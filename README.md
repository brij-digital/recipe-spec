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
   §2, nothing else, inside a sandbox with an egress allowlist per domain.
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

A recipe is a process (today: `node recipe.mjs`) that reads its job from the
**environment**, does its work, prints **signals** on stdout, and **exits
with a code**. The toy recipe demonstrates all of it.

### 2.1 Task selection

| Env | Values | Meaning |
|---|---|---|
| `TASK` | `search` · `offer-details` · `book` (default `book`) | which job |
| `PURCHASE_MODE` | `dry` (default) · `approve` · `real` | `dry` walks to the checkout and **stops before Pay**; `approve` parks at the checkout and waits for a verdict; `real` pays |

### 2.2 Search criteria (all tasks)

| Env | Example | Notes |
|---|---|---|
| `DCITY` `ACITY` | `ibz` `mad` | IATA, case-insensitive |
| `DDATE` | `20261203` | `YYYYMMDD` |
| `RDATE` | `20261210` | present ⇒ round trip |
| `CLASS` | `y` `s` `c` `f` | economy · premium · business · first |
| `ADULT` `CHILD` `INFANT` | `1` `0` `0` | counts |
| `TOPK` | `5` | round trip: how many outbounds to expand into firm return combos |

### 2.3 Offer selection (`offer-details`, `book`)

| Env | Meaning |
|---|---|
| `FLIGHT` | the outbound offer **id from `search`** (times + airline; times are the identity) |
| `RETURN_FLIGHT` | the return offer id (round trip) |
| `FARE_PRICE` | the fare to book, **by price** (resolved against the live fare menu at purchase — never by index) |
| `FARE` | legacy index; tiebreak only |
| `PRICE_CAP` | safety ceiling — refuse if the checkout total exceeds it |

### 2.4 Passengers & contact (`book`)

| Env | Meaning |
|---|---|
| `PAX_LIST` | JSON array, **lead passenger at position 0** — `[{given, surname, dob, gender, nationality, idnum, idExp}]` |
| `PAX_GIVEN` `PAX_SURNAME` `PAX_DOB` `PAX_GENDER` `PAX_NATIONALITY` `PAX_IDNUM` `PAX_ID_EXP` | single-passenger fallback |
| `CONTACT_EMAIL` | **the oracle address**, injected by the runtime — give the supplier exactly this |
| `CONTACT_PHONE` | E.164 (`+34600000000`) — split dial code / national number yourself |

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

The SDK's `waitApproval` / `waitOTP` implement both — don't reimplement.

### 2.7 Runtime & browser

| Env | Meaning |
|---|---|
| `BB=1` | run on the marketplace's remote browser (headless, proxies, captcha solving) |
| `BB_CONNECT_URL` `BB_SESSION_ID` | **trusted-runner session**: the runtime creates the browser session and passes its connect URL — your process holds no browser-platform key for search/details |
| `BB_PROXY_COUNTRY` | proxy geo pin — **suppliers serve different inventory per geo**; one order's search, details and book must share it |
| `ANTHROPIC_API_KEY` | model access for the few steps that need model-driven actions (card iframes, Pay); provided on `book` only, scoped and budgeted |
| `FROM` `STOP` `KEEP` `FRESH` `ONLY` | developer controls — not used in production |

### 2.8 Signals — stdout, one line each, `__NAME__` + JSON

Use the SDK emitters; the shapes below are what the runtime parses.

| Signal | When | Payload |
|---|---|---|
| `__FULFILLER_RESULT__` | end of every task | `search`: `{route, ddate, tripType, count, offers:[{id, airline, price, currency, departISO, arriveISO, durationMin, stops, seats, from, to, segments:[…]}]}` — **firm offers only**. `offer-details`: `{flight, returnFlight, base, fares:[{price, currency, seats, cabin, brand, conditions:[{type,text}]}]}`. `book`: `{task, mode, payClicked, total, reason, reference, paymentStatus, flowError}` |
| `__FULFILLER_APPROVAL__` | `approve` mode, parked at the checkout | `{task, sessionId, total, currency, flight, returnFlight, fare, itinerary, lead, pax, cap, screenshots:[…]}` |
| `__FULFILLER_3DS__` | after Pay, a 3-D Secure challenge appeared | `{sessionId, need:"otp", total, screenshots}` |
| `__FULFILLER_SESSION__` | keep-alive runs | the browser session id, for reuse |

**`book` semantics the runtime relies on:**
- `payClicked=false` ⇒ nothing was paid; any failure is a clean failure (refund).
- `payClicked=true` without a `reference` ⇒ **uncertain** — money may have
  moved. The order freezes for a human; it is never retried automatically.
- `reference` = the supplier's order number — a join key for the
  confirmation email, **not** proof of payment (principle 1).
- `paymentStatus` = your honest read of the completion page: `paid` ·
  `failed` · `unverified`. Informational only.

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

Any nonzero exit **before Pay** is a clean failure. The runtime decides
refund vs uncertain from `payClicked`, never from the exit code alone.

### 2.10 Screenshots

Full-page PNGs at the milestones via the SDK's `snap` — paths carried in
the signals, read by the runtime. Evidence for humans and judges; **never
settlement** (principle 1).

### 2.11 What a recipe must never do

- persist, log or transmit a card number, CVV or passenger identity beyond
  the supplier's own forms;
- reach any host outside its manifest's egress allowlist;
- pay for anything the order did not ask for;
- retry a Pay click; hammer a form that rejected input;
- pretend: emit `payClicked=true` only if the Pay control was actually
  activated; obfuscated code (eval, encoded blobs) is rejected without review.

## 3. The manifest

One `manifest.yaml` per domain — see [`example.com/manifest.yaml`](example.com/manifest.yaml).

| Key | Meaning |
|---|---|
| `domain` | the supplier host |
| `recipe` | entry file |
| `flow` | `guest` · `ephemeral-account` · `account` (expensive, avoid) |
| `kind` | `browser` (this contract) · `api` (a connector — same signals, no browser) |
| `oracle` | `type: email` + `sender_domains` (DKIM) + `template` — how the marketplace recognizes "ticket issued" |
| `coverage` | regions / cabins actually handled — bounds the search fan-out |
| `proxy_country` | inventory-per-geo pin |
| `budgets` | `search_s`, `book_s`, browser minutes — enforced |
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
