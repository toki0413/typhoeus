#!/usr/bin/env bash
# SAR 水面制图开线 · 第一段：取证不训练。
# 目的只有一个——把 Sen1Floods11 的真实内部结构打印出来，
# 我按真结构写训练件，不照猜的目录布局写。
# 全程落数据盘；30 分钟量级；任何一步崩了前面的产物都还在。
set -uo pipefail

W="${DATA_DISK:-/root/autodl-tmp}/sar"
ZIP="$W/Sen1Floods11_sar.zip"
URL="https://modelscope.cn/api/v1/datasets/fanstandy/Sen1Floods11_sar/repo?Revision=master&FilePath=Sen1Floods11_sar.zip"
mkdir -p "$W" || exit 1
cd "$W" || exit 1

echo "===[0] 机器与盘==="
df -h "$W" | sed -n '2p'; nproc; python3 -V
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || echo "无 nvidia-smi"

echo "===[1] 下载 7.36 GB（匿名免 key，断点续传，60 min 止损）==="
if [ ! -s "$ZIP" ]; then
  curl -sS -L --retry 6 --retry-all-errors -C - --max-time 3600 -A "Mozilla/5.0" -o "$ZIP" "$URL"
fi
ls -l "$ZIP" | awk '{printf "包 %d 字节 = %.1f MB\n", $5, $5/1e6}'

echo "===[2] 解包（只解一次，20 min 止损）==="
if [ ! -d "$W/unzipped" ]; then
  mkdir -p "$W/unzipped" && (cd "$W/unzipped" && timeout 1200 unzip -q -o "$ZIP" || echo "unzip 退出码 $?（可能有嵌套 zip，见下）")
fi
find "$W/unzipped" -maxdepth 2 -type d | head -20

echo "===[3] 结构清点：扩展名分布 + 最深样例==="
find "$W/unzipped" -type f | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -12
echo "--- 样例 12 条（路径 + 字节）---"
find "$W/unzipped" -type f | head -12 | while read -r f; do printf "%12d  %s\n" "$(stat -c%s "$f" 2>/dev/null || echo 0)" "${f#$W/unzipped/}"; done
echo "--- 若有嵌套 zip，列前 3 个的内部条目 ---"
find "$W/unzipped" -name "*.zip" | head -3 | while read -r z; do echo "  [$z]"; unzip -l "$z" 2>/dev/null | sed -n '4,9p'; done

echo "===[4] 抽一个数据体读真实 dtype/shape/范围（不猜）==="
python3 -X utf8 - <<'PY'
import glob, os, sys
import numpy as np
root = sys.argv[1] if len(sys.argv) > 1 else "unzipped"
cands = []
for pat in ("*.npy", "*.npz", "*.tif", "*.tiff", "*.png", "*.jpg", "*.h5", "*.hdf", "*.mat"):
    cands += glob.glob(os.path.join(root, "**", pat), recursive=True)[:2]
print("抽样文件类型候选:", [os.path.basename(c) for c in cands][:6])
for c in cands[:6]:
    ext = os.path.splitext(c)[1].lower()
    try:
        if ext == ".npy":
            a = np.load(c, mmap_mode="r")
            v = np.asarray(a[:2]) if a.ndim else np.asarray(a)
            print(f"  {os.path.relpath(c, root)[:60]:62s} dtype={a.dtype} shape={a.shape} "
                  f"min={float(np.nanmin(v)):.4g} max={float(np.nanmax(v)):.4g} uniq={len(np.unique(v[:1,:1]))}")
        elif ext == ".npz":
            z = np.load(c)
            print(f"  {os.path.relpath(c, root)[:60]:62s} keys={list(z.keys())[:6]} "
                  f"shapes={[z[k].shape for k in list(z.keys())[:3]]}")
        elif ext in (".tif", ".tiff"):
            try:
                import rasterio
                with rasterio.open(c) as r:
                    print(f"  {os.path.relpath(c, root)[:60]:62s} crs={r.crs} size={r.width}x{r.height} "
                          f"bands={r.count} dtype={r.dtypes[0]} nodata={r.nodata}")
            except ImportError:
                print(f"  {os.path.relpath(c, root)[:60]:62s} 未装 rasterio，仅字节数 {os.path.getsize(c)}")
        elif ext in (".png", ".jpg"):
            try:
                from PIL import Image
                im = Image.open(c); arr = np.asarray(im)
                print(f"  {os.path.relpath(c, root)[:60]:62s} mode={im.mode} size={im.size} "
                      f"uniq_vals={np.unique(arr).tolist()[:6]}")
            except ImportError:
                print(f"  {os.path.relpath(c, root)[:60]:62s} 未装 PIL")
        elif ext in (".h5", ".hd5", ".hdf", ".hdf5"):
            try:
                import h5py
                with h5py.File(c, "r") as f:
                    f.visititems(lambda n, o: print(f"    {n} {getattr(o,'shape',None)} {getattr(o,'dtype',None)}"))
            except ImportError:
                print(f"  {os.path.relpath(c, root)[:60]:62s} 未装 h5py")
        else:
            print(f"  {c} 未识别扩展 {ext}")
    except Exception as e:
        print(f"  {os.path.relpath(c, root)[:60]:62s} 读失败 {type(e).__name__}: {str(e)[:60]}")
PY

echo "===[5] GPU 烟雾测试（装 torch 后跑一个 GPU 卷积，量显存与耗时）==="
python3 -c "import torch" 2>/dev/null || {
  echo "  装 torch（国内镜像）"; python3 -m pip install -q -i https://mirrors.aliyun.com/pypi/simple/ torch torchvision 2>&1 | tail -2; }
timeout 300 python3 -X utf8 - <<'PY'
try:
    import torch, time
    print("  torch", torch.__version__, "cuda 可用", torch.cuda.is_available())
    if torch.cuda.is_available():
        print("  设备", torch.cuda.get_device_name(0),
              "显存 %.1f GB" % (torch.cuda.get_device_properties(0).total_memory / 1e9))
        x = torch.randn(16, 4, 256, 256, device="cuda")
        conv = torch.nn.Conv2d(4, 64, 3, padding=1).cuda()
        for _ in range(3):
            conv(x).sum().backward()
        torch.cuda.synchronize(); t = time.time()
        for _ in range(50):
            y = torch.nn.functional.relu(conv(x))
        torch.cuda.synchronize()
        print(f"  50 次前向 (16×4×256×256) 用时 {(time.time()-t)*1e3:.0f} ms，"
              f"峰值显存 {torch.cuda.max_memory_allocated()/1e9:.2f} GB")
except Exception as e:
    print("  torch 不可用:", type(e).__name__, str(e)[:120])
PY

echo "===[6] 交回给我看的清单==="
du -sh "$W/unzipped" 2>/dev/null
df -h "$W" | sed -n '2p'
echo "把上面 [3][4][5] 三段原样贴回来，我按真实布局写训练件与推理件。"
