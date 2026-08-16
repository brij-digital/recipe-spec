// @brij/recipe-sdk v1 — the recipe CONTRACT as code.
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

// ── the machine markers: one line on stdout, prefix + JSON, parsed by the runner ──
export const MARKERS = {
  result: "__FULFILLER_RESULT__",     // task outcome (search offers, fare menu, bookResult)
  approval: "__FULFILLER_APPROVAL__", // parked at the checkout, waiting for a verdict
  threeDS: "__FULFILLER_3DS__",       // waiting for an SCA code
  session: "__FULFILLER_SESSION__",   // reusable Browserbase session id
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
  malformed: 7,    // the recipe built a result that violates the schema — the SDK refused to emit it
};

// ── protocol version ──
// Stamped by the SDK into EVERY signal ({v, task, ...}); declared by the
// manifest as protocol_version. The runtime refuses a version it does not
// support and treats a v/manifest mismatch as a malformed signal.
export const PROTOCOL_VERSION = 1;

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
    });
    return errs;
  },
  "offer-details"(p) {
    const errs = [];
    if (!Array.isArray(p.fares)) { errs.push("fares must be an array"); return errs; }
    p.fares.forEach((f, i) => {
      if (!isNum(f.price) || f.price <= 0) errs.push(`fares[${i}]: price must be > 0`);
      if (f.conditions !== undefined && !Array.isArray(f.conditions)) errs.push(`fares[${i}]: conditions must be an array`);
    });
    return errs;
  },
  book(p) {
    const errs = [];
    if (typeof p.payClicked !== "boolean") errs.push("payClicked must be a boolean");
    if (!["paid", "failed", "unverified"].includes(p.paymentStatus)) errs.push("paymentStatus must be paid|failed|unverified");
    return errs;
  },
};

// ── signal emission — the ONLY way a recipe should talk to the runner ──
// emitResult(task, payload) VALIDATES, stamps {v, task} (the SDK imposes
// both — payload values are ignored), and refuses a malformed result with
// EXIT.malformed. Financial conservatism: a malformed BOOK result still
// emits a minimal well-formed line carrying payClicked first, so the
// runner never loses the one fact that decides refund vs uncertain.
export const emitResult = (task, payload) => {
  const validate = validators[task];
  if (!validate) { L(`emitResult: unknown task "${task}"`); process.exitCode = EXIT.malformed; return false; }
  const errs = validate(payload ?? {});
  if (errs.length) {
    errs.forEach(e => L("malformed result: " + e));
    if (task === "book") {
      console.log(MARKERS.result + JSON.stringify({
        v: PROTOCOL_VERSION, task, payClicked: payload?.payClicked === true,
        paymentStatus: "unverified", malformed: true,
      }));
    }
    process.exitCode = EXIT.malformed;
    return false;
  }
  console.log(MARKERS.result + JSON.stringify({ ...payload, v: PROTOCOL_VERSION, task }));
  return true;
};
export const emitApproval = obj => console.log(MARKERS.approval + JSON.stringify({ ...obj, v: PROTOCOL_VERSION, task: "approval" }));
export const emit3DS = obj => console.log(MARKERS.threeDS + JSON.stringify({ ...obj, v: PROTOCOL_VERSION, task: "3ds" }));
export const emitSession = id => { if (id) console.log(MARKERS.session + id); };

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

// ── clean exit ──
// makeBail({shot, cleanup}): narrate, capture the failure, run the recipe's cleanup (close the
// browser session…), FLUSH stdout, exit. shot is the recipe's cheap screenshot helper (may be a
// no-op on search); cleanup must never throw the bail off course — it is awaited inside a guard.
export const makeBail = ({ shot, cleanup } = {}) => async (code, msg, png) => {
  L(msg);
  if (png && shot) await shot(png);
  try { await cleanup?.(); } catch {}
  await drain();
  process.exit(code);
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
