"""p27 维度诊断：我们缺的是"第三维"还是"第四维"？

论点：本项目的水深场是 (情景, 时刻, y, x)，**已经是四维张量**，
但只稀疏用了二维（峰值场）。真正缺的不是网格维度，而是**垂向(z)**——
因为致灾过程是垂向连通的：地表水 → 下穿隧道 → 地下车库 → 电梯井。

证据检验：
  1) 5 处下穿立交实测均 0.50 m，它们在 30 m DSM 上是否有洼地？
  2) 若 DSM 上有洼地，填洼深度与观测水深是否相关？
  3) 三维扩展需要什么数据，缺多少？

用法：python -m typhoeus.dimension
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"

LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
MARGIN = 0.05


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _dem_native():
    """返回在计算域+余量窗口上的 30 m 高程数组与坐标换算。"""
    import rasterio

    lo_lon, hi_lon = LON_MIN - MARGIN, LON_MAX + MARGIN
    lo_lat, hi_lat = LAT_MIN - MARGIN, LAT_MAX + MARGIN
    with rasterio.open(ROOT / "data" / "dem_n29e121.tif") as src:
        win = rasterio.windows.from_bounds(lo_lon, lo_lat, hi_lon, hi_lat, src.transform)
        win = win.round_offsets().round_lengths()
        z = src.read(1, window=win).astype("float64")
        tr = src.window_transform(win)
    return z, tr


def _priority_flood(z: np.ndarray) -> np.ndarray:
    import heapq

    ny, nx = z.shape
    filled = z.copy()
    vis = np.zeros((ny, nx), bool)
    heap: list[tuple[float, int, int]] = []
    for i in range(ny):
        for j in (0, nx - 1):
            heapq.heappush(heap, (z[i, j], i, j))
            vis[i, j] = True
    for j in range(nx):
        for i in (0, ny - 1):
            if not vis[i, j]:
                heapq.heappush(heap, (z[i, j], i, j))
                vis[i, j] = True
    nbrs = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))
    while heap:
        e, i, j = heapq.heappop(heap)
        for di, dj in nbrs:
            a, b = i + di, j + dj
            if 0 <= a < ny and 0 <= b < nx and not vis[a, b]:
                vis[a, b] = True
                v = max(z[a, b], e)
                filled[a, b] = v
                heapq.heappush(heap, (v, a, b))
    return filled


def build(outdir: str = "out", verbose: bool = True) -> dict:
    import rasterio

    z, tr = _dem_native()
    ny, nx = z.shape
    if verbose:
        print(f"  30 m 窗口 {nx}×{ny}")
    filled = _priority_flood(z)
    depr = filled - z

    rows = []
    for r in _load(SEED / "flood_points_2021_infa.csv"):
        try:
            x, y = float(r["lon"]), float(r["lat"])
            obs = float(r["depth_m"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (LON_MIN <= x <= LON_MAX and LAT_MIN <= y <= LAT_MAX):
            continue
        row, col = rasterio.transform.rowcol(tr, x, y)
        row = int(np.clip(row, 0, ny - 1))
        col = int(np.clip(col, 0, nx - 1))
        r0, r1 = max(0, row - 2), min(ny, row + 3)
        c0, c1 = max(0, col - 2), min(nx, col + 3)
        local = float(depr[r0:r1, c0:c1].max())
        rows.append({
            "编号": r["point_id"], "名称": r["name"],
            "结构": r.get("structure_type", ""),
            "观测_m": obs,
            "点高程_m": round(float(z[row, col]), 2),
            "DSM填洼_m": round(float(depr[row, col]), 3),
            "邻域最大填洼_m": round(local, 3),
            "DSM是否表达": bool(local >= 0.20),
        })

    under = [r for r in rows if r["结构"] == "下穿立交"]
    n_missing = sum(1 for r in under if not r["DSM是否表达"])
    obs_arr = np.array([r["观测_m"] for r in rows])
    depr_arr = np.array([r["邻域最大填洼_m"] for r in rows])
    rho = None
    if len(rows) >= 4 and depr_arr.std() > 0:
        from scipy.stats import spearmanr
        rho = float(spearmanr(depr_arr, obs_arr).statistic)

    # 三维扩展所需数据清单（逐项标明是否已有）
    needs = [
        {"项": "下穿立交竖向剖面（口部高程、底高程、长度、坡向）",
         "是否已有": False, "影响": "决定容器容积与进水口过流宽度"},
        {"项": "地下空间（车库/地铁/人防）层数与底高程",
         "是否已有": False, "影响": "决定二次淹没与人员风险"},
        {"项": "电梯井/管井底高程与井道连通性",
         "是否已有": False, "影响": "决定电梯停梯阈值（现用 0.10 m 工程假设）"},
        {"项": "点位 footprint（硬化/绿地比例）",
         "是否已有": False, "影响": "决定产流系数与容器进水效率"},
        {"项": "抽排能力（泵站/移动泵）",
         "是否已有": "部分", "影响": "p21 已可反解，但缺实测标定"},
    ]

    payload = {
        "名称": "维度诊断：缺的是第三维还是第四维",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "现有维度": {
            "张量": "depth(scenario, t, y, x)",
            "实际使用": "多为峰值场（scenario × y × x）与统计量",
            "已被压缩掉的轴": ["时间（只取峰值）", "情景（四档分别统计）"],
        },
        "缺口判断": {
            "不是网格维度不够": "场已有 (情景, t, y, x) 四轴，加密网格不解决线性失真",
            "缺的是垂向(z)": "致灾链路是垂向的：地表水→下穿隧道→地下车库→电梯井",
            "证据": {
                "下穿立交数": len(under),
                "DSM 未表达的下穿立交数": n_missing,
                "说明": "若 DSM 都无法表达其凹陷，则 2D 模型结构上不可能在那里积水",
            },
        },
        "逐点": rows,
        "填洼与观测的秩相关": round(rho, 4) if rho is not None else None,
        "三维扩展所需数据": needs,
        "结论": (
            "点位失真是**维度缺失**，不是参数问题："
            f"{n_missing}/{len(under)} 处下穿立交在 30 m DSM 上无可用洼地，"
            "而它们实测均为 0.50 m。2D 曲面模型无法表达三维容器，"
            "再怎么调参也不会在这些点出水。"
        ),
        "可行路径": [
            "① 从观测反推容器深度下界（已在做：观测 0.50 m ⇒ 容器 ≥0.50 m）",
            "② 用结构类型给容器形状先验（槽形/面形），容积曲线 V(h) 参数化",
            "③ 把容器作为图的**节点容量**接入现有图守恒律内核（不改 2D 求解器）",
            "④ 数据到位后标定 ①②，再决定是否上真三维求解",
        ],
        "边界": [
            "「DSM 未表达」以邻域最大填洼 <0.20 m 判定，阈值是经验值。",
            "观测水深来自公开通报，5 处下立交均为 0.50 m 属同一通报口径，可能被统一取整。",
            "填洼用 priority-flood，未做人工地物（桥、涵）剔除。",
            "本件只做维度诊断，不实现三维求解。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p27_维度诊断.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  下穿立交 {len(under)} 处，DSM 未表达 {n_missing} 处")
        for r in under:
            print(f"    {r['编号']} {r['名称'][:18]:<20} 观测 {r['观测_m']:.2f}  "
                  f"填洼 {r['DSM填洼_m']:.3f}  邻域 {r['邻域最大填洼_m']:.3f}  "
                  f"{'✓表达' if r['DSM是否表达'] else '✗未表达'}")
        print(f"  填洼 vs 观测 秩相关 ρ = {rho}")
        print(f"→ {p / 'p27_维度诊断.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.dimension")
    ap.add_argument("outdir", nargs="?", default="out")
    a = ap.parse_args(argv)
    build(a.outdir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
