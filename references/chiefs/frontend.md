# Frontend lens

Loaded for `kind: frontend` nodes. Pairs with whatever you put in
`references/skills/frontend-design/`.

## Hard rules

- Every interactive element is reachable and operable by keyboard.
- Every input has a label. Placeholder text is not a label.
- Colour is never the only carrier of meaning.
- Loading, empty, and error states exist for anything that can be slow, absent, or
  fail. All three, not just the happy render.
- Design values come from tokens. A hex code in a component is a defect.

## Traps specific to generated code

- **The happy state only.** A component that renders a list beautifully and shows
  nothing at all when the list is empty.
- **Layout that works at exactly one width.** Nothing tested the narrow case.
- **Focus lost after an async update**, which is invisible with a mouse and fatal
  with a keyboard.
- **Inline styles reintroducing values the token system already defines**, which is
  how a design system erodes one component at a time.

## Design slop

Slop is not ugliness. It is the absence of decisions: default fonts, inconsistent
spacing, six accent colours because six components each chose one, a card
component that exists three times in slightly different forms.

The mitigation is structural. Tokens are frozen before any UI node is planned, and
components read from them. Anything else is taste, and taste does not survive
delegation to a cheap model.
