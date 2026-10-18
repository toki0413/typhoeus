"""中央气象台台风网：官方最佳路径读取器（免注册）。

为什么要有这一件
----------------
赛事官方《参赛数据源汇总》（深求社区，2026-10-13）在【05 浙江台风内涝】
一条下推荐的首个来源就是「中央气象台台风网」。本项目主链现用 IBTrACS
（NOAA 国际最佳路径），两者互补：

  IBTrACS  ：国际多机构合成，118 点（近岸加密），有发布滞后
  中央气象台 ：中国官方（WNP 区域专责中心），81 点 6 小时，实时可查

中央气象台的接口是 JSONP，且**两种端点括号层数不同**（`list_default`
是 `f(({...}))`，`list_2021` 是 `f({...})`）。本模块不数括号，直接取
首个 `{` 到末个 `}`，避免这个坑。

接口形态（实测 2026-10-17）
--------------------------
  年度列表  /weatherservice/typhoon/jsons/list_<year>
  路径详情  /weatherservice/typhoon/jsons/view_<tid>
  点格式    [点id, "YYYYMMDDHHMM", epoch_ms, 等级, 经度, 纬度, 气压, 风速m/s, ...]
  注意：**经度在纬度之前**（与 TrackPoint 的字段顺序相反，易错）

用法
----
    python -m typhoeus.nmc_track            # 自测：取烟花并与 IBTrACS 对比
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request

BASE = "http://typhoon.nmc.cn/weatherservice/typhoon/jsons"
UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120 Safari/537.36"),
    "Referer": "http://typhoon.nmc.cn/web.html",
}
# 该站点证书链在部分环境不可验，只读公开数据，故不校验证书。
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# 等级字符串 → 便于下游识别的中文阶段标签
GRADE_ZH = {
    "TD": "热带低压", "TS": "热带风暴", "STS": "强热带风暴",
    "TY": "台风", "STY": "强台风", "SuperTY": "超强台风",
}


class NmcError(RuntimeError):
    """中央气象台台风网取数失败。与"数据不存在"分开，便于下游区分。"""


def _get(path: str) -> str:
    url = f"{BASE}/{path}"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60, context=_CTX) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise NmcError(f"{url} 返回 HTTP {e.code}") from e
    except Exception as e:  # noqa: BLE001
        raise NmcError(f"{url} 请求失败：{type(e).__name__}: {e}") from e


def _unwrap(raw: str) -> dict:
    """JSONP → dict。不数括号，取首 `{` 到末 `}`。"""
    i, j = raw.find("{"), raw.rfind("}")
    if i < 0 or j <= i:
        raise NmcError(f"响应里找不到 JSON 主体（前 80 字符：{raw[:80]!r}）")
    try:
        return json.loads(raw[i:j + 1])
    except json.JSONDecodeError as e:
        raise NmcError(f"JSON 解析失败：{e}") from e


def list_season(year: int) -> list[dict]:
    """某年台风列表。返回 [{tid, name, name_cn, code, status}, ...]。"""
    j = _unwrap(_get(f"list_{year}"))
    rows = j.get("typhoonList") or []
    out = []
    for t in rows:
        if len(t) < 4:
            continue
        out.append({
            "tid": t[0],
            "name": (t[1] or "").strip(),
            "name_cn": t[2],
            "code": str(t[3]),
            "status": t[7] if len(t) > 7 else None,
        })
    return out


def fetch_track(tid: int) -> dict:
    """取一个台风的官方路径。

    返回 {"meta": {...}, "points": [TrackPoint-like dict, ...]}，
    点为 dict 而非 data.TrackPoint，避免本模块反向依赖 data（data 已依赖网络层）。
    """
    j = _unwrap(_get(f"view_{tid}"))
    t = j.get("typhoon")
    if not t or len(t) < 9:
        raise NmcError(f"view_{tid} 返回结构不符（取到 {type(t).__name__}）")
    raw_pts = t[8] or []
    pts = []
    for p in raw_pts:
        if len(p) < 8:
            continue
        # [点id, 时间str, epoch, 等级, 经度, 纬度, 气压, 风速m/s, ...]
        pts.append({
            "t": str(p[1]),
            "lon": float(p[4]),
            "lat": float(p[5]),
            "pres_mb": float(p[6]) if p[6] is not None else None,
            "vmax_ms": float(p[7]) if p[7] is not None else None,
            "vmax_kts": (round(float(p[7]) / 0.514444, 1)
                         if p[7] is not None else None),
            "grade": str(p[3] or ""),
            "stage": GRADE_ZH.get(str(p[3] or ""), str(p[3] or "")),
        })
    return {
        "meta": {
            "tid": t[0], "name": t[1], "name_cn": t[2],
            "code": str(t[3]), "status": t[7],
            "来源": "中央气象台台风网（typhoon.nmc.cn）",
        },
        "points": pts,
    }


def find_by_code(year: int, code: str) -> dict | None:
    """按编号（如 "2106"）或英文名检索。"""
    code = str(code).strip().upper()
    for row in list_season(year):
        if row["code"] == code or str(row["name"]).upper() == code:
            return row
    return None


def _selftest() -> int:
    """自测：取 2021 烟花，检查点数、范围、经度在纬度之前、与 IBTrACS 的偏差。"""
    print("=== 中央气象台台风网读取器自测 ===")
    row = find_by_code(2021, "2106")
    if not row:
        print("  FAIL 未找到 2021 年第 06 号（烟花）")
        return 1
    print(f"  检索命中：{row['name_cn']}（{row['name']}）tid={row['tid']} "
          f"code={row['code']} status={row['status']}")

    tr = fetch_track(row["tid"])
    pts = tr["points"]
    print(f"  路径点 {len(pts)} 个，时间 {pts[0]['t']} .. {pts[-1]['t']}")
    lons = [p["lon"] for p in pts]
    lats = [p["lat"] for p in pts]
    print(f"  经度 {min(lons)}..{max(lons)}   纬度 {min(lats)}..{max(lats)}")

    ok = True
    # 1) 经度应在 100..180（西北太平洋），纬度应在 0..50；若颠倒会立刻异常
    if not (100 <= max(lons) <= 180 and 0 <= max(lats) <= 50):
        print(f"  FAIL 经纬度疑似颠倒：lon max {max(lons)} lat max {max(lats)}")
        ok = False
    else:
        print("  PASS 经纬度顺序正确（经度在纬度之前）")

    # 2) 必须覆盖 2021-07-25（台风影响宁波当日）
    has_day = any(p["t"].startswith("20210725") for p in pts)
    print(f"  {'PASS' if has_day else 'FAIL'} 覆盖 2021-07-25（宁波受灾日）")
    ok = ok and has_day

    # 3) 与 IBTrACS 比对同名时刻的位置偏差
    try:
        import re as _re

        from typhoeus import data as D

        def _key(s: str) -> str:
            """把任意时间串压成 YYYYMMDDHHMM，只留数字。

            IBTrACS 的 ISO_TIME 形如 "2021-07-16 12:00:00"，含冒号；
            只删 '-' 与空格会把 "12:00" 留在前 12 位里，导致键永远对不上。
            """
            return _re.sub(r"\D", "", str(s))[:12]

        ib = D.load_track(season=2021, name="IN-FA")
        ib_map = {_key(getattr(p, "t", "")): p for p in ib}
        diffs = []
        for p in pts:
            key = _key(p["t"])
            if key in ib_map:
                q = ib_map[key]
                d = ((p["lon"] - q.lon) ** 2 + (p["lat"] - q.lat) ** 2) ** 0.5
                diffs.append(d)
        if diffs:
            diffs.sort()
            med = diffs[len(diffs) // 2]
            print(f"  PASS 与 IBTrACS 同刻比对 {len(diffs)} 点，"
                  f"位置偏差中位 {med:.3f}°、最大 {diffs[-1]:.3f}°")
        else:
            print(f"  WARN 与 IBTrACS 无同刻点可比"
                  f"（NMC 首点 {pts[0]['t']}，IBTrACS 首点 "
                  f"{getattr(ib[0], 't', '?') if ib else '无'}）")
    except Exception as e:  # noqa: BLE001
        print(f"  WARN 未能与 IBTrACS 比对：{type(e).__name__}: {e}")

    print(f"\n  结论：{'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
