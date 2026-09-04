# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包脚本：python-engine/engine.exe

构建前若已安装 NumPy，本 spec 会自动收集 NumPy 并打入 exe；
若未安装，则构建不含 NumPy 的精简版。后续升级 NumPy 后重新执行本脚本即可。
"""

from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

# 可选 NumPy：保留“升级安装 NumPy 后再打包”的能力
try:
    import numpy
    numpy_datas, numpy_binaries, numpy_hidden = collect_all("numpy")
    datas += numpy_datas
    binaries += numpy_binaries
    hiddenimports += numpy_hidden
except ImportError:
    pass

# Chaldea 翻译表（JP 数据 -> CN 显示名）
datas += [("engine/data/name_translations.json", "engine/data")]
hiddenimports += ["engine.event_bonus"]

a = Analysis(
    ["engine_launcher.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
