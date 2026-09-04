import io
import json
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent          # python-engine/
PROJECT_ROOT = BASE.parent                       # 项目根
sys.path.insert(0, str(BASE))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from engine import calculator, search
from engine.constants import PROJECT_ROOT as ENGINE_PROJECT_ROOT
from engine.models import parse_request

DB = ENGINE_PROJECT_ROOT / 'db' / 'fgo_data.db'
ctx = calculator.load_context(DB)

base = json.load(open(BASE / 'sample_request.json', encoding='utf-8'))


def run(name, data):
    req = parse_request(data)
    t = time.time()
    res = search.search_top_teams(ctx, req, progress=lambda m: None)
    top = res['top20'][0] if res['top20'] else {}
    print(f"[{name}] elapsed={time.time()-t:.2f}s top={len(res['top20'])} best={top.get('totalMultiplier')} cost={top.get('costUsed')}")


# 1. 固定前排左从者 100100 + 固定午餐礼装在前排中
d = json.loads(json.dumps(base))
d['fixedServants'] = [{"servantId": 100100, "position": "front_left"}]
d['fixedCrafts'] = [{"position": "front_middle", "craftId": 9401970, "type": "bond"}]
run('fixed_servant_craft', d)

# 2. 指定从者最大化
d = json.loads(json.dumps(base))
d['strategy'] = 'target_max'
d['targetServantId'] = 603700
run('target_max', d)

# 3. 均衡模式
d = json.loads(json.dumps(base))
d['strategy'] = 'balanced'
run('balanced', d)

# 4. Cost 很低 -> 应能降级礼装或报错
d = json.loads(json.dumps(base))
d['costLimit'] = 50
try:
    run('low_cost', d)
except Exception as e:
    print('[low_cost] error:', e)
