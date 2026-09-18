"""安卓（Chaquopy）宿主用的 Python 入口。

设计原则：**协议与桌面完全一致** —— 输入一份请求 JSON，输出一份结果 JSON
（见 shared/contracts/engine-protocol.md）。桌面走 stdin/stdout 子进程，
安卓走 Java → Python 的函数调用，仅传输方式不同。

由 android/app/src/main/java/.../PythonEnginePlugin.java 通过
    Python.getInstance().getModule("fgo_engine_bridge").callAttr("calculate", dbPath, requestJson)
调用。
"""

from __future__ import annotations

import json
from typing import Any, Dict

from engine.main import calculate as _calculate

# 协作式取消标志：Java 侧 cancel() 会调 set_cancel(True)，
# 引擎在搜索循环里通过 should_cancel 回调读到它并尽快返回。
_CANCEL = False


def set_cancel(value: bool) -> None:
    """由 Java 侧调用（可能在另一线程）：请求取消当前计算。"""
    global _CANCEL
    _CANCEL = bool(value)


def _should_cancel() -> bool:
    return _CANCEL


def calculate(database_path: str, request_json: str) -> str:
    """返回结果 JSON 字符串；出错时返回 {"status":"error","message":...}（与桌面一致）。"""
    global _CANCEL
    _CANCEL = False
    try:
        data: Dict[str, Any] = json.loads(request_json)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"status": "error", "message": f"请求 JSON 解析失败：{exc}"}, ensure_ascii=False)

    try:
        result = _calculate(data, db_path=database_path, should_cancel=_should_cancel)
        result.setdefault("status", "success")
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"status": "error", "message": str(exc)}, ensure_ascii=False)


def engine_info() -> str:
    """给宿主做自检用：返回版本与可用性信息。"""
    import sys

    info = {"python": sys.version.split()[0], "ok": True}
    try:
        from engine.constants import SCHEMA_VERSION  # type: ignore

        info["schemaVersion"] = SCHEMA_VERSION
    except Exception:  # noqa: BLE001
        pass
    return json.dumps(info, ensure_ascii=False)
