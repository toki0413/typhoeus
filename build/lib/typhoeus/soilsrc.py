"""提比翁Demo —— L0 土壤状态与蒸散驱动接入层。

背景：`kernel.py` 的 Green-Ampt 分支用两个常数标定起渗——
`soil_theta0=0.45`（初始相对饱和度）与 `net_sw_wm2=40.0`（净短波，
驱动 Ghil-Sellers 潜热项）。这两个值上一轮是**按"未饱和 + 阴天"
的定性判断**定的，没有任何观测锚点。本模块把锚点接进来。

实测到的两条事实（本轮，见下）：

1. **烟花登陆时宁波表层土壤已接近饱和。**ERA5-Land 0-7 cm 在
   `ANCHOR_ISO`（2021-07-25T06:00）实测 sm=0.520 m³/m³。按
   θ_sat=0.46 / θ_res=0.08 换算 θ=1.158 —— 超 1，因为再分析本身
   湿偏。`soil_theta0=0.45` 意味着"还剩 55% 容量可吸"，实测只剩
   ~0%。这是内核参数与实测的直接矛盾，不是标定精度问题。

2. **台风遮蔽期ET0 接近零。**同窗口`et0_fao_evapotranspiration`
   只有 0.03-0.10 mm/h。而 `net_sw_wm2=40.0` 按 Ghil-Sellers 推出
   的蒸发速率是 ~0.40 mm/h，**高估约 8 倍**。本模块接入 ET0 后，
   潜热项不再由固定辐射驱动。

**偏差纪律。** ERA5-Land 土壤湿度有据可查的湿偏（中位 +0.05 ~
+0.08 m³/m³，RMSE ~0.039，与 SMAP 相关 R=0.71）。因此本模块**不
直接把 sm 当θ 用**，而是：
  - 报出原始 sm；
  - 提供两种换算（湿偏修正 / 不修正），`dry_bias_m3_m3` 控制；
  - θ 裁剪到 [0, 1]，超 1 的部分显式计数 `n_theta_clipped`，不隐藏。
超 1 本身就是"再分析说这块地已经饱和"的信号，裁剪是对物理约束
的承认，不是修饰。

三条纪律沿用 `rainsrc.py`：
  1. **不修饰观测**。原始 sm 落盘，换算系数随输出物落盘。
  2. **离线可复现**。落`data/seed/soil_state_era5land.npz`，二次运行
     走缓存。本项目全程零 API key、零环境变量。
  3. **降级必须显式**。拉不到就抛 `SoilSourceError`，调用方降级到
     参数化常数并把 `driver=parametric-fallback` 写进输出物。

数据源：**ERA5-Land via Open-Meteo archive-api，免 key，CC BY 4.0**。
实测 0.1° 网格，服务端吸附坐标与请求坐标不同（本轮请求
29.87/121.55 返回 29.912125/121.536674），必须读返回坐标。
`reference_evapotranspiration` 变量实测 HTTP 400 不可用，ET0 只走
`et0_fao_evapotranspiration`（FAO-56 Penman-Monteith 参考蒸散，mm/h）。
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .data import DATA_DIR

SEED_DIR = DATA_DIR / "seed"

UA = "TyphoeusDemo/0.6 (soil-source; contact: typhoeus-demo@example.org)"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# 与 rainsrc.ANCHOR_ISO 同一个时刻。内核 t=0 对齐在这里，土壤初始
# 状态必须取同一时刻的观测，否则入渗起始条件与降雨时序错位。
ANCHOR_ISO = "2021-07-25T06:00"

# 取数日窗比内核 72 h 窗口宽：需要一段前期无雨时段来分离"降雨累积"
# 与"台风期高湿"两个来源。实测 07-15 至 07-30 共 384 h 无缺测。
CLIM_START = "2021-07-15"
CLIM_END = "2021-07-30"

# 换算常数。θ_sat/θ_res 取宁波粉质黏土与水稻土之间的典型值；
# 0-7 cm 层在 7 月台风季接近饱和，符合实测。
THETA_SAT = 0.46
THETA_RES = 0.08

# ERA5-Land 土壤湿度湿偏（m³/m³）。文献中位 +0.05 ~ +0.08，
# 取中值 0.065 作默认修正，区间上下界随输出物落盘供审计。
DRY_BIAS_M3_M3 = 0.065
DRY_BIAS_RANGE = (0.05, 0.08)


class SoilSourceError(RuntimeError):
    """土壤源不可用。调用方必须显式降级，不许静默继续。"""


@dataclass
class SoilProfile:
    """ERA5-Land 土壤状态与蒸散，接入计算域后的产物。"""

    sm_0_7: np.ndarray          # (nt,) 表层体积含水率 m³/m³
    sm_7_28: np.ndarray# (nt,) 次表层 m³/m³
    soil_temp_c: np.ndarray     # (nt,) 表层土壤温度 °C
    et0_mm_h: np.ndarray        # (nt,) FAO-56 参考蒸散 mm/h
    theta0: float               # anchor 时刻的相对饱和度（裁剪后）
    theta0_raw: float           # 未裁剪值，可 > 1
    et0_anchor_mm_h: float
    et0_mean_mm_h: float
    lat: float                  # 服务端吸附后的纬度
    lon: float
    window: tuple[str, str]
    n_timesteps: int
    fetched_at: str
    notes: dict = field(default_factory=dict)


def _http_json(url: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        raise SoilSourceError(
            f"Open-Meteo archive 返回 HTTP {e.code}：{body}") from e
    except Exception as e:
        raise SoilSourceError(f"Open-Meteo archive 请求失败：{e}") from e


# 逐变量可用性实测：`reference_evapotranspiration` 返回 400，
# 其余四个均 200。这里显式列出可用集，改动前先跑
# `python -m typhoeus.soilsrc --probe` 复验。
AVAILABLE_VARS = (
    "soil_moisture_0_to_7cm",
    "soil_moisture_7_to_28cm",
    "soil_temperature_0_to_7cm",
    "et0_fao_evapotranspiration",
)


def probe(lat: float = 29.87, lon: float = 121.55) -> dict:
    """逐变量探测 archive-api 可用性，返回 {var: True/False}。"""
    out: dict[str, bool] = {}
    for v in AVAILABLE_VARS + ("reference_evapotranspiration",):
        url = (f"{ARCHIVE_URL}?latitude={lat:.4f}&longitude={lon:.4f}"
               f"&start_date={CLIM_START}&end_date={CLIM_END}"
               f"&hourly={v}&timezone=Asia%2FShanghai")
        try:
            _http_json(url, timeout=30)
            out[v] = True
        except SoilSourceError:
            out[v] = False
    return out


def sm_to_theta(sm: np.ndarray | float,
                theta_sat: float = THETA_SAT,
                theta_res: float = THETA_RES,
                dry_bias: float = DRY_BIAS_M3_M3) -> np.ndarray:
    """体积含水率 → 相对饱和度。

    `dry_bias` 是对 ERA5-Land 湿偏的改正量（m³/m³），从 sm 里减掉
    再换算。取 0.0 即关闭修正，得到的是"再分析自己以为的饱和度"。

    输出可能 > 1（再分析高估 + 参数 θ_sat 偏低都会导致）。**不在
    ��函数内裁剪** —— 调用方需要知道超了多少，裁剪信息会进
    `n_theta_clipped`。
    """
    return (np.asarray(sm, dtype=np.float64) - dry_bias - theta_res) / \
        max(theta_sat - theta_res, 1e-12)


def fetch_soil(lat: float = 29.87, lon: float = 121.55,
               start: str = CLIM_START, end: str = CLIM_END,
               dry_bias: float = DRY_BIAS_M3_M3) -> SoilProfile:
    """拉取单点 ERA5-Land 土壤状态与 ET0 逐时序列。

    单点而非格网：土壤湿度在0.1° 尺度上空间梯度远小于降雨，把一个
    标量赋给全域比用 4 个节点插值出一个人为梯度更诚实。域内地形
    起伏带来的土壤差异不进本模型，口径限制写进 `notes`。
    """
    url = (f"{ARCHIVE_URL}?latitude={lat:.4f}&longitude={lon:.4f}"
           f"&start_date={start}&end_date={end}"
           "&hourly=" + ",".join(AVAILABLE_VARS) +
           "&timezone=Asia%2FShanghai")
    data = _http_json(url)

    h = data.get("hourly") or {}
    times = h.get("time") or []
    if not times:
        raise SoilSourceError("archive-api 返回空hourly")

    def _col(name: str) -> np.ndarray:
        raw = h.get(name)
        if raw is None:
            raise SoilSourceError(f"响应缺变量 {name}")
        return np.array([np.nan if v is None else float(v) for v in raw],
                        dtype=np.float64)

    sm07 = _col("soil_moisture_0_to_7cm")
    sm728 = _col("soil_moisture_7_to_28cm")
    st = _col("soil_temperature_0_to_7cm")
    et0 = _col("et0_fao_evapotranspiration")

    if ANCHOR_ISO not in times:
        raise SoilSourceError(
            f"anchor {ANCHOR_ISO} 不在返回窗口内，"
            f"实际窗口 {times[0]} .. {times[-1]}")
    i0 = times.index(ANCHOR_ISO)

    theta_raw_arr = sm_to_theta(sm07[i0], dry_bias=dry_bias)
    theta_raw = float(theta_raw_arr)

    # anchor 前 24 h 的 ET0 均值，比瞬时值稳；台风期辐射被云遮挡，
    # 瞬时值噪声大到能改变符号。
    w = et0[max(i0 - 24, 0):i0 + 1]
    finite = w[np.isfinite(w)]

    return SoilProfile(
        sm_0_7=sm07, sm_7_28=sm728, soil_temp_c=st, et0_mm_h=et0,
        theta0=float(np.clip(theta_raw, 0.0, 1.0)),
        theta0_raw=theta_raw,
        et0_anchor_mm_h=float(et0[i0]) if np.isfinite(et0[i0]) else 0.0,
        et0_mean_mm_h=float(finite.mean()) if finite.size else 0.0,
        lat=float(data["latitude"]), lon=float(data["longitude"]),
        window=(times[0], times[-1]), n_timesteps=len(times),
        fetched_at=dt.datetime.now().isoformat(timespec="seconds"),
        notes={
            "src": "ERA5-Land via Open-Meteo archive-api（免key）",
            "grid_deg":0.1,
            "anchor": ANCHOR_ISO,
            "anchor_index": i0,
            "requested_lat_lon": [lat, lon],
            "returned_lat_lon": [float(data["latitude"]),
                                  float(data["longitude"])],
            "variables": list(AVAILABLE_VARS),
            "licence": "CC BY 4.0（数据），需署名 Open-Meteo / ECMWF ERA5-Land",
            "theta_sat": THETA_SAT,
            "theta_res": THETA_RES,
            "dry_bias_m3_m3": dry_bias,
            "dry_bias_range_m3_m3": list(DRY_BIAS_RANGE),
            "n_theta_clipped": int(theta_raw > 1.0),
            "sm_anchor_m3_m3": float(sm07[i0]),
            "sm_7_28_anchor_m3_m3": float(sm728[i0]),
            "soil_temp_anchor_c": float(st[i0]),
            "caveat": "ERA5-Land 土壤湿度有 +0.05~+0.08 m³/m³ 湿偏"
                      "（RMSE ~0.039，与 SMAP 相关 R=0.71），已按 "
                      f"{dry_bias} 做定值改正，未做逐场变率订正；"
                      "单点值赋全域，未做地形订正；"
                      "ET0 是 FAO-56 参考蒸散(mm/h)，不是实测蒸散。",
        })


def save_cache(p: SoilProfile) -> Path:
    path = SEED_DIR / "soil_state_era5land.npz"
    SEED_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path, sm_0_7=p.sm_0_7, sm_7_28=p.sm_7_28,
        soil_temp_c=p.soil_temp_c, et0_mm_h=p.et0_mm_h,
        meta=np.array(json.dumps({
            "src": p.notes.get("src"),
            "theta0": p.theta0, "theta0_raw": p.theta0_raw,
            "et0_anchor_mm_h": p.et0_anchor_mm_h,
            "et0_mean_mm_h": p.et0_mean_mm_h,
            "lat": p.lat, "lon": p.lon,
            "window": list(p.window), "n_timesteps": p.n_timesteps,
            "fetched_at": p.fetched_at, "notes": p.notes,
        }, ensure_ascii=False)))
    return path


def load_cache() -> SoilProfile | None:
    path = SEED_DIR / "soil_state_era5land.npz"
    if not path.exists():
        return None
    z = np.load(path, allow_pickle=False)
    meta = json.loads(str(z["meta"]))
    return SoilProfile(
        sm_0_7=z["sm_0_7"], sm_7_28=z["sm_7_28"],
        soil_temp_c=z["soil_temp_c"], et0_mm_h=z["et0_mm_h"],
        theta0=float(meta["theta0"]), theta0_raw=float(meta["theta0_raw"]),
        et0_anchor_mm_h=float(meta["et0_anchor_mm_h"]),
        et0_mean_mm_h=float(meta["et0_mean_mm_h"]),
        lat=float(meta["lat"]), lon=float(meta["lon"]),
        window=tuple(meta["window"]), n_timesteps=int(meta["n_timesteps"]),
        fetched_at=meta["fetched_at"], notes=meta["notes"])


def get_soil(use_cache: bool = True, verbose: bool = True) -> tuple[SoilProfile, dict]:
    """取土壤初始状态与 ET0 驱动。优先缓存，其次实时拉取。

    返回 `(profile, driver_report)`。`driver` 字段标明实际走了哪条，
    调用方必须写进输出物 —— 只报数字不报来源的门槛结果无效。
    """
    log = (lambda *a: print(*a, flush=True)) if verbose else (lambda *a: None)

    if use_cache:
        c = load_cache()
        if c is not None:
            log(f"     土壤源 ERA5-Land 缓存命中  "
                f"θ0={c.theta0:.3f}  ET0_anchor={c.et0_anchor_mm_h:.3f} mm/h")
            return c, {"driver": "era5land-cache", **c.notes}

    try:
        log("[L0] 拉取 ERA5-Land 土壤湿度与 ET0（免 key） ...")
        p = fetch_soil()
        log(f"     {p.n_timesteps} 步  anchor sm={p.notes['sm_anchor_m3_m3']:.3f} "
            f"m3/m3  θ0={p.theta0:.3f}  ET0={p.et0_mean_mm_h:.3f} mm/h")
        save_cache(p)
        return p, {"driver": "era5land", **p.notes}
    except SoilSourceError as e:
        log(f"[!] ERA5-Land 不可用：{e}")
        log("[!] 降级到参数化土壤常数，θ0 与蒸散不可观测")
        raise SoilSourceError(
            f"土壤源降级：{e}。参数化常数（θ0=0.45、net_sw_wm2=40）"
            f"没有观测锚点，所有由它推出的入渗量必须在报告中标注为"
            f"参数化驱动") from e


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="逐变量探测可用性")
    ap.add_argument("--refresh", action="store_true", help="强制重新拉取")
    ap.add_argument("--dry-bias", type=float, default=DRY_BIAS_M3_M3)
    a = ap.parse_args()

    if a.probe:
        print(json.dumps(probe(), ensure_ascii=False, indent=2))
        raise SystemExit(0)

    try:
        prof, rep = get_soil(use_cache=not a.refresh)
    except SoilSourceError as e:
        print(f"soil source unavailable: {e}")
        raise SystemExit(1)

    i0 = rep["anchor_index"]
    print(json.dumps({
        k: v for k, v in rep.items()
        if k not in ("variables", "caveat", "returned_lat_lon",
                     "requested_lat_lon", "dry_bias_range_m3_m3")
    }, ensure_ascii=False, indent=2))
    print("\n# 锚点邻域序列")
    for i in range(max(i0 - 72, 0), min(i0 + 25, prof.n_timesteps), 6):
        th = float(np.clip(sm_to_theta(prof.sm_0_7[i],
                                       dry_bias=a.dry_bias), 0, 1))
        print(f"  idx={i:3d}  sm={prof.sm_0_7[i]:.3f}  θ={th:.3f}  "
              f"et0={prof.et0_mm_h[i]:.3f} mm/h  T={prof.soil_temp_c[i]:.1f} C")