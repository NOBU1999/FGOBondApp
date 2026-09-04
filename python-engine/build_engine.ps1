# 构建 python-engine/engine.exe
# 说明：会先尝试升级 NumPy，确保打包时使用当前/最新已安装版本。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 升级/安装 NumPy（保留后续升级空间；若不想联网升级可注释下一行）
python -m pip install --upgrade numpy

# 使用 spec 打包（自动收集 numpy 等依赖）
python -m PyInstaller --clean --noconfirm pyinstaller.spec

# 将 dist/engine.exe 放到 python-engine/engine.exe（便携目录最终位置）
New-Item -ItemType Directory -Force -Path . | Out-Null
Copy-Item -Force .\dist\engine.exe .\engine.exe
Write-Host "engine.exe built: $PSScriptRoot\engine.exe"
