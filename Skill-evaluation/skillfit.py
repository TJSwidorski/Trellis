#!/usr/bin/env python3
"""
Pipeline 2 - fit evaluator.

Reads skills that pipeline 1 marked 'cleared' and decides whether each one is
actually useful to a specific target agent (Trellis, or anything else with a
capability manifest and a task set). Writes the 'fit' block of the ledger.

Four gates, cheapest first. Each one only sees what survived the last:

    A  relevance    does this touch anything the target says it needs?
    B  redundancy   does the target already have something that does this?
    C  validation   is it well-formed enough to be worth measuring?
    D  live eval    does the agent measurably do better with it installed?

Gate D is the only one that answers the real question, and the only one that
costs real money. Everything above it exists to make D affordable.

Usage:
    python skillfit.py --ledger ledger.json --manifest trellis-manifest.json
    python skillfit.py --ledger ledger.json --manifest m.json --live --agent codex
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# clean/benign/blind_spot classifier + v1->v2 migration live in pipeline 1,
# which owns the security block; pipeline 2 reads the same code so they can't
# drift. skillfinder imports nothing from here, so this is not circular.
from skillfinder import classify_incompleteness as _classify_incompleteness
from skillfinder import migrate_ledger

VALIDATE_TIMEOUT = 600
LIVE_TIMEOUT = 3600
CLONE_TIMEOUT = 120


class GateError(RuntimeError):
    """A gate ran to completion but produced a result that cannot be scored.

    Distinct from "the gate did not run" (recorded as ran=False and handled as
    'deferred'). This is raised so a broken measurement is never silently fed
    into decide() as a neutral zero.
    """

# Gate D is only worth running when the cheap gates say the skill is plausible.
RELEVANCE_FLOOR = 0.25
REDUNDANCY_CEILING = 0.85


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_event(entry: dict[str, Any], event: str, note: str = "") -> None:
    entry.setdefault("history", []).append(
        {"at": now(), "actor": "pipeline2", "event": event, **({"note": note} if note else {})}
    )


# --------------------------------------------------------------------------
# the target's manifest
# --------------------------------------------------------------------------

@dataclass
class Manifest:
    """Describes what the target agent is and what it wants.

    trellis-manifest.json shape:
    {
      "target": "trellis@2.0.0",
      "needs": {
        "worktree-isolation": ["git worktree", "sandbox", "isolation"],
        "graph-planning":     ["dag", "task graph", "dependency"],
        "cost-routing":       ["model routing", "broker", "token budget"]
      },
      "installed_skills_dir": "./skills",
      "task_set": "./evals/trellis-evals.json",
      "adopt_threshold": { "correctness": 0.05, "efficiency": 0.0 },
      "dimension_map": { "security": "security", "correctness": "correctness",
                         "efficiency": "efficiency" }
    }

    'needs' is the thing you maintain by hand. It is the only place that
    encodes what Trellis is currently missing, and it is what makes this
    pipeline yours rather than a generic leaderboard.

    'dimension_map' maps the canonical dimension names this pipeline reasons
    about (the keys of adopt_threshold, plus 'security' for the regression
    veto) onto the id SkillEvaluator's Tier 3 payload actually uses. In
    skillevaluator 0.2.1 the Tier 3 dimensions are a fixed set --
    security / correctness / discoverability / effectiveness / efficiency
    (constants.AGENT_EVAL_DIMENSIONS) -- so the map is an identity today. It
    exists because that set has already changed once upstream (an older
    payload had no 'security' dimension) and the README warns the JSON shape
    moves; a rename becomes a config edit here instead of a silent no-op in
    decide().
    """
    target: str
    needs: dict[str, list[str]]
    installed_skills_dir: Path | None
    task_set: Path | None
    adopt_threshold: dict[str, float]
    dimension_map: dict[str, str]

    _DEFAULT_DIMENSION_MAP = {
        "security": "security",
        "correctness": "correctness",
        "discoverability": "discoverability",
        "effectiveness": "effectiveness",
        "efficiency": "efficiency",
    }

    @classmethod
    def load(cls, path: Path) -> "Manifest":
        cfg = json.loads(path.read_text())
        return cls(
            target=cfg.get("target", "unknown"),
            needs={k: [t.lower() for t in v] for k, v in cfg.get("needs", {}).items()},
            installed_skills_dir=Path(p) if (p := cfg.get("installed_skills_dir")) else None,
            task_set=Path(p) if (p := cfg.get("task_set")) else None,
            adopt_threshold=cfg.get("adopt_threshold", {"correctness": 0.05}),
            dimension_map={**cls._DEFAULT_DIMENSION_MAP, **cfg.get("dimension_map", {})},
        )


# --------------------------------------------------------------------------
# gate A - relevance
# --------------------------------------------------------------------------

def fetch_skill(url: str, dest: Path) -> Path | None:
    proc = subprocess.run(
        ["git", "clone", "--depth", "1", "--quiet", url, str(dest)],
        capture_output=True, text=True, timeout=CLONE_TIMEOUT,
    )
    if proc.returncode != 0:
        return None
    # a repo may hold several skills; the shallowest SKILL.md is the entry point
    found = sorted(dest.rglob("SKILL.md"), key=lambda p: len(p.parts))
    return found[0].parent if found else None


def gate_relevance(skill_dir: Path, manifest: Manifest) -> dict[str, Any]:
    """Keyword match of the skill's own description against declared needs.

    Deliberately dumb and free. Swap in embeddings later by replacing this
    function; the contract it returns does not change. The only job here is to
    throw away the 95% of skills that have nothing to do with the target.
    """
    md = (skill_dir / "SKILL.md").read_text(errors="ignore").lower()
    header = md[:4000]  # frontmatter + intro carries the description

    matched: list[str] = []
    hits = 0
    for need, terms in manifest.needs.items():
        if any(re.search(rf"\b{re.escape(t)}", header) for t in terms):
            matched.append(need)
            hits += 1

    score = hits / len(manifest.needs) if manifest.needs else 0.0
    return {"score": round(score, 3), "matched_needs": matched, "method": "keyword"}


# --------------------------------------------------------------------------
# SkillEvaluator CLI plumbing
# --------------------------------------------------------------------------
#
# SkillEvaluator (0.2.x) has no `--format` flag and never writes its
# machine-readable report to stdout. `-r json -o DIR` drops one JSON file in
# DIR: `validate` names it skillevaluator-output-<timestamp>.json, and
# `similarity-check` names it skillevaluator-similarity.json. Its exit code is 1
# whenever any gate fails, so a non-zero return is not by itself a runner error.

def _se_env() -> dict[str, str]:
    """Env for the SkillEvaluator subprocess.

    Its Rich renderer crashes with UnicodeEncodeError against a cp1252 Windows
    console before the JSON report is flushed, so force UTF-8.
    """
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _run_skillevaluator(
    args: list[str], out_dir: Path, timeout: int
) -> tuple[dict[str, Any] | None, str]:
    """Run `skillevaluator <args> -r json -o out_dir`.

    Returns (report, error). report is None only when no readable JSON was
    produced at all; error carries the reason in that case.
    """
    try:
        proc = subprocess.run(
            ["skillevaluator", *args, "-r", "json", "-o", str(out_dir)],
            capture_output=True, text=True, timeout=timeout, env=_se_env(),
        )
    except subprocess.TimeoutExpired:
        return None, "skillevaluator timed out"
    except FileNotFoundError:
        return None, "skillevaluator not on PATH"

    reports = sorted(out_dir.glob("skillevaluator-*.json"), key=lambda p: p.stat().st_mtime)
    if not reports:
        return None, (proc.stderr or proc.stdout or "no JSON report produced").strip()[:300]
    try:
        data = json.loads(reports[-1].read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"unreadable report: {exc}"[:300]
    # A report that parsed to `{}` (or a list, or null) is not a usable report;
    # return None so callers hit their explicit "no report" branch rather than
    # iterating an empty structure that looks like "nothing wrong".
    if not isinstance(data, dict) or not data:
        return None, "report file was empty or not a JSON object"
    return data, ""


# --------------------------------------------------------------------------
# gate B - redundancy
# --------------------------------------------------------------------------

def gate_redundancy(skill_dir: Path, manifest: Manifest) -> dict[str, Any]:
    """SkillEvaluator similarity-check against what is already installed.

    This is the gate that makes the answer specific to you. A skill can be
    excellent in the abstract and still worthless here because Trellis already
    covers it. Needs an embeddings provider configured.

    similarity-check reports each duplicate pair as a SIMILARITY *finding* under
    results[] (there is no top-level "pairs" array); the pair scores live in
    finding.metadata as {score, classification, entry_a, entry_b, path_a,
    path_b}. When no embeddings provider is configured the check exits non-zero
    with zero findings and an error naming the missing key — which must read as
    overlap, never as "novel".
    """
    if not manifest.installed_skills_dir or not manifest.installed_skills_dir.exists():
        return {"max_similarity": 0.0, "closest_existing": None, "verdict": "novel"}

    staging = Path(tempfile.mkdtemp(prefix="simcheck-"))
    out_dir = Path(tempfile.mkdtemp(prefix="simcheck-out-"))
    try:
        # similarity-check wants a folder of skill dirs; this layout is not
        # auto-detectable, hence --type skill.
        for src in sorted(manifest.installed_skills_dir.iterdir()):
            if (src / "SKILL.md").exists():
                shutil.copytree(src, staging / src.name)
        shutil.copytree(skill_dir, staging / "__candidate__")
        report, err = _run_skillevaluator(
            ["similarity-check", str(staging), "--type", "skill"],
            out_dir, VALIDATE_TIMEOUT,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)

    results = (report or {}).get("results", [])
    sim = next((r for r in results if r.get("validator") == "Similarity Check"), None)
    # No positively-readable result -> absent signal -> treat as overlap.
    if report is None or sim is None or (
        not sim.get("passed", False) and not sim.get("findings")
    ):
        detail = err or "; ".join((sim or {}).get("legacy", {}).get("errors", []))
        return {"max_similarity": 0.0, "closest_existing": None,
                "verdict": "partial_overlap",
                "note": f"similarity unavailable: {detail}"[:200]}

    best, closest = 0.0, None
    for f in sim.get("findings", []):
        meta = f.get("metadata") or {}
        pa, pb = str(meta.get("path_a", "")), str(meta.get("path_b", ""))
        if "__candidate__" not in pa + pb:
            continue
        s = float(meta.get("score", 0) or 0)
        if s > best:
            best = s
            closest = meta.get("entry_a") if "__candidate__" in pb else meta.get("entry_b")

    verdict = ("redundant" if best >= REDUNDANCY_CEILING
               else "partial_overlap" if best >= 0.6 else "novel")
    return {"max_similarity": round(best, 3), "closest_existing": closest, "verdict": verdict}


# --------------------------------------------------------------------------
# gate C - validation
# --------------------------------------------------------------------------
#
# The report lists one entry per validator under results[], each with a
# `validator` name, a `passed` bool and a `findings` list; `overall_passed` is
# SkillEvaluator's own gate. We do NOT use overall_passed directly, because the
# default `external` profile fails a candidate for publication-readiness gaps
# (no LICENSE, no author, missing "## Examples") that have nothing to do with
# whether the skill is broken or hostile. Instead we split the validators:
#
#   hard-fail  -> the skill is malformed or unsafe; reject at gate C.
#   soft-flag  -> publication-readiness; recorded in fit.provenance_flags and
#                 used by decide() to cap the final verdict at 'trial'.
#
# `security` and `code-integrity` also exist as keyless Tier 1 checks and would
# be hard-fail, but they re-invoke SkillSpector over the same tree pipeline 1
# already scanned, so they are deliberately left out of gate C.

_HARD_VALIDATORS = {
    "PII Scan",
    "Unicode Smuggling Detection",
    "Security Scan",
    "Code Risk Analysis",
    "Secrets Detection",
    "Code Integrity & Hygiene",
}
_SOFT_VALIDATORS = {"License Compliance", "QUALITY", "SCRIPT_LINT"}
# Schema & Repository Governance is mixed: these check_names are convention /
# provenance nudges, everything else it reports is structural.
_SOFT_SCHEMA_CHECKS = {
    "author_missing", "author_format", "body_recommended_section", "line_count",
}


def _script_syntax_errors(skill_dir: Path) -> list[str]:
    """Hard-fail any bundled Python script that does not parse.

    SkillEvaluator's own SCRIPT_LINT does `ast.parse` in a bare
    `except SyntaxError: return` -- it swallows the error and emits nothing, so
    a broken script otherwise surfaces only as "incomplete analysis". A skill
    whose scripts do not parse is broken, not merely unpolished.
    """
    errs: list[str] = []
    for p in sorted(skill_dir.rglob("*.py")):
        try:
            ast.parse(p.read_text(encoding="utf-8", errors="replace"), filename=p.name)
        except SyntaxError as exc:
            errs.append(f"script does not parse: {p.relative_to(skill_dir)}:{exc.lineno} {exc.msg}"[:160])
        except OSError:
            pass
    return errs


def gate_validation(skill_dir: Path) -> dict[str, Any]:
    """Tier 1 hygiene, split into hard failures and soft provenance flags.

    Returns {passed, failed_checks, provenance_flags}. `passed` is False only
    when a hard validator failed; soft items never block.
    """
    # Our own check, run regardless of what SkillEvaluator's report looks like.
    syntax_hard = _script_syntax_errors(skill_dir)

    out_dir = Path(tempfile.mkdtemp(prefix="validate-out-"))
    try:
        report, err = _run_skillevaluator(
            ["validate", str(skill_dir),
             "--checks", "schema,pii,license,quality,unicode,lint", "--no-dedup"],
            out_dir, VALIDATE_TIMEOUT,
        )
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if report is None:
        return {"passed": False,
                "failed_checks": syntax_hard + [f"runner_error: {err}"[:200]],
                "provenance_flags": []}

    # A validate report always carries a per-validator results[] list. Its
    # absence means the run did not actually evaluate anything -- which must not
    # read as "no hard failures, gate passed".
    results = report.get("results")
    if not isinstance(results, list) or not results:
        return {"passed": False,
                "failed_checks": syntax_hard + ["runner_error: validate report carried no results[]"],
                "provenance_flags": []}

    hard: list[str] = list(syntax_hard)
    soft: list[str] = []

    def _msgs(r: dict[str, Any]) -> str:
        fs = r.get("findings") or []
        return "; ".join(f.get("check_name") or f.get("message", "?") for f in fs) or "failed"

    for r in results:
        name = r.get("validator", "?")
        findings = r.get("findings") or []

        if name == "Schema & Repository Governance":
            hard_fs = [
                f for f in findings
                if f.get("check_name") not in _SOFT_SCHEMA_CHECKS
                and str(f.get("severity", "")).lower() in ("high", "critical")
            ]
            soft_fs = [f for f in findings if f not in hard_fs]
            if hard_fs:
                hard.append(f"{name}: " + "; ".join(f.get("check_name", "?") for f in hard_fs))
            for f in soft_fs:
                soft.append(f"{name}/{f.get('check_name', '?')}: {f.get('message', '?')}"[:160])
            continue

        if name in _SOFT_VALIDATORS:
            # record advisories whether or not the validator "passed" under the
            # active profile
            if name == "QUALITY":
                q = r.get("quality") or {}
                if q.get("overall_score") is not None:
                    soft.append(f"QUALITY score {q.get('overall_score')}/100 (grade {q.get('grade', '?')})")
            src = findings or ([{"message": r.get("description", name)}]
                               if not r.get("passed", True) else [])
            for f in src:
                soft.append(f"{name}: {f.get('message', '?')}"[:160])
            continue

        # hard validators, and anything unrecognised -> fail closed
        if not r.get("passed", True):
            hard.append(f"{name}: {_msgs(r)}"[:160])

    return {"passed": not hard, "failed_checks": hard, "provenance_flags": soft}


# --------------------------------------------------------------------------
# gate D - live evaluation
# --------------------------------------------------------------------------

def gate_live(skill_dir: Path, manifest: Manifest, agent: str, env_mode: str) -> dict[str, Any]:
    """Tier 3: run the target's task set with and without the skill.

    This is the only gate that measures the thing you actually care about.
    Budget it: it spends model tokens and sandbox time per skill, so it should
    see a handful of finalists per run, never the whole night's crawl.
    """
    # SkillEvaluator has no --eval-dataset flag. A caller-supplied task set is
    # only picked up from <skill_dir>/evals/ (BYOT); otherwise --full lets
    # autopilot generate one. Stage the manifest's task_set there if we have it.
    if manifest.task_set and manifest.task_set.exists():
        evals_dir = skill_dir / "evals"
        evals_dir.mkdir(exist_ok=True)
        shutil.copy(manifest.task_set, evals_dir / manifest.task_set.name)

    out_dir = Path(tempfile.mkdtemp(prefix="live-out-"))
    try:
        report, err = _run_skillevaluator(
            ["validate", str(skill_dir), "--full",
             "--agents", agent, "--env-mode", env_mode],
            out_dir, LIVE_TIMEOUT,
        )
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if report is None:
        return {"ran": False, "agent": agent, "env_mode": env_mode,
                "deltas": {}, "error": err}

    # tier3 == the agent_eval payload. It carries per-dimension
    # {id, with_skill, baseline, lift, verdict} under `dimensions` (a list) and
    # scalar `overall_lift` -- there is no flat `deltas` map or `n_tasks`/
    # `report_path`. Build `deltas` from the per-dimension lift figures, keyed
    # back to canonical names via the manifest's dimension_map so the ledger
    # stays stable if SkillEvaluator renames a dimension. `lift` is None when
    # the run used --skip-baseline; such dimensions are omitted.
    t3 = report.get("tier3") or {}
    payload_to_canonical = {v: k for k, v in manifest.dimension_map.items()}
    dims = t3.get("dimensions") or []
    deltas: dict[str, float] = {}
    for d in dims:
        if not isinstance(d, dict) or d.get("lift") is None:
            continue
        canonical = payload_to_canonical.get(str(d.get("id")))
        if canonical:
            deltas[canonical] = round(float(d["lift"]), 4)

    completed = t3.get("execution_status") == "completed"
    # A completed run with no usable deltas is a broken run, not a neutral one:
    # empty/absent dimensions, every lift null (e.g. --skip-baseline), or a
    # dimension_map that matches none of the payload ids. Raise rather than let
    # decide() score a phantom zero-lift.
    if completed and not deltas:
        raise GateError(
            "gate D reported execution_status=completed but produced no usable deltas "
            f"(payload dimension ids={[d.get('id') for d in dims if isinstance(d, dict)] or 'none'}; "
            f"dimension_map targets={sorted(payload_to_canonical)}; "
            "all lifts may be null under --skip-baseline)"
        )

    ds = t3.get("dataset_summary") or t3.get("summary", {}).get("dataset_summary") or {}
    return {
        "ran": completed,
        "agent": agent,
        "env_mode": env_mode,
        "task_set": str(manifest.task_set) if manifest.task_set else "generated",
        "n_tasks": int(ds.get("total_tasks", 0) or 0),
        "deltas": deltas,
        "report_path": None,
    }


# --------------------------------------------------------------------------
# verdict
# --------------------------------------------------------------------------


def decide(fit: dict[str, Any], manifest: Manifest, sec: dict[str, Any]) -> tuple[str, str]:
    rel = fit.get("relevance", {})
    red = fit.get("redundancy", {})
    val = fit.get("validation", {})
    live = fit.get("live_eval", {})
    soft_flags = fit.get("provenance_flags", [])
    # `benign` incompleteness (reference_unresolved on a skill's own file refs)
    # is near-universal and is NOT a reason to withhold adoption -- it is
    # recorded in fit.scan_flags for the audit trail but only `blind_spot`
    # caps the verdict here.
    inc_class, inc_reason = _classify_incompleteness(sec)

    if rel.get("score", 0) < RELEVANCE_FLOOR:
        return "reject", f"no overlap with declared needs (relevance {rel.get('score')})"
    if red.get("verdict") == "redundant":
        return "reject", f"duplicates {red.get('closest_existing')} (sim {red.get('max_similarity')})"
    # gate C now only carries HARD failures; publication-readiness lives in
    # provenance_flags and never rejects here.
    if val and not val.get("passed", True):
        return "reject", f"failed tier 1 (hard): {', '.join(val.get('failed_checks', []))[:120]}"
    if not live.get("ran"):
        return "deferred", "passed cheap gates; live evaluation not yet run"

    deltas = live.get("deltas", {})

    # Behavioural-regression veto. `security` is AGENT_EVAL_DIMENSIONS[0] and
    # every baselined Tier 3 run emits it (compute_dimensions iterates a fixed
    # DIMENSION_MAPPING), so this branch does fire against a real gate-D result.
    sec_delta = deltas.get("security")
    if sec_delta is not None and sec_delta < 0:
        return "reject", f"measurably degrades agent security behaviour (security {sec_delta})"

    meets = all(deltas.get(k, 0) >= v for k, v in manifest.adopt_threshold.items())
    if not meets:
        return "reject", f"no measurable improvement: {deltas}"

    # Benchmarked well enough to adopt. Anything below caps the verdict at
    # 'trial' -- it never rejects -- and rides into the rationale.
    blockers: list[str] = []
    n_findings = len(sec.get("findings") or [])
    if n_findings:
        blockers.append(f"{n_findings} open scan finding(s)")
    if inc_class == "blind_spot":
        kind = sec.get("blind_spot_kind")
        suffix = {
            "provider_unavailable": " (provider unavailable -- pipeline 1 will retry on the next run)",
            "provider_persistent": (f" (LLM leg has failed {sec.get('consecutive_provider_failures', '?')}+ runs -- "
                                    "payload likely too large for this model; needs a bigger model or manual review)"),
            "structural": " (structural -- the scanner cannot finish reading this skill)",
        }.get(kind, "")
        blockers.append(f"scan blind spot: {inc_reason}{suffix}")
    if sec_delta is None:
        blockers.append("security dimension not reported; regression veto did not run")
    if soft_flags:
        blockers.append(f"provenance: {'; '.join(soft_flags)[:100]}")
    if blockers:
        note = "" if inc_class != "benign" else f" [scan incomplete but benign: {inc_reason[:60]}]"
        return "trial", (f"improves the agent ({deltas}); held at trial -- "
                         f"{' | '.join(blockers)}{note}")
    if inc_class == "benign":
        return "adopt", (f"improves the agent on the task set ({deltas}); "
                         f"scan incomplete but benign ({inc_reason[:60]})")
    return "adopt", f"improves the agent on the task set ({deltas})"


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def evaluate(
    ledger: dict[str, Any],
    manifest: Manifest,
    *,
    live: bool,
    agent: str,
    env_mode: str,
    max_live: int,
) -> dict[str, int]:
    counts = {"adopt": 0, "trial": 0, "reject": 0, "deferred": 0, "error": 0}
    live_budget = max_live

    # Everything pipeline 1 scanned and did not quarantine. Skip entries whose
    # security block predates the v2 completeness fields (is_complete absent) --
    # pipeline 1's needs_rescan() will repopulate those.
    queue = [
        e for e in ledger["entries"].values()
        if e.get("state") == "awaiting_fit"
        and (e.get("security") or {}).get("recommendation") != "DO_NOT_INSTALL"
        and (e.get("security") or {}).get("is_complete") is not None
    ]

    for entry in queue:
        sec = entry.get("security") or {}
        workdir = Path(tempfile.mkdtemp(prefix="fit-"))
        try:
            skill_dir = fetch_skill(entry["source"]["url"], workdir / "src")
            if skill_dir is None:
                entry["fit"] = {"evaluated_at": now(), "verdict": "deferred",
                                "error": "could not fetch or no SKILL.md found"}
                counts["error"] += 1
                log_event(entry, "fit_fetch_failed")
                continue

            fit: dict[str, Any] = {"evaluated_at": now(), "target": manifest.target}

            # incompleteness classification rides in as a flag, like a gate-C
            # provenance flag: it never rejects, only caps at trial.
            inc_class, inc_reason = _classify_incompleteness(sec)
            fit["scan_flags"] = (
                [] if inc_class == "clean"
                else [f"scan incomplete ({inc_class}): {inc_reason}"[:180]]
            )

            fit["relevance"] = gate_relevance(skill_dir, manifest)

            if fit["relevance"]["score"] >= RELEVANCE_FLOOR:
                fit["redundancy"] = gate_redundancy(skill_dir, manifest)
                if fit["redundancy"]["verdict"] != "redundant":
                    gv = gate_validation(skill_dir)
                    fit["provenance_flags"] = gv.pop("provenance_flags", [])
                    fit["validation"] = gv
                    if fit["validation"]["passed"] and live and live_budget > 0:
                        fit["live_eval"] = gate_live(skill_dir, manifest, agent, env_mode)
                        live_budget -= 1

            verdict, rationale = decide(fit, manifest, sec)
            fit["verdict"], fit["rationale"] = verdict, rationale
            entry["fit"] = fit
            entry["state"] = {"adopt": "adopted", "trial": "fit_evaluated",
                              "reject": "rejected", "deferred": "fit_evaluated"}[verdict]
            counts[verdict] += 1
            log_event(entry, "fit_evaluated", f"{verdict}: {rationale}"[:200])
        except GateError as exc:
            # a gate produced an unscoreable result -> record it, do not decide()
            fit["verdict"] = "deferred"
            fit["rationale"] = f"gate produced no usable measurement: {exc}"[:200]
            fit["error"] = str(exc)[:300]
            entry["fit"] = fit
            entry["state"] = "fit_evaluated"
            counts["error"] += 1
            log_event(entry, "fit_gate_error", str(exc)[:200])
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description="Pipeline 2 - evaluate scanned skills for target fit")
    ap.add_argument("--ledger", type=Path, default=Path("ledger.json"))
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--live", action="store_true", help="run gate D (costs money)")
    ap.add_argument("--agent", default="codex")
    # SkillEvaluator's Harbor env modes: docker | local | daytona | e2b | modal
    # | runloop | langsmith | gke | novita. "cloud" is not one of them.
    ap.add_argument("--env-mode", default="docker", choices=["docker", "local"])
    ap.add_argument("--max-live", type=int, default=5, help="cap on gate D runs per invocation")
    args = ap.parse_args()

    ledger = migrate_ledger(json.loads(args.ledger.read_text()))
    manifest = Manifest.load(args.manifest)

    counts = evaluate(
        ledger, manifest,
        live=args.live, agent=args.agent, env_mode=args.env_mode,
        max_live=args.max_live,
    )

    ledger["updated_at"] = now()
    tmp = args.ledger.with_suffix(".tmp")
    tmp.write_text(json.dumps(ledger, indent=2))
    tmp.replace(args.ledger)

    print(f"adopt {counts['adopt']} | trial {counts['trial']} | "
          f"reject {counts['reject']} | deferred {counts['deferred']} | errors {counts['error']}")
    for e in ledger["entries"].values():
        if (e.get("fit") or {}).get("verdict") in ("adopt", "trial"):
            print(f"  {e['fit']['verdict']:<8} {e['id']:<48} {e['fit']['rationale'][:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
