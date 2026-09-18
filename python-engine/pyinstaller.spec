# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包脚本：python-engine/engine.exe

只收集引擎真正用到的依赖（cryptography / pyppmd）。
2026-09-19 瘦身：原来这里有一段「若装了 numpy 就 collect_all 打进 exe」的逻辑，
但引擎代码 0 处使用 numpy，白白让 engine.exe 从 17MB 涨到 32MB → 已删除。
哪天真要向量化计算，先评估安卓端（Chaquopy）体积/ABI 代价，再决定是否加回来。
"""

from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

# 验证串加密：cryptography 依赖（Fernet/AES）
try:
    crypto_datas, crypto_binaries, crypto_hidden = collect_all("cryptography")
    datas += crypto_datas
    binaries += crypto_binaries
    hiddenimports += crypto_hidden
except ImportError:
    pass

# 验证串压缩：PPMd
try:
    ppmd_datas, ppmd_binaries, ppmd_hidden = collect_all("pyppmd")
    datas += ppmd_datas
    binaries += ppmd_binaries
    hiddenimports += ppmd_hidden
except ImportError:
    pass

# Chaldea 翻译表（JP 数据 -> CN 显示名）
datas += [("engine/data/name_translations.json", "engine/data")]
hiddenimports += ["engine.event_bonus", "engine.verification"]

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
