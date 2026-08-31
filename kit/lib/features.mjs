/**
 * Node features for routing (item 15), derived from fields the ledger
 * already records — dep count, write count, test count — rather than new
 * graph fields. A new field on the task-graph schema would need a schema
 * version bump and a migration story; a number derived from arrays already
 * on every node needs neither.
 *
 * Deliberately a coarse, three-bucket size signal and nothing cleverer:
 * routing.mjs's own docblock says anything cleverer than "where to start,
 * which tiers to skip" would be unexplainable and unfalsifiable. This adds
 * exactly one more axis to pool observations by, using the SAME pooling
 * machinery tag-based routing already has — see routing.mjs's planTiers,
 * which folds this bucket into the same `tags` array it already unions
 * observations across, rather than a second routing mechanism running
 * alongside the first.
 *
 * A shared module, not folded into ledger.mjs or routing.mjs directly:
 * routing.mjs already imports tierStats from ledger.mjs, so ledger.mjs
 * importing back from routing.mjs would be circular.
 */

const SMALL_MAX = 2;
const MEDIUM_MAX = 5;

/** One synthetic "tag" summarising a node's rough size, from counts already
 *  stored on every ledger row and every task-graph node. */
export function featureBucket({ depCount = 0, writeCount = 0, testCount = 0 } = {}) {
  const size = depCount + writeCount + testCount;
  if (size <= SMALL_MAX) return "size:small";
  if (size <= MEDIUM_MAX) return "size:medium";
  return "size:large";
}

/** The same bucket, computed straight from a task-graph node's own arrays —
 *  what planTiers has on hand before any ledger row exists for it. */
export function nodeFeatureBucket(node) {
  return featureBucket({
    depCount: (node.deps ?? []).length,
    writeCount: (node.write ?? []).length,
    testCount: (node.tests ?? []).length,
  });
}
