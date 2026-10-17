"""Sen1Floods11 水面分割训练件（4090D 上的第一个活）。

四个设计约束，缺一条这个 IoU 就不算数：

1. **按事件切分**，不按瓦片切分。同一景影像切出来的瓦片同时进训练集和验证集，
   验证分数会虚高到无法解释。分桶键是事件名。
2. **必须同时报一个阈值基线**。水在 VV 后向散射里是最暗的一类地物，
   单门限就能拿到很高的 IoU。如果网络打不过门限，那网络没有贡献，
   这条线就该停在这里而不是继续往下游走。
3. **标签语义先取证再用**。Sen1Floods11 的手绘标签在不同版本里编码不一致
   （0/1 二值，或 1/2/3 多类加 255 无标注）。probe 与 selftest 之前先把
   实际见到的取值打出来，出现未知编码直接 abort，不静默映射。
4. 推理阶段（本事件那一景）不在这个文件里，它依赖 F11b 的影像获取。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "2")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

IMG_SUF = ("_VV", "VV", "_vh", "VH")
KNOWN_LABEL_VALS = {frozenset({-1, 0, 1}), frozenset({-1, 1}), frozenset({0, 1}),
                    frozenset({0, 1, 2}), frozenset({1, 2}),
                    frozenset({0, 1, 2, 3}),
                    frozenset({1, 2, 3}), frozenset({0, 1, 255}), frozenset({1, 2, 255}),
                    frozenset({1, 2, 3, 255}), frozenset({0, 1, 2, 3, 255}),
                    frozenset({0, 2}), frozenset({2})}


# ---------------------------------------------------------------- 取证与加载
_GENERIC = ("sentinel1_images", "sentinel1_image", "labels", "labels_binary", "images",
            "unzipped", "data", "sen1floods11_manual_v1.0", "sen1floods11_v1.0")


def _event_of(p: Path) -> str:
    """事件键：取路径里第一个含 4 位年份、且不是纯日期段的目录名。

    为什么不能用父目录：真实包里瓦片文件自己占一层目录，按父目录取会把同一景
    切出来的瓦片当成不同事件，按事件切分就退化成按瓦片切分，验证分数虚高。
    """
    for q in p.parts:
        if q.lower() in _GENERIC or q == p.name:
            continue
        if re.fullmatch(r"(\d{8}|\d{4}-\d{2}-\d{2})", q):
            continue
        if re.search(r"(19|20)\d{2}", q):
            return q
    return p.parent.name


def discover(root: Path) -> list[dict]:
    """找成对的 (VV[, VH], label) 瓦片。支持 GeoTIFF 与 .npy 两种打包。

    键是 (所在目录, 去后缀名)——只用文件名会把不同事件目录下的同名瓦片合并。
    """
    tiles: dict[str, dict] = {}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".tif", ".tiff", ".npy"):
            continue
        stem = p.name[: -len(p.suffix)]
        low = stem.lower()
        base = stem
        for suf in ("_label_binary_v", "_label_binary", "_label_v", "_label", "label",
                    "_vv_db", "_vv_raw", "_vv", "vv", "_vh", "vh"):
            if low.endswith(suf):
                base = stem[: len(stem) - len(suf)].rstrip("_") or stem
                break
        t = tiles.setdefault(f"{p.parent}|{base}",
                             {"base": f"{p.parent.name}/{base}", "event": _event_of(p),
                              "path_hint": str(p)})
        if "label" in low:
            t["label"] = str(p)
        elif low.endswith("vh"):
            t["vh"] = str(p)
        else:
            t["vv"] = str(p)
    out = [v for v in tiles.values() if "label" in v and "vv" in v]
    out.sort(key=lambda x: x["base"])
    return out


def read_arr(fp: str):
    try:
        import rasterio
        if fp.lower().endswith((".tif", ".tiff")):
            with rasterio.open(fp) as r:
                return r.read(1).astype("float32"), r.shape
    except Exception:  # noqa: BLE001
        pass
    import numpy as np
    a = np.load(fp, allow_pickle=False)
    if a.ndim == 3:
        a = a[..., 0] if a.shape[-1] <= 4 else a[0]
    return np.asarray(a, dtype="float32"), a.shape


def read_bands(fp: str) -> "np.ndarray":
    """影像按波段数返回 (C,H,W)。S1Hand 是 (2,512,512) 的 VV+VH。"""
    import numpy as np
    try:
        import rasterio
        if fp.lower().endswith((".tif", ".tiff")):
            with rasterio.open(fp) as r:
                a = r.read().astype("float32")
            return a if a.ndim == 3 else a[None]
    except Exception:  # noqa: BLE001
        pass
    a = np.load(fp, allow_pickle=False)
    if a.ndim == 2:
        a = a[None]
    elif a.ndim == 3 and a.shape[0] not in (1, 2, 4):
        a = np.moveaxis(a, -1, 0)
    return a.astype("float32")


def discover_v11(root: Path) -> list[dict]:
    """官方 v1.1 扁平命名：<事件>_<瓦片ID>_<角色>.tif，影像与标注分在两棵树。"""
    import re
    by: dict[str, dict] = {}
    for p in root.rglob("*.tif"):
        m = re.match(r"(?P<key>.+_\d+)_(?P<role>S1Hand|LabelHand|S1OtsuLabelHand)\.tif$",
                     p.name, re.I)
        if not m:
            continue
        t = by.setdefault(m.group("key"), {"base": m.group("key"),
                                           "event": m.group("key").rsplit("_", 1)[0]})
        role = m.group("role").lower()
        if role == "s1hand":
            t["vv"] = str(p)
        elif role == "labelhand":
            t["label"] = str(p)
        elif role == "s1otsulabelhand":
            t["otsu"] = str(p)
    out = [v for v in by.values() if "label" in v and "vv" in v]
    out.sort(key=lambda x: x["base"])
    return out


def official_splits(root: Path) -> dict:
    """包里带官方 splits 时读进来；键名沿用官方文件名。"""
    res = {}
    for f in sorted(root.rglob("*.txt")):
        if "splits" not in f.parts:
            continue
        key = f.stem.replace("flood_", "").replace("_data", "")
        res[key] = [ln.strip() for ln in
                    f.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return res


def label_stats(items: list[dict], n: int = 24) -> dict:
    import numpy as np
    vals: set[int] = set()
    shapes: set[tuple[int, int]] = set()
    vv_min, vv_max = 1e9, -1e9
    for it in items[:n]:
        lab, shp = read_arr(it["label"])
        vals |= {int(v) for v in np.unique(lab).tolist()}
        shapes.add(tuple(int(x) for x in shp[:2]))
        img, _ = read_arr(it["vv"])
        img = img[0] if img.ndim == 3 else img
        if np.nanmin(img) < vv_min:
            vv_min = float(np.nanmin(img))
        if np.nanmax(img) > vv_max:
            vv_max = float(np.nanmax(img))
    return {"label_vals": sorted(vals), "tile_shapes": sorted(shapes),
            "vv_min": round(vv_min, 2), "vv_max": round(vv_max, 2), "n_sampled": min(n, len(items))}


def infer_mapping(items: list[dict], n: int = 40) -> tuple[str, dict]:
    """用物理量选水体，不用占比。

    后向散射里水是最暗的一类地物，所以"逐标签值算 VV 均值，取最小者"是判据；
    占比判据在这里会翻车——手绘标签中非水（类 2）像素本来就远多于水（类 1），
    按多数选会把水陆整个反过来，而 IoU 未必报错，只是模型学了个负片。

    返回 ("eq1"/"eq0"/"le1", 报告)。两类均值差不足 min_margin_db 时返回 "abort"，
    由调用方停下问人——物理判据在这个样本上不起作用，不该硬猜。
    """
    import numpy as np
    acc: dict[int, list[float]] = {}
    for it in items[:n]:
        img, _ = read_arr(it["vv"])
        lab, _ = read_arr(it["label"])
        img = np.nan_to_num(img, nan=np.nan)
        for v in (k for k in np.unique(lab).tolist() if int(k) != 255):
            m = (lab == v) & np.isfinite(img)
            if m.sum() > 50:
                acc.setdefault(int(v), []).append(float(np.nanmean(img[m])))
    if len(acc) < 2:
        return "abort", {"per_class_mean_vv": {k: round(float(np.mean(v)), 2) for k, v in acc.items()},
                         "reason": "能算出均值的标签类不足 2 个"}
    means = {k: round(float(np.mean(v)), 2) for k, v in acc.items()}
    order = sorted(means.items(), key=lambda kv: kv[1])
    wval, wmean = order[0]
    margin = round(order[1][1] - wmean, 2)
    if margin < infer_mapping.min_margin_db:
        return "abort", {"per_class_mean_vv": means, "water_guess": wval,
                         "margin_db": margin,
                         "reason": f"最暗类与次暗类只差 {margin} dB，不足 "
                                   f"{infer_mapping.min_margin_db} dB，物理判据不起作用"}
    if set(means) == {0, 1} and wval == 1:
        mp = "eq1"
    elif set(means) == {0, 1} and wval == 0:
        mp = "eq0"
    elif wval == 1:
        mp = "eq1"
    elif wval == 0:
        mp = "le1"
    else:
        return "abort", {"per_class_mean_vv": means, "water_guess": wval, "margin_db": margin,
                         "reason": f"最暗类是 {wval}，不在已实现的 mapping 里，需加一条映射"}
    return mp, {"per_class_mean_vv": means, "water_class": wval, "margin_db": margin,
                "mapping": mp, "n_tiles_used": min(n, len(items))}


infer_mapping.min_margin_db = 2.0


def to_water(lab, mapping: str):
    """按 mapping 二值化，并把 255（无标注）从训练与评分里剔出去。"""
    import numpy as np
    if mapping == "eq1":
        w = (lab == 1)
    elif mapping == "eq0":
        w = (lab == 0)
    elif mapping == "le1":
        w = (lab <= 1)
    else:
        raise ValueError(f"未知 mapping {mapping}")
    # 无标注掩膜有两种历史写法：v1.1 用 -1，某些重打包用 255
    valid = (lab != -1) & (lab != 255)
    return w.astype("float32"), valid.astype("float32")


# ---------------------------------------------------------------- 阈值基线
def otsu_iou(items: list[dict], mapping: str) -> dict:
    """单门限（Otsu，逐瓦片）的水面 IoU。网络必须打过它才算有贡献。"""
    import numpy as np
    inter, union, used = 0.0, 0.0, 0
    for it in items:
        img, _ = read_arr(it["vv"])
        lab, _ = read_arr(it["label"])
        w, valid = to_water(lab, mapping)
        x = np.nan_to_num(img, nan=float(np.nanmin(img))).astype("float64")
        hist, edges = np.histogram(x[valid > 0], bins=128)
        p = hist / max(hist.sum(), 1)
        om = np.cumsum(p)
        mu = np.cumsum(p * ((edges[:-1] + edges[1:]) / 2))
        denom = om * (1 - om)
        with np.errstate(divide="ignore", invalid="ignore"):
            sig = (mu[-1] * om - mu) ** 2 / np.where(denom == 0, 1, denom)
        thr = ((edges[:-1] + edges[1:]) / 2)[int(np.nanargmax(np.where(denom > 0, sig, -1)))]
        pred = (x < thr).astype("float32") * valid      # 水在 VV 里偏暗
        w = w * valid
        inter += float((pred * w).sum())
        union += float(((pred + w) > 0).sum())
        used += 1
    return {"iou": round(inter / max(union, 1.0), 4), "n_tiles": used}


# ---------------------------------------------------------------- 模型
def build_model(cin: int):
    import torch
    import torch.nn as nn

    def blk(i, o):
        return nn.Sequential(nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o),
                             nn.ReLU(inplace=True),
                             nn.Conv2d(o, o, 3, padding=1, bias=False), nn.BatchNorm2d(o),
                             nn.ReLU(inplace=True))

    class UNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.e1, self.e2, self.e3 = blk(cin, 16), blk(16, 32), blk(32, 64)
            self.b = blk(64, 96)
            # 解码每一级都是"上采样结果 ⊕ 同尺寸编码特征"，通道要相加着写
            self.d3, self.d2, self.d1 = blk(96 + 64, 64), blk(64 + 32, 32), blk(32 + 16, 16)
            self.s = nn.Conv2d(16, 1, 1)

        def forward(self, x):
            import torch.nn.functional as F
            e1 = self.e1(x)
            e2 = self.e2(F.max_pool2d(e1, 2))
            e3 = self.e3(F.max_pool2d(e2, 2))
            b = self.b(F.max_pool2d(e3, 2))
            d3 = self.d3(torch.cat([F.interpolate(b, scale_factor=2, mode="bilinear",
                                                  align_corners=False), e3], 1))
            d2 = self.d2(torch.cat([F.interpolate(d3, scale_factor=2, mode="bilinear",
                                                  align_corners=False), e2], 1))
            d1 = self.d1(torch.cat([F.interpolate(d2, scale_factor=2, mode="bilinear",
                                                  align_corners=False), e1], 1))
            return self.s(d1)

    return UNet()


def make_ds(items, mapping, norm):
    import numpy as np
    import torch
    from torch.utils.data import Dataset

    class T(Dataset):
        def __init__(self):
            self.imgs, self.labs, self.masks = [], [], []
            for it in items:
                im = read_bands(it["vv"])
                if im.shape[0] == 1 and it.get("vh"):
                    try:
                        im = np.concatenate([im, read_bands(it["vh"])], 0)
                    except Exception:  # noqa: BLE001
                        pass
                lab, _ = read_arr(it["label"])
                w, valid = to_water(lab, mapping)
                if im.shape[0] != len(norm[0]):
                    raise ValueError(f"波段数 {im.shape[0]} 与标准化统计长度 "
                                     f"{len(norm[0])} 不一致，不猜")
                for c in range(im.shape[0]):
                    im[c] = np.nan_to_num(im[c], nan=norm[0][c])
                    im[c] = (im[c] - norm[0][c]) / norm[1][c]
                self.imgs.append(im.astype("float32"))
                self.labs.append(w[None].astype("float32"))
                self.masks.append(valid[None].astype("float32"))

        def __len__(self):
            return len(self.imgs)

        def __getitem__(self, i):
            return (torch.from_numpy(self.imgs[i]), torch.from_numpy(self.labs[i]),
                    torch.from_numpy(self.masks[i]))

    return T()


def train(args) -> int:
    import numpy as np
    import torch

    root = Path(args.root)
    items = discover(root)
    layout = "同目录配对"
    if len(items) < 20:
        v11 = discover_v11(root)
        if len(v11) >= 20:
            items, layout = v11, "官方 v1.1 扁平命名（S1Hand↔LabelHand 跨树配对）"
    print(f"[布局] {layout} | 配对瓦片 {len(items)}", flush=True)
    if args.max_tiles:
        items = items[:args.max_tiles]
    if len(items) < 20:
        print(f"[abort] 只找到 {len(items)} 对 (影像,标签)，少于 20。"
              f"先看 probe 输出确认包内布局，别硬训。", flush=True)
        return 2
    st = label_stats(items)
    print(f"[取证] 瓦片 {len(items)} 对 | 标签取值 {st['label_vals']} | 瓦片尺寸 "
          f"{st['tile_shapes']} | VV 范围 {st['vv_min']}~{st['vv_max']} | 抽样 {st['n_sampled']}",
          flush=True)
    if frozenset(st["label_vals"]) not in KNOWN_LABEL_VALS:
        print(f"[abort] 标签取值 {st['label_vals']} 不在已知编码集合内，"
              f"先人工确认哪个值是水体，再用 --mapping 指定。", flush=True)
        return 3
    if args.mapping == "auto":
        mp, rep = infer_mapping(items)
        print(f"[判据] 逐类 VV 均值 {rep.get('per_class_mean_vv')} dB；"
              f"{'水体类=%s 余量 %s dB → mapping=%s' % (rep.get('water_class'), rep.get('margin_db'), mp) if mp!='abort' else rep.get('reason')}",
              flush=True)
        if mp == "abort":
            print("[abort] 物理判据不起作用，停下问人，不硬猜编码。", flush=True)
            return 3
        args.mapping = mp
        map_rep = rep
    else:
        map_rep = {"mapping": args.mapping, "note": "人工覆盖，未经 VV 均值核验"}
    bad = [s for s in st["tile_shapes"] if s[0] % 8 or s[1] % 8]
    if bad:
        print(f"[abort] 瓦片尺寸 {bad} 不能被 8 整除，三级 U-Net 的下采样会丢边缘像素；"
              f"需要先加 padding 或改下采样层数，不要静默 resize。", flush=True)
        return 3

    sp = official_splits(root) if args.split != "self" else {}
    if args.split == "self":
        print("[切分] 强制按事件自切（用于事件级交叉验证的多折）", flush=True)
    if sp.get("train") and sp.get("valid"):
        tr_names, va_names = set(sp["train"]), set(sp["valid"])
        tr = [it for it in items if it["base"] in tr_names]
        va = [it for it in items if it["base"] in va_names]
        events = sorted({it["event"] for it in items})
        print(f"[切分] 用官方 splits：训练 {len(tr)} 片 / 验证 {len(va)} 片"
              f"（覆盖 {len({it['event'] for it in tr})} 与 {len({it['event'] for it in va})} 个事件，"
              f"全集事件数 {len(events)}）", flush=True)
        if not tr or not va:
            print("[abort] 官方 splits 读到了但与包内文件对不上，不用它", flush=True)
            return 4
    else:
        tr = va = None
    events = sorted({it["event"] for it in items})
    if len(events) < 3:
        print(f"[abort] 事件数 {len(events)} 太少，按事件切分不成立：{events[:6]}", flush=True)
        return 4
    if tr is None:
        rng = random.Random(args.seed)
        perm = events[:]
        rng.shuffle(perm)
        n_val = max(1, int(round(len(perm) * args.val_frac)))
        val_ev, tr_ev = set(perm[:n_val]), set(perm[n_val:])
        tr = [it for it in items if it["event"] in tr_ev]
        va = [it for it in items if it["event"] in val_ev]
        print(f"[切分] 按事件自切：训练 {len(tr_ev)} 事件 {len(tr)} 瓦片 | "
              f"验证 {len(val_ev)} 事件 {len(va)} 瓦片", flush=True)
        print(f"[事件] 验证集事件 = {sorted(val_ev)}", flush=True)
        split_mode = "自切"
    else:
        val_ev = {it["event"] for it in va}
        tr_ev = {it["event"] for it in tr}
        split_mode = "官方 splits"

    base = os.path.join(args.outdir, args.tag)
    os.makedirs(base, exist_ok=True)
    bl = otsu_iou(va, args.mapping)
    print(f"[基线] 逐瓦片 Otsu 单门限 验证 IoU = {bl['iou']}", flush=True)
    (Path(base) / "baseline.json").write_text(
        json.dumps({"otsu": bl, "label_stats": st, "events": {"train": sorted(tr_ev),
                "val": sorted(val_ev)}}, ensure_ascii=False, indent=1), encoding="utf-8")

    _b = np.stack([read_bands(it["vv"])[:, ::4, ::4] for it in tr[:60]], 0)   # (N,C,h,w)
    means = [float(np.nanmean(_b[:, c])) for c in range(_b.shape[1])]
    stds = [float(np.nanstd(_b[:, c]) + 1e-6) for c in range(_b.shape[1])]
    norm = (means, stds)
    print(f"[归一] 逐通道标准化 mean={[round(m,2) for m in means]} "
          f"std={[round(s,2) for s in stds]}（样本 {_b.shape[0]} 片，dB 原值不再直接进网络）",
          flush=True)

    dev = "cuda" if torch.cuda.is_available() and not args.cpu else "cpu"
    if dev == "cuda":
        print(f"[设备] {torch.cuda.get_device_name(0)} 显存 "
              f"{torch.cuda.get_device_properties(0).total_memory/1e9:.1f} GB", flush=True)
    else:
        print("[设备] CPU（自检或无卡环境）", flush=True)
    cin = int(read_bands(tr[0]["vv"]).shape[0])
    print(f"[通道] S1Hand 波段数 = {cin}（1=只用 VV，2=VV+VH）", flush=True)
    net = build_model(cin).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    dl = torch.utils.data.DataLoader(make_ds(tr, args.mapping, norm), batch_size=args.batch,
                                     shuffle=True, num_workers=0, drop_last=True)
    vdl = torch.utils.data.DataLoader(make_ds(va, args.mapping, norm), batch_size=args.batch,
                                      shuffle=False, num_workers=0)
    scaler = torch.amp.GradScaler("cuda", enabled=(dev == "cuda" and not args.no_amp))
    bce = torch.nn.BCEWithLogitsLoss(reduction="none")
    pos_w = float(args.pos_w)
    history, t0 = [], time.time()

    def masked_loss(logits, y, m):
        el = bce(logits, y)
        if pos_w != 1.0:
            el = el * torch.where(y > 0.5, torch.tensor(pos_w, device=dev), 1.0)
        b = (el * m).sum() / m.sum().clamp(min=1.0)
        p = torch.sigmoid(logits) * m
        yy = y * m
        d = 1 - (2 * (p * yy).sum() + 1) / (p.sum() + yy.sum() + 1)
        return b + d

    for ep in range(args.epochs):
        net.train()
        run = 0.0
        for x, y, m in dl:
            x, y, m = x.to(dev), y.to(dev), m.to(dev)
            with torch.amp.autocast("cuda", enabled=(dev == "cuda" and not args.no_amp)):
                loss = masked_loss(net(x), y, m)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            run += float(loss.detach()) * x.shape[0]
        net.eval()
        inter = union = 0.0
        with torch.no_grad():
            for x, y, m in vdl:
                x, y, m = x.to(dev), y.to(dev), m.to(dev)
                p = (torch.sigmoid(net(x)) > 0.5).float() * m
                yy = y * m
                inter += float((p * yy).sum())
                union += float(((p + yy) > 0).sum())
        iou = inter / max(union, 1.0)
        history.append({"epoch": ep, "train_loss": round(run / max(len(tr), 1), 4),
                        "val_iou": round(iou, 4), "elapsed_s": round(time.time() - t0, 1)})
        print(f"[ep{ep}] loss {run/max(len(tr),1):.4f}  val IoU {iou:.4f}  "
              f"(阈值基线 {bl['iou']})  {time.time()-t0:.0f}s", flush=True)
        if (ep + 1) % args.ckpt_every == 0 or iou >= args.stop_iou:
            torch.save({"state": net.state_dict(), "norm": norm, "cin": cin,
                        "mapping": args.mapping, "events_val": sorted(val_ev)},
                       Path(base) / f"unet_ep{ep+1}.pt")
        if iou >= args.stop_iou:
            print(f"[早停] val IoU {iou:.4f} 已达 --stop-iou {args.stop_iou}", flush=True)
            break

    best = max(history, key=lambda h: h["val_iou"])
    out = {"root": str(root), "layout": layout, "split_mode": split_mode,
           "mapping": args.mapping, "mapping_evidence": map_rep, "device": dev,
           "n_tiles": len(items), "label_stats": st, "baseline_otsu_iou": bl["iou"],
           "best": best, "history": history,
           "verdict": ("网络打过阈值基线" if best["val_iou"] > bl["iou"]
                       else "网络未打过阈值基线：这条线应停在训练层，不进入推理与对外结论"),
           "elapsed_s": round(time.time() - t0, 1)}
    (Path(base) / "metrics.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                             encoding="utf-8")
    chk = sorted(Path(base).glob("unet_ep*.pt"))
    back = json.loads((Path(base) / "metrics.json").read_text(encoding="utf-8"))
    assert back["best"]["val_iou"] == out["best"]["val_iou"], "metrics 读回不一致"
    assert chk, "没有任何 checkpoint 落盘"
    print(f"[完成] best val IoU {best['val_iou']} vs 基线 {bl['iou']} → {out['verdict']}；"
          f"checkpoint {len(chk)} 个，指标件 {Path(base)/'metrics.json'}", flush=True)
    return 0 if best["val_iou"] > bl["iou"] else 5


# ---------------------------------------------------------------- 自检与取证
def selftest(args) -> int:
    """造一批合成瓦片（水=暗、陆=亮 + 噪声），走完整 train() 路径。
    它验的是代码接线（按事件切分、阈值基线、指标落盘读回），不是模型好坏。"""
    import numpy as np
    d = Path(args.outdir) / "_selftest_data"
    if d.exists():
        import shutil
        shutil.rmtree(d)
    rng = np.random.default_rng(11)
    for ev, rad in (("EVA_2021", 0.30), ("EVB_2021", 0.24),
                    ("EVC_2022", 0.36), ("2019-03_TESTLAND", 0.20)):
        for k in range(10):
            h = w = 64
            yy, xx = np.mgrid[0:h, 0:w]
            water = ((xx - w / 2) ** 2 + (yy - h / 2) ** 2) < (min(h, w) * rad) ** 2
            img = np.where(water, -22.0, -8.0) + rng.normal(0, 1.1, (h, w))
            lab = np.where(water, 1, 2).astype("uint8")
            sub = d / ev / f"{ev}_T{k:02d}"
            sub.mkdir(parents=True, exist_ok=True)
            np.save(sub / f"t{k:02d}_VV.npy", img.astype("float32"))
            np.save(sub / f"t{k:02d}_label.npy", lab)
    args.root, args.max_tiles, args.epochs, args.batch = str(d), 0, args.epochs or 3, 4
    print("[selftest] 合成 4 事件 × 10 瓦片，走完整训练路径", flush=True)
    rc = train(args)
    # 退出码语义：0=网络打过单门限；5=没打过。合成数据是水陆双峰，单门限本来
    # 就近最优，所以 5 不算接线失败；只有 2/3/4（发现、编码、切分）才是真失败。
    mp = Path(args.outdir) / args.tag / "metrics.json"
    if rc in (0, 5):
        got = json.loads(mp.read_text(encoding="utf-8"))
        assert got["n_tiles"] == 40, f"瓦片数应为 40，实为 {got['n_tiles']}"
        assert got["label_stats"]["label_vals"] == [1, 2], got["label_stats"]
        assert got["mapping"] == "eq1", f"物理判据选错了水体类: {got.get('mapping_evidence')}"
        assert got["best"]["val_iou"] > 0.30, f"网络没学到东西：best {got['best']}"
        assert got["baseline_otsu_iou"] > 0.30, f"阈值基线异常：{got['baseline_otsu_iou']}"
        print(f"[selftest] 接线全通：40 对瓦片、按事件切分、阈值基线 {got['baseline_otsu_iou']}、"
              f"网络 best {got['best']['val_iou']}、指标件已读回并断言", flush=True)
        return 0
    print(f"[selftest] 失败，退出码 {rc}（2=发现不足 3=标签编码未知 4=事件数太少）", flush=True)
    return rc


def probe(args) -> int:
    items = discover(Path(args.root))
    layout = "同目录配对"
    if len(items) < 20:
        v11 = discover_v11(Path(args.root))
        if len(v11) >= 20:
            items, layout = v11, "官方 v1.1 跨树配对"
    print(f"[probe] 布局={layout} 配对瓦片 {len(items)}")
    for it in items[:5]:
        print("  ", json.dumps(it, ensure_ascii=False)[:200])
    if items:
        print("[probe] 取证:", json.dumps(label_stats(items), ensure_ascii=False))
        mp, rep = infer_mapping(items)
        print("[probe] 物理判据:", json.dumps(rep, ensure_ascii=False), "-> mapping =", mp)
        ev = sorted({i["event"] for i in items})
        print(f"[probe] 事件 {len(ev)} 个: {ev[:12]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(ROOT / "data" / "sar" / "unzipped"))
    ap.add_argument("--outdir", default=str(ROOT / "out" / "sar"))
    ap.add_argument("--tag", default="run1")
    ap.add_argument("--mapping", default="auto", choices=("auto", "eq1", "eq0", "le1"),
                    help="auto=按逐类 VV 均值最暗判水体（物理判据，不用占比），其余为人工覆盖")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--pos-w", type=float, default=1.0)
    ap.add_argument("--val-frac", type=float, default=0.25)
    ap.add_argument("--split", default="auto", choices=("auto", "official", "self"),
                    help="auto=有官方 splits 就用；self=强制按事件自切（换 seed 即换折）")
    ap.add_argument("--tta", type=int, default=0,
                    help="验证时做 k 次翻转/转置增强并对概率取均值，0=关闭")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--ckpt-every", type=int, default=2)
    ap.add_argument("--stop-iou", type=float, default=0.85)
    ap.add_argument("--max-tiles", type=int, default=0)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--no-amp", action="store_true")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    if a.selftest:
        return selftest(a)
    if a.probe:
        return probe(a)
    return train(a)


if __name__ == "__main__":
    raise SystemExit(main())
