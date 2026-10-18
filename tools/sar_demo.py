#!/usr/bin/env python3
"""Sen1Floods11 推理 Demo —— 加载已训权重，逐瓦片出水面图与三个数。

用途：证明"可运行成果"这一条。单瓦片处理，不把整个子集读进内存。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    import os
    os.environ.setdefault(_v, "2")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import numpy as np  # noqa: E402
import torch  # noqa: E402

import sar_train as S  # noqa: E402


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def score_tile(net, it, mapping, norm, dev):
    """返回 (iou, prec, rec, 掩膜统计)。全部只在 valid 像元上算。"""
    means, stds = norm
    x = S.read_bands(it["vv"])
    cin = x.shape[0]
    if cin != len(means):
        x = x[: len(means)] if cin > len(means) else np.concatenate(
            [x, np.repeat(x[-1:], len(means) - cin, 0)], 0)
    x = (x - np.array(means, dtype="float32")[:, None, None]) / \
        np.array(stds, dtype="float32")[:, None, None]
    lab, _ = S.read_arr(it["label"])
    y, valid = S.to_water(lab, mapping)
    v = valid > 0.5
    if v.sum() < 100:
        return None
    with torch.no_grad():
        t = torch.from_numpy(x.astype("float32")[None]).to(dev)
        p = (torch.sigmoid(net(t))[0, 0].cpu().numpy() > 0.5) & v
    yy = (y > 0.5) & v
    inter = float((p & yy).sum())
    union = float((p | yy).sum())
    fp_ = float((p & ~yy).sum())
    fn = float((~p & yy).sum())
    return {
        "tile": it["base"], "event": it["event"],
        "iou": round(inter / union, 4) if union else 0.0,
        "precision": round(inter / (inter + fp_), 4) if inter + fp_ else None,
        "recall": round(inter / (inter + fn), 4) if inter + fn else None,
        "water_frac": round(float(yy.sum()) / float(v.sum()), 4),
        "pred_frac": round(float(p.sum()) / float(v.sum()), 4),
        "vv": it["vv"], "label": it["label"],
        "_p": p, "_y": yy, "_v": v,
    }


def overlay_png(r, out: Path) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    vv, _ = S.read_arr(r["vv"])
    fig, ax = plt.subplots(figsize=(6.4, 3.0), dpi=150)
    ax.imshow(np.nan_to_num(vv), cmap="gray", vmin=float(np.nanmin(vv)),
              vmax=float(np.nanmax(vv)))
    truth = r["_y"] & ~r["_p"]
    ax.set_axis_off()
    ax.imshow(np.ma.masked_where(~truth, truth), cmap="spring", alpha=0.55)
    ax.imshow(np.ma.masked_where(~r["_p"], r["_p"]), cmap="autumn", alpha=0.55)
    ax.set_title(f"{r['tile']}  IoU {r['iou']:.3f}  "
                 f"P {r['precision']}  R {r['recall']}", fontsize=8)
    fig.text(0.01, 0.02, "magenta = model water   green = reference water",
             fontsize=6.5)
    fig.tight_layout()
    fp = out / f"{r['tile']}.png"
    fig.savefig(fp, bbox_inches="tight")
    plt.close(fig)
    return fp.name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=str(ROOT / "runs/cloud_artifacts" / "cv7" / "unet_ep10.pt"))
    ap.add_argument("--root", default=str(ROOT / "data" / "sar" / "unzipped"))
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--outdir", default=str(ROOT / "out" / "sar_demo"))
    ap.add_argument("--prefer-heldout", action="store_true",
                    help="只用该权重训练时留出的事件（官方留出集）")
    a = ap.parse_args()

    ck_path = Path(a.ckpt)
    if not ck_path.exists():
        print(f"[缺权重] {ck_path}", flush=True)
        return 2
    root = Path(a.root)
    if not root.exists():
        print(f"[缺数据] {root} 不存在：先解 Sen1Floods11 包", flush=True)
        return 2

    ck = torch.load(ck_path, map_location="cpu", weights_only=True)
    norm, mapping, events_val = ck["norm"], ck["mapping"], ck.get("events_val", [])
    # 存档结构：{"state": state_dict, "norm": (means, stds), "cin", "mapping", "events_val"}
    net = S.build_model(ck["cin"])
    net.load_state_dict(ck["state"])
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net.to(dev).eval()
    print(f"[权重] {ck_path.name}  sha256={sha256(ck_path)[:16]}…  "
          f"cin={ck['cin']} mapping={mapping} dev={dev}", flush=True)
    print(f"[留出事件] {len(events_val)} 个：{events_val[:4]}…", flush=True)

    items = S.discover_v11(root)
    if not items:
        print("[配对失败] discover_v11 零命中，包结构与预期不符", flush=True)
        return 3
    print(f"[数据] 配对瓦片 {len(items)} 张", flush=True)
    if a.prefer_heldout and events_val:
        pick = [it for it in items if it["event"] in set(events_val)]
        print(f"[留出筛] {len(pick)} 张落在留出事件里", flush=True)
        items = pick or items
    items = items[: a.n]

    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)
    rows, t0 = [], time.time()
    for i, it in enumerate(items, 1):
        r = score_tile(net, it, mapping, norm, dev)
        if r is None:
            print(f"[{i}] {it['base']} 无有效像元，跳过", flush=True)
            continue
        png = overlay_png(r, out)
        r["overlay"] = png
        rows.append(r)
        print(f"[{i}] {r['tile']:<28} IoU {r['iou']:.4f}  P {r['precision']}  "
              f"R {r['recall']}  水面占比 参考{r['water_frac']}↔预测{r['pred_frac']}  → {png}",
              flush=True)

    bl = S.otsu_iou(items, mapping)
    ious = [r["iou"] for r in rows]
    summ = {
        "ckpt": str(ck_path), "ckpt_sha256": sha256(ck_path),
        "mapping": mapping, "norm": {"mean": list(norm[0]), "std": list(norm[1])},
        "device": dev, "n_tiles": len(rows), "elapsed_s": round(time.time() - t0, 1),
        "model_iou_mean": round(float(np.mean(ious)), 4) if ious else None,
        "model_iou_sd": round(float(np.std(ious, ddof=1)), 4) if len(ious) > 1 else None,
        "otsu_iou": bl,
        "tiles": [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows],
    }
    (out / "demo_metrics.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    print(f"\n[汇总] 网络 IoU {summ['model_iou_mean']} ± {summ['model_iou_sd']}  "
          f"（{len(rows)} 张）  Otsu 基线 {bl}", flush=True)
    print(f"[落盘] {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
