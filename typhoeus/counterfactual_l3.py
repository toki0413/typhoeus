"""p57 第三级反事实：反演前期状态，再换一个干预。

为什么这一件与 p41 不同
----------------------
Pearl 三级阶梯：

  一级 关联    P(y | x)                — 观测到雨大，淹得深
  二级 干预    P(y | do(x))            — 把顶托拨到 0.5 m，会淹多深
  三级 反事实  P(y_x | x', y')         — **已经知道实际发生了什么**，
                                        在同一个"世界状态"下换一个做法

p41 自己在边界里写明：「这是干预（do-算子）实验，不是严格意义的反事实——
因为真实前期状态没有观测，只能设定而非反演。」

本件补上缺的那一半：**先把前期状态从观测里反演出来（abduction），
把它钉住不动（同一个 U），再换一个干预重算。**

反演（U）来自哪
---------------
`soilcal` 从 ERA5-Land 反演两个量：
    θ0       自然面实测饱和度 0.987 × 城市折减 0.456 = 0.450
    net_sw   由 ET0 反算 → **78.0 W/m²**（参数化先验只有 40.0，低估 1.95 倍）

**这两个就是本件的 U**：它们来自观测，不是假设。
之后只动排水顶托（唯一杠杆最大的轴，×2.81），U 保持不变。

反演里仍有一个未观测的自由量
----------------------------
`urban_theta_frac=0.456`（自然面 → 城市硬化面的折减）**目前无观测**，
是显式参数化的。故 θ0 的反演只是**部分识别**：
    θ_obs 有观测上界，θ_city 的大小取决于这个折减系数。
本件把它单列，不在结论里假装它是已知的。

用法：python -m typhoeus.counterfactual_l3
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

# 反事实世界：只改顶托（河网/潮位水位的代理）
WORLDS = [
    ("现实（参数化顶托）", 0.05, "本链基线，顶托 0.05 m"),
    ("反事实A_河口低水位", 0.01, "干旱期河网低水位，排水出口不受顶托"),
    ("反事实B_高潮位顶托", 0.20, "台风高潮位，出口被抬到 0.20 m"),
    ("反事实C_极端顶托", 0.50, "风暴潮+天文潮叠加，出口 0.50 m"),
]
RED_TH = 0.50
ORANGE_LO = 0.20


def main() -> int:
    from typhoeus import cli as CLI
    from typhoeus import config as CFG
    from typhoeus import data as D
    from typhoeus import kernel as K
    from typhoeus import observe as OB
    from typhoeus import rainsrc as RS
    from typhoeus import soilcal as SC

    cfg = CFG.Config()
    inp = D.load_all(cfg.l2.bbox, cfg.l4.resample)
    g = inp.grid
    rain, rain_rep = RS.get_rainfall(g, stations=OB.load_rain_stations(),
                                    use_cache=True,
                                    calibrate=cfg.l2.rain_calibrate,
                                    verbose=False)

    # ---- 第一步：反演 U（abduction）----
    soil = SC.calibrate(cfg, verbose=False, allow_fallback=True)
    rep = soil.report or {}
    theta0 = float(soil.theta0)
    net_sw = float(soil.net_sw_wm2)
    theta_obs = (theta0 / cfg.l2.urban_theta_frac
                 if cfg.l2.urban_theta_frac else None)

    abduction = {
        "做了什么": ("从 ERA5-Land 反演前期土壤饱和度与净辐射，"
                 "作为『同一个世界状态 U』钉住不动。"),
        "θ0_城市值": round(theta0, 4),
        "θ0_自然面实测反演": round(theta_obs, 4) if theta_obs else None,
        "θ0_参数化先验": cfg.l2.soil_theta0,
        "θ0_是否与先验相符": abs(theta0 - cfg.l2.soil_theta0) < 1e-6,
        "net_sw_反演_Wm2": round(net_sw, 2),
        "net_sw_参数化先验_Wm2": cfg.l2.net_sw_wm2,
        "net_sw_先验低估倍数": (round(net_sw / cfg.l2.net_sw_wm2, 3)
                            if cfg.l2.net_sw_wm2 else None),
        "未观测的自由量": {
            "urban_theta_frac": cfg.l2.urban_theta_frac,
            "说明": ("自然面 → 城市硬化面的折减系数，**目前无观测**，"
                   "显式参数化。故 θ0 只是部分识别："
                   "θ_obs 有观测上界，θ_city 的大小取决于此系数。"),
        },
        "反演来源": rep.get("src"), "驱动": rep.get("driver"),
        "锚点": rep.get("anchor"),
        "applied": bool(getattr(soil, "applied", False)),
    }

    # ---- 第二步：同一 U，多个干预世界 ----
    base_kp = CLI._kernel_params(cfg, soil)
    rows = []
    t0 = time.perf_counter()
    for name, invert, note in WORLDS:
        kp = copy.copy(base_kp)
        kp.drainage_invert_m = float(invert)
        try:
            res = K.run(g, rain, kp)
        except Exception as e:  # noqa: BLE001
            rows.append({"世界": name, "顶托_m": invert, "错误": type(e).__name__})
            continue
        peak = np.asarray(res.depth).max(axis=0)
        ha = (g.cell_m ** 2) / 1e4
        rows.append({
            "世界": name, "顶托_m": invert, "说明": note,
            "峰值水深_m": round(float(peak.max()), 4),
            "红格_ha": round(float((peak >= RED_TH).sum() * ha), 2),
            "橙格以上_ha": round(float((peak >= ORANGE_LO).sum() * ha), 2),
            "排水_万m3": round(float(res.drain_total_m3) / 1e4, 1),
            "下渗_万m3": round(float(res.infil_total_m3) / 1e4, 1),
            "守恒残差": float(f"{res.mass_resid:.2e}"),
        })
    elapsed = round(time.perf_counter() - t0, 1)

    good = [r for r in rows if "峰值水深_m" in r]
    fact = next((r for r in good if "现实" in r["世界"]), None)
    cmax = max(good, key=lambda r: r["峰值水深_m"]) if good else None

    payload = {
        "名称": "第三级反事实：反演前期状态后换一个干预",
        "生成时间": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "为什么这一件是第三级而不是第二级": (
            "p41 自己是干预实验，边界里写明『真实前期状态没有观测，只能设定』。"
            "本件先**从观测反演**前期状态（θ0、net_sw），把它钉住不动，"
            "只换排水顶托——这就是 Pearl 第三级：同一个 U 下的反事实。"
            "第二级只需设定 U，第三级必须**观测到 U**。"),
        "降雨": {"面雨量_mm": rain_rep.get("mm") if isinstance(rain_rep, dict) else None,
               "驱动": (rain_rep.get("driver") if isinstance(rain_rep, dict) else None)},
        "第一步_反演U": abduction,
        "第二步_反事实世界": rows,
        "耗时_s": elapsed,
        "结论": [],
        "边界": [
            "**U 只部分识别**：urban_theta_frac=0.456 无观测，"
            "故 θ0 的城市值是『观测 × 未标定折减』，不是纯观测。",
            "净辐射反演依赖 ET0 → 净辐射的换算链，其中 albedo、"
            "ground_flux_frac、sensible_frac 仍为参数化值。",
            "顶托是河网/潮位水位的代理，**无任何观测**；"
            "四个世界是设定值而非反演值。",
            "本件仍是**单变量反事实**：只动顶托，其余保持反演值；"
            "真实反事实需要多变量联合分布。",
            "观测证据仅来自 17 个涝点的通报水深（p5/p26 已证明其空间技能不足），"
            "故本件不做『反演模型误差项』——那一步在本项目不可行。",
            "反事实数字不可与 p41 的包络逐位比较：p41 用参数化 net_sw=40，"
            f"本件用反演 net_sw={net_sw:.1f}。",
        ],
    }

    concl = [
        (f"**反演得到的 U**：θ0={theta0:.3f}（自然面实测反演 "
         f"{theta_obs:.3f} × 城市折减 {cfg.l2.urban_theta_frac}），"
         f"与参数化先验 {cfg.l2.soil_theta0} "
         + ("**恰好相符**——先验没被观测推翻。" if abduction["θ0_是否与先验相符"]
            else "**不符**——先验被观测推翻。")),
        (f"**但净辐射被推翻**：参数化先验 {cfg.l2.net_sw_wm2:.1f} W/m²，"
         f"观测反演 {net_sw:.1f} W/m²，"
         f"先验**低估 {abduction['net_sw_先验低估倍数']} 倍**。"
         "这是本件唯一一条『观测修正了模型假设』的硬结果。"),
    ]
    if fact and cmax and fact["峰值水深_m"]:
        ratio = cmax["峰值水深_m"] / fact["峰值水深_m"]
        concl.append(
            f"**同一 U 下换顶托**：现实 {fact['峰值水深_m']} m（顶托 0.05），"
            f"最优 {good[0]['峰值水深_m']} m（顶托 {good[0]['顶托_m']}），"
            f"最差 {cmax['峰值水深_m']} m（顶托 {cmax['顶托_m']}）→ "
            f"**跨 {ratio:.2f} 倍**。红格从 {fact['红格_ha']} ha 变为 "
            f"{cmax['红格_ha']} ha。")
        concl.append(
            "**这就是反事实与干预的区别**：p41 说『若 θ0 干/湿，差 +150%』——"
            "那是设定出来的包络；本件说『**在观测到的前期状态下**，"
            "若顶托是 0.50 而非 0.05，峰值变成 X』——"
            "这是能被观测证据约束的、关于**已发生事件**的陈述。")
    concl.append(
        "**但它仍然不是完整的三级**：真正的三级要对**已发生的损失**做归因"
        "（『那 17 个点之所以淹，多少是因为顶托、多少是因为雨』）。"
        "那需要反演模型的结构误差项，而 p5/p26 已证明该误差不可空间反演——"
        "**这一步在本项目不可行，且原因不是方法，是观测密度。**")

    payload["结论"] = concl

    (OUT / "p57_第三级反事实.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  反演: θ0={theta0:.3f}（先验 {cfg.l2.soil_theta0}）  "
          f"net_sw={net_sw:.1f}（先验 {cfg.l2.net_sw_wm2}，"
          f"低估 {abduction['net_sw_先验低估倍数']}×）")
    for r in good:
        print(f"    {r['世界']:<20} 顶托 {r['顶托_m']:.2f}  "
              f"峰值 {r['峰值水深_m']:.4f} m  红格 {r['红格_ha']:.2f} ha")
    print(f"  耗时 {elapsed}s → {OUT / 'p57_第三级反事实.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
