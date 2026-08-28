// What was expensive about building the software, as opposed to what was wrong
// with it.
//
// Rejection codes and attempt kinds are both about the product. Neither can see
// the thing you actually want to automate: the orchestrator quietly doing work by
// hand, session after session, because no tool exists for it. run.jsonl cannot
// see it either — that file records the mechanical loop, and this happens in the
// sessions around it.
//
// Be honest about the ceiling before reading further: you cannot verify a
// self-report. Anything a driver can check, a model can satisfy with an equally
// cheap lie. The design goal is not to make lying impossible. It is to turn
// silence into a signed statement, and to make the lie visible as a PATTERN
// across runs rather than an accusation against any one session.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl } from "./paths.mjs";
import { loadCodes, normaliseCode } from "./codes.mjs";

/**
 * The closed set of friction shapes.
 *
 * Deliberately small. A taxonomy with thirty entries gets the nearest-fit
 * treatment and stops meaning anything; the free-text `note` carries the detail.
 */
export const FRICTION_KINDS = Object.freeze(
  new Set([
    "manual-edit",       // fixed an artifact by hand
    "repeated-read",     // read the same thing more than twice
    "missing-tool",      // wanted a capability that does not exist
    "context-refetch",   // re-derived something a previous session knew
    "hand-transform",    // did a mechanical transformation manually
    "contract-gap",      // the stage contract did not say what to do
    "none",              // explicit assertion that there was none
  ])
);

/** Verbosity must not be rewarded any more than silence is. */
export const MAX_PER_STAGE_RUN = 10;

export function frictionPath(root, cfg) {
  return path.join(root, cfg?.paths?.state ?? ".trellis", "friction.jsonl");
}

/**
 * Validate a record before it is written.
 *
 * Note what is NOT checked: whether the claim is true. This rejects records that
 * cannot be counted — a bad kind, a missing stage — and nothing else.
 */
export function validate(rec) {
  const errors = [];
  if (!rec || typeof rec !== "object") return ["not an object"];
  if (!rec.stage) errors.push("stage is required — a record no stage owns cannot be verified");
  if (!FRICTION_KINDS.has(rec.kind)) {
    errors.push(`kind "${rec.kind}" is not one of: ${[...FRICTION_KINDS].join(", ")}`);
  }
  if (rec.kind !== "none" && !rec.code) {
    errors.push("code is required unless kind is 'none' — an uncoded record cannot be counted");
  }
  if (rec.count !== undefined && (!Number.isInteger(rec.count) || rec.count < 1)) {
    errors.push("count must be a whole number >= 1");
  }
  if (rec.note !== undefined && String(rec.note).length > 140) {
    errors.push("note must be 140 characters or fewer — it is context, not a report");
  }
  return errors;
}

export function read(root, cfg) {
  const p = frictionPath(root, cfg);
  if (!fs.existsSync(p)) return [];
  return parseJsonl(fs.readFileSync(p, "utf8")).filter(Boolean);
}

/**
 * Append one record, stamping `ts` and `run` here rather than accepting them.
 *
 * That is the whole reason this goes through code instead of a model appending
 * JSONL. The two fields that make cross-run counting possible are exactly the two
 * a hand-written line would get wrong — omitted, or carrying last run's id — and
 * a record that cannot be attributed to a run is not evidence of anything.
 */
export function append(root, cfg, rec, { run }) {
  const errors = validate(rec);
  if (errors.length) throw new Error(errors.join("; "));
  if (!run) throw new Error("no runId available to stamp this record against");

  const existing = read(root, cfg).filter((r) => r.run === run && r.stage === rec.stage);
  if (existing.length >= MAX_PER_STAGE_RUN) {
    throw new Error(
      `${MAX_PER_STAGE_RUN} friction records already recorded for ${rec.stage} in this run. ` +
        `The cap is deliberate: a long list is as uninformative as an empty one.`
    );
  }

  const row = {
    ts: new Date().toISOString(),
    run,
    stage: rec.stage,
    kind: rec.kind,
    ...(rec.code ? { code: rec.code } : {}),
    ...(rec.target ? { target: rec.target } : {}),
    ...(rec.count ? { count: rec.count } : {}),
    ...(rec.note ? { note: String(rec.note) } : {}),
  };

  const p = frictionPath(root, cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + "\n");
  return row;
}

/**
 * Did this stage report anything at all for this run?
 *
 * The verify predicate. `--none` satisfies it, and that is the point: it converts
 * an absence, which is uncheckable and deniable, into a claim sitting in an
 * append-only file next to the mechanical record that can contradict it.
 */
export function assertedFor(root, cfg, { run, stage }) {
  if (!run) return { ok: false, detail: "no runId to attribute friction to" };
  const rows = read(root, cfg).filter((r) => r.run === run && r.stage === stage);
  if (!rows.length) {
    return {
      ok: false,
      detail:
        `no friction record for ${stage} in run "${run}" — ` +
        `report what you did by hand, or assert none with \`trellis friction --stage ${stage} --none\``,
    };
  }
  const reported = rows.filter((r) => r.kind !== "none");
  return {
    ok: true,
    detail: reported.length ? `${reported.length} friction record(s)` : "asserted none",
    assertedNone: reported.length === 0,
  };
}

/**
 * Counts by code across distinct runs, same discipline as every other source.
 *
 * Normalising here — at READ time — is the whole point, and it was missing.
 * `cmdFriction` normalises what it writes, but friction.jsonl is a plain file a
 * human can edit (MISSION invariant 5) and nothing else re-checked it. A
 * hand-written line reading `"code": "gate.mjs is too strict"` across three runs
 * produced a pattern that cleared the threshold and landed on the shortlist,
 * pointing at a protected file. That is precisely the threshold evasion the
 * vocabulary exists to prevent, and rejectionCounts already does it right —
 * see the comment there for why read-time is the correct moment.
 *
 * `Object.create(null)` because the accumulator is keyed by codes read from a
 * file: a line with `"code": "__proto__"` used to walk into Object.prototype and
 * mutate it process-wide before throwing. Normalisation above now neutralises
 * that payload on its own, so this is depth rather than the active defence — and
 * deliberately so, since it is the thing that still holds if normalisation is
 * ever bypassed. No regression check distinguishes the two; that is accurate
 * rather than an oversight.
 */
export function counts(root, cfg, { codes = null } = {}) {
  const vocab = codes ?? loadCodes(root);
  const out = Object.create(null);
  for (const r of read(root, cfg)) {
    if (r.kind === "none" || !r.code) continue;
    const code = normaliseCode(r.code, vocab, "friction");
    if (!code) continue;
    out[code] ??= { code, count: 0, runs: new Set(), stages: new Set(), targets: new Set() };
    // A hand-written `count` is not a licence to outweigh everything else: the
    // shortlist sorts on occurrences, so an unbounded value here reorders which
    // patterns stage 07 is allowed to see.
    const n = Number.isInteger(r.count) && r.count > 0 ? Math.min(r.count, MAX_PER_STAGE_RUN) : 1;
    out[code].count += n;
    if (r.run) out[code].runs.add(r.run);
    if (r.stage) out[code].stages.add(r.stage);
    if (r.target) out[code].targets.add(r.target);
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [
      k,
      { code: v.code, count: v.count, runs: v.runs.size, stages: [...v.stages], targets: [...v.targets] },
    ])
  );
}

/**
 * Stage-runs that asserted `none` while the mechanical record says otherwise.
 *
 * This is what gives the assertion teeth. A single contradiction proves nothing —
 * a triage session can legitimately have a smooth time on a run with exhausted
 * nodes. But the same contradiction across three or more distinct runs is a
 * pattern about the loop, and it is subject to exactly the same threshold as
 * everything else.
 *
 * It never accuses a session. It counts.
 */
export function contradictions(root, cfg, { ledgerRecords = [], triageRows = [] } = {}) {
  const rows = read(root, cfg);
  const asserted = new Map();
  for (const r of rows) {
    if (!r.run) continue;
    const key = `${r.run}|${r.stage}`;
    if (!asserted.has(key)) asserted.set(key, { run: r.run, stage: r.stage, none: true });
    if (r.kind !== "none") asserted.get(key).none = false;
  }

  const exhaustedByRun = {};
  for (const rec of ledgerRecords) {
    if (rec.status === "exhausted") exhaustedByRun[rec.runId] = (exhaustedByRun[rec.runId] ?? 0) + 1;
  }
  const rejectsByRun = {};
  for (const row of triageRows) {
    const n = (Array.isArray(row?.decisions) ? row.decisions : []).filter((d) => d?.verdict === "reject").length;
    if (n) rejectsByRun[row.run] = (rejectsByRun[row.run] ?? 0) + n;
  }

  const out = [];
  for (const { run, stage, none } of asserted.values()) {
    if (!none) continue;
    const why = [];
    if (exhaustedByRun[run]) why.push(`${exhaustedByRun[run]} exhausted node(s)`);
    if ((rejectsByRun[run] ?? 0) >= 2) why.push(`${rejectsByRun[run]} rejections`);
    if (why.length) out.push({ run, stage, why });
  }
  return out;
}
