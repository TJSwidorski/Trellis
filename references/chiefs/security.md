# Security lens

Loaded for any node whose `surfaces` is not `["none"]`, and at triage for every
high-risk node.

## Hard rules

- Secrets never enter source, tests, fixtures, logs, or error messages. Config or
  environment only.
- Every input crossing a trust boundary is validated at the boundary, not deep
  inside the call stack where the caller's assumptions are invisible.
- Parameterised queries always. String-built SQL is a defect regardless of whether
  the input "can't" be hostile.
- Authorisation is checked at the resource, not at the route. A route guard plus a
  direct object reference is the most common real-world hole.
- Errors returned to a user say what they did wrong. They do not say what the
  system is, what version it runs, or where the file lives.

## Traps specific to generated code

- **Auth that checks authentication and calls it authorization.** Logged in is not
  the same as allowed, and a test that logs in and succeeds proves nothing.
- **Validation written from the happy path.** The test asserts a valid input
  passes. Nothing asserts an invalid one is rejected, so the branch may not exist.
- **Secrets in test fixtures** that get committed because the test needed something
  that looked real.
- **Permissive defaults.** CORS `*`, cookies without `SameSite`, an open bucket —
  each is one line and each survives review because it is not wrong-looking.

## At triage

For each high-risk node ask: what would an attacker send that the test never sent?
If the answer is easy, the gap is in stage 03, and the rejection code belongs to
the cases skill rather than to the worker.
