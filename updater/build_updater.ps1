# Build the standalone updater (updater.exe)
#
#   powershell -ExecutionPolicy Bypass -File updater\build_updater.ps1
#
# Output: updater\dist\updater.exe
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI).

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    Write-Host "=== building updater.exe ===" -ForegroundColor Cyan
    $sevenZip = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path $sevenZip)) {
        throw "7-Zip not found (7z.exe + 7z.dll are embedded as the extractor): $sevenZip"
    }
    python -m PyInstaller --clean --noconfirm updater.spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

    $exe = Join-Path $here "dist\updater.exe"
    if (-not (Test-Path $exe)) { throw "updater.exe was not produced: $exe" }
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "done: $exe ($size MB)" -ForegroundColor Green
} finally {
    Pop-Location
}
