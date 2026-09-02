#!/usr/bin/env python3
"""
Pipeline 1 - skill finder.

Discovers candidate agent skills, runs them through SkillSpector, and writes a
security verdict into the shared ledger. Produces no opinion about usefulness;
that is pipeline 2's job.

Flow:
    discover -> dedupe against ledger -> gate 1 (static) -> gate 2 (llm) -> write

Design notes:
  - Gate 1 is free and parallel, so it runs over everything.
  - Gate 2 costs tokens, so it only runs on what gate 1 did not already
    condemn. A DO_NOT_INSTALL from static analysis needs no second opinion.
  - Nothing is re-scanned unless its content hash changed or the scanner
    version changed. That is what makes this cheap to run nightly.
  - Every subprocess is given a timeout. A hung scan must not stall the batch.

Usage:
    python skillfinder.py --sources sources.json --ledger ledger.json
    python skillfinder.py --add https://github.com/acme/some-skill
    python skillfinder.py --report            # print the current triage table
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 2
STATIC_TIMEOUT = 180
LLM_TIMEOUT = 600          # hard subprocess ceiling; a hung scan must not wedge the crawl
CLONE_TIMEOUT = 120

# We do not cap the LLM leg ourselves. SkillSpector's own per-call timeout is
# 120s (hardcoded, not env-configurable) and it retries each batch 7x
# internally; anything looser from us never binds. When its LLM leg still fails,
# the fix is to re-invoke the whole scan a few minutes later -- the failures
# cluster in provider windows -- not to cap harder.
LLM_RETRY_ATTEMPTS = 3                      # whole-scan LLM invocations (initial + 2 retries)
LLM_RETRY_BACKOFF_SECONDS = (60, 180)       # sleep between attempt 1->2 and 2->3
# After this many consecutive runs where the LLM leg still fails and the static
# scan is otherwise benign, stop retrying: the cause is the skill's payload
# (too large for the model's per-call budget), not a provider window. K=3
# nightly runs, each already 3 in-run attempts with backoff, is ~9 whole-scan
# attempts over 3+ days before giving up -- a real outage rarely spans that.
LLM_PERSISTENT_FAILURE_RUNS = 3

# Incompleteness reasons that do not indicate the scanner missed content.
# reference_unresolved: a path-shaped string in prose that doesn't resolve.
# static_parse_limit: one bounded parser bailed on one expression -- benign
#   ONLY under the degraded-analyzer count guard below (scope, not reason name).
_BENIGN_INCOMPLETE_REASONS = {"reference_unresolved", "static_parse_limit"}
_MAX_BENIGN_DEGRADED = 1
# LLM-leg failure reasons: transient, worth a whole-scan retry. A static
# analyzer can also emit runtime_limit (its own 30s/artifact budget), so reason
# name alone can't classify -- the retry decision is gated on the static scan's
# own classification instead (see triage()).
_LLM_FAILURE_REASONS = {
    "runtime_limit", "llm_batch_failed",
    "llm_connection_retries_exhausted", "llm_structured_response_invalid",
}


def classify_incompleteness(sec: dict[str, Any]) -> tuple[str, str]:
    """('clean' | 'benign' | 'blind_spot', reason). Shared by both pipelines.

    Pipeline 1 records the raw completeness signals and this derived class;
    pipeline 2 routes on it. It answers "did the scanner miss content", not
    "is this skill a good fit".
    """
    if sec.get("is_complete"):
        return "clean", ""
    reasons = set(sec.get("ledger_exception_reasons") or [])
    ndeg = len(sec.get("degraded_analyzers") or [])
    hits: list[str] = []
    if sec.get("llm_requested") and sec.get("llm_ran") is False:
        hits.append("LLM leg did not complete")
    if ndeg > _MAX_BENIGN_DEGRADED:
        hits.append(f"{ndeg} analyzers degraded")
    extra = reasons - _BENIGN_INCOMPLETE_REASONS
    if extra:
        hits.append(f"reasons beyond benign set: {sorted(extra)}")
    if hits:
        return "blind_spot", "; ".join(hits)
    return "benign", f"incomplete but within benign bounds ({sorted(reasons) or 'no reason'})"


# --------------------------------------------------------------------------
# ledger io
# --------------------------------------------------------------------------

def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(url: str) -> str:
    s = re.sub(r"^https?://", "", url.strip().rstrip("/"))
    s = re.sub(r"\.git$", "", s)
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", s).lower().strip("-")
    return s or hashlib.sha256(url.encode()).hexdigest()[:16]


def migrate_ledger(data: dict[str, Any]) -> dict[str, Any]:
    """Bring an older ledger up to SCHEMA_VERSION in place. Shared by both scripts.

    v1 -> v2: pipeline 1 no longer pre-judges fitness with a SAFE/CAUTION state
    split, so the two handoff states collapse into one. `cleared` (was SAFE) and
    `scanned` (was CAUTION) both become `awaiting_fit`. The new security-block
    completeness fields are simply absent on migrated entries; pipeline 1's
    needs_rescan() treats a security block with no `is_complete` as stale and
    rescans it, and pipeline 2 skips any entry still missing it.
    """
    if data.get("schema_version") == 1:
        for entry in data.get("entries", {}).values():
            if entry.get("state") in ("cleared", "scanned"):
                entry["state"] = "awaiting_fit"
        data["schema_version"] = 2
    return data


def load_ledger(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "updated_at": now(), "entries": {}}
    data = migrate_ledger(json.loads(path.read_text()))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise SystemExit(f"ledger schema {data.get('schema_version')} != {SCHEMA_VERSION}")
    return data


def save_ledger(path: Path, ledger: dict[str, Any]) -> None:
    """Atomic write. A half-written ledger loses the whole history."""
    ledger["updated_at"] = now()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(ledger, indent=2, sort_keys=False))
    tmp.replace(path)


def log_event(entry: dict[str, Any], event: str, note: str = "") -> None:
    entry.setdefault("history", []).append(
        {"at": now(), "actor": "pipeline1", "event": event, **({"note": note} if note else {})}
    )


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

@dataclass
class Candidate:
    url: str
    origin: str
    name: str = ""
    ref: str | None = None

    @property
    def id(self) -> str:
        return slugify(self.url)


def discover_github_topic(topic: str, limit: int, since_days: int) -> list[Candidate]:
    """Search GitHub for repos carrying a skills topic, newest first.

    Unauthenticated calls are rate-limited to 10/min. Set GITHUB_TOKEN to raise
    that. Failure here is non-fatal: an empty list just means a quiet night.
    """
    q = f"topic:{topic} pushed:>={_days_ago(since_days)}"
    url = (
        "https://api.github.com/search/repositories"
        f"?q={urllib.parse.quote(q)}&sort=updated&order=desc&per_page={min(limit, 100)}"
    )
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    if token := os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.load(r)
    except Exception as exc:  # network, rate limit, malformed json
        print(f"[warn] github discovery failed: {exc}", file=sys.stderr)
        return []
    return [
        Candidate(url=item["html_url"], origin="github_topic", name=item["full_name"])
        for item in payload.get("items", [])[:limit]
    ]


def _days_ago(n: int) -> str:
    from datetime import timedelta

    return (datetime.now(timezone.utc) - timedelta(days=n)).date().isoformat()


def load_sources(path: Path) -> list[Candidate]:
    """sources.json shape:
    {
      "manual":       ["https://github.com/acme/skill-a", ...],
      "github_topics": [{"topic": "agent-skills", "limit": 50, "since_days": 7}]
    }
    """
    if not path.exists():
        return []
    cfg = json.loads(path.read_text())
    out: list[Candidate] = [Candidate(url=u, origin="manual") for u in cfg.get("manual", [])]
    for t in cfg.get("github_topics", []):
        out += discover_github_topic(
            t["topic"], t.get("limit", 50), t.get("since_days", 7)
        )
    # first occurrence wins, so a manual entry keeps its 'manual' origin
    seen: set[str] = set()
    deduped = []
    for c in out:
        if c.id not in seen:
            seen.add(c.id)
            deduped.append(c)
    return deduped


# --------------------------------------------------------------------------
# scanning
# --------------------------------------------------------------------------

@dataclass
class ScanResult:
    ok: bool
    score: int = 0
    severity: str = "LOW"
    recommendation: str = "SAFE"
    mode: str = "static"
    version: str = ""
    executable: bool = False
    findings: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    # which LLM produced this verdict, and the sampling controls it ran under.
    # Verdicts from different models are not comparable; the serving backend is
    # not observable through SkillSpector's JSON, so reproducibility rests on
    # seed + temperature. All None for a static-only scan.
    llm_model: str | None = None
    llm_provider: str | None = None
    llm_seed: int | None = None
    llm_temperature: float | None = None
    llm_requested: bool = False
    # completeness accounting, recorded raw for pipeline 2 to route on. Pipeline
    # 1 does not judge whether an incomplete scan is a real blind spot.
    is_complete: bool | None = None
    coverage_percent: float | None = None
    fully_inspected_files: int | None = None
    partially_inspected_files: int | None = None
    entirely_uninspected_files: int | None = None
    degraded_analyzers: list[str] = field(default_factory=list)
    ledger_exception_reasons: list[str] = field(default_factory=list)


def run_skillspector(target: str, use_llm: bool, baseline: Path | None) -> ScanResult:
    """Shell out to the CLI and parse its JSON contract.

    We deliberately do not import the package. Its Python API is not a stable
    surface; the CLI's JSON output is.
    """
    cmd = ["skillspector", "scan", target, "--format", "json"]
    if not use_llm:
        cmd.append("--no-llm")
    if baseline:
        cmd += ["--baseline", str(baseline)]

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=LLM_TIMEOUT if use_llm else STATIC_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return ScanResult(ok=False, error="scan timed out")
    except FileNotFoundError:
        return ScanResult(ok=False, error="skillspector not on PATH")

    # exit 2 means the scan itself failed; 0 and 1 both carry a real report
    if proc.returncode == 2:
        return ScanResult(ok=False, error=(proc.stderr or "").strip()[:500])

    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return ScanResult(ok=False, error="unparseable scanner output")

    # Fail closed on anything that parsed but is not a recognisable scan report.
    # `report.get("risk_assessment", {})` on a bare `{}` (or an error blob that
    # still exited 0/1) would otherwise fall through every default below and
    # hand back recommendation="SAFE" -- an absent verdict read as a clean one.
    risk = report.get("risk_assessment")
    meta = report.get("metadata")
    if not isinstance(risk, dict) or not isinstance(meta, dict):
        return ScanResult(ok=False, error="scan report missing risk_assessment/metadata")
    if risk.get("recommendation") not in ("SAFE", "CAUTION", "DO_NOT_INSTALL"):
        return ScanResult(ok=False, error=f"scan report has no known recommendation: {risk.get('recommendation')!r}")
    try:
        score = int(risk["score"])
    except (KeyError, TypeError, ValueError):
        return ScanResult(ok=False, error="scan report has no numeric score")

    # "available" is not "ran": a provider can be reachable while every call
    # fails. Require at least one successful call before trusting a full-scan
    # verdict (0 succeeded -> treat as static, same as a silent LLM fall-over).
    calls_ok = int(meta.get("llm_calls_succeeded", 0) or 0)
    usage = meta.get("inference_usage") or []
    llm_really_ran = (
        bool(meta.get("llm_requested"))
        and bool(meta.get("llm_available"))
        and (calls_ok > 0 or bool(usage))
    )

    llm_model = llm_provider = llm_seed = llm_temperature = None
    if llm_really_ran:
        # top-level metadata.llm_model is null in practice; the real values are
        # per-call in inference_usage[]. SkillSpector never echoes seed or
        # temperature, so read them from the env this process will hand the
        # subprocess (subprocess inherits our env).
        first = usage[0] if usage and isinstance(usage[0], dict) else {}
        llm_model = first.get("model") or os.environ.get("SKILLSPECTOR_MODEL") or None
        llm_provider = first.get("provider") or None
        raw_seed = os.environ.get("SKILLSPECTOR_SEED", "").strip()
        if raw_seed.lstrip("-").isdigit():
            llm_seed = int(raw_seed)
        raw_temp = os.environ.get("SKILLSPECTOR_TEMPERATURE", "").strip()
        if raw_temp:
            try:
                llm_temperature = float(raw_temp)
            except ValueError:
                llm_temperature = None

    ac = report.get("analysis_completeness") or {}
    statuses = ac.get("analyzer_statuses") or []
    # Only degraded/failed/partial are blind-spot signals. `disabled` (e.g.
    # meta_analyzer under --no-llm) and `not_applicable` are intentional skips,
    # not coverage gaps -- counting them would push a benign skill like
    # trellis-plan over _MAX_BENIGN_DEGRADED.
    degraded = sorted(
        a.get("analyzer_id", "?")
        for a in statuses
        if isinstance(a, dict) and a.get("status") in ("degraded", "failed", "partial")
    )
    exc_reasons = sorted(
        {e.get("reason_code") for e in (ac.get("ledger_exceptions") or [])
         if isinstance(e, dict) and e.get("reason_code")}
    )

    return ScanResult(
        ok=True,
        score=score,
        severity=risk.get("severity", "LOW"),
        recommendation=risk["recommendation"],
        # never record a full-scan verdict if the LLM leg silently fell over
        mode="static+llm" if llm_really_ran else "static",
        version=meta.get("skillspector_version", ""),
        executable=bool(meta.get("has_executable_scripts")),
        # an empty `issues` list is a legitimate clean result, distinct from the
        # failure modes above which return ok=False.
        findings=[_slim(i) for i in report.get("issues", [])],
        llm_model=llm_model,
        llm_provider=llm_provider,
        llm_seed=llm_seed,
        llm_temperature=llm_temperature,
        llm_requested=bool(use_llm),
        is_complete=ac.get("is_complete"),
        coverage_percent=ac.get("coverage_percent"),
        fully_inspected_files=ac.get("fully_inspected_files"),
        partially_inspected_files=ac.get("partially_inspected_files"),
        entirely_uninspected_files=ac.get("entirely_uninspected_files"),
        degraded_analyzers=degraded,
        ledger_exception_reasons=exc_reasons,
    )


def _slim(issue: dict[str, Any]) -> dict[str, Any]:
    loc = issue.get("location") or {}
    out = {
        "rule_id": issue.get("id") or issue.get("rule_id", "?"),
        "severity": issue.get("severity", "LOW"),
    }
    for k, v in (
        ("category", issue.get("category")),
        ("confidence", issue.get("confidence")),
        ("file", loc.get("file")),
        ("line", loc.get("start_line")),
        # SkillSpector emits `finding` (short) and `explanation` (long); there is
        # no `message` key.
        ("message", issue.get("message") or issue.get("finding") or issue.get("explanation")),
    ):
        if v is not None:
            out[k] = v
    return out


def content_hash(url: str) -> str | None:
    """Shallow clone and hash the tree so we can skip unchanged skills.

    Hashing filenames alongside contents means a renamed-but-identical file
    still counts as a change, which is what we want for a security ledger.
    """
    tmp = tempfile.mkdtemp(prefix="skillhash-")
    try:
        proc = subprocess.run(
            ["git", "clone", "--depth", "1", "--quiet", url, tmp + "/repo"],
            capture_output=True, text=True, timeout=CLONE_TIMEOUT,
        )
        if proc.returncode != 0:
            return None
        h = hashlib.sha256()
        root = Path(tmp) / "repo"
        for p in sorted(root.rglob("*")):
            if p.is_file() and ".git" not in p.parts:
                h.update(str(p.relative_to(root)).encode())
                h.update(p.read_bytes())
        return h.hexdigest()
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def needs_rescan(
    entry: dict[str, Any], new_hash: str | None, want_llm: bool, *, hash_attempted: bool
) -> bool:
    sec = entry.get("security")
    if not sec:
        return True
    # A v1 security block has no completeness fields. Pipeline 2 skips those, so
    # rescan to populate them rather than leaving the entry stranded.
    if "is_complete" not in sec:
        return True
    # A failed clone-and-hash returns None, which is not "unchanged" -- it is
    # "could not verify". Don't let that read as a cache hit.
    if hash_attempted and new_hash is None:
        return True
    if new_hash and entry.get("content_hash") != new_hash:
        return True
    if want_llm and sec.get("scan_mode") == "static":
        return True  # upgrade a static-only verdict to a full one
    # A provider-unavailable blind spot is not settled: the next run retries it.
    # `provider_persistent` and `structural` ARE settled -- only a content-hash
    # change (handled above) forces those to be looked at again.
    if sec.get("blind_spot_kind") == "provider_unavailable":
        return True
    return False


def _completeness_view(res: "ScanResult", llm_ran: bool) -> dict[str, Any]:
    """The subset of a ScanResult that classify_incompleteness() reads."""
    return {
        "is_complete": res.is_complete,
        "ledger_exception_reasons": res.ledger_exception_reasons,
        "degraded_analyzers": res.degraded_analyzers,
        "llm_requested": res.llm_requested,
        "llm_ran": llm_ran,
    }


def gate2_with_retries(
    url: str,
    baseline: Path | None,
    static_res: "ScanResult",
    static_class: str,
    *,
    on_retry: "callable | None" = None,
) -> tuple["ScanResult", list[dict[str, Any]]]:
    """Run the LLM leg, retrying a *transient* failure with backoff.

    Transient == the LLM leg did not complete but the skill's own static scan is
    benign/clean (static_class), i.e. only the provider dropped the request. A
    structural failure (static_class already blind_spot) is not retried -- it
    fails identically every time. Returns (best ScanResult seen, attempt_log);
    falls back to static_res so a failed LLM leg never loses the gate-1 verdict.
    """
    best = static_res
    attempts: list[dict[str, Any]] = []
    for i in range(LLM_RETRY_ATTEMPTS):
        up = run_skillspector(url, True, baseline)
        ran = up.ok and up.mode == "static+llm"
        err = None if ran else (
            up.error or "; ".join(up.ledger_exception_reasons) or "LLM leg did not complete"
        )[:200]
        attempts.append({"at": now(), "error": err})
        if up.ok:
            best = up  # a fuller result than static, even when the LLM leg failed
        if ran or static_class not in ("benign", "clean"):
            break
        if i + 1 < LLM_RETRY_ATTEMPTS:
            delay = LLM_RETRY_BACKOFF_SECONDS[min(i, len(LLM_RETRY_BACKOFF_SECONDS) - 1)]
            if on_retry:
                on_retry(i + 1, err, delay)
            time.sleep(delay)
    return best, attempts


def blind_spot_kind_for(res: "ScanResult", static_class: str, llm_ran: bool) -> str | None:
    """Classify a blind spot's *nature* -- structural vs a dropped provider request."""
    final_class, _ = classify_incompleteness(_completeness_view(res, llm_ran))
    if final_class != "blind_spot":
        return None
    llm_leg_failed = res.llm_requested and not llm_ran
    return (
        "provider_unavailable"
        if llm_leg_failed and static_class in ("benign", "clean")
        else "structural"
    )


def triage(
    candidates: Iterable[Candidate],
    ledger: dict[str, Any],
    *,
    workers: int,
    use_llm: bool,
    baseline: Path | None,
    skip_hash: bool,
) -> dict[str, int]:
    entries = ledger["entries"]
    counts = {"skipped": 0, "safe": 0, "caution": 0, "blocked": 0, "error": 0}
    work: list[tuple[Candidate, dict[str, Any]]] = []

    for cand in candidates:
        entry = entries.get(cand.id)
        if entry is None:
            entry = {
                "id": cand.id,
                "name": cand.name or cand.id,
                "source": {"url": cand.url, "origin": cand.origin},
                "discovered_at": now(),
                "content_hash": None,
                "state": "discovered",
                "history": [],
            }
            log_event(entry, "discovered", cand.origin)
            entries[cand.id] = entry

        h = None if skip_hash else content_hash(cand.url)
        if not needs_rescan(entry, h, use_llm, hash_attempted=not skip_hash):
            counts["skipped"] += 1
            continue
        if h:
            entry["content_hash"] = h
        work.append((cand, entry))

    # gate 1: static, wide, free
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        static = dict(
            zip(
                (c.id for c, _ in work),
                pool.map(lambda ce: run_skillspector(ce[0].url, False, baseline), work),
            )
        )

    for cand, entry in work:
        res = static[cand.id]

        # gate 2: LLM, narrow, paid.
        #  - crawled bulk: skip anything static already condemned; no point
        #    paying to explain obvious garbage.
        #  - manual (--add or sources.json "manual"): always run it. If someone
        #    asked about a specific skill and it comes back CRITICAL, they want
        #    the explanation, not just the number.
        # The static scan's own classification decides whether a failing LLM leg
        # is worth retrying: if static alone is already a blind spot (docx:
        # 13 degraded + obfuscated_instruction_text), the LLM leg failing again
        # changes nothing -- structural, no retry. If static is benign/clean,
        # only the LLM leg's failure pushes it over -- transient, retry.
        static_class, _ = classify_incompleteness(_completeness_view(res, llm_ran=False))

        manual = cand.origin == "manual"
        attempt_log: list[dict[str, Any]] = []
        if use_llm and res.ok and (manual or res.recommendation != "DO_NOT_INSTALL"):
            res, attempt_log = gate2_with_retries(
                cand.url, baseline, res, static_class,
                on_retry=lambda n, err, delay: log_event(
                    entry, "gate2_retry", f"attempt {n} failed ({err}); backing off {delay}s"
                ),
            )

        llm_attempts = len(attempt_log)
        llm_ran = res.mode == "static+llm"
        blind_spot_kind = blind_spot_kind_for(res, static_class, llm_ran)

        # Cross-run counter: how many consecutive runs the LLM leg has come back
        # provider_unavailable. Reset by any other outcome (a success, a
        # structural blind spot, a static-only run). Once it reaches K, the
        # cause is the payload, not a provider window -- promote to a terminal
        # kind so needs_rescan() stops churning one paid attempt per night.
        prior_fails = int((entry.get("security") or {}).get("consecutive_provider_failures", 0) or 0)
        if blind_spot_kind == "provider_unavailable":
            consecutive_provider_failures = prior_fails + 1
            if consecutive_provider_failures >= LLM_PERSISTENT_FAILURE_RUNS:
                blind_spot_kind = "provider_persistent"
                log_event(entry, "provider_persistent",
                          f"LLM leg failed {consecutive_provider_failures} consecutive runs; "
                          f"payload likely exceeds the model's per-call budget")
        else:
            consecutive_provider_failures = 0

        entry["security"] = {
            "scanned_at": now(),
            "scanner_version": res.version,
            "scan_mode": res.mode,
            "score": res.score,
            "severity": res.severity,
            "recommendation": res.recommendation,
            "has_executable_scripts": res.executable,
            "findings": res.findings,
            "baseline_applied": str(baseline) if baseline else None,
            "error": res.error,
            # null unless the LLM leg actually ran; verdicts from different
            # models are not comparable, and seed+temperature are what make one
            # reproducible (the serving backend is not recoverable).
            "llm_model": res.llm_model,
            "llm_provider": res.llm_provider,
            "llm_seed": res.llm_seed,
            "llm_temperature": res.llm_temperature,
            "llm_requested": res.llm_requested,
            "llm_ran": llm_ran,
            "llm_attempts": llm_attempts,
            "llm_last_error": attempt_log[-1]["error"] if attempt_log else None,
            "llm_attempt_log": attempt_log,
            # distinguishes "the scanner couldn't read this skill" (settled) from
            # "the provider dropped the request" (retry it) -- so a nightly crawl
            # doesn't treat Tuesday as a property of the skill. provider_persistent
            # is provider_unavailable that has stopped being plausibly transient.
            "blind_spot_kind": blind_spot_kind,
            "consecutive_provider_failures": consecutive_provider_failures,
            # raw completeness accounting; pipeline 2 decides what it means.
            "is_complete": res.is_complete,
            "coverage_percent": res.coverage_percent,
            "fully_inspected_files": res.fully_inspected_files,
            "partially_inspected_files": res.partially_inspected_files,
            "entirely_uninspected_files": res.entirely_uninspected_files,
            "degraded_analyzers": res.degraded_analyzers,
            "ledger_exception_reasons": res.ledger_exception_reasons,
        }

        if not res.ok:
            entry["state"] = "discovered"
            counts["error"] += 1
            log_event(entry, "scan_failed", res.error or "")
            continue

        # Pipeline 1 no longer pre-judges fitness. Everything that scanned and is
        # not DO_NOT_INSTALL is handed to pipeline 2, which routes on the raw
        # signals above.
        if res.recommendation == "DO_NOT_INSTALL":
            entry["state"] = "quarantined"
            counts["blocked"] += 1
        else:
            entry["state"] = "awaiting_fit"
            counts["safe" if res.recommendation == "SAFE" else "caution"] += 1

        bsk = f" blind_spot={blind_spot_kind}" if blind_spot_kind else ""
        atl = f" llm_attempts={llm_attempts}" if llm_attempts > 1 else ""
        log_event(
            entry, "scanned",
            f"{res.recommendation} score={res.score} mode={res.mode}{atl}{bsk}",
        )

    return counts


def report(ledger: dict[str, Any]) -> None:
    rows = []
    for e in ledger["entries"].values():
        sec = e.get("security") or {}
        rows.append(
            (
                sec.get("recommendation", "-"),
                sec.get("score", "-"),
                e.get("state", "-"),
                e["id"][:52],
            )
        )
    order = {"DO_NOT_INSTALL": 0, "CAUTION": 1, "SAFE": 2, "-": 3}
    rows.sort(key=lambda r: (order.get(r[0], 3), -(r[1] if isinstance(r[1], int) else 0)))
    print(f"{'verdict':<16}{'score':>6}  {'state':<14}skill")
    print("-" * 96)
    for rec, score, state, sid in rows:
        print(f"{rec:<16}{str(score):>6}  {state:<14}{sid}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Pipeline 1 - discover and security-triage skills")
    ap.add_argument("--ledger", type=Path, default=Path("ledger.json"))
    ap.add_argument("--sources", type=Path, default=Path("sources.json"))
    ap.add_argument("--add", action="append", default=[], metavar="URL",
                    help="add a skill by URL (repeatable); skips crawling")
    ap.add_argument("--baseline", type=Path, default=None,
                    help="suppress already-triaged findings so only new ones score")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--no-llm", action="store_true", help="gate 1 only")
    ap.add_argument("--skip-hash", action="store_true",
                    help="skip clone-and-hash change detection (faster, rescans everything)")
    ap.add_argument("--report", action="store_true", help="print the ledger and exit")
    args = ap.parse_args()

    ledger = load_ledger(args.ledger)

    if args.report:
        report(ledger)
        return 0

    candidates = (
        [Candidate(url=u, origin="manual") for u in args.add]
        if args.add
        else load_sources(args.sources)
    )
    if not candidates:
        print("no candidates", file=sys.stderr)
        return 0

    counts = triage(
        candidates,
        ledger,
        workers=args.workers,
        use_llm=not args.no_llm,
        baseline=args.baseline,
        skip_hash=args.skip_hash,
    )
    save_ledger(args.ledger, ledger)

    print(
        f"{len(candidates)} candidates | "
        f"safe {counts['safe']} | caution {counts['caution']} | "
        f"blocked {counts['blocked']} | errors {counts['error']} | "
        f"unchanged {counts['skipped']}"
    )
    # non-zero when something new was quarantined, so a cron wrapper can alert
    return 1 if counts["blocked"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
