"""语料抽取：从公开报道中抽出「地点 + 深度 + 时刻」候选事实。

用途：扩充验证集。当前涝点台账只有 28 条（域内 17 条），且坐标精度 ±100 m。
公开报道里还有大量"某路积水 90 厘米"这类带地点与量级的陈述，可作**候选**，
但必须经人工核对才能入台账——因此本模块输出 `provenance=语料候选，待核对`。

关键实现点：
  - 央广网/中新网等大量页面是 **GBK/GB2312**，必须按 meta charset 解码，
    否则整页乱码（实测 urllib 默认会解成乱码）。
  - 只抽"深度 + 地点"同句出现的片段，避免把无关数字当水深。

用法：python -m typhoeus.corpus --url <URL> [--url ...]
      python -m typhoeus.corpus --batch   # 用内置 URL 列表
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 2021 烟花事件期间的公开报道（人工检索所得，均为可公开访问的新闻页）
BATCH = [
    ("央广网", "http://zj.cnr.cn/mlnb/nbpd/20210728/t20210728_525546272.shtml"),
    ("中青网", "http://news.cyol.com/gb/articles/2021-07/25/content_eLYxEi4PO.html"),
    ("中新网", "http://www.chinanews.com.cn/sh/2021/07-26/9528632.shtml"),
    ("海曙区政府", "https://www.haishu.gov.cn/art/2021/7/30/art_1229100592_58947734.html"),
    ("宁波住建局", "http://zjw.ningbo.gov.cn/art/2021/7/23/art_1229126187_58918959.html"),
]

# 深度表达式：数字 + 单位
DEPTH = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*(厘米|公分|cm|CM|毫米)")
# 地点表达式：常见地名后缀
PLACE = re.compile(
    r"([\u4e00-\u9fa5]{2,10}?(?:路|街|道|巷|弄|小区|社区|村|镇|街道|立交|下穿|"
    r"隧道|桥|广场|花园|新村|公寓|路口|片区|新区))")
# 时刻
DATE = re.compile(r"(20\d{2})-(\d{1,2})-(\d{1,2})|(\d{1,2})月(\d{1,2})日")
# 水相关上下文
WATER_CTX = ("积水", "水深", "淹没", "受淹", "进水", "漫过", "内涝")


def fetch_text(url: str) -> tuple[str, str]:
    """取页面并按正确编码解码，返回 (文本, 编码)。"""
    req = urllib.request.Request(url, headers=_UA)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=45, context=ctx) as r:
        raw = r.read()
        ctype = r.headers.get("Content-Type", "")
    # 1) 从 meta 找 charset
    head = raw[:4000].decode("ascii", "ignore")
    m = re.search(r'charset\s*=\s*["\']?\s*([A-Za-z0-9_\-]+)', head, re.I)
    enc = (m.group(1) if m else "").lower()
    if not enc:
        m2 = re.search(r"charset=([A-Za-z0-9_\-]+)", ctype, re.I)
        enc = (m2.group(1) if m2 else "").lower()
    # 2) 依次尝试
    for cand in ([enc] if enc else []) + ["utf-8", "gb18030", "gbk", "big5"]:
        if not cand:
            continue
        try:
            txt = raw.decode(cand)
            # 中文页面的健全性检查：乱码时常用替换字符或极低的中文字符比例
            cjk = sum(1 for ch in txt[:3000] if "\u4e00" <= ch <= "\u9fff")
            if cjk > 20 or cand in ("utf-8", "gb18030"):
                return txt, cand
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace"), "utf-8(replace)"


def strip_tags(html: str) -> str:
    """去脚本/样式/标签，保留正文文本。"""
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&nbsp;?", " ", html)
    return re.sub(r"\s+", " ", html)


def extract(text: str) -> list[dict]:
    """抽「深度 + 地点」同句出现的事实。"""
    facts = []
    # 粗分句
    for sent in re.split(r"[。；！？\n]", text):
        if not any(k in sent for k in WATER_CTX):
            continue
        deps = DEPTH.findall(sent)
        if not deps:
            continue
        places = PLACE.findall(sent)
        dates = DATE.findall(sent)
        for num, unit in deps:
            try:
                val = float(num)
            except ValueError:
                continue
            if unit == "毫米":
                val = val / 10.0          # 毫米→厘米
            if not (1 <= val <= 500):
                continue
            facts.append({
                "深度_cm": val,
                "地点": places[0] if places else None,
                "同句地点": places[:3],
                "日期": "-".join(x for x in dates[0][:3] if x) if dates else None,
                "原句": sent.strip()[:160],
            })
    # 去重
    seen, out = set(), []
    for f in facts:
        key = (f["深度_cm"], f["地点"], f["原句"][:40])
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
    return out


def run_urls(urls: list[tuple[str, str]]) -> dict:
    results = []
    for name, url in urls:
        item = {"来源": name, "URL": url}
        try:
            txt, enc = fetch_text(url)
            body = strip_tags(txt)
            facts = extract(body)
            item.update({"编码": enc, "正文字数": len(body), "抽取条数": len(facts),
                         "事实": facts})
        except urllib.error.HTTPError as e:
            item.update({"错误": f"HTTP {e.code}"})
        except Exception as e:  # noqa: BLE001
            item.update({"错误": f"{type(e).__name__}: {str(e)[:60]}"})
        results.append(item)
        print(f"  {name:<10} {item.get('编码', '—'):<16} "
              f"正文 {item.get('正文字数', 0):>6} 字  抽取 {item.get('抽取条数', 0)} 条"
              f"{'  ' + item['错误'] if '错误' in item else ''}")
        for f in item.get("事实", [])[:3]:
            print(f"      {f['深度_cm']:>5.0f} cm  {str(f['地点'])[:14]:<16} "
                  f"{str(f['日期'])[:12]:<12} {f['原句'][:52]}")

    payload = {
        "名称": "语料事实抽取（候选）",
        "生成时间": datetime.now().isoformat(timespec="seconds"),
        "用途": "扩充验证集；抽取结果须人工核对后方可入台账",
        "provenance": "语料候选，待核对",
        "汇总": {
            "页面数": len(results),
            "成功页数": sum(1 for r in results if "错误" not in r),
            "候选事实数": sum(r.get("抽取条数", 0) for r in results),
            "带地点的事实数": sum(1 for r in results for f in r.get("事实", [])
                             if f.get("地点")),
        },
        "来源": results,
        "边界": [
            "抽取为规则匹配，未做人工核对；地点可能指片区而非确切坐标。",
            "深度为报道口径，可能与实测水深、积水深度、淹没深度含义不同。",
            "日期缺失时无法与模型时序比对。",
            "不得把本件结果直接并入 flood_points 台账，须逐条核对来源与坐标。",
        ],
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "p15_语料候选事实.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    s = payload["汇总"]
    print(f"\n汇总：{s['成功页数']}/{s['页面数']} 页成功，"
          f"候选事实 {s['候选事实数']} 条（带地点 {s['带地点的事实数']} 条）")
    print(f"→ {OUT / 'p15_语料候选事实.json'}")
    return payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.corpus")
    ap.add_argument("--url", action="append", default=[])
    ap.add_argument("--batch", action="store_true")
    a = ap.parse_args(argv)

    if a.url:
        urls = [(f"手动{u}", u) for u in a.url]
    elif a.batch:
        urls = BATCH
    else:
        urls = BATCH
    run_urls(urls)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
