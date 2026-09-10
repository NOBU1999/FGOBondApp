"""计算复现验证串。

用途
----
一次计算完成后，把“本次请求参数 + 本次使用的完整静态数据快照 + 本次结果的精简基线”
打包成一个可复制字符串。用户在本机用 reproduce_verification.py 解码后，
用同一份快照重建 DataContext 并重新运行搜索，再把重跑结果与原始基线对比，
用于验证/定位 bug。

说明
----
v3 起默认只做 PPMd 压缩 + Base64URL 编码，不再加密。
- 优点：实现简单，和加密版体积差距很小；密码/密钥不再是问题。
- 缺点：没有防篡改校验，复制不完整时可能解码失败或得到错误结果；字符串本身
  也不算隐私保护，分享前自行确认其中的 Box/静态数据可以公开。
- 兼容：v1（zlib+Fernet）、v2（PPMd+Fernet）旧验证串仍可正常解码。
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import zlib
from typing import Any, Dict, List, Optional

from .calculator import CraftInfo, DataContext, ServantInfo

try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception:  # pragma: no cover - 旧引擎无 cryptography 时降级
    Fernet = None
    InvalidToken = Exception

try:
    import pyppmd
except Exception:  # pragma: no cover - 缺依赖时旧格式仍可解密
    pyppmd = None


# v1：zlib + Fernet（旧格式，继续支持解密）
# v2：PPMd + Fernet（继续支持解密）
# v3：PPMd + Base64URL（当前默认，不加密）
_PREFIX_V1 = "FGOBONDV1."
_PREFIX_V2 = "FGOBONDV2."
_PREFIX_V3 = "FGOBONDV3."
_PREFIX = _PREFIX_V1  # 兼容旧代码引用
_FORMAT_VERSION = 1
_APP_SECRET = "FGOBondApp-local-verification-v1"
_PPMD_ORDER = 16
_PPMD_MEM = 16 << 20


def _fernet_key() -> bytes:
    digest = hashlib.sha256(_APP_SECRET.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _fernet() -> Fernet:
    if Fernet is None:
        raise RuntimeError("缺少 cryptography 依赖，无法解密 v1/v2 验证串")
    return Fernet(_fernet_key())


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii")


def _b64url_decode(text: str) -> bytes:
    text = text.strip()
    text += "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


def _jsonable(value: Any) -> Any:
    """把 dict key / set / tuple 等转成可 JSON 序列化结构。"""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (set, tuple, frozenset)):
        return sorted(_jsonable(v) for v in value)
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def _ctx_snapshot(ctx: DataContext) -> Dict[str, Any]:
    """把运行时 DataContext 序列化为自包含快照。"""
    servants = []
    for sid in sorted(ctx.servants):
        info = ctx.servants[sid]
        traits = {
            stage: sorted(set(traits))
            for stage, traits in sorted(info.traits.items())
        }
        servants.append(
            {
                "id": info.id,
                "name": info.name,
                "class": info.servant_class,
                "cost": info.cost,
                "rarity": info.rarity,
                "traits": traits,
            }
        )
    crafts = []
    for cid in sorted(ctx.crafts):
        c = ctx.crafts[cid]
        crafts.append(
            {
                "id": c.id,
                "name": c.name,
                "cost": c.cost,
                "rarity": c.rarity,
                "bonusType": c.bonus_type,
                "bonusValue": c.bonus_value,
                "supportBonus": c.support_bonus,
                "triggerTraits": c.trigger_traits,
                "isBondCe": c.is_bond_ce,
                "detail": c.detail,
                "isEventLimited": c.is_event_limited,
                "flatBonus": c.flat_bonus,
                "repeatable": c.repeatable,
                "isCustom": c.is_custom,
            }
        )
    return {"servants": servants, "crafts": crafts}


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _trim_snapshot_for_request(
    snapshot: Dict[str, Any],
    request_data: Dict[str, Any],
) -> Dict[str, Any]:
    """按本次请求裁剪快照，避免把整个游戏数据都塞进验证串。

    保留：
    - Box / 固定 / 手动助战 / 指定从者的完整数据（搜索确实需要这些从者的特性和 Cost）；
    - 自动助战选择所需的全体从者“ID + 职阶”骨架（不保留特性，体积很小）；
    - 所有牵绊礼装 + 被固定/助战引用的其他礼装 + 合成占位礼装。
    """
    request_data = request_data or {}
    keep_servant_ids: set = set()

    for raw in request_data.get("box") or []:
        if isinstance(raw, dict):
            sid = _int_or_none(raw.get("id"))
        else:
            sid = _int_or_none(raw)
        if sid is not None:
            keep_servant_ids.add(sid)

    for raw in request_data.get("fixedServants") or []:
        if isinstance(raw, dict):
            sid = _int_or_none(raw.get("servantId") if raw.get("servantId") is not None else raw.get("id"))
        else:
            sid = _int_or_none(raw)
        if sid is not None:
            keep_servant_ids.add(sid)

    support = request_data.get("support")
    manual_support_id: Optional[int] = None
    support_craft_ids: set = set()
    if isinstance(support, dict):
        manual_support_id = _int_or_none(support.get("servantId"))
        if manual_support_id is not None:
            keep_servant_ids.add(manual_support_id)
        for key in ("craftId", "secondCraftId"):
            cid = _int_or_none(support.get(key))
            if cid is not None:
                support_craft_ids.add(cid)

    target_id = _int_or_none(request_data.get("targetServantId") or request_data.get("target_servant_id"))
    if target_id is not None:
        keep_servant_ids.add(target_id)

    fixed_craft_ids: set = set()
    for raw in request_data.get("fixedCrafts") or []:
        if isinstance(raw, dict):
            cid = _int_or_none(raw.get("craftId") if raw.get("craftId") is not None else raw.get("id"))
        else:
            cid = _int_or_none(raw)
        if cid is not None:
            fixed_craft_ids.add(cid)

    # 自动助战要从全体从者里按职阶选 ID 最小者；保留“ID + 职阶”骨架即可。
    need_all_servant_ids = manual_support_id is None
    new_servants = []
    for s in snapshot.get("servants") or []:
        sid = _int_or_none(s.get("id"))
        if sid in keep_servant_ids:
            new_servants.append(s)
        elif need_all_servant_ids:
            new_servants.append(
                {
                    "id": s.get("id"),
                    "name": "",
                    "class": s.get("class") or "",
                    "cost": 0,
                    "rarity": 0,
                    "traits": {},
                }
            )

    keep_craft_ids = {0, -1, -2, -3, -4, -5, -10, -20, -21, -22}
    keep_craft_ids |= fixed_craft_ids
    keep_craft_ids |= support_craft_ids
    for c in snapshot.get("crafts") or []:
        if c.get("isBondCe"):
            cid = _int_or_none(c.get("id"))
            if cid is not None:
                keep_craft_ids.add(cid)
    new_crafts = [
        c for c in (snapshot.get("crafts") or [])
        if _int_or_none(c.get("id")) in keep_craft_ids
    ]

    return {"servants": new_servants, "crafts": new_crafts}


def load_context_from_snapshot(snapshot: Dict[str, Any]) -> DataContext:
    """从验证串中的快照重建 DataContext。"""
    ctx = DataContext()
    for raw in snapshot.get("servants") or []:
        sid = int(raw["id"])
        traits = {
            str(stage): set(str(t) for t in traits)
            for stage, traits in (raw.get("traits") or {}).items()
        }
        ctx.servants[sid] = ServantInfo(
            id=sid,
            name=str(raw.get("name") or ""),
            servant_class=str(raw.get("class") or ""),
            cost=int(raw.get("cost") or 0),
            rarity=int(raw.get("rarity") or 0),
            traits=traits,
        )
    for raw in snapshot.get("crafts") or []:
        cid = int(raw["id"])
        ctx.crafts[cid] = CraftInfo(
            id=cid,
            name=str(raw.get("name") or ""),
            cost=int(raw.get("cost") or 0),
            rarity=int(raw.get("rarity") or 0),
            bonus_type=raw.get("bonusType"),
            bonus_value=float(raw.get("bonusValue") or 0),
            support_bonus=float(raw.get("supportBonus") or 0),
            trigger_traits=[
                [str(x) for x in group]
                for group in (raw.get("triggerTraits") or [])
            ],
            is_bond_ce=bool(raw.get("isBondCe")),
            detail=str(raw.get("detail") or ""),
            is_event_limited=bool(raw.get("isEventLimited")),
            flat_bonus=float(raw.get("flatBonus") or 0),
            repeatable=bool(raw.get("repeatable")),
            is_custom=bool(raw.get("isCustom")),
        )
    return ctx


def _compact_member(m: Dict[str, Any]) -> Dict[str, Any]:
    """只保留重跑后能用于比较的队伍成员字段。"""
    return {
        "position": str(m.get("position") or ""),
        "servantId": m.get("servantId"),
        "stage": m.get("stage"),
        "craftId": m.get("craftId"),
        "secondCraftId": m.get("secondCraftId"),
        "isSupport": bool(m.get("isSupport")),
    }


def _compact_result(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "rank": int(r.get("rank") or 0),
        "totalMultiplier": float(r.get("totalMultiplier") or 0),
        "costUsed": int(r.get("costUsed") or 0),
        "baseBond": float(r.get("baseBond") or 0),
        "totalBondPoints": float(r.get("totalBondPoints") or 0),
        "maxBondCount": int(((r.get("maxBondStats") or {}).get("count")) or 0),
        "team": [_compact_member(m) for m in (r.get("team") or [])],
    }


def compact_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [_compact_result(r) for r in (results or [])]


def build_payload(
    ctx: DataContext,
    request_data: Dict[str, Any],
    result: Dict[str, Any],
    app_name: str = "FGO牵绊推荐器",
    compact: bool = True,
) -> Dict[str, Any]:
    snapshot = _ctx_snapshot(ctx)
    if compact:
        # 默认复现模式：只保留本次搜索可能访问到的 Box/固定/助战/礼装。
        snapshot = _trim_snapshot_for_request(snapshot, request_data)
    return {
        "formatVersion": _FORMAT_VERSION,
        "appName": app_name,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "request": _jsonable(request_data),
        "snapshot": snapshot,
        "baseline": compact_results(result.get("top20") or []),
        "phaseLimits": result.get("_verifyPhase"),
        "meta": {
            "totalCandidates": result.get("totalCandidates"),
            "elapsed": result.get("_elapsed"),
            "processed": result.get("_processed"),
        },
    }


def encrypt_payload(payload: Dict[str, Any]) -> str:
    """把 payload 编码为验证串（函数名保留兼容；v3 起不再加密）。"""
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if pyppmd is None:
        raise RuntimeError("缺少 pyppmd 依赖，无法生成验证串")
    compressed = pyppmd.compress(raw, max_order=_PPMD_ORDER, mem_size=_PPMD_MEM)
    return _PREFIX_V3 + _b64url_encode(compressed)


def make_verification_token(
    ctx: DataContext,
    request_data: Dict[str, Any],
    result: Dict[str, Any],
    app_name: str = "FGO牵绊推荐器",
    compact: bool = True,
) -> str:
    return encrypt_payload(
        build_payload(ctx, request_data, result, app_name=app_name, compact=compact)
    )


def make_verification_tokens(
    ctx: DataContext,
    request_data: Dict[str, Any],
    result: Dict[str, Any],
    app_name: str = "FGO牵绊推荐器",
) -> Dict[str, str]:
    """同时生成“复现模式”和“完整模式”两种验证串。"""
    return {
        "repro": make_verification_token(
            ctx, request_data, result, app_name=app_name, compact=True
        ),
        "full": make_verification_token(
            ctx, request_data, result, app_name=app_name, compact=False
        ),
    }


def decrypt_token(token: str) -> Dict[str, Any]:
    token = (token or "").strip()
    if token.startswith(_PREFIX_V3):
        if pyppmd is None:
            raise ValueError("缺少 pyppmd 依赖，无法解码验证串")
        raw = pyppmd.decompress(
            _b64url_decode(token[len(_PREFIX_V3):]),
            max_order=_PPMD_ORDER,
            mem_size=_PPMD_MEM,
        )
    elif token.startswith(_PREFIX_V2):
        fernet = _fernet()
        try:
            compressed = fernet.decrypt(token[len(_PREFIX_V2):].encode("ascii"))
        except InvalidToken as exc:  # type: ignore[attr-defined]
            raise ValueError("验证串解密/校验失败，请确认复制完整") from exc
        if pyppmd is None:
            raise ValueError("缺少 pyppmd 依赖，无法解码验证串")
        raw = pyppmd.decompress(
            compressed,
            max_order=_PPMD_ORDER,
            mem_size=_PPMD_MEM,
        )
    elif token.startswith(_PREFIX_V1):
        fernet = _fernet()
        try:
            compressed = fernet.decrypt(token[len(_PREFIX_V1):].encode("ascii"))
        except InvalidToken as exc:  # type: ignore[attr-defined]
            raise ValueError("验证串解密/校验失败，请确认复制完整") from exc
        raw = zlib.decompress(compressed)
    else:
        raise ValueError("验证串格式不正确：缺少 FGOBONDV1./V2./V3. 前缀")

    payload = json.loads(raw)
    if int(payload.get("formatVersion") or 0) != _FORMAT_VERSION:
        raise ValueError(f"不支持的验证串格式版本: {payload.get('formatVersion')}")
    return payload
