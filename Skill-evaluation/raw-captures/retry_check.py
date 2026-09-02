#!/usr/bin/env python3
"""Task 3: re-run just the four skills whose LLM leg failed last round
(text-analyzer, pdf, docx, mcp-builder), with retries on, through the *real*
pipeline-1 functions. Reports which failures were transient (retried to a clean
LLM verdict, or classified provider_unavailable) vs structural, and whether
text-analyzer returns to benign / adopt-eligible.

Run from Skill-evaluation/raw-captures/ with OPENROUTER_API_KEY set.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import skillfinder as sf
import skillfit

REF = Path(os.environ["SKILLEVAL_REF"])
ANTH = Path(os.environ["ANTH_SKILLS"])
BASELINE = Path(__file__).resolve().parents[1] / "skillspector-baseline.yaml"
RAW = Path("retry_raw"); RAW.mkdir(exist_ok=True)

# OpenRouter / deepseek-v4-flash, temp 0, seed 42 -- into os.environ so
# skillfinder.run_skillspector (which shells out with the ambient env) picks it up.
os.environ.update(
    SKILLSPECTOR_PROVIDER="openai",
    OPENAI_API_KEY=os.environ["OPENROUTER_API_KEY"],
    OPENAI_BASE_URL="https://openrouter.ai/api/v1",
    SKILLSPECTOR_MODEL="deepseek/deepseek-v4-flash",
    SKILLSPECTOR_TEMPERATURE="0",
    SKILLSPECTOR_SEED="42",
    PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
)

TARGETS = {
    "text-analyzer": REF / "text-analyzer",
    "anthropic-pdf": ANTH / "skills" / "pdf",
    "anthropic-docx": ANTH / "skills" / "docx",
    "anthropic-mcp-builder": ANTH / "skills" / "mcp-builder",
}
M = skillfit.Manifest.load(Path(__file__).resolve().parents[1] / "trellis-manifest.json")


def project(sec: dict) -> tuple[bool, str, str]:
    cls, reason = sf.classify_incompleteness(sec)
    reaches = sec["recommendation"] != "DO_NOT_INSTALL" and sec["is_complete"] is not None
    caps = []
    if sec["findings"]:
        caps.append(f"{len(sec['findings'])} finding(s)")
    if cls == "blind_spot":
        caps.append(f"blind_spot/{sec.get('blind_spot_kind')}")
    if not reaches:
        v = "quarantined"
    elif caps:
        v = "trial [" + "; ".join(caps) + "]"
    else:
        v = "ADOPT-eligible" + (" (benign incompleteness)" if cls == "benign" else "")
    return reaches, cls, v


def main() -> int:
    print(f"retries: N={sf.LLM_RETRY_ATTEMPTS}, backoff={sf.LLM_RETRY_BACKOFF_SECONDS}s\n")
    rows = []
    for name, path in TARGETS.items():
        print(f"=== {name} ===", file=sys.stderr, flush=True)
        static = sf.run_skillspector(str(path), False, BASELINE)
        static_class, _ = sf.classify_incompleteness(sf._completeness_view(static, llm_ran=False))
        t0 = time.time()
        res, log = sf.gate2_with_retries(
            str(path), BASELINE, static, static_class,
            on_retry=lambda n, e, d: print(f"  attempt {n} failed ({e}); backoff {d}s", file=sys.stderr, flush=True),
        )
        secs = round(time.time() - t0, 1)
        llm_ran = res.mode == "static+llm"
        bsk = sf.blind_spot_kind_for(res, static_class, llm_ran)
        sec = {
            "recommendation": res.recommendation,
            "findings": res.findings,
            "is_complete": res.is_complete,
            "ledger_exception_reasons": res.ledger_exception_reasons,
            "degraded_analyzers": res.degraded_analyzers,
            "llm_requested": res.llm_requested, "llm_ran": llm_ran,
            "blind_spot_kind": bsk,
        }
        reaches, final_class, verdict = project(sec)
        kind = (
            "TRANSIENT: LLM leg ran on attempt 1 (last round it failed)" if llm_ran and len(log) == 1
            else "TRANSIENT: recovered after retry" if llm_ran
            else "TRANSIENT: provider_unavailable, needs_rescan will retry next run" if bsk == "provider_unavailable"
            else "STRUCTURAL: static scan alone is a blind spot" if bsk == "structural"
            else "?"
        )
        rows.append((name, static_class, len(log), llm_ran, final_class, bsk, kind, verdict, secs, res.ledger_exception_reasons))
        (RAW / f"{name}.json").write_text(json.dumps({
            "static_class": static_class, "attempts": log, "llm_ran": llm_ran,
            "final_class": final_class, "blind_spot_kind": bsk, "verdict": verdict,
            "reasons": res.ledger_exception_reasons, "degraded": res.degraded_analyzers,
            "recommendation": res.recommendation, "n_findings": len(res.findings),
        }, indent=2))

    print("\n=== TASK 3 RESULT ===")
    for name, sc, na, lr, fc, bsk, kind, verdict, secs, reasons in rows:
        print(f"  {name:<22} static={sc:<11} attempts={na} llm_ran={lr!s:<6} final={fc:<11} "
              f"blind_spot_kind={bsk}")
        print(f"  {'':<22} {kind}")
        print(f"  {'':<22} reasons={reasons}  ->  {verdict}\n")
    ta = next(r for r in rows if r[0] == "text-analyzer")
    print(f"text-analyzer: last round llm_ran=False -> blind_spot -> trial. "
          f"This round: llm_ran={ta[3]}, final class = {ta[4]}.")
    print("  -> classification drift RESOLVED: back to benign"
          if ta[4] == "benign" else f"  -> still {ta[4]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
