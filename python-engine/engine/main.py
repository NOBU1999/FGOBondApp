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
import sys
import time
from typing import Any, Dict, Optional

from . import calculator, data_fetcher, search
from .constants import DB_PATH
from .models import parse_request

# Windows 下 Python stdout/stderr 可能默认使用 GBK，导致 Electron 端中文乱码。
# 这里统一强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _progress(message: str) -> None:
    print(f"[progress] {message}", file=sys.stderr, flush=True)


def calculate_from_stdin(db_path: Optional[str] = None) -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("stdin 中没有收到 JSON 输入")
    data = json.loads(raw)
    return calculate(data, db_path=db_path)


def calculate(data: Dict[str, Any], db_path: Optional[str] = None) -> Dict[str, Any]:
    req = parse_request(data)
    _progress("正在加载本地数据...")
    ctx = calculator.load_context(db_path, region=req.server_region)

    if req.cost_limit < 50 or req.cost_limit > 200:
        raise ValueError("Cost上限需在50~200之间")

    # 策略 target_max 必须带目标从者
    if req.strategy == "target_max" and req.target_servant_id is None:
        raise ValueError("指定从者最大化策略需要提供 targetServantId")

    _progress("正在准备队伍布局...")
    result = search.search_top_teams(ctx, req, progress=_progress)
    if not result.get("top20"):
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


def update(db_path: Optional[str] = None, force: bool = False) -> Dict[str, Any]:
    _progress("正在检查数据更新...")
    result = data_fetcher.update_database(
        db_path=db_path,
        force=force,
        use_cache=True,
        progress=_progress,
    )
    _progress("数据更新完成" if result.get("updated") else "数据已是最新")
    return result


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="FGO 牵绊推荐计算引擎")
    parser.add_argument("--mode", default="calculate", choices=["calculate", "update"])
    parser.add_argument("--db", default=str(DB_PATH))
    parser.add_argument("--force-update", action="store_true")
    args = parser.parse_args(argv)

    start = time.time()
    try:
        if args.mode == "update":
            result = update(db_path=args.db, force=args.force_update)
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
