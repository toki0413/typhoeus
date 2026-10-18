# 打包：生成可离线验收的安装包（白名单，只放对外必要文件）
# 用法： powershell -ExecutionPolicy Bypass -File tools\pack_acceptance.ps1
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$name = "typhoeus-acceptance-v1.0"
$stage = Join-Path $root "dist\$name"
$zip = Join-Path $root "dist\$name.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Copy-Tree($src, $dst) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ .pytest_cache | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $src -> $dst" }
}

# 1) 代码
Copy-Tree "$root\typhoeus" "$stage\typhoeus"

# 2) 验收脚本与三个诊断脚本
New-Item -ItemType Directory -Force -Path "$stage\tools\pkg" | Out-Null
Copy-Item "$root\tools\trim_ibtracs.py"   "$stage\tools"
Copy-Item "$root\tools\mcp_selftest.py"   "$stage\tools"
Copy-Item "$root\tools\infil_diag.py"     "$stage\tools"
Copy-Item "$root\tools\pkg\install.ps1"   "$stage"
Copy-Item "$root\tools\pkg\verify.ps1"    "$stage"
Copy-Item "$root\tools\pkg\start_web.ps1" "$stage"
Copy-Item "$root\tools\pkg\验收单.md"     "$stage"

# 3) 数据
New-Item -ItemType Directory -Force -Path "$stage\data" | Out-Null
New-Item -ItemType Directory -Force -Path "$stage\data\seed" | Out-Null
Copy-Item "$root\data\dem_n29e121.tif" "$stage\data"
Get-ChildItem "$root\data\seed" -File |
    Where-Object { $_.Length -lt 5MB -or $_.Name -eq "rain_reanalysis_era5_144x270.npz" } |
    ForEach-Object { Copy-Item $_.FullName "$stage\data\seed" }
python "$root\tools\trim_ibtracs.py" "$stage\data\ibtracs_wp.csv"

# 4) 产物：全部 JSON 与 HTML（.npy 二进制不入包）
New-Item -ItemType Directory -Force -Path "$stage\out" | Out-Null
Copy-Item "$root\out\*.json" "$stage\out"
Copy-Item "$root\out\*.html" "$stage\out"

# 5) 根文件
foreach ($f in @("pyproject.toml","requirements.txt","README.md","LICENSE","NOTICE.md")) {
    if (Test-Path "$root\$f") { Copy-Item "$root\$f" "$stage" }
}
Copy-Item "$root\tools\make_offline_wheels.ps1" "$stage"

# 6) wheels
if (Test-Path "$root\dist\wheels") {
    Copy-Tree "$root\dist\wheels" "$stage\wheels"
    "wheels: $((Get-ChildItem "$stage\wheels" -File).Count) files"
} else {
    Write-Host "no dist\wheels: install needs network" -ForegroundColor Yellow
}

# 7) 压缩
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
"zip: $zip"
"size: $size MB"
"SHA256: $hash"
Set-Content -Path "$zip.sha256" -Value "$hash  $name.zip" -Encoding ascii
