"""SAR 摄入链：从原始 GRD 复算域内 VV 后向散射（dB）。

为什么需要这一件
----------------
此前 `p10`/`p11`/`p14` 只消费预处理好的 `vv_domain_db.npy` 与 `water_prob.npy`，
**生成它们的代码不在仓库里**——遥感这条支线的可复算性是断的。
本模块把那段链补出来，并用已落盘的 `vv_domain_db.npy` **反向验证**它。

链条四步（全部只依赖原生产品）
------------------------------
  1 读定标 LUT（`cal-iw-vv.xml`）：27 条 `calibrationVector`，
    每条给 line 与一组 (pixel, sigmaNought)
  2 定标：sigma0 = DN² / A²，dB = 20·log10(DN) − 20·log10(A)
     A 在该 (line, pixel) 处由 LUT 双线性插值
  3 几何：读 `annotation-iw-vv.xml` 的 210 个 GCP，
     在域附近拟合 (lon, lat) → (pixel, line) 的仿射映射
  4 重网格：对目标网格每个单元中心，映射到 SAR 像元，取 DN 并定标

验证口径
--------
用同一套原始文件复算出的域内 dB 场，与既有 `vv_domain_db.npy` 比对：
相关系数、偏差、RMSE。若高度一致，说明摄入链**可从原始数据复现**。

用法：
    python -m typhoeus.sar_ingest --verify      # 复算并与既有 npy 比对
    python -m typhoeus.sar_ingest               # 只复算并落盘
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SAR_DIR = ROOT / "data" / "seed" / "sentinel1"
OUT = ROOT / "out"

# 域（与 config.L2 同源；此处硬编码仅为让本模块可独立运行）
BBOX = (121.550139, 29.840417, 121.699583, 29.919861)   # lon_min, lat_min, lon_max, lat_max
GRID_SHAPE = (358, 498)      # 与既有 vv_domain_db.npy 一致


# ---------------------------------------------------------------- 定标 LUT
def parse_cal(path: Path) -> list[dict]:
    s = path.read_text(encoding="utf-8", errors="replace")
    out = []
    for body in re.findall(r"<calibrationVector>(.*?)</calibrationVector>", s, re.S):
        line = int(re.search(r"<line[^>]*>\s*(\d+)\s*</line>", body).group(1))
        # 注意：<pixel> 带 count 属性（如 <pixel count="637">），正则必须允许属性
        px = re.search(r"<pixel[^>]*>\s*([^<]+)</pixel>", body).group(1).split()
        sn = re.search(r"<sigmaNought[^>]*>\s*([^<]+)</sigmaNought>",
                       body).group(1).split()
        out.append({"line": line,
                    "pixel": np.array(px, float),
                    "sigmaNought": np.array(sn, float)})
    out.sort(key=lambda d: d["line"])
    return out


def calib_A(vectors: list[dict], line: int, pixel: int) -> float:
    """在该 (line, pixel) 处双线性插值定标常数 A。"""
    lines = np.array([v["line"] for v in vectors], float)
    lines_c = np.clip(lines, lines.min(), lines.max())
    i = int(np.searchsorted(lines_c, line, side="right") - 1)
    i = min(max(i, 0), len(vectors) - 1)
    j = min(i + 1, len(vectors) - 1)
    if i == j or lines_c[j] == lines_c[i]:
        w = 0.0
    else:
        w = (line - lines_c[i]) / (lines_c[j] - lines_c[i])
        w = float(np.clip(w, 0.0, 1.0))
    a = []
    for k in (i, j):
        v = vectors[k]
        a.append(float(np.interp(pixel, v["pixel"], v["sigmaNought"])))
    return (1 - w) * a[0] + w * a[1]


# ---------------------------------------------------------------- 几何 GCP
def parse_gcp(path: Path) -> np.ndarray:
    """返回 (n, 4) 数组：[line, pixel, lon, lat]。"""
    s = path.read_text(encoding="utf-8", errors="replace")
    rows = []
    for body in re.findall(
            r"<geolocationGridPoint>(.*?)</geolocationGridPoint>", s, re.S):
        d = dict(re.findall(r"<(\w+)>([^<]+)</\1>", body))
        try:
            rows.append((float(d["line"]), float(d["pixel"]),
                         float(d["longitude"]), float(d["latitude"])))
        except (KeyError, ValueError):
            continue
    return np.array(rows, float)


def fit_affine(gcp: np.ndarray, bbox: tuple[float, ...],
               margin_deg: float = 0.35) -> tuple[np.ndarray, np.ndarray, dict]:
    """用域附近的 GCP 拟合 (lon,lat) → (pixel,line) 仿射。"""
    lon, lat = gcp[:, 2], gcp[:, 3]
    lon0, lat0, lon1, lat1 = bbox
    clon, clat = (lon0 + lon1) / 2, (lat0 + lat1) / 2
    m = ((np.abs(lon - clon) <= margin_deg) & (np.abs(lat - clat) <= margin_deg))
    if m.sum() < 6:
        m = np.ones(len(gcp), bool)
    G = gcp[m]
    # 设计矩阵：[1, dlon, dlat]
    X = np.column_stack([np.ones(len(G)), G[:, 2] - clon, G[:, 3] - clat])
    cpix, *_ = np.linalg.lstsq(X, G[:, 1], rcond=None)
    clin, *_ = np.linalg.lstsq(X, G[:, 0], rcond=None)
    # 拟合残差（换算成米：0.001° ≈ 96 m at this latitude for lon, 111 m for lat）
    pr = X @ cpix - G[:, 1]
    lr = X @ clin - G[:, 0]
    # SAR 像元约 10 m（GRD 全分辨），残差以像元数与米同时报
    info = {
        "用于拟合GCP数": int(m.sum()),
        "pixel残差_中位_像元": round(float(np.median(np.abs(pr))), 2),
        "line残差_中位_像元": round(float(np.median(np.abs(lr))), 2),
        "pixel残差_最大_像元": round(float(np.max(np.abs(pr))), 2),
        "line残差_最大_像元": round(float(np.max(np.abs(lr))), 2),
        "残差换算_m_约10m像元": {
            "中位": round(float(np.median(np.abs(np.r_[pr, lr]))) * 10, 1),
            "最大": round(float(np.max(np.abs(np.r_[pr, lr]))) * 10, 1),
        },
    }
    return cpix, clin, info


# ---------------------------------------------------------------- 主链
def ingest(tiff: Path, cal: Path, ann: Path,
           bbox: tuple[float, ...] = BBOX,
           shape: tuple[int, int] = GRID_SHAPE,
           looks: int = 1) -> tuple[np.ndarray, dict]:
    """looks=k 时在 sigma0 线性域做 k×k 多视平均，再转 dB。

    顺序很重要：**必须先平均线性功率再取对数**。
    若先转 dB 再平均，得到的是几何平均，与辐射平均差一个偏置。
    """
    import tifffile

    vectors = parse_cal(cal)
    gcp = parse_gcp(ann)
    cpix, clin, geo = fit_affine(gcp, bbox)

    lon0, lat0, lon1, lat1 = bbox
    ny, nx = shape
    lons = np.linspace(lon0, lon1, nx)
    lats = np.linspace(lat1, lat0, ny)         # 北→南，与模型网格一致
    LON, LAT = np.meshgrid(lons, lats)
    clon, clat = (lon0 + lon1) / 2, (lat0 + lat1) / 2
    X = np.column_stack([np.ones(LON.size), (LON - clon).ravel(),
                         (LAT - clat).ravel()])
    pix = (X @ cpix).reshape(ny, nx)
    lin = (X @ clin).reshape(ny, nx)

    with tifffile.TiffFile(tiff) as tf:
        arr = tf.pages[0].asarray()            # uint16 DN
    H, W = arr.shape
    pi = np.clip(np.round(pix).astype(int), 0, W - 1)
    li = np.clip(np.round(lin).astype(int), 0, H - 1)
    if looks <= 1:
        dn = arr[li, pi].astype(np.float64)
        dn2 = dn ** 2
    else:
        # 多视：对 k×k 窗口内的线性功率（DN²）取均值。
        # 单视 SAR 强度的标准差约等于均值，不平均则逐像元比对毫无意义。
        half = looks // 2
        acc = np.zeros(li.shape, np.float64)
        cnt = np.zeros(li.shape, np.float64)
        for dy in range(-half, half + 1):
            for dx in range(-half, half + 1):
                yy = np.clip(li + dy, 0, H - 1)
                xx = np.clip(pi + dx, 0, W - 1)
                v = arr[yy, xx].astype(np.float64)
                acc += v ** 2
                cnt += 1.0
        dn2 = acc / np.maximum(cnt, 1.0)
        dn = np.sqrt(dn2)

    # 逐点定标常数。为控制耗时，按 (line, pixel) 的组合去重计算。
    keys = np.stack([li.ravel(), pi.ravel()], axis=1)
    uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    amps = np.array([calib_A(vectors, int(a), int(b)) for a, b in uniq])
    A = amps[inv].reshape(ny, nx)

    with np.errstate(divide="ignore"):
        # dB = 10·log10(mean(DN²)) − 20·log10(A)，等价于 10·log10(sigma0)
        db = 10 * np.log10(np.maximum(dn2, 1e-12)) - 20 * np.log10(A)
    db[dn2 <= 0] = np.nan

    info = {
        "定标向量数": len(vectors),
        "GCP数": len(gcp),
        "几何拟合": geo,
        "SAR尺寸": [int(H), int(W)],
        "网格": [int(ny), int(nx)],
        "多视_looks": int(looks),
        "域内dB": {"min": round(float(np.nanmin(db)), 2),
                 "max": round(float(np.nanmax(db)), 2),
                 "mean": round(float(np.nanmean(db)), 2),
                 "nan比例": round(float(np.isnan(db).mean()), 4)},
        "定标常数A范围": [round(float(amps.min()), 1), round(float(amps.max()), 1)],
    }
    return db, info


def verify(db: np.ndarray, ref_path: Path) -> dict:
    ref = np.load(ref_path).astype(np.float64)
    if ref.shape != db.shape:
        # 形状不同时用最近邻重采样到参照网格，保证可比
        ny, nx = ref.shape
        yi = np.clip((np.linspace(0, db.shape[0] - 1, ny)).astype(int), 0, db.shape[0] - 1)
        xi = np.clip((np.linspace(0, db.shape[1] - 1, nx)).astype(int), 0, db.shape[1] - 1)
        dbc = db[np.ix_(yi, xi)]
        note = f"形状不同（{db.shape} → {ref.shape}），已最近邻重采样后比对"
    else:
        dbc = db
        note = "形状一致，逐像元比对"
    m = np.isfinite(dbc) & np.isfinite(ref)
    a, b = dbc[m], ref[m]
    if a.size < 10:
        return {"说明": "有效像元过少，无法比对"}
    corr = float(np.corrcoef(a, b)[0, 1])
    diff = a - b
    return {
        "比对口径": note,
        "有效像元": int(m.sum()),
        "相关系数": round(corr, 4),
        "偏差_均值_dB": round(float(diff.mean()), 3),
        "RMSE_dB": round(float(np.sqrt((diff ** 2).mean())), 3),
        "我方均值_dB": round(float(a.mean()), 3),
        "参照均值_dB": round(float(b.mean()), 3),
        "判定": ("可复现（r ≥ 0.95 且 |偏差| ≤ 1 dB）" if corr >= 0.95
               and abs(diff.mean()) <= 1.0 else "**未完全复现**，见偏差与 RMSE"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.sar_ingest")
    ap.add_argument("--verify", action="store_true", help="与既有 vv_domain_db.npy 比对")
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--looks", type=int, default=5,
                    help="多视窗口边长（奇数）；单视 SAR 斑点太强，默认 5")
    a = ap.parse_args(argv)

    tiff = SAR_DIR / "iw-vv.tiff"
    cal = SAR_DIR / "cal-iw-vv.xml"
    ann = SAR_DIR / "annotation-iw-vv.xml"
    for f in (tiff, cal, ann):
        if not f.exists():
            print(f"缺文件：{f}")
            return 2

    t0 = time.perf_counter()
    db, info = ingest(tiff, cal, ann, looks=max(1, a.looks))
    info["耗时_s"] = round(time.perf_counter() - t0, 1)

    payload = {
        "名称": "SAR 摄入链：从原始 GRD 复算域内 VV",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么需要这一件": (
            "此前 p10/p11/p14 只消费预处理好的 npy，生成它们的代码不在仓库，"
            "遥感支线的可复算性是断的。本模块补齐下载后处理链："
            "定标 LUT → sigma0 → GCP 仿射 → 重网格 → 域内 dB 场。"),
        "输入": {"tiff": str(tiff.relative_to(ROOT)),
                 "cal": str(cal.relative_to(ROOT)),
                 "ann": str(ann.relative_to(ROOT))},
        "处理链": {
            "定标": "sigma0 = DN²/A²；dB = 20log10(DN) − 20log10(A)，"
                    "A 由 27 条 calibrationVector 的 sigmaNought 双线性插值",
            "几何": "用 annotation 的 GCP 拟合 (lon,lat)→(pixel,line) 局部仿射",
            "重网格": f"目标网格 {GRID_SHAPE}，北→南行序",
        },
        "复算信息": info,
        "验证": {},
        "结论": [],
        "边界": [
            "几何是**局部仿射**，不是严格的地距投影；残差见 info.几何拟合。",
            "未做斑点滤波、地形辐射校正（RTC）与入射角归一化。",
            "定标只用 sigmaNought LUT，未用噪声 LUT 做热噪声去除。",
            "本模块只覆盖『下载之后』的处理；下载本身仍由外部完成。",
            "重网格用最近邻取值，未做面积加权平均。",
            "**本件未完成可复现性判定**：复算场与既有产物相关仅约 0.12–0.16，"
            "粗网格大范围平移搜索亦无显著峰（最佳约 0.29），"
            "故判定为『重网格口径不同』而非『错位』。"
            "原始回归方式无法从落盘产物反推。",
            "多视（looks）只把相关从 0.115 提到 0.158，且偏差变差，"
            "说明斑点不是主因。",
        ],
    }

    np.save(Path(a.outdir) / "sar_ingest_db.npy", db.astype(np.float16))

    if a.verify:
        ref = SAR_DIR / "vv_domain_db.npy"
        v = verify(db, ref) if ref.exists() else {"说明": "无参照文件"}
        payload["验证"] = v
        if v.get("相关系数") is not None:
            payload["结论"].append(
                f"复算场与既有 `vv_domain_db.npy` 的相关系数 **{v['相关系数']}**，"
                f"偏差 {v['偏差_均值_dB']} dB，RMSE {v['RMSE_dB']} dB → "
                f"{v['判定']}。")
        else:
            payload["结论"].append(str(v.get("说明")))
    else:
        payload["结论"].append("未做比对（加 --verify）")

    # 结论必须按验证结果分支：复现失败时不得声称"已补上"
    ok = (payload["验证"].get("判定", "").startswith("可复现"))
    if ok:
        payload["结论"].append(
            "**遥感支线已从『只有结果、无生成代码』变为『可从原始 GRD 复算』。**")
    else:
        payload["结论"].append(
            "**复现失败。** 摄入链现已存在于仓库（这是进步），"
            "但它**不能复现**既有的 `vv_domain_db.npy`——"
            f"相关系数仅 {payload['验证'].get('相关系数')}。")
        payload["结论"].append(
            "**关键诊断**：粗网格（60×60）上做 ±15 块的大范围平移搜索，"
            "最佳相关系数也只有约 0.29，且无显著峰——"
            "**说明差异不是简单错位，而是重网格口径不同**"
            "（投影、范围、插值方式的一项或多项）。")
        payload["结论"].append(
            "**这比『缺代码』更严重**：原始输入（tiff + cal + annotation）"
            "**全在仓库里**，仍然无法复现派生产物。"
            "故 p10 / p11 / p14 的输入在现有仓库状态下**不可验证**。"
            "这是必须记为待补项的科研级缺口，本件**没有**解决它。")

    (Path(a.outdir) / "p54_SAR摄入链复算.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  定标向量 {info['定标向量数']}  GCP {info['GCP数']}  "
          f"A∈[{info['定标常数A范围'][0]}, {info['定标常数A范围'][1]}]")
    print(f"  几何残差中位 {info['几何拟合']['残差换算_m_约10m像元']['中位']} m")
    print(f"  域内 dB mean {info['域内dB']['mean']}  "
          f"nan {info['域内dB']['nan比例']*100:.1f}%  耗时 {info['耗时_s']}s")
    if payload["验证"].get("相关系数") is not None:
        v = payload["验证"]
        print(f"  验证 r={v['相关系数']}  偏差 {v['偏差_均值_dB']} dB  "
              f"RMSE {v['RMSE_dB']} dB → {v['判定']}")
    print(f"→ {Path(a.outdir) / 'p54_SAR摄入链复算.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
