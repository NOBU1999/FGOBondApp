"""Task 2：Python 计算引擎入口。

启动方式（任务书要求）：
    engine.exe --mode=calculate

通信协议：
- stdin：输入 JSON（单行或完整 JSON）
- stdout：结果 JSON
- stderr：进度/日志，Electron 转发给前端
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, Optional

from . import calculator, data_fetcher, search
from .constants import DB_PATH
from .models import parse_request

# Windows 下 Python stdout/stderr 可能默认使用 GBK，导致 Electron 端中文乱码。
# 这里统一强制 UTF-8 输出（stdin 见 calculate_from_stdin 的说明）。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


def _progress(message: str) -> None:
    print(f"[progress] {message}", file=sys.stderr, flush=True)


def _read_stdin_text() -> str:
    """把 stdin 读成文本。

    ⚠️ **必须按字节读、再显式按 UTF-8 解码**：JSON 规范要求 UTF-8，而 Windows 上 Python
    默认按系统码页（简中 = cp936）解 stdin —— 请求里只要出现一个非 ASCII 字符就会被解错，
    表现是 `Invalid \\escape: line 1 column …`（2026-10-11 实测：超级模式的 stopFile 路径带
    中文目录名就踩到了）。
    ⚠️ 也别指望 `PYTHONIOENCODING` / `PYTHONUTF8` 兜底：冻结版 exe 实测两者都不生效。
    """
    stream = getattr(sys.stdin, "buffer", None)
    if stream is not None:
        return stream.read().decode("utf-8", errors="replace")
    return sys.stdin.read()  # 测试替身（StringIO 之类）没有 buffer


def calculate_from_stdin(db_path: Optional[str] = None) -> Dict[str, Any]:
    raw = _read_stdin_text()
    if not raw.strip():
        raise ValueError("stdin 中没有收到 JSON 输入")
    data = json.loads(raw)
    # 超级模式：宿主（桌面宿主点了"停止"）会建一个停止文件；引擎发现它就把当前搜索收尾，
    # 返回已经算出来的结果（status="partial"），而不是被直接杀掉、白算一场。
    # ⚠️ 只在超级模式下接这个开关：普通档位保持原来的"杀进程"语义，避免误伤。
    should_cancel = None
    try:
        super_on = float(data.get("superMode") or 0) > 1.0
    except (TypeError, ValueError):
        super_on = False
    stop_file = str(data.get("stopFile") or "").strip()
    if super_on and stop_file:
        def should_cancel() -> bool:  # noqa: ANN001
            try:
                return os.path.exists(stop_file)
            except Exception:  # noqa: BLE001
                return False

    return calculate(data, db_path=db_path, should_cancel=should_cancel)


def calculate(
    data: Dict[str, Any],
    db_path: Optional[str] = None,
    should_cancel: Optional[Any] = None,
) -> Dict[str, Any]:
    req = parse_request(data)
    _progress("正在加载本地数据...")
    ctx = calculator.load_context(db_path, region=req.server_region)

    if req.cost_limit < 50 or req.cost_limit > 200:
        raise ValueError("Cost上限需在50~200之间")

    # 策略 target_max 必须带目标从者
    if req.strategy == "target_max" and req.target_servant_id is None:
        raise ValueError("指定从者最大化策略需要提供 targetServantId")

    _progress("正在准备队伍布局...")
    result = search.search_top_teams(ctx, req, progress=_progress, should_cancel=should_cancel)
    # 超级模式下用户点了"停止"：这时可能还一支队伍都没评出来 —— 那也是有效结果
    # （返回部分结果，界面会说明"已停止、还没算出队伍"），不要当成配置错误。
    if not result.get("top20") and result.get("status") != "partial":
        raise ValueError("当前配置下无法组成任何队伍，请提高Cost上限或调整Box/固定配置")

    _progress("生成验证串...")
    try:
        from .verification import make_verification_tokens
        tokens = make_verification_tokens(ctx, data, result)
        result["verificationToken"] = tokens.get("repro", "")
        result["verificationTokenFull"] = tokens.get("full", "")
    except Exception:
        # 旧引擎/缺依赖时不应影响正常计算；只是没有验证串可复制。
        result["verificationToken"] = ""
        result["verificationTokenFull"] = ""

    _progress("计算完成")
    return result


def update(db_path: Optional[str] = None) -> Dict[str, Any]:
    _progress("正在下载并重建数据...")
    result = data_fetcher.update_database(
        db_path=db_path,
        use_cache=True,
        progress=_progress,
    )
    _progress("数据更新完成")
    return result


def check(db_path: Optional[str] = None) -> Dict[str, Any]:
    _progress("正在检查远程数据...")
    result = data_fetcher.check_update(db_path=db_path)
    _progress("检查完成")
    return result


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="FGO 牵绊推荐计算引擎")
    parser.add_argument("--mode", default="calculate", choices=["calculate", "check", "update"])
    parser.add_argument("--db", default=str(DB_PATH))
    args = parser.parse_args(argv)

    start = time.time()
    try:
        if args.mode == "check":
            result = check(db_path=args.db)
        elif args.mode == "update":
            result = update(db_path=args.db)
        else:
            result = calculate_from_stdin(db_path=args.db)
        result.setdefault("status", "success")
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        error_result = {
            "status": "error",
            "message": str(exc),
            "elapsed": round(time.time() - start, 3),
        }
        print(json.dumps(error_result, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
