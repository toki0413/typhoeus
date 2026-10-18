"""TPDC（国家青藏高原科学数据中心）数据集可用性与元数据查询。

为什么要这个模块：TPDC 的页面是前端 SPA，没有公开文档；但它的元数据接口
**可匿名 POST**，能拿到标题、作者、DOI、文件总量、共享策略（sharePolicy）
与发布状态。本项目用它来判断一份数据"能不能自己下、要多大、要不要申请"，
把"缺数据"从一句模糊的话变成可核对的读数。

实测到的事实（2026-10-17）：
  - `POST /view/metadataView/detail  {"metadataId": <uuid>}` → 200，返回完整元数据；
  - 免登录下载的判据（前端源码）：`fileSize < 1024**3` 才开放，
    否则按钮 disabled 并强制走需登录的 FTP；
  - sharePolicy="A" 表示免申请审核，不等于免登录（大文件仍需登录取 FTP 凭据）；
  - `/admin/ftp/*` 与 `/my/ftp/*` 需完整认证（实测 401）。

用法：
  python -m typhoeus.tpdc --uuid e60dfd96-5fd8-493f-beae-e8e5d24dece4
  python -m typhoeus.tpdc --preset cmfd east_asia_001
"""

from __future__ import annotations

import argparse
import json
import ssl
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://data.tpdc.ac.cn"
ONE_GIB = 1024 ** 3

# 本项目关心的数据集
PRESETS = {
    "cmfd": "e60dfd96-5fd8-493f-beae-e8e5d24dece4",          # CMFD 2.0（3h, 0.1°）
    "east_asia_001": "89722216-c43d-4a54-a896-11e6bdae030a",  # 东亚 0.01° 逐小时融合降水
}

_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": "https://data.tpdc.ac.cn/",
    "Origin": "https://data.tpdc.ac.cn",
}


def detail(uuid: str, timeout: int = 60, retries: int = 3) -> dict:
    """取数据集完整元数据（匿名可读）。

    TPDC 偶发读超时（实测同一请求两次成功一次超时），故带指数退避重试。
    """
    import time

    url = BASE + "/view/metadataView/detail"
    body = json.dumps({"metadataId": uuid}).encode("utf-8")
    ctx = ssl.create_default_context()
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=_UA, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
            if str(j.get("code")) != "200":
                raise RuntimeError(
                    f"TPDC 返回 code={j.get('code')} message={j.get('message')}")
            return j.get("context") or {}
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (2 ** attempt))
    raise RuntimeError(f"重试 {retries} 次仍失败：{type(last).__name__}: {last}")


def summarize(ctx: dict) -> dict:
    """把元数据压成可用性判断。"""
    mv = ctx.get("metadataVO") or {}
    fs = float(mv.get("fileSize") or 0)
    policy = mv.get("sharePolicy")
    status = mv.get("status")
    can_anon = fs > 0 and fs < ONE_GIB
    authors = [a.get("name") for a in (ctx.get("authorVOList") or []) if a.get("name")]
    doi = next((x.get("doi") for x in (ctx.get("literatureVOList") or [])
                if x.get("doi")), None)
    return {
        "id": mv.get("id"),
        "title": mv.get("title"),
        "title_en": mv.get("titleEn"),
        "authors": authors,
        "doi": doi,
        "fileSize_B": fs,
        "fileSize_GiB": round(fs / 2 ** 30, 2),
        "sharePolicy": policy,
        "status": status,
        "policy_含义": {"A": "免申请审核", "B": "需申请", "C": "需申请"}.get(policy, "未知"),
        "免登录可直下": can_anon,
        "免登录判据": f"fileSize < 1 GiB（{ONE_GIB:,} B）；前端实测按此禁用按钮",
        "下载门槛": ("可直接匿名下载" if can_anon
                     else f"文件 {fs / 2 ** 30:.1f} GiB ≥ 1 GiB → 需登录获取 FTP 凭据"
                          if fs else "未标注文件总量"),
        "摘要": (mv.get("description") or "")[:300],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="typhoeus.tpdc")
    ap.add_argument("--uuid", help="数据集 UUID")
    ap.add_argument("--preset", nargs="*", choices=list(PRESETS),
                    help="用内置数据集：" + ", ".join(PRESETS))
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    targets: dict[str, str] = {}
    if a.uuid:
        targets[a.uuid[:8]] = a.uuid
    if a.preset:
        for k in a.preset:
            targets[k] = PRESETS[k]
    if not targets:
        targets = dict(PRESETS)

    results = []
    for name, uid in targets.items():
        try:
            ctx = detail(uid)
        except Exception as e:  # noqa: BLE001
            print(f"[失败] {name} {uid}: {type(e).__name__}: {e}")
            continue
        s = summarize(ctx)
        s["_key"] = name
        results.append(s)
        if a.json:
            continue
        print(f"### {name}  ({uid[:8]}…)")
        print(f"  标题    : {s['title']}")
        print(f"  作者    : {'、'.join(s['authors'][:4]) or '—'}")
        print(f"  DOI     : {s['doi'] or '—'}")
        print(f"  文件量  : {s['fileSize_GiB']} GiB（{s['fileSize_B']:,.0f} B）")
        print(f"  共享策略: {s['sharePolicy']}（{s['policy_含义']}）  status={s['status']}")
        print(f"  下载门槛: {s['下载门槛']}")
        print(f"  免登录  : {'是' if s['免登录可直下'] else '否'}（判据 {s['免登录判据']}）")
        print()

    out = Path(a.outdir) / "tpdc_数据集可用性.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(
        {"查询时间": datetime.now().isoformat(timespec="seconds"), "数据集": results},
        ensure_ascii=False, indent=2), encoding="utf-8")

    if a.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    print(f"→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
