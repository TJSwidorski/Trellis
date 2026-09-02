#!/usr/bin/env bash
# One deterministic-scan run. Usage: det_run.sh <run-number>
set -u
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
export SKILLSPECTOR_PROVIDER=openai
export OPENAI_API_KEY="$OPENROUTER_API_KEY"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export SKILLSPECTOR_MODEL="deepseek/deepseek-v4-flash"
export SKILLSPECTOR_TEMPERATURE=0
export SKILLSPECTOR_SEED=42

N="$1"
TARGET="C:/Users/tswid/AppData/Roaming/uv/tools/skillevaluator/Lib/site-packages/skillevaluator/tier3/reference_skills/calculator"
OUT="C:/Users/tswid/PersonalPrograms/Trellis/Skill-evaluation/raw-captures/det_calculator_run${N}.json"

skillspector scan "$TARGET" --format json > "$OUT" 2> "${OUT%.json}.stderr"
echo "run $N exit=$? at $(date -u +%H:%M:%S)"
py -c "
import json
r=json.load(open(r'$OUT')); m=r['metadata']; ac=r.get('analysis_completeness',{})
print('  llm_requested', m.get('llm_requested'), '| llm_available', m.get('llm_available'),
      '| meta_analysis_applied', m.get('meta_analysis_applied'))
print('  score', r['risk_assessment']['score'], '| verdict', r['risk_assessment']['recommendation'])
print('  is_complete', ac.get('is_complete'), '| coverage_percent', ac.get('coverage_percent'), '| status', ac.get('status'))
print('  model', m.get('llm_model'), '| provider', m.get('llm_provider'), '| inference_usage', m.get('inference_usage'))
fs=[(i.get('id'),i.get('severity'),i.get('category'),(i.get('finding') or i.get('explanation') or '')[:70]) for i in r.get('issues',[])]
print('  findings (%d):' % len(fs))
for f in fs: print('   ', f)
"
