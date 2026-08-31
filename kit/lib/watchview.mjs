import { levels } from "./graph.mjs";
import * as st from "./state.mjs";

/**
 * The `trellis watch` view, as data.
 *
 * It is exactly the `trellis validate` level printout — longest-path depth,
 * nodes grouped by level — with each node's live status folded in from
 * state.json. A node with no state entry (run not started, or added since) is
 * `pending`, never absent: the level structure comes from the graph and does
 * not move as a run progresses.
 *
 * Pure: no colour, no I/O. cli.mjs paints it for the terminal; watchHtml()
 * renders the same model to a standalone file.
 */
export function watchModel(graph, state) {
  const depth = levels(graph);
  const byLevel = new Map();
  for (const [id, d] of depth) {
    if (!byLevel.has(d)) byLevel.set(d, []);
    byLevel.get(d).push(id);
  }
  const nodes = state?.nodes ?? {};
  const title = new Map(graph.nodes.map((n) => [n.id, n.title || ""]));

  const levelsOut = [...byLevel.keys()]
    .sort((a, b) => a - b)
    .map((d) => ({
      depth: d,
      nodes: byLevel.get(d).map((id) => ({
        id,
        title: title.get(id) ?? "",
        status: nodes[id]?.status ?? st.STATUS.PENDING,
        tier: nodes[id]?.tier ?? null,
        attempts: (nodes[id]?.attempts ?? []).length,
      })),
    }));

  const head = state
    ? `${state.project} — run ${String(state.runId).slice(0, 8)} — ${state.finishedAt ? "finished" : "in progress"}`
    : `${graph.project ?? "(unnamed)"} — no run yet`;

  return { head, levels: levelsOut, summary: state ? st.rollup(state) : null };
}

/**
 * A self-contained HTML snapshot of the same model — the whole thing in one
 * file, JSON inlined, no external request. Not a live page: it is regenerated
 * on disk every time `trellis watch` re-renders. `<` in the payload is escaped
 * so the data can never open a tag.
 */
export function watchHtml(model, { generatedAt = new Date().toISOString(), project = "" } = {}) {
  const json = JSON.stringify({ ...model, generatedAt }).replace(/</g, "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trellis watch${project ? ` — ${project}` : ""}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 2rem; }
  h1 { font-size: 1rem; margin: 0 0 1rem; }
  h2 { font-size: .85rem; margin: 1.3rem 0 .2rem; opacity: .6; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; max-width: 64rem; }
  td { padding: .15rem .7rem .15rem 0; white-space: nowrap; vertical-align: top; }
  td.title { white-space: normal; opacity: .75; }
  .merged, .audit { color: #1a7f37; }
  .weak-tests, .review { color: #9a6700; }
  .exhausted, .conflict, .budget-stopped { color: #cf222e; }
  .running { color: #0969da; }
  .pending, .blocked { opacity: .45; }
  .meta { opacity: .55; margin-top: 1.6rem; font-size: .85rem; }
</style>
<h1 id="head"></h1>
<div id="body"></div>
<p class="meta" id="meta"></p>
<script>
const M = ${json};
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
document.getElementById("head").textContent = M.head;
const out = [];
for (const lv of M.levels) {
  out.push("<h2>level " + lv.depth + "</h2><table>");
  for (const n of lv.nodes) {
    out.push(
      "<tr><td class='" + n.status + "'>" + n.status + "</td>" +
      "<td>" + esc(n.id) + "</td>" +
      "<td>" + esc(n.tier || "") + "</td>" +
      "<td>" + (n.attempts || "") + "</td>" +
      "<td class='title'>" + esc(n.title) + "</td></tr>"
    );
  }
  out.push("</table>");
}
document.getElementById("body").innerHTML = out.join("");
document.getElementById("meta").textContent =
  (M.summary ? M.summary.done + "/" + M.summary.total + " landed · " : "") +
  "generated " + M.generatedAt + " · static snapshot — re-run \`trellis watch\` to refresh";
</script>
`;
}
