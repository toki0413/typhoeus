#!/usr/bin/env python3
"""
训练结构签名 + PCA 场系数的 MLP 代理（numpy，无 torch）。

输入：tools/surrogate-dataset.json（由 tools/gen-surrogate-data.mjs 生成）
输出：server/research/surrogate.json（纯 JSON 权重，Node 端直接前向）

这不是严格的 DeepONet/FNO：输入是标量参数而不是函数场。它学习的是
“参数 → 结构签名 + 低维场基系数”的降阶代理，用于候选排序；
最终分数仍由服务端精确重跑判定。
"""

import argparse
import datetime
import json
import math
import os

import numpy as np

FEATURES = ["density", "anisotropy", "period", "components", "perimeter"]
K_COMPONENTS = 16
SEED = 20261113


def target_features(targets, kind):
    tid = "gs-spots-lit" if kind == "grayScott" else "cima-stripes"
    for t in targets:
        if t.get("id") == tid:
            return t["features"], t
    raise KeyError(tid)


def signature_distance(a, b):
    scales = {"density": 0.2, "anisotropy": 0.3, "period": 10, "components": 0.01, "perimeter": 0.6}
    weights = {"density": 1.0, "anisotropy": 1.2, "period": 1.0, "components": 1.0, "perimeter": 0.8}
    total = 0.0
    for key in scales:
        x = float(a.get(key, 0.0))
        y = float(b.get(key, 0.0))
        diff = (x - y) / scales[key]
        total += weights[key] * diff * diff
    return math.sqrt(total)


def score_of(features, target):
    return 100.0 / (1.0 + signature_distance(features, target))


def pearson(a, b):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size < 2 or a.std() < 1e-12 or b.std() < 1e-12:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


class MLP:
    def __init__(self, sizes, rng):
        self.sizes = sizes
        self.w = []
        self.b = []
        for i in range(len(sizes) - 1):
            fan_in, fan_out = sizes[i], sizes[i + 1]
            scale = math.sqrt(2.0 / (fan_in + fan_out))
            self.w.append((rng.standard_normal((fan_in, fan_out)) * scale).astype(np.float64))
            self.b.append(np.zeros(fan_out, dtype=np.float64))

    def forward(self, x):
        h = x
        for i in range(len(self.w)):
            h = h @ self.w[i] + self.b[i]
            if i < len(self.w) - 1:
                h = np.tanh(h)
        return h

    def params(self):
        return self.w + self.b


def train_mlp(x, y, weight, seed, epochs=3000, batch=64, lr=1e-3):
    rng = np.random.default_rng(seed)
    n, d = x.shape
    net = MLP([d, 64, 64, y.shape[1]], rng)
    params = net.params()
    m = [np.zeros_like(p) for p in params]
    v = [np.zeros_like(p) for p in params]
    b1, b2, eps = 0.9, 0.999, 1e-8
    step = 0
    best = (float("inf"), None)
    loss = float("inf")
    wsq = weight[None, :]
    for epoch in range(epochs):
        order = rng.permutation(n)
        for start in range(0, n, batch):
            idx = order[start:start + batch]
            xb, yb = x[idx], y[idx]
            # forward 缓存
            hs = [xb]
            h = xb
            for i in range(len(net.w)):
                h = h @ net.w[i] + net.b[i]
                if i < len(net.w) - 1:
                    h = np.tanh(h)
                    hs.append(h)
            diff = (h - yb) * wsq
            loss = float((diff * diff).mean())
            # backward
            grad = 2.0 * diff / (yb.size)
            gw = [None] * len(net.w)
            gb = [None] * len(net.b)
            for i in range(len(net.w) - 1, -1, -1):
                gw[i] = hs[i].T @ grad
                gb[i] = grad.sum(axis=0)
                if i > 0:
                    grad = (grad @ net.w[i].T) * (1.0 - hs[i] ** 2)
            step += 1
            for i, p in enumerate(net.params()):
                g = gw[i] if i < len(net.w) else gb[i - len(net.w)]
                m[i] = b1 * m[i] + (1 - b1) * g
                v[i] = b2 * v[i] + (1 - b2) * g * g
                mh = m[i] / (1 - b1 ** step)
                vh = v[i] / (1 - b2 ** step)
                p -= lr * mh / (np.sqrt(vh) + eps)
        if loss < best[0]:
            best = (loss, [p.copy() for p in net.params()])
    for p, bp in zip(net.params(), best[1]):
        p[...] = bp
    return net, best[0]


def evaluate(net, x, ysig, coeff, stats, target, kind):
    out = net.forward((x - stats["x_mean"]) / stats["x_std"])
    sig_std = out[:, :5]
    pred_sig = sig_std * stats["sig_std"] + stats["sig_mean"]
    pred_sig[:, 0] = np.clip(pred_sig[:, 0], 0, 1)
    pred_sig[:, 1] = np.clip(pred_sig[:, 1], 0, 1)
    pred_sig[:, 2] = np.clip(pred_sig[:, 2], 0, 64)
    pred_sig[:, 3] = np.clip(pred_sig[:, 3], 0, 1)
    pred_sig[:, 4] = np.clip(pred_sig[:, 4], 0, 4)

    rmse = {}
    for i, key in enumerate(FEATURES):
        rmse[key] = float(np.sqrt(np.mean((pred_sig[:, i] - ysig[:, i]) ** 2)))

    # 排名质量：用真实目标特征算预测分与真实分
    pred_scores = [score_of({k: float(pred_sig[j, i]) for i, k in enumerate(FEATURES)}, target)
                   for j in range(pred_sig.shape[0])]
    true_scores = [score_of({k: float(ysig[j, i]) for i, k in enumerate(FEATURES)}, target)
                   for j in range(ysig.shape[0])]
    n = len(true_scores)
    order = np.argsort(-np.asarray(pred_scores))
    true_best = int(np.argmax(true_scores))
    top1 = int(order[0] == true_best)
    top3 = int(true_best in set(order[:3].tolist()))
    top5 = int(true_best in set(order[:5].tolist()))
    mae = float(np.mean(np.abs(np.asarray(pred_scores) - np.asarray(true_scores))))

    # 候选池召回：每次随机抽 20 个样本，看真实最优是否落在代理前 k 名。
    # 这比“整份留出集里找唯一最优”更接近真实使用方式（一次只给 3 个候选）。
    pool_size = min(20, n)
    trials = 200
    prng = np.random.default_rng(SEED + 1)
    pred_arr = np.asarray(pred_scores)
    true_arr = np.asarray(true_scores)
    hit1 = hit3 = 0
    for _ in range(trials):
        pool = prng.choice(n, size=pool_size, replace=False)
        rank = pool[np.argsort(-pred_arr[pool])]
        best = pool[int(np.argmax(true_arr[pool]))]
        hit1 += int(rank[0] == best)
        hit3 += int(best in set(rank[:3].tolist()))
    pool_recall = {
        "poolSize": int(pool_size),
        "top1Hit": round(hit1 / trials, 3),
        "top3Hit": round(hit3 / trials, 3),
    }

    # 场误差（PCA 重建）
    pred_coeff = out[:, 5:] * stats["coeff_std"] + stats["coeff_mean"]
    recon = pred_coeff @ stats["basis"] + stats["field_mean"]
    field_rmse = float(np.sqrt(np.mean((recon - coeff["field"]) ** 2)))

    return {
        "samples": n,
        "signatureRmse": {k: round(v, 4) for k, v in rmse.items()},
        "scoreMae": round(mae, 2),
        "scorePearson": round(pearson(pred_scores, true_scores), 3),
        "top1Hit": top1,
        "top3Hit": top3,
        "top5Hit": top5,
        "poolRecall": pool_recall,
        "fieldRmse": round(field_rmse, 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="tools/surrogate-dataset.json")
    ap.add_argument("--out", default="server/research/surrogate.json")
    ap.add_argument("--epochs", type=int, default=3000)
    ap.add_argument("--holdout", type=float, default=0.15)
    args = ap.parse_args()

    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)
    with open(os.path.join(os.path.dirname(__file__), "..", "server", "research", "targets.json"), "r", encoding="utf-8") as f:
        targets = json.load(f)["targets"]

    rng = np.random.default_rng(SEED)
    out = {
        "version": 1,
        "kind": "mlp-field-pca",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "seed": SEED,
        "features": FEATURES,
        "components": K_COMPONENTS,
        "note": "降阶神经代理：标量参数 → 结构签名 + 16 维 PCA 场系数；不是裁判，最终分数由服务端重跑。",
        "kinds": {},
    }

    for kind, block in data["kinds"].items():
        samples = block["samples"]
        x = np.asarray([s["params"] for s in samples], dtype=np.float64)
        ysig = np.asarray([[s["features"][k] for k in FEATURES] for s in samples], dtype=np.float64)
        fields = np.asarray([s["field"] for s in samples], dtype=np.float64)

        n = len(samples)
        if n < 6:
            print(f"[train] {kind}: 样本太少（{n}），跳过")
            continue
        idx = rng.permutation(n)
        n_hold = min(n - 2, max(2, int(round(n * args.holdout))))
        hold_idx = idx[:n_hold]
        train_idx = idx[n_hold:]

        x_mean, x_std = x[train_idx].mean(0), x[train_idx].std(0) + 1e-8
        sig_mean, sig_std = ysig[train_idx].mean(0), ysig[train_idx].std(0) + 1e-8

        field_mean = fields[train_idx].mean(0)
        centered = fields[train_idx] - field_mean
        _, _, vt = np.linalg.svd(centered, full_matrices=False)
        basis = vt[:K_COMPONENTS]
        if basis.shape[0] < K_COMPONENTS:
            basis = np.vstack([basis, np.zeros((K_COMPONENTS - basis.shape[0], basis.shape[1]))])
        coeff_all = (fields - field_mean) @ basis.T
        coeff_mean, coeff_std = coeff_all[train_idx].mean(0), coeff_all[train_idx].std(0) + 1e-8

        x_train = (x[train_idx] - x_mean) / x_std
        ys_train = (ysig[train_idx] - sig_mean) / sig_std
        co_train = (coeff_all[train_idx] - coeff_mean) / coeff_std
        y_train = np.hstack([ys_train, co_train])
        weight = np.concatenate([np.ones(5), np.full(K_COMPONENTS, 0.35)])

        net, loss = train_mlp(x_train, y_train, weight, SEED, epochs=args.epochs)

        stats = {
            "x_mean": x_mean, "x_std": x_std,
            "sig_mean": sig_mean, "sig_std": sig_std,
            "coeff_mean": coeff_mean, "coeff_std": coeff_std,
            "field_mean": field_mean, "basis": basis,
        }
        target, target_obj = target_features(targets, kind)
        train_metrics = evaluate(net, x[train_idx], ysig[train_idx], {"field": fields[train_idx]}, stats, target, kind)
        hold_metrics = evaluate(net, x[hold_idx], ysig[hold_idx], {"field": fields[hold_idx]}, stats, target, kind)

        def arr(a):
            return np.round(np.asarray(a), 6).tolist()

        out["kinds"][kind] = {
            "params": block["params"],
            "ranges": block["ranges"],
            "holdout": round(args.holdout, 3),
            "trainSamples": int(len(train_idx)),
            "holdoutSamples": int(n_hold),
            "loss": round(float(loss), 6),
            "xMean": arr(x_mean),
            "xStd": arr(x_std),
            "sigMean": arr(sig_mean),
            "sigStd": arr(sig_std),
            "coeffMean": arr(coeff_mean),
            "coeffStd": arr(coeff_std),
            "fieldMean": arr(field_mean),
            "basis": arr(basis),
            "layers": [
                {"w": arr(net.w[i]), "b": arr(net.b[i])} for i in range(len(net.w))
            ],
            "pool": arr(x),
            "metrics": {"train": train_metrics, "holdout": hold_metrics},
            "target": {"id": target_obj.get("id"), "label": target_obj.get("label")},
        }
        print(f"[train] {kind}: train={len(train_idx)} holdout={n_hold} loss={loss:.5f}")
        print(f"        holdout {json.dumps(hold_metrics, ensure_ascii=False)}")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[train] 写入 {args.out} ({os.path.getsize(args.out)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
