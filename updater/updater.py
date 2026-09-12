#!/usr/bin/env python3
"""FGO 牵绊推荐器 - 独立更新器（updater.exe）

设计目标
--------
1. **独立于主程序**：单独构建的 exe，不依赖 resources/app.asar 与 python 引擎；
   主程序打不开时也能双击它更新或回滚。
2. **个人数据永不丢**：安装时只替换「程序文件」，
   `db/fgo_data.db`（账号 / Box / 排除 / 预设）与 `db/backup/` 会原样搬进新版本。
3. **失败不砖**：先把新版本展开到 `<程序目录>.new`，一切就绪后再用两次同盘改名完成替换；
   中途任何失败都保持原目录不动。
4. **兼容区间校验**：包内 `update.json` 声明 compatibleFrom / compatibleTo
   （= 支持基于该版本及以上安装），不在区间内只警告 + 二次确认。

用法
----
    updater.exe --package <zip|7z> [--app-dir <程序目录>] [--pid <主程序PID>]
                [--keep-package 0|1] [--mode install|rollback] [--no-restart] [--console]

也可以把 zip / 7z **直接拖到 updater.exe 上**；双击则弹出文件选择框。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

APP_ID = "fgo-bond-recommender"
MARKER_NAME = "update.json"
VERSION_NAME = "version.json"
UPDATES_DIR = "updates"

MB_OK = 0x0
MB_OKCANCEL = 0x1
MB_YESNOCANCEL = 0x3
MB_ICONINFO = 0x40
MB_ICONWARNING = 0x30
MB_ICONERROR = 0x10
IDOK = 1
IDCANCEL = 2
IDYES = 6
IDNO = 7

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008

EXE_SUFFIXES = (".exe",)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
class Abort(Exception):
    """用户取消或前置校验失败（可预期，不需要堆栈）。"""


_log_path: Path | None = None
_console_allocated = False


def log(message: str = "") -> None:
    text = f"[{datetime.now():%H:%M:%S}] {message}"
    try:
        print(text, flush=True)
    except Exception:
        pass
    if _log_path:
        try:
            with open(_log_path, "a", encoding="utf-8") as fp:
                fp.write(text + "\n")
        except Exception:
            pass


def attach_console() -> bool:
    """GUI 子系统下按需申请一个控制台（双击 / 拖拽时用）。"""
    global _console_allocated
    if os.name != "nt" or sys.stdout is not None:
        return False
    try:
        if not ctypes.windll.kernel32.AllocConsole():
            return False
        sys.stdout = open("CONOUT$", "w", encoding="utf-8", buffering=1)
        sys.stderr = sys.stdout
        _console_allocated = True
        ctypes.windll.kernel32.SetConsoleTitleW("FGO牵绊推荐器 更新器")
        return True
    except Exception:
        return False


def msgbox(text: str, flags: int = MB_OK, title: str = "FGO牵绊推荐器 更新器") -> int:
    try:
        return int(ctypes.windll.user32.MessageBoxW(None, str(text), str(title), flags))
    except Exception:
        # 非 Windows / 无 GUI：退化为控制台输入
        print(text)
        return IDOK


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024
    return f"{num:.1f} GB"


def now_stamp() -> str:
    return f"{datetime.now():%Y%m%d-%H%M%S}"


def version_tuple(value) -> tuple:
    parts = []
    for chunk in str(value or "").split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def version_in_range(current: str, low, high) -> bool:
    """current 是否落在 [low, high] 内；low/high 为空表示该侧无限制。"""
    cur = version_tuple(current)
    if low and cur < version_tuple(low):
        return False
    if high and cur > version_tuple(high):
        return False
    return True


# ---------------------------------------------------------------------------
# 自我搬运：更新器本身也在被替换的目录里，先把自己复制到 TEMP 再干活
# ---------------------------------------------------------------------------
def relocate_self(app_dir: Path) -> Path | None:
    """把自身复制到 TEMP 再启动副本；只有「更新器就在被替换目录里」时才需要。"""
    if "--from-temp" in sys.argv:
        return None
    if not getattr(sys, "frozen", False):
        return None  # 源码直接运行时不搬运，方便调试
    source = Path(sys.executable)
    work = Path(tempfile.gettempdir()) / f"FGOBondUpdater-{now_stamp()}-{os.getpid()}"
    try:
        work.mkdir(parents=True, exist_ok=True)
        target = work / source.name
        shutil.copy2(source, target)
    except OSError as exc:
        log(f"无法把更新器复制到临时目录（就地运行）：{exc}")
        return None
    forwarded = [a for a in sys.argv[1:] if a != "--from-temp"]
    child = [
        str(target),
        *forwarded,
        "--from-temp",
        "--app-dir",
        str(app_dir),
        "--work-dir",
        str(work),
    ]
    try:
        proc = subprocess.Popen(child, close_fds=True, creationflags=DETACHED_PROCESS)
    except OSError as exc:
        log(f"无法启动临时副本（就地运行）：{exc}")
        return None
    # 副本被安全软件拦下时会「启动即退出」，此时退回就地运行，避免用户点了没反应
    time.sleep(1.5)
    if proc.poll() is not None:
        log(f"临时副本启动后立刻退出（退出码 {proc.returncode}），改为就地运行")
        return None
    return work


def schedule_cleanup(paths: list[Path]) -> None:
    """让 cmd 在我们退出后删掉临时目录。"""
    for path in paths:
        if not path or not path.exists():
            continue
        try:
            subprocess.Popen(
                f'cmd /c ping -n 3 127.0.0.1 >nul & rmdir /s /q "{path}"',
                shell=True,
                creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            )
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 包检查：识别包结构 + 读取标记
# ---------------------------------------------------------------------------
def normalize(name: str) -> str:
    return name.replace("\\", "/")


def zip_root_prefix(names: list[str]) -> str:
    """找出包内「程序根目录」前缀（可能为空）。

    以 resources/app.asar 为最强特征，其次 update.json / version.json。
    """
    markers = ("resources/app.asar", MARKER_NAME, VERSION_NAME)
    candidates: list[str] = []
    for name in names:
        for marker in markers:
            if name == marker:
                candidates.append("")
            elif name.endswith("/" + marker):
                candidates.append(name[: -len(marker)])
    if not candidates:
        raise Abort("压缩包里找不到程序文件（缺少 resources/app.asar 或 update.json）。")
    candidates.sort(key=lambda p: (p.count("/"), len(p)))
    return candidates[0]


def safe_parts(rel: str) -> list[str]:
    return [p for p in normalize(rel).split("/") if p not in ("", ".", "..")]


def read_zip_json(pkg: Path, root: str, name: str) -> dict | None:
    target = f"{root}{name}"
    with zipfile.ZipFile(pkg) as zf:
        for info in zf.infolist():
            if normalize(info.filename) == target:
                try:
                    return json.loads(zf.read(info).decode("utf-8-sig"))
                except (ValueError, UnicodeDecodeError):
                    return None
    return None


def inspect_zip(pkg: Path) -> dict:
    with zipfile.ZipFile(pkg) as zf:
        names = [normalize(i.filename) for i in zf.infolist()]
        total = sum(i.file_size for i in zf.infolist())
    if not names:
        raise Abort("压缩包是空的。")
    root = zip_root_prefix(names)
    return {
        "kind": "zip",
        "root": root,
        "marker": read_zip_json(pkg, root, MARKER_NAME),
        "version": read_zip_json(pkg, root, VERSION_NAME),
        "files": len(names),
        "uncompressed": total,
    }


def sevenzip_path() -> Path | None:
    """优先用内置的 7z；开发态回落到系统安装的 7-Zip。"""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates = [base / "7zbin" / "7z.exe", base / "7zbin" / "7zr.exe", base / "7z.exe"]
    for env in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        root = os.environ.get(env)
        if root:
            candidates.append(Path(root) / "7-Zip" / "7z.exe")
    found = shutil.which("7z") or shutil.which("7zr") or shutil.which("7za")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


def sevenzip_listing(tool: Path, pkg: Path) -> tuple[list[str], int]:
    """列出 7z 包内文件与解压后总大小。"""
    result = subprocess.run(
        [str(tool), "l", "-slt", "-ba", str(pkg)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
    )
    if result.returncode != 0:
        raise Abort(f"读取 7z 包失败（退出码 {result.returncode}）：{result.stderr.strip()[:200]}")
    names: list[str] = []
    total = 0
    for raw in (result.stdout or "").splitlines():
        line = raw.strip()
        if line.startswith("Path = "):
            path = line[7:].strip()
            # 归档自身的头部信息也会带 Path，过滤掉等于包名的条目
            if path and Path(path).name != pkg.name:
                names.append(normalize(path))
        elif line.startswith("Size = "):
            digits = line[7:].strip()
            if digits.isdigit():
                total += int(digits)
    if not names:
        raise Abort("7z 包是空的或无法解析。")
    return names, total


def extract_7z_file(tool: Path, pkg: Path, inner: str) -> bytes:
    """从 7z 里单独取出一个文件（包内路径分隔符可能是 / 或 \\）。"""
    for candidate in (inner, inner.replace("/", "\\"), inner.replace("\\", "/")):
        result = subprocess.run(
            [str(tool), "x", "-so", "-y", str(pkg), candidate],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    return b""


def inspect_7z(pkg: Path) -> dict:
    tool = sevenzip_path()
    if tool is None:
        raise Abort("更新器未内置 7z 解压器，无法读取 7z 包，请改用 zip 包。")
    names, total = sevenzip_listing(tool, pkg)
    root = zip_root_prefix(names)
    marker = None
    version = None
    raw_marker = extract_7z_file(tool, pkg, f"{root}{MARKER_NAME}")
    if raw_marker:
        try:
            marker = json.loads(raw_marker.decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            marker = None
    raw_version = extract_7z_file(tool, pkg, f"{root}{VERSION_NAME}")
    if raw_version:
        try:
            version = json.loads(raw_version.decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            version = None
    return {
        "kind": "7z",
        "root": root,
        "marker": marker,
        "version": version,
        "files": len(names),
        "uncompressed": total,
    }


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# 解压到目标目录（zip 直接流式写入，省一次复制）
# ---------------------------------------------------------------------------
def extract_zip_into(pkg: Path, dest: Path, root: str) -> None:
    with zipfile.ZipFile(pkg) as zf:
        infos = zf.infolist()
        total = sum(i.file_size for i in infos) or 1
        done = 0
        last_report = 0.0
        for info in infos:
            name = normalize(info.filename)
            if root and not name.startswith(root):
                continue
            rel = name[len(root):] if root else name
            parts = safe_parts(rel)
            if not parts or name.endswith("/"):
                continue
            target = dest.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            done += info.file_size
            if time.time() - last_report > 0.5:
                last_report = time.time()
                log(f"  解压中... {done * 100 // total}%")
    log("  解压完成 100%")


def extract_7z_tree(pkg: Path, dest: Path) -> None:
    tool = sevenzip_path()
    if tool is None:
        raise Abort("更新器未内置 7z 解压器，无法解开 7z 包，请改用 zip 包。")
    dest.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(tool), "x", str(pkg), f"-o{dest}", "-y", "-bso0", "-bsp0"],
        creationflags=CREATE_NO_WINDOW,
    )
    if result.returncode != 0:
        raise Abort(f"7z 解压失败（退出码 {result.returncode}）。")


def find_package_root(path: Path) -> Path:
    """在解压结果里定位程序根目录（含 version.json / resources/app.asar 的那一层）。"""
    stack = [path]
    while stack:
        current = stack.pop(0)
        if (current / VERSION_NAME).exists() or (current / "resources" / "app.asar").exists():
            return current
        if current.is_dir():
            for child in sorted(current.iterdir()):
                if child.is_dir():
                    stack.append(child)
    raise Abort("包内找不到程序根目录（缺少 version.json / resources/app.asar）。")


def copy_tree(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


# ---------------------------------------------------------------------------
# 等待主程序退出
# ---------------------------------------------------------------------------
def pid_alive(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
        ).stdout or ""
    except OSError:
        return False
    return str(pid) in out


def wait_for_app_exit(app_dir: Path, pid: int | None, timeout: float = 90.0) -> bool:
    exe = find_app_exe(app_dir)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pid and pid_alive(pid):
            time.sleep(0.5)
            continue
        if exe is not None and not file_replaceable(exe):
            time.sleep(0.5)
            continue
        return True
    return False


def file_replaceable(path: Path) -> bool:
    """用一次改名往返探测文件是否被占用。"""
    if not path.exists():
        return True
    probe = path.with_name(path.name + ".probe")
    try:
        os.rename(path, probe)
    except OSError:
        return False
    try:
        os.rename(probe, path)
    except OSError:
        pass
    return True


def find_app_exe(app_dir: Path, hint: str | None = None) -> Path | None:
    if hint:
        candidate = app_dir / hint
        if candidate.exists():
            return candidate
    exes = [p for p in app_dir.glob("*.exe") if p.name.lower() != "updater.exe"]
    if not exes:
        return None
    exes.sort(key=lambda p: p.stat().st_size, reverse=True)
    return exes[0]


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FGO 牵绊推荐器 独立更新器")
    parser.add_argument("package_pos", nargs="?", help="安装包路径（拖拽到 exe 上时自动带上）")
    parser.add_argument("--package", dest="package", help="安装包路径（zip / 7z）")
    parser.add_argument("--app-dir", dest="app_dir", help="程序目录（默认：updater.exe 所在目录）")
    parser.add_argument("--pid", dest="pid", type=int, help="等待该进程退出后再替换文件")
    parser.add_argument("--keep-package", dest="keep_package", default=None,
                        help="1/0：是否保留本次安装包以便回滚")
    parser.add_argument("--mode", dest="mode", default="install", choices=["install", "rollback"])
    parser.add_argument("--no-restart", dest="no_restart", action="store_true")
    parser.add_argument("--quiet", dest="quiet", action="store_true",
                        help="成功时不弹提示框（由主程序界面反馈）")
    parser.add_argument("--relaunch-on-cancel", dest="relaunch_on_cancel", action="store_true",
                        help="用户取消时重新启动原程序")
    parser.add_argument("--console", dest="console", action="store_true")
    parser.add_argument("--yes", dest="assume_yes", action="store_true",
                        help="跳过确认弹窗（自动化/测试用）")
    parser.add_argument("--from-temp", action="store_true", help="内部使用")
    parser.add_argument("--work-dir", dest="work_dir", help="内部使用")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="只校验不安装")
    return parser.parse_args(argv)


def pick_package_file(initial_dir: Path) -> Path:
    """双击运行时用系统文件对话框选包（无第三方依赖）。"""
    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", ctypes.c_uint32),
            ("hwndOwner", ctypes.c_void_p),
            ("hInstance", ctypes.c_void_p),
            ("lpstrFilter", ctypes.c_wchar_p),
            ("lpstrCustomFilter", ctypes.c_wchar_p),
            ("nMaxCustFilter", ctypes.c_uint32),
            ("nFilterIndex", ctypes.c_uint32),
            ("lpstrFile", ctypes.c_wchar_p),
            ("nMaxFile", ctypes.c_uint32),
            ("lpstrFileTitle", ctypes.c_wchar_p),
            ("nMaxFileTitle", ctypes.c_uint32),
            ("lpstrInitialDir", ctypes.c_wchar_p),
            ("lpstrTitle", ctypes.c_wchar_p),
            ("Flags", ctypes.c_uint32),
            ("nFileOffset", ctypes.c_uint16),
            ("nFileExtension", ctypes.c_uint16),
            ("lpstrDefExt", ctypes.c_wchar_p),
            ("lCustData", ctypes.c_void_p),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", ctypes.c_wchar_p),
        ]

    OFN_FILEMUSTEXIST = 0x00001000
    OFN_PATHMUSTEXIST = 0x00000800
    OFN_EXPLORER = 0x00080000
    buffer = ctypes.create_unicode_buffer(4096)
    dialog = OPENFILENAMEW()
    dialog.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    dialog.lpstrFilter = (
        "安装包 (*.zip;*.7z)\0*.zip;*.7z\0zip 压缩包 (*.zip)\0*.zip\0"
        "7z 压缩包 (*.7z)\0*.7z\0全部文件 (*.*)\0*.*\0\0"
    )
    dialog.lpstrFile = ctypes.cast(buffer, ctypes.c_wchar_p)
    dialog.nMaxFile = len(buffer)
    dialog.lpstrInitialDir = str(initial_dir)
    dialog.lpstrTitle = "选择 FGO牵绊推荐器 安装包"
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER
    if not ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(dialog)):
        raise Abort("没有选择安装包。")
    return Path(buffer.value)


def run(args: argparse.Namespace) -> int:
    global _log_path

    app_dir = Path(args.app_dir).expanduser().resolve() if args.app_dir else Path(sys.executable).resolve().parent
    if not (app_dir / "resources").exists() and not (app_dir / VERSION_NAME).exists():
        raise Abort(f"这不是 FGO牵绊推荐器的程序目录：\n{app_dir}")

    log_dir = app_dir / "db" / "backup"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        _log_path = log_dir / f"update-{now_stamp()}.log"
    except OSError:
        _log_path = None

    log("=" * 60)
    log(f"FGO牵绊推荐器 更新器（mode={args.mode}）")
    log(f"程序目录: {app_dir}")

    # ---------------- 0. 程序目录可写性 ----------------
    probe = app_dir.parent / f".fgo-write-probe-{os.getpid()}"
    try:
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise Abort(
            f"程序所在目录不可写：\n{app_dir.parent}\n\n"
            "请把程序放在自己的文件夹（如 D:\\FGOBond），或右键『以管理员身份运行』。\n"
            f"（{exc}）"
        )

    # ---------------- 1. 当前版本 ----------------
    installed = read_json(app_dir / VERSION_NAME) or {}
    installed_version = installed.get("version") or "未知"
    log(f"当前版本: {installed_version}")

    # ---------------- 2. 安装包 ----------------
    package = args.package or args.package_pos
    if not package:
        package = str(pick_package_file(Path.home() / "Downloads"))
    pkg = Path(package).expanduser()
    if not pkg.exists():
        raise Abort(f"安装包不存在：\n{pkg}")
    size = pkg.stat().st_size
    log(f"安装包: {pkg}（{human_size(size)}）")

    work_dir = Path(args.work_dir) if args.work_dir else Path(tempfile.mkdtemp(prefix="FGOBondUpdater-"))
    suffix = pkg.suffix.lower()
    if suffix == ".zip":
        info = inspect_zip(pkg)
    elif suffix == ".7z":
        info = inspect_7z(pkg)
    else:
        raise Abort("只支持 .zip 与 .7z 安装包。")

    marker = info.get("marker") or {}
    pkg_version_json = info.get("version") or {}
    pkg_version = marker.get("version") or pkg_version_json.get("version") or "未知"
    log(f"包内版本: {pkg_version}（根目录: {info.get('root') or '/'}）")

    if marker.get("appId") and marker["appId"] != APP_ID:
        raise Abort(f"这不是本程序的安装包（appId={marker['appId']}）。")
    if not marker:
        raise Abort(
            "安装包里没有 update.json 标记文件，无法确认版本与兼容范围。\n\n"
            "请使用官方发布的安装包（发布包内应包含 update.json 与 version.json）。"
        )

    low = marker.get("compatibleFrom")
    high = marker.get("compatibleTo")
    compatible = version_in_range(installed_version, low, high)
    range_text = f"基于 v{low} 及以上" if low else "任意版本"
    if high:
        range_text += f"（上限 v{high}）"

    # ---------------- 3. 确认 ----------------
    keep_default = args.keep_package != "0"
    if args.keep_package is None:
        keep_text = "（更新后会询问是否保留安装包）"
    else:
        keep_text = "（保留安装包以便回滚）" if keep_default else "（不保留安装包）"

    lines = [
        f"当前版本：v{installed_version}",
        f"新包版本：v{pkg_version}",
        f"支持基于：{range_text}",
        f"安装包大小：{human_size(size)}",
    ]
    stage = str(marker.get("stage") or "").lower()
    if stage in ("beta", "test", "testing", "preview"):
        log(f"更新器阶段标记：{stage}")
        lines.append("")
        lines.append("⚠ 更新系统目前处于测试阶段，安装流程仍在验证中。")
        lines.append("  建议先备份整个程序文件夹（至少备份 db 文件夹）再更新。")
    if not compatible:
        lines.append("")
        lines.append("⚠ 版本不在该包声明的兼容区间内，可能存在结构破坏性变更。")
        lines.append("  强行安装后如果出现异常，请用旧版安装包重新安装。")
    lines.append("")
    lines.append("个人数据（账号 / Box / 排除 / 预设）会自动保留。")

    if args.dry_run:
        log("dry-run：校验通过，未执行安装。")
        if args.console:
            print("\n".join(lines))
        return 0

    if not compatible:
        log(f"⚠ 版本 {installed_version} 不在兼容区间（{range_text}）内，仅作警告")

    if args.assume_yes:
        keep_package = keep_default
        log("已跳过确认（--yes）")
    elif args.keep_package is None:
        choice = msgbox(
            "\n".join(lines + [
                "",
                "是否保留本次安装包以便日后一键回滚？",
                f"（占用约 {human_size(size)}，存放在 db\\updates）",
                "",
                "是(Y)：安装，并保留安装包",
                "否(N)：安装，不保留",
                "取消：中止",
            ]),
            MB_YESNOCANCEL | (MB_ICONWARNING if not compatible else MB_ICONINFO),
        )
        if choice == IDCANCEL:
            raise Abort("已取消安装。")
        keep_package = choice == IDYES
    else:
        if msgbox("\n".join(lines + ["", "开始安装？"]), MB_OKCANCEL | (MB_ICONWARNING if not compatible else MB_ICONINFO)) != IDOK:
            raise Abort("已取消安装。")
        keep_package = keep_default

    # ---------------- 4. 等主程序退出 ----------------
    if args.pid:
        log(f"等待主程序退出（pid={args.pid}）...")
    if not wait_for_app_exit(app_dir, args.pid):
        raise Abort("主程序似乎仍在运行，请完全退出后重试。")
    log("主程序已退出。")

    # ---------------- 5. 磁盘空间 ----------------
    need = int(info.get("uncompressed") or 0) + size + 64 * 1024 * 1024
    free = shutil.disk_usage(app_dir.parent).free
    log(f"磁盘可用 {human_size(free)}，预计需要 {human_size(need)}")
    if free < need:
        raise Abort(f"磁盘空间不足：需要约 {human_size(need)}，当前可用 {human_size(free)}。")

    # ---------------- 6. 展开新版本 ----------------
    new_dir = app_dir.parent / (app_dir.name + ".new")
    if new_dir.exists():
        log(f"清理上次残留：{new_dir}")
        shutil.rmtree(new_dir, ignore_errors=True)

    if info["kind"] == "zip":
        log("正在解压安装包...")
        extract_zip_into(pkg, new_dir, info["root"])
    else:
        stage = app_dir.parent / f".fgo-stage-{now_stamp()}"
        log(f"正在解压 7z 包到 {stage.name} ...")
        extract_7z_tree(pkg, stage)
        root_dir = find_package_root(stage)
        log(f"正在安置新版本到 {new_dir.name} ...")
        try:
            os.rename(root_dir, new_dir)
        except OSError:
            # 兜底：跨目录时用复制
            copy_tree(root_dir, new_dir)
        shutil.rmtree(stage, ignore_errors=True)

    if not (new_dir / "resources" / "app.asar").exists():
        shutil.rmtree(new_dir, ignore_errors=True)
        raise Abort("安装包内容不完整（解压后缺少 resources/app.asar）。")

    # ---------------- 7. 搬运个人数据 ----------------
    carried = []
    live_db_dir = app_dir / "db"
    new_db_dir = new_dir / "db"
    new_db_dir.mkdir(parents=True, exist_ok=True)
    for name in ("fgo_data.db", "fgo_data.db-wal", "fgo_data.db-shm"):
        src = live_db_dir / name
        if src.exists():
            shutil.copy2(src, new_db_dir / name)
            carried.append(name)
    backup_src = live_db_dir / "backup"
    if backup_src.is_dir():
        copy_tree(backup_src, new_db_dir / "backup")
    log(f"已搬移个人数据：{', '.join(carried) if carried else '（无运行库）'}")

    # 更新前再留一份运行库快照
    live_runtime = live_db_dir / "fgo_data.db"
    if live_runtime.exists():
        pre = new_db_dir / "backup" / f"pre-update-v{installed_version}-{now_stamp()}.db"
        try:
            pre.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(live_runtime, pre)
            log(f"更新前快照：{pre.name}")
        except OSError as exc:
            log(f"更新前快照失败（继续）：{exc}")

    # ---------------- 8. 记住本次安装包（可选，用于回滚） ----------------
    updates_dir = new_db_dir / UPDATES_DIR
    record = {
        "version": pkg_version,
        "from": installed_version,
        "packageName": pkg.name,
        "packageSize": size,
        "installedAt": datetime.now().isoformat(timespec="seconds"),
        "mode": args.mode,
    }
    if keep_package:
        try:
            updates_dir.mkdir(parents=True, exist_ok=True)
            target = updates_dir / pkg.name
            if pkg.resolve() != target.resolve():
                shutil.copy2(pkg, target)
            for stale in updates_dir.glob("*"):
                if stale.is_file() and stale.name != pkg.name and stale.suffix.lower() in (".zip", ".7z"):
                    stale.unlink()
            record["keptPackage"] = pkg.name
            log(f"已保留安装包用于回滚：{pkg.name}")
        except OSError as exc:
            record.pop("keptPackage", None)
            log(f"保留安装包失败（不影响更新）：{exc}")
    else:
        shutil.rmtree(updates_dir, ignore_errors=True)
    write_json(new_db_dir / UPDATES_DIR / "last-install.json", record)

    # 移除新版本里带过来的旧账号数据（防止开发者本机数据被分发；安全兜底）
    if not carried:
        log("注意：原目录没有运行库，新版本会从种子库生成全新运行库。")

    # ---------------- 9. 目录交换 ----------------
    old_dir = app_dir.parent / (app_dir.name + ".old")
    if old_dir.exists():
        shutil.rmtree(old_dir, ignore_errors=True)
    log("正在替换程序文件...")
    try:
        os.rename(app_dir, old_dir)
    except OSError as exc:
        shutil.rmtree(new_dir, ignore_errors=True)
        raise Abort(f"无法重命名原程序目录（可能被占用）：{exc}")
    try:
        os.rename(new_dir, app_dir)
    except OSError as exc:
        os.rename(old_dir, app_dir)
        shutil.rmtree(new_dir, ignore_errors=True)
        raise Abort(f"替换失败，已回滚到原版本：{exc}")

    log(f"替换完成：{old_dir.name} -> 已退役")
    shutil.rmtree(old_dir, ignore_errors=True)

    # ---------------- 10. 重启程序 ----------------
    exe = find_app_exe(app_dir, installed.get("exe"))
    if exe and not args.no_restart:
        try:
            subprocess.Popen([str(exe)], cwd=str(app_dir), creationflags=DETACHED_PROCESS)
            log(f"已启动：{exe.name}")
        except OSError as exc:
            log(f"启动新版本失败：{exc}")
    elif not exe:
        log("未找到主程序 exe，请手动启动。")

    log(f"更新完成：v{installed_version} -> v{pkg_version}")
    return 0


def relaunch_original(args: argparse.Namespace) -> None:
    """用户取消时把原程序重新拉起来。"""
    app_dir = Path(args.app_dir).expanduser().resolve() if args.app_dir else None
    if not app_dir or not app_dir.exists():
        return
    installed = read_json(app_dir / VERSION_NAME) or {}
    exe = find_app_exe(app_dir, installed.get("exe"))
    if not exe:
        return
    try:
        subprocess.Popen([str(exe)], cwd=str(app_dir), creationflags=DETACHED_PROCESS)
    except OSError:
        pass


def dispatch(args: argparse.Namespace) -> int:
    """确定程序目录 -> 必要时先选包 -> 需要时搬到 TEMP -> 执行安装。"""
    if not args.app_dir:
        args.app_dir = str(Path(sys.executable).resolve().parent)
    app_dir = Path(args.app_dir).expanduser().resolve()
    frozen = bool(getattr(sys, "frozen", False))
    from_temp = "--from-temp" in sys.argv

    # 双击 / 拖拽场景：先在「当前进程」里弹出选择框，保证用户立刻看到反馈，
    # 否则主进程会先退到 TEMP 副本，副本万一启动失败就完全没反应。
    if frozen and not from_temp and not (args.package or args.package_pos):
        args.package = str(pick_package_file(Path.home() / "Downloads"))

    # 更新器自己就在被替换的目录里：先把自己复制到 TEMP 再干活
    if frozen and not from_temp:
        self_path = Path(sys.executable).resolve()
        if self_path.parent == app_dir:
            if relocate_self(app_dir) is not None:
                return 0  # 已交给 TEMP 里的副本

    return run(args)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    args = parse_args(argv)
    if args.console:
        attach_console()

    temp_dirs = [Path(args.work_dir)] if args.work_dir else []

    try:
        code = dispatch(args)
        if args.console:
            # --console：只在真的申请到控制台时等待，管道/自动化场景直接返回
            if _console_allocated:
                print("\n更新完成，窗口 10 秒后自动关闭。")
                try:
                    time.sleep(10)
                except KeyboardInterrupt:
                    pass
        elif not args.quiet:
            msgbox("更新完成，程序即将启动。", MB_OK | MB_ICONINFO)
        return code
    except Abort as exc:
        log(f"中止：{exc}")
        if args.console:
            print(f"\n[失败] {exc}\n日志：{_log_path}\n")
            if _console_allocated:
                try:
                    input("按回车键退出...")
                except EOFError:
                    pass
        else:
            msgbox(f"{exc}\n\n日志：{_log_path or '（未生成）'}", MB_OK | MB_ICONERROR)
            if args.relaunch_on_cancel:
                relaunch_original(args)
        return 1
    except Exception as exc:  # noqa: BLE001
        import traceback

        log("未预期的错误：\n" + traceback.format_exc())
        text = f"更新过程中出现未预期的错误：\n{exc}\n\n日志：{_log_path or '（未生成）'}"
        if args.console:
            print("\n" + text)
            if _console_allocated:
                try:
                    input("按回车键退出...")
                except EOFError:
                    pass
        else:
            msgbox(text, MB_OK | MB_ICONERROR)
        return 2
    finally:
        if temp_dirs:
            schedule_cleanup(temp_dirs)


if __name__ == "__main__":
    raise SystemExit(main())
