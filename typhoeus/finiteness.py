"""提比翁 Demo —— 非有限值防线（L0 数据完整性）。

对应 `ENGINEERING_MATURITY.md` 的 H2，根因已实测：
  2x2 网格在第 3 步注入一个 NaN 雨量，`kernel.run` 返回
  `positivity_ok=True`、`max_depth=nan`、`mass_resid=nan`，
  守恒核算全项 NaN——**三道防线全部漏过**。

机制：Python/NumPy 里 NaN 与任何数比较恒为 False。
  `nan < -1e-12` 为 False，所以 `h.min() < -1e-12` 拦不住；
  `nan > 0.0` 为 False，所以 `np.where(h > min_depth, h, 0)` 保留 NaN；
  `h[h < 0]` 取不到 NaN，因此负值修正也不动它。

所以"正性检查通过"和"守恒残差合格"这两个结论在含 NaN 时都是假的，
而它们正是内核拒绝输出的判据。防线必须放在每个物理环节的**出口**，
不能放函数入口——`_fill_depressions` 与上坡产流项可能自身产生 NaN，
入口检查会误杀合法输入。

三个接入点（按数据流向）：
  data.load_dem       —— 已有 isfinite 检查，补 Inf 与"填完仍 NaN"的确认
  kernel.run 循环内   —— 每步雨量增量与水深各查一次
  projection.aggregate —— 入口查水深时序，NaN 会直达输出物的 Q 值

向后兼容：本模块为新增，不改变任何已有函数的签名与返回值。
内核在正常输入下的输出逐字节不变。
"""
from __future__ import annotations

import numpy as np


class NonFiniteError(ValueError):
    """非有限值（NaN / ±Inf）。带 code 供命令行程序化处理。"""

    code = "NONFINITE"


def count_nonfinite(arr) -> int:
    """统计非有限值个数。标量与数组通用。"""
    a = np.asarray(arr, dtype=np.float64)
    if a.size == 0:
        return 0
    return int(np.count_nonzero(~np.isfinite(a)))


def assert_finite(arr, where: str) -> None:
    """非有限值即抛错。where 说明是哪个物理环节的出口。"""
    n = count_nonfinite(arr)
    if n:
        raise NonFiniteError(f"{where} 含 {n} 个非有限值（NaN/±Inf），"
                             f"拒绝继续推进。请检查上游输入或数值发散。")


def finite_summary(arr, where: str) -> dict:
    """诊断用摘要，不抛错。用于失败时定位是哪一环先坏。"""
    a = np.asarray(arr, dtype=np.float64)
    n = count_nonfinite(a)
    out = {"where": where, "n_nonfinite": n, "size": int(a.size)}
    if n and a.size > n:
        ok = a[np.isfinite(a)]
        out["finite_min"] = float(ok.min())
        out["finite_max"] = float(ok.max())
    return out