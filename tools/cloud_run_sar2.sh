#!/usr/bin/env bash
# SAR 线第二段：自检 → 取证 → 训练。三道门，前一门不过就停，不烧卡。
# 约定：代码在 $ROOT/typhoeus，数据在数据盘 $DATA_DISK。
set -uo pipefail

D="${DATA_DISK:-/root/autodl-tmp}"
CODE="$D/typhoeus"
SAR="$D/sar/unzipped"
cd "$CODE" || { echo "找不到代码目录 $CODE，先跑 cloud_run.sh 解包"; exit 1; }

echo "===[门 1] CPU 自检：合成瓦片走完整训练路径（不碰真数据、不碰卡）==="
mkdir -p "$D/sar"
timeout 900 python3 -X utf8 tools/sar_train.py --selftest --outdir "$D/sar/out" \
  > "$D/sar/selftest.log" 2>&1
RC=$?
tail -14 "$D/sar/selftest.log"
if [ $RC -ne 0 ]; then
  echo "[停] 自检没过（退出码 $RC，全文见 $D/sar/selftest.log）。"
  echo "     接线有问题时上 GPU 只会把 bug 放大，先修这里。"
  exit $RC
fi

echo "===[门 2] 取证：真包内的布局、标签取值、瓦片尺寸、VV 范围==="
[ -d "$SAR" ] || { echo "[停] 没找到 $SAR，先跑 cloud_run_sar.sh 完成下载解包"; exit 1; }
timeout 600 python3 -X utf8 tools/sar_train.py --probe --root "$SAR" 2>&1 | tail -14
MAP="${MAP:-auto}"
echo "[门2] mapping=$MAP —— auto 用物理判据（逐类 VV 均值最暗者为水）；"
echo "     两类余量不足 2 dB 时训练件自己 abort，不会硬猜编码。要人工覆盖就 MAP=eq1 重跑。"

echo "===[门 3] 训练（4090D）==="
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader
timeout 10800 python3 -X utf8 tools/sar_train.py \
  --root "$SAR" --outdir "$D/sar/out" --tag "run_$(date +%m%d_%H%M)" \
  --mapping "$MAP" --epochs 12 --batch 16 --val-frac 0.25 > "$D/sar/train.log" 2>&1
RC=$?
tail -30 "$D/sar/train.log"

echo "===[汇总]==="
echo "[门3] 训练退出码 $RC（0=网络打过单门限，5=没打过→这条线停在训练层，2/3/4=数据或接线问题）"
python3 -X utf8 - <<PY
import glob, json, os
fs = sorted(glob.glob("$D/sar/out/run_*/metrics.json"))
for f in fs[-1:]:
    d = json.load(open(f, encoding="utf-8"))
    print(f"metrics {os.path.basename(os.path.dirname(f))}")
    print("  瓦片对 %d | 事件切分 | 标签取值 %s" % (d["n_tiles"], d["label_stats"]["label_vals"]))
    print("  阈值基线 IoU %.4f | 网络 best IoU %.4f (%s)" % (
        d["baseline_otsu_iou"], d["best"]["val_iou"], d["verdict"]))
    print("  设备 %s | 用时 %.0f s" % (d["device"], d["elapsed_s"]))
    print("  指标件", f)
ck = sorted(glob.glob("$D/sar/out/run_*/unet_ep*.pt"))
print("  checkpoint", len(ck), "个")
PY
df -h "$D" | sed -n '2p'
