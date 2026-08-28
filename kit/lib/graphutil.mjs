/**
 * Shared, iterative dependency-cycle detection.
 *
 * Two graphs in this kit each need "does this DAG have a cycle": the product
 * graph (product.mjs, at ingest) and the task graph (graph.mjs, at validate/
 * run time). Each used to carry its own implementation, and they had drifted
 * into genuinely different shapes — product.mjs's was RECURSIVE (one JS call
 * frame per edge on the current path), which is exactly the kind of graph
 * algorithm that blows the call stack on a long enough chain; a migration
 * modelled as a few thousand sequential steps would crash `trellis ingest`
 * with a RangeError instead of reporting the cycle it may or may not have.
 * graph.mjs's version was already iterative for this reason. Fixing the
 * duplication and the stack-overflow risk were the same fix.
 */
export function findCycle(byId, depsOf = (n) => n?.deps ?? []) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map([...byId.keys()].map((k) => [k, WHITE]));
  for (const start of byId.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack = [[start, 0]];
    const trail = [];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [id, i] = frame;
      if (i === 0) { color.set(id, GREY); trail.push(id); }
      const deps = depsOf(byId.get(id)) || [];
      if (i < deps.length) {
        frame[1]++;
        const d = deps[i];
        // An id absent from byId is an unknown-dependency error reported
        // elsewhere by the caller's own field validation — inert here rather
        // than dereferenced, so a malformed graph cannot crash cycle detection.
        if (!byId.has(d)) continue;
        if (color.get(d) === GREY) {
          return trail.slice(trail.indexOf(d)).concat(d);
        }
        if (color.get(d) === WHITE) stack.push([d, 0]);
      } else {
        color.set(id, BLACK);
        trail.pop();
        stack.pop();
      }
    }
  }
  return null;
}
