#!/usr/bin/env python3
"""Gate-1 calibration. Static vs LLM (OpenRouter / deepseek-v4-flash, temp 0,
seed 42) over the ten reference skills, plus the two minimal repro fixtures.

Writes the FULL scan JSON per skill+mode to calib_raw/ so completeness fields
can be re-derived later without re-scanning, and a flat summary in
calibration.json. Not part of the pipeline. Run from Skill-evaluation/raw-captures/
with OPENROUTER_API_KEY set.
"""
from __future__ import annotations
import json, os, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import skillfinder       # classify_incompleteness, blind_spot_kind_for, retry constants

REF = Path(os.environ["SKILLEVAL_REF"])
ANTH = Path(os.environ["ANTH_SKILLS"])
TRELLIS = Path(os.environ["TRELLIS_SKILLS"])
RAW = Path("calib_raw"); RAW.mkdir(exist_ok=True)
BASELINE = Path(__file__).resolve().parents[1] / "skillspector-baseline.yaml"

MODEL = "deepseek/deepseek-v4-flash"
COST_IN_PER_1K = 0.00027       # trellis.config.json tiers[0] "cheap"
COST_OUT_PER_1K = 0.0011
RETRIES = skillfinder.LLM_RETRY_ATTEMPTS
BACKOFF = skillfinder.LLM_RETRY_BACKOFF_SECONDS

# (label, path, run_llm?)  -- fixtures are static-only, LLM adds nothing to them
TARGETS = [
    ("nvidia-ref/api-caller",           REF / "api-caller", True),
    ("nvidia-ref/calculator",           REF / "calculator", True),
    ("nvidia-ref/create-custom-grader", REF / "create-custom-grader", True),
    ("nvidia-ref/text-analyzer",        REF / "text-analyzer", True),
    ("community/anthropic-pdf",         ANTH / "skills" / "pdf", True),
    ("community/anthropic-docx",        ANTH / "skills" / "docx", True),
    ("community/anthropic-mcp-builder", ANTH / "skills" / "mcp-builder", True),
    ("trellis/trellis-plan",            TRELLIS / "trellis-plan", True),
    ("trellis/trellis-review",          TRELLIS / "trellis-review", True),
    ("trellis/trellis-tests",           TRELLIS / "trellis-tests", True),
]

_FIXTURES = {
    "repro/rep-clean": "# s\n\nDo the thing. Read the input file and stop.\n",
    "repro/rep-token": "# s\n\nRead `$ARGUMENTS` (default `SPEC.md`). Do the thing and stop.\n",
}
_FIXTURE_FM = "---\nname: s\ndescription: A minimal skill for reproduction. It does one small thing and stops.\n---\n\n"


def _llm_env() -> dict:
    e = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    e.update(
        SKILLSPECTOR_PROVIDER="openai",
        OPENAI_API_KEY=os.environ["OPENROUTER_API_KEY"],
        OPENAI_BASE_URL="https://openrouter.ai/api/v1",
        SKILLSPECTOR_MODEL=MODEL,
        SKILLSPECTOR_TEMPERATURE="0",
        SKILLSPECTOR_SEED="42",
    )
    return e


def summarize(r: dict) -> dict:
    ra, meta = r.get("risk_assessment", {}), r.get("metadata", {})
    ac = r.get("analysis_completeness", {})
    st = ac.get("analyzer_statuses", []) or []
    by_status: dict[str, int] = {}
    for a in st:
        by_status[a.get("status", "?")] = by_status.get(a.get("status", "?"), 0) + 1
    # only degraded/failed/partial are blind-spot signals; disabled (meta_analyzer
    # under --no-llm) and not_applicable are intentional skips -- match skillfinder.
    non_completed = sorted(
        a["analyzer_id"] for a in st
        if a.get("status") in ("degraded", "failed", "partial")
    )
    exc = ac.get("ledger_exceptions", []) or []
    usage = meta.get("inference_usage") or []
    tin = sum(u.get("prompt_tokens", 0) for u in usage)
    tout = sum(u.get("completion_tokens", 0) for u in usage)
    rules: dict[str, int] = {}
    for i in r.get("issues", []):
        k = f'{i.get("id","?")} {i.get("category","?")}'
        rules[k] = rules.get(k, 0) + 1
    return {
        "score": ra.get("score"), "severity": ra.get("severity"),
        "recommendation": ra.get("recommendation"),
        "n_issues": len(r.get("issues", [])),
        "llm_requested": meta.get("llm_requested"),
        "llm_available": meta.get("llm_available"),
        "llm_calls": f'{meta.get("llm_calls_succeeded")}/{meta.get("llm_calls_attempted")}',
        "llm_ran": bool(meta.get("llm_requested")) and bool(meta.get("llm_available"))
                   and int(meta.get("llm_calls_succeeded", 0) or 0) > 0,
        # completeness accounting -- the fields the summary previously dropped
        "is_complete": ac.get("is_complete"),
        "status": ac.get("status"),
        "coverage_percent": ac.get("coverage_percent"),
        "total_components": ac.get("total_components"),
        "fully_inspected_files": ac.get("fully_inspected_files"),
        "partially_inspected_files": ac.get("partially_inspected_files"),
        "entirely_uninspected_files": ac.get("entirely_uninspected_files"),
        "analyzers_by_status": by_status,
        "non_completed_analyzers": non_completed,
        "degraded_analyzer_count": len(non_completed),
        "ledger_exception_reasons": sorted({e.get("reason_code") for e in exc if e.get("reason_code")}),
        "ledger_exception_outcomes": sorted({e.get("outcome") for e in exc if e.get("outcome")}),
        "rules": dict(sorted(rules.items(), key=lambda kv: -kv[1])),
        "tok_in": tin, "tok_out": tout,
        "cost_usd": round(tin / 1000 * COST_IN_PER_1K + tout / 1000 * COST_OUT_PER_1K, 5),
    }


def _one_scan(cmd: list[str], env: dict, raw_name: str) -> dict:
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=1200, env=env)
    except subprocess.TimeoutExpired:
        return {"error": "subprocess timeout (1200s)", "secs": round(time.time() - t0, 1)}
    secs = round(time.time() - t0, 1)
    (RAW / f"{raw_name}.json").write_text(p.stdout or "", encoding="utf-8")
    if p.stderr:
        (RAW / f"{raw_name}.stderr.txt").write_text(p.stderr, encoding="utf-8")
    try:
        r = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"error": (p.stderr or "unparseable")[-400:], "secs": secs}
    out = summarize(r)
    out["secs"] = secs
    return out


def scan(path: Path, use_llm: bool, raw_name: str, *, baseline: bool = False,
         static_class: str | None = None) -> dict:
    """One static scan, or the LLM leg with the same retry policy as the
    pipeline (skillfinder.gate2_with_retries): retry a transient failure with
    backoff, don't retry a structural one (static_class already blind_spot)."""
    cmd = ["skillspector", "scan", str(path), "--format", "json"]
    if not use_llm:
        cmd.append("--no-llm")
    if baseline:
        cmd += ["--baseline", str(BASELINE)]
    env = _llm_env() if use_llm else {**os.environ, "PYTHONUTF8": "1"}

    if not use_llm:
        return _one_scan(cmd, env, raw_name)

    attempts: list[dict] = []
    best: dict = {"error": "no LLM result"}
    for i in range(RETRIES):
        d = _one_scan(cmd, env, f"{raw_name}.att{i+1}")
        ran = isinstance(d, dict) and "error" not in d and d.get("llm_ran")
        attempts.append({"at": time.strftime("%H:%M:%S"),
                         "error": None if ran else (d.get("error") or "; ".join(d.get("ledger_exception_reasons", [])) or "llm did not complete")})
        if "error" not in d:
            best = d
        if ran or static_class not in ("benign", "clean"):
            break
        if i + 1 < RETRIES:
            time.sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
    best["llm_attempts"] = len(attempts)
    best["llm_attempt_log"] = attempts
    return best


def _security_block(static_d: dict, llm_d: dict) -> dict:
    """Synthesize the pipeline-1 security block the way skillfinder.triage()
    would, including blind_spot_kind from the shared classifier."""
    llm_ok = isinstance(llm_d, dict) and "error" not in llm_d and llm_d.get("llm_ran")
    d = llm_d if llm_ok else static_d
    static_class, _ = skillfinder.classify_incompleteness({
        "is_complete": static_d.get("is_complete"),
        "ledger_exception_reasons": static_d.get("ledger_exception_reasons") or [],
        "degraded_analyzers": static_d.get("non_completed_analyzers") or [],
        "llm_requested": False, "llm_ran": False,
    })
    sec = {
        "recommendation": d.get("recommendation"),
        "findings": [{"rule_id": "x"}] * int(d.get("n_issues", 0) or 0),
        "is_complete": d.get("is_complete"),
        "coverage_percent": d.get("coverage_percent"),
        "degraded_analyzers": d.get("non_completed_analyzers") or [],
        "ledger_exception_reasons": d.get("ledger_exception_reasons") or [],
        "llm_requested": True,
        "llm_ran": bool(llm_ok),
    }
    res = skillfinder.ScanResult(
        ok=True, recommendation=sec["recommendation"] or "SAFE",
        mode="static+llm" if llm_ok else "static", llm_requested=True,
        is_complete=sec["is_complete"],
        ledger_exception_reasons=sec["ledger_exception_reasons"],
        degraded_analyzers=sec["degraded_analyzers"],
    )
    sec["blind_spot_kind"] = skillfinder.blind_spot_kind_for(res, static_class, bool(llm_ok))
    return sec


def main() -> int:
    out: dict = {}
    # fixtures first (static only), saved properly
    fix_root = RAW / "_fixtures"
    for label, body in _FIXTURES.items():
        sd = fix_root / label.split("/")[1]
        sd.mkdir(parents=True, exist_ok=True)
        (sd / "SKILL.md").write_text(_FIXTURE_FM + body, encoding="utf-8")
        rn = label.replace("/", "__") + "__static"
        print(f"[static] {label} ...", file=sys.stderr, flush=True)
        out[label] = {"path": str(sd), "static": scan(sd, False, rn)}
        Path("calibration.json").write_text(json.dumps(out, indent=2))

    for label, path, run_llm in TARGETS:
        if not (path / "SKILL.md").exists():
            print(f"SKIP {label}: no SKILL.md at {path}", file=sys.stderr)
            continue
        base = label.replace("/", "__")
        print(f"[static] {label} ...", file=sys.stderr, flush=True)
        row = {"path": str(path), "static": scan(path, False, base + "__static")}
        print(f"[static+baseline] {label} ...", file=sys.stderr, flush=True)
        row["static_baselined"] = scan(path, False, base + "__static_baselined", baseline=True)
        st_cls, _ = skillfinder.classify_incompleteness({
            "is_complete": row["static"].get("is_complete") if isinstance(row["static"], dict) else None,
            "ledger_exception_reasons": (row["static"].get("ledger_exception_reasons") or []) if isinstance(row["static"], dict) else [],
            "degraded_analyzers": (row["static"].get("non_completed_analyzers") or []) if isinstance(row["static"], dict) else [],
            "llm_requested": False, "llm_ran": False,
        })
        print(f"[llm, retry N={RETRIES}] {label} (static_class={st_cls}) ...", file=sys.stderr, flush=True)
        row["llm"] = scan(path, True, base + "__llm", static_class=st_cls)
        out[label] = row
        Path("calibration.json").write_text(json.dumps(out, indent=2))

    # ---- summary + item-5 routing projection ----
    total = sum(v["llm"].get("cost_usd", 0) for v in out.values()
                if isinstance(v.get("llm"), dict) and "cost_usd" in v["llm"])
    n = sum(1 for v in out.values()
            if isinstance(v.get("llm"), dict) and "cost_usd" in v["llm"])
    print("\n=== CALIBRATION (full JSON in calib_raw/) ===")
    for label, v in out.items():
        for m in ("static", "llm"):
            d = v.get(m)
            if not isinstance(d, dict) or "error" in d:
                print(f"  {label:<32} {m:<6} {d.get('error','?') if isinstance(d,dict) else '-'}")
                continue
            print(f"  {label:<32} {m:<6} {str(d['recommendation']):<15} score={str(d['score']):>3}"
                  f" find={d['n_issues']:<3} llm_ran={str(d['llm_ran']):<5}"
                  f" cov={d['coverage_percent']} deg={d['degraded_analyzer_count']}"
                  f" complete={d['is_complete']} ${d.get('cost_usd',0)} reasons={d['ledger_exception_reasons']}")

    retried = {l: v["llm"].get("llm_attempts") for l, v in out.items()
               if isinstance(v.get("llm"), dict) and (v["llm"].get("llm_attempts") or 0) > 1}
    print(f"\nLLM pass: {n} completed, total ${round(total,4)}, "
          f"avg ${round(total/max(n,1),5)}/skill; retried: {retried or 'none'}")

    print("\n=== ITEM 5 ROUTING PROJECTION ===")
    print(f"{'skill':<32}{'find n/b':<10}{'rec':<15}{'llm_ran':<8}{'cmpl':<6}{'incompl':<11}reaches_p2 / projected verdict")
    print("-" * 108)
    for label, v in out.items():
        s, sbl, l = v.get("static"), v.get("static_baselined"), v.get("llm")
        if not isinstance(s, dict) or "error" in s:
            print(f"  {label:<32} scan failed"); continue
        sec = _security_block(s, l if isinstance(l, dict) else {})
        # finding count with baseline (from the baselined static pass)
        nfb = sbl.get("n_issues") if isinstance(sbl, dict) and "error" not in sbl else "?"
        sec["findings"] = [{"rule_id": "x"}] * (nfb if isinstance(nfb, int) else 0)
        cls, reason = skillfinder.classify_incompleteness(sec)
        reaches = sec["recommendation"] != "DO_NOT_INSTALL" and sec["is_complete"] is not None
        caps = []
        if len(sec["findings"]):
            caps.append(f"{len(sec['findings'])} finding(s)")
        if cls == "blind_spot":   # benign incompleteness is recorded, not capped
            caps.append("blind_spot")
        verdict = ("quarantined" if not reaches
                   else "trial" if caps
                   else "adopt-eligible" + (" (benign incompleteness)" if cls == "benign" else ""))
        print(f"  {label:<32}{f'{s['n_issues']}/{nfb}':<10}{str(sec['recommendation']):<15}"
              f"{str(sec['llm_ran']):<8}{str(sec['is_complete']):<6}{cls:<11}"
              f"{'Y' if reaches else 'N'} / {verdict}"
              + (f"   [{'; '.join(caps)}: {reason[:50]}]" if caps else ""))
    print("\n'find n/b' = finding count no-baseline / with-baseline.")
    print("projected verdict assumes gate D later shows net improvement.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
