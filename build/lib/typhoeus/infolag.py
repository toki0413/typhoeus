"""p16 信息时滞度量：信息公开比事件本身慢多少。

第三条腿（打破城建与市民的信息不对称）的可量化指标。三部分：

  A. 披露滞后（日级区间）
     台账 `source` 只带日期（"07-26 报道"），不带时刻。
     因此只能给出滞后**区间**：report_date 的函数在 [当天0点, 当天24点]。
     这是数据精度决定的，不伪装成点值。

  B. 报道时滞（分钟级，来自语料）
     语料文章的发布时间是分钟级（"2021-07-28 11:22:00"），
     正文里又常见"截至昨日下午4点"这类相对时刻。两者相减是真时滞。

  C. 模型净增益
     模型越阈时刻（p13）vs 台账披露时刻。
     回答：如果当时有本模型，能比公开报道早多少小时知道？

用法：python -m typhoeus.infolag
"""

from __future__ import annotations

import csv
import json
import re
import ssl
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed"
OUT = ROOT / "out"
YEAR = 2021

_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 用于 B 部分的语料（与 corpus.py 的批次一致，取有明确时间陈述的页面）
CORPUS = [
    ("央广网", "http://zj.cnr.cn/mlnb/nbpd/20210728/t20210728_525546272.shtml",
     "在积水最深的广蔺社区"),
    ("中新网", "http://www.chinanews.com.cn/sh/2021/07-26/9528632.shtml",
     "上水碶村"),
]

# 报道日期："07-25 通报" / "07-26 报道" / "7月26日"
REPORT_DATE = re.compile(r"(0?\d{1,2})[-月](\d{1,2})")
# 文章发布时间："2021-07-28 11:22:00" / "2021年7月28日 11:22"
PUB_TIME = re.compile(
    r"(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?\s*(\d{1,2}):(\d{2})")
# 时段短语 → 默认小时（中文报道常只说"昨天夜里"，不给钟点）
DAY_WORD = {"昨": 1, "今": 0, "前": 2}          # 相对发布日的天数
BAND_WORD = {
    "凌晨": (2, 5, 3.5), "清晨": (5, 7, 6.0), "早上": (6, 9, 7.5),
    "上午": (8, 12, 10.0), "中午": (11, 14, 12.5), "下午": (13, 18, 15.5),
    "傍晚": (17, 20, 18.5), "晚上": (19, 23, 21.0), "夜里": (20, 24, 22.0),
    "深夜": (22, 24, 23.0), "夜间": (20, 24, 22.0),
}
REL_PHRASE = re.compile(
    r"(昨|今|前)\s*天?\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|夜间)")
# 兼容「截至昨日下午4点」这类带钟点的表述
REL_CLOCK = re.compile(
    r"截至\s*(昨|今|前)\s*日?\s*(上午|下午)?\s*(\d{1,2})\s*[点时]")


def _load(p: Path) -> list[dict]:
    with open(p, encoding="utf-8-sig") as f:
        return [{k.lstrip("\ufeff"): v for k, v in r.items()} for r in csv.DictReader(f)]


def _parse_report_date(src: str) -> datetime | None:
    m = REPORT_DATE.search(src)
    if not m:
        return None
    mon, day = int(m.group(1)), int(m.group(2))
    if not (1 <= mon <= 12 and 1 <= day <= 31):
        return None
    try:
        return datetime(YEAR, mon, day)
    except ValueError:
        return None


def _fetch_html(url: str) -> str:
    """取页面并按**全文中文占比**选择最优编码。

    踩过的坑：只看前 3000 字的中文数会把导航/脚本区当正文，
    对 UTF-8 页面误判为乱码后回退到 gb18030，结果整页乱码。
    改为逐候选解码 + 全文打分取最优。
    """
    req = urllib.request.Request(url, headers=_UA)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=45, context=ctx) as r:
        raw = r.read()

    head = raw[:4000].decode("ascii", "ignore")
    m = re.search(r'charset\s*=\s*["\']?\s*([A-Za-z0-9_\-]+)', head, re.I)
    declared = (m.group(1) if m else "").lower()
    cands = [c for c in (declared, "utf-8", "gb18030", "gbk") if c]

    best, best_score = None, -1.0
    for cand in cands:
        try:
            t = raw.decode(cand)
        except (UnicodeDecodeError, LookupError):
            continue
        # 全文中文占比（替代前 3000 字的局部统计）
        score = sum(1 for ch in t if "\u4e00" <= ch <= "\u9fff") / max(len(t), 1)
        if score > best_score:
            best, best_score = t, score
    if best is None:
        return raw.decode("gb18030", "replace")
    return best


def part_a() -> list[dict]:
    """披露滞后：台账 source 日期 − 事件 start_at。

    规则：
      - 报道不可能早于事件，故滞后下界不得为负（clip 到 0）。
      - 若报道日期与事件同日，则该事件时刻很可能就来自这篇报道，
        滞后**不可分离**——标 `同日不可分`，不给数值。
    """
    rows = []
    for r in _load(SEED / "service_outages_2021_infa.csv"):
        start = datetime.strptime(r["start_at"], "%Y-%m-%d %H:%M")
        rep = _parse_report_date(r["source"])
        if rep is None:
            continue
        rec = {
            "编号": r["outage_id"], "类别": r["category"], "对象": r["target"],
            "事件时刻": start.strftime("%m-%d %H:%M"),
            "报道日期": rep.strftime("%m-%d"),
        }
        if rep.date() == start.date():
            rec.update({"滞后区间_h": None, "滞后下界_h": None,
                        "判定": "同日不可分",
                        "说明": "事件时刻很可能来自该报道本身，滞后无法分离"})
        else:
            lo = max(0.0, (rep - start).total_seconds() / 3600.0)
            hi = (rep + timedelta(days=1) - start).total_seconds() / 3600.0
            rec.update({"滞后区间_h": [round(lo, 1), round(hi, 1)],
                        "滞后下界_h": round(lo, 1), "判定": "可分离",
                        "说明": "报道时刻未知，区间为 [报道日0点, 次日0点]"})
        rows.append(rec)
    return rows


def part_b() -> list[dict]:
    """报道时滞：文章发布时间 − 正文所述事件时刻（分钟级）。"""
    rows = []
    for name, url, anchor in CORPUS:
        item = {"来源": name, "URL": url, "锚点": anchor}
        try:
            html = _fetch_html(url)
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text)
        except Exception as e:  # noqa: BLE001
            item["错误"] = f"{type(e).__name__}"
            rows.append(item)
            continue

        pts = PUB_TIME.findall(text)
        if not pts:
            item["错误"] = "未找到发布时间"
            rows.append(item)
            continue
        y, mo, d, hh, mm = (int(x) for x in pts[0])
        pub = datetime(y, mo, d, hh, mm)

        # 在全文里找时间短语：优先"截至…X点"，其次"昨天夜里"这类时段词
        clock_hits = list(REL_CLOCK.finditer(text))
        band_hits = list(REL_PHRASE.finditer(text))
        k = text.find(anchor)

        if clock_hits:
            m = (min(clock_hits, key=lambda x: abs(x.start() - k))
                 if k >= 0 else clock_hits[0])
            rel, half, hh = m.group(1), m.group(2), int(m.group(3))
            if half == "下午" and hh < 12:
                hh += 12
            base = pub - timedelta(days=DAY_WORD[rel])
            event = base.replace(hour=hh, minute=0, second=0, microsecond=0)
            lo_cm, hi_cm = hh, hh
            phrase = m.group(0)
            kind = "钟点"
        elif band_hits:
            m = (min(band_hits, key=lambda x: abs(x.start() - k))
                 if k >= 0 else band_hits[0])
            rel, word = m.group(1), m.group(2)
            lo_cm, hi_cm, _mid = BAND_WORD[word]
            base = pub - timedelta(days=DAY_WORD[rel])
            event = base.replace(hour=lo_cm, minute=0, second=0, microsecond=0)
            phrase = m.group(0)
            kind = "时段（默认时刻）"
        else:
            item.update({"发布时间": pub.strftime("%m-%d %H:%M"),
                         "错误": "全文未找到时间短语"})
            rows.append(item)
            continue

        # 滞后区间：时段词给带宽，钟点词给点值
        # 注意 hour 可能为 24（"夜里"→∞），不能用 replace，须用 timedelta 累加
        day0 = base.replace(hour=0, minute=0, second=0, microsecond=0)
        ev_lo = day0 + timedelta(hours=lo_cm)
        ev_hi = day0 + timedelta(hours=hi_cm)
        lag_lo = (pub - ev_hi).total_seconds() / 3600.0
        lag_hi = (pub - ev_lo).total_seconds() / 3600.0
        item.update({
            "发布时间": pub.strftime("%m-%d %H:%M"),
            "原文时间表述": phrase,
            "表述类型": kind,
            "事件时刻_下界": ev_lo.strftime("%m-%d %H:%M"),
            "事件时刻_上界": ev_hi.strftime("%m-%d %H:%M"),
            "报道时滞_h": [round(min(lag_lo, lag_hi), 2), round(max(lag_lo, lag_hi), 2)],
        })
        rows.append(item)
    return rows


def part_c() -> list[dict]:
    """模型净增益：模型越阈时刻 vs 台账披露时刻。"""
    p13 = OUT / "p13_生命线断供预判.json"
    if not p13.exists():
        return []
    d = json.loads(p13.read_text(encoding="utf-8"))
    rows = []
    for r in d.get("断供事件", {}).get("明细", []):
        if not r.get("模型越阈时刻"):
            continue
        rep = _parse_report_date(r.get("来源", ""))
        cross = datetime.strptime(f"{YEAR}-{r['模型越阈时刻']}", "%Y-%m-%d %H:%M:%S")
        if rep is None:
            continue
        # 报道日期当日 12:00 作为中性假设
        rep_t = rep.replace(hour=12)
        rows.append({
            "编号": r["编号"], "类别": r["类别"], "对象": r["对象"],
            "模型越阈时刻": r["模型越阈时刻"],
            "披露日期": rep.strftime("%m-%d"),
            "净增益_h": round((rep_t - cross).total_seconds() / 3600.0, 1),
            "说明": "正值=模型早于披露；披露时刻按当日 12:00 假设",
        })
    return rows


def run(outdir: str = "out", verbose: bool = True) -> dict:
    a, b, c = part_a(), part_b(), part_c()

    lags_a = [r["滞后下界_h"] for r in a if r.get("滞后下界_h") is not None]
    # B 的时滞是区间，取中点做汇总，同时保留原区间
    lags_b_mid = []
    for r in b:
        v = r.get("报道时滞_h")
        if isinstance(v, list) and len(v) == 2:
            lags_b_mid.append(round((v[0] + v[1]) / 2, 2))
    gains_c = [r["净增益_h"] for r in c]

    def summ(v):
        if not v:
            return {"最小": None, "中位": None, "最大": None}
        s = sorted(v)
        return {"最小": s[0], "中位": s[len(s) // 2], "最大": s[-1]}

    payload = {
        "名称": "信息时滞度量",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "问题": "公开信息比事件本身慢多少？若当时有本模型，能早多少？",
        "A_披露滞后_日级": {
            "样本数": len(a),
            "可分离样本数": len(lags_a),
            "同日不可分数": sum(1 for r in a if r.get("判定") == "同日不可分"),
            "滞后下界_h": summ(lags_a),
            "说明": "source 只带日期，故为区间；同日记录的事件时刻来自报道本身，不可分离",
            "明细": a,
        },
        "B_报道时滞_分钟级": {
            "样本数": len(b),
            "有效样本数": len(lags_b_mid),
            "滞后中点_h": summ(lags_b_mid),
            "说明": "文章发布时间 − 正文所述事件时刻；时段词（如『昨天夜里』）给区间，取中点入汇总",
            "明细": b,
        },
        "C_模型净增益": {
            "样本数": len(c),
            "净增益_h": summ(gains_c),
            "明细": c,
        },
        "边界": [
            "A 部分精度受限于台账口径（source 只有日期），只能给区间，不得当作点值引用。",
            "B 部分为规则抽取，相对时刻表述（昨/今/前 + 上午/下午）可能被误解析。",
            "C 部分样本极少（仅模型越阈的记录），不足以做统计推断。",
            "本件只度量『披露』，不度量『触达』——市民是否看到、看懂，无数据。",
        ],
    }
    p = Path(outdir)
    p.mkdir(parents=True, exist_ok=True)
    (p / "p16_信息时滞.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if verbose:
        print(f"  A 披露滞后（日级）：{len(a)} 条，下界 "
              f"{payload['A_披露滞后_日级']['滞后下界_h']}")
        print(f"  B 报道时滞（分钟级）：{len(b)} 条，中点 "
              f"{payload['B_报道时滞_分钟级']['滞后中点_h']}")
        print(f"  C 模型净增益：{len(c)} 条，{payload['C_模型净增益']['净增益_h']}")
        print(f"→ {p / 'p16_信息时滞.json'}")
    return payload


if __name__ == "__main__":
    run(verbose=True)
