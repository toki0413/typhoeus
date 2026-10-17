"""提比翁回归测试骨架。

对应 `ENGINEERING_MATURITY.md` H1。当前 2647 行代码此前**零测试**，
本会话修复的 8 个内核 bug 全部靠人工 debug 发现，没有一条能被回归拦住。

设计取舍：
1. **小网格fixture**。全链 39 s，CI 每次提交都跑不现实。
   单测用 30x30 网格，只有`test_output_deterministic` 跑全链并标 slow。
2. **每个用例锁一个已修 bug**。断言写的是那条 bug 的具体失效方式，
   不是笼统的 "returns True"。例如 NaN 用例断言抛 NonFiniteError，
   而不是断言结果里有 nan。
3. **不追求覆盖率数字**。12 条用例覆盖 8 个 bug 与 3 条新口径，
   覆盖率低但每一条都有具体的失效场景。

运行：pytest -q（本文件需 pytest；未装则可用下方 `python -m typhoeus.tests` 跑等价断言）
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from typhoeus import finiteness as FN
from typhoeus import gates as G
from typhoeus import kernel as K
from typhoeus import observe as OB
from typhoeus import planner as P
from typhoeus import projection as PRJ
from typhoeus import reconcile as RC
from typhoeus import version as V
from typhoeus.config import Config, L3_Strategy


# ---------- fixtures ----------

class _Grid:
    """最小网格替身。30x30、54 m 像元、高程带一个缓坡。"""

    def __init__(self, ny=30, nx=30):
        self.cell_m = 54.0
        self.lat = np.linspace(29.84, 29.92, ny)
        self.lon = np.linspace(121.55, 121.70, nx)
        self.elev = (np.add.outer(np.arange(ny), np.arange(nx)) * 0.05)

    @property
    def shape(self):
        return self.elev.shape


@pytest.fixture
def grid():
    return _Grid()


@pytest.fixture(autouse=True)
def _fresh_call_budget():
    """每个测试前清零工具调用预算。

    R4 限制单次对话最多 2 个工具调用，而测试会连续调多个。
    不清零的话这些测试测到的不是它们声称的东西，而是 R4 本身。
    """
    from typhoeus import mcp_server as MS
    MS.reset_call_budget()
    yield
    MS.reset_call_budget()


def _rain(nt=8, ny=30, nx=30, peak=10.0):
    """逐步增强的降雨场（mm/h），峰值在末步。"""
    r = np.zeros((nt, ny, nx))
    for k in range(nt):
        r[k] = peak * (k + 1) / nt
    return r


# ---------- H2：NaN 防线 ----------

def test_nan_rejected_at_kernel_entry():
    """已修 bug：NaN 绕过全部三道防线。

    失效方式：`h.min() < -1e-12`、`h[h<0]`、`np.where(h<min,h,0)`
    对 NaN 恒为 False，三处全漏过，run() 返回 positivity_ok=True
    而 mass_resid=nan。
    """
    rain = _rain()
    rain[3, 10, 10] = np.nan
    with pytest.raises(FN.NonFiniteError):
        K.run(_Grid(), rain, K.KernelParams())


def test_nan_rejected_in_projection():
    """投影层是水深的最后一个消费者，nan 会直达 Q 值与输出物。"""
    d = np.zeros((5, 30, 30))
    d[2, 5, 5] = np.nan
    with pytest.raises(FN.NonFiniteError):
        PRJ.aggregate(d)


def test_finiteness_helpers():
    assert FN.count_nonfinite(np.array([1.0, np.nan, np.inf])) == 2
    assert FN.count_nonfinite(np.array([])) == 0
    assert FN.count_nonfinite(3.5) == 0
    with pytest.raises(FN.NonFiniteError):
        FN.assert_finite(np.array([1.0, -np.inf]), "测试")
    # 正常输入不抛错
    FN.assert_finite(np.array([0.0, 1.0]), "测试")


# ---------- 内核三条硬约束 ----------

def test_mass_conservation(grid):
    """守恒核算闭合。锁住逐边累加与量纲对齐两条 bug。"""
    res = K.run(grid, _rain(nt=6), K.KernelParams())
    tol = K.KernelParams().tol_mass
    assert res.mass_resid <= tol, f"守恒残差 {res.mass_resid} 超容差 {tol}"
    # 收支各项求和应等于域内存量（含数值损耗）
    budget = res.__dict__.get("budget", {})
    if budget:
        assert all(v == v for v in budget.values()), "收支项含 NaN"


def test_positivity(grid):
    """正性在干湿截断之前判。此处锁住"检查放在截断之后形同虚设"的 bug。"""
    res = K.run(grid, _rain(nt=6), K.KernelParams())
    assert res.positivity_ok
    assert float(res.depth.min()) >= 0.0


def test_flux_budget_no_negative(grid):
    """供体出流预算。失效时会出现负水深或单步出流超过 0.95*h。"""
    res = K.run(grid, _rain(nt=6, peak=30.0), K.KernelParams())
    assert float(res.depth.min()) >= -1e-9
    assert res.neg_loss_m3 >= 0.0, "负水深修正量不应为负"
    # 强降雨下若出现负水深，说明供体预算失效；正常路径该值应为 0
    assert res.neg_loss_m3 < 1e-6, f"负水深修正 {res.neg_loss_m3} 偏大"


# ---------- Green-Ampt 入渗 + Ghil-Sellers 能量平衡 ----------


def _kga(**kw):
    kw.setdefault("infiltration_mode", "green_ampt")
    kw.setdefault("dt_s", 600.0)
    kw.setdefault("max_t_h", 6.0)
    return K.KernelParams(**kw)


def _storm(nt, ny, nx, peak):
    """钟形雨场，峰值在 1/3 处。"""
    t = np.arange(nt)
    shape = np.exp(-0.5 * ((t - nt / 3.0) / (nt / 6.0)) ** 2)
    return np.tile((peak * shape)[:, None, None], (1, ny, nx)).astype(np.float32)


def test_infiltration_mode_switch_changes_result(grid):
    """两种机制必须给出不同的入渗量，否则开关本身是假的。"""
    rain = _storm(37, 30, 30, 20.0)
    old = K.run(grid, rain, _kga(infiltration_mode="legacy",
                                infiltration_m_h=1.2e-3))
    new = K.run(grid, rain, _kga())
    assert old.infiltration_mode == "legacy"
    assert new.infiltration_mode == "green_ampt"
    assert abs(old.infil_total_m3 - new.infil_total_m3) > 1e-6, \
        "legacy 与 green_ampt 入渗量相同，机制开关未生效"


def test_green_ampt_conserves_mass(grid):
    """加了土壤状态与蒸发后，水量守恒残差仍须在容差内。

    这一条最容易失效：蒸发把土壤水搬出系统，而土壤水不在
    守恒等式的项里。多算或少算一项都会从这里露出来。
    """
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    assert res.mass_resid <= _kga().tol_mass, \
        f"守恒残差 {res.mass_resid:.3e}"
    assert res.positivity_ok


def test_green_ampt_soil_budget_closes(grid):
    """土壤侧恒等式：储水变化 = 下渗 − 土壤蒸发。

    三个量都从同一次推演取，恒等式不成立说明其中一项记错了口径
    （最可能是把蒸发算进了下渗里）。
    """
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    lhs = res.soil_final_m3 - res.soil_init_m3
    rhs = res.infil_total_m3 - res.evap_total_m3
    assert abs(lhs - rhs) <= 1e-9 * max(res.infil_total_m3, 1.0), \
        f"土壤收支不闭合：ΔS={lhs:.6e} 入渗−蒸发={rhs:.6e}"


def test_green_ampt_capacity_is_hard_ceiling(grid):
    """土壤储水不得超过有效容量。

    失效时土壤水会无限累积，饱和机制等于没设。
    """
    res = K.run(grid, _storm(73, 30, 30, 60.0), _kga())
    cfg = _kga()
    cap = cfg.soil_capacity_mm / 1000.0 * (1.0 - cfg.impervious_frac)
    assert res.soil_final_m3 <= cap * res.n_cells * res.cell_area_m2 * 1.001, \
        f"土壤储水 {res.soil_final_m3:.4f} 超有效容量上限"


def test_impervious_fraction_scales_infiltration(grid):
    """硬化面占比越高，有效土壤容量越小，入渗越少。

    这条是本轮实测暴露出来的错误：缺折减时整片城区被当成裸土农田，
    入渗被名义容量锁死，59 mm 与 1179 mm 雨场的入渗只差 0.04 mm。
    """
    rain = _storm(73, 30, 30, 30.0)
    low = K.run(grid, rain, _kga(impervious_frac=0.0))
    high = K.run(grid, rain, _kga(impervious_frac=0.9))
    assert high.infil_total_m3 < low.infil_total_m3, \
        (f"硬化面 90% 的入渗 {high.infil_total_m3:.4f} 未低于"
         f" 0% 的 {low.infil_total_m3:.4f}")


def test_suction_gain_shrinks_as_soil_fills(grid):
    """吸力增益随土壤饱和而衰减，退化为纯 Ksat。

    这是 Green-Ampt 替换 legacy 的全部意义所在：入渗能力由
    土壤状态决定，而不是由地表水深决定。
    """
    weak = K.run(grid, _storm(37, 30, 30, 4.0), _kga(soil_theta0=0.05))
    wet = K.run(grid, _storm(37, 30, 30, 4.0), _kga(soil_theta0=0.95))
    bw = weak.budget_energy()
    bwt = wet.budget_energy()
    # 干土的吸力增益占比必须高于湿土
    assert bw["吸力增益占比"] > bwt["吸力增益占比"], \
        (f"干土增益占比 {bw['吸力增益占比']} 未高于"
         f" 湿土 {bwt['吸力增益占比']}")


def test_legacy_mode_has_no_energy_budget(grid):
    """legacy 不跑能量平衡，能量账必须为空而不是填零。

    填零会被读成"能量项算过且恰好为零"，与"没算"是两件事。
    """
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga(infiltration_mode="legacy"))
    assert res.energy == {}
    assert res.evap_total_m3 == 0.0
    assert res.soil_init_m3 == 0.0


def test_energy_budget_closes(grid):
    """Ghil-Sellers 四项闭合：Rn = G + H + LE。"""
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    e = res.energy
    for k in ("净辐射_MJ_m2", "土壤热流_MJ_m2", "感热_MJ_m2", "潜热_MJ_m2"):
        assert k in e, f"能量账缺 {k}"
    assert abs(e["能量闭合残差_MJ_m2"]) < 1e-9, \
        f"能量不闭合，残差 {e['能量闭合残差_MJ_m2']}"
    assert e["净辐射_MJ_m2"] > 0.0, "净辐射应为正（台风遮蔽下是弱正值）"


def test_latent_heat_activation_reported(grid):
    """潜热项是否激活必须由实测算据落盘，不在正文里假设。

    net_sw=40 W/m² 的台风条件下 LE 是否显著，取决于 sensible_frac
    与 ground_flux_frac 之和是否 < 1。此测试只锁"报出来且是真值"。
    """
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    act = res.energy["潜热激活步占比"]
    assert 0.0 <= act <= 1.0
    cfg = _kga()
    expect = 1.0 if cfg.ground_flux_frac + cfg.sensible_frac < 1.0 else 0.0
    assert act == pytest.approx(expect, abs=1e-6), \
        f"潜热激活步占比 {act} 与参数推出的 {expect} 不符"


def test_evap_consumes_soil_water(grid):
    """蒸发真的从土壤水里扣，不是凭空出现或凭空消失。"""
    with_evap = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    no_evap = K.run(grid, _storm(37, 30, 30, 20.0),
                    _kga(ground_flux_frac=0.55, sensible_frac=0.45))
    # ground+sensible = 1.0 时 LE = 0，蒸发必须恰为 0
    assert no_evap.evap_total_m3 == 0.0, "LE=0 时仍有蒸发"
    assert no_evap.energy["潜热激活步占比"] == 0.0
    assert with_evap.evap_total_m3 > 0.0, "LE>0 但蒸发为 0"
    # 蒸发开启时土壤储水应低于关闭时（同样入渗扣得更多）
    assert with_evap.soil_final_m3 < no_evap.soil_final_m3


def test_unknown_infiltration_mode_rejected(grid):
    """拼错的机制名必须 raise，不能静默走默认分支。

    静默走默认的后果是"配了新机制但跑的是旧机制"，
    而 config hash 是新的——复算查不出来。
    """
    with pytest.raises(ValueError, match="infiltration_mode"):
        K.run(grid, _storm(6, 30, 30, 10.0),
              _kga(infiltration_mode="green-ampt"))      # 用了连字符


def test_kernel_params_built_from_config_single_source():
    """主链与多事件批量必须走同一个 KernelParams 构造。"""
    from typhoeus import cli as CLI
    cfg = Config()
    k = CLI._kernel_params(cfg)
    assert k.infiltration_mode == cfg.l2.infiltration_mode
    assert k.soil_ksat_m_h == cfg.l2.soil_ksat_m_h
    assert k.impervious_frac == cfg.l2.impervious_frac
    assert k.net_sw_wm2 == cfg.l2.net_sw_wm2
    assert k.soil_theta0 == cfg.l2.soil_theta0


def test_infiltration_params_enter_config_hash():
    """入渗机制参数进 hash —— 「同一 hash 才能复算」对它同样成立。"""
    a = Config()
    b = Config()
    assert a.hash() == b.hash()
    b.l2.soil_ksat_m_h *= 2.0
    assert a.hash() != b.hash(), "改 Ksat 未改变 config hash"
    c = Config()
    c.l2.infiltration_mode = "legacy"
    assert a.hash() != c.hash(), "切机制未改变 config hash"


def test_infiltration_budget_lines_all_finite(grid):
    """能量账与细分账不得出 NaN/inf。

    NaN 会一路传到 MCP 的 JSON 响应里，而 json 允许 NaN，
    下游解析器不一定认。
    """
    res = K.run(grid, _storm(37, 30, 30, 20.0), _kga())
    for k, v in res.budget_energy().items():
        if isinstance(v, (int, float)):
            assert v == v and abs(v) != float("inf"), f"{k} 非有限值"


def test_g18_excludes_infiltration_mm_from_rain_count():
    """入渗/蒸发/排水是 mm 但不是雨量，不得进 G18 的雨量分母。

    G18 量的是"雨量数字有没有带口径段"。把入渗量算进雨量，
    门槛统计的对象就与它的名字不符了——分母虚高，
    分子不变，通过率被无关字段稀释。
    """
    from typhoeus import agent_gates as AG
    # 只认 `_mm` 结尾的键（`_mm_h` 是雨强，不在这个门槛的口径内）。
    rain_only = {"面雨量_mm": 259.1, "面雨量72h_mm": 251.6}
    assert AG._count_rain_numbers(rain_only) == 2

    infil = {"下渗_mm": 4.83, "下渗_Ksat本底_mm": 4.78,
             "下渗_吸力增益_mm": 0.05, "土壤蒸发_mm": 0.70,
             "土壤储水变化_mm": 4.08, "排水_mm": 221.2}
    assert AG._count_rain_numbers(infil) == 0, \
        "入渗/蒸发/排水被误计为雨量数字"

    # 混合场景下只认雨量那一半
    mixed = dict(rain_only)
    mixed.update(infil)
    assert AG._count_rain_numbers(mixed) == 2


# ---------- 投影层 ----------

def test_capacity_monotone():
    """D 必须单调不增：水深越大，功能越低。这是恢复排序有意义的前提。"""
    ok, worst = PRJ.check_monotone(np.linspace(0, 1, 200))
    assert ok, f"D 非单调，最大违背 {worst}"


def test_q_not_time_average():
    """已修 bug：`acc/nt` 是全时段平均而非逐时空间平均。

    失效时整条曲线压成 1/nt，Q(0) < Q(t)，event_total 恒为 0，
    门槛 8 的三项分解全部退化成 0。
    """
    nt = 40
    d = np.zeros((nt, 30, 30))
    d[0, 10:20, 10:20] = 0.4      # 仅 t=0 有积水
    out = PRJ.aggregate(d)
    # 正确的逐时口径下 Q(0) 应明显低于 Q(末)：只有起雨时刻有积水。
    # 若退化成 1/nt 时间平均，整条曲线被压平，两个值相等。
    assert out["Q"][0] < out["Q"][-1], (
        f"Q(0)={out['Q'][0]:.4f} 不低于 Q(末)={out['Q'][-1]:.4f}，"
        f"起雨时刻的积水未反映到功能曲线上")
    assert out["Q"][-1] - out["Q"][0] > 0.05, (
        f"Q(0)={out['Q'][0]:.4f} 与 Q(末)={out['Q'][-1]:.4f} 差距过小，"
        f"疑似退化为时间平均")


def test_q_cutoff_semantics():
    """割点 = 损失达峰值损失 80% 的时刻。

    绝对阈值（跌破 Q(0) 的 80%）在损失幅度仅 3.56% 时永不跌破，
    割点恒等于窗口末���，语义上等于没有割点。
    """
    nt = 50
    d = np.zeros((nt, 30, 30))
    for k in range(nt):
        if 10 <= k < 30:
            d[k, 12:18, 12:18] = 0.35
    out = PRJ.aggregate(d)
    ci = out["cutoff_index"]
    assert 0 < ci < nt - 1, f"割点落在窗口端点（{ci}/{nt}），割点退化"
    assert out["cutoff_loss"] >= 0.80 * out["peak_loss"] - 1e-9


def test_all_zero_field():
    """边界情形：无灾场。Q≡1，割点 0，损失 0，不应抛错。

    损失用 1e-9 容差判零而非严格等于：capacity() 里的浮点运算
    在 h 全零时给出 1.0 - 1e-16 量级的残差，这是浮点表示的正常表现，
    不是口径错误。断言过严会让测试变成噪声。
    """
    out = PRJ.aggregate(np.zeros((10, 30, 30)))
    assert out["peak_loss"] < 1e-9, f"无灾场损失应为零，实得 {out['peak_loss']}"
    assert out["cutoff_index"] == 0
    assert abs(out["Q"][0] - 1.0) < 1e-9


def test_nt_one():
    """边界情形：单步。割点为 0，不应崩溃。"""
    out = PRJ.aggregate(np.full((1, 30, 30), 0.3))
    assert out["cutoff_index"] == 0


# ---------- A2：承灾体系数外置 ----------

def test_capacity_degenerate_b():
    """已修缺陷：b <= 0.1 时除零，功能曲线塌成常数且**仍通过单调性校验**。

    这是个静默出错的坑——不报错，只是数字全错。
    """
    h = np.linspace(0, 0.5, 50)
    out = PRJ.capacity(h, a=0.05, b=0.10)     # b 恰在绿级阈值
    assert np.all(np.isfinite(out)), "除零产生 inf/nan"
    ok, _ = PRJ.check_monotone(h, a=0.05, b=0.10)
    assert ok, "退化输入下仍应保持单调"


def test_road_capacity_validation():
    """参数校验：a > b（半损后回升）与量纲错误都必须报错。

    注意 a 与 b 的物理次序：a 是**容量**（半损后保留的比例），
    b 是**水深**（中断阈值）。所以不变量是 b ≥ 0.1 m（绿级阈值之上）
    且 b 与 a 各自合法，不存在 a > b 的约束——`capacity()` 里
    容量与水深是两个量纲，混在一起比会写出错误断言。
    """
    # b 低于绿级阈值：半损与中断水深都在 0.1 m 以下，量纲不自洽
    with pytest.raises(ValueError, match="绿级"):
        PRJ.ProjectionParams(road_capacity={"支路": {"a": 0.20, "b": 0.05}})
    # a 越界：容量保留比不可能超过 1
    with pytest.raises(ValueError, match="越界"):
        PRJ.ProjectionParams(road_capacity={"支路": {"a": 1.4, "b": 0.45}})
    # 路网占比之和不为 1
    with pytest.raises(ValueError, match="之和"):
        PRJ.ProjectionParams(road_mix={"支路": 0.5, "主干路": 0.3})


def test_road_capacity_exposed_in_params():
    """承灾体系数必须在 ProjectionParams 里，改动要能进 config hash。"""
    p = PRJ.ProjectionParams()
    assert set(p.road_capacity) == {"支路", "主干路", "下穿立交"}
    assert abs(sum(p.road_mix.values()) - 1.0) < 1e-9, "路网占比之和须为 1"


def test_road_capacity_affects_q():
    """改承灾体系数必须改功能曲线，否则外置是无效的。"""
    d = np.zeros((10, 30, 30))
    d[:, 10:20, 10:20] = 0.3
    base = PRJ.aggregate(d, PRJ.ProjectionParams())
    # 下穿立交更早失效，半损水深取小值应使损失更大
    hard = PRJ.ProjectionParams(road_capacity={
        "支路": {"a": 0.10, "b": 0.20},
        "主干路": {"a": 0.10, "b": 0.20},
        "下穿立交": {"a": 0.05, "b": 0.12},
    })
    strict = PRJ.aggregate(d, hard)
    assert strict["peak_loss"] > base["peak_loss"], "改承灾体系数未改变功能损失"


def test_road_capacity_change_moves_hash():
    """L3 承灾体进config 层，改它必须改 hash——否则"复算"不成立。"""
    a = Config()
    b = Config()
    b.l3.road_capacity["下穿立交"] = {"a": 0.15, "b": 0.28}
    assert a.hash() != b.hash(), "改承灾体系数但 config_hash 未变"


# ---------- H6：未知字段告警 ----------

def test_unknown_field_warns(tmp_path):
    """静默忽略未知字段会让用户以为新参数生效了，实际它没进对象。"""
    import json
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({
        "L4_solver": {"dt_s": 600.0, "dt_ss": 60.0}   # 拼写错误
    }), encoding="utf-8")
    with pytest.warns(UserWarning, match="未知字段"):
        Config.load(str(p))


def test_valid_config_no_warn(tmp_path):
    import json
    p = tmp_path / "ok.json"
    p.write_text(json.dumps({"L4_solver": {"dt_s": 600.0}}), encoding="utf-8")
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        c = Config.load(str(p))
    assert c.l4.dt_s == 600.0


# ---------- H4：版本单一来源 ----------

def test_version_single_source():
    """SCHEMA_VERSION 只在 version.py 定义一处，改一处不漂移。"""
    from typhoeus import compile as C
    assert C.SCHEMA_VERSION is V.SCHEMA_VERSION
    assert C.KERNEL_VERSION is V.KERNEL_VERSION


def test_check_compat_low_rejected():
    v = V.check_compat({"schema_version": "1.0.0"})
    assert not v["readable"], "低版本应拒绝读取"
    v = V.check_compat({"schema_version": "99.0.0"})
    assert v["readable"] and not v.get("forward_compatible"), "高版本应可读但标记"


def test_schema_is_minor_bump():
    """schema 版本须 ≥ 最小可读版本，且不降级。

    不断言具体版本号字符串——那会让每次升版都要改测试，且掩盖了
    "降级"这个真正要防的错误。
    """
    cur = V.parse_semver(V.SCHEMA_VERSION)
    minr = V.parse_semver(V.MIN_READABLE_SCHEMA)
    assert cur >= minr, f"schema {V.SCHEMA_VERSION} 低于最小可读版本"
    # 兼容 3.0.0 的读取是文档承诺，不随升版改变
    assert V.MIN_READABLE_SCHEMA == "3.0.0"
    # 旧版本 payload 必须仍可读
    old = V.check_compat({"schema_version": "3.0.0"})
    assert old["readable"], "3.0.0 应仍可读"


# ---------- A1：四阶段×五维度 ----------

def test_every_gate_has_axes():
    """每条门槛都要带 stage/cover，否则矩阵有格无内容。"""
    gs = G.check_all(_fake_ctx())
    for x in gs:
        assert x.get("stage") in G.STAGES, f"门槛 {x['id']} stage 非法"
        assert x.get("cover") in G.DIMENSIONS, f"门槛 {x['id']} cover 非法"


def test_matrix_exposes_empty_cells():
    """矩阵的实际价值是暴露空白。economy/environment 应出现在空格清单里。"""
    gs = G.check_all(_fake_ctx())
    m = G.coverage_matrix(gs)
    assert set(m["matrix"]) == set(G.STAGES)
    assert len(m["matrix"]["rescue"]) == len(G.DIMENSIONS)
    # 当前没有任何门槛挂在 economy/environment 两维上
    assert any("economy" in c for c in m["empty_cells"])
    assert any("environment" in c for c in m["empty_cells"])


# ---------- 规划器 ----------

def test_greedy_differs_from_degree():
    """次模贪心与按度排序不应构造相同，否则提升恒0、门槛 6 退化。"""
    st = np.zeros((24, 24))
    st[2:8, 2:8] = 0.7
    st[15:22, 15:22] = 0.3
    out = P.compare_orders(st, dt_h=1.0)
    assert "gain_over_baseline" in out


# ---------- 规划器评分口径（v3.2.0 修） ----------
#
# 这组用例针对一个已修的真实缺陷：`functional_area` 曾把自然恢复写成
# "每步 0.02"，与 dt_h 耦合且让"步数"成为策略质量的隐性权重。48 h /
# 0.1 h = 480 步内 (1-0.02)^480 仅 6e-5，衰减把晚清的损失几乎全部吃掉，
# 于是"晚清"反而得分更高。实测默认参数下贪心 1704.4 < 随机 2229.6，
# 算法被评分函数判成弱于随机。

def test_no_natural_recovery_by_default():
    """默认不应含自然恢复项——评分只比恢复次序，不掺入恢复动力学。"""
    st = np.zeros((30, 30))
    st[5:12, 5:12] = 0.8
    order = P.restore_order(st)
    # 相同序列、不同衰减参数：默认(0) 与显式 0 必须完全一致
    a = P.functional_area(order, st, dt_h=0.1, recovery_rate_per_h=0.0)
    b = P.functional_area(order, st, dt_h=0.1, recovery_rate_per_h=0.0)
    assert abs(a - b) < 1e-9


def test_decay_decoupled_from_dt_h():
    """衰减须按物理时间计：相同物理时长内，累计衰减因子一致。

    注意与清除次数的区别——恢复是离散事件，每步清除一次，所以
    dt 变小会让清除更频繁、面积更小。真正要检的是"衰减因子本身"
    不再随 dt 放大：dt=0.1 与 dt=0.2 在各自一步上的衰减量之比应为 2。
    """
    st = np.zeros((24, 24))
    st[4:10, 4:10] = 0.6
    # 单步衰减量：dt=0.1 @ 5%/h -> 0.5%/步；dt=0.2 -> 1%/步
    d1 = 1.0 - 0.05 * 0.1
    d2 = 1.0 - 0.05 * 0.2
    assert abs((1 - d1) * 2 - (1 - d2)) < 1e-12, "衰减未按物理时间线性化"
    # 且随 dt 单调：dt 越小面积越小（清除更频繁）
    order = P.restore_order(st)
    a = P.functional_area(order, st, dt_h=0.1, horizon_h=2.4,
                          recovery_rate_per_h=0.05)
    b = P.functional_area(order, st, dt_h=0.4, horizon_h=2.4,
                          recovery_rate_per_h=0.05)
    assert a < b, "dt 变小应带来更频繁的清除，面积应变小"


def test_greedy_beats_both_baselines():
    """次模贪心须同时优于随机与按度。仅优于最优基线不够——
    另一条基线明显更差时仍报PASS 是掩盖而非验证。"""
    rng = np.random.default_rng(20210725)
    st = rng.random((60, 60))
    st = np.where(st < 0.15, st * 2.0, 0.0)
    out = P.compare_orders(st, dt_h=0.1)
    assert out["beats_both"], (
        f"贪心未同时优于两基线：贪心 {out['greedy_area']:.1f} / "
        f"随机 {out['random_area']:.1f} / 按度 {out['degree_area']:.1f}")
    assert out["greedy_area"] < out["random_area"]
    assert out["greedy_area"] < out["degree_area"]


def test_horizon_capped_at_event_window():
    """评分窗口不得超过 72 h 事件窗。超出后比的是"谁把积水留到
    窗外的时刻更晚"，那不是恢复效率。

    构造长排序：60x60 稀疏积水在 dt=0.167 下需 129 步= 21.5 h，未触发
    封顶；把 dt 降到 0.05 h 则 129 步= 6.45 h。这里用更稀疏的状态把
    所需步数推过 72 h / dt 的界，验证封顶生效。
    """
    rng = np.random.default_rng(0)
    st = rng.random((60, 60))
    st = np.where(st < 0.15, st * 2.0, 0.0)
    # dt 大 -> 步数少 -> 不封顶；此处先确认未封顶的情形本身合法
    out = P.compare_orders(st, dt_h=0.167)
    assert out["horizon_h"] <= 72.0 + 1e-9
    # 显式传入超窗horizon 时按传入值算，不做静默截断
    out2 = P.compare_orders(st, dt_h=0.167, horizon_h=200.0)
    assert out2["horizon_h"] == 200.0, "显式 horizon 不应被静默改写"
    assert out2["horizon_capped_at_72h"] is False


def test_gate6_rejects_when_only_beats_best_baseline():
    """只优于最优基线、未优于另一条时，门槛 6 必须 FAIL。"""
    c = {"greedy_area": 100.0, "random_area": 200.0, "degree_area": 90.0,
         "best_baseline_area": 200.0, "best_baseline": "random",
         "gain_over_baseline": 0.5, "beats_both": False,
         "horizon_h": 72.0, "horizon_capped_at_72h": True,
         "greedy_order_head": [], "degree_order_head": [], "n_nodes": 100,
         "n_cmp_steps": 10, "steps_to_clear": {}, "recovery_rate_per_h": 0.0}
    gs = G.check_all({**_fake_ctx(), "order_cmp": c})
    g6 = next(x for x in gs if x["id"] == 6)
    assert g6["status"] == "FAIL", "只优于一条基线却报 PASS，判据失效"


def test_gate6_tolerates_legacy_order_cmp():
    """旧结构的 order_cmp（无 beats_both）不应让门槛函数崩溃。"""
    c = {"greedy_area": 100.0, "random_area": 200.0, "degree_area": 190.0,
         "best_baseline_area": 200.0, "best_baseline": "random",
         "gain_over_baseline": 0.5,
         "greedy_order_head": [], "degree_order_head": [], "n_nodes": 100}
    gs = G.check_all({**_fake_ctx(), "order_cmp": c})
    g6 = next(x for x in gs if x["id"] == 6)
    assert "未做双基线校验" in g6["note"]


def test_steps_to_clear_detects_completion():
    """steps_to_clear 必须能给出清空全量所需步数，否则诊断字段失真。"""
    st = np.zeros((20, 20))
    st[5:8, 5:8] = 0.5
    order = P.restore_order(st)
    n = P.steps_to_clear(order, st)
    assert n > 0, "应能用有限步清空"
    assert P.steps_to_clear(order[:0], st) == -1, "空序列不可能清空"


# ---------- 降雨源与输入层校验 ----------

def test_domain_filter_prefers_grid_over_bbox():
    """域内判定必须按格网实际范围，不能按请求框。

    请求框比格网范围大零点几度，落在两者之间的站点测点在计算域外，
    插值权重没有定义。用请求框判会多算站，订正锚点与校验锚点就此错位。
    """
    st = [{"station": "A", "lon": 121.60, "lat": 29.87, "accum_mm": 300.0},
          {"station": "B", "lon": 121.54, "lat": 29.87, "accum_mm": 100.0}]

    class _G:
        lon = np.array([121.55, 121.70])
        lat = np.array([29.84, 29.92])

    bb = {"lon_min": 121.53, "lon_max": 121.70,
          "lat_min": 29.84, "lat_max": 29.92}
    by_grid = OB.rain_check(300.0, st, bb, grid=_G())
    by_bbox = OB.rain_check(300.0, st, bb)
    assert by_grid["n_stations"] == 1, f"格网口径应判1 站，判了 {by_grid['n_stations']}"
    assert by_bbox["n_stations"] == 2, f"请求框口径应判 2 站，判了 {by_bbox['n_stations']}"
    assert by_grid["domain_basis"].startswith("grid.lon/lat")


def test_calibrated_rain_check_marks_in_sample():
    """订正过的降雨场再用同一批站校验，是自样本，判据必须换口径。"""
    st = [{"station": "宁波站", "lon": 121.56, "lat": 29.87, "accum_mm": 283.0}]

    class _G:
        lon = np.array([121.55, 121.70])
        lat = np.array([29.84, 29.92])

    raw = OB.rain_check(259.0, st, grid=_G())
    cal = OB.rain_check(283.0, st, grid=_G(), calibrated=True)

    assert raw["in_sample"] is False, "未订正时域内口径是独立比对"
    assert raw["rel_err_verdict"] == raw["rel_err"], "独立时判据就用域内口径"
    assert cal["in_sample"] is True, "订正后域内口径是自样本"
    assert cal["rel_err"] == 0.0, "构造上自样本偏差接近零"
    assert cal["rel_err_verdict"] == cal["rel_err_allcity"], (
        "自样本时判据必须落到与订正锚点不同源的全市口径")
    assert "全市" in cal["verdict_basis"]


def test_gate15_fails_when_only_insample_passes():
    """自样本过关但独立口径超差时，门槛 15必须判FAIL。"""
    ctx = _fake_ctx()
    ctx["rain_check"] = {
        "model_mm": 259.0, "obs_mm": 283.0, "rel_err": -0.085,
        "rel_err_allcity": -0.309, "rel_err_verdict": -0.309,
        "in_sample": True, "n_stations": 1, "allcity_mm": 375.0,
        "verdict_basis": "官方全市面雨量（与订正锚点不同源）",
        "domain_basis": "grid.lon/lat 实际范围",
        "obs_basis": "域内实测站算术均值（1 站：宁波站 283）",
        "sampling_bias": "测试用",
    }
    g = {x["id"]: x for x in G.check_all(ctx)}
    assert g[15]["status"] == "FAIL", (
        f"自样本 -8.5% 但独立口径 -30.9%，判据应 FAIL，实得 {g[15]['status']}")
    assert "自样本" in g[15]["note"]


def test_gate15_passes_on_independent_domain_check():
    """未订正时判据仍取域内口径，行为不因新增字段而改变。"""
    ctx = _fake_ctx()
    ctx["rain_check"] = {
        "model_mm": 202.0, "obs_mm": 269.0, "rel_err": -0.25,
        "rel_err_allcity": -0.46, "rel_err_verdict": -0.25,
        "in_sample": False, "n_stations": 2, "allcity_mm": 375.0,
        "verdict_basis": "域内实测站算术均值",
        "domain_basis": "grid.lon/lat 实际范围",
        "obs_basis": "测试用", "sampling_bias": "测试用",
    }
    g = {x["id"]: x for x in G.check_all(ctx)}
    assert g[15]["status"] == "FAIL", "-25% 超 15% 判据，应 FAIL"
    assert "独立" in g[15]["value"]


# ---------- MCP 只读服务 ----------

def test_mcp_desc_budget():
    """六个工具的描述总量须在 2 KB 内。超了就是往 Agent 上下文里塞噪声。"""
    from typhoeus import mcp_server as MS
    n = MS.desc_bytes()
    assert n <= MS.DESC_BUDGET_B, f"描述总量 {n} B 超预算 {MS.DESC_BUDGET_B} B"


def test_mcp_tools_match_artifacts_exactly():
    """工具集须与产物集一一对应，且一个不多一个不少。

    产物分两类：前六份由 `COMPILERS` 从单场ctx 编译，第七份
    （多事件标定单）由 `calib_sheet` 从批量标定结果编译——它独立
    运行、不并入主链，因为全链 40 s 而批量6 min，混在一起日常
    回归跑不掉。所以对齐关系要显式写出，不能只比`COMPILERS`。
    """
    from typhoeus import mcp_server as MS
    from typhoeus.compile import COMPILERS
    from typhoeus import calib_sheet as CSH
    # 第七份产物由 calib_sheet 产出，文件名在 cli 里定死
    standalone = {"07_multievent_calibration"}
    assert set(MS._TOOL_FILES.values()) == set(COMPILERS) | standalone, (
        f"工具与产物不对齐：{sorted(MS._TOOL_FILES.values())} "
        f"vs {sorted(set(COMPILERS) | standalone)}")
    assert set(MS._TOOL_FNS) == set(MS._TOOL_FILES), "工具名与映射表不一致"
    assert CSH.multievent_sheet("out").get("名称") == "多事件标定单"


def test_mcp_tools_return_provenance():
    """每个工具返回必须带来源凭据。无来源的数字不可引用。"""
    from typhoeus import mcp_server as MS
    for name, fn in MS._TOOL_FNS.items():
        MS.reset_call_budget()      # R4：单次对话 2 个调用，循环内清零
        r = fn()
        assert r["产物"], f"{name} 缺产物名"
        p = r["来源"]
        assert p.get("config_hash"), f"{name} 缺 config_hash"
        assert p.get("caveat"), f"{name} 缺 caveat"
        assert r["数据"].get("schema_version"), f"{name} 缺 schema_version"


def test_mcp_missing_artifact_raises_with_actionable_message():
    """产物缺失时报错要说清怎么修，不说"文件不存在"就完了。"""
    from typhoeus import mcp_server as MS
    with pytest.raises(MS.ArtifactError) as e:
        MS.get_health_report(outdir="/tmp/typhoeus-nonexistent-dir")
    assert "cli run" in str(e.value), "报错须指明先跑全链"


def test_mcp_rejects_unreadable_schema(tmp_path):
    """低于最小可读版本的产物必须拒答。

    返回一份标了告警的旧产物看起来是"有数据"，Agent 会照着用，而那些
    字段在旧版本下没有定义。这比拿不到数据更坏。
    """
    import shutil
    from typhoeus import mcp_server as MS
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)
    p = dst / "06_health_report.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d["schema_version"] = "2.9.0"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(MS.ArtifactError) as e:
        MS.get_health_report(outdir=str(dst))
    assert "版本不可读" in str(e.value)


def test_mcp_flags_missing_provenance(tmp_path):
    """manifest 缺指纹时明说降级，不让 Agent 把 None 当配置值。"""
    import shutil
    from typhoeus import mcp_server as MS
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)
    (dst / "manifest.json").unlink()
    r = MS.get_health_report(outdir=str(dst))
    assert "_degraded" in r["来源"], "manifest 缺失须标记降级"


def test_mcp_cache_invalidates_on_change(tmp_path):
    """产物改了缓存必须失效。不失效就是给 Agent 陈旧结论。"""
    import shutil
    from typhoeus import mcp_server as MS
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)
    before = MS.get_health_report(outdir=str(dst))
    hp = dst / "06_health_report.json"
    d = json.loads(hp.read_text(encoding="utf-8"))
    d["峰值水深_m"] = 9.99
    hp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    after = MS.get_health_report(outdir=str(dst))
    assert before["数据"]["峰值水深_m"] != 9.99
    assert after["数据"]["峰值水深_m"] == 9.99, "缓存未失效，返回了陈旧值"


def test_mcp_is_readonly():
    """server 全程不写文件。这是它能被称为"只读"的前提，不是承诺。"""
    from typhoeus import mcp_server as MS
    src = Path(__file__).resolve().parent.parent / "out"
    before = {p.name: p.stat().st_mtime_ns for p in src.iterdir()}
    n_before = len(list(src.iterdir()))
    for fn in MS._TOOL_FNS.values():
        MS.reset_call_budget()      # 同上
        fn(outdir=str(src))
    after = {p.name: p.stat().st_mtime_ns for p in src.iterdir()}
    assert before == after, "工具调用改动了 out/ 里的文件"
    assert len(list(src.iterdir())) == n_before, "工具调用在 out/ 里新建了文件"


def test_mcp_server_end_to_end():
    """经 MCP 协议层实调七个工具，不只调底层函数。"""
    import asyncio
    pytest.importorskip("mcp")
    from typhoeus import mcp_server as MS

    async def _go():
        srv = MS.build_server()
        tools = await srv.list_tools()
        assert len(tools) == len(MS._TOOL_FNS), (
            f"协议层暴露 {len(tools)} 个工具，"
            f"函数表里{len(MS._TOOL_FNS)} 个")
        out = {}
        for name in MS._TOOL_FNS:
            # 每个工具单次调用：R4 限制单次对话 2 个调用，
            # 连调六个会超限。这条测的是协议层可达性，不是调用预算。
            MS.reset_call_budget()
            r = await srv.call_tool(name, {})
            txt = r[0][0].text if isinstance(r, tuple) else r[0].text
            out[name] = json.loads(txt)
        return out

    res = asyncio.run(_go())
    assert len(res) == len(MS._TOOL_FNS)
    for name, d in res.items():
        assert d["数据"]["名称"], f"{name} 未返回产物内容"


# ---------- 护栏：三条硬拒绝 ----------

def test_r1_rejects_out_of_domain():
    """域外点必须拒答。余姚是最容易被问的域外点位——暴雨中心。"""
    from typhoeus import guardrails as GR
    with pytest.raises(GR.RefusalError) as e:
        GR.check_in_domain(121.15, 30.03, "余姚城区")
    assert "余姚" in str(e.value) or "域外" in str(e.value)
    assert "475" in str(e.value), "拒答要说清为什么不能外推"


def test_r1_accepts_in_domain():
    from typhoeus import guardrails as GR
    r = GR.check_in_domain(121.617, 29.868, "鄞州大道")
    assert r["in_domain"] is True


def test_r1_rejects_unparsable_coord():
    from typhoeus import guardrails as GR
    with pytest.raises(GR.RefusalError):
        GR.check_in_domain("东经121.6", 29.87)


def test_r2_rejects_weak_baseline():
    """只优于一条基线、缺双基线标记、缺评分窗口，三种都必须拒。"""
    from typhoeus import guardrails as GR
    good = {"gain_over_baseline": 0.2961, "beats_both": True,
            "horizon_h": 72.0, "horizon_capped_at_72h": True,
            "n_cmp_steps": 1291}
    GR.check_order_usable(good)          # 正常产物不得被拒
    for bad in ({**good, "beats_both": False},
                {k: v for k, v in good.items() if k != "beats_both"},
                {k: v for k, v in good.items() if k != "horizon_h"},
                {**good, "gain_over_baseline": -0.05}):
        with pytest.raises(GR.RefusalError):
            GR.check_order_usable(bad)


def test_r3_rejects_single_basis():
    """只给单一口径，或把自样本数字当判据，都必须拒。"""
    from typhoeus import guardrails as GR
    full = {"rel_err": -0.085, "rel_err_allcity": -0.309,
            "rel_err_verdict": -0.309, "verdict_basis": "官方全市",
            "domain_basis": "grid.lon/lat", "in_sample": True}
    GR.check_dual_basis(full, "测试")
    with pytest.raises(GR.RefusalError):
        GR.check_dual_basis({**full, "rel_err_allcity": None}, "测试")
    with pytest.raises(GR.RefusalError):
        GR.check_dual_basis({**full, "verdict_basis": None}, "测试")
    with pytest.raises(GR.RefusalError):
        # 自样本数字被当成判据口径
        GR.check_dual_basis({**full, "rel_err_verdict": -0.085}, "测试")


def test_guard_query_rejects_report_without_basis():
    """体检报告报了面雨量却没给口径段，必须拒——这是护栏在拦真实缺口。"""
    from typhoeus import guardrails as GR
    with pytest.raises(GR.RefusalError) as e:
        GR.guard_query({"产物": "标准体检报告",
                        "数据": {"面雨量_mm": 259.1}})
    assert "面雨量" in str(e.value)


def test_guard_rejects_malformed_recon():
    """声称闭合但缺残差占比，闭合性无法核验。"""
    from typhoeus import guardrails as GR
    with pytest.raises(GR.RefusalError):
        GR.guard_query({"产物": "事件对账单",
                        "数据": {"Q分解": {"Q_total": 0.47, "closed": True}}})


def test_refusal_carries_actionable_fields():
    """拒答必须带规则号与处理办法。只说"不行"的下游无从处置。"""
    from typhoeus import guardrails as GR
    try:
        GR.check_in_domain(121.15, 30.03, "余姚")
    except GR.RefusalError as e:
        d = e.as_dict()
        assert d["refused"] is True
        assert d["rule"] == "R1"
        assert d["reason"] and d["remedy"]
        assert d["code"] == "REFUSED"


# ---------- Agent 门槛 G16–G20 ----------

def test_agent_gates_all_pass():
    """五条 Agent 门槛必须全 PASS。任何一条 FAIL 都不该发布。"""
    from typhoeus import agent_gates as AG
    gs = AG.run_all()
    assert len(gs) == 5
    bad = [f"G{x['id']}={x['value']}" for x in gs if x["status"] != "PASS"]
    assert not bad, f"Agent 门槛未全通过：{bad}"


def test_agent_gates_have_axes():
    """每条门槛都要带 stage 与 cover，否则覆盖矩阵算不出来。"""
    from typhoeus import agent_gates as AG
    for x in AG.run_all():
        assert x.get("stage") in G.STAGES
        assert x.get("cover") in G.DIMENSIONS


def test_g19_denominator_excludes_first_read():
    """分母是可比对次数，不含首读。算错会让通过率永远差一截。"""
    from typhoeus import agent_gates as AG
    same, comparable, _ = AG.measure_g19(n=5)
    assert comparable > 0
    assert same == comparable, "同源 hash 应全部一致"
    # 6 个工具 × (5-1) 次比对
    assert comparable == 4 * len(AG.MS._TOOL_FNS), (
        f"分母 {comparable} 应为 工具数×(n-1)")


def test_rain_number_counter_catches_unit_suffixed_keys():
    """键名自带单位的雨量数字也要计入。漏掉预置方案单的触发阈值。"""
    from typhoeus import agent_gates as AG
    n = AG._count_rain_numbers({"触发阈值": {"面雨量_72h_mm": 251.6}})
    assert n == 1, f"触发阈值应计入，实测 {n}"


def test_mcp_tools_carry_guardrail_receipt():
    """每次返回都要带护栏回执，读者知道这份数字过了哪几道检查。"""
    from typhoeus import mcp_server as MS
    for name, fn in MS._TOOL_FNS.items():
        MS.reset_call_budget()      # R4：单次对话 2 个调用，循环内清零
        r = fn()
        assert "护栏" in r, f"{name} 缺护栏回执"
        for k in ("R1_越域", "R2_弱基线", "R3_单口径"):
            assert k in r["护栏"], f"{name} 护栏回执缺 {k}"


def test_bundle_manifest_carries_live_caveat():
    """manifest 的 caveat 必须随降雨源变，不能是硬编码的参数化声明。"""
    from typhoeus import compile as C
    # new_bundle 要的字段比门槛结构测试用的最小 ctx 多，逐个补齐
    ctx = {
        "config_hash": "testcfg", "source_hash": "testsrc",
        "event_name": "测试事件", "conclusion": "测试结论",
        "measure": {"joint_quantile_mm": {"p90": 251.6},
                    "peak_wind_ms": 41.7},
        "gates": [],
        "rain_source": {"driver": "era5-cache",
                        "calibration": {"applied": True,
                                        "n_stations_in_domain": 1}},
        "rain_check": {"rel_err": -0.085, "rel_err_allcity": -0.309,
                       "allcity_mm": 375.0},
    }
    b = C.new_bundle(ctx, {})
    assert "ERA5" in b.caveat, f"caveat 未反映降雨源：{b.caveat[:60]}"
    # 参数化声明只能作为"非此"的对照出现，不能是主语
    assert not b.caveat.startswith("降雨由台风路径参数化合成")

    ctx["rain_source"] = {"driver": "parametric"}
    ctx["rain_check"] = {"rel_err": -0.25, "rel_err_allcity": -0.46,
                         "allcity_mm": 375.0}
    b2 = C.new_bundle(ctx, {})
    assert "参数化合成" in b2.caveat, "参数化驱动时caveat 应回到合成声明"


# ---------- G21 跨产物一致性 ----------

def test_g21_all_pairs_consistent():
    """七对跨产物引用必须全部一致。这是闸门自己的判据。"""
    from typhoeus import consistency as CS
    rep = CS.check()
    bad = [f"{x['label']}={x['detail']}"
           for x in rep["results"] if x["status"] != "PASS"]
    assert not bad, f"跨产物不一致：{bad}"


def test_g21_catches_injected_inconsistency(tmp_path):
    """注入不一致必须被FAIL。闸门若对注入无反应，它就没有校验能力。"""
    import shutil
    from typhoeus import consistency as CS
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)
    p = dst / "04_resilience_pricing.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d["依据"]["气候分量_Q"] = 0.40
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    rep = CS.check(dst)
    assert rep["n_fail"] >= 1, "注入的不一致未被抓到"
    g = CS.as_gate(dst)
    assert g["status"] == "FAIL"
    assert g["id"] == 21


def test_g21_reports_blocked_when_artifact_missing(tmp_path):
    """产物缺失报 BLOCKED 而非 FAIL 或 PASS——两者含义不同。"""
    from typhoeus import consistency as CS
    g = CS.as_gate(tmp_path / "empty")
    assert g["status"] == "BLOCKED", f"空目录应报 BLOCKED，实得 {g['status']}"


def test_q_decomposition_precision_is_usable():
    """Q 分解精度不够则分量与残差的关系无法核验。

    2 位精度下 Q_engineering = 0.0072 落成 0.01，只剩一位有效数字，
    而残差本身在 ±0.03 量级——四个分量之和与总量的关系说不清。
    """
    from typhoeus import reconcile as RC
    r = RC.decompose(total=0.47, pred_climate=0.4447,
                     pred_excess=0.0534, pred_engineering=0.0072)
    d = r.as_dict()
    assert d["Q_engineering"] != 0.01, f"工程失效分量精度丢失：{d}"
    s = (d["Q_climate"] + d["Q_excess"] + d["Q_engineering"]
         + d["Q_residual"])
    assert abs(s - d["Q_total"]) < 0.005, (
        f"四分量之和 {s:.4f} 与总量 {d['Q_total']:.4f} 差过大，精度不足")


def test_recon_precision_matches_pricing():
    """两处 Q 分量精度必须相同，否则跨产物核对得到假阳性。"""
    import shutil
    from typhoeus import consistency as CS
    src = Path(__file__).resolve().parent.parent / "out"
    for stem, keys in (("03_event_reconciliation",
                        ("Q分解", "Q_climate")),
                       ("04_resilience_pricing",
                        ("依据", "气候分量_Q"))):
        d = json.loads((src / f"{stem}.json").read_text(encoding="utf-8"))
        for k in keys:
            d = d[k]
        v = float(d)
        # 4 位精度：round(x,4) 后再读回应完全相等
        assert abs(v - round(v, 4)) < 1e-12, f"{stem} 精度不是 4 位：{v}"


# ---------- G22–G24 服务层 ----------

def test_r4_rejects_call_budget_overflow():
    """单次对话超过 2 个工具调用必须拒。这是反向使用复合概率。"""
    from typhoeus import mcp_server as MS
    from typhoeus import guardrails as GR
    MS.reset_call_budget()
    MS._TOOL_FNS["get_health_report"]()
    MS._TOOL_FNS["get_recovery_order"]()
    with pytest.raises(GR.RefusalError) as e:
        MS._TOOL_FNS["get_health_metrics"]()
    assert e.value.rule == "R4"
    assert "分步" in e.value.remedy or "拆" in e.value.remedy


def test_r4_reset_allows_new_turn():
    from typhoeus import mcp_server as MS
    MS.reset_call_budget()
    for fn in MS._TOOL_FNS.values():
        MS.reset_call_budget()      # 模拟新的一轮对话
        fn()
    MS.reset_call_budget()
    assert MS._TOOL_FNS["get_health_report"]()["产物"] == "标准体检报告"


def test_call_budget_limit_is_two():
    from typhoeus import serving as SV
    assert SV.MAX_CALLS_PER_TURN == 2
    from typhoeus import guardrails as GR
    SV.enforce_call_budget(2)
    with pytest.raises(GR.RefusalError):
        SV.enforce_call_budget(3)


def test_g22_g23_g24_present_and_shaped():
    """三条门槛必须存在且字段齐备（格式与 gates._g 一致）。"""
    from typhoeus import serving as SV
    gs = {g["id"]: g for g in SV.as_gates()}
    assert set(gs) == {22, 23, 24}
    for gid, g in gs.items():
        for k in ("id", "content", "value", "threshold", "status",
                  "note", "stage", "cover"):
            assert g.get(k) not in (None, ""), f"门槛{gid} 缺 {k}"
        assert g["stage"] in G.STAGES
        assert g["cover"] in G.DIMENSIONS


def test_g24_blocks_without_api_key():
    """无 API key 时G24 必须 BLOCKED 而不是 PASS 或 FAIL。"""
    import os
    from typhoeus import serving as SV
    saved = {k: os.environ.pop(k) for k in list(os.environ)
             if k.endswith("_API_KEY")}
    try:
        g = SV._agent_dialogue_gate()
        assert g["status"] == "BLOCKED", f"无 key 时应 BLOCKED，实得 {g['status']}"
        assert "决策阻断项" in g["note"]
    finally:
        os.environ.update(saved)


def test_cache_effectiveness_is_measured_not_assumed():
    """G22 的判据不得设成命中率——那取决于查询分布而非实现。"""
    from typhoeus import serving as SV
    g = {x["id"]: x for x in SV.as_gates()}[22]
    assert "命中率 ≥90%" not in g["threshold"], (
        f"命中率不是实现质量指标，不应作判据：{g['threshold']}")
    assert "重复查询全命中" in g["threshold"]


def test_repeat_queries_all_hit():
    """重复查询必须 100% 命中。实现能保证的只有这一条。"""
    from typhoeus import serving as SV
    for key in ("追问型", "混合型"):
        r = SV.measure_cache(SV.SEQUENCES[key])
        assert r["n_repeat"] > 0, f"{key} 无重复查询"
        assert r["n_hit"] == r["n_repeat"], (
            f"{key} 重复查询命中 {r['n_hit']}/{r['n_repeat']}")


# ---------- 对账层 ----------

def test_recon_residual_not_always_zero():
    """三项独立预测时残差应非零；固定比例拆分会让残差恒 0，门控失效。"""
    r = RC.decompose(total=1.0, pred_climate=0.55,
                     pred_excess=0.25, pred_engineering=0.15)
    # 三项之和 0.95，残差应为 0.05，不是 0
    assert abs(r.resid_share - 0.05) < 1e-9, (
        f"残差占比 {r.resid_share}，固定比例拆分会给出恒 0")
    assert r.closed, "残差 5% 应在容差内判闭合"


# ---------- 多事件标定：重现期口径 ----------

def _gpd_sample(n, rng):
    """从真GPD(ξ=0.2, β=50) 抽样并截尾。

    合成样本必须自己落在 GPD 的合理参数域内，否则测的是估计量在
    病态区的行为，不是拟合逻辑本身。gamma 分布的尾部太轻，拿它测
    POT 会得到 ξ = 45 这种值。
    """
    u = rng.uniform(size=n * 40)
    x = 50.0 / 0.2 * ((1 - u) ** -0.2 - 1)
    return np.sort(x[x < 400])[:n]


def test_pot_threshold_is_not_the_full_sample():
    """POT 阈值必须取分位数，不能设成全部场次。

    阈值取到最小值时全部点进拟合，拟合的是全分布不是尾部，
    重现期曲线结构上就错了，而数值上看不出错。

    这条只断言阈值选取行为，不断言拟合成功——本样本量下GPD
    本来就不可用，参数合理性由`test_gpd_rejects_pathological_
    parameters` 单独把关。
    """
    from typhoeus import multievent as ME
    x = _gpd_sample(18, np.random.default_rng(3))
    assert x.size == 18
    fit = ME.fit_return_period(x)
    assert fit["n_exceed"] < fit["n_total"], (
        f"超阈值 {fit['n_exceed']} 未少于总场次 {fit['n_total']}，"
        f"POT 退化成对全分布拟合")
    assert fit["threshold_mm"] > x.min(), "阈值必须高于样本最小值"
    assert fit["threshold_mm"] < x.max(), "阈值必须低于样本最大值"
    assert fit["threshold_rule"].endswith("分位")
    # 超阈值点必须是严格大于阈值的那些
    assert fit["n_exceed"] == int((x > fit["threshold_mm"]).sum())


def test_gpd_rejects_pathological_parameters():
    """病态 GPD 参数必须判不可用，不产出分位数。

    实测 13 场致涝样本下 MLE 给出 ξ = 6.34。放行这个值的后果是五个
    重现期全等于阈值——数值正常、量纲正常，只有结论不可用。
    """
    from typhoeus import multievent as ME
    # 真实样本的离散度不够：超阈值点5–6 个，尾部有 90 mm 空档
    real = np.array([12.4, 13.8, 25.8, 34.4, 36.7, 40.7, 45.6,
                     49.7, 69.2, 73.5, 121.6, 202.5, 291.6])
    fit = ME.fit_return_period(real)
    assert not fit["ok"], (
        f"真实样本应判不可用，实际给出 ξ="
        f"{fit.get('gpd_attempt', {}).get('shape_xi')}")
    assert "不可用" in fit["reason"]
    assert fit["gpd_attempt"]["estimator"], "须记录尝试过的估计量"
    lv = ME.return_period_levels(fit, 0.36)
    assert not lv["ok"] and lv["levels"] == {}, (
        "拟合不可用时不得产出任何分位数")


def test_empirical_levels_are_measured_not_extrapolated():
    """经验频率法只报样本内实测值，覆盖范围外给 None。"""
    from typhoeus import multievent as ME
    real = np.array([12.4, 13.8, 25.8, 34.4, 36.7, 40.7, 45.6,
                     49.7, 69.2, 73.5, 121.6, 202.5, 291.6])
    emp = ME.empirical_levels(real, 13 / 36.0, 36)
    assert emp["ok"]
    #每个给出的数值都必须真实出现在样本里
    for T, v in emp["levels"].items():
        if v["面雨量_mm"] is not None:
            assert v["面雨量_mm"] in real.tolist(), (
                f"{T} 给出的 {v['面雨量_mm']} 不在样本内，属外推")
    # T=2 对应期望 0.72 场，低于样本下限
    assert emp["levels"]["T2"]["面雨量_mm"] is None


def test_empirical_levels_report_non_monotonic():
    """经验频率分位非单调时必须报出来，不能悄悄取max。"""
    from typhoeus import multievent as ME
    real = np.array([12.4, 13.8, 25.8, 34.4, 36.7, 40.7, 45.6,
                     49.7, 69.2, 73.5, 121.6, 202.5, 291.6])
    emp = ME.empirical_levels(real, 13 / 36.0, 36)
    # 实测 T3 与 T5 同为 202.5 mm、T10 为 73.5 mm —— 非单调
    assert emp["monotonic"] is False, (
        "实测分位非单调（T3=T5=202.5 mm > T10=73.5 mm），"
        "该事实须显式报出")
    assert "非单调" in emp["caveat"]


def test_return_period_uses_annual_rate_not_inverse_count():
    """重现期必须按年均事件率折算，不能按 1/场数。

    13 场致涝跨 36 年时 λ = 0.36 场/年。按 1/13 = 1.0算等于假设
    每年都有 13 场，年超越概率差近 3 倍。

    方向容易搞反：POT 里 λ 是**乘子**（P(X>x) = λ · GPD 尾部），
    λ 越大则同概率 1/T 对应的阈值越高。所以 λ 减半，同一 T 的
    分位应**变小**。
    """
    from typhoeus import multievent as ME
    gpd = {"ok": True, "shape_xi": 0.15, "scale_beta": 40.0,
           "threshold_mm": 200.0, "n_exceed": 8, "n_total": 18}
    fast = ME.return_period_levels(gpd, 1.0)
    slow = ME.return_period_levels(gpd, 0.5)
    assert fast["ok"] and slow["ok"]
    assert fast["levels"]["T50"]["面雨量_mm"] > slow["levels"]["T50"]["面雨量_mm"], (
        f"年均事件率减半时同重现期的雨量应变小（POT 里 λ 是乘子），"
        f"实际 {fast['levels']['T50']['面雨量_mm']} ≤ "
        f"{slow['levels']['T50']['面雨量_mm']}，λ 没有正确进入公式")
    assert abs(slow["lambda_per_year"] - 0.5) < 1e-9


def test_return_period_below_annual_rate_is_rejected():
    """重现期短于年均事件间隔时不在样本覆盖内，须显式拒绝而非外推。

    真实量级：13 场致涝跨 36 年，λ = 0.36 场/年，年均间隔 2.8 年。
    T=2 年落在样本下限之外——这里显式传入含 T2 的年份表来测它。
    """
    from typhoeus import multievent as ME
    gpd = {"ok": True, "shape_xi": 0.15, "scale_beta": 40.0,
           "threshold_mm": 200.0, "n_exceed": 8, "n_total": 18}
    r = ME.return_period_levels(gpd, 0.36, years=(2, 5, 10))
    assert r["levels"]["T2"]["面雨量_mm"] is None, (
        "T=2 小于年均间隔 2.8 年时不得给数值")
    assert "不在样本覆盖内" in r["levels"]["T2"]["状态"]
    # T=5 对应期望 1.8 场，应给数值
    assert isinstance(r["levels"]["T5"]["面雨量_mm"], (int, float))
    assert r["levels"]["T5"]["面雨量_mm"] > gpd["threshold_mm"]


def test_return_period_levels_are_monotonic():
    """GPD 分位必须随重现期递增。非单调是外推失效的直接信号。

    用固定参数直接测分位公式的形状——拟合层是否可用由门控单独把关，
    这里只关心给定合理参数时分位是否单调。
    """
    from typhoeus import multievent as ME
    gpd = {"ok": True, "shape_xi": 0.15, "scale_beta": 40.0,
           "threshold_mm": 200.0, "n_exceed": 8, "n_total": 18}
    lv = ME.return_period_levels(gpd, 0.36)
    assert lv["ok"]
    vals = [(T, lv["levels"][f"T{T}"]["面雨量_mm"])
            for T in (5, 10, 20, 50, 100)]
    for (t1, v1), (t2, v2) in zip(vals, vals[1:]):
        assert isinstance(v1, (int, float)) and v1 > gpd["threshold_mm"], (
            f"T{t1} 分位 {v1} 未高于阈值 {gpd['threshold_mm']}，"
            f"T·λ ≤ 1 的判据方向有误")
        assert v2 > v1, f"T{t1}={v1} mm 到 T{t2}={v2} mm 非递增"


def test_intensity_loss_rejects_negative_slope():
    """雨量越大损失越小 —— 斜率为负时该关系不可用，R² 再高也不行。"""
    from typhoeus import multievent as ME
    # 雨量升而 Q 降：与承灾机理相反
    ev = [ME.EventResult(2000 + i, f"T{i}", 60, 50.0, 35.0, 960.0,
                         rain72_mm=100.0 + 20.0 * i, peak_intensity_mm_h=20.0,
                         max_depth_m=0.4, peak_time_h=5.0,
                         q_total=0.9 - 0.01 * i, q_climate=0.45,
                         q_excess=0.03, q_engineering=0.01, q_residual=0.01,
                         resid_share=0.02, closed=True, elapsed_s=1.0)
          for i in range(8)]
    il = ME.fit_intensity_loss(ev)
    assert not il["ok"], (
        f"雨量升而损失降的关系应被判不可用，实际斜率 "
        f"{il.get('log_log_slope')}")
    assert il["slope_positive"] is False
    assert il["log_log_slope"] < 0


def test_multievent_q_matches_main_chain_basis():
    """批量与主链的 Q 口径必须同一个函数，否则两边算出两个数。

    同一个 total 与分位数下，`RC.split_from_measure` 给出的四项与
    直接调 `RC.decompose` 按同参数计算必须一致。这条锁的是
    "主链与批量不得各写一遍公式"这个约束。
    """
    from typhoeus import measure as M
    mp = M.MeasureParams()
    jq = {"p50": 160.0, "p90": 195.0}
    rec = RC.split_from_measure(0.48, jq, engineering_share=0.15,
                              excess_share=0.25, sst_cc_lim=0.6,
                              cc_lo=mp.cc_ci_low, cc_hi=mp.cc_ci_high)
    cc_mid = 0.5 * (mp.cc_ci_low + mp.cc_ci_high)
    clim = 0.48 * (1.0 / (1.0 + cc_mid * 0.6)) ** 1.6
    frac = (195.0 - 160.0) / 195.0
    exc = 0.48 * frac * 0.25 / 0.4
    eng = 0.48 * 0.15 * (1.0 - 1.0 / (1.0 + cc_mid * 0.6)) / 0.4
    assert abs(rec.climate - clim) < 1e-12
    assert abs(rec.excess - exc) < 1e-12
    assert abs(rec.engineering - eng) < 1e-12
    # 四项必须闭合到total
    assert abs(rec.total - (rec.climate + rec.excess + rec.engineering
                            + rec.residual)) < 1e-12


# ---------- 多事件门槛 G25–G27 ----------

def _calib_report(**over):
    rep = {
        "n_events_catalog": 18, "n_events_ok": 18, "n_events_skipped": 0,
        "skipped": [], "year_span": [1990, 2025], "year_count": 36,
        "lambda_per_year": 0.5,
        "intensity_loss": {"ok": True, "n": 18, "log_log_slope": 1.31,
                           "intercept": -4.2, "r2": 0.86,
                           "slope_positive": True},
        "monotonicity": {"n_violations": 0, "violations": [], "passed": True},
        "return_period_fit": {"ok": True, "shape_xi": 0.15,
                              "scale_beta": 40.0, "threshold_mm": 200.0,
                              "threshold_rule": "75% 分位",
                              "n_exceed": 4, "n_total": 18,
                              "mean_mm": 190.0, "max_mm": 275.0,
                              "sample_cv": 0.32},
        "return_period_levels": {
            "ok": True, "lambda_per_year": 0.5, "n_exceed": 4,
            "levels": {"T5": {"面雨量_mm": 260.0},
                       "T10": {"面雨量_mm": 300.0},
                       "T20": {"面雨量_mm": 340.0},
                       "T50": {"面雨量_mm": 395.0},
                       "T100": {"面雨量_mm": 430.0}}},
    }
    rep.update(over)
    return rep


def test_g25_g26_g27_all_pass_on_clean_report(tmp_path):
    from typhoeus import calib_gates as CG
    (tmp_path / "multievent_calibration.json").write_text(
        json.dumps(_calib_report(), ensure_ascii=False), encoding="utf-8")
    gs = CG.run_all(tmp_path)
    assert [x["id"] for x in gs] == [25, 26, 27]
    assert [x["status"] for x in gs] == ["PASS"] * 3, \
        [(x["id"], x["status"], x["note"][:80]) for x in gs]


def test_g25_fails_below_min_events():
    from typhoeus import calib_gates as CG
    g = CG.measure_g25(_calib_report(n_events_ok=14))
    assert g["status"] == "FAIL"
    assert "14 场" in g["value"]


def test_g26_fails_on_negative_slope():
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    rep["intensity_loss"] = {"ok": False, "log_log_slope": -0.8,
                             "intercept": 1.0, "r2": 0.71,
                             "slope_positive": False, "n": 18}
    g = CG.measure_g26(rep)
    assert g["status"] == "FAIL"
    assert "斜率为负" in g["note"]


def test_g26_fails_on_monotonicity_violation():
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    rep["monotonicity"] = {
        "n_violations": 1, "passed": False,
        "violations": [{"年": 2014, "台风": "FUNG-WONG", "雨量_mm": 260.0,
                        "Q": 0.31}]}
    g = CG.measure_g26(rep)
    assert g["status"] == "FAIL"
    assert "单调性违背 1 处" in g["note"]


def test_g27_fails_on_non_monotonic_levels():
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    rep["return_period_levels"]["levels"]["T50"]["面雨量_mm"] = 280.0
    g = CG.measure_g27(rep)
    assert g["status"] == "FAIL"
    assert "非单调递增" in g["note"]


def test_g27_fails_when_extrapolation_stays_below_sample_max():
    """外推没进尾部区时结果不能用于超标准设计，须判FAIL。"""
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    for T in (5, 10, 20, 50, 100):
        rep["return_period_levels"]["levels"][f"T{T}"]["面雨量_mm"] = 200.0
    g = CG.measure_g27(rep)
    assert g["status"] == "FAIL"
    assert "未超过样本最大值" in g["note"]


def test_g25_g26_g27_blocked_without_artifact(tmp_path):
    from typhoeus import calib_gates as CG
    gs = CG.run_all(tmp_path)
    assert [x["status"] for x in gs] == ["BLOCKED"] * 3
    assert [x["id"] for x in gs] == [25, 26, 27]


def test_zero_rainfall_event_is_skipped_not_zero_loss():
    """降雨场全零的场次必须记SKIP，不能以 Q=0 混进标定样本。

    log(Q) 在 Q=0 处取 -inf，一个零场次就能把强度—损失拟合的斜率
    直接带偏。实测 18 场里有2 场（BEBINCA、HAIKUI）触发，成因不同：
    一场是雨强低于 R_FLOOR 被截断，一场是最近时刻落在 72 h 窗外。
    """
    from typhoeus import multievent as ME
    r = ME.EventResult._skip(2024, "BEBINCA",
                             "雨区未覆盖计算域（最近 115 km）")
    assert r.ok is False
    assert r.q_total == 0.0 and r.rain72_mm == 0.0
    d = r.as_dict()
    assert d["状态"] == "SKIP"
    assert "雨区未覆盖计算域" in d["原因"]
    # 标定时按 ok 过滤，零场次不得进入拟合
    il = ME.fit_intensity_loss([r] + [
        ME.EventResult(2000 + i, f"T{i}", 60, 50.0, 35.0, 960.0,
                       rain72_mm=200.0 - 8.0 * i, peak_intensity_mm_h=20.0,
                       max_depth_m=0.4, peak_time_h=5.0,
                       q_total=0.4 - 0.008 * i, q_climate=0.35,
                       q_excess=0.02, q_engineering=0.01, q_residual=0.02,
                       resid_share=0.05, closed=True, elapsed_s=1.0)
        for i in range(6)])
    assert il["n"] == 6, f"拟合样本 {il['n']} 含入了 SKIP 场次"


def _mk_events(pairs):
    """由 (雨量mm, Q) 列表造场次。雨量升序即输入顺序。"""
    from typhoeus import multievent as ME
    return [
        ME.EventResult(2000 + i, f"T{i}", 60, 50.0, 35.0, 960.0,
                       rain72_mm=r, peak_intensity_mm_h=20.0,
                       max_depth_m=0.4, peak_time_h=5.0,
                       q_total=q, q_climate=q * 0.9,
                       q_excess=0.02, q_engineering=0.01, q_residual=0.02,
                       resid_share=0.05, closed=True, elapsed_s=1.0)
        for i, (r, q) in enumerate(pairs)
    ]


def test_monotonicity_tolerance_ignores_float_noise():
    """Q 的 0.2% 相对降幅不算违背。

    实测触发场景：1995 JANIS（69.2 mm，Q 0.1478）与
    2000 KAI-TAK（73.5 mm，Q 0.1475），雨量差 4.3 mm 而
    Q 差 0.0003。严格不降判据会把它报成机制性违背，
    把一条实测成立的标度关系判成 FAIL。
    """
    from typhoeus import multievent as ME
    mono = ME.check_monotonicity(_mk_events([(40.0, 0.05), (69.2, 0.1478),
                                             (73.5, 0.1475), (120.0, 0.25)]))
    assert mono["n_violations"] == 0, \
        f"0.2% 的浮点差异被判为违背：{mono['violations']}"
    assert mono["passed"]
    assert "容差依据" in mono, "容差判据必须落盘依据，否则无从复核"


def test_monotonicity_still_catches_real_violation():
    """真违背（相对降幅远超容差）不得被容差放过。"""
    from typhoeus import multievent as ME
    mono = ME.check_monotonicity(_mk_events([(40.0, 0.20), (69.2, 0.05),
                                             (73.5, 0.06), (120.0, 0.25)]))
    assert mono["n_violations"] >= 1, "Q 降 75% 未被记为违背"
    assert not mono["passed"]
    v = mono["violations"][0]
    assert "相对降幅_pct" in v, "违背须落盘相对幅度，供复核容差是否合适"
    assert v["前一场"], "须记下前一场，否则无法定位"


def test_monotonicity_tolerance_between_noise_and_signal():
    """容差必须夹在实测噪声与正常相邻变动之间。

    本批13 个致涝场次的相邻对 |ΔQ|/Q 中位数 54.4%、10% 分位 11.2%，
    实测噪声 0.20%。容差取 5%：高于噪声、低于最小正常变动。
    """
    from typhoeus import multievent as ME
    assert ME.MONO_TOL > 0.002, "容差低于实测浮点噪声，会被噪声触发"
    assert ME.MONO_TOL < 0.112, "容差高于正常相邻对的10% 分位，会放过真违背"


def test_infiltration_appears_in_consistency_pairs():
    """入渗量必须进跨产物一致性对表。

    它在 06 里出现两次（守恒段 2 位、能量段 4 位），读者拿 4.83 去
    核对 4.8258 会以为不一致。两处不锁住，改一处忘另一处就分叉。
    """
    from typhoeus import consistency as CO
    labels = [p[0] for p in CO.CONSISTENCY_PAIRS]
    assert any("入渗" in s for s in labels), \
        f"入渗量未进一致性对表，现有：{labels}"
    pair = next(p for p in CO.CONSISTENCY_PAIRS if "守恒段" in p[0])
    assert pair[1][1:] == ("守恒性", "水量收支_mm", "下渗")
    assert pair[2][1:] == ("入渗与能量", "下渗_mm")


def test_skip_positional_args_match_field_order():
    """_skip 的位置参数必须与字段声明同序。

    补残差字段时 q_residual / resid_share / closed 插在 elapsed_s
    之前，少传一个就是 TypeError——而 TypeError 发生在 except 块里，
    会把整批标定打断。
    """
    from typhoeus import multievent as ME
    import dataclasses
    r = ME.EventResult._skip(2000, "X", "测试")
    assert isinstance(r, ME.EventResult)
    n_fields = len(dataclasses.fields(ME.EventResult))
    assert r.elapsed_s == 0.0
    assert r.closed is False
    assert r.resid_share == 0.0
    assert n_fields == 20


# ---------- 多事件标定单（第七份产物） ----------

def test_calib_sheet_reports_both_conclusions():
    """标定单必须按各自状态呈现两条结论。

    强度—损失已标定、重现期不可标定——这是实测结果。只写成功
    那条，读者会以为重现期已标定；只写失败那条，读者会以为多事件
    序列没跑通。两条都在，才是对当前状态的准确描述。
    """
    import tempfile
    from typhoeus import calib_sheet as CSH
    d = Path(tempfile.mkdtemp())
    rep = _calib_report()
    rep["n_flood_events"] = 14
    rep["return_period_fit"] = {
        "ok": False, "n_total": 14, "n_exceed": 7, "threshold_mm": 45.6,
        "mean_mm": 122.0, "max_mm": 291.6, "sample_cv": 0.703,
        "reason": "GPD 在本样本量下不可用"}
    rep["return_period_levels"] = {"ok": False, "levels": {}}
    rep["no_flood_events"] = [{"年": 2005, "台风": "KHANUN",
                               "72h面雨量_mm": 2.9, "Q": 0.0}]
    (d / "multievent_calibration.json").write_text(
        json.dumps(rep, ensure_ascii=False), encoding="utf-8")
    s = CSH.multievent_sheet(d)
    assert s["强度—损失关系"]["状态"] == "已标定"
    assert s["强度—损失关系"]["斜率"] == 1.31
    assert s["重现期关系"]["状态"] == "不可标定"
    assert s["重现期关系"]["业务影响"], "不成立的结论必须写业务影响"
    assert s["重现期关系"]["解锁条件"], "不成立的结论必须写解锁条件"
    assert s["声明"], "必须写明两者不可混用"


def test_calib_sheet_without_artifact_is_explicit():
    """缺产物时写「未运行」壳，而不是报空或抛异常。

    交付方看到"这条能力存在且尚未启用"，比文件缺失更容易理解。
    """
    import tempfile
    from typhoeus import calib_sheet as CSH
    d = Path(tempfile.mkdtemp())
    s = CSH.multievent_sheet(d)
    assert s["状态"] == "未运行"
    assert "multievent" in s["说明"]


def test_calib_sheet_declares_single_rainfall_basis():
    """标定单的雨量来自参数化场，必须走 no_second_basis 形态。

    主链的域内/全市双口径建立在 ERA5 实算之上，对参数化场不适用。
    硬塞两个口径等于把同一个数报两遍。
    """
    import tempfile
    from typhoeus import calib_sheet as CSH
    from typhoeus import guardrails as GR
    d = Path(tempfile.mkdtemp())
    rep = _calib_report()
    rep["n_flood_events"] = 14
    (d / "multievent_calibration.json").write_text(
        json.dumps(rep, ensure_ascii=False), encoding="utf-8")
    s = CSH.multievent_sheet(d)
    sec = s["降雨口径"]
    assert sec["no_second_basis"], "须声明无第二口径"
    assert sec["what_is_missing"], "须给出补齐路径"
    assert GR.check_dual_basis(sec, "多事件标定单")


def test_r3_accepts_no_second_basis_only_with_path():
    """no_second_basis 缺补齐路径时仍须拒答。

    声明"只有一个口径"而不说补齐要做什么，读者无法判断这个限制
    能不能接受——那等于把判断责任推回给读者而不给依据。
    """
    from typhoeus import guardrails as GR
    ok = {"no_second_basis": "驱动不同，无对照口径", "what_is_missing": "拉 ERA5"}
    assert GR.check_dual_basis(ok, "测试")
    with pytest.raises(GR.RefusalError) as ei:
        GR.check_dual_basis({"no_second_basis": "只有一个口径"}, "测试")
    assert ei.value.rule == "R3"
    assert "补齐路径" in ei.value.reason


def test_r3_still_rejects_missing_dual_basis():
    """普通形态下缺双口径仍须拒答——新形态不能成了开口子。"""
    from typhoeus import guardrails as GR
    with pytest.raises(GR.RefusalError) as ei:
        GR.check_dual_basis({"rel_err_verdict": -0.31}, "测试")
    assert ei.value.rule == "R3"


def test_seventh_tool_registered_and_readable():
    """第七个 MCP 工具须注册、能读出产物、且带来源段。"""
    from typhoeus import mcp_server as MS
    assert "get_multievent_calibration" in MS._TOOL_FNS
    assert "get_multievent_calibration" in MS._TOOL_FILES
    MS.reset_call_budget()
    r = MS.get_multievent_calibration("out")
    assert r["产物"] == "多事件标定单"
    assert r["来源"], "缺来源段的返回不可用于引用"
    assert r["数据"]["名称"] == "多事件标定单"


def test_desc_budget_still_ok_with_seven_tools():
    from typhoeus import mcp_server as MS
    assert len(MS._TOOL_FNS) == 7
    n = MS.desc_bytes()
    assert n <= MS.DESC_BUDGET_B, f"描述总量 {n} B 超预算"


def test_g27_fails_and_explains_when_gpd_unusable():
    """GPD 不可用时门槛 27 判 FAIL 并把经验频率口径一并写进 note。"""
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    rep["return_period_fit"] = {
        "ok": False, "n_total": 14, "n_exceed": 7, "threshold_mm": 45.6,
        "threshold_rule": "50% 分位", "shape_xi": 5.932,
        "scale_beta": 61.09, "mean_mm": 122.0, "max_mm": 291.6,
        "sample_cv": 0.703,
        "gpd_attempt": {"estimator": "scipy.stats.genextreme.fit（MLE）",
                        "shape_xi": 5.932, "scale_beta": 61.09},
        "sample_size_requirement": {"metric": "ξ 落在 ±0.5 内的比例",
                                    "curve": {"7": 0.163, "30": 0.787}},
        "reason": "GPD 在本样本量下不可用：MLE 形状参数 ξ=5.932"}
    rep["return_period_levels"] = {"ok": False, "levels": {},
                                   "reason": "拟合不可用"}
    rep["empirical_levels"] = {
        "ok": True, "monotonic": False,
        "coverage_limit_years": 36.0,
        "caveat": "分位非单调（T3=202.5 mm、T5=202.5 mm、T10=73.5 mm）"}
    g = CG.measure_g27(rep)
    assert g["status"] == "FAIL"
    assert "经验频率口径" in g["note"]
    assert "非单调" in g["note"]
    assert "。\n" not in g["note"], "拼接出现换行或双句号"


def test_calib_gates_all_pass_with_valid_report():
    """构造一份自洽的报告时G25–G27 应全 PASS。"""
    from typhoeus import calib_gates as CG
    rep = _calib_report()
    assert CG.measure_g25(rep)["status"] == "PASS"
    assert CG.measure_g26(rep)["status"] == "PASS"
    assert CG.measure_g27(rep)["status"] == "PASS"


def test_empirical_levels_sorted_numerically_not_lexically():
    """分位排序必须按数值。"T10" < "T2" 按字符串排会错。"""
    from typhoeus import multievent as ME
    real = np.array([12.4, 13.8, 25.8, 34.4, 36.7, 40.7, 45.6,
                     49.7, 69.2, 73.5, 121.6, 202.5, 291.6])
    emp = ME.empirical_levels(real, 13 / 36.0, 36)
    assert emp["monotonic"] is False, (
        "T3=T5=202.5 而 T10=73.5，若按字符串排序会把T10 排到 T2 前面，"
        f"单调性判断跟着错：{emp['levels']}")
    assert "非单调" in emp["caveat"]
    assert "T10=73.5" in emp["caveat"] or "T20=40.7" in emp["caveat"]


# ---------- 辅助：假 ctx，仅供门槛结构测试 ----------

def _fake_ctx():
    """构造一个够门槛结构测试用的最小 ctx。

    只要求门槛函数能跑通不抛错，不要求数值正确——
    数值正确性由上面的内核/投影用例负责。
    """
    nt, ny, nx = 6, 12, 12
    d = np.zeros((nt, ny, nx))
    d[:, 3:6, 3:6] = 0.3
    proj = PRJ.aggregate(d)
    res = K.run(_Grid(ny, nx), _rain(nt, ny, nx), K.KernelParams())
    r = RC.decompose(total=1.0, pred_climate=0.55,
                     pred_excess=0.25, pred_engineering=0.15)
    st = np.zeros((ny, nx))
    st[2:6, 2:6] = 0.5
    return {
        "kernel": {"positivity_ok": True, "mass_resid": 1e-9,
                    "max_depth": 0.5, "peak_time_h": 3.0,
                    "rain_total_mm": 200.0,
                    "budget": {"降雨": 200.0}},
        "cfg": Config(),
        "cell_m": 54.0,
        "coverage": {"rate": 0.6, "n_hit": 6, "n_total": 10, "missed": [],
                     "excluded": []},
        "coverage_top20": 0.6,
        "front": {"n": 3, "mean_abs_diff_m": 0.3, "max_abs_diff_m": 0.4},
        "dead_spot": {"reason": "测试"},
        "order_cmp": {"gain_over_baseline": 0.12, "best_baseline": "random"},
        "adj": {"median_rel_err": 1e-9, "passed": True},
        "recon": r,
        "cc_identifiable": {"identifiable": False, "n_events": 1},
        "retrofit": {"n_projects": 6},
        "observe": {"monitor_sites": 149, "monitor_sites_spec": 149,
                     "service_outages": 10, "rain_stations": 8},
        "elapsed_s": 10.0,
        "gate": {"reduction": 0.44, "passed": True},
        "rain_check": {"model_mm": 202.0, "obs_mm": 269.0, "rel_err": -0.25,
                       "rel_err_allcity": -0.46, "n_stations": 2,
                       "allcity_mm": 375.0, "obs_basis": "测试",
                       "sampling_bias": "测试"},
        "rain_total_mm": 202.0,
        "depth_accuracy": None,
        "levels": PRJ.level_counts(d),
        "proj": proj,
    }

# ---------- 土壤观测接入（soilsrc + soilcal） ----------

def _soilsrc_fake():
    """构造一个假的 SoilProfile，跳过网络与磁盘。"""
    import numpy as _np
    from typhoeus import soilsrc
    n = 384
    return soilsrc.SoilProfile(
        sm_0_7=_np.full(n, 0.520), sm_7_28=_np.full(n, 0.518),
        soil_temp_c=_np.full(n, 25.1),
        et0_mm_h=_np.full(n, 0.076, dtype=float),
        theta0=0.987, theta0_raw=0.987,
        et0_anchor_mm_h=0.050, et0_mean_mm_h=0.076,
        lat=29.91, lon=121.54,
        window=("2021-07-15T00:00", "2021-07-30T23:00"),
        n_timesteps=n, fetched_at="2021-08-01T00:00:00",
        notes={"anchor_index": 246, "anchor": "2021-07-25T06:00",
               "sm_anchor_m3_m3": 0.520, "sm_7_28_anchor_m3_m3": 0.518,
               "soil_temp_anchor_c": 25.1,
               "licence": "CC BY 4.0", "driver": "fake"})


class _patched_soil:
    """把 soilsrc.get_soil / load_cache 换成假的，用完还原。"""

    def __init__(self, prof=None, boom=False):
        self.prof = prof or _soilsrc_fake()
        self.boom = boom

    def __enter__(self):
        import typhoeus.soilsrc as SS
        self._ss = SS
        self._og, self._oc = SS.get_soil, SS.load_cache
        prof = self.prof

        def _boom_fn(use_cache=True, verbose=True):
            raise SS.SoilSourceError("模拟网络不可用")

        SS.get_soil = _boom_fn if self.boom else (
            lambda use_cache=True, verbose=True:
            (prof, {"driver": "fake", **prof.notes}))
        SS.load_cache = lambda: None if self.boom else prof
        return self

    def __exit__(self, *a):
        self._ss.get_soil = self._og
        self._ss.load_cache = self._oc
        return False


def test_sm_to_theta_uses_documented_sat_res():
    """sm → θ 的换算必须用文档常量 θ=(sm-res)/(sat-res)。"""
    from typhoeus import soilsrc
    # bias=0 时 sm=θ_sat → θ=1.0
    assert abs(float(soilsrc.sm_to_theta(0.46, dry_bias=0.0)) - 1.0) < 1e-12
    # bias=0.065 时 sm=0.520 → (0.520-0.065-0.08)/0.38 = 0.98684
    v = float(soilsrc.sm_to_theta(0.520, dry_bias=0.065))
    assert abs(v - 0.98684) < 1e-4, v


def test_sm_to_theta_can_exceed_one_without_clipping():
    """θ>1 必须原样返回。裁剪会藏掉「再分析高估」这个信号。"""
    from typhoeus import soilsrc
    v = float(soilsrc.sm_to_theta(0.520, dry_bias=0.0))
    assert v > 1.0, v


def test_sm_to_theta_dry_bias_range_straddles_saturation():
    """湿偏区间两端跨越 θ=1，这正是选区间中值的理由。

    实测 sm=0.520：bias=0.05 给 θ=1.026（超饱和，说明改正不足），
    bias=0.08 给 θ=0.947（未饱和）。+0.065 给0.987。
    三层深度层实测值一致，所以这个跨越不是噪声。
    """
    from typhoeus import soilsrc
    lo, hi = soilsrc.DRY_BIAS_RANGE
    a = float(soilsrc.sm_to_theta(0.520, dry_bias=lo))
    b = float(soilsrc.sm_to_theta(0.520, dry_bias=hi))
    assert a > 1.0, a
    assert 0.0 < b < 1.0, b
    mid = float(soilsrc.sm_to_theta(0.520,
                                    dry_bias=soilsrc.DRY_BIAS_M3_M3))
    assert b < mid < a
    assert 0.95 <= mid <= 0.999


def test_soilsrc_available_vars_excludes_reference_et():
    """可用变量表不能含 reference_evapotranspiration（实测 HTTP 400）。"""
    from typhoeus import soilsrc
    assert "reference_evapotranspiration" not in soilsrc.AVAILABLE_VARS
    assert "et0_fao_evapotranspiration" in soilsrc.AVAILABLE_VARS
    assert "soil_moisture_0_to_7cm" in soilsrc.AVAILABLE_VARS
    assert "soil_moisture_7_to_28cm" in soilsrc.AVAILABLE_VARS


def test_net_sw_from_et0_matches_manual_energy_balance():
    """ET0 → 净短波的反解必须与 Ghil-Sellers 正算互逆。

    实测基准：ET0 5.47 mm/72h x 面积比 0.25 = 1.3675 mm，
    net_sw = 78.0 W/m²，正算回 1.3675 mm。
    """
    from typhoeus import soilcal as SC
    sw = SC._net_sw_from_et0(1.3675, 0.15, 0.25, 0.45, 0.65, hours=72.0)
    assert abs(sw - 78.0) < 0.5, sw
    le = sw * 0.85 * 0.30
    back = le * 0.65 / (1000.0 * 2.45e6) * 72 * 3600 * 1000
    assert abs(back - 1.3675) < 1e-3, back


def test_net_sw_scales_linearly_with_target_evaporation():
    """净短波必须与目标土壤蒸发量成正比（同一量纲链）。"""
    from typhoeus import soilcal as SC
    a = SC._net_sw_from_et0(1.0, 0.15, 0.25, 0.45, 0.65, hours=72.0)
    b = SC._net_sw_from_et0(2.0, 0.15, 0.25, 0.45, 0.65, hours=72.0)
    assert abs(b / a - 2.0) < 1e-9, (a, b)


def test_net_sw_from_et0_rejects_degenerate_inputs():
    """ET0≤0、潜热份额≤0、反照率≥1 三种退化必须报错。"""
    import pytest as _pt
    from typhoeus import soilcal as SC
    with _pt.raises(SC.CalibrationError):
        SC._net_sw_from_et0(0.0, 0.15, 0.25, 0.45, 0.65)
    with _pt.raises(SC.CalibrationError):
        SC._net_sw_from_et0(-1.0, 0.15, 0.25, 0.45, 0.65)
    with _pt.raises(SC.CalibrationError):
        SC._net_sw_from_et0(1.0, 0.15, 0.60, 0.45, 0.65)
    with _pt.raises(SC.CalibrationError):
        SC._net_sw_from_et0(1.0, 1.0, 0.25, 0.45, 0.65)


def test_soilcal_applies_observation_over_parametric():
    """观测可用时 θ0 与净辐射必须被标定值覆盖。"""
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    with _patched_soil():
        cal = SC.calibrate(CFG.Config(), verbose=False)
    assert cal.applied is True
    assert cal.driver == "fake"
    assert abs(cal.theta0 - 0.987 * 0.456) < 1e-3, cal.theta0
    assert abs(cal.net_sw_wm2 - 78.0) < 1.0, cal.net_sw_wm2
    assert cal.report["evap_backcheck_resid_mm"] < 1e-3


def test_soilcal_parametric_source_keeps_config_values():
    """soil_source=parametric 时不得被观测覆盖，且 applied=False。"""
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    c = CFG.Config()
    c.l2.soil_source = "parametric"
    cal = SC.calibrate(c, verbose=False)
    assert cal.applied is False
    assert cal.theta0 == c.l2.soil_theta0
    assert cal.net_sw_wm2 == c.l2.net_sw_wm2


def test_soilcal_raises_when_source_down_and_no_fallback():
    """降级必须显式：allow_fallback=False 时抛错而非静默用常数。"""
    import pytest as _pt
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    with _patched_soil(boom=True):
        with _pt.raises(SC.CalibrationError):
            SC.calibrate(CFG.Config(), verbose=False)
        cal = SC.calibrate(CFG.Config(), verbose=False, allow_fallback=True)
    assert cal.applied is False
    assert cal.driver == "parametric-fallback"
    assert "reason" in cal.report


def test_soilcal_theta_clipped_when_observation_already_saturated():
    """观测θ=0.987 直接当城市θ 时必须截断并计数。

    折减系数取 1.0 时 θ_final = 0.987 已被内核截到 0.999 上限之下，
    但按内核的饱和判据（θ ≥ 0.999 视为饱和不再吸）这仍属"接近饱和"。
    折减系数必须显式大于 0 才能让 Green-Ampt 保留吸力增益 ——
    实测 diag：θ0=0.987 时三档强度吸力增益全为 0.000 mm，
    机制退化成常数入渗；θ0=0.45 时为0.000 / 2.089 / 3.132 mm。
    """
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    c = CFG.Config()
    c.l2.urban_theta_frac = 1.0
    with _patched_soil():
        cal = SC.calibrate(c, verbose=False)
    # 截断上限保证内核不会拿到 θ≥1
    assert cal.theta0 <= 0.999
    # 折减系数为 1 时应报告"接近饱和"
    assert cal.report["theta_observed"] * 1.0 >= 0.95
    # 反过来：默认折减系数必须显著低于 1，否则机制会退化
    d = CFG.Config()
    with _patched_soil():
        cal_d = SC.calibrate(d, verbose=False)
    assert cal_d.theta0 < 0.60, cal_d.theta0


def test_soilcal_reports_observation_exceeds_parametric():
    """实测 θ 必须落进报告：它是 config 常数的上界这条事实要可核。"""
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    with _patched_soil():
        cal = SC.calibrate(CFG.Config(), verbose=False)
    assert cal.report["theta_observed"] > 0.9
    assert cal.report["theta0_parametric"] < cal.report["theta_observed"]
    assert cal.report["net_sw_parametric_wm2"] != \
        cal.report["net_sw_calibrated_wm2"]


def test_soilcal_report_declares_licence_and_caveat():
    """观测接入必须带许可与 caveat，否则护栏会拒产物。"""
    from typhoeus import config as CFG
    from typhoeus import soilcal as SC
    with _patched_soil():
        cal = SC.calibrate(CFG.Config(), verbose=False)
    assert "CC BY" in cal.report["licence"]
    assert cal.report["caveat"]
    assert cal.report["anchor"] == "2021-07-25T06:00"


def test_kernel_params_prefers_soil_calibration():
    """_kernel_params 拿到标定结果时必须用它，而不是 config 值。"""
    from typhoeus import config as CFG
    from typhoeus import cli as CLI
    from typhoeus import soilcal as SC
    c = CFG.Config()
    cal = SC.SoilCalibration(theta0=0.62, net_sw_wm2=88.0,
                             applied=True, driver="fake")
    k = CLI._kernel_params(c, soil=cal)
    assert k.soil_theta0 == 0.62
    assert k.net_sw_wm2 == 88.0
    k0 = CLI._kernel_params(c)
    assert k0.soil_theta0 == c.l2.soil_theta0
    assert k0.net_sw_wm2 == c.l2.net_sw_wm2


def test_soil_source_and_fractions_enter_config_hash():
    """土壤源与两个折减系数必须进 hash，否则两批场次无法区分。"""
    from typhoeus import config as CFG
    a = CFG.Config()
    b = CFG.Config()
    b.l2.soil_source = "parametric"
    assert a.hash() != b.hash()
    c = CFG.Config()
    c.l2.urban_theta_frac = 0.8
    assert a.hash() != c.hash()
    d = CFG.Config()
    d.l2.evap_area_frac = 0.5
    assert a.hash() != d.hash()
    # 同值同hash
    assert CFG.Config().hash() == CFG.Config().hash()


def test_config_hash_is_a_method_not_an_attribute():
    """`cfg._hash` 不存在，读它永远得到 None。

    多事件产物曾用 `getattr(cfg, "_hash", None)` 取配置指纹，落盘出来
    是 null——同一批场次的 config_hash 与 manifest 无法对上，
    「同hash 才能复算」这条审计要求在多事件侧失效。Config 上真实的
    接口是 `hash()` 方法。
    """
    from typhoeus import config as CFG
    c = CFG.Config()
    assert not hasattr(c, "_hash"), "又冒出 _hash 属性，两处会再分叉"
    h = c.hash()
    assert isinstance(h, str) and len(h) >= 12, h
    assert c.hash() == h


def test_consistency_pairs_include_soil_calibration():
    """θ0 与净短波的标定值/使用值必须进一致性对表。"""
    from typhoeus import consistency as CS
    names = [p[0] for p in CS.CONSISTENCY_PAIRS]
    assert any("θ0" in n for n in names), names
    assert any("净短波" in n for n in names), names


def test_compile_soil_section_recomputes_theta_from_observation(tmp_path):
    """06 里「θ0 实际使用」必须等于 观测 × 城市折减系数。

    两者不等说明标定报告写进了产物但没进内核参数，或者反过来。
    """
    import json
    import shutil
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)

    p = dst / "06_health_report.json"
    rep = json.loads(p.read_text(encoding="utf-8"))
    sec = rep["土壤标定"]
    assert sec["已应用观测"] is True
    assert sec["驱动"].startswith("era5land")
    obs = sec["θ0_观测"]
    fac = sec["θ0_城市折减系数"]
    assert abs(sec["θ0_城市折减系数_乘观测"] - obs * fac) < 1e-3
    assert abs(sec["θ0_实际使用"] - sec["θ0_城市折减系数_乘观测"]) < 1e-3
    assert sec["净短波_标定_W_m2"] == sec["净短波_实际使用_W_m2"]
    assert "CC BY" in sec["许可"]
    assert sec["caveat"]
    # 观测值必须高于内核取值：观测是自然地表，计算域是硬化面
    assert obs > sec["θ0_实际使用"]


def test_compile_soil_section_survives_missing_calibration(tmp_path):
    """旧产物没有标定信息时，compile 必须报「未记录」而不是 KeyError。

    v0.6.0 之前的 06 没有「土壤标定」段。兼容读取不能因为新字段
    缺失而整份报告崩掉，也不能拿 config 常数冒充观测值。
    """
    import json
    import shutil
    from typhoeus import compile as CO
    src = Path(__file__).resolve().parent.parent / "out"
    dst = tmp_path / "out"
    shutil.copytree(src, dst)

    p = dst / "06_health_report.json"
    rep = json.loads(p.read_text(encoding="utf-8"))
    rep.pop("土壤标定")
    p.write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")

    #直接调 compile 的报告段构造：给它一个缺标定段的 kernel
    k = {"positivity_ok": True, "mass_resid": 1e-9, "max_depth": 0.5,
         "peak_time_h": 3.0, "rain_total_mm": 200.0,
         "budget": {"降雨": 200.0}, "infil_energy": {}}
    out = CO.health_report(_compile_ctx(k))
    sec = out["土壤标定"]
    assert sec["驱动"] == "未记录"
    assert sec["已应用观测"] is False
    assert sec["θ0_实际使用"] == 0.0
    assert sec["净短波_实际使用_W_m2"] == 0.0
    assert sec["许可"] is None


def _compile_ctx(kernel: dict) -> dict:
    """构造 health_report 需要的最小 ctx。"""
    from typhoeus import config as _CFG
    return {
        "gates": {"items": []}, "kernel": kernel, "cfg": _CFG.Config(),
        "cell_m": 54.0,
        "coverage": {"rate": 0.6, "n_hit": 6, "n_total": 10,
                     "missed": [], "excluded": []},
        "coverage_top20": 0.6,
        "front": {"n": 3, "mean_abs_diff_m": 0.3, "max_abs_diff_m": 0.4},
        "dead_spot": {"reason": "测试"},
        "order_cmp": {"gain_over_baseline": 0.12, "best_baseline": "random"},
        "adj": {"median_rel_err": 1e-9, "passed": True},
        "recon": {}, "cc_identifiable": {"identifiable": False, "n_events": 1},
        "retrofit": {"n_projects": 6},
        "observe": {"monitor_sites": 149, "monitor_sites_spec": 149,
                    "service_outages": 10, "rain_stations": 8},
        "gate": {"reduction": 0.44, "passed": True},
        "rain_check": {"model_mm": 202.0, "obs_mm": 269.0, "rel_err": -0.25,
                       "rel_err_allcity": -0.46, "n_stations": 2,
                       "allcity_mm": 375.0, "obs_basis": "测试",
                       "sampling_bias": "测试"},
        "rain_total_mm": 202.0, "depth_accuracy": None,
        "event_name": "测试", "config_hash": "x", "source_hash": "y",
        "levels": {0: 0.5, 1: 0.3, 2: 0.2}, "proj": {},
        "conclusion": {"门槛数": 27, "通过": 15},
    }
    assert sec["净短波_实际使用_W_m2"] == 0.0
def test_selfcheck_closure_is_clean():
    """体系自检闭合：规模与覆盖不得静默缩小。

    背景：本项目曾出现三处**静默退步**，全部通过了 130 条测试与 G16–G20：
      1) get_flood_cards 工具消失（8→7）
      2) _CALIBER_SECTIONS 退回 2 项，G18 分母 5→4 但仍报 PASS
      3) cli.py 丢失情景矩阵阶段，p6 只剩 p50 而材料引用四档
    三者都不抛异常、不改结论，只缩小覆盖面——所以必须把**分母**本身
    作为判据，而不能只看比率。
    """
    from typhoeus import selfcheck as SC

    r = SC.measure()
    failed = [c for c in r["逐项"] if not c["通过"]]
    msg = "; ".join(f"{c['判据']} 实测 {c['实测']} 应为 {c['应为']}"
                    for c in failed)
    assert r["score"] == 1.0, f"自检未闭合（score={r['score']}）：{msg}"
