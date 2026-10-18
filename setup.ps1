# 一键上手：建环境 → 装依赖 → 备数据 → 跑全链 → 起值班台
# 用法： powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$py = "python"

Write-Host "== 1/4 建虚拟环境 ==" -ForegroundColor Cyan
if (-not (Test-Path ".\.venv")) { & $py -m venv .venv }
$vpy = ".\.venv\Scripts\python.exe"

Write-Host "== 2/4 装依赖 ==" -ForegroundColor Cyan
& $vpy -m pip install --upgrade pip --quiet
if (Test-Path ".\wheels") {
    & $vpy -m pip install --no-index --find-links wheels -r requirements.txt
} else {
    & $vpy -m pip install -r requirements.txt
}

& $vpy -m pip install -e . --no-deps --quiet

Write-Host "== 3/4 准备数据 ==" -ForegroundColor Cyan
& $vpy .\tools\fetch_data.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "数据准备失败：见上方提示（DEM 与台风路径需要外网，各约 43 MB / 110 MB）" -ForegroundColor Yellow
    exit 1
}

Write-Host "== 4/4 跑全链 ==" -ForegroundColor Cyan
& $vpy -m typhoeus.cli run

Write-Host "`n完成。值班台： powershell -File .\start_web.ps1（或 .\.venv\Scripts\typhoeus-web.exe）" -ForegroundColor Green
