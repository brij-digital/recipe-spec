// Offline conformance test — runnable by any author with plain node:
//   node test-sdk.mjs
// Replays fixtures/corpus.json against the SDK validators. The marketplace
// runner replays the SAME corpus in Go; CI verifies both implementations
// agree on this published corpus (which is what "no divergence" means —
// agreement on the corpus, not a proof over all inputs).
import { validators } from "./sdk/index.mjs";
import fs from "fs";

const corpus = JSON.parse(fs.readFileSync(new URL("./fixtures/corpus.json", import.meta.url)));
let failed = 0;
for (const c of corpus.cases) {
  const errs = validators[c.task](c.payload);
  const ok = (errs.length === 0) === c.valid;
  console.log(`${ok ? "✓" : "✗"} ${c.name}${ok ? "" : ` — expected valid=${c.valid}, got errors: ${errs.join("; ") || "none"}`}`);
  if (!ok) failed++;
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("ALL PASS");

// ── manifest ↔ input-contract consistency ──
// Every capabilities entry must reference a schema that EXISTS in
// schemas/input/ and whose declared task matches the manifest key.
{
  const fs = await import("node:fs");
  const assert = (cond, msg) => { if (!cond) { console.log("manifest↔schema FAILED: " + msg); process.exit(1); } };
  const manifest = fs.readFileSync(new URL("./example.com/manifest.yaml", import.meta.url), "utf8");
  const capBlock = manifest.match(/^capabilities:[^\n]*\n((?:[ \t]+[^\n]*\n?)+)/m)?.[1] || "";
  const refs = []; let task = null;
  for (const line of capBlock.split("\n")) {
    const t = line.match(/^ {2}([A-Za-z-]+):/); if (t) { task = t[1]; continue; }
    const sch = line.match(/^\s+input_schema:\s*(\S+)/); if (sch && task) refs.push([task, sch[1]]);
  }
  assert(refs.length >= 3, "example manifest declares no input_schema refs");
  for (const [t, name] of refs) {
    const path = new URL(`./schemas/input/${name}.yaml`, import.meta.url);
    assert(fs.existsSync(path), `schemas/input/${name}.yaml missing (referenced by ${t})`);
    const doc = fs.readFileSync(path, "utf8");
    assert(new RegExp(`^schema: ${name}$`, "m").test(doc), `${name}.yaml: schema field mismatch`);
    assert(new RegExp(`^task: ${t}$`, "m").test(doc), `${name}.yaml declares a different task than '${t}'`);
  }
  console.log(`manifest↔schema: ${refs.length} references verified`);
}

// ── unit tests for the shared code that runs with a card in the process ──
// submit3DSCode and makeBail are the two SDK functions whose bugs cost money,
// and both were exercised only through a browser. A fake CDP is enough: what
// matters is which frame is chosen, what is typed, and what is reported.
import { submit3DSCode, makeBail } from "./sdk/index.mjs";

const fakeFrame = (url, { input = null, button = null } = {}) => {
  const state = { filled: null, clicked: false, pressed: false };
  return {
    state,
    url: () => url,
    evaluate: async fn => {
      const src = String(fn);
      if (src.includes("data-otp-target")) return !!input;
      if (src.includes("data-otp-submit")) return !!button;
      return false;
    },
    fill: async (_sel, value) => { state.filled = value; },
    click: async () => { state.clicked = true; },
    press: async () => { state.pressed = true; },
  };
};
const fakeCdp = frames => ({ contexts: () => [{ pages: () => [{ frames: () => frames }] }] });

let unit = 0, unitFailed = 0;
const check = (name, ok) => { unit++; if (!ok) { unitFailed++; console.log(`✗ ${name}`); } else console.log(`✓ ${name}`); };

{ // the code goes into the frame that has the input, and Confirm is clicked
  const noInput = fakeFrame("https://acs.issuer.test/step", {});
  const challenge = fakeFrame("https://cardinal.test/stepup", { input: true, button: true });
  const ok = await submit3DSCode({ cdp: fakeCdp([noInput, challenge]), code: "483920", attempts: 1, log: () => {} });
  check("3DS: types into the frame that has the field", challenge.state.filled === "483920");
  check("3DS: clicks Confirm", challenge.state.clicked === true);
  check("3DS: reports success when no detection is supplied", ok === true);
}
{ // no button → Enter, rather than silently doing nothing
  const challenge = fakeFrame("https://cardinal.test/stepup", { input: true, button: false });
  await submit3DSCode({ cdp: fakeCdp([challenge]), code: "111111", attempts: 1, log: () => {} });
  check("3DS: falls back to Enter when the frame has no submit button", challenge.state.pressed === true);
}
{ // the recipe's own detection decides, not the fill
  const challenge = fakeFrame("https://cardinal.test/stepup", { input: true, button: true });
  const stuck = await submit3DSCode({ cdp: fakeCdp([challenge]), code: "000000", attempts: 2,
    stillChallenged: async () => true, log: () => {} });
  check("3DS: a code that never clears the challenge is a failure", stuck === false);
}
{ // no frame carries a code field at all
  const ok = await submit3DSCode({ cdp: fakeCdp([fakeFrame("https://trip.test/pay", {})]), code: "1", attempts: 1, log: () => {} });
  check("3DS: no reachable input is a failure, not a success", ok === false);
}

// makeBail exits the process, so its two outcomes are checked in a child.
// This is the money-losing case: after the Pay click, a "clean failure" is
// what makes the marketplace refund a customer whose card is charged.
import { spawnSync } from "node:child_process";
const bailChild = paid => spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { makeBail } from "${new URL("./sdk/index.mjs", import.meta.url).pathname}";
  const bail = makeBail({ committed: () => ${paid}, onCommitted: () => console.log("EMITTED") });
  await bail(3, "3-D Secure: no code provided");
`], { encoding: "utf8" });

{
  const after = bailChild(true);
  check("bail: post-Pay exits uncertain (7), not the clean code", after.status === 7);
  check("bail: post-Pay emits the outcome so the runtime sees the click", after.stdout.includes("EMITTED"));
  const before = bailChild(false);
  check("bail: pre-Pay keeps the code the recipe asked for", before.status === 3);
  check("bail: pre-Pay emits nothing", !before.stdout.includes("EMITTED"));
}
console.log(`SDK unit total: ${unit - unitFailed}/${unit} passed`);
if (unitFailed) process.exit(1);

// waitVerification's parser: one line, three verdicts, and anything else is
// "not a verdict yet" — a half-written file must never be read as one.
import { parseVerification, EXIT, MARKERS } from "./sdk/index.mjs";
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("verification: CODE", eq(parseVerification("CODE 483920"), { kind: "code", value: "483920" }));
  check("verification: URL https", eq(parseVerification("URL https://www.ryanair.com/verify?t=abc"), { kind: "url", value: "https://www.ryanair.com/verify?t=abc" }));
  check("verification: REJECT is null", parseVerification("REJECT") === null);
  check("verification: http URL is not a verdict", parseVerification("URL http://evil/") === undefined);
  check("verification: empty file is not a verdict", parseVerification("") === undefined);
  check("verification: partial line is not a verdict", parseVerification("COD") === undefined);
  check("verification: code with spaces is not a verdict", parseVerification("CODE 12 34") === undefined);
  check("EXIT.accountRequired is 8", EXIT.accountRequired === 8);
  check("verification marker", MARKERS.verification === "__FULFILLER_VERIFICATION__");
}
console.log(`SDK unit total (with verification): ${unit - unitFailed}/${unit} passed`);
if (unitFailed) process.exit(1);

// The case file: what a bail leaves for whoever debugs it next. Two
// properties are worth a test — the card must not survive into a file kept
// for a week, and a bail must produce the dump without the recipe asking,
// since a recipe that had to remember would eventually not.
import { dumpCase, recordPayload, makeShot } from "./sdk/index.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
{
  const dir = mkdtempSync(`${tmpdir()}/case-`);
  const cwd = process.cwd();
  process.chdir(dir);
  process.env.CARD_NUMBER = "4111111111111111";
  process.env.LLM_RUN_TOKEN = "tok_live_abcdef123456";
  process.env.TASK = "book";
  // The job this run was given: the traveller in it is what a real booking's
  // passenger form puts in the DOM.
  process.env.RECIPE_INPUT = JSON.stringify({
    schema: "air-book.v1", task: "book",
    data: {
      origin_iata: "MAD", destination_iata: "LIS", depart_date: "2026-09-22", flight: "IB3106",
      passengers: [{ given: "Amelia", surname: "Kowalczyk", dob: "1988-04-17", gender: "F", nationality: "PL", idnum: "ZS4471902" }],
      contact_email: "o-42@bookings.brij.fi", contact_phone: "+351912345678",
    },
  });
  recordPayload("https://supplier.test/FareOptions", { fares: [{ price: 1 }] });
  // Shaped like wrapPage's ADAPTER, which is what both live recipes drive:
  // `url` is ASYNC and there is no `content` — the real page hangs off `raw`.
  // The first version read `.url()` without awaiting and `.content()` without
  // checking, so the first production case file carried a serialized Promise
  // for its url and NO DOM at all (trip.com, 2026-09-02). A page shape
  // invented for a test proved nothing; this one is the shape that ships.
  const realPage = {
    url: () => "https://supplier.test/checkout",
    content: async () => `<input type="password" value="hunter2"><b>4111111111111111</b>` +
      `<i>tok_live_abcdef123456</i><input name=surname value="Kowalczyk"><span>1988-04-17 ZS4471902 ` +
      `o-42@bookings.brij.fi +351912345678</span><p>F PL IB3106 MAD</p>`,
  };
  const page = { url: async () => realPage.url(), evaluate: async () => "<html>unused</html>", raw: realPage };
  const written = await dumpCase(() => page, { exit: 4, message: "fare menu not captured" });
  check("case: the three files are written", written.length === 3);
  const state = JSON.parse(readFileSync("case.state.json", "utf8"));
  check("case: state names the url and the bail", state.url === "https://supplier.test/checkout" && state.exit === 4);
  check("case: the url is a string, never an unawaited promise", typeof state.url === "string");
  const html = gunzipSync(readFileSync("case.html.gz")).toString();
  check("case: the card never reaches the file", !html.includes("4111111111111111"));
  check("case: a password input keeps no value", !html.includes("hunter2"));
  // A real booking's case file holds the passenger form. The runtime knows
  // exactly which strings it sent, so they go by VALUE — no pattern hunting.
  for (const pii of ["Kowalczyk", "1988-04-17", "ZS4471902", "o-42@bookings.brij.fi", "+351912345678"]) {
    check(`case: the traveller's ${pii.slice(0, 6)}… is redacted`, !html.includes(pii));
  }
  check("case: a live run token is redacted", !html.includes("tok_live_abcdef123456"));
  // …and the page is still a usable fixture: what is NOT identity survives,
  // including the two-letter codes a value-based redaction must not eat.
  check("case: the DOM structure survives redaction", html.includes("<input name=surname") && html.includes("IB3106") && html.includes("F PL"));
  const payloads = JSON.parse(gunzipSync(readFileSync("case.payloads.json.gz")).toString());
  check("case: the supplier payload is the fixture", JSON.parse(payloads[0].body).fares.length === 1);
  // makeShot carries its page so makeBail can dump without a second argument
  // in every recipe — the coverage rests on that, not on authors remembering.
  check("case: the shot helper exposes its page to bail", typeof makeShot(() => page).getPage === "function");
  // A page with neither `raw` nor `content` still yields its DOM: `evaluate`
  // is on every surface the page-surface contract covers.
  const evaluateOnly = { url: async () => "https://supplier.test/x", evaluate: async () => "<html>EVAL</html>" };
  await dumpCase(() => evaluateOnly, { exit: 1 });
  check("case: the DOM is read through evaluate when there is no content()",
    gunzipSync(readFileSync("case.html.gz")).toString() === "<html>EVAL</html>");
  process.chdir(cwd);
  check("case: nothing was written outside the run's directory", !existsSync("case.state.json"));
}
console.log(`SDK unit total (with case files): ${unit - unitFailed}/${unit} passed`);
if (unitFailed) process.exit(1);
