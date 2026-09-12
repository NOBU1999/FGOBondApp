# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：FGO 牵绊推荐器 独立更新器。

产物：updater/dist/updater.exe（单文件、GUI 子系统，不弹控制台黑框；
双击时脚本会自行 AllocConsole 显示进度）。

内置 7z 解压器：把 7-Zip 的 7z.exe + 7z.dll 打进 _MEIPASS/7zbin/，
这样 zip 与 7z 两种安装包都能直接安装。

    python -m PyInstaller --clean --noconfirm updater.spec
"""

import os
from pathlib import Path

HERE = Path(os.path.abspath(SPECPATH))  # noqa: F821  (PyInstaller 注入)

SEVENZIP_CANDIDATES = [
    Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "7-Zip",
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "7-Zip",
]

binaries = []
sevenzip_dir = next((p for p in SEVENZIP_CANDIDATES if (p / "7z.exe").exists()), None)
if sevenzip_dir is None:
    raise SystemExit("找不到 7-Zip（需要 7z.exe + 7z.dll）用于内置解压器")
binaries.append((str(sevenzip_dir / "7z.exe"), "7zbin"))
if (sevenzip_dir / "7z.dll").exists():
    binaries.append((str(sevenzip_dir / "7z.dll"), "7zbin"))
if (sevenzip_dir / "License.txt").exists():
    binaries.append((str(sevenzip_dir / "License.txt"), "7zbin"))

a = Analysis(  # noqa: F821
    [str(HERE / "updater.py")],
    pathex=[str(HERE)],
    binaries=binaries,
    datas=[],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc", "doctest", "email", "http", "xml"],
    noarchive=False,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="updater",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,  # GUI 子系统：不闪黑框；需要时脚本自己 AllocConsole
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
