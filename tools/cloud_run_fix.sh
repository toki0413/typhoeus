#!/usr/bin/env bash
# 补跑被参数错误跳过的段：A 的门槛检查 + C 并行包络 + D 多事件。
# B 段（OSM pass1）此刻正在另一个进程里跑，这里不碰它。
set -uo pipefail
W="${DATA_DISK:-/root/autodl-tmp}/typhoeus"
cd "$W" || exit 1
mkdir -p "$W/out_cloud"
echo "[env] $W  核数 $(nproc)  负载 $(cut -d' ' -f1 /proc/loadavg)"

echo "===[A2] 27 条门槛（check 不吃 --outdir，之前那行是错的）==="
timeout 900 python3 -X utf8 -m typhoeus.cli check > "$W/out_cloud/check.log" 2>&1
echo "[A2] 退出码 $?；三态计数：$(grep -oE '"(PASS|FAIL|BLOCKED)"' "$W/out_cloud/check.log" | tr -d '"' | sort | uniq -c | tr '\n' ' ')"
tail -3 "$W/out_cloud/check.log"

echo "===[C] 包络网格 21 格并行（128 核，父进程读一次数据后 fork）==="
timeout 3600 python3 -X utf8 tools/envelope_grid.py --jobs "${JOBS:-21}" \
  --out "$W/out_cloud/envelope_grid.json" > "$W/out_cloud/envelope.log" 2>&1
echo "[C] 退出码 $?"; tail -10 "$W/out_cloud/envelope.log"

echo "===[D] 18 场多事件批量==="
timeout 1800 python3 -X utf8 -m typhoeus.cli multievent > "$W/out_cloud/multievent.log" 2>&1
echo "[D] 退出码 $?"; tail -4 "$W/out_cloud/multievent.log"
ls -l "$W/out/07_multievent_calibration.json" "$W/out_cloud/envelope_grid.json" 2>/dev/null
df -h "$W" | sed -n '2p'
echo "ALLFIX_DONE"
