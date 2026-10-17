"""从全国 OSM 快照里取宁波小域，给涝点定米级坐标并判定"附近有无下穿结构"。

数据源：ModelScope 镜像 ocero4/china-260820-openstreetmap-pbf（匿名免 key 下载，
快照时点 2020-08-26，比烟花早 11 个月；静态几何可用，绝对高程不在里面）。

分三段可续跑，任何一段崩了不必从头：
  pass1  扫节点，落 in-bbox 的 id→坐标（最重的一遍）
  pass2  扫 ways，用 pass1 的表判域并留 highway/tunnel/bridge/name
  match  按台账地名与周边要素配对，产出坐标候选与结构标签
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PBF = ROOT / "data" / "osm" / "china-260820.osm.pbf"
NODES_JSON = ROOT / "data" / "osm" / "nb_nodes.json"
WAYS_JSON = ROOT / "data" / "osm" / "nb_ways.json"
MATCH_JSON = ROOT / "data" / "seed" / "osm_flood_match.json"
WAY_KEYS = ("highway", "tunnel", "bridge", "man_made", "waterway")

import osmium  # noqa: E402
import osmium.filter as FILT  # noqa: E402


def _bbox():
    from typhoeus import config as CFG
    b = CFG.Config().l2.bbox
    return b["lon_min"], b["lon_max"], b["lat_min"], b["lat_max"]


def _m_per_deg(lat: float) -> tuple[float, float]:
    import math
    return 111320.0 * math.cos(math.radians(lat)), 110540.0


class _Stop(Exception):
    """烟测用截断信号：从 C++ 回调里抛出，由 apply_file 外层接住。"""


def pass1(max_nodes: int = 0) -> None:
    lon0, lon1, lat0, lat1 = _bbox()

    class H(osmium.SimpleHandler):
        def __init__(self, cap: int):
            super().__init__()
            self.kept: dict[int, tuple[float, float]] = {}
            self.n = 0
            self.cap = cap
            self.t0 = time.time()

        def node(self, n):
            self.n += 1
            if self.n % 10_000_000 == 0:
                print(f"[pass1] 已扫 {self.n/1e6:.0f}M 节点  域内保留 {len(self.kept)}  "
                      f"{time.time()-self.t0:.0f} s", flush=True)
            if self.cap and self.n > self.cap:
                raise _Stop()
            try:
                lon, lat = n.location.lon, n.location.lat
            except Exception:  # noqa: BLE001
                return
            if lon0 <= lon <= lon1 and lat0 <= lat <= lat1:
                self.kept[n.id] = (lon, lat)

    print(f"[pass1] 域 {lon0:.4f}–{lon1:.4f}, {lat0:.4f}–{lat1:.4f} 开始扫 {PBF.name}"
          f"{'（烟测截断）' if max_nodes else ''}", flush=True)
    t = time.time()
    h = H(max_nodes)
    try:
        h.apply_file(str(PBF))
    except _Stop:
        print(f"[pass1] 达 --max-nodes {max_nodes}，提前收扫（烟测，非全域结果）", flush=True)
    NODES_JSON.write_text(json.dumps({str(k): v for k, v in h.kept.items()}), encoding="utf-8")
    rate = h.n / max(time.time() - t, 1e-9)
    print(f"[pass1] 完成：扫 {h.n/1e6:.1f}M 节点，域内留 {len(h.kept)}，"
          f"{rate/1e3:.1f}k 节点/s，用时 {time.time()-t:.0f} s → {NODES_JSON.name}", flush=True)
    return h.n, len(h.kept), rate


def pass2() -> None:
    lon0, lon1, lat0, lat1 = _bbox()
    nodes = {int(k): tuple(v) for k, v in json.loads(NODES_JSON.read_text(encoding="utf-8")).items()}
    out: list[dict] = []

    class H(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.n = 0
            self.t0 = time.time()

        def way(self, w):
            self.n += 1
            if self.n % 2_000_000 == 0:
                print(f"[pass2] 已扫 {self.n/1e6:.0f}M ways  域内留 {len(out)}  "
                      f"{time.time()-self.t0:.0f} s", flush=True)
            refs = [nd.ref for nd in w.nodes]
            pts = [nodes[r] for r in refs if r in nodes]
            if not pts:
                return
            if not any(lon0 <= lon <= lon1 and lat0 <= lat <= lat1 for lon, lat in pts):
                return
            tg = dict(w.tags)
            out.append({"id": w.id, "refs": refs[:40],
                        "tags": {k: tg[k] for k in ("highway", "tunnel", "bridge", "man_made",
                                                    "waterway", "name", "layer", "location",
                                                    "cycleway", "maxspeed") if k in tg},
                        "in_bbox": len(pts), "total": len(refs)})

    # 这版 pyosmium 没有 TagsFilter，TagFilter 要求 (key, value) 成对；
    # "含有任一 key" 的过滤器是 KeyFilter(*keys)。
    flt = FILT.KeyFilter(*WAY_KEYS)
    h = H()
    osmium.apply(str(PBF), flt, h)
    if h.n == 0:
        raise SystemExit("[pass2] 过滤器没放进任何 way（KeyFilter 未生效），不写空产物")
    if not out:
        print("[pass2] 警告：过滤器放进了 way，但域内一条都没有——"
              "检查 pass1 的节点表是否覆盖本域", flush=True)
    WAYS_JSON.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"[pass2] 经过滤器进入回调的 ways {h.n}，域内留 {len(out)} → {WAYS_JSON.name}", flush=True)


def match() -> None:
    from typhoeus import observe as OB
    lon0, lon1, lat0, lat1 = _bbox()
    cx = (lon0 + lon1) / 2
    mx, my = _m_per_deg(cx)
    ways = json.loads(WAYS_JSON.read_text(encoding="utf-8")) if WAYS_JSON.exists() else []
    nodes = ({int(k): tuple(v) for k, v in
              json.loads(NODES_JSON.read_text(encoding="utf-8")).items()}
             if NODES_JSON.exists() else {})
    pts: list[tuple[float, float, str, dict]] = []
    for w in ways:
        tg = w["tags"]
        for r in w["refs"]:
            if r in nodes:
                pts.append((nodes[r][0], nodes[r][1], tg.get("name", ""), tg))

    def norm(s: str) -> str:
        return re.sub(r"[（）()\s路街道区]", "", s or "")

    rows = []
    for p in OB.load_flood_points():
        if not (lon0 <= p.lon <= lon1 and lat0 <= p.lat <= lat1):
            continue
        key = norm(re.sub(r"[（(].*?[)）]", "", p.name))
        best, cand = None, 0
        for lon, lat, nm, tg in pts:
            if not nm or not key or (key not in norm(nm) and norm(nm) not in key):
                continue
            d = ((lon - p.lon) * mx) ** 2 + ((lat - p.lat) * my) ** 2
            cand += 1
            if best is None or d < best[0]:
                best = (d, lon, lat, nm, tg)
        near = [(tg.get("tunnel") or tg.get("bridge") or tg.get("man_made") or "",
                 tg.get("highway", ""), nm)
                for lon, lat, nm, tg in pts
                if ((lon - p.lon) * mx) ** 2 + ((lat - p.lat) * my) ** 2 <= 300 ** 2
                and (tg.get("tunnel") or tg.get("bridge") or tg.get("man_made"))]
        rows.append({
            "point_id": p.point_id, "name": p.name, "structure_type": p.structure_type,
            "old": [p.lon, p.lat],
            "matched": bool(best), "matched_name": best[3] if best else None,
            "new": [best[1], best[2]] if best else None,
            "shift_m": round(((best[0]) ** 0.5), 1) if best else None,
            "name_hits": cand,
            "underpass_within_300m": len(near),
            "near_kinds": sorted({f"{a or b}@{c[:12]}" for a, b, c in near})[:5],
        })
    MATCH_JSON.write_text(json.dumps({
        "src": f"OSM 快照 {PBF.name}（ModelScope ocero4/china-260820-openstreetmap-pbf，"
               f"匿名免key 下载），几何为 2020-08-26 时点，无高程",
        "domain_bbox": {"lon": [lon0, lon1], "lat": [lat0, lat1]},
        "n_ways_in_bbox": len(ways), "n_named_vertices": len(pts),
        "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    hit = sum(1 for r in rows if r["matched"])
    up = sum(1 for r in rows if r["underpass_within_300m"])
    print(f"[match] 域内涝点 {len(rows)}，地名命中 {hit}，300 m 内有桥隧/下穿要素 {up} "
          f"→ {MATCH_JSON.name}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=("pass1", "pass2", "match", "all"))
    ap.add_argument("--max-nodes", type=int, default=0,
                    help="只扫前 N 个节点就收（烟测用，验证写盘链路，不出全域结果）")
    a = ap.parse_args()
    if not PBF.exists():
        raise SystemExit(f"缺少 {PBF}")
    for st in (("pass1", "pass2", "match") if a.stage == "all" else (a.stage,)):
        if st == "pass1":
            pass1(a.max_nodes)
        else:
            {"pass2": pass2, "match": match}[st]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
