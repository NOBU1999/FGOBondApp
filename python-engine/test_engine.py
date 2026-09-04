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
data = json.load(open(BASE / 'sample_request.json', encoding='utf-8'))
t0 = time.time()
ctx = calculator.load_context(DB)
req = parse_request(data)
res = search.search_top_teams(ctx, req, progress=lambda m: None)
print('elapsed', time.time() - t0, 'top', len(res['top20']), 'totalCandidates', res['totalCandidates'])
for s in res['top20'][:5]:
    print('rank', s['rank'], 'score', s['totalMultiplier'], 'cost', s['costUsed'])
    for m in s['team']:
        print(' ', m['position'], m['name'], 'support' if m['isSupport'] else '', m['craftName'], m['bonusDetail']['totalMultiplier'])
