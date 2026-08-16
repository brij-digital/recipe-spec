// @brij/recipe-sdk v0 — the recipe CONTRACT as code.
//
// Everything a recipe says to the runtime goes through here: the machine
// signals (__FULFILLER_*), the exit codes, the screenshot evidence, and the
// two runtime gates (human approval, 3DS code). A recipe that uses this
// module cannot mis-implement the contract — the schema of the conversation
// is enforced by construction, and the conformance CI can trust the shape.
//
// v0 is a LIBRARY: it runs inside the recipe's process, so it adds zero
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
};

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

// ── signal emission — the ONLY way a recipe should talk to the runner ──
export const emitResult = obj => console.log(MARKERS.result + JSON.stringify(obj));
export const emitApproval = obj => console.log(MARKERS.approval + JSON.stringify(obj));
export const emit3DS = obj => console.log(MARKERS.threeDS + JSON.stringify(obj));
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
