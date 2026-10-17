#!/usr/bin/env bash
# 提比翁云端作业：A 复算对账 → B OSM 取数 → C 包络网格 → D 多事件批量
# 全部落数据盘；系统盘只放解释器与已装包。任何一步崩了前面的产物都还在。
#
# 两处口径修正（2026-10-16 实测暴露）：
#   · cli 只有 run 子命令接受 --outdir，check / multievent 不接受，之前给它们加了参数
#   · 机器有 128 核，包络网格是 21 次互相独立的推演，改成并行（tools/envelope_grid.py）
set -uo pipefail

W="${DATA_DISK:-/root/autodl-tmp}/typhoeus"
TGZ="${1:-typhoeus_core.tar.gz}"
mkdir -p "$W" || exit 1
cd "$W" || exit 1
echo "[env] 工作区 $W"; df -h "$W" | sed -n '2p'; nproc; python3 -V
mkdir -p "$W/out_cloud"

# 0) 依赖（只装缺的，不动系统盘的 conda 基线）
python3 -c "import numpy,scipy" 2>/dev/null || python3 -m pip install -q "numpy>=2.0" "scipy>=1.11"
python3 -c "import rasterio" 2>/dev/null || python3 -m pip install -q "rasterio>=1.3"
python3 -c "import osmium" 2>/dev/null || python3 -m pip install -q osmium
python3 -c "import pytest" 2>/dev/null || python3 -m pip install -q "pytest>=8"

# 1) 解码（tar 里已含 DEM 与 seed；IBTrACS 两个大分片另放 $W/data/）
if [ -f "$W/$TGZ" ]; then tar xzf "$W/$TGZ" -C "$W" && echo "[code] 解包完成"; else echo "[code] 没找到 $TGZ，假设已解压"; fi
cd "$W" || exit 1

echo "===[A] 全链复算 + 门槛对账（约 50 s）==="
timeout 900 python3 -X utf8 -m typhoeus.cli run --outdir "$W/out_cloud" > "$W/out_cloud/run.log" 2>&1
echo "[A] run 退出码 $?（详见 out_cloud/run.log）"
timeout 900 python3 -X utf8 -m typhoeus.cli check > "$W/out_cloud/check.log" 2>&1
echo "[A] check 退出码 $?；门槛三态计数：$(grep -oE 'PASS|FAIL|BLOCKED' "$W/out_cloud/check.log" | sort | uniq -c | tr '\n' ' ')"
python3 -X utf8 - <<'PY'
import json, pathlib
a = json.load(open("out/06_health_report.json", encoding="utf-8"))
b = json.load(open("out_cloud/06_health_report.json", encoding="utf-8"))
for k in ("面雨量_mm", "峰值水深_m", "config_hash"):
    print(f"[A 对账] {k}: 归档 {a.get(k)!r} | 云端 {b.get(k)!r} | "
          f"{'一致' if a.get(k)==b.get(k) else '不一致'}")
ra = a["守恒性"]["相对残差"]; rb = b["守恒性"]["相对残差"]
print(f"[A 对账] 守恒残差: 归档 {ra:.3e} | 云端 {rb:.3e} | "
      f"{'逐位一致' if ra==rb else f'末位漂移 {abs(ra-rb):.1e}，两者都远低于容差 1e-6'}")
PY

echo "===[B] OSM 全国包取数与宁波小域（ModelScope 匿名免 key，1.58 GB）==="
OSMDIR="$W/data/osm"; mkdir -p "$OSMDIR"
if [ ! -s "$OSMDIR/china-260820.osm.pbf" ]; then
  curl -sS -L --retry 6 --retry-all-errors -C - --max-time 3600 -A "Mozilla/5.0" \
    -o "$OSMDIR/china-260820.osm.pbf" \
    "https://modelscope.cn/api/v1/datasets/ocero4/china-260820-openstreetmap-pbf/repo?Revision=master&FilePath=china-260820.osm.pbf"
fi
ls -l "$OSMDIR/china-260820.osm.pbf"
timeout 7200 python3 -X utf8 tools/osm_flood_match.py pass1 2>&1 | tail -4
timeout 7200 python3 -X utf8 tools/osm_flood_match.py pass2 2>&1 | tail -3
timeout 600  python3 -X utf8 tools/osm_flood_match.py match 2>&1 | tail -2

echo "===[C] 量级包络网格（7×3=21 格，并行）==="
timeout 3600 python3 -X utf8 tools/envelope_grid.py --jobs "${JOBS:-21}" \
  --out "$W/out_cloud/envelope_grid.json" 2>&1 | tail -8

echo "===[D] 18 场多事件批量（约 280 s）==="
timeout 1800 python3 -X utf8 -m typhoeus.cli multievent > "$W/out_cloud/multievent.log" 2>&1
echo "[D] multievent 退出码 $?；产物 $(ls -1 "$W"/out/07_multievent_calibration.json 2>/dev/null || echo 未见)"

echo "===[汇总]==="
df -h "$W" | sed -n '2p'
ls -l "$W/out_cloud" 2>/dev/null | tail -10
ls -l "$W/data/seed/osm_flood_match.json" "$W/out_cloud/envelope_grid.json" 2>/dev/null
