# receipt — cart pricing engine

A first Trellis test. Deliberately chosen: no external dependencies, real
correctness surface, and a dependency shape that exercises the graph properly
(two parallel roots, two parallel middles, one convergence).

Copy this to `SPEC.md` in your repo root, then follow `QUICKSTART.md` from
step 6 — `trellis slice`, then the `sessions/02_slice` → `04_tests` stages —
or drive the whole pipeline with `trellis auto`.

---

## What this is

A pure library that turns a cart of line items into a priced receipt: subtotal,
discounts, tax, total. No HTTP, no database, no UI. Everything is a function.

## Stack

- language / runtime: Node 20+, ESM (`.mjs`), no dependencies
- test runner: `node --test`
- run one test file: `node --test tests/<name>.test.mjs`
- lint / typecheck: none
- data store: none — the catalog is an injected plain object

## Scope for this run

- [ ] Integer-cent money arithmetic with explicit, documented rounding
- [ ] Product catalog lookup with sku validation
- [ ] Discount rule engine: percent-off, buy-n-get-one-free, and a stacking cap
- [ ] Tax calculation applied to the post-discount subtotal, by jurisdiction rate
- [ ] Receipt composition: line items, subtotal, discount total, tax, grand total

## Explicitly not in scope

- Currencies other than USD
- Floating-point money anywhere, at any layer
- Persistence, HTTP, serialization formats
- Coupon codes, gift cards, loyalty points
- Internationalization or locale-aware formatting
- Any dependency from npm

## Interfaces already decided

Money is **always** an integer number of cents. Never a float, never a string,
never a Decimal object.

```js
// src/money.mjs
export function parse(dollarsString)          // "12.34" -> 1234, throws on bad input
export function multiplyRate(cents, rate)     // rate is a float like 0.0825
export function format(cents)                 // 1234 -> "$12.34"

// src/catalog.mjs
export function createCatalog(products)       // products: { [sku]: { name, priceCents } }
// returns { lookup(sku) -> { sku, name, priceCents }, has(sku) -> boolean }
// lookup throws on an unknown sku

// src/discounts.mjs
export function applyDiscounts(lines, rules)  // -> { discountCents, applied: [ruleId] }
// lines: [{ sku, qty, unitPriceCents }]
// rules: [{ id, type: "percentOff", pct }] | [{ id, type: "buyNGetOne", sku, n }]

// src/tax.mjs
export function taxFor(subtotalCents, jurisdiction)  // -> cents
// jurisdiction: { code, rate }

// src/receipt.mjs
export function buildReceipt({ cart, catalog, rules, jurisdiction })
// cart: [{ sku, qty }]
// -> { lines: [{ sku, name, qty, unitPriceCents, lineTotalCents }],
//      subtotalCents, discountCents, taxCents, totalCents, appliedRules }
```

Rounding rule, stated once so no node has to guess: **`multiplyRate` rounds half
away from zero.** `multiplyRate(1005, 0.5)` is `503`, not `502`. Every other layer
uses only integer addition and `multiplyRate`.

Stacking rule: discounts never reduce a line below zero, and total discount never
exceeds 50% of the pre-discount subtotal. When the cap binds, apply rules in array
order until it does.

## High-risk areas

- **`money`** — rounding is the classic case where a test passes and the code is
  still wrong. A half-away-from-zero implementation and a banker's-rounding
  implementation agree on most inputs.
- **`discounts`** — the stacking cap is real business logic with an ordering
  dependency. Passing the happy path proves very little.

## Definition of done

```
node --test tests/
```

exits 0, and a cart of three items with one percent-off rule and one
buy-two-get-one rule produces the arithmetically correct total by hand check.
