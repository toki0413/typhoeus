# 安装（Windows / PowerShell）—— 需要联网（PyPI）
# 用法： powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# 无法访问 PyPI 时不要跑这个脚本：直接用系统 Python 跑 verify.ps1（无网路径），
# 前提是本机已有 numpy/scipy/rasterio/pytest。
$ErrorActionPreference = "Stop"
$py = "python"

Write-Host "== 1/3 建虚拟环境 ==" -ForegroundColor Cyan
& $py -m venv .venv
$vpy = ".\.venv\Scripts\python.exe"

Write-Host "== 2/3 装依赖（numpy / scipy / rasterio / pytest）==" -ForegroundColor Cyan
& $vpy -m pip install --upgrade pip
if (Test-Path ".\wheels") {
    Write-Host "发现 wheels\：离线安装，不访问网络" -ForegroundColor Green
    & $vpy -m pip install --no-index --find-links wheels -r requirements.txt
    if (Test-Path ".\wheels\mcp*.whl") {
        & $vpy -m pip install --no-index --find-links wheels "mcp>=1.0"
    }
} else {
    & $vpy -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Host "rasterio 常规安装失败，改用二进制轮子重试" -ForegroundColor Yellow
        & $vpy -m pip install "rasterio>=1.3" --only-binary=:all:
    }
    Write-Host "== 3/3 可选：MCP 服务 ==" -ForegroundColor Cyan
    & $vpy -m pip install "mcp>=1.0"
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "mcp 未安装（不影响主链与门槛，只影响 MCP 服务）" -ForegroundColor Yellow
}

Write-Host "`n安装完成。运行验收： powershell -ExecutionPolicy Bypass -File .\verify.ps1" -ForegroundColor Green
