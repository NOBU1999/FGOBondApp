# Build python-engine/engine.exe
#
# NOTE (ASCII-only on purpose): Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
# so Chinese comments can be garbled and swallow the next code line (that silently
# skipped the PyInstaller step once). Keep this file ASCII-only.
#
# 2026-09-19 slimming: this script used to run `pip install --upgrade numpy` first,
# which wasted a 12.7MB download every rebuild and packed numpy (never used by the
# engine) into the exe: engine.exe 16.9MB -> 32.3MB, i.e. every player downloaded
# 13~15MB extra. For numerical experiments install into a dev environment instead,
# never into the shipped engine.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

python -m PyInstaller --clean --noconfirm pyinstaller.spec
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed (exit code $LASTEXITCODE)"
}

New-Item -ItemType Directory -Force -Path . | Out-Null
Copy-Item -Force .\dist\engine.exe .\engine.exe

$size = [math]::Round((Get-Item .\engine.exe).Length / 1MB, 1)
Write-Host "engine.exe built: $PSScriptRoot\engine.exe ($size MB)"
