"""IMERG 逐半小时取数（GES DISC OPeNDAP 约束子集）。

设计为"凭据到位即可跑通"的管道：
  - 带指数退避重试（GES DISC 对频繁失败请求会临时断连，实测出现 WinError 10060）
  - 自动判定三态：元数据通/取数 401（EULA 未批准）/ 连接失败（限速）
  - 只取宁波计算域的 3×3 格 × 事件窗，落成 npz

用法：
  set EDL=<token>
  python -m typhoeus.imerg_fetch [--days 2021-07-24..2021-07-28] [--outdir out]

认证说明（实测）：
  EDL 的 renew_token 用 Bearer 返回 200 → token 有效；
  GES DISC 的 .dds/.das 返回 200 → 服务可达；
  取数路径（.ascii/.dods/文件下载）返回 401 → 该应用 EULA 未获批准。
"""

from __future__ import annotations

import argparse
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BASE_DIR = "https://gpm1.gesdisc.eosdis.nasa.gov/opendap/GPM_L3/GPM_3IMERGHH.07"
# 计算域（DEM 重采样后的实际范围）
LON_MIN, LON_MAX = 121.550139, 121.699583
LAT_MIN, LAT_MAX = 29.840417, 29.919861
# IMERG 0.1°：lon -180..180，lat -90..90
RES = 0.1


def _idx(bounds: tuple[float, float], lo: float, hi: float, origin: float) -> tuple[int, int]:
    a = int(round((bounds[0] - origin) / RES))
    b = int(round((bounds[1] - origin) / RES))
    return (min(a, b), max(a, b))


LON_I = _idx((LON_MIN, LON_MAX), LON_MIN, LON_MAX, -180.0)
LAT_I = _idx((LAT_MIN, LAT_MAX), LAT_MIN, LAT_MAX, -90.0)


def _ctx() -> ssl.SSLContext:
    return ssl.create_default_context()


def _request(url: str, token: str, timeout: int = 120, retries: int = 4):
    """带指数退避的请求。返回 (ok, status, body)。"""
    hdrs = {"User-Agent": "Mozilla/5.0 (typhoeus-demo imerg)",
            "Authorization": f"Bearer {token}"}
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
                return True, r.status, r.read()
        except urllib.error.HTTPError as e:
            return False, e.code, e.read(400)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(30, 3 * (2 ** attempt)))
    return False, None, str(last).encode()


def granule_url(d: date, half_hour_index: int) -> str:
    """拼 IMERG HHR granule 的 OPeNDAP 地址（文件名由起始时刻决定）。"""
    doy = d.timetuple().tm_yday
    start_min = half_hour_index * 30
    hh, mm = divmod(start_min, 60)
    end_min = start_min + 29
    eh, em = divmod(end_min, 60)
    if em == 59:
        eh, em = (hh, 59) if end_min == start_min + 29 else (eh, em)
    end_h = (end_min + 1) // 60
    end_m = 59
    name = (f"3B-HHR.MS.MRG.3IMERG.{d:%Y%m%d}-S{hh:02d}{mm:02d}00-"
            f"E{end_h:02d}{end_m:02d}59.{start_min:04d}.V07B.HDF5")
    return f"{BASE_DIR}/{d.year}/{doy:03d}/{name}"


def fetch_point_series(days: list[date], token: str, verbose: bool = True) -> dict:
    """逐 granule 取宁波子集，返回结构化结果与判定。"""
    rows = []
    diag = {"首个元数据": None, "首个取数": None, "错误样例": None}
    for d in days:
        for i in range(48):                     # 每天 48 个半小时
            url = granule_url(d, i)
            ok, status, body = _request(url + ".dds", token, timeout=60)
            if diag["首个元数据"] is None:
                diag["首个元数据"] = (status, body[:80].decode("utf-8", "replace"))
            if not ok:
                diag["错误样例"] = f"{url}.dds -> {status}"
                continue
            sub = (f"?precipitation[0][{LON_I[0]}:1:{LON_I[1]}]"
                   f"[{LAT_I[0]}:1:{LAT_I[1]}]")
            ok2, status2, body2 = _request(url + ".ascii" + sub, token, timeout=120)
            if diag["首个取数"] is None:
                diag["首个取数"] = (status2, body2[:120].decode("utf-8", "replace"))
            if not ok2:
                diag["错误样例"] = f"{url}.ascii -> {status2}"
                continue
            # 解析 ascii：值块在 "precipitation = { ... }" 之内
            txt = body2.decode("utf-8", "replace")
            rows.append({"date": str(d), "i": i, "url": url, "raw": txt[:400]})
            if verbose:
                print(f"  OK {d} #{i:02d}")
    return {"rows": rows, "诊断": diag}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.imerg_fetch")
    ap.add_argument("--start", default="2021-07-24")
    ap.add_argument("--end", default="2021-07-28")
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--probe", action="store_true", help="只探一个 granule 判定三态")
    a = ap.parse_args(argv)

    token = os.environ.get("EDL", "").strip()
    if not token:
        print("未设置环境变量 EDL（Earthdata token）", flush=True)
        return 2

    s, e = date.fromisoformat(a.start), date.fromisoformat(a.end)
    days = [s + timedelta(days=i) for i in range((e - s).days + 1)]
    print(f"目标 {s}..{e}（{len(days)} 天 × 48 个半小时）")
    print(f"格点子集 lon[{LON_I[0]}:{LON_I[1]}] lat[{LAT_I[0]}:{LAT_I[1]}]")

    if a.probe:
        url = granule_url(s, 0)
        ok, st, body = _request(url + ".dds", token, timeout=60)
        print(f"元数据 .dds : {st} {'OK' if ok else body[:100]!r}")
        ok2, st2, body2 = _request(
            url + f".ascii?precipitation[0][{LON_I[0]}:1:{LON_I[1]}]"
                  f"[{LAT_I[0]}:1:{LAT_I[1]}]", token, timeout=120)
        print(f"取数 .ascii : {st2} {'OK' if ok2 else body2[:160]!r}")
        if ok2:
            print("→ EULA 已批准，可全量取数")
            return 0
        if st2 == 401:
            print("→ 401：该应用 EULA 未批准（token 有效，无需换 token）")
            return 3
        print("→ 连接失败/限速，稍后重试")
        return 4

    res = fetch_point_series(days, token)
    out = Path(a.outdir) / "p10_IMERG取数状态.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json
    out.write_text(json.dumps({
        "目标窗口": f"{s}..{e}", "成功granule数": len(res["rows"]),
        "诊断": {k: (list(v) if isinstance(v, tuple) else v)
                 for k, v in res["诊断"].items()},
        "格点": {"lon": LON_I, "lat": LAT_I},
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n成功 {len(res['rows'])} 个 granule → {out}")
    if not res["rows"]:
        print("三态：BLOCKED —— 见 p10 诊断字段")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
