# recipe-spec — write a fulfiller recipe for the BRIJ marketplace

A **recipe** is an executable that turns a booking job into a firm quote, a
fare menu, or a paid ticket on one supplier's website. Recipes are how the
[BRIJ travel marketplace](https://travel.brij.fi) covers suppliers that have
no API: agents and developers write them, the marketplace runs them, authors
earn a share of every sale their recipe fulfills.

This repo is the **public contract**: everything you need to write a recipe
for any domain, without seeing anyone else's. Your recipe — and your
domain knowledge — stay yours; submissions are private and your code is
never published.

- [`sdk/index.mjs`](sdk/index.mjs) — the contract as code: signal emitters,
  exit codes, evidence helpers, runtime gates. Import it; don't reimplement it.
- [`example.com/`](example.com/) — a toy recipe that speaks the whole
  contract **offline** (`node example.com/recipe.mjs` — no browser, no keys).
  Read it top to bottom: it is the tutorial.
- This README is the normative text.

---

## 0. Principles

1. **No recipe output is ever proof of settlement.** The marketplace
   captures a customer's escrow only on the supplier's own confirmation
   email (DKIM-verified) delivered to an address the marketplace controls,
   injected into your run as `CONTACT_EMAIL`. Not on `payClicked`, not on an
   order id, not on a screenshot — some suppliers show "Payment successful"
   *even when the payment failed*. Consequence: the oracle does not trust
   your recipe, so trust is never the bottleneck of joining.
2. **An approved recipe is immutable** — identified by the hash the
   marketplace registered. Fixing it means a new version, a new review.
3. **The runtime gives a recipe only what it is owed** — the environment in
   §2, nothing else. Enforced today: a whitelisted environment, a per-run
   working directory, OS confinement (dedicated uid, read-only filesystem
   outside the run dir). **Target, in progress** (lands before the first
   external author runs): an enforced egress allowlist per domain, and the
   card/PII moved behind runner-held capabilities — until then external
   recipes run in dry mode only, never with card data.
4. **A slow or wasteful recipe costs its author, not the marketplace.** Run
   cost (browser minutes, model tokens) is deducted from your payout.
5. **Never buy what wasn't asked.** Refuse the checkout if it carries any
   add-on the order didn't request (paid seat, insurance, bundle).
6. **Target family: `guest + browser + email`** — guest checkout, browser
   automation, confirmation by email. The dominant flow of the web.

## 1. Lifecycle

```
write your recipe against this spec (the toy shows every signal)
   → submit it (see §5) — a paid x402 API; the paying wallet IS your identity
   → automatic conformance: your recipe runs search / offer-details / book
     in DRY mode against the live supplier, in the marketplace sandbox
   → an AI judge checks the run's evidence against your manifest
   → you stake the order cost (double escrow) → probation (capped amounts)
   → clean bookings → active. Health is measured by the settlement oracle;
     a recipe that stops working loses its domain to a challenger — and a
     displaced author keeps a residual finder's fee (§4).
```

No git, no fork, no PR: the submission API is the front door.

## 2. The contract — what every recipe speaks

A recipe is a process (today: `node recipe.mjs`) that reads its job from **one
JSON document**, does its work, prints **signals** on stdout, and **exits with
a code**. The toy recipe demonstrates all of it.

### 2.1 The job: `RECIPE_INPUT`

Everything about WHAT to do arrives in a single environment variable,
`RECIPE_INPUT`, holding `{schema, task, data}`:

```json
{"schema":"air-book.v1","task":"book","data":{
  "origin_iata":"MAD","destination_iata":"IBZ","depart_date":"2026-11-07",
  "flight":"2026-11-07T20:35|2026-11-07T21:55|FR",
  "passengers":[{"given":"Jean","surname":"Martin","dob":"1979-10-25"}],
  "contact_email":"o-abc123@bookings.brij.fi"}}
```

**There is no per-field fallback.** No `DCITY`, no `DDATE`, no `PAX_LIST`, no
`PRICE_CAP`. A missing document, or one declaring a schema your recipe does
not speak, is a refusal — exit `EXIT.badInput`, never a default. Defaults are
how a recipe books a passenger nobody named, on a date nobody chose.

The marketplace validates the document before your process starts, so a field
it owes you is its bug, not yours. What arrives is complete or nothing does.

Field by field: [`schemas/input/`](schemas/input/) — `air-search.v1`,
`air-offer-details.v1`, `air-book.v1`. A manifest names the one each task
speaks (`capabilities.<task>.input_schema`).

**Values are canonical.** Dates are ISO `YYYY-MM-DD` — including passenger
`dob` and `idexp`. IATA codes are upper-case. Gender is the raw API code
(`m`/`f`), not a supplier's form label. If your supplier's URLs or forms want
something else, convert at your own door: that dialect is yours, not the
contract's.

### 2.2 Task selection

| Env | Values | Meaning |
|---|---|---|
| `TASK` | `search` · `offer-details` · `book` (default `book`) | which job — must match the document's `task` |

**There is no purchase mode.** You are not told whether this run may spend
money; you are given what spending requires, or you are not:

| You received | What it means |
|---|---|
| `CARD_*` **and** `APPROVE_SIGNAL_FILE` | Pay is reachable. Walk to the cashier, emit `__FULFILLER_APPROVAL__`, **wait for the verdict**, and only then enter the card. |
| anything less | Pay is not reachable. Run the same walk with a synthetic card and stop before Pay. This is the conformance run every submission gets. |

Derive it once and branch on it — `const CAN_PAY = HAS_CARD && !!APPROVE_SIGNAL_FILE` — and never
ask "what mode am I in". A mode was a string you were asked to honour; a
missing card is not something you can misread, ignore, or work around. Your
code is identical either way except for the last click.

### 2.3 Prices: USD, and say so

The marketplace settles in USD and **converts nothing**. Every price you
report — search offers, fare menus, the cashier total — must carry
`currency: "USD"`, and a missing currency is refused as loudly as a wrong one:
a price without one is not "probably dollars", it is a price nobody checked.

If your supplier prices in another currency, that is a property of the URL you
chose, not a fact of life — Ryanair prices EUR on `/gb/en/` and USD on
`/us/en/`. Read the currency back from the supplier rather than asserting it
in your code: a constant in your recipe is exactly how a EUR menu gets sold as
dollars for a day.

### 2.4 The cashier total (`book`)

No price ceiling is passed to you. Report the checkout total honestly and the
marketplace compares it against what the customer engaged, at the approval
gate, before the card is touched. A total you cannot read is a refusal — the
gate cannot judge a number it never received, and paying blind is worse than
paying too much.

### 2.5 Payment (`book` only, provided for the duration of the run — never stored)

| Env | Notes |
|---|---|
| `CARD_NUMBER` `CARD_EXPIRATION` (`MM/YY`) `CARD_CVV` `CARD_HOLDER` | the instrument |
| `CARD_BILLING_ADDRESS` `CARD_CITY` `CARD_STATE` `CARD_ZIP` `CARD_COUNTRY` | billing, split in five (suppliers require it) — `BILL_*` accepted aliases |

Dry runs receive **no card at all** — the runtime withholds it by mode.

### 2.6 Human-in-the-loop signals (`book`)

| Env | Meaning |
|---|---|
| `APPROVE_SIGNAL_FILE` | `approve` mode: poll this path for `APPROVE` / `REJECT` written by the runtime |
| `APPROVE_TIMEOUT_S` | how long to wait (default 480) |
| `OTP_SIGNAL_FILE` | on a 3-D Secure challenge: poll this path for the one-time code (the code travels **only** through this file — never argv, never logs) |
| `OTP_TIMEOUT_S` | how long to wait (default 300) |

| `VERIFY_SIGNAL_FILE` | `flow: ephemeral-account` only: after signing up, poll this path for the email verification the runtime relayed — `CODE 123456` or `URL https://…` (or `REJECT`) |
| `VERIFY_TIMEOUT_S` | how long to wait (default 300) |

The SDK's `waitApproval` / `waitOTP` / `waitVerification` implement all three — don't reimplement.

### 2.6-bis Ephemeral accounts (`flow: ephemeral-account`)

Some suppliers refuse to sell to a guest: the checkout ends in a login wall
with no way around it. The answer is **one account per order**, never a
shared one — shared means every customer's bookings in one place, and one
ban takes the whole supplier down.

What you receive, and only in a paying run (`real_trusted`):

| Env | Meaning |
|---|---|
| `ACCOUNT_PASSWORD` | the ORDER's password, derived by the runtime from an operator key and the order id — the same on a retry, so a second run logs into the account the first one created instead of creating another; never stored, never logged. The account's email is `contact_email` from the document — the order's own address, whose inbox the runtime owns |
| `VERIFY_SIGNAL_FILE` / `VERIFY_TIMEOUT_S` | the email verification relay, above |

The walk: reach the wall → sign up with `contact_email` + `ACCOUNT_PASSWORD` →
`emitVerification({ sessionId, email, need: "code" | "link", screenshots })` →
`waitVerification(...)` → type the code or navigate to the link → continue
to the cashier exactly as a guest recipe would.

Without `ACCOUNT_PASSWORD` — every conformance run — you reach the wall,
photograph it, emit `emitPhase("signup-wall")`, report
`payReachable: false, blocker: "account-required"` and exit
`EXIT.accountRequired`. **Never submit a signup in a run that holds no
password**: a dry run creates no account anywhere.

What this is not: a security boundary. The password is typed by your code,
so it is in your process, exactly like the card — which is why it exists
only under the reviewed, pinned commit.

The account is the customer's booking, and their way into it is a password
reset on the order's address: the runtime owns that inbox and can relay the
reset to them. Nothing else is promised — in particular the runtime does
NOT hand out the password it derived.

A conformance run must leave evidence the gate can check, not a claim it
must believe: `emitPhase("signup-wall")` AND a screenshot of the wall,
besides the `payReachable:false` result. Without both, exit 8 is a failure.

### 2.7 Runtime & browser

**Node ≥ 22** (`package.json` `engines`): Stagehand v4 relies on the global
`WebSocket` that Node exposes natively only from 22 — on Node 20 a recipe dies
at import with `WebSocket is not defined`. The marketplace runs 22; pin the
same locally.

| Env | Meaning |
|---|---|
| `BB=1` | run on the marketplace's remote browser (headless, proxies, captcha solving) |
| `BB_CONNECT_URL` `BB_SESSION_ID` | **trusted-runner session**: the runtime creates the browser session and passes its connect URL — your process holds no browser-platform key for search/details |
| `BB_PROXY_COUNTRY` | proxy geo pin — **suppliers serve different inventory per geo**; one order's search, details and book must share it |
| `LLM_PROXY_URL` + `LLM_RUN_TOKEN` | model access for the few steps that need model-driven actions (card iframes, Pay) — a per-run, budget-capped token against the runtime's own proxy, provided on `book` only. No raw provider key ever reaches a recipe; the SDK's `runtimeModel()` wires it into Stagehand |
| `FROM` `STOP` `KEEP` `FRESH` `ONLY` | developer controls — not used in production |

### 2.7-bis Reading the supplier's JSON (`captureJSON`)

Prices, times and fare menus arrive as JSON the supplier's front-end fetches —
complete and typed. **Read them off the wire, do not scrape the DOM** (the DOM
is a lossy, shifting rendering of that JSON; a fare table read from HTML breaks
on the next A/B redesign, the payload does not). Stagehand exposes no network
events, so the SDK's `captureJSON(cdpUrl, routes)` opens a parallel Playwright
CDP client on the same browser and buckets the responses you name:

```js
const net = await captureJSON(process.env.BB_CONNECT_URL, {
  fares: { match: /FareOptions/, key: j => j.flightNo, parse: j => j.fares,
           keep: (old, fresh) => fresh.length >= old.length }, // refuse a partial re-emit
});
// …drive the page (Stagehand / the page adapter)…
const menu = await net.until("fares", flightNo, 15000);  // null on timeout
await net.close();
```

The click only *triggers* the request; `captureJSON` gives you the payload it
produced. `keep` guards the case where a supplier re-emits a smaller payload
after the full one. See the reference recipe for a worked example.

### 2.8 Signals — stdout, one line each, `__NAME__` + JSON

Use the SDK emitters; the shapes below are what the runtime parses.

| Signal | When | Payload |
|---|---|---|
| `__FULFILLER_RESULT__` | end of every task | `search`: `{route, ddate, tripType, count, offers:[{id, airline, price, currency, departISO, arriveISO, durationMin, stops, seats, from, to, segments:[…]}]}` — **firm offers only**. `offer-details`: `{flight, returnFlight, base, fares:[{price, currency, seats, cabin, brand, conditions:[{type,text}]}]}`. `book`: `{task, mode, payClicked, total, reason, reference, paymentStatus, flowError}` |
| `__FULFILLER_APPROVAL__` | `approve` mode, parked at the checkout | `{task, sessionId, total, currency, flight, returnFlight, fare, itinerary, lead, pax, cap, screenshots:[…]}` |
| `__FULFILLER_3DS__` | after Pay, a 3-D Secure challenge appeared | `{sessionId, need:"otp", total, screenshots}` |
| `__FULFILLER_VERIFICATION__` | `ephemeral-account`: the signup was submitted and the supplier mailed the order's address | `{sessionId, email, need:"code"|"link", screenshots}` — then `waitVerification` |
| `__FULFILLER_SESSION__` | keep-alive runs | the browser session id, for reuse |

**`book` semantics the runtime relies on:**
- `payClicked=false` ⇒ nothing was paid; any failure is a clean failure (refund).
- `payClicked=true` without a `reference` ⇒ **uncertain** — money may have
  moved. The order freezes for a human; it is never retried automatically.
- `reference` = the supplier's order number — a join key for the
  confirmation email, **not** proof of payment (principle 1).
- `paymentStatus` = your honest read of the completion page: `paid` ·
  `failed` · `unverified`. Informational only.
- `payReachable` (walk-only runs) = you located Pay and found it present,
  enabled and **uncovered** — or you did not, and `blocker` says what stood
  in the way (`account-required`, `cookie-wall`, …). A dry run that stops
  "just before Pay" without reporting this proved nothing about Pay: a
  recipe was once activated that passed every check and could never pay,
  because the login wall sits on the last screen.

`__FULFILLER_PHASE__` (SDK `emitPhase("select")`) marks timeline steps —
the runtime parses them into the run's evidence (`phases[]`, and
`failure_phase` = the last phase entered before a failing exit). Optional
but cheap; the structured failure reason authors iterate fastest on.

### 2.9 Exit codes (`EXIT` in the SDK)

| Code | Meaning |
|---|---|
| `0` | task completed (result signal emitted) |
| `1` | bad input |
| `2` | blocked by a captcha the runtime could not solve |
| `3` | offer or fare no longer available / live price not verified (**never book an unverified price**) |
| `4` | could not reach the checkout |
| `5` | round-trip return selection failed |
| `6` | passenger form rejected — stop, never hammer |
| `7` | `EXIT.uncertain` (alias `EXIT.malformed`) — the run's claims cannot be trusted: a result that violates the schema, or **any unconfirmed outcome after the Pay click** (exception, 3-D Secure timeout, no readable confirmation/reference) |

Any nonzero exit **before Pay** is a clean failure. The runtime decides
refund vs uncertain from `payClicked`, never from the exit code alone —
but after Pay, exiting `EXIT.uncertain` is what states plainly that a
human must resolve the order: never exit a clean-failure code (or `ok`
without a supplier reference) once Pay was clicked.

`8` = `EXIT.accountRequired`: the supplier will not sell to a guest and this
run holds no `ACCOUNT_PASSWORD`. Clean — nothing was submitted, nothing was
paid. For a `flow: ephemeral-account` manifest this is the EXPECTED end of a
conformance run (with `payReachable:false`, `blocker:"account-required"`).

### 2.10 Screenshots

Full-page PNGs at the milestones via the SDK's `snap` — paths carried in
the signals, read by the runtime. Evidence for humans and judges; **never
settlement** (principle 1).

### 2.11 What a recipe must never do

- persist, log or transmit a card number, CVV or passenger identity beyond
  the supplier's own forms;
- reach any host outside its manifest's egress allowlist (contractual
  today, OS-enforced before the first external author runs);
- pay for anything the order did not ask for;
- retry a Pay click; hammer a form that rejected input;
- pretend: emit `payClicked=true` only if the Pay control was actually
  activated; obfuscated code (eval, encoded blobs) is rejected without review.

## 2-bis. Protocol version and validation

Every signal the SDK emits is stamped `{ v: 1, task: "…" }` — the SDK
imposes both, payload values are ignored. `emitResult(task, payload)`
validates the payload against the task's shape (executable validators in
`sdk/index.mjs`, documentary JSON Schemas in `schemas/`, shared corpus in
`fixtures/corpus.json` — CI verifies all implementations agree on that
corpus) and refuses a malformed result with exit 7. Financial rule: a
malformed BOOK result still emits a minimal well-formed line carrying
`payClicked` first, and the runtime classifies any malformed/unreadable
post-Pay outcome as UNCERTAIN — never an automatic refund. Run the corpus
offline: `node test-sdk.mjs`.

## 3. The manifest

One `manifest.yaml` per domain — see [`example.com/manifest.yaml`](example.com/manifest.yaml).

| Key | Meaning |
|---|---|
| `domain` | the supplier host — and the identity everything else derives from. The marketplace TIER this recipe quotes and settles under is the domain itself: do NOT declare `tier`, it is refused at load. A declared one can only restate `domain` or be wrong, and when it is wrong it is wrong in three places at once (the daily canary asks whether that tier sells, the settlement engine keys its email template by it, the fulfiller quotes under it) |
| `protocol_version` | the SDK/signal protocol the recipe speaks (current: `1`); the runtime refuses versions it does not support and treats a signal `v` that contradicts the manifest as malformed |
| `recipe` | entry file |
| `capabilities` | which tasks the recipe implements, each referencing a versioned input contract from [`schemas/input/`](schemas/input/) (`input_schema: air-book.v1`, plus `accepts` for book targets) — public field names, never transport env ([ADR 0001](adr/0001-discover-and-fulfill.md)); absent = all three air.v1 schemas with `accepts: [offer_ref]` (the current behavior). Descriptive in protocol 1 |
| `author` | `wallet` is your identity and is REQUIRED: it must equal the wallet paying for the submission, and it is what lets you read the recipe back (`GET /recipes/source/<domain>`). `partner` beside it is a label. A domain's manifest must live in the folder named after it — the folder IS the identity |
| `flow` | `guest` (no account) · `ephemeral-account` (the supplier will not sell to a guest — one account per ORDER, see §2.6-bis). There is no `account` flow: a persistent, shared account is not a recipe, it is a first-party API fulfiller |
| `kind` | `browser` (this contract) · `api` (a connector — same signals, no browser) |
| `oracle` | `type: email` + `template` (version label), and OPTIONALLY `issued_pattern` / `pnr_pattern` (group 1 = PNR) / `cancelled_subject_pattern` — all three or none (a partial set is a typo that would silently never settle, and is a hard error). None = **bootstrap**: the first real confirmation email is stored and pages the operator, the patterns are written against it, and the booking settles retroactively inside its hold. Do NOT declare `sender_domains`: the settlement authority is derived from `domain` and always is the supplier itself; a declared foreign entry is refused at load. The author supplies patterns; DKIM verification and the capture decision are never the recipe's |
| `coverage` | regions / cabins actually handled — bounds the search fan-out |
| `payment.max_amount` | above this, orders are not routed to the recipe |
| `known_traps` | what you learned the hard way — reviewers and your future self thank you |

## 4. Economics

- **You earn a share of every sale your recipe fulfills.** Run costs
  (browser minutes, tokens) are deducted from your payout — speed is money,
  yours.
- **Finder's fee.** If the supplier later connects officially and displaces
  your recipe, you keep a residual, decreasing, time-bounded (~12 months)
  commission on the domain's sales. Pioneering is paid, not punished. The
  same applies if a better recipe takes your domain: measured health decides,
  and the displaced author keeps the residual.
- **Skin in the game.** Authors stake the order cost (double escrow,
  on-chain) while their recipe executes; a recipe that makes the marketplace
  pay a supplier for nothing forfeits the stake. The submission fee is
  credited back against your first earnings.

## 5. Submitting

The submission API (x402-paid, the paying wallet is your identity and your
payout address) is being finalized. Until it opens: **open an issue on this
repo** with the domain you want to cover — we onboard early authors by hand,
and early authors get the primary seat on their domain.

Questions, domains you'd like to see, or a supplier you *are* and want to
connect directly: open an issue.
