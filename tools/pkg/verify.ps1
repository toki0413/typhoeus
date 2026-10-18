# 验收（Windows / PowerShell）
# 用法： powershell -ExecutionPolicy Bypass -File .\verify.ps1
#   · 有 .venv → 用 .venv 里的 Python（install.ps1 装过）
#   · 没有 .venv → 用系统 Python（无网验收路径，需本机已有 numpy/scipy/rasterio/pytest）
$ErrorActionPreference = "Continue"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$vpy = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $vpy)) {
    $vpy = "python"
    Write-Host "未找到 .venv：改用系统 Python（无网验收路径）" -ForegroundColor Yellow
}
$fail = 0

function Step([string]$title, [string[]]$cmd) {
    Write-Host "`n== $title ==" -ForegroundColor Cyan
    & $vpy @cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [失败] 退出码 $LASTEXITCODE" -ForegroundColor Red
        $script:fail++
    }
}

Step "1/5 指纹自检（manifest / config.json / 运行时三方一致）" @("-m", "typhoeus.selfcheck")
Step "2/5 全链重算 + 27 条门槛" @("-m", "typhoeus.cli", "run")
Step "3/5 回归测试" @("-m", "pytest", "typhoeus/tests.py", "-q")
Step "4/5 MCP 工具表" @("-m", "typhoeus.mcp_server", "--list-tools")
$pycode = @"
import json
hm = json.load(open('out/05_health_metrics.json', encoding='utf-8'))
hr = json.load(open('out/06_health_report.json', encoding='utf-8'))
mf = json.load(open('out/manifest.json', encoding='utf-8'))
print('config_hash', mf['config_hash'], '| source_hash', mf['source_hash'])
print('门槛', hm['指标总数'], 'PASS', hm['PASS'], 'FAIL', hm['FAIL'], 'BLOCKED', hm['BLOCKED'])
print('06 门槛统计', hr['门槛统计'])
print('产物', len(mf['outputs']), '份，指纹', len(mf['指纹']), '个')
"@
Step "5/5 关键数字" @("-c", $pycode)

Write-Host "`n================ 验收结论 ================" -ForegroundColor Cyan
if ($fail -eq 0) {
    Write-Host "五项全部通过" -ForegroundColor Green
} else {
    Write-Host "$fail 项未通过，见上方 [失败] 行" -ForegroundColor Red
}
Write-Host "已知限制（不是本包缺陷，见 验收单.md）：水深命中率 0%、全市雨量偏差 -31%、7 条 BLOCKED" -ForegroundColor Yellow
exit $fail
