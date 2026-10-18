# 启动值班台（本地 Web 壳）
# 用法： powershell -ExecutionPolicy Bypass -File .\start_web.ps1
#   浏览器打开 http://127.0.0.1:8765 ，Ctrl+C 停止。
$ErrorActionPreference = "Continue"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$vpy = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $vpy)) {
    $vpy = "python"
    Write-Host "未找到 .venv：使用系统 Python" -ForegroundColor Yellow
}
Start-Process "http://127.0.0.1:8765"
& $vpy -m typhoeus.webapp --port 8765
