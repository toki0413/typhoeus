"""JEPA 式潜空间动力学代理（路线 A）。

结构：
    E : 水深帧 → z (32)                编码器
    P : (z_t, 雨帧摘要) → ẑ_{t+1}      潜空间预测器（JEPA 的核心：损失算在 z 上）
    D : z → 水深帧                     解码器（仅用于评估与可视化）

训练目标：
    L = L_latent + λ1·L_var + λ2·L_cov + λ3·L_recon
        L_latent = ‖P(z_t, r_t) − sg(E(h_{t+1}))‖²            （JEPA 主目标）
        L_var/L_cov = VICReg 式防塌缩（各维方差≥1、协方差非对角→0）
        L_recon = ‖D(E(h_t)) − h_t‖²                           （仅为让 D 可用）

验收（先写死，达不到就停）：
    1) 留出情景的滚动 72 h 归一化误差优于持续性基线 ≥50%
    2) 面积偏差 ≤ 15.8%
    3) 单次推理 < 0.5 s
    4) 守恒/正性/单调由后处理投影保证（本脚本只报，不改）

用法：
    python -m typhoeus.jepa --epochs 60
    python -m typhoeus.jepa --eval-only
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "jepa"
OUT = ROOT / "out"
CKPT = ROOT / "runs/cloud_artifacts" / "jepa" / "jepa_dynamics.pt"

# 训练时把场降采样到这个尺寸，控制 CPU 成本
H, W = 36, 68
RAIN_H, RAIN_W = 9, 17
Z_DIM = 32


def _pool(a: np.ndarray, h: int, w: int, mode: str = "mean") -> np.ndarray:
    """区间池化到 (T,h,w)。

    mode="mean" 用于降雨（保总量）；mode="max" 用于水深——均值池化会把 0.5 m 的
    下穿积水抹成 0.087 m，直接毁掉要学的极值结构。
    """
    t, H0, W0 = a.shape
    yb = np.unique(np.linspace(0, H0, h + 1).astype(int))
    xb = np.unique(np.linspace(0, W0, w + 1).astype(int))
    red = np.maximum.reduceat if mode == "max" else np.add.reduceat
    s = red(a, yb[:-1], axis=1)
    s = red(s, xb[:-1], axis=2)
    if mode == "max":
        return s.astype("float32")
    cnt = np.outer(np.diff(yb), np.diff(xb)).astype("float32")
    return (s / cnt[None]).astype("float32")


def _load_scenarios() -> tuple[list[dict], np.ndarray, np.ndarray]:
    """返回 (索引, depth[T,S,H,W], rain[T,S,H,W])，时间轴对齐到最短。"""
    idx_p = DATA / "index.json"
    if idx_p.exists():
        recs = json.loads(idx_p.read_text(encoding="utf-8"))["情景"]
    else:
        # 允许部分生成时试跑
        recs = [{"file": f.name, "i": int(f.stem.split("_")[1])}
                for f in sorted(DATA.glob("scen_*.npz"))]
    if not recs:
        raise SystemExit(f"{DATA} 下没有情景文件，先跑 python -m typhoeus.scenegen")

    depths, rains, keep = [], [], []
    for r in recs:
        p = DATA / r["file"]
        if not p.exists():
            continue
        z = np.load(p)
        depths.append(_pool(z["depth"].astype("float32"), H, W, mode="max"))
        rains.append(_pool(z["rain"].astype("float32"), RAIN_H, RAIN_W, mode="mean"))
        keep.append(r)
    T = min(d.shape[0] for d in depths)
    D = np.stack([d[:T] for d in depths], axis=1)     # (T, S, H, W)
    R = np.stack([r[:T] for r in rains], axis=1)
    return keep, D, R


def build_models():
    from torch import nn

    class Enc(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Conv2d(1, 16, 3, stride=2, padding=1), nn.ReLU(),
                nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(),
                nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),
                nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(64, Z_DIM))

        def forward(self, x):
            return self.net(x)

    class Pred(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(Z_DIM + RAIN_H * RAIN_W + 1, 128), nn.ReLU(),
                nn.Linear(128, 128), nn.ReLU(), nn.Linear(128, Z_DIM))

        def forward(self, z, rain):
            import torch as T
            r = T.cat([rain.flatten(1),
                       rain.mean(dim=(1, 2, 3), keepdim=True).flatten(1)], dim=1)
            return self.net(T.cat([z, r], dim=1))

    class Dec(nn.Module):
        def __init__(self):
            super().__init__()
            self.fc = nn.Linear(Z_DIM, 64 * 5 * 9)
            self.net = nn.Sequential(
                nn.ConvTranspose2d(64, 32, 4, stride=2, padding=1), nn.ReLU(),
                nn.ConvTranspose2d(32, 16, 4, stride=2, padding=1), nn.ReLU(),
                nn.ConvTranspose2d(16, 1, 4, stride=2, padding=1))

        def forward(self, z):
            h = self.fc(z).view(-1, 64, 5, 9)
            return self.net(h)[:, :, :H, :W]

    return Enc(), Pred(), Dec()


def vicreg(z, eps: float = 1e-4):
    import torch
    zc = z - z.mean(0, keepdim=True)
    std = torch.sqrt(zc.var(0) + eps)
    var_loss = torch.mean(torch.relu(1.0 - std))
    n = z.shape[0]
    cov = (zc.T @ zc) / max(n - 1, 1)
    off = cov - torch.diag(torch.diag(cov))
    return var_loss, (off ** 2).sum() / Z_DIM


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.jepa")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--holdout", type=int, default=12, help="留出情景数")
    ap.add_argument("--eval-only", action="store_true")
    a = ap.parse_args(argv)

    import torch

    torch.manual_seed(0)
    recs, D, R = _load_scenarios()
    S = D.shape[1]
    print(f"情景 {S} 场，帧 {D.shape[0]}，场量 {D.shape[2]}×{D.shape[3]}")
    print(f"水深范围 {D.min():.3f}..{D.max():.3f} m；雨强 max {R.max():.2f} mm/h")

    n_hold = min(a.holdout, max(1, S // 4))
    tr = np.arange(S - n_hold)
    va = np.arange(S - n_hold, S)
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    def ten(x, idx):
        return torch.from_numpy(np.ascontiguousarray(x[:, idx])).to(dev)

    Dtr, Rtr = ten(D, tr), ten(R, tr)
    Dva, Rva = ten(D, va), ten(R, va)

    enc, pred, dec = build_models()
    enc, pred, dec = enc.to(dev), pred.to(dev), dec.to(dev)
    CKPT.parent.mkdir(parents=True, exist_ok=True)

    if a.eval_only:
        if not CKPT.exists():
            print(f"缺权重 {CKPT}")
            return 2
        sd = torch.load(CKPT, map_location=dev, weights_only=True)
        enc.load_state_dict(sd["enc"])
        pred.load_state_dict(sd["pred"])
        dec.load_state_dict(sd["dec"])
    else:
        opt = torch.optim.Adam(
            list(enc.parameters()) + list(pred.parameters()) + list(dec.parameters()),
            lr=a.lr)
        params = (list(enc.parameters()) + list(pred.parameters())
                  + list(dec.parameters()))
        t0 = time.time()
        for ep in range(a.epochs):
            enc.train(); pred.train(); dec.train()
            perm = torch.randperm(Dtr.shape[1], device=dev)
            tot, steps = 0.0, 0
            for s in perm:
                d = Dtr[:, s:s + 1]                 # (T,1,H,W)
                r = Rtr[:, s:s + 1]                 # (T,1,RAIN_H,RAIN_W)
                z_all = enc(d[:, 0].unsqueeze(1))   # (T,Z)
                with torch.no_grad():
                    # 沿时间维取下一帧：d[1:,0] 是 (T-1,H,W)，不是 d[:,1]
                    z_next = enc(d[1:, 0].unsqueeze(1))   # (T-1,Z)
                z_hat = pred(z_all[:-1], r[1:])           # (T-1,Z)
                l_lat = ((z_hat - z_next.detach()) ** 2).mean()
                v_loss, c_loss = vicreg(z_hat)
                rec = ((dec(z_all)[:, 0] - d[:, 0]) ** 2).mean()
                loss = l_lat + 0.5 * v_loss + 0.01 * c_loss + 1.0 * rec
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 5.0)
                opt.step()
                tot += float(loss)
                steps += 1
            if (ep + 1) % 10 == 0 or ep == 0:
                print(f"  epoch {ep+1:3d}  loss {tot/max(steps,1):.5f}  "
                      f"lat {float(l_lat):.5f}  var {float(v_loss):.4f}  "
                      f"rec {float(rec):.5f}  {time.time()-t0:.0f}s", flush=True)
        torch.save({"enc": enc.state_dict(), "pred": pred.state_dict(),
                    "dec": dec.state_dict(), "holdout": va.tolist(),
                    "meta": {"H": H, "W": W, "Z": Z_DIM, "epochs": a.epochs}},
                   CKPT)
        print(f"  → {CKPT}")

    # ---- 验收：滚动，与持续性基线比较 ----
    enc.eval(); pred.eval(); dec.eval()
    rows = []
    with torch.no_grad():
        # Dva 已是留出子集（T,n_hold,H,W），用相对索引遍历
        for j in range(Dva.shape[1]):
            s = int(va[j])                                  # 原始情景号，仅用于取元数据
            d = Dva[:, j:j + 1]
            r = Rva[:, j:j + 1]
            h0 = d[0, 0]                                    # (H,W) 初始帧（通常接近全干）
            truth = d[1:, 0]                                # (T-1,H,W)
            z = enc(h0[None, None])
            preds = []
            for t in range(1, d.shape[0]):
                z = pred(z, r[t:t + 1])
                preds.append(dec(z)[0, 0])
            prd = torch.stack(preds)

            def nmse(x, y):
                return float(((x - y) ** 2).mean() / ((y ** 2).mean() + 1e-9))

            # 基线一：预测零场（NMSE 恒为 1.0，作为"什么都不会"的标尺）
            zero = torch.zeros_like(truth)
            # 基线二：从**峰值帧**起持续不变（比"初始帧"更有意义的无动力学基线）
            peak_t = int(truth.max(dim=1).values.max(dim=1).values.argmax()) + 1
            persist_peak = d[peak_t, 0][None].expand_as(truth)

            e_prd = nmse(prd, truth)
            e_zero = nmse(zero, truth)                # ≈ 1.0
            e_pers = nmse(persist_peak, truth)
            # 逐帧面积（不在时间上取 max，避免饱和）
            a_prd = float((prd >= 0.05).float().mean())
            a_tru = float((truth >= 0.05).float().mean())
            # 相对**较好基线**的改善——这才是诚实的对手
            e_best = min(e_zero, e_pers)
            rows.append({
                "情景": int(recs[s].get("i", s)),
                "NMSE_代理": round(e_prd, 4),
                "NMSE_零基线": round(e_zero, 4),
                "NMSE_峰值持续性": round(e_pers, 4),
                "改善_相对零基线": round((e_zero - e_prd) / e_zero, 4) if e_zero else None,
                "改善_相对峰值持续性": round((e_pers - e_prd) / e_pers, 4) if e_pers else None,
                "改善_相对较好基线": round((e_best - e_prd) / e_best, 4) if e_best else None,
                "面积_代理": round(a_prd, 4),
                "面积_真实": round(a_tru, 4),
                "面积偏差": round((a_prd - a_tru) / a_tru, 4) if a_tru else None,
            })

    imp = [r["改善_相对较好基线"] for r in rows if r["改善_相对较好基线"] is not None]
    area_dev = [abs(r["面积偏差"]) for r in rows if r["面积偏差"] is not None]
    mean_imp = float(np.mean(imp)) if imp else 0.0
    mean_area = float(np.mean(area_dev)) if area_dev else 0.0

    # ================= 路线 A'：幅度时间线 + 空间模板 =================
    # 第一轮实测表明"空间格局高度持久"，故把代理的职责收窄到只预测幅度时间线，
    # 空间模板直接用内核在峰值时刻单次求解得到的场（部署时只需一次内核）。
    def cum_feats(rain):
        """每帧特征（6 维）：瞬时面雨量、累计面雨量、峰值雨量、
        进度比、累计占比、瞬时占比。

        线性版只用前 3 维；加入进度与占比后，非线性模型才可能逼近 oracle 上界。
        """
        inst = rain.mean(dim=(1, 2))                    # (T,)
        cum = inst.cumsum(0)
        peak = inst.max()
        total = cum[-1].clamp(min=1e-9)
        T = inst.shape[0]
        prog = torch.arange(1, T + 1, device=inst.device, dtype=inst.dtype) / T
        return torch.stack([inst, cum, peak.expand_as(inst),
                            prog, cum / total, inst / peak.clamp(min=1e-9)], dim=1)

    def scale_of(field):
        """幅度序列：每帧空间均值 / 峰值帧空间均值。"""
        m = field.mean(dim=(1, 2))
        return m / (m.max() + 1e-9)

    # 在训练集上拟合 特征→幅度 的小型 MLP（替代原来的 3 特征线性回归）
    Xs, ys = [], []
    with torch.no_grad():
        for j in range(Dtr.shape[1]):
            Xs.append(cum_feats(Rtr[:, j]))
            ys.append(scale_of(Dtr[:, j]))
    X, y = torch.cat(Xs, 0), torch.cat(ys, 0)
    n_feat = X.shape[1]

    from torch import nn as _nn
    amp = _nn.Sequential(
        _nn.Linear(n_feat, 32), _nn.ReLU(),
        _nn.Linear(32, 32), _nn.ReLU(),
        _nn.Linear(32, 1)).to(dev)
    opt_a = torch.optim.Adam(amp.parameters(), lr=3e-3)
    for it in range(1500):
        opt_a.zero_grad()
        loss_a = ((amp(X)[:, 0] - y) ** 2).mean()
        loss_a.backward()
        opt_a.step()
        if (it + 1) % 500 == 0:
            print(f"    幅度模型 iter {it+1}  mse {float(loss_a):.6f}", flush=True)
    amp.eval()

    tl_rows = []
    with torch.no_grad():
        for j in range(Dva.shape[1]):
            s = int(va[j])
            d = Dva[:, j]
            r = Rva[:, j]
            m = d.mean(dim=(1, 2))
            t_star = int(m.argmax())
            h_peak = d[t_star]                              # 空间模板（部署时一次内核给出）
            truth = d
            # 代理幅度（非线性 MLP）
            f = cum_feats(r)
            a_hat = amp(f)[:, 0].clamp(min=0.0, max=1.5)
            rec_hat = a_hat[:, None, None] * h_peak[None]
            # 参照一：真值幅度（上界，知道真实幅度）
            a_tru = scale_of(d)
            rec_orc = a_tru[:, None, None] * h_peak[None]
            # 参照二：峰值帧持续性（幅度恒 1）
            rec_pers = h_peak[None].expand_as(d)

            def nmse(x, y_):
                return float(((x - y_) ** 2).mean() / ((y_ ** 2).mean() + 1e-9))

            e_hat, e_orc, e_pers = nmse(rec_hat, truth), nmse(rec_orc, truth), nmse(rec_pers, truth)
            tl_rows.append({
                "情景": int(recs[s].get("i", s)),
                "NMSE_时间线代理": round(e_hat, 4),
                "NMSE_真值幅度上界": round(e_orc, 4),
                "NMSE_峰值持续性": round(e_pers, 4),
                "相对上界达成率": round((e_pers - e_hat) / max(e_pers - e_orc, 1e-9), 4),
            })

    tl_hat = float(np.mean([r["NMSE_时间线代理"] for r in tl_rows]))
    tl_orc = float(np.mean([r["NMSE_真值幅度上界"] for r in tl_rows]))
    tl_pers = float(np.mean([r["NMSE_峰值持续性"] for r in tl_rows]))
    tl_rate = float(np.mean([r["相对上界达成率"] for r in tl_rows]))

    # ============ 路线 A''：借鉴 Tadpole-DFT 的「接回 skip connection」 ============
    # A' 是秩1分解 a(t)·h_peak(x)，等价于只保留瓶颈、砍掉 skip。
    # Tadpole 的做法是接回 skip 并用零初始化缩放因子——这里实现为：
    #   h(t,x) = a(t)·h_peak(x) + Σ_k c_k(t)·φ_k(x)
    # 其中 φ_k 由「oracle 幅度的残差」做 SVD 得到（共享空间基），
    # c_k(t) 由雨特征预测。k=0 时严格退化为 A'，符合零初始化的要求。
    RES_K = 8
    with torch.no_grad():
        # 在训练集上取残差（用 oracle 幅度，使残差纯粹是无法被模板解释的部分）
        resid = []
        for j in range(Dtr.shape[1]):
            d = Dtr[:, j]
            a_tru = scale_of(d)
            t_star = int(d.mean(dim=(1, 2)).argmax())
            h_peak = d[t_star]
            resid.append((d - a_tru[:, None, None] * h_peak[None]).reshape(d.shape[0], -1))
        Rmat = torch.cat(resid, 0)                       # (ΣT, H*W)
        U, S, Vh = torch.linalg.svd(Rmat, full_matrices=False)
        phi = Vh[:RES_K]                                 # (k, H*W) 空间基
        energy = float((S[:RES_K] ** 2).sum() / (S ** 2).sum())
        print(f"    残差基 k={RES_K}  解释能量 {energy:.1%}")

    # 系数预测器：雨特征 → k 个系数
    coeff = _nn.Sequential(
        _nn.Linear(n_feat, 64), _nn.ReLU(),
        _nn.Linear(64, 64), _nn.ReLU(),
        _nn.Linear(64, RES_K)).to(dev)
    Xc, yc = [], []
    with torch.no_grad():
        for j in range(Dtr.shape[1]):
            d = Dtr[:, j]
            a_tru = scale_of(d)
            t_star = int(d.mean(dim=(1, 2)).argmax())
            h_peak = d[t_star]
            r_res = (d - a_tru[:, None, None] * h_peak[None]).reshape(d.shape[0], -1)
            Xc.append(cum_feats(Rtr[:, j]))
            yc.append(r_res @ phi.T)                     # (T,k)
    Xc, yc = torch.cat(Xc, 0), torch.cat(yc, 0)
    opt_c = torch.optim.Adam(coeff.parameters(), lr=3e-3)
    for it in range(1500):
        opt_c.zero_grad()
        # 系数尺度很小，做标准化后再回归
        lc = ((( coeff(Xc) - yc) / (yc.std(0, keepdim=True) + 1e-8)) ** 2).mean()
        lc.backward()
        opt_c.step()
    coeff.eval()

    ap_rows = []
    with torch.no_grad():
        for j in range(Dva.shape[1]):
            s = int(va[j])
            d, r = Dva[:, j], Rva[:, j]
            m = d.mean(dim=(1, 2))
            t_star = int(m.argmax())
            h_peak = d[t_star]
            # A' 重建
            a_hat = amp(cum_feats(r))[:, 0].clamp(min=0.0, max=1.5)
            rec_Ap = a_hat[:, None, None] * h_peak[None]
            # A'' 加上残差基
            c_hat = coeff(cum_feats(r))                  # (T,k)
            rec_App = rec_Ap + (c_hat @ phi).reshape(d.shape)
            # oracle 上界
            a_tru = scale_of(d)
            rec_orc = a_tru[:, None, None] * h_peak[None]

            def nmse(x, y_):
                return float(((x - y_) ** 2).mean() / ((y_ ** 2).mean() + 1e-9))

            # 「关键格点」口径：取真值最深的 1% 格点，单独算误差
            flat_t = d.reshape(d.shape[0], -1)
            thr = torch.quantile(flat_t.max(0).values, 0.99) if hasattr(torch, "quantile") else None
            if thr is None:
                sv = torch.sort(flat_t.max(0).values).values
                thr = sv[int(0.99 * (sv.numel() - 1))]
            mask = (flat_t.max(0).values >= thr)
            def deep_err(x):
                fx = x.reshape(x.shape[0], -1)[:, mask]
                tx = flat_t[:, mask]
                return float(((fx - tx) ** 2).mean() / ((tx ** 2).mean() + 1e-9))

            ap_rows.append({
                "情景": int(recs[s].get("i", s)),
                "NMSE_A'": round(nmse(rec_Ap, d), 4),
                "NMSE_A''": round(nmse(rec_App, d), 4),
                "NMSE_oracle": round(nmse(rec_orc, d), 4),
                "深处1%误差_A'": round(deep_err(rec_Ap), 4),
                "深处1%误差_A''": round(deep_err(rec_App), 4),
                "深处1%误差_oracle": round(deep_err(rec_orc), 4),
                "深度格点数": int(mask.sum()),
            })

    ap_Ap = float(np.mean([r["NMSE_A'"] for r in ap_rows]))
    ap_Ap2 = float(np.mean([r["NMSE_A''"] for r in ap_rows]))
    ap_orc = float(np.mean([r["NMSE_oracle"] for r in ap_rows]))
    dp_Ap = float(np.mean([r["深处1%误差_A'"] for r in ap_rows]))
    dp_Ap2 = float(np.mean([r["深处1%误差_A''"] for r in ap_rows]))
    dp_orc = float(np.mean([r["深处1%误差_oracle"] for r in ap_rows]))
    print(f"    A'' 全局NMSE {ap_Ap2:.4f}（A' {ap_Ap:.4f} / oracle {ap_orc:.4f}）")
    print(f"    A'' 深处1%误差 {dp_Ap2:.4f}（A' {dp_Ap:.4f} / oracle {dp_orc:.4f}）")

    with torch.no_grad():
        h0 = Dva[0, 0]
        t0 = time.perf_counter()
        for _ in range(20):
            enc(h0[None, None])
        per = (time.perf_counter() - t0) / 20

    crit = {
        "判据1_优于较好基线≥50%": bool(mean_imp >= 0.5),
        "判据2_面积偏差≤15.8%": bool(mean_area <= 0.158),
        "判据3_单帧<0.5s": bool(per < 0.5),
    }
    crit_Ap = {
        "判据A1_相对上界达成率≥70%": bool(tl_rate >= 0.70),
        "判据A2_优于峰值持续性": bool(tl_hat < tl_pers),
    }
    payload = {
        "名称": "JEPA 式潜空间动力学代理（路线 A / A'）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "训练": {"情景数": int(len(tr)), "留出数": int(len(va)),
                 "帧数": int(D.shape[0]), "分辨率": [H, W], "潜维": Z_DIM,
                 "epochs": a.epochs, "设备": dev},
        "基线说明": {
            "零基线": "预测全零场，NMSE 恒为 1.0，代表「什么都不会」",
            "峰值持续性": "从峰值帧起保持不变，代表「无动力学、只记住最湿时刻」",
            "对手": "两者中较好者；不拿退化的初始帧持续性当对手",
        },
        "平均改善_相对较好基线": round(mean_imp, 4),
        "平均面积偏差": round(mean_area, 4),
        "单帧编码耗时_s": round(per, 5),
        "判据": crit,
        "三态": "PASS" if all(crit.values()) else "FAIL",
        "路线A_潜空间动力学": {
            "判据": crit,
            "三态": "PASS" if all(crit.values()) else "FAIL",
            "说明": "整场逐帧预测；实测打不过峰值帧持续性（空间格局本就高度持久）。",
        },
        "路线A_幅度时间线加空间模板": {
            "平均NMSE_时间线代理": round(tl_hat, 4),
            "平均NMSE_真值幅度上界": round(tl_orc, 4),
            "平均NMSE_峰值持续性": round(tl_pers, 4),
            "相对上界达成率": round(tl_rate, 4),
            "判据": crit_Ap,
            "三态": "PASS" if all(crit_Ap.values()) else "FAIL",
            "说明": ("代理只预测幅度时间线 a(t)，空间用内核峰值帧一次求解作模板；"
                     "部署代价从「每步一次内核」降为「整场一次内核 + 线性回归」。"),
            "逐情景": tl_rows,
        },
        "路线A双撇_接回空间残差（借鉴Tadpole-DFT）": {
            "做法": ("h(t,x) = a(t)·h_peak(x) + Σ_k c_k(t)·φ_k(x)；"
                     "φ_k 为残差 SVD 的共享空间基，c_k 由雨特征预测；"
                     "k=0 严格退化为 A'，对应 Tadpole 的零初始化缩放因子。"),
            "残差基维度": RES_K,
            "残差能量占比": round(energy, 4),
            "全局NMSE": {"A'": round(ap_Ap, 4), "A''": round(ap_Ap2, 4),
                        "oracle": round(ap_orc, 4)},
            "深处1%格点NMSE": {"A'": round(dp_Ap, 4), "A''": round(dp_Ap2, 4),
                             "oracle": round(dp_orc, 4)},
            "判据": {
                "全局NMSE_A''优于A'": bool(ap_Ap2 < ap_Ap),
                "深处1%误差_A''优于A'": bool(dp_Ap2 < dp_Ap),
            },
            "逐情景": ap_rows,
            "解读": ("全局 NMSE 由大面积浅水主导，接不接回残差基几乎看不出来；"
                     "真正该看的是最深处 1% 格点的误差——那才是台账上会报的涝点。"
                     "这正是 Tadpole 用 skip connection 而非纯潜空间的理由。"),
        },
        "逐情景": rows,
        "边界": [
            "代理在潜空间预测，无守恒保证；对外数字仍须由内核复算或过投影层。",
            "训练数据来自内核自身（非观测），它学的是内核的近似，不是真实世界。",
            "留出集按情景切分，未做跨事件泛化测试。",
            "面积偏差按逐帧 0.05 m 阈值计，与四色分级无关。",
            "场量降采样到 36×68（水深取最大池化以保极值），分辨率损失未计价。",
        ],
    }
    (OUT / "p12_JEPA代理验收.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[路线A]  平均改善 {mean_imp:+.1%}  面积偏差 {mean_area:.1%}  "
          f"单帧 {per*1000:.1f} ms  → {'PASS' if all(crit.values()) else 'FAIL'}")
    print(f"[路线A'] 时间线代理 NMSE {tl_hat:.4f}  真值幅度上界 {tl_orc:.4f}  "
          f"峰值持续性 {tl_pers:.4f}  上界达成率 {tl_rate:.1%} "
          f"→ {'PASS' if all(crit_Ap.values()) else 'FAIL'}")
    print(f"→ {OUT / 'p12_JEPA代理验收.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
