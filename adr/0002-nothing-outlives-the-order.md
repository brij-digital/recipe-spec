# ADR 0002 — Nothing outlives the order: ephemeral accounts

Status: proposed · 2026-08-22

## Context

Some suppliers refuse guest checkout. Ryanair (2026-08-22, measured): the
guest walk reaches `/payment`, then a `/kyc` iframe in a fixed `<ry-portal>`
with no close control demands a myRyanair login; "Log in later" on the
passenger step only defers it. A recipe activated on a dry-run — which
stops at the cashier — never met the wall. `ryanair.com` is activated and
cannot book.

Three ways to hold an account were weighed:

1. **A global account per domain**, held by BRIJ, persisted as a browser
   context. Rejected. A recipe executes *inside* the authenticated session:
   it can read every past booking (PII, PNRs — enough to cancel other
   customers' tickets) or lift the cookies. Review and pinning lower that
   risk; they do not bound it. Every other asset in this system is bounded
   to one order (escrow PDA, contact email, sandbox, browser session,
   signal files, and — once issued per order — the card). One unbounded
   asset in a system of bounded ones is the asset that gets taken.
2. **Credentials injected like the card** (`ACCOUNT_*`). Rejected: same
   blast radius as 1, plus a secret in transit, plus 2FA relayed by us,
   plus no social login.
3. **Third-party fulfillers with their own accounts.** Out of scope: BRIJ
   executes everything today and no PII leaves it. A partner with its own
   accounts is a contract (KYB, DPA), not a feature.

## Decision

**An account is born with the order and dies with it.** `flow:
ephemeral-account` becomes operative. The recipe signs up on the supplier
with the order's own identity — the contact address the marketplace already
routes (`o-<id>@bookings.brij.fi`), a phone number behind the marketplace's
SMS relay, a generated password it never sees again — books, and abandons
the account. Nothing is persisted: no context, no cookie, no credential.

Consequences, in order of importance:

- **Bounded blast radius.** A malicious or compromised recipe, a stolen
  session, a leaked sandbox exposes exactly one order. This is what makes
  running third-party recipes acceptable at all.
- **Suppliers that require a non-disposable account (identity-verified,
  KYC) are not served directly.** Ryanair stays behind Trip.com. This is a
  limit we choose, not one we work around: an account that cannot be
  thrown away accumulates history, and history is the thing we refuse to
  hold. `flow: account` stays in the manifest as a name for that category
  and is **refused by the gate**.
- **Signup is part of the recipe and is proven like the rest.** No human
  step, no live view: the gate dry-runs it.
- **The operational cost is visible and per-domain**: a supplier's
  anti-fraud may refuse N fresh accounts a month. That shows up as a
  success rate on that domain, never as exposed data. We accept losing
  hostile suppliers; we do not accept an unbounded asset.

## The contract

### Manifest

```yaml
flow: ephemeral-account
account:
  signup_url: https://example.com/register
  signup_requires: [email, phone_sms]        # subset of: email, phone_sms
  verification: email                        # none | email | sms — what the site checks before booking
  notes: "…known traps…"
```
The gate refuses `flow: ephemeral-account` without a complete `account:`,
and refuses `signup_requires` outside the set the runtime can supply.
`flow: account` is refused outright (see Decision).

### What the runtime supplies (book only, `real_trusted`)

| Env | Meaning |
|---|---|
| `ACCOUNT_EMAIL` | the order's contact address — the same one the oracle reads |
| `ACCOUNT_PHONE` | a number behind the marketplace's SMS relay (E.164) |
| `ACCOUNT_PASSWORD` | generated per run by the runtime, never stored, never logged |
| `VERIFY_SIGNAL_FILE` | where the runtime drops the supplier's verification code or link (from the inbound email or the SMS relay) |

The dry-run (`try_untrusted`) supplies the same shape with synthetic
values and a dead inbox: the signup walk is proven, the verification step
times out cleanly.

### SDK

- `waitVerification({ file, timeoutS })` — poll the signal file; returns
  the code or URL the runtime extracted. Sibling of `waitOTP`, same file
  mechanics, same rule: the secret travels only through the runtime-owned
  file.
- `EXIT.signupRefused = 8` — the supplier refused the account (anti-fraud,
  duplicate phone, blocked domain). Clean failure before Pay; the
  marketplace counts it per domain.
- No new marker. `TASK=book` performs the signup inline when the wall
  appears: the account has no existence outside this booking, so it has no
  task of its own.

### Runtime (x402-travel)

- **Verification relay.** The inbound-email route already stores the raw
  body per order; the runtime extracts the first verification URL or 4–8
  digit code whose recipient is the order's address and writes it to
  `VERIFY_SIGNAL_FILE`. SMS codes arrive on the existing `/internal/sms-otp`
  inbox — books are sequential, so the inbox is unambiguous. Both are
  consume-once, drained at book start.
- **Password.** Generated per run (`crypto/rand`, 24 chars), passed in env,
  never written anywhere. After the run it cannot be recovered — by design.
- **Card per order.** Prerequisite, tracked separately: a virtual card
  issued per order with the order's amount as its limit, destroyed after
  capture or refund. Until then `CARD_*` stays the static card and the
  account model is NOT enabled in production.
- **Phone.** One relay number today; a small pool when a supplier rejects
  reuse. Per-domain success rate decides.

### Gate & activation

- Dry-run proves the signup walk and the clean `signupRefused`/verification
  timeout. No human, no live view.
- Activation of an ephemeral-account recipe still requires one supervised
  book that **reached Pay** — the Ryanair lesson applies to every flow.

## Out of scope (deliberately)

Persistent contexts, live-view login gates (customer or operator),
credential injection for persistent accounts, third-party fulfillers,
account rotation schemes. Each was a way to keep an unbounded asset while
looking careful.

## Order of work

0. This ADR, `account:` manifest schema, `waitVerification`, `EXIT.signupRefused`,
   toy recipe with a signup step (offline, CI).
1. Runtime: verification relay (email + SMS → signal file), per-run
   password, `ACCOUNT_*` injection under `real_trusted`, gate refusal of
   `flow: account`, per-domain signup stats.
2. Virtual card per order (separate ADR: issuer, limits, lifecycle).
3. First recipe on a supplier whose signup is email-only; then one with
   SMS. Ryanair is not a candidate.
