"""在 hf-mirror 上找没被转坏的 Sen1Floods11，并逐个报文件树与扩展名分布。

判据：要的是官方 npy/png 布局（每瓦片一张 512×512 VV 图 + 同尺寸标注），
不是上次那种影像只剩 1024 像素的 50Cities 转换残骸。
"""
import json
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0"}
MIRROR = "https://hf-mirror.com"


def get(url):
    req = urllib.request.Request(url, headers=UA)
    return json.loads(urllib.request.urlopen(req, timeout=45).read().decode())


def head_bytes(url, n=4096):
    req = urllib.request.Request(url, headers=dict(UA))
    req.add_header("Range", f"bytes=0-{n - 1}")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            b = r.read()
            return r.status, len(b), b[:4]
    except Exception as e:
        return type(e).__name__, 0, b""


cands = get(f"{MIRROR}/api/datasets?search=sen1floods&limit=15")
print("候选：")
for x in cands:
    print(f"  {x['id']:44s} gated={x.get('gated')} likes={x.get('likes')} dl={x.get('downloads')}")

for x in cands:
    dsid = x["id"]
    if x.get("gated"):
        print(f"\n== {dsid}: gated，跳过（需 token）")
        continue
    try:
        tree = get(f"{MIRROR}/api/datasets/{dsid}/tree/main?recursive=true&limit=120")
    except Exception as e:
        print(f"\n== {dsid}: 列目录失败 {type(e).__name__} {str(e)[:70]}")
        continue
    rows = []
    for p in tree.get("paths", []):
        rows.append((p.get("path", ""), p.get("size", 0) or 0, p.get("type")))
    if not rows:
        print(f"\n== {dsid}: 树为空")
        continue
    ext = {}
    for name, size, typ in rows:
        if typ == "blob":
            key = name.rsplit(".", 1)[-1][:6] if "." in name else "(无扩展)"
            ext[key] = ext.get(key, 0) + 1
    total = sum(s for _, s, _ in rows)
    print(f"\n== {dsid}: 条目 {len(rows)}，合计 {total / 1e9:.2f} GB，扩展名 {dict(sorted(ext.items(), key=lambda kv: -kv[1])[:6])}")
    for name, size, typ in rows[:10]:
        print(f"   {typ:4s} {size / 1e6:9.2f} MB  {name[:74]}")
    blobs = [n for n, s, t in rows if t == "blob" and s > 10_000][:3]
    for n in blobs:
        url = f"{MIRROR}/datasets/{dsid}/resolve/main/{urllib.parse.quote(n)}"
        st, ln, magic = head_bytes(url, 4096)
        print(f"   抽样头 4KB: {st} {ln}B magic={magic!r}  ({n[:50]})")
