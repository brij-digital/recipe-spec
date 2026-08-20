# ADR 0001 — Two capabilities, one contract: discover and fulfill

Status: accepted · 2026-08-20

## Context

The platform has two distinct uses built on one engine:

- **Discovery / aggregation** — "find me the best offers for this
  intention." Several recipes quote different suppliers; results are
  normalized so they compare (price, availability, conditions, segments).
- **Direct fulfillment** — "buy this exact product on this domain." No
  aggregation: the caller already holds a target. The recipe is a
  transactional adapter — select, fill, pay, handle 3-DS, return proof.

The contract already separates them mechanically (`TASK=search`,
`offer-details`, `book`), but nothing lets a recipe say which halves it
implements, and nothing writes down the rules that keep the fulfill side
safe as it generalizes beyond travel.

## Decision

Two primitives, **one infrastructure**. Same sandbox, same signals, same
approval and payment machinery, same registry. The platform is not split.

1. **`DISCOVER(intent) → normalized offers[]`** — `TASK=search` (and
   `offer-details` to enrich). Output must be normalized and comparable;
   an offer a recipe quotes is an offer it can book.
2. **`FULFILL(target, constraints) → order | approval | failure`** —
   `TASK=book`. Today the target is an `offer_ref` produced by discovery.
   A later protocol version may admit a direct target (a URL, a supplier
   reference) for fulfill-only recipes.

A recipe declares what it implements in the manifest:

```yaml
capabilities:
  discover: true          # search + offer-details produce normalized offers
  fulfill:
    inputs: [offer_ref]   # what a book target may be; later: url
```

**Absence of the field means the current behavior** —
`discover: true`, `fulfill.inputs: [offer_ref]` — so every existing
manifest stays valid. The field is descriptive in protocol 1: the runtime
does not yet route on it. Declaring it now is what lets routing use it
later without a migration.

## Rules

1. `discover` produces **normalized, comparable offers** — never raw
   supplier payloads.
2. `fulfill(offer_ref)` buys an offer that came out of this recipe's own
   discovery, at the quoted terms. Quote what you can book; book what you
   quoted.
3. `fulfill(url)` — when a protocol version admits it — buys a target the
   caller already chose. A URL may only point at the recipe's declared
   `domain` (or a subdomain of it). A recipe never navigates a payment to
   a host outside its declaration; the runtime will enforce this the day
   the input exists.
4. **No fulfill without a settlement oracle.** Escrow capture requires a
   supplier-side proof the marketplace can verify on its own — today a
   DKIM-verified confirmation email from `oracle.sender_domains` to an
   address the marketplace controls. A domain with no verifiable
   confirmation signal cannot carry an auto-settling fulfill recipe: it is
   human-approval only, or it waits for another oracle type. The recipe's
   own declaration of success is never the settlement (README §0.1).

## Consequences

- Fulfill-only recipes (adapter for a known target) become describable
  without pretending to aggregate; discover-only recipes (quote engines)
  likewise.
- The submission pipeline keeps accepting manifests without the field.
- Commercially the two halves can be told apart — search the market vs.
  act on any covered site — while running on one codebase, one review
  pipeline, one economics model.
