"""把本地包推上云端并在机上起跑作业。密码只在使用时从文件读，绝不打印、绝不复制到他处。

用法（本地）：
    python tools/cloud_push.py            # 装公钥 + 传包 + 远端校验
    python tools/cloud_push.py --run      # 上一步之后，接着解包并跑 tools/cloud_run.sh

密码来源优先级：环境变量 AUTODL_PASS，其次 ~/.autodl_pass（由你自己创建）。
公钥来源：~/.ssh/id_ed25519.pub（只读公钥，不碰私钥）。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = os.environ.get("AUTODL_HOST", "connect.cqa1.seetacloud.com")
PORT = int(os.environ.get("AUTODL_PORT", "29542"))
USER = os.environ.get("AUTODL_USER", "root")
DATA_DISK = os.environ.get("AUTODL_DATA", "/root/autodl-tmp")
TARBALL = ROOT / "typhoeus_core.tar.gz"
EXPECT_SHA = os.environ.get("EXPECT_SHA", "")


def _password() -> str:
    p = os.environ.get("AUTODL_PASS", "").strip()
    if p:
        return p
    f = Path.home() / ".autodl_pass"
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    raise SystemExit(
        "取不到密码。在你自己的终端跑这一行（粘贴一次，文件只留在你机器上）：\n"
        '  Read-Host "粘贴实例密码" | Set-Content "$env:USERPROFILE\\.autodl_pass" -NoNewline')


def _pubkey() -> str:
    f = Path.home() / ".ssh" / "id_ed25519.pub"
    if not f.exists():
        raise SystemExit(f"没有 {f}，先生成一把：ssh-keygen -t ed25519")
    return f.read_text(encoding="utf-8").strip()


def _sha256(fp: Path) -> str:
    h = hashlib.sha256()
    with fp.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _cli(password: str | None, use_key: bool):
    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = dict(hostname=HOST, port=PORT, username=USER, timeout=25,
              banner_timeout=30, auth_timeout=30, look_for_keys=False, allow_agent=False)
    if use_key:
        c.connect(key_filename=str(Path.home() / ".ssh" / "id_ed25519"), **kw)
    else:
        c.connect(password=password, **kw)
    return c


def _run(c, cmd: str, timeout: int = 120) -> tuple[int, str]:
    _, so, se = c.exec_command(cmd, timeout=timeout)
    out = so.read().decode("utf-8", "ignore")
    err = se.read().decode("utf-8", "ignore")
    rc = so.channel.recv_exit_status()
    return rc, (out + ("\n" + err.strip() if err.strip() else "")).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="传完接着解包并跑 cloud_run.sh")
    ap.add_argument("--skip-install", action="store_true")
    a = ap.parse_args()

    if not TARBALL.exists():
        raise SystemExit(f"缺少 {TARBALL}")
    loc_sha = _sha256(TARBALL)
    size = TARBALL.stat().st_size
    print(f"[包] {size/1e6:.1f} MB  sha256 {loc_sha[:16]}…", flush=True)

    if not a.skip_install:
        pw = _password()
        pub = _pubkey()
        print(f"[1/4] 用密码登录并装公钥 {pub.split()[0]} {pub[-12:]} 到 {HOST}:{PORT}", flush=True)
        c = _cli(pw, use_key=False)
        rc, out = _run(c, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && "
                           f"grep -qF '{pub}' ~/.ssh/authorized_keys || echo '{pub}' >> ~/.ssh/authorized_keys; "
                           "chmod 600 ~/.ssh/authorized_keys; echo KEY_OK; wc -l < ~/.ssh/authorized_keys")
        print("      " + out.replace("\n", " | "), flush=True)
        c.close()
        del pw

    print("[2/4] 改用密钥登录（验证免密通道成立）", flush=True)
    c = _cli(None, use_key=True)
    rc, out = _run(c, "hostname; nproc; python3 -V; nvidia-smi --query-gpu=name,memory.total "
                      "--format=csv,noheader; df -h /root /root/autodl-tmp 2>/dev/null | sed -n '2,3p'")
    print("      " + out.replace("\n", "\n      "), flush=True)
    rc, out = _run(c, f"mkdir -p {DATA_DISK}/typhoeus && df -h {DATA_DISK} | sed -n 2p")
    print(f"[3/4] 上传到 {DATA_DISK}/typhoeus_core.tar.gz", flush=True)
    sftp = c.open_sftp()
    t0 = time.time()
    remote = f"{DATA_DISK}/typhoeus_core.tar.gz"
    last = [0.0]

    def cb(sent: int, total: int) -> None:
        if total and (sent - last[0] >= (20 << 20) or sent == total):
            last[0] = sent
            el = time.time() - t0
            rate = sent / max(el, 1e-9)
            print(f"      {sent/1e6:6.0f} / {total/1e6:.0f} MB  {rate/1e6:.1f} MB/s  "
                  f"余 {(total-sent)/max(rate,1):.0f} s", flush=True)

    sftp.put(str(TARBALL), remote, callback=cb)
    sftp.close()
    el = time.time() - t0
    print(f"      上传完成 {size/1e6:.1f} MB / {el:.0f} s = {size/1e6/el:.1f} MB/s", flush=True)

    rc, out = _run(c, f"sha256sum {remote}; stat -c%s {remote}", timeout=300)
    print("[4/4] 远端校验：" + out.replace("\n", " | "), flush=True)
    rsha = out.split()[0] if out else ""
    if rsha != loc_sha:
        print(f"      哈希不一致！本地 {loc_sha} != 远端 {rsha}，不起跑。", flush=True)
        c.close()
        return 6

    if a.run:
        print(f"[跑] 解包并执行 tools/cloud_run.sh（输出同时进 .scratch/cloud_run.log）", flush=True)
        cmd = (f"cd {DATA_DISK}/typhoeus && tar xzf typhoeus_core.tar.gz -C {DATA_DISK}/typhoeus && "
               f"bash tools/cloud_run.sh")
        chan = c.get_transport().open_session()
        chan.settimeout(None)
        chan.exec_command(cmd)
        log = ROOT / ".scratch" / "cloud_run.log"
        log.parent.mkdir(exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"\n==== {time.strftime('%F %T')} 起 ====\n")
            while True:
                if chan.recv_ready():
                    s = chan.recv(8192).decode("utf-8", "ignore")
                    sys.stdout.write(s)
                    fh.write(s)
                    fh.flush()
                elif chan.recv_stderr_ready():
                    s = chan.recv_stderr(4096).decode("utf-8", "ignore")
                    sys.stdout.write(s)
                    fh.write(s)
                    fh.flush()
                elif chan.exit_status_ready():
                    break
                else:
                    time.sleep(0.5)
            fh.write(f"\n==== 退出码 {chan.recv_exit_status()} ====\n")
        print(f"\n[跑] 远端退出码 {chan.recv_exit_status()}，全文存 {log}", flush=True)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
