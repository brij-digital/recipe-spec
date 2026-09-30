// @brij/recipe-sdk v1 — the recipe CONTRACT as code.
// Speaks protocol 1 (air: search / offer-details / book) and protocol 2
// (shop.v1: quote / buy — README §"Protocol v2"; rail adds discover). One SDK for both: the
// signals, gates and evidence are the same machinery, only the tasks differ.
//
// Everything a recipe says to the runtime goes through here: the machine
// signals (__FULFILLER_*), the exit codes, the screenshot evidence, and the
// two runtime gates (human approval, 3DS code). A recipe that uses this
// module refuses to emit a malformed signal (EXIT.malformed); the runtime
// revalidates server-side and treats any non-conforming line as recipe
// failure, never as data — the SDK is DX, the runner is the trust boundary.
//
// v1 is a LIBRARY: it runs inside the recipe's process, so it adds zero
// security (same trust domain). Its value is DX + contract fidelity + a
// structured trace. The signatures are the durable part: a later version
// moves the sensitive primitives behind an RPC boundary to the trusted
// runner WITHOUT changing recipe code (the API is stable, the trust
// boundary migrates).
//
// Every implementation below is extracted VERBATIM from the Trip.com
// reference recipe (the production one) — behavior-identical, only the
// wiring (dependency injection for page/cleanup) is new.
import fs from "fs";
import zlib from "node:zlib";

// ── the machine markers: one line on stdout, prefix + JSON, parsed by the runner ──
export const MARKERS = {
  result: "__FULFILLER_RESULT__",     // task outcome (search offers, fare menu, bookResult)
  approval: "__FULFILLER_APPROVAL__", // parked at the checkout, waiting for a verdict
  threeDS: "__FULFILLER_3DS__",       // waiting for an SCA code
  verification: "__FULFILLER_VERIFICATION__", // an ephemeral account awaits its email code/link
  session: "__FULFILLER_SESSION__",   // reusable Browserbase session id
  phase: "__FULFILLER_PHASE__",       // timeline step (emitPhase) — powers the evidence timeline
};

// ── exit codes (README §2.9). Any nonzero exit BEFORE Pay is a clean failure;
//    the runtime decides refund vs uncertain from payClicked, never from the code alone. ──
export const EXIT = {
  ok: 0,           // task completed (result signal emitted)
  badInput: 1,     // missing FLIGHT, invalid FARE_PRICE, …
  captcha: 2,      // blocked by a captcha the runtime could not solve
  offerGone: 3,    // offer/fare no longer available, live menu not captured — never book an unverified price
  checkoutFail: 4, // could not reach the checkout
  returnFail: 5,   // round-trip return selection failed
  paxRejected: 6,  // passenger form rejected — stop, never hammer
  // Protocol 2 NAMES for the same two numbers. Aliases, not new codes: the
  // runtime's refund-vs-uncertain logic keys on the number, and a second
  // number meaning "gone" would be one more the runner had to learn — and
  // could forget. A shop recipe says what it means; the runner reads 3 and 6.
  itemUnavailable: 3,    // = offerGone: the product/variant is no longer buyable as quoted
  fulfilmentRejected: 6, // = paxRejected: the shipping/recipient form was refused — stop, never hammer
  accountRequired: 8, // the supplier will not sell to a guest, and this run holds no account
                   // (no ACCOUNT_PASSWORD): the wall was reached and photographed, nothing
                   // was submitted. Clean — nothing was paid.
  malformed: 7,    // the recipe built a result that violates the schema — the SDK refused to emit it
  uncertain: 7,    // alias of 7 — money may have moved and nothing confirms it: use for EVERY
                   // unconfirmed outcome after the Pay click (exception, 3DS timeout, unreadable
                   // confirmation). The runtime freezes 7-after-payClicked for a human; it never
                   // auto-refunds it. Same number as malformed on purpose: both mean "do not
                   // trust this run's claims".
};

// ── protocol version ──
// Stamped by the SDK into EVERY signal ({v, task, ...}); declared by the
// manifest as protocol_version. The runtime refuses a version it does not
// support and treats a v/manifest mismatch as a malformed signal.
export const PROTOCOL_VERSION = 1;
// Protocol 2 is a set of TASKS, not a new wire: quote and buy are stamped
// v:2, the air tasks keep v:1 whatever else the SDK learns. Keyed by task
// rather than read from the manifest because the SDK never sees the
// manifest — and because a v1 recipe must keep emitting exactly what it
// emitted yesterday, byte for byte, without re-declaring anything.
export const PROTOCOL_VERSION_V2 = 2;
// `discover` is protocol 2's discovery task, per vertical (rail first): it is
// never called `search`, because `search` is the air task and stays v:1.
export const TASK_PROTOCOL = Object.freeze({ search: 1, "offer-details": 1, book: 1, discover: 2, quote: 2, buy: 2 });

// ── narration + timing ──
export const L = s => console.log(s);
// stdout to a PIPE is asynchronous: process.exit() DROPS whatever is not
// flushed. A large __FULFILLER_RESULT__ line came out TRUNCATED on the
// fulfiller side (measured in prod). drain() guarantees the flush before any exit.
export const drain = () => new Promise(r => process.stdout.write("", r));
export const sleep = ms => new Promise(r => setTimeout(r, ms));   // page-independent timer (survives a closed page)
// bounded EVENT-DRIVEN wait (no blind sleep): re-tests a condition until true or timeout
export const until = async (cond, ms = 8000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await cond()) return true; } catch {} await sleep(step); }
  return false;
};

// ── result validation — hand-rolled, zero dependencies (this file is
// vendored; a schema library would contaminate every recipe). The JSON
// Schemas under schemas/ are the documentary twin; CI verifies both agree
// on the fixture corpus. The runtime revalidates server-side: this SDK is
// DX, the runner is the trust boundary.
const isNum = x => typeof x === "number" && Number.isFinite(x);
const isStr = x => typeof x === "string" && x.length > 0;
// The marketplace settles in USD and converts nothing, so a price without a
// currency is not "probably dollars" — it is a price nobody checked. Say it
// once, here, and every result carries a currency that was verified.
const SELLABLE_CURRENCY = "USD";
const currencyError = (what, currency) =>
  !isStr(currency) ? `${what}: currency is required (the marketplace sells ${SELLABLE_CURRENCY} and converts nothing)`
  : currency.toUpperCase() !== SELLABLE_CURRENCY ? `${what}: currency ${currency} is not sellable — this marketplace settles in ${SELLABLE_CURRENCY}`
  : "";

// ── protocol 2 (shop.v1) vocabulary ──
// The requirement slots a quote may say the buy will need. A closed list:
// the marketplace asks the BUYER for exactly these before it funds anything,
// so a slot it does not know is a question nobody can be asked — and a buy
// that then stalls on a form with the customer's money in escrow.
export const REQUIREMENT_SLOTS = Object.freeze(["person", "document", "recipient", "address.shipping", "contact.phone", "loyalty"]);
const UNAVAILABLE_REASONS = ["out_of_stock", "not_shippable", "quantity_limit", "not_found"];
const QUOTE_STATUSES = ["priced", "options_required", "unavailable"];
// Money is compared to the cent. The float slack is not a second tolerance:
// 59.97 + 6.99 + 5.00 is not exactly 71.96 in binary, and a rule that
// refused honest arithmetic would teach authors to round until it passed.
const CENT = 0.01, FLOAT_SLACK = 1e-9;
const withinCent = (a, b) => Math.abs(a - b) <= CENT + FLOAT_SLACK;
const isObj = x => !!x && typeof x === "object" && !Array.isArray(x);
// A calendar date, not a date-shaped string: 2026-02-30 is refused (Go's
// time.Parse("2006-01-02") refuses it too, which keeps the corpus honest).
const isISODate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;

// The cashier a buy walk reports when it reached Pay. It is what the PAYER
// compares against the order before the human is paged (currency, total ≤
// engaged, the lines, and for a parcel the ZIP), so every field is one of
// those comparisons: a cashier the payer cannot compare is one it cannot pass.
//
// ship_to_postal_code is OPTIONAL here since rail: a train ticket ships
// nowhere, so a rail cashier has no ZIP to read. The product that needs it
// (shop) is enforced by the FULFILLER, which knows the product — the result
// alone does not. Present, it must still be a non-empty string: an empty ZIP
// is an unread one, and a value the payer would compare against the order.
const cashierErrors = c => {
  const errs = [];
  if (!isObj(c)) return ["cashier must be an object"];
  if (!isNum(c.merchant_total) || c.merchant_total <= 0) errs.push("cashier.merchant_total must be a number > 0");
  const cur = currencyError("cashier", c.currency);
  if (cur) errs.push(cur);
  if (!Array.isArray(c.lines) || c.lines.length === 0) errs.push("cashier.lines must be a non-empty array (the order summary as the merchant shows it)");
  else c.lines.forEach((l, i) => {
    if (!isObj(l)) { errs.push(`cashier.lines[${i}] must be an object`); return; }
    if (!isStr(l.title)) errs.push(`cashier.lines[${i}].title must be a non-empty string`);
    if (!Number.isInteger(l.quantity) || l.quantity < 1) errs.push(`cashier.lines[${i}].quantity must be an integer >= 1`);
    if (!isNum(l.amount) || l.amount < 0) errs.push(`cashier.lines[${i}].amount must be a number >= 0`);
  });
  if (c.ship_to_postal_code !== undefined && !isStr(c.ship_to_postal_code)) errs.push("cashier.ship_to_postal_code must be a non-empty string when present (read from the checkout, never echoed from the input)");
  return errs;
};

export const validators = {
  search(p) {
    const errs = [];
    if (!Array.isArray(p.offers)) { errs.push("offers must be an array"); return errs; }
    if (!Number.isInteger(p.count) || p.count !== p.offers.length) errs.push("count must equal offers.length");
    p.offers.forEach((o, i) => {
      const oneWay = isNum(o.price) && o.price > 0;
      const roundTrip = isNum(o.price_total) && o.price_total > 0 && o.outbound && o.return;
      if (!oneWay && !roundTrip) errs.push(`offers[${i}]: needs price>0 (one-way) or price_total>0 + outbound + return (round trip)`);
      if (!isStr(o.id) && !(o.outbound && isStr(o.outbound.id))) errs.push(`offers[${i}]: id missing`);
      const cur = currencyError(`offers[${i}]`, o.currency);
      if (cur) errs.push(cur);
    });
    return errs;
  },
  "offer-details"(p) {
    const errs = [];
    if (!Array.isArray(p.fares)) { errs.push("fares must be an array"); return errs; }
    p.fares.forEach((f, i) => {
      if (!isNum(f.price) || f.price <= 0) errs.push(`fares[${i}]: price must be > 0`);
      const cur = currencyError(`fares[${i}]`, f.currency);
      if (cur) errs.push(cur);
      if (f.conditions !== undefined && !Array.isArray(f.conditions)) errs.push(`fares[${i}]: conditions must be an array`);
    });
    return errs;
  },
  book(p) {
    const errs = [];
    if (typeof p.payClicked !== "boolean") errs.push("payClicked must be a boolean");
    if (!["paid", "failed", "unverified"].includes(p.paymentStatus)) errs.push("paymentStatus must be paid|failed|unverified");
    // payReachable is what a walk-only run proves: it located Pay and found
    // it present, enabled and uncovered — or it reports what stood in the
    // way. A dry run that stops "just before Pay" without it proved nothing
    // about Pay.
    if (p.payReachable !== undefined && typeof p.payReachable !== "boolean") errs.push("payReachable must be a boolean when present");
    if (p.blocker !== undefined && typeof p.blocker !== "string") errs.push("blocker must be a string when present");
    if (p.payClicked === true && p.payReachable === false) errs.push("payClicked cannot be true when payReachable is false");
    return errs;
  },

  // ── protocol 2 ──
  // discover: what a vertical has to sell for the question asked (rail: the
  // journeys between two places on a date). Each item is something a quote
  // can price next — its `ref` is the recipe's own, opaque to everyone else,
  // and must find the same journey again. price_from is the CHEAPEST fare for
  // the whole party asked, a teaser: the quote, not this, sizes the escrow.
  // No trains is an honest answer (count 0), never an error.
  discover(p) {
    const errs = [];
    if (!Array.isArray(p.items)) return ["items must be an array ([] when nothing matches)"];
    if (!Number.isInteger(p.count) || p.count !== p.items.length) errs.push("count must equal items.length");
    p.items.forEach((it, i) => {
      if (!isObj(it)) { errs.push(`items[${i}] must be an object`); return; }
      if (!isStr(it.ref)) errs.push(`items[${i}].ref must be a non-empty string (the recipe's own id for this item)`);
      if (!isStr(it.title)) errs.push(`items[${i}].title must be a non-empty string`);
      if (!isNum(it.price_from) || it.price_from <= 0) errs.push(`items[${i}].price_from must be a number > 0`);
      const cur = currencyError(`items[${i}]`, it.currency);
      if (cur) errs.push(cur);
      if (it.summary !== undefined && !isObj(it.summary)) errs.push(`items[${i}].summary must be an object when present`);
    });
    return errs;
  },
  // quote: a FIRM price for one item, shipped to one place — or the reason
  // there is none. Three outcomes, and each is an answer the marketplace can
  // act on: charge this, ask the buyer this, or tell them no. A quote is
  // what the customer's escrow is sized from, so its arithmetic is checked
  // here rather than trusted: a breakdown that does not add up is a total
  // nobody can explain to the person paying it.
  quote(p) {
    const errs = [];
    if (!QUOTE_STATUSES.includes(p.status)) return [`status must be ${QUOTE_STATUSES.join("|")}`];
    if (p.status === "options_required") {
      // The buyer must choose (size, colour…) before anything can be priced.
      // A menu with nothing on it is not a question, it is a dead end.
      if (!Array.isArray(p.menu) || p.menu.length === 0) return ["menu must be a non-empty array when status is options_required"];
      p.menu.forEach((m, i) => {
        if (!isObj(m)) { errs.push(`menu[${i}] must be an object`); return; }
        if (!isStr(m.name)) errs.push(`menu[${i}].name must be a non-empty string`);
        if (!Array.isArray(m.values) || m.values.length === 0 || !m.values.every(isStr)) errs.push(`menu[${i}].values must be a non-empty array of non-empty strings`);
        if (m.unavailable !== undefined && (!Array.isArray(m.unavailable) || !m.unavailable.every(v => typeof v === "string"))) errs.push(`menu[${i}].unavailable must be an array of strings when present`);
      });
      return errs;
    }
    if (p.status === "unavailable") {
      if (!UNAVAILABLE_REASONS.includes(p.reason)) errs.push(`reason must be ${UNAVAILABLE_REASONS.join("|")} when status is unavailable`);
      return errs;
    }
    // priced
    const it = p.item;
    let itemNumeric = false;
    if (!isObj(it)) errs.push("item must be an object");
    else {
      if (!isStr(it.ref)) errs.push("item.ref must be a non-empty string");
      if (!isStr(it.title)) errs.push("item.title must be a non-empty string");
      if (!isObj(it.selections)) errs.push("item.selections must be an object ({} for a product with no options)");
      if (!Number.isInteger(it.quantity) || it.quantity < 1) errs.push("item.quantity must be an integer >= 1");
      if (!isNum(it.unit_price) || it.unit_price <= 0) errs.push("item.unit_price must be a number > 0");
      if (it.sku !== undefined && typeof it.sku !== "string") errs.push("item.sku must be a string when present");
      if (it.image_url !== undefined && typeof it.image_url !== "string") errs.push("item.image_url must be a string when present");
      itemNumeric = Number.isInteger(it.quantity) && it.quantity >= 1 && isNum(it.unit_price) && it.unit_price > 0;
    }
    const b = p.breakdown;
    if (!isObj(b)) errs.push("breakdown must be an object {items, shipping, tax, merchant_fees, merchant_total}");
    else {
      let numeric = true;
      for (const k of ["items", "shipping", "tax", "merchant_fees", "merchant_total"]) {
        if (!isNum(b[k]) || b[k] < 0) { errs.push(`breakdown.${k} must be a number >= 0`); numeric = false; }
      }
      if (numeric) {
        if (b.merchant_total <= 0) errs.push("breakdown.merchant_total must be > 0");
        // The parts must make the whole: a fee the recipe did not name is
        // money the customer pays for nothing anyone can point to.
        if (!withinCent(b.items + b.shipping + b.tax + b.merchant_fees, b.merchant_total)) {
          errs.push(`breakdown does not add up: items+shipping+tax+merchant_fees = ${+(b.items + b.shipping + b.tax + b.merchant_fees).toFixed(4)}, merchant_total = ${b.merchant_total}`);
        }
        if (itemNumeric && !withinCent(it.unit_price * it.quantity, b.items)) {
          errs.push(`breakdown.items (${b.items}) is not unit_price × quantity (${it.unit_price} × ${it.quantity})`);
        }
      }
    }
    const cur = currencyError("quote", p.currency);
    if (cur) errs.push(cur);
    if (p.shipping_method !== undefined && typeof p.shipping_method !== "string") errs.push("shipping_method must be a string when present");
    // When the service is over (the parcel delivered) — what the escrow's
    // hold is sized from. Required: a hold nobody sized is one that expires
    // with the parcel still in a van, and expiry is what refunds the buyer.
    if (!isISODate(p.service_ends_at)) errs.push("service_ends_at must be a date YYYY-MM-DD");
    if (!Array.isArray(p.requires)) errs.push(`requires must be an array of requirement slots (${REQUIREMENT_SLOTS.join(", ")}) — [] when none`);
    else p.requires.forEach((r, i) => { if (!REQUIREMENT_SLOTS.includes(r)) errs.push(`requires[${i}]: "${r}" is not a requirement slot (${REQUIREMENT_SLOTS.join(", ")})`); });
    return errs;
  },
  // buy: book's rules — the same money facts decide refund vs uncertain —
  // plus the cashier. A walk that says it reached Pay must say what Pay
  // would charge: that is the one thing the payer checks before a human is
  // paged, and "reachable" without it is a claim the payer cannot verify.
  buy(p) {
    const errs = validators.book(p);
    if (p.payReachable === true && p.cashier === undefined) errs.push("cashier is required when payReachable is true");
    // Present without payReachable:true it is still checked: a malformed
    // cashier is malformed wherever it sits, and "ignored unless" is how a
    // bad one ends up read by something later.
    if (p.cashier !== undefined) errs.push(...cashierErrors(p.cashier));
    if (p.reference !== undefined && typeof p.reference !== "string") errs.push("reference must be a string when present");
    return errs;
  },
};

// ── signal emission — the ONLY way a recipe should talk to the runner ──
// emitResult(task, payload) VALIDATES, stamps {v, task} (the SDK imposes
// both — payload values are ignored; v is the TASK's protocol, 1 for the air
// tasks and 2 for discover/quote/buy), and refuses a malformed result with
// EXIT.malformed. Financial conservatism: a malformed BOOK or BUY result
// still emits a minimal well-formed line carrying payClicked first, so the
// runner never loses the one fact that decides refund vs uncertain.
export const emitResult = (task, payload) => {
  const validate = validators[task];
  if (!validate) { L(`emitResult: unknown task "${task}"`); process.exitCode = EXIT.malformed; return false; }
  const errs = validate(payload ?? {});
  if (errs.length) {
    errs.forEach(e => L("malformed result: " + e));
    if (task === "book" || task === "buy") {
      console.log(MARKERS.result + JSON.stringify({
        v: TASK_PROTOCOL[task], task, payClicked: payload?.payClicked === true,
        paymentStatus: "unverified", malformed: true,
      }));
    }
    process.exitCode = EXIT.malformed;
    return false;
  }
  console.log(MARKERS.result + JSON.stringify({ ...payload, v: TASK_PROTOCOL[task], task }));
  return true;
};
export const emitApproval = obj => console.log(MARKERS.approval + JSON.stringify({ ...obj, v: PROTOCOL_VERSION, task: "approval" }));
export const emit3DS = obj => console.log(MARKERS.threeDS + JSON.stringify({ ...obj, v: PROTOCOL_VERSION, task: "3ds" }));
// emitVerification: the ephemeral account was created on the order's address
// and the supplier sent something there — a code or a link. The runtime owns
// that inbox; the recipe asks and waits (waitVerification), never reads mail.
export const emitVerification = obj => console.log(MARKERS.verification + JSON.stringify({ ...obj, v: PROTOCOL_VERSION, task: "verification" }));
export const emitSession = id => { if (id) console.log(MARKERS.session + id); };
// emitPhase marks a step of the run ("search", "select", "passenger-form",
// "cashier"…). The runtime parses these into the evidence timeline; the last
// phase before a failing exit becomes the structured failure_phase an author
// (or an agent) iterates on. Cheap, honest, worth sprinkling.
const PHASE_T0 = Date.now();
export const emitPhase = name => {
  if (!name) return;
  CASE.phase = String(name); // the case file's "where was it" — free, since the phase is already declared here
  console.log(MARKERS.phase + JSON.stringify({ phase: String(name), at: Date.now() - PHASE_T0, v: PROTOCOL_VERSION }));
};

// ── case files: what a FAILURE leaves behind, beyond the picture ──────────
// A PNG says a walk broke. It never says which selector to write, so a
// broken selector meant freezing a live session and hoping the intermittent
// case came back — a day, on the seat modal. What actually answers the
// question is the DOM at the moment of the failure and the JSON the site
// answered with, and both are free to keep: the page is open and the
// payloads have already gone past.
//
// Written next to the screenshot, harvested by the runtime with it
// (/v1/runs/collect), swept with it:
//   case.state.json          where it was, what it wanted, what it saw
//   case.html.gz             outerHTML — replay it offline against selectors
//   case.payloads.json.gz    the supplier responses the run captured
//
// Bounded on purpose: a case file that costs a run its memory is not
// evidence, it is a second bug.
const CASE_PAYLOADS = 8, CASE_PAYLOAD_BYTES = 256 * 1024, CASE_HTML_BYTES = 8 * 1024 * 1024;
const CASE = { phase: "", payloads: [] };

// recordPayload keeps ONE supplier response in a ring of the last few. The
// SDK's own captureJSON feeds it for every route a recipe declares, so a
// recipe that captures through the SDK gets its payload fixtures without a
// line of its own. body may be an object or raw text.
export const recordPayload = (url, body) => {
  try {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    if (!text) return;
    CASE.payloads.push({
      url: String(url || "").slice(0, 500),
      at: Date.now() - PHASE_T0,
      phase: CASE.phase,
      // Truncation is marked, never silent: a fixture nobody can tell is
      // partial is a test that fails for the wrong reason later.
      body: text.length > CASE_PAYLOAD_BYTES ? text.slice(0, CASE_PAYLOAD_BYTES) : text,
      truncated: text.length > CASE_PAYLOAD_BYTES,
    });
    while (CASE.payloads.length > CASE_PAYLOADS) CASE.payloads.shift();
  } catch {}
};

// redactCase removes, BY VALUE, what the runtime handed this run and what
// must not survive in a file kept for a week. By value rather than by
// pattern: the runtime knows exactly which strings it sent — they are in
// RECIPE_INPUT and in the environment — so this is exact, where hunting for
// "things that look like a passport number" is a guess that misses the
// unusual passenger and mangles the ordinary page.
//
// Three groups, and each is here for its own reason:
//   the CARD      — it is not normally IN the DOM (a typed value is a
//                   property, not an attribute) but "not normally" is not a
//                   property to rest on;
//   the TOKENS    — a run token and a signed session URL are live
//                   credentials for as long as the run, and a case file
//                   outlives it. ACCOUNT_PASSWORD joined them on 2026-09-02:
//                   it was left out while nothing injected it, and the day
//                   conformance walks started holding one, the case file
//                   became a place it could sit — a file an AUTHOR reads
//                   back, for an account on an inbox we own;
//   the TRAVELLER — a real booking's passenger form is a full identity, and
//                   the case file is the one place it would sit in the open.
//
// Fields are named, not sniffed: `gender` is "M" and `nationality` is "FR",
// and redacting two-letter values by value would eat every "M" in the page.
// Anything shorter than 4 characters is left alone for the same reason.
//
// buy.v1 adds the parcel's destination: the recipient (given, surname, phone
// — already named above) and the street (line1, line2, city). region,
// postal_code and country are KEPT: they are not an identity on their own,
// they are exactly what a debugger needs to see which shipping rule fired,
// and "CA"/"US" are the two-letter values the ≥4 rule exists to spare.
// buy.v1 for rail carries fulfilment.person[] — {given, surname, dob} per
// traveller, exactly a v1 passenger — so the same named fields cover it.
const PII_FIELDS = ["given", "surname", "dob", "idnum", "idexp", "contact_email", "contact_phone", "email", "phone",
  "line1", "line2", "city"];
const SECRET_ENV = ["CARD_NUMBER", "CARD_CVV", "CARD_EXPIRATION", "LLM_RUN_TOKEN", "BB_CONNECT_URL", "ACCOUNT_PASSWORD"];

const caseSecrets = () => {
  const out = [];
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 4) out.push(v);
  }
  // The traveller, straight from the job this run was given.
  const collect = node => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") { collect(value); continue; }
      if (typeof value === "string" && value.length >= 4 && PII_FIELDS.includes(key)) out.push(value);
    }
  };
  try { collect(JSON.parse(process.env.RECIPE_INPUT || "{}")); } catch {}
  // Longest first: a surname that is a substring of an email address must
  // not leave the email half-redacted and still readable.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
};

const redactCase = text => {
  let out = String(text);
  for (const secret of caseSecrets()) out = out.split(secret).join("«redacted»");
  return out.replace(/(<input[^>]*type=["\']password["\'][^>]*?)value=("[^"]*"|\'[^\']*\')/gi, "$1value=\"«redacted»\"");
};

// pageHTML/pageURL read the two facts a case file needs from whatever page
// object the recipe holds — and that is NOT always a Playwright page. Both
// live recipes drive `wrapPage`'s adapter, whose `url` is ASYNC and which
// has no `content` at all. The first version of this called `.url()` without
// awaiting and `.content()` without checking: the first production case file
// (trip.com, 2026-09-02 05:07) recorded `"url": {}` — a serialized Promise —
// and no DOM whatsoever, which is the one thing it exists to carry. The
// smoke test passed because it was written against a page shape I invented
// rather than the one production drives.
const pageHTML = async page => {
  // The adapter keeps the real page on `raw`; ask it directly when it is
  // there, fall back to a DOM read through `evaluate`, which every surface
  // in the page-surface contract has.
  for (const read of [
    () => page?.raw?.content?.(),
    () => page?.content?.(),
    () => page?.evaluate?.(() => document.documentElement.outerHTML),
  ]) {
    try {
      const html = await read();
      if (typeof html === "string" && html) return html;
    } catch {}
  }
  return "";
};

const pageURL = async page => {
  try {
    const url = await page?.url?.();
    return typeof url === "string" ? url : "";
  } catch { return ""; }
};

// dumpCase writes the case file. Best-effort from end to end: a failing run
// is already failing, and nothing here may change how it ends.
export const dumpCase = async (getPage, state = {}) => {
  const written = [];
  const write = (name, text, gzip) => {
    try {
      const raw = Buffer.from(redactCase(text));
      fs.writeFileSync(name, gzip ? zlib.gzipSync(raw) : raw);
      written.push(name);
    } catch {}
  };
  let page = null;
  try { page = getPage?.(); } catch {}
  const url = await pageURL(page);
  write("case.state.json", JSON.stringify({
    task: process.env.TASK || "", url, phase: CASE.phase, at: Date.now() - PHASE_T0,
    session: process.env.BB_SESSION_ID || "", ...state,
  }, null, 2), false);
  const html = await pageHTML(page);
  // A page over the cap is dropped rather than cut: half a document is not
  // a smaller fixture, it is one no parser can load.
  if (html && html.length <= CASE_HTML_BYTES) write("case.html.gz", html, true);
  if (CASE.payloads.length) write("case.payloads.json.gz", JSON.stringify(CASE.payloads), true);
  return written;
};

// ── screenshot evidence ──
// approvalShots: ABSOLUTE paths collected for the approval/3DS requests (the runner reads these files).
export const approvalShots = [];
// makeSnap(getPage): FULL PAGE (fullPage) — the human must see the WHOLE form at once; on the passenger
// page the scroll sits at the bottom, a viewport capture would hide the passenger at the top.
// Viewport fallback if fullPage fails. getPage is a closure because the recipe's active page CHANGES
// (Trip opens steps in new tabs).
export const makeSnap = getPage => async name => {
  const p = name.endsWith(".png") ? name : name + ".png";
  const save = async opt => {
    fs.writeFileSync(p, await getPage().screenshot(opt));
    const abs = `${process.cwd()}/${p}`;
    if (!approvalShots.includes(abs)) approvalShots.push(abs);
    return abs;
  };
  try { return await save({ fullPage: true }); } catch { try { return await save({}); } catch { return null; } }
};

// shot(getPage) is makeSnap's cheap twin: no fullPage retry, no approval
// bookkeeping, and it swallows its own failure — a debugging aid must never
// take a run down. Both recipes had reimplemented exactly this, which was the
// last reason author code imported `fs`.
export const makeShot = (getPage, { skip = () => false } = {}) => {
  const shot = async name => {
    if (skip()) return null;
    const p = name.endsWith(".png") ? name : name + ".png";
    try { fs.writeFileSync(p, await getPage().screenshot()); return p; } catch { return null; }
  };
  // makeBail dumps the DOM of the page that failed, and the page it must
  // reach is exactly the one this closure holds. Carried on the function
  // rather than asked of the recipe: both ends are the SDK's, and a second
  // constructor argument is a line every recipe would have to add (and one
  // of them would forget) for a file the runtime collects anyway.
  shot.getPage = getPage;
  return shot;
};

// ── clean exit ──
// makeBail({shot, cleanup}): narrate, capture the failure, run the recipe's cleanup (close the
// browser session…), FLUSH stdout, exit. shot is the recipe's cheap screenshot helper (may be a
// no-op on search); cleanup must never throw the bail off course — it is awaited inside a guard.
// `committed` reports whether Pay has been clicked, and `onCommitted` emits
// the outcome. Once money may have moved, NO exit code is a clean failure:
// the runtime refunds a clean failure, so a post-Pay bail refunds a customer
// whose card may already be charged, and the operator eats the ticket. The
// conversion lives here rather than at each call site because it has to hold
// for the bail nobody thought about — trip.com's 3-D Secure timeout was
// exactly that one, reporting exit 3 (offer gone) after clicking Pay.
export const makeBail = ({ shot, cleanup, committed, onCommitted } = {}) => async (code, msg, png) => {
  L(msg);
  if (png && shot) await shot(png);
  // The case file, always — not only when the recipe remembered to ask for
  // a screenshot. This is the bail EVERY failure goes through, which is the
  // only reason the coverage is complete.
  if (shot?.getPage) {
    const kept = await dumpCase(shot.getPage, { exit: code, message: String(msg).slice(0, 500) });
    if (kept.length) L(`  [case] ${kept.join(", ")}`);
  }
  let paid = false;
  try { paid = committed ? !!(await committed()) : false; } catch {}
  if (paid) {
    L("  ⚠️ Pay was already clicked — reporting UNCERTAIN, not a failure (a failure would refund a charged card)");
    try { await onCommitted?.(msg); } catch {}
  }
  try { await cleanup?.(); } catch {}
  await drain();
  process.exit(paid ? EXIT.uncertain : code);
};

// ── runtime gates: a file, no network. Boring on purpose. ──
// waitApproval: polls the signal file until APPROVE / REJECT / TIMEOUT.
// Without a file (manual test), reads stdin ("APPROVE"/"REJECT" + Enter).
export const waitApproval = async ({ file, timeoutS }) => {
  const t0 = Date.now();
  if (!file) {
    L("  (no APPROVE_SIGNAL_FILE — type APPROVE or REJECT + Enter)");
    process.stdin.resume();
    return await new Promise(res => {
      const to = setTimeout(() => res("TIMEOUT"), timeoutS * 1000);
      process.stdin.once("data", d => { clearTimeout(to); res(/^\s*approve/i.test(String(d)) ? "APPROVE" : "REJECT"); });
    });
  }
  while ((Date.now() - t0) / 1000 < timeoutS) {
    try { const v = fs.readFileSync(file, "utf8").trim().toUpperCase(); if (v === "APPROVE" || v === "REJECT") return v; } catch {}
    await sleep(2000);
  }
  return "TIMEOUT";
};

// waitOTP: the 3DS code travels ONLY through the signal file (or stdin in manual runs) —
// never a cache, never a log. Returns "" on timeout.
export const waitOTP = async ({ file, timeoutS }) => {
  const t0 = Date.now();
  if (!file) {
    L("  (no OTP_SIGNAL_FILE — type the 3DS code + Enter)");
    process.stdin.resume();
    return await new Promise(res => {
      const to = setTimeout(() => res(""), timeoutS * 1000);
      process.stdin.once("data", d => { clearTimeout(to); res(String(d).replace(/\D/g, "")); });
    });
  }
  while ((Date.now() - t0) / 1000 < timeoutS) {
    try { const v = fs.readFileSync(file, "utf8").trim(); if (/^\d{3,10}$/.test(v)) return v; } catch {}
    await sleep(2000);
  }
  return "";
};

// ── waitVerification: the email verification of an ephemeral account ──────
// The supplier mails the order's address; the runtime relays what arrived
// into VERIFY_SIGNAL_FILE, one line:
//   CODE 123456                      → { kind: "code", value: "123456" }
//   URL https://supplier/verify/…    → { kind: "url",  value: "https://…" }
//   REJECT                           → null  (the operator declined)
// Timeout → null. The value is typed into the page or navigated to — where
// the browser may go is bounded by the session's allowedDomains, not here.
// A URL must be https; anything else in the file is ignored and waited past,
// so a half-written line never becomes a verdict.
export const parseVerification = line => {
  const m = String(line || "").trim().match(/^(CODE|URL|REJECT)(?:\s+(\S+))?$/i);
  if (!m) return undefined;
  const kind = m[1].toUpperCase();
  if (kind === "REJECT") return null;
  if (kind === "CODE") return /^[A-Za-z0-9-]{3,12}$/.test(m[2] || "") ? { kind: "code", value: m[2] } : undefined;
  return /^https:\/\/\S+$/.test(m[2] || "") ? { kind: "url", value: m[2] } : undefined;
};
export const waitVerification = async ({ file, timeoutS }) => {
  const t0 = Date.now();
  if (!file) {
    L("  (no VERIFY_SIGNAL_FILE — type CODE <code> or URL <https://…> + Enter)");
    process.stdin.resume();
    return await new Promise(res => {
      const to = setTimeout(() => res(null), timeoutS * 1000);
      process.stdin.once("data", d => { clearTimeout(to); res(parseVerification(String(d)) ?? null); });
    });
  }
  while ((Date.now() - t0) / 1000 < timeoutS) {
    try {
      const v = parseVerification(fs.readFileSync(file, "utf8"));
      if (v !== undefined) return v;
    } catch {}
    await sleep(2000);
  }
  return null;
};

// ── submit3DSCode: type the code INTO the challenge and confirm ───────────
// Waiting for a code and then not entering it is not a 3-D Secure flow: the
// payment simply never completes, and every challenged order freezes as
// uncertain. That was ryanair.com until 2026-08-21 — it logged "code entered"
// and moved on.
//
// Why it lives here: the mechanics are the issuer's, not the supplier's. The
// challenge renders in a cross-origin OOPIF (cardinal / centinel / stepup /
// acs), where Stagehand's act() fails with "extension world not ready" —
// observed live on 3 of 3 attempts. A parallel Playwright CDP client does
// traverse those frames, so the code is typed frame-side, by shape rather
// than by a hard-coded selector: an input whose name/aria/placeholder says
// code, else a short maxLength, else the only input on the frame.
//
// The code goes into the page and nowhere else — never logged, never cached.
//
// There is no second path on purpose. The obvious one — Stagehand's act() —
// is the thing that already fails here, so it would be a rescue that does not
// rescue: a branch nobody exercises, in the one place where being wrong costs
// a charged card and a frozen order. A code that does not clear the challenge
// is reported as such, and a human resolves it.
//
//   cdp             the parallel Playwright browser (connectOverCDP)
//   code            the one-time code
//   stillChallenged optional () => Promise<boolean>, the recipe's own
//                   detection; used to stop as soon as the challenge is gone
//   attempts        how many times to try (default 3)
//
// Returns true once the challenge is gone (or the code was accepted and no
// detection was supplied), false if it never left.
export const submit3DSCode = async ({ cdp, code, stillChallenged, attempts = 3, log = L }) => {
  const lastPage = () => {
    try { const ps = cdp.contexts().flatMap(c => c.pages()); return ps[ps.length - 1] || null; }
    catch { return null; }
  };
  const fillOnce = async () => {
    const pp = lastPage();
    if (!pp) { log("  [3DS] no Playwright client — cannot reach the challenge frame"); return false; }
    log("  [3DS] frames: " + pp.frames().map(f => (f.url() || "?").replace(/^https?:\/\//, "").slice(0, 45)).join(" | "));
    for (const fr of pp.frames()) {
      const url = (fr.url() || "").toLowerCase();
      let found = false;
      try {
        found = await fr.evaluate(() => {
          const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const inputs = [...document.querySelectorAll("input")].filter(i => visible(i) && !/hidden|checkbox|radio|button|submit/.test(i.type));
          const meta = i => ((i.name || "") + " " + (i.id || "") + " " + (i.placeholder || "") + " " + (i.getAttribute("aria-label") || "")).toLowerCase();
          const target = inputs.find(i => /code|otp|pass|pin|token|secur|challenge/.test(meta(i)))
            || inputs.find(i => i.maxLength > 0 && i.maxLength <= 10)
            || (inputs.length === 1 ? inputs[0] : null);
          if (!target) return false;
          target.setAttribute("data-otp-target", "1");
          return true;
        });
      } catch {}
      if (!found) {
        if (/cardinal|centinel|stepup|acs|3ds|challenge|authenticat/.test(url)) log(`  [3DS] frame ${url.slice(0, 55)}: code input not found`);
        continue;
      }
      try {
        await fr.fill('[data-otp-target="1"]', code, { timeout: 8000 });
        log(`  [3DS] code entered ✓ (frame ${(url || "same-origin").replace(/^https?:\/\//, "").slice(0, 50)})`);
        const hasButton = await fr.evaluate(() => {
          const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const b = [...document.querySelectorAll("button,input[type=submit],[role=button]")].filter(visible)
            .find(e => /confirm|submit|verify|validate|continue|\bpay\b|\bok\b/i.test((e.innerText || e.value || "").trim())
              && (e.innerText || e.value || "").trim().length < 30);
          if (!b) return false;
          b.setAttribute("data-otp-submit", "1");
          return true;
        });
        if (hasButton) { await fr.click('[data-otp-submit="1"]', { timeout: 8000 }); log("  [3DS] Confirm clicked ✓"); }
        else { await fr.press('[data-otp-target="1"]', "Enter").catch(() => {}); log("  [3DS] no button found → Enter"); }
        return true;
      } catch (e) { log("  [3DS] frame-fill failed: " + String(e.message).slice(0, 70)); }
    }
    return false;
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const filled = await fillOnce();
    await sleep(3000);
    if (stillChallenged) {
      if (!(await stillChallenged())) { log("  [3DS] validated (left the challenge)"); return true; }
    } else if (filled) {
      return true;
    }
    log(`  [3DS] still on the challenge (attempt ${attempt})`);
  }
  return false;
};

// ── runtimeModel: the LLM behind Stagehand, WITHOUT an Anthropic key ──────
// Stagehand v4 accepts a "bring your own LLM" callback ({ generate }) that
// runs in THIS process. The runtime gives the recipe LLM_PROXY_URL (a
// loopback proxy holding the real key) and LLM_RUN_TOKEN (a per-run token
// with a budget, revoked when the run ends). generate() translates
// Stagehand's provider-neutral request into an Anthropic Messages call on
// that proxy and translates the answer back. Text and image blocks map 1:1;
// a json_schema response format is asked for through a single forced tool,
// which is the reliable way to get schema-shaped JSON from Claude.
//
// Usage: model: runtimeModel()   — when LLM_PROXY_URL is unset (local dev
// with your own key), returns null so callers can fall back to
// { modelName, apiKey }.
export const runtimeModel = ({ modelName = process.env.SH_MODEL || "anthropic/claude-sonnet-4-6", maxTokens = 4096 } = {}) => {
  const base = (process.env.LLM_PROXY_URL || "").replace(/\/$/, "");
  const token = process.env.LLM_RUN_TOKEN || "";
  if (!base || !token) return null;
  const model = modelName.replace(/^anthropic\//, "");
  const toBlocks = c => (Array.isArray(c) ? c : [c]).map(b => {
    if (!b || typeof b !== "object") return { type: "text", text: String(b ?? "") };
    if (b.type === "text") return { type: "text", text: b.text ?? "" };
    if (b.type === "image") return { type: "image", source: { type: "base64", media_type: b.mimeType || "image/png", data: b.data } };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id || b.toolUseId || "tu_" + Math.random().toString(36).slice(2), name: b.name, input: b.input ?? {} };
    if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.toolUseId || b.tool_use_id || b.id, content: toBlocks(b.content || []) };
    return { type: "text", text: JSON.stringify(b) };
  });
  const generate = async params => {
    const body = {
      model, max_tokens: maxTokens,
      messages: (params.messages || []).map(m => ({ role: m.role, content: toBlocks(m.content) })),
    };
    if (params.systemPrompt) body.system = params.systemPrompt;
    if (typeof params.temperature === "number") body.temperature = params.temperature;
    if (params.stopSequences?.length) body.stop_sequences = params.stopSequences;
    const wantsJSON = params.responseFormat?.type === "json_schema";
    const tools = [];
    if (wantsJSON) tools.push({ name: params.responseFormat.name || "respond", description: params.responseFormat.description || "Answer with the requested structure.", input_schema: params.responseFormat.schema });
    for (const t of params.tools || []) tools.push({ name: t.name, description: t.description || "", input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} } });
    if (tools.length) body.tools = tools;
    if (wantsJSON) body.tool_choice = { type: "tool", name: tools[0].name };
    const res = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`llm proxy ${res.status}: ${text.slice(0, 300)}`);
    const out = JSON.parse(text);
    const usage = out.usage ? {
      inputTokens: out.usage.input_tokens || 0, outputTokens: out.usage.output_tokens || 0,
      totalTokens: (out.usage.input_tokens || 0) + (out.usage.output_tokens || 0),
      cachedInputTokens: out.usage.cache_read_input_tokens || 0,
    } : undefined;
    const blocks = out.content || [];
    if (wantsJSON) {
      const tu = blocks.find(b => b.type === "tool_use");
      let structured = tu?.input;
      if (structured === undefined) {
        const t = blocks.filter(b => b.type === "text").map(b => b.text).join("");
        try { structured = JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("llm answered without the requested structure"); }
      }
      return { role: "assistant", content: { type: "text", text: JSON.stringify(structured) }, outputFormat: "json_schema", structuredContent: structured, stopReason: out.stop_reason || undefined, usage };
    }
    const content = blocks.map(b => b.type === "text" ? { type: "text", text: b.text }
      : b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input }
      : { type: "text", text: JSON.stringify(b) });
    return { role: "assistant", content: content.length === 1 ? content[0] : content, outputFormat: "text", stopReason: out.stop_reason || undefined, usage };
  };
  return { generate };
};

// ── captureJSON: the supplier's own JSON, read off the wire ────────────────
// Every browser recipe needs the same thing: the availability / fare / basket
// payloads the supplier's front-end fetches, read as JSON instead of scraped
// from the DOM (prices, times and fare menus are complete and typed there;
// the DOM is a lossy, shifting rendering of them). Stagehand does not expose
// network events, so this opens a PARALLEL Playwright CDP client on the same
// browser and listens to responses — the reference recipe has done exactly
// this since day one; this is that pattern, supplier-agnostic.
//
//   const net = await captureJSON(cdpUrl, {
//     list:  { match: /FlightListSearch/, key: () => "list" },            // one payload, latest wins
//     fares: { match: /FlightMiddleSearch/, key: j => j.flightNo,         // many payloads, keyed
//              parse: j => j.fares, keep: (old, fresh) => fresh.length >= old.length },
//   });
//   …drive the page with Stagehand / the page adapter…
//   const menu = await net.until("fares", "FR9440", 15000);              // null on timeout
//   net.map.list; net.count("fares"); await net.close();
//
// routes[name] = { match, key?, parse?, keep? }
//   match: RegExp | string | (url) => boolean — which responses to read;
//   key:   (json, url) => string|null — the bucket inside net.map[name]
//          (default "*" = single latest payload; return null to skip);
//   parse: (json, url) => value stored (default: the JSON itself);
//   keep:  (old, fresh) => boolean — accept a replacement (default true).
//          A supplier may re-emit a PARTIAL payload after the full one (Trip
//          does, per cabin tab); keep() lets a recipe refuse the downgrade.
// Non-JSON or unparsable bodies are ignored; nothing here ever throws into
// the recipe. cdpUrl is the Browserbase connect URL (BB_CONNECT_URL) or the
// local http://127.0.0.1:<port>. playwright is imported lazily so the toy
// recipe and the validators stay dependency-free.
// ── the job, and the page ─────────────────────────────────────────────────
// Three things every recipe needs and none of them supplier-specific, so
// every recipe had written them twice.

// The task's input document. Throws with a message worth printing — the
// caller decides the exit code, because only it knows its own convention.
export const readInput = task => {
  const raw = process.env.RECIPE_INPUT;
  if (!raw) throw new Error("RECIPE_INPUT is required — a recipe has no environment fallback");
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error("RECIPE_INPUT is not JSON: " + e.message); }
  const want = { search: "air-search.v1", "offer-details": "air-offer-details.v1", book: "air-book.v1",
    discover: "rail-search.v1", quote: "quote.v1", buy: "buy.v1" }[task];
  if (!want) throw new Error(`unknown TASK ${task}`);
  if (doc.schema !== want) throw new Error(`RECIPE_INPUT declares ${doc.schema}, TASK=${task} speaks ${want}`);
  return doc.data || {};
};

// Documents carry ISO dates; suppliers often want them compact. The
// conversion is theirs to ask for, not the contract's to make.
export const isoToCompact = iso => String(iso || "").replace(/-/g, "");

// wrapPage: a raw Playwright page shaped to the surface a Stagehand page
// offers, so the code shared by the LLM and 0-LLM paths calls one thing.
//
// The INVARIANT, pinned by the registry's page-surface test: every method a
// recipe calls on `page` exists here. Anything missing is a latent "is not a
// function" that fires only on the path that needs it — `scroll` crashed
// exactly that way on a drill-down that had to reach a below-the-fold card.
export const wrapPage = p => ({
  goto: (u, o) => p.goto(u, o),
  evaluate: (f, a) => p.evaluate(f, a),
  locator: s => p.locator(s),
  click: (x, y) => p.mouse.click(x, y),
  // scroll(x, y, dx, dy): Stagehand's signature, through the real mouse.
  scroll: (x, y, dx, dy) => p.mouse.move(x, y).then(() => p.mouse.wheel(dx, dy)),
  keyPress: k => p.keyboard.press(k),
  keyboard: { press: k => p.keyboard.press(k) },
  type: t => p.keyboard.type(t),
  screenshot: () => p.screenshot(),
  url: async () => p.url(),
  raw: p,
});

// ── the browser, for local development ────────────────────────────────────
// The production path is connectRuntimeBrowser below. This is the other one:
// a Chromium on your own machine, so an author can iterate without the
// marketplace. It lives here rather than in each recipe because it is the
// same code every time, it is the only reason a recipe ever touched `fs` or
// `fetch`, and every knob it reads (CDP_PORT, HEADLESS, KEEP, FRESH) is a
// developer's, not a supplier's.
//
// Keeping it out of recipe files is what lets the lint rules that matter —
// no filesystem, no direct network, no dynamic env access — apply to author
// code without exceptions carved for a path production never runs.
//
// Returns the same shape as connectRuntimeBrowser: { browser, sessionId,
// connectUrl }. browser is a Stagehand handle when needsBrowser is set (book
// and any flow that needs act()/extract()), null otherwise — the caller then
// drives Playwright over the returned connectUrl.
export const connectLocalBrowser = async ({ needsBrowser = false } = {}) => {
  const port = Number(process.env.CDP_PORT || 9222);
  const cdpUrl = `http://127.0.0.1:${port}`;
  const fresh = process.env.FRESH !== "0";
  const headless = process.env.HEADLESS !== "0";
  const keepAlive = process.env.KEEP !== "0";
  const profile = "./chrome-profile";
  const alive = async () => {
    try {
      const r = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  };
  if (fresh) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  let browser = null;
  if (needsBrowser) {
    const { localBrowser } = await import("@browserbasehq/stagehand");
    browser = !fresh && (await alive())
      ? await localBrowser.connect({ cdpUrl })
      : (fs.mkdirSync(profile, { recursive: true }), await localBrowser.launch({
          headless, viewport: { width: 1400, height: 900 }, port,
          userDataDir: profile, preserveUserDataDir: true, keepAlive,
        }));
    return { browser, sessionId: "local", connectUrl: cdpUrl };
  }
  // 0-LLM tasks: a bare Playwright Chromium exposing CDP on the same port.
  // FRESH=0 reuses whatever is already listening here too — not paying for a
  // cold browser on every iteration is the whole point of the flag, and it
  // used to apply only to the Stagehand branch. Nothing is returned to close:
  // a browser this call did not start is not its to end.
  if (!fresh && (await alive())) return { browser: null, sessionId: "local", connectUrl: cdpUrl };
  const { chromium } = await import("playwright");
  const launched = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--remote-debugging-port=${port}`],
  });
  const up = await until(alive, 8000, 200);
  if (!up) { await launched.close().catch(() => {}); throw new Error(`local CDP port ${port} did not come up`); }
  return { browser: null, sessionId: "local", connectUrl: cdpUrl, launched };
};

// ── the browser, obtained from the runtime ────────────────────────────────
// A recipe does not create browser sessions. The marketplace's trusted runner
// does: it holds the Browserbase key, picks the proxy geo, the region, the
// timeout and the keepAlive policy, uploads Stagehand's extension, and ends
// the session when the run is over. What reaches the recipe is a connect URL
// and, for book, the id of the preloaded extension — never a key.
//
// connectRuntimeBrowser attaches to that session and returns the handle. It
// deliberately CANNOT create one: no key is read, no session API is called,
// and an absent BB_CONNECT_URL is a refusal rather than a fallback. That is
// what stops a recipe choosing its own geo, its own timeout, or its own
// session — decisions that belong to whoever pays for them.
//
// Returns { browser, sessionId, connectUrl }. `browser` is a Stagehand
// handle for book (which needs act()/extract() for the card), and null for
// the 0-LLM tasks, which drive the page over CDP instead — attaching
// Stagehand there would make the session unreusable.
//
// Closing: the caller must NOT end the session. It belongs to the runner,
// which reuses it (a warm session skips ~24s of cold start) and ends it.
//
// stagehand is imported lazily, like playwright below, so the toy recipe and
// the validators stay dependency-free.
// buy defaults like book: it is the purchase walk, and the checkout forms it
// fills are where act() earns its keep. A cardless walk passes
// needsBrowser:false explicitly, exactly as a cardless book does. discover
// defaults like search (no Stagehand): it reads a results page, over CDP.
export const connectRuntimeBrowser = async ({ task, needsBrowser = task === "book" || task === "buy" } = {}) => {
  const connectUrl = (process.env.BB_CONNECT_URL || "").trim();
  const sessionId = (process.env.BB_SESSION_ID || "").trim();
  const extensionId = (process.env.BB_EXTENSION_ID || "").trim();
  if (!connectUrl) {
    throw new Error("BB_CONNECT_URL is required: the runtime owns the browser session and this recipe cannot create one");
  }
  // needsBrowser, not the task name: a book that will never touch a card
  // (the conformance walk) has nothing to say to an LLM, so it must not
  // demand the extension the runner only uploads for a paying one. The local
  // path already worked this way; the two disagreed, and the runtime one won
  // by refusing a run it could have served.
  if (!needsBrowser) {
    return { browser: null, sessionId: sessionId || "runner-owned", connectUrl };
  }
  if (!extensionId) {
    throw new Error("BB_EXTENSION_ID is required for book/buy: Stagehand attaches to the runner's session by its preloaded extension");
  }
  const { localBrowser } = await import("@browserbasehq/stagehand");
  const browser = await localBrowser.connect({ cdpUrl: connectUrl, extensionId });
  return { browser, sessionId: sessionId || "runner-owned", connectUrl };
};

// attachStagehand: the LLM-driven half, obtained rather than assembled.
// Both recipes wrote the same four lines — create Stagehand on the handle,
// then take the context's active page — around the same model expression, and
// both carried a placeholder key ("sk-not-needed-for-dry") for the case where
// there is no model at all. A placeholder key does not make act() work; it
// turns a missing model into a 401 three minutes later, inside a checkout.
// Here it is a refusal, before the browser is touched.
//
// Where the model comes from is the runtime's business: in production a
// per-run proxy token (runtimeModel), in local development an ANTHROPIC_API_KEY.
// A recipe never holds a raw key in production and does not choose between them.
export const attachStagehand = async ({ browser, modelName = process.env.SH_MODEL || "anthropic/claude-sonnet-4-6" } = {}) => {
  if (!browser) throw new Error("attachStagehand: no browser handle — the runtime attaches Stagehand for book only");
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  const model = runtimeModel({ modelName }) || (key ? { modelName, apiKey: key } : null);
  if (!model) throw new Error("attachStagehand: no model — the runtime supplies LLM_PROXY_URL + LLM_RUN_TOKEN, local development needs ANTHROPIC_API_KEY");
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = await Stagehand.create({ browser, model });
  const page = (await browser.context.activePage()) ?? (await browser.context.newPage());
  return { stagehand, page };
};

// connectBrowser: the one call a recipe makes to get a page. Both recipes
// carried the same fifteen-line if/else — BB=1 means the runtime owns the
// session, anything else means a developer's Chromium — and a branch copied
// per recipe is a branch that drifts (trip.com's copy never closed the local
// browser; ryanair's did).
//
// It is NOT a fallback: under BB=1 a missing BB_CONNECT_URL still throws,
// exactly as before. The runtime never silently degrades to launching its own
// browser — that would hide a broken runner behind a slow, keyless run.
//
// Returns { browser, sessionId, connectUrl, launched, remote }. `launched` is
// the dev Chromium this call started, and the only thing a recipe may close;
// `remote` says a real proxy and solveCaptchas are in play, which is what
// decides how long to wait on a captcha (nobody is watching a headless run).
export const connectBrowser = async ({ task, needsBrowser = task === "book" || task === "buy" } = {}) => {
  if (process.env.BB === "1" || process.env.BB === "true") {
    const session = await connectRuntimeBrowser({ task, needsBrowser });
    L(`Browserbase session from the runtime (${session.sessionId}) — keyless${session.browser ? ", Stagehand attached" : ""}`);
    return { ...session, launched: null, remote: true };
  }
  const local = await connectLocalBrowser({ needsBrowser });
  L(`local Chromium (${local.connectUrl})`);
  return { ...local, remote: false };
};

export const captureJSON = async (cdpUrl, routes, { log = () => {} } = {}) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(cdpUrl);
  const map = {}, hits = {}, seqs = {};
  for (const name of Object.keys(routes)) { map[name] = {}; hits[name] = 0; seqs[name] = {}; }
  let seq = 0; // response ARRIVAL order, taken synchronously below
  const matches = (m, url) => m instanceof RegExp ? m.test(url) : typeof m === "function" ? !!m(url) : url.includes(String(m));
  const onResponse = async (res) => {
    // The sequence is claimed BEFORE any await: event order = arrival
    // order, while res.json() below resolves in whatever order the wire
    // pleases — without this, an old slow response could overwrite a
    // newer one after the fact.
    const mySeq = ++seq;
    const url = res.url();
    for (const [name, r] of Object.entries(routes)) {
      if (!matches(r.match, url)) continue;
      let json; try { json = await res.json(); } catch { continue; }
      recordPayload(url, json); // the fixture half: a payload + its mapper is a free, deterministic test
      let k; try { k = r.key ? r.key(json, url) : "*"; } catch { k = null; }
      if (k === null || k === undefined) continue;
      let v; try { v = r.parse ? r.parse(json, url) : json; } catch { continue; }
      const old = map[name][String(k)];
      if (old !== undefined && r.keep && !r.keep(old, v)) { log(`[net] ${name}[${k}]: kept the earlier payload`); continue; }
      if (old !== undefined && !r.keep && (seqs[name][String(k)] ?? 0) > mySeq) { log(`[net] ${name}[${k}]: stale response ignored`); continue; }
      map[name][String(k)] = v; seqs[name][String(k)] = mySeq; hits[name]++;
      log(`[net] ${name}[${k}] captured`);
    }
  };
  const wire = ctx => { ctx.on("response", onResponse); ctx.on("page", () => {}); };
  browser.contexts().forEach(wire);
  const untilFn = async (name, key = "*", ms = 15000) => {
    const ok = await until(() => map[name]?.[String(key)] !== undefined, ms);
    return ok ? map[name][String(key)] : null;
  };
  return {
    map, browser,
    until: untilFn,
    count: name => hits[name] || 0,
    close: async () => { try { await browser.close(); } catch {} },
  };
};

// ── shopify: the helpers a Shopify store recipe needs (protocol 2) ─────────
// Why here and not in the recipe: the lint allows a recipe exactly one
// relative import, this file, so a helper worth sharing across stores lives
// in the SDK where it is reviewed once. Thousands of storefronts run the same
// platform; the second Shopify recipe should be a manifest and twenty lines.
//
// Two halves, and they deserve different trust:
//
//   PURE (tested offline in test-sdk.mjs): the product document → the
//   variant, the option menu, the item description; the checkout's order
//   summary TEXT → total, lines, breakdown. Deterministic, no page.
//
//   PAGE (best-effort): navigation and checkout form filling. Everything
//   that touches the checkout DOM is marked UNVERIFIED — to confirm on the
//   Shopify spike. Shopify's one-page checkout is shared across stores but
//   its markup is not a contract; treat these as a starting point to be
//   pinned against a live store, not as fact.
//
// No fetch anywhere: the product document is read by NAVIGATING to it
// (page.goto) and reading the body — the browser's network, which
// Browserbase's allowedDomains bounds, never the recipe's own.

// A product URL's handle: /products/<handle>, also under a collection
// (/collections/x/products/<handle>). Anything else is not a product page.
const shopifyHandle = url => {
  try {
    const m = new URL(url).pathname.match(/\/products\/([^/?#.]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
};

// ?variant=<id> on a product URL is Shopify's own way to name one variant —
// a ref that carries it needs no selections at all.
const shopifyVariantParam = url => {
  try { const v = new URL(url).searchParams.get("variant"); return /^\d+$/.test(v || "") ? v : null; } catch { return null; }
};

// The option NAMES in position order. /products/<h>.js serves options as
// objects ({name, position, values}); older themes and the Liquid object
// carry bare strings. Both are read so a recipe never has to care which.
const shopifyOptionNames = product =>
  (Array.isArray(product?.options) ? product.options : []).map(o => (typeof o === "string" ? o : o?.name) || "").slice(0, 3);

// Shopify's placeholder for a product without options: one option "Title",
// one variant "Default Title". It is not a choice anybody makes, so it is
// neither a selection to echo nor a menu to show.
const isDefaultTitleOption = (product) => {
  const names = shopifyOptionNames(product);
  const vs = Array.isArray(product?.variants) ? product.variants : [];
  return names.length === 1 && /^title$/i.test(names[0]) && vs.length === 1 && /^default title$/i.test(String(vs[0].option1 || vs[0].title || ""));
};

const norm = s => String(s ?? "").trim().toLowerCase();

// variant.price: INTEGER CENTS in the .js document, a DECIMAL STRING
// ("19.99") in the .json one. Reading one as the other is a 100× error in
// either direction, so the shape decides, never a guess on magnitude.
const shopifyPrice = price => {
  if (typeof price === "number" && Number.isFinite(price)) return Math.round(price) / 100;
  if (typeof price === "string" && /^\d+(\.\d+)?$/.test(price.trim())) {
    return price.includes(".") ? Math.round(parseFloat(price) * 100) / 100 : parseInt(price, 10) / 100;
  }
  return null;
};

// Money as the checkout prints it: "$1,234.56", "USD $60.11", "60.11".
// Returns the number, or null — never 0 for "unreadable": 0 is a price.
// Only a figure that LOOKS like money counts — a currency symbol before it,
// or two decimals — so "Standard (3-5 days)" on the shipping row is never
// read as a $3 shipping fee.
const MONEY = /[$€£]\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(?![\d])|(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})(?![\d])/;
const parseMoney = s => {
  const m = String(s ?? "").match(MONEY);
  if (!m) return null;
  const whole = m[1] ?? m[3], cents = m[1] !== undefined ? m[2] : m[4];
  return parseFloat(whole.replace(/,/g, "") + (cents || ""));
};
const hasMoney = s => /[$€£]\s?\d|\d\.\d{2}\b/.test(String(s ?? ""));

// The value on a LABELLED row of the order summary: the first money amount
// on the label's own line or within the next three, stopping at the next
// label. Never "the largest number on the page": the largest number is as
// often a "compare at" price, a subtotal before discount, or a phone number.
const SUMMARY_LABELS = {
  subtotal: /^subtotal\b/i,
  shipping: /^shipping\b/i,
  tax: /^(estimated\s+)?tax(es)?\b/i,
  total: /^total\b/i,
};
const labelledRow = (lines, re) => {
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) return null;
  const window = [lines[i].replace(re, "")];
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    if (Object.values(SUMMARY_LABELS).some(r => r.test(lines[j]))) break;
    window.push(lines[j]);
  }
  return window.join("\n");
};

// One order-summary row's text → {title, quantity, amount}. The quantity is
// read from a "Quantity" label or the badge (a bare integer line), and is
// null when neither is there — never defaulted to 1: the payer refuses a
// quantity that is not the order's, and a default would pass that check for
// a cart it never read.
const parseSummaryLine = text => {
  const lines = String(text ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.some(hasMoney)) return null; // a header row, or an image with no price
  let quantity = null;
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(/^quantity\s*:?\s*(\d+)?$/i);
    if (q) { quantity = parseInt(q[1] || lines[i + 1] || "", 10); break; }
  }
  if (quantity === null || Number.isNaN(quantity)) {
    const badge = lines.find(l => /^\d{1,3}$/.test(l));
    quantity = badge ? parseInt(badge, 10) : null;
  }
  const moneyLines = lines.filter(hasMoney);
  const amount = parseMoney(moneyLines[moneyLines.length - 1]); // the row's own total sits last
  const title = lines.find(l => !hasMoney(l) && !/^\d{1,3}$/.test(l) && !/^quantity\b/i.test(l)) || "";
  return { title, quantity: Number.isInteger(quantity) ? quantity : null, amount };
};

export const shopify = {
  handle: shopifyHandle,
  variantParam: shopifyVariantParam,
  parsePrice: shopifyPrice,
  parseMoney,
  parseSummaryLine,

  // The product document, by NAVIGATION: <origin>/products/<handle>.js is
  // public on every Shopify store and carries every variant with its price
  // and availability — the JSON the product page itself is rendered from, so
  // nothing is scraped. `origin` and `url` are attached for describe().
  async product(page, url) {
    const handle = shopifyHandle(url);
    if (!handle) throw new Error(`shopify.product: not a product URL: ${url}`);
    const origin = new URL(url).origin;
    await page.goto(`${origin}/products/${encodeURIComponent(handle)}.js`, { waitUntil: "domcontentloaded" });
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    return shopify.parseProduct(text, { origin, url });
  },
  parseProduct(text, { origin = "", url = "" } = {}) {
    let json;
    try { json = JSON.parse(String(text ?? "").trim()); } catch (e) { throw new Error("shopify.product: the product document is not JSON: " + e.message); }
    // /products/<h>.json wraps it in {product}; .js does not.
    const product = isObj(json?.product) ? json.product : json;
    if (!isObj(product) || !Array.isArray(product.variants)) throw new Error("shopify.product: no variants in the product document");
    return { ...product, origin, url };
  },

  // The ONE variant the selections name, or null. Null covers both "no
  // variant matches" and "several do" on purpose: an ambiguous selection is
  // not resolved by picking the first — that is how a recipe ships the
  // wrong size — it is answered with the menu (status options_required).
  // Matching is case-insensitive and trimmed ("m" = "M "), option names
  // included. A product with a single variant needs no selections.
  pickVariant(product, selections = {}) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const names = shopifyOptionNames(product).map(norm);
    const want = Object.entries(selections || {});
    if (!want.length) return variants.length === 1 ? variants[0] : null;
    const slots = [];
    for (const [k, v] of want) {
      const i = names.indexOf(norm(k));
      if (i < 0) return null; // an option this product does not have: not a match, never ignored
      slots.push([`option${i + 1}`, norm(v)]);
    }
    const hits = variants.filter(vr => slots.every(([key, v]) => norm(vr[key]) === v));
    return hits.length === 1 ? hits[0] : null;
  },

  // The option menu for options_required: every option with its values in
  // the store's order, and the values no AVAILABLE variant carries. Per
  // option, not per combination — "M is sold out in red" is the buy's
  // problem, reported then as out_of_stock; the menu says what exists.
  menu(product) {
    if (isDefaultTitleOption(product)) return [];
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    return shopifyOptionNames(product).map((name, i) => {
      const key = `option${i + 1}`;
      const declared = product.options[i];
      const values = (typeof declared === "object" && Array.isArray(declared?.values) && declared.values.length)
        ? declared.values.map(String)
        : [...new Set(variants.map(v => v[key]).filter(v => v != null).map(String))];
      const unavailable = values.filter(val => !variants.some(v => v.available !== false && norm(v[key]) === norm(val)));
      return { name, values, unavailable };
    });
  },

  // The quote's `item` for one variant, minus quantity (the order's, not the
  // product's). `ref` names the variant itself (?variant=<id>) so the buy
  // lands on exactly what was priced even if the store reorders its options.
  describe(product, variant) {
    const names = shopifyOptionNames(product);
    const selections = {};
    if (!isDefaultTitleOption(product)) names.forEach((n, i) => { const v = variant?.[`option${i + 1}`]; if (n && v != null) selections[n] = String(v); });
    const variantTitle = String(variant?.title || "");
    const title = !variantTitle || /^default title$/i.test(variantTitle) ? String(product?.title || "") : `${product?.title || ""} - ${variantTitle}`;
    const base = product?.origin && product?.handle ? `${product.origin}/products/${product.handle}` : (product?.url || "");
    let image = variant?.featured_image?.src || (typeof product?.featured_image === "string" ? product.featured_image : product?.featured_image?.src) || "";
    if (image.startsWith("//")) image = "https:" + image; // Shopify's CDN URLs are protocol-relative
    const out = { ref: base ? `${base}?variant=${variant?.id}` : String(variant?.id ?? ""), title, selections, unit_price: shopifyPrice(variant?.price) };
    if (variant?.sku) out.sku = String(variant.sku);
    if (image) out.image_url = image;
    return out;
  },

  // Shopify's cart permalink: /cart/<variant>:<qty> builds a fresh cart with
  // exactly that line and redirects to the checkout. Exactly that line is
  // the point — a session cart holding something a previous run added would
  // be bought too, and "lines != 1" is a refusal at the payer.
  cartPermalink(origin, variantId, quantity) {
    if (!/^\d+$/.test(String(variantId))) throw new Error(`shopify: variant id must be numeric, got ${variantId}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`shopify: quantity must be an integer >= 1, got ${quantity}`);
    return `${String(origin).replace(/\/$/, "")}/cart/${variantId}:${quantity}`;
  },
  async addToCart(page, variantId, quantity, { origin } = {}) {
    const from = origin || new URL(await page.url()).origin;
    await page.goto(shopify.cartPermalink(from, variantId, quantity), { waitUntil: "domcontentloaded" });
    return page.url();
  },

  // UNVERIFIED — to confirm on the Shopify spike. The permalink normally
  // lands on /checkouts/…; a store with a cart page in between is sent to
  // /checkout, which redirects to the live checkout of the current cart.
  async toCheckout(page, { timeoutMs = 20000 } = {}) {
    const onCheckout = async () => /\/checkouts?\//.test(await page.url());
    if (!(await until(onCheckout, 5000))) {
      await page.goto(`${new URL(await page.url()).origin}/checkout`, { waitUntil: "domcontentloaded" });
    }
    if (!(await until(onCheckout, timeoutMs))) throw new Error("shopify.toCheckout: never reached /checkouts/");
    return page.url();
  },

  // The checkout form, as data: which field, which selectors, which value.
  // Pure so the mapping from buy.v1 to Shopify's form is testable without a
  // page. Selectors: name= first (Shopify's one-page checkout), then the
  // autocomplete tokens every checkout that honours autofill carries.
  // UNVERIFIED — to confirm on the Shopify spike.
  fieldPlan(fulfilment = {}, email = "") {
    const r = fulfilment.recipient || {}, a = fulfilment["address.shipping"] || {};
    const f = (field, value, selectors, kind = "input") => ({ field, value, selectors, kind });
    return [
      // Country first: changing it re-renders the form (zone list, postcode
      // label), and a field filled before that is a field filled twice.
      f("countryCode", a.country, ['select[name="countryCode"]', 'select[autocomplete="shipping country"]'], "select"),
      f("email", email, ['input[name="email"]', 'input#email', 'input[autocomplete="shipping email"]', 'input[autocomplete="email"]']),
      f("firstName", r.given, ['input[name="firstName"]', 'input[autocomplete="shipping given-name"]']),
      f("lastName", r.surname, ['input[name="lastName"]', 'input[autocomplete="shipping family-name"]']),
      f("address1", a.line1, ['input[name="address1"]', 'input[autocomplete="shipping address-line1"]']),
      f("address2", a.line2, ['input[name="address2"]', 'input[autocomplete="shipping address-line2"]']),
      f("city", a.city, ['input[name="city"]', 'input[autocomplete="shipping address-level2"]']),
      f("zone", a.region, ['select[name="zone"]', 'select[autocomplete="shipping address-level1"]'], "select"),
      f("postalCode", a.postal_code, ['input[name="postalCode"]', 'input[autocomplete="shipping postal-code"]']),
      f("phone", r.phone, ['input[name="phone"]', 'input[autocomplete="shipping tel"]']),
    ].filter(x => x.value != null && String(x.value) !== "");
  },

  // UNVERIFIED — to confirm on the Shopify spike. Fills one field of the
  // plan. Inputs are TYPED through the page's locator when it has one (React
  // checkouts ignore a bare value assignment), and set through the native
  // setter + input/change events otherwise. Selects match the option's value
  // OR its label, case-insensitively: Shopify's zone list has value "CA",
  // label "California", and the document carries the code.
  async fillField(page, { selectors, value, kind }) {
    const v = String(value);
    if (kind === "input" && typeof page.locator === "function") {
      for (const sel of selectors) {
        try { await page.locator(sel).fill(v, { timeout: 4000 }); return sel; } catch {}
      }
    }
    return await page.evaluate(({ selectors, v, kind }) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        let next = v;
        if (kind === "select") {
          const want = v.trim().toLowerCase();
          const opt = [...el.options].find(o => o.value.trim().toLowerCase() === want) ||
            [...el.options].find(o => (o.textContent || "").trim().toLowerCase() === want);
          if (!opt) return null;
          next = opt.value;
        }
        const proto = kind === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return sel;
      }
      return null;
    }, { selectors, v, kind });
  },

  // UNVERIFIED — to confirm on the Shopify spike. Fills the whole shipping
  // form from buy.v1's fulfilment + contact_email. Returns what was filled
  // and what was not found; the recipe decides whether a missing field is
  // fatal (a missing address2 is not, a missing postalCode is).
  async fillShipping(page, fulfilment, email) {
    const filled = [], missing = [];
    for (const step of shopify.fieldPlan(fulfilment, email)) {
      const hit = await shopify.fillField(page, step).catch(() => null);
      (hit ? filled : missing).push(step.field);
    }
    return { filled, missing };
  },

  // UNVERIFIED — to confirm on the Shopify spike. Prices a ship-to that is
  // only country/region/ZIP (quote.v1 has no street) and waits for the
  // summary to show a shipping figure. Some stores will not rate a parcel
  // without a street; the spike decides what a quote does then — never an
  // invented street address.
  async priceTo(page, shipTo, { timeoutMs = 15000 } = {}) {
    const plan = shopify.fieldPlan({ "address.shipping": {
      country: shipTo?.country, region: shipTo?.region, postal_code: shipTo?.postal_code } }, "");
    for (const step of plan) await shopify.fillField(page, step).catch(() => null);
    let summary = null;
    await until(async () => { summary = await shopify.readCashier(page); return summary.shipping !== null && summary.merchant_total !== null; }, timeoutMs, 750);
    return summary ?? (await shopify.readCashier(page));
  },

  // UNVERIFIED — to confirm on the Shopify spike. Reads the order summary:
  // its text (the region labelled as the summary, else <aside>, else the
  // body), its line rows (role=row / tr inside it), and the ZIP the form
  // actually holds — read back, never echoed from the input, because the
  // payer's ZIP check is only worth something if it compares two sources.
  async readCashier(page) {
    const raw = await page.evaluate(() => {
      const region = document.querySelector('[aria-label*="order summary" i]') ||
        document.querySelector('[aria-labelledby*="summary" i]') || document.querySelector("aside") || document.body;
      const rows = [...region.querySelectorAll('[role="row"], tr')].map(r => r.innerText || "");
      const zip = document.querySelector('input[name="postalCode"], input[autocomplete="shipping postal-code"]');
      return { text: region.innerText || "", rows, zip: zip ? zip.value : "" };
    });
    return shopify.parseCashier(raw);
  },

  // Pure: the summary's text → {merchant_total, currency, subtotal,
  // shipping, tax, lines, ship_to_postal_code}. Every figure comes from its
  // LABELLED row. currency is the ISO code printed beside the total, or null:
  // "$" alone is also CAD, AUD, and a dozen others, and a currency nobody
  // read is the one the marketplace refuses.
  parseCashier({ text = "", rows = [], zip = "" } = {}) {
    const lines = String(text).split("\n").map(l => l.trim()).filter(Boolean);
    const at = key => { const row = labelledRow(lines, SUMMARY_LABELS[key]); return row === null ? null : row; };
    const money = key => { const row = at(key); return row === null ? null : parseMoney(row); };
    const totalRow = at("total");
    const shippingRow = at("shipping");
    const shipping = shippingRow !== null && /\bfree\b/i.test(shippingRow) && !hasMoney(shippingRow) ? 0 : money("shipping");
    const code = totalRow ? (totalRow.match(/\b([A-Z]{3})\b/) || [])[1] || null : null;
    return {
      merchant_total: totalRow === null ? null : parseMoney(totalRow),
      currency: code,
      subtotal: money("subtotal"),
      shipping,
      tax: money("tax"),
      lines: rows.map(parseSummaryLine).filter(Boolean),
      ship_to_postal_code: String(zip || "").trim(),
    };
  },

  // Pure: a read summary → the quote's breakdown, or null with the reason.
  // merchant_fees is what the total holds beyond items, shipping and tax
  // (duties, a handling fee) — named rather than dropped, so the breakdown
  // adds up. A NEGATIVE residual is a discount this code did not read, and
  // is refused rather than folded into a number.
  breakdown(summary) {
    const s = summary || {};
    for (const k of ["subtotal", "shipping", "merchant_total"]) {
      if (!isNum(s[k])) return { breakdown: null, reason: `order summary: no readable ${k}` };
    }
    const tax = isNum(s.tax) ? s.tax : 0;
    const round = n => Math.round(n * 100) / 100;
    const fees = round(s.merchant_total - s.subtotal - s.shipping - tax);
    if (fees < -CENT) return { breakdown: null, reason: `order summary: total is ${-fees} below its parts (an unread discount)` };
    return { breakdown: { items: s.subtotal, shipping: s.shipping, tax, merchant_fees: Math.max(0, fees), merchant_total: s.merchant_total }, reason: "" };
  },
};
