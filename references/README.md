# References — Layer 3

The factory. Configured once, stable across runs, internalised as constraints.

Contrast with `.trellis/` (Layer 4), which is the product: graphs, plans, cases,
reports, all specific to one run and processed as input.

```
references/
  chiefs/           review lenses by domain — loaded per node
  skills/           your drop point, one folder per lens
  conventions.md    repo-wide rules every stage restates to workers
  scale-tiers.md    what breaks at 1, 10, 100, 1k, 10k users
  EVOLUTION.md      how Trellis is allowed to change itself
```

Nothing here is loaded wholesale. Each stage's `CONTEXT.md` names what it reads,
and each node's `lenses` array names which chiefs and skills apply to it.
