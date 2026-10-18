"""取公共空间几何并算调蓄潜力（慢速、带退避，避开 Overpass 限速）。

输出：域内公园/球场/体育场的面积，以及"下沉 X 米"可提供的调蓄容积，
并折算成等效面雨量削减（mm）。
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = ROOT / "data" / "seed" / "osm_public_space.json"

CTX = ssl.create_default_context()
UA = {"User-Agent": "typhoeus-demo/0.1 (research)"}
BBOX = "29.79,121.50,29.97,121.75"
MIRRORS = ["https://overpass.private.coffee/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass-api.de/api/interpreter"]

# 只取三类调蓄载体
TAGS = {
    "公园": 'way["leisure"="park"]',
    "球场": 'way["leisure"="pitch"]',
    "体育场": 'way["leisure"="stadium"]',
}


def fetch(tag: str, sel: str) -> list[dict]:
    q = f"[out:json][timeout:120];{sel}({BBOX});out geom;"
    data = urllib.parse.urlencode({"data": q}).encode()
    for m in MIRRORS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    m, data=data,
                    headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
                    j = json.loads(r.read().decode("utf-8", "replace"))
                els = j.get("elements", [])
                print(f"  {tag}: {len(els)} 个要素（{m.split('//')[1][:24]}）")
                return els
            except urllib.error.HTTPError as e:
                print(f"    {e.code} {m.split('//')[1][:24]} {tag} 第{attempt+1}次")
                time.sleep(8 * (attempt + 1))
            except Exception as e:  # noqa: BLE001
                print(f"    ERR {type(e).__name__} {tag}")
                time.sleep(5)
    return []


def ring_area_m2(geom: list[dict]) -> float:
    """球面多边形面积（小区域近似）：先投影到局部平面。"""
    import math

    if len(geom) < 3:
        return 0.0
    lat0 = sum(p["lat"] for p in geom) / len(geom)
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    xs = [p["lon"] * kx for p in geom]
    ys = [p["lat"] * ky for p in geom]
    s = 0.0
    n = len(xs)
    for i in range(n):
        j = (i + 1) % n
        s += xs[i] * ys[j] - xs[j] * ys[i]
    return abs(s) / 2.0


def main() -> int:
    if CACHE.exists():
        data = json.loads(CACHE.read_text(encoding="utf-8"))
        print(f"用缓存 {CACHE.name}")
    else:
        data = {}
        for tag, sel in TAGS.items():
            data[tag] = fetch(tag, sel)
            time.sleep(12)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"→ 缓存 {CACHE}")

    # 面积汇总（只统计落在计算域内的）
    LON_MIN, LON_MAX = 121.550139, 121.699583
    LAT_MIN, LAT_MAX = 29.840417, 29.919861
    summary = {}
    for tag, els in data.items():
        tot = 0.0
        n = 0
        for e in els:
            g = e.get("geometry") or []
            if len(g) < 3:
                continue
            clat = sum(p["lat"] for p in g) / len(g)
            clon = sum(p["lon"] for p in g) / len(g)
            if not (LON_MIN <= clon <= LON_MAX and LAT_MIN <= clat <= LAT_MAX):
                continue
            a = ring_area_m2(g)
            if a <= 0:
                continue
            tot += a
            n += 1
        summary[tag] = {"要素数": n, "面积_ha": round(tot / 1e4, 1)}
        print(f"  {tag:<6} 域内 {n:>4} 处  面积 {tot/1e4:>8.1f} 公顷")

    hectare = sum(v["面积_ha"] for v in summary.values())
    area_m2 = hectare * 1e4
    domain_km2 = ((LON_MAX - LON_MIN) * 111.32 * 0.999
                  * (LAT_MAX - LAT_MIN) * 110.54)
    # 下沉深度情景
    depths = [0.2, 0.3, 0.5, 1.0]
    scen = []
    for d in depths:
        vol = area_m2 * d
        mm = vol / (domain_km2 * 1e6) * 1000.0     # 折算为全域面雨量 mm
        scen.append({"下沉深度_m": d, "可调蓄容积_万m3": round(vol / 1e4, 1),
                     "等效全域雨量削减_mm": round(mm, 2)})

    payload = {
        "名称": "公共空间调蓄潜力（自然—人工水系互联的量化入口）",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "数据来源": "OpenStreetMap via Overpass（ODbL）",
        "范围": {"bbox": BBOX, "计算域_km2": round(domain_km2, 2)},
        "公共空间": summary,
        "合计_公顷": round(hectare, 1),
        "调蓄情景": scen,
        "解读": (
            "把域内公共空间下沉改造，可提供的调蓄容积很小："
            "即使全部下沉 1 m，也只相当于几毫米面雨量——"
            "对比本次事件的 259 mm，杯水车薪。"
            "**公共空间调蓄的价值不在总量，而在「局部削峰」**："
            "它只能护住周边几百米范围的低洼点，不能替代管网。"
        ),
        "边界": [
            "OSM 公园/球场边界不是可下沉范围，实际可用面积远小于此。",
            "下沉深度需扣除覆土、结构、排水层，工程可行值通常 ≤0.3 m。",
            "未区分公园内水体（本就不能再调蓄）与硬化场地。",
            "OSM 覆盖不完整，域外公园未计入。",
        ],
    }
    (OUT / "p29_公共空间调蓄潜力.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  合计 {hectare:.1f} 公顷；计算域 {domain_km2:.1f} km²")
    for s in scen:
        print(f"    下沉 {s['下沉深度_m']} m → {s['可调蓄容积_万m3']} 万 m³ "
              f"= 全域 {s['等效全域雨量削减_mm']} mm")
    print(f"→ {OUT / 'p29_公共空间调蓄潜力.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
