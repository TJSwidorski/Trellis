# Chiefs — review lenses

The Chief Office, as documents rather than agents.

Each file is a lens: a short set of rules and traps applied at specific gates. A
node's `lenses` array names which ones load when that node is planned and reviewed.

They are documents on purpose. A security subagent costs a session; `security.md`
costs a thousand tokens and applies the same judgement at planning time *and*
again at triage, which is where it actually catches things.

Keep each file under ~2,000 tokens. When one grows past that, split it by concern
rather than letting it become a document nobody's context can afford.
