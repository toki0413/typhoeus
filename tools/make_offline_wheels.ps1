# 下载离线 wheel（在能上网的机器上跑一次，本机/CI 均可）
# 用法： powershell -ExecutionPolicy Bypass -File .\tools\make_offline_wheels.ps1
# 产物： dist\wheels\  —— 再跑 pack_acceptance.ps1，zip 会把它打进去，安装不再需要联网。
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$dst = Join-Path $root "dist\wheels"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

python -m pip download -r (Join-Path $root "requirements.txt") -d $dst `
    --only-binary=:all: --platform win_amd64 --python-version 313
if ($LASTEXITCODE -ne 0) { throw "wheel 下载失败（检查网络或 Python 版本）" }

$n = (Get-ChildItem $dst -File).Count
$mb = [math]::Round(((Get-ChildItem $dst -File | Measure-Object Length -Sum).Sum / 1MB), 1)
"wheels：$n 个文件，$mb MB → $dst"
