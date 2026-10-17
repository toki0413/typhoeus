"""Sen1Floods11_sar（ModelScope 重打包版）的配对探针。

上一轮结构报告给了三个对不上的读数：
  img/000002.tif   rasterio 报 size=2x512, bands=1, crs=None
  annos/000002.png 512x512, mode=L, uniq=[0,1,255]
  共 4282 个 tif + 4282 个 png
影像宽度 2 与标注 512 不可能是同一张图。这个脚本只回答三件事，不训练：
  1) tif 的真实数组形状与数值范围（多通道？转置？还是 2×512 真是别的含义）
  2) 影像与标注能否按序号配对，配对后逐类 VV 均值是多少（决定哪个值是水体）
  3) 包内那两个 json 里有没有作者留下的标签语义说明
"""
from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np
import rasterio
from PIL import Image

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/root/autodl-tmp/sar/unzipped/Sen1Floods11_sar"
imgs = sorted(glob.glob(os.path.join(ROOT, "**", "*.tif"), recursive=True))
labs = sorted(glob.glob(os.path.join(ROOT, "**", "*.png"), recursive=True))
print(f"影像 {len(imgs)} 个 | 标注 {len(labs)} 个 | 根 {ROOT}")
print("影像目录分布:", {os.path.relpath(p, ROOT).split(os.sep)[0]: 1 for p in imgs[:1]} )


def stem(p: str) -> str:
    return os.path.splitext(os.path.basename(p))[0]


lab_by = {stem(p): p for p in labs}
img_by = {stem(p): p for p in imgs}
common = sorted(set(lab_by) & set(img_by))
print(f"按序号可配对: {len(common)} 对  |  仅影像 {len(set(img_by)-set(lab_by))}  |  仅标注 {len(set(lab_by)-set(img_by))}")

for p in imgs[:3]:
    with rasterio.open(p) as r:
        a = r.read()
        print(f"  {os.path.relpath(p, ROOT)[:40]:42s} 报尺寸 {r.width}x{r.height} "
              f"bands={r.count} dtype={r.dtypes[0]} 实际数组 {a.shape} "
              f"min={a.min():.2f} max={a.max():.2f} 有限值占比 {np.isfinite(a).mean():.3f}")

for p in labs[:3]:
    im = Image.open(p)
    arr = np.asarray(im)
    u, c = np.unique(arr, return_counts=True)
    print(f"  {os.path.relpath(p, ROOT)[:40]:42s} mode={im.mode} shape={arr.shape} "
          f"取值/像素数 {dict(zip(u.tolist(), c.tolist()))}")

print("\n=== 配对后逐类 VV 均值（谁最暗谁就是水）===")
acc: dict[int, list] = {}
shapes = set()
for name in common[:12]:
    with rasterio.open(img_by[name]) as r:
        a = r.read()
    lab = np.asarray(Image.open(lab_by[name]))
    if a.shape[-2:] != lab.shape:
        print(f"  {name}: 影像 {a.shape} 与标注 {lab.shape} 不配对，跳过")
        continue
    shapes.add(a.shape)
    flat = a.reshape(a.shape[0], -1) if a.ndim == 3 else a[None]
    for v in (int(x) for x in np.unique(lab) if int(x) != 255):
        m = (lab == v)
        for b in range(flat.shape[0]):
            acc.setdefault((v, b), []).append(float(np.nanmean(flat[b][m])))
if not acc:
    print("  没有一对能配上——这个包的两类文件不能直接用")
for (v, b), vals in sorted(acc.items()):
    print(f"  标签值 {v} 通道 {b}: 均值 {np.mean(vals):7.2f} dB（样本 {len(vals)}）")

print("\n=== 包内 json 说明 ===")
for jp in glob.glob(os.path.join(ROOT, "**", "*.json"), recursive=True)[:4]:
    try:
        d = json.loads(open(jp, encoding="utf-8").read())
        print(f"  {os.path.relpath(jp, ROOT)}: {json.dumps(d, ensure_ascii=False)[:280]}")
    except Exception as e:  # noqa: BLE001
        print(f"  {jp} 读失败 {e}")
