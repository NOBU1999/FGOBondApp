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

# 取前100个可从者模拟大Box
servants = sorted(ctx.servants.values(), key=lambda s: s.id)[:100]
box = [{"id": s.id, "stage": "fourth", "maxBond": False, "bondSwitch1": True, "bondSwitch2": False, "personalBonus": 0.0} for s in servants]
data = {"box": box, "fixedServants": [], "fixedCrafts": [], "support": {}, "costLimit": 114, "strategy": "total_max", "activityBonus": 0, "teaBonus": 1}
req = parse_request(data)
t0 = time.time()
try:
    res = search.search_top_teams(ctx, req, progress=lambda m: None)
    print('elapsed', round(time.time()-t0, 3), 'top', len(res['top20']), 'candidates', res['totalCandidates'], 'processed', res['_processed'])
except Exception as e:
    print('ERROR', e)
