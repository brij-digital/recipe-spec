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
  // The toys: the air one (protocol 1, three tasks), the store (protocol 2,
  // quote + buy) and the railway (protocol 2, discover + quote + buy) — each
  // must name schemas that exist.
  const refs = [];
  for (const [dir, min] of [["example.com", 3], ["shop.example.com", 2], ["rail.example.com", 3]]) {
    const manifest = fs.readFileSync(new URL(`./${dir}/manifest.yaml`, import.meta.url), "utf8");
    const capBlock = manifest.match(/^capabilities:[^\n]*\n((?:[ \t]+[^\n]*\n?)+)/m)?.[1] || "";
    const mine = []; let task = null;
    for (const line of capBlock.split("\n")) {
      const t = line.match(/^ {2}([A-Za-z-]+):/); if (t) { task = t[1]; continue; }
      const sch = line.match(/^\s+input_schema:\s*(\S+)/); if (sch && task) mine.push([task, sch[1]]);
    }
    assert(mine.length >= min, `${dir} manifest declares fewer than ${min} input_schema refs`);
    refs.push(...mine);
  }
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
  process.env.ACCOUNT_PASSWORD = "Br!zzTopSecretPassword99";
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
      `<i>tok_live_abcdef123456</i><b>Br!zzTopSecretPassword99</b><input name=surname value="Kowalczyk"><span>1988-04-17 ZS4471902 ` +
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
  // The ephemeral account's password: harmless while nothing injected it,
  // a real leak since conformance walks started holding one — and the case
  // file is read back by the recipe's AUTHOR.
  check("case: the ephemeral account password is redacted", !html.includes("Br!zzTopSecretPassword99"));
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

// ── protocol 2 (shop.v1) ──────────────────────────────────────────────────
// The corpus above already pins the quote/buy validators case by case. What
// it cannot pin: which `v` each task is stamped with, the minimal line a
// malformed BUY still emits (the refund-vs-uncertain fact), the schemas
// readInput accepts, the Shopify pure helpers, and the redaction of a
// parcel's destination.
import { TASK_PROTOCOL, PROTOCOL_VERSION, PROTOCOL_VERSION_V2, REQUIREMENT_SLOTS, readInput, shopify, validators as V } from "./sdk/index.mjs";
{
  check("v2: EXIT.itemUnavailable is offerGone (3)", EXIT.itemUnavailable === 3 && EXIT.offerGone === 3);
  check("v2: EXIT.fulfilmentRejected is paxRejected (6)", EXIT.fulfilmentRejected === 6 && EXIT.paxRejected === 6);
  check("v2: PROTOCOL_VERSION stays 1 for v1 recipes", PROTOCOL_VERSION === 1 && PROTOCOL_VERSION_V2 === 2);
  check("v2: tasks map to their protocol", TASK_PROTOCOL.book === 1 && TASK_PROTOCOL.search === 1 && TASK_PROTOCOL["offer-details"] === 1 && TASK_PROTOCOL.quote === 2 && TASK_PROTOCOL.buy === 2);
  check("v2: the requirement vocabulary is the contract's six slots",
    JSON.stringify(REQUIREMENT_SLOTS) === JSON.stringify(["person", "document", "recipient", "address.shipping", "contact.phone", "loyalty"]));

  // emitResult prints and sets process.exitCode, so it runs in a child.
  const emitChild = (task, payload) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { emitResult } from "${new URL("./sdk/index.mjs", import.meta.url).pathname}";
    emitResult(${JSON.stringify(task)}, ${JSON.stringify(payload)});
  `], { encoding: "utf8" });
  const lineOf = r => { const l = r.stdout.split("\n").find(x => x.startsWith(MARKERS.result)); return l ? JSON.parse(l.slice(MARKERS.result.length)) : null; };
  const q = lineOf(emitChild("quote", { status: "unavailable", reason: "out_of_stock", v: 9, task: "search" }));
  check("v2: quote is stamped v:2, task:quote (payload values ignored)", q?.v === 2 && q?.task === "quote");
  const b1 = lineOf(emitChild("book", { payClicked: false, paymentStatus: "failed" }));
  check("v2: book is still stamped v:1", b1?.v === 1 && b1?.task === "book");
  const bad = emitChild("buy", { payClicked: true, paymentStatus: "paid", payReachable: true /* no cashier */ });
  const minimal = lineOf(bad);
  check("v2: a malformed buy still emits the minimal line, payClicked first",
    minimal?.v === 2 && minimal?.task === "buy" && minimal?.payClicked === true && minimal?.paymentStatus === "unverified" && minimal?.malformed === true);
  check("v2: a malformed buy exits malformed (7)", bad.status === 7);
  const badQuote = emitChild("quote", { status: "priced" });
  check("v2: a malformed quote emits NO result line", lineOf(badQuote) === null && badQuote.status === 7);

  // readInput: the two new schemas, and still no cross-talk.
  const saved = process.env.RECIPE_INPUT;
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "quote.v1", task: "quote", data: { product: "shop" } });
  check("v2: readInput accepts quote.v1 for TASK=quote", readInput("quote").product === "shop");
  let threw = false; try { readInput("buy"); } catch { threw = true; }
  check("v2: readInput refuses quote.v1 for TASK=buy", threw);
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "buy.v1", task: "buy", data: { product: "shop" } });
  check("v2: readInput accepts buy.v1 for TASK=buy", readInput("buy").product === "shop");
  process.env.RECIPE_INPUT = saved;
}

// Shopify's product document, as /products/<handle>.js serves it.
const TEE = {
  id: 1, title: "Classic Tee", handle: "classic-tee", featured_image: "//cdn.shopify.com/tee.jpg",
  options: [{ name: "Size", position: 1, values: ["S", "M", "L"] }, { name: "Color", position: 2, values: ["Black", "White"] }],
  variants: [
    { id: 11, title: "S / Black", option1: "S", option2: "Black", price: 1999, sku: "S-B", available: true },
    { id: 12, title: "M / Black", option1: "M", option2: "Black", price: 1999, sku: "M-B", available: true, featured_image: { src: "//cdn.shopify.com/m-black.jpg" } },
    { id: 13, title: "M / White", option1: "M", option2: "White", price: 2050, sku: "", available: true },
    { id: 14, title: "L / Black", option1: "L", option2: "Black", price: 2199, available: false },
  ],
};
const MUG = { id: 2, title: "Mug", handle: "mug", options: [{ name: "Title", position: 1, values: ["Default Title"] }],
  variants: [{ id: 21, title: "Default Title", option1: "Default Title", price: 1200, available: true }] };
{
  const prod = shopify.parseProduct(JSON.stringify(TEE), { origin: "https://store.test", url: "https://store.test/products/classic-tee" });
  check("shopify: handle from a product URL", shopify.handle("https://store.test/products/classic-tee?variant=12") === "classic-tee");
  check("shopify: handle under a collection", shopify.handle("https://store.test/collections/tees/products/classic-tee") === "classic-tee");
  check("shopify: no handle on a non-product URL", shopify.handle("https://store.test/pages/about") === null);
  check("shopify: ?variant= names the variant", shopify.variantParam("https://store.test/products/classic-tee?variant=12") === "12");
  check("shopify: .json's {product} wrapper is unwrapped", shopify.parseProduct(JSON.stringify({ product: TEE })).handle === "classic-tee");
  let notJson = false; try { shopify.parseProduct("<html>404</html>"); } catch { notJson = true; }
  check("shopify: a page that is not the product document is an error, not an empty product", notJson);

  check("shopify: pickVariant on full selections", shopify.pickVariant(prod, { Size: "M", Color: "Black" })?.id === 12);
  check("shopify: pickVariant is case-insensitive and trimmed", shopify.pickVariant(prod, { " size": "m ", COLOR: "white" })?.id === 13);
  check("shopify: pickVariant is null when ambiguous (M in two colours)", shopify.pickVariant(prod, { Size: "M" }) === null);
  check("shopify: pickVariant resolves a partial selection that names one variant", shopify.pickVariant(prod, { Color: "White" })?.id === 13);
  check("shopify: pickVariant is null for a missing combination", shopify.pickVariant(prod, { Size: "S", Color: "White" }) === null);
  check("shopify: pickVariant is null for an option the product lacks", shopify.pickVariant(prod, { Size: "M", Material: "Cotton" }) === null);
  check("shopify: pickVariant with no selections on a multi-variant product is null", shopify.pickVariant(prod, {}) === null);
  check("shopify: a single-variant product needs no selections", shopify.pickVariant(MUG, {})?.id === 21 && shopify.pickVariant(MUG)?.id === 21);
  check("shopify: pickVariant returns a sold-out variant (the caller answers out_of_stock)", shopify.pickVariant(prod, { Size: "L", Color: "Black" })?.available === false);

  const menu = shopify.menu(prod);
  check("shopify: menu lists options in order with the store's values",
    JSON.stringify(menu.map(m => [m.name, m.values])) === JSON.stringify([["Size", ["S", "M", "L"]], ["Color", ["Black", "White"]]]));
  check("shopify: menu marks a value no available variant carries", JSON.stringify(menu[0].unavailable) === '["L"]' && menu[1].unavailable.length === 0);
  check("shopify: menu from bare-string options derives values from variants",
    JSON.stringify(shopify.menu({ ...TEE, options: ["Size", "Color"] })[1].values) === '["Black","White"]');
  check("shopify: a Default Title product has no menu", shopify.menu(MUG).length === 0);
  check("shopify: the menu validates as options_required", V.quote({ status: "options_required", menu }).length === 0);

  const d = shopify.describe(prod, prod.variants[1]);
  check("shopify: describe converts .js cents to dollars", d.unit_price === 19.99);
  check("shopify: describe names the variant in the ref", d.ref === "https://store.test/products/classic-tee?variant=12");
  check("shopify: describe carries title, selections and sku",
    d.title === "Classic Tee - M / Black" && JSON.stringify(d.selections) === '{"Size":"M","Color":"Black"}' && d.sku === "M-B");
  check("shopify: describe makes a protocol-relative image absolute", d.image_url === "https://cdn.shopify.com/m-black.jpg");
  check("shopify: describe omits an empty sku", !("sku" in shopify.describe(prod, prod.variants[2])));
  const m = shopify.describe(MUG, MUG.variants[0]);
  check("shopify: a Default Title product has no selections and a plain title", m.title === "Mug" && JSON.stringify(m.selections) === "{}" && m.unit_price === 12);
  check("shopify: .json's decimal-string price is dollars, not cents", shopify.parsePrice("19.99") === 19.99 && shopify.parsePrice(1999) === 19.99);

  check("shopify: cart permalink", shopify.cartPermalink("https://store.test/", 12, 2) === "https://store.test/cart/12:2");
  let refused = 0;
  for (const [id, qty] of [["12;x", 1], [12, 0], [12, 1.5]]) { try { shopify.cartPermalink("https://store.test", id, qty); } catch { refused++; } }
  check("shopify: permalink refuses a non-numeric id and a bad quantity", refused === 3);

  const plan = shopify.fieldPlan({ recipient: { given: "Ada", surname: "Lovelace", phone: "+14155550100" },
    "address.shipping": { line1: "2 Market St", city: "San Francisco", region: "CA", postal_code: "94107", country: "US" } }, "o-1@bookings.brij.fi");
  check("shopify: the field plan starts with the country (it re-renders the form)", plan[0].field === "countryCode" && plan[0].kind === "select");
  check("shopify: the field plan maps buy.v1 onto the checkout",
    ["email", "firstName", "lastName", "address1", "city", "zone", "postalCode", "phone"].every(f => plan.some(x => x.field === f)) &&
    plan.find(x => x.field === "email").value === "o-1@bookings.brij.fi" && plan.find(x => x.field === "zone").value === "CA");
  check("shopify: an absent line2 is not in the plan", !plan.some(x => x.field === "address2"));

  // The order summary, as innerText. The Total is read from its LABEL — the
  // compare-at price above it is larger and must not win.
  const summary = shopify.parseCashier({
    text: "Order summary\n2\nClassic Tee\nM / Black\n$59.99\n$39.98\nSubtotal · 2 items\n$39.98\nShipping\nStandard (3-5 business days)\n$6.99\nEstimated taxes\n$3.50\nTotal\nUSD\n$50.47\nIncluding $3.50 in taxes",
    rows: ["Product image\nDescription\nQuantity\nPrice", "2\nClassic Tee\nM / Black\n$39.98"],
    zip: " 94107 ",
  });
  check("shopify: total from the labelled Total row", summary.merchant_total === 50.47);
  check("shopify: currency is the code printed at the total", summary.currency === "USD");
  check("shopify: subtotal, shipping (not the 3 of '3-5 days') and tax", summary.subtotal === 39.98 && summary.shipping === 6.99 && summary.tax === 3.5);
  check("shopify: one line, header row skipped", summary.lines.length === 1 &&
    JSON.stringify(summary.lines[0]) === '{"title":"Classic Tee","quantity":2,"amount":39.98}');
  check("shopify: the ZIP is read back from the form", summary.ship_to_postal_code === "94107");
  check("shopify: '$' with no code is an UNREAD currency, not USD",
    shopify.parseCashier({ text: "Total\n$50.47" }).currency === null);
  check("shopify: free shipping reads as 0", shopify.parseCashier({ text: "Shipping\nFree\nTotal\nUSD $10.00" }).shipping === 0);
  check("shopify: a line with no readable quantity keeps null, never 1",
    shopify.parseSummaryLine("Classic Tee\n$19.99").quantity === null);
  check("shopify: a 'Quantity' label is read", shopify.parseSummaryLine("Quantity\n3\nClassic Tee\n$59.97").quantity === 3);

  const { breakdown } = shopify.breakdown(summary);
  check("shopify: the breakdown adds up from the summary",
    JSON.stringify(breakdown) === '{"items":39.98,"shipping":6.99,"tax":3.5,"merchant_fees":0,"merchant_total":50.47}');
  check("shopify: a residual is named as merchant_fees",
    shopify.breakdown({ subtotal: 10, shipping: 5, tax: 1, merchant_total: 18.5 }).breakdown.merchant_fees === 2.5);
  check("shopify: an unread discount refuses the breakdown",
    shopify.breakdown({ subtotal: 10, shipping: 5, tax: 1, merchant_total: 12 }).breakdown === null);
  check("shopify: no shipping figure refuses the breakdown",
    shopify.breakdown({ subtotal: 10, shipping: null, tax: 1, merchant_total: 11 }).breakdown === null);

  // End to end, pure: describe + summary → a quote the validator accepts,
  // and the cashier → a buy the validator accepts.
  const item = { ...d, quantity: 2 };
  check("shopify: describe + breakdown make a valid priced quote", V.quote({ status: "priced", item, breakdown, currency: summary.currency,
    service_ends_at: "2026-10-21", requires: ["recipient", "address.shipping"] }).length === 0);
  const cashier = { merchant_total: summary.merchant_total, currency: summary.currency, lines: summary.lines, ship_to_postal_code: summary.ship_to_postal_code };
  check("shopify: the read cashier makes a valid buy walk", V.buy({ payClicked: false, paymentStatus: "unverified", payReachable: true, cashier }).length === 0);

  // The page half, against a fake page: product() NAVIGATES to the .js
  // document (the browser's network, bounded by allowedDomains) — it never
  // fetches — and addToCart navigates to the permalink on the page's origin.
  const visits = [];
  const fakePage = { goto: async u => { visits.push(u); }, evaluate: async () => JSON.stringify(TEE), url: async () => "https://store.test/products/classic-tee" };
  const got = await shopify.product(fakePage, "https://store.test/products/classic-tee?variant=12");
  check("shopify: product() navigates to <origin>/products/<handle>.js", visits[0] === "https://store.test/products/classic-tee.js");
  check("shopify: product() returns the parsed document with its origin", got.variants.length === 4 && got.origin === "https://store.test");
  await shopify.addToCart(fakePage, 12, 2);
  check("shopify: addToCart navigates to the permalink on the page's origin", visits[1] === "https://store.test/cart/12:2");
}

// A parcel's destination is identity too. buy.v1 carries the recipient and
// the street: both must be gone from a case file, while region, ZIP and
// country — what a debugger needs to see which shipping rule fired — stay.
{
  const dir = mkdtempSync(`${tmpdir()}/case-buy-`);
  const cwd = process.cwd();
  process.chdir(dir);
  for (const k of ["CARD_NUMBER", "LLM_RUN_TOKEN", "ACCOUNT_PASSWORD"]) delete process.env[k];
  process.env.TASK = "buy";
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "buy.v1", task: "buy", data: {
    product: "shop", item: { ref: "https://store.test/products/classic-tee?variant=12", quantity: 2 },
    engaged: { merchant_total: 50.47, currency: "USD" },
    fulfilment: { recipient: { given: "Augusta", surname: "Lovelace", phone: "+14155550100" },
      "address.shipping": { line1: "2 Market Street", line2: "Apt 4B", city: "San Francisco", region: "CA", postal_code: "94107", country: "US" } },
    contact_email: "o-77@bookings.brij.fi" } });
  const page = { url: async () => "https://store.test/checkouts/cn/x", evaluate: async () =>
    `<input name="firstName" value="Augusta"><input name="lastName" value="Lovelace"><input name="address1" value="2 Market Street">` +
    `<input name="address2" value="Apt 4B"><input name="city" value="San Francisco"><select name="zone"><option value="CA" selected>California</option></select>` +
    `<input name="postalCode" value="94107"><input name="phone" value="+14155550100"><input name="email" value="o-77@bookings.brij.fi"><b>US</b>` };
  await dumpCase(() => page, { exit: 6 });
  const html = gunzipSync(readFileSync("case.html.gz")).toString();
  for (const pii of ["Augusta", "Lovelace", "+14155550100", "2 Market Street", "Apt 4B", "San Francisco", "o-77@bookings.brij.fi"]) {
    check(`case(buy): ${pii.slice(0, 8)}… is redacted`, !html.includes(pii));
  }
  check("case(buy): region, ZIP and country survive", html.includes('value="CA"') && html.includes('value="94107"') && html.includes("<b>US</b>"));
  check("case(buy): the form's structure survives", html.includes('name="address1"') && html.includes('name="postalCode"'));
  process.chdir(cwd);
}
console.log(`SDK unit total (with protocol 2): ${unit - unitFailed}/${unit} passed`);
if (unitFailed) process.exit(1);

// ── protocol 2, rail (CONTRACT-rail) ──────────────────────────────────────
// The corpus pins the discover validator and the relaxed cashier. What it
// cannot: the stamp, the input schema readInput maps to discover, that
// discover attaches no Stagehand by default, that a buy's persons leave no
// trace in a case file, and that the toy railway speaks all of it.
import { connectRuntimeBrowser } from "./sdk/index.mjs";
{
  check("rail: discover is a protocol-2 task", TASK_PROTOCOL.discover === 2 && TASK_PROTOCOL.search === 1);
  const emitChild = (task, payload) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { emitResult } from "${new URL("./sdk/index.mjs", import.meta.url).pathname}";
    emitResult(${JSON.stringify(task)}, ${JSON.stringify(payload)});
  `], { encoding: "utf8" });
  const lineOf = r => { const l = r.stdout.split("\n").find(x => x.startsWith(MARKERS.result)); return l ? JSON.parse(l.slice(MARKERS.result.length)) : null; };
  const d = lineOf(emitChild("discover", { count: 0, items: [], v: 1, task: "search" }));
  check("rail: discover is stamped v:2, task:discover (payload values ignored)", d?.v === 2 && d?.task === "discover");
  const badD = emitChild("discover", { count: 1, items: [{ ref: "x", title: "t", price_from: 10, currency: "EUR" }] });
  check("rail: a malformed discover emits NO result line and exits 7", lineOf(badD) === null && badD.status === 7);

  const saved = process.env.RECIPE_INPUT;
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "rail-search.v1", task: "discover", data: { product: "rail", origin: "Paris", destination: "Lyon", depart_date: "2026-12-15", adults: 1 } });
  check("rail: readInput accepts rail-search.v1 for TASK=discover", readInput("discover").origin === "Paris");
  let threw = false; try { readInput("search"); } catch { threw = true; }
  check("rail: readInput refuses rail-search.v1 for TASK=search", threw);
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "air-search.v1", task: "search", data: {} });
  threw = false; try { readInput("discover"); } catch { threw = true; }
  check("rail: readInput refuses air-search.v1 for TASK=discover", threw);
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "quote.v1", task: "quote", data: { product: "rail", item: { ref: "r", quantity: 1 },
    context: { adults: 2, search: { origin: "Paris", destination: "Lyon", depart_date: "2026-12-15" } } } });
  check("rail: readInput accepts a rail quote.v1", readInput("quote").context.adults === 2);
  process.env.RECIPE_INPUT = saved;

  // discover reads a results page over CDP, like search: no extension asked.
  const env = { u: process.env.BB_CONNECT_URL, e: process.env.BB_EXTENSION_ID };
  process.env.BB_CONNECT_URL = "wss://connect.test/x"; delete process.env.BB_EXTENSION_ID;
  const sess = await connectRuntimeBrowser({ task: "discover" }).catch(e => ({ error: e.message }));
  check("rail: discover defaults to no Stagehand (like search)", sess.browser === null && sess.connectUrl === "wss://connect.test/x");
  let refusedBuy = false; try { await connectRuntimeBrowser({ task: "buy" }); } catch { refusedBuy = true; }
  check("rail: buy still needs the extension by default", refusedBuy);
  if (env.u === undefined) delete process.env.BB_CONNECT_URL; else process.env.BB_CONNECT_URL = env.u;
  if (env.e !== undefined) process.env.BB_EXTENSION_ID = env.e;

  const railCashier = { merchant_total: 91, currency: "USD", lines: [{ title: "Paris → Lyon, 2 adults", quantity: 1, amount: 91 }] };
  check("rail: a cashier with no ZIP is a valid buy walk", V.buy({ payClicked: false, paymentStatus: "unverified", payReachable: true, cashier: railCashier }).length === 0);
  check("rail: a ZIP present but not a string is refused", V.buy({ payClicked: false, paymentStatus: "unverified", payReachable: true, cashier: { ...railCashier, ship_to_postal_code: 94107 } }).length === 1);
}
// A train's travellers are identity, exactly like a flight's passengers.
{
  const dir = mkdtempSync(`${tmpdir()}/case-rail-`);
  const cwd = process.cwd();
  process.chdir(dir);
  process.env.TASK = "buy";
  process.env.RECIPE_INPUT = JSON.stringify({ schema: "buy.v1", task: "buy", data: {
    product: "rail", item: { ref: "rx:paris-lyon:2026-12-15T08:04", selections: { fare: "Standard" }, quantity: 1 },
    engaged: { merchant_total: 91, currency: "USD" },
    fulfilment: { person: [{ given: "Augusta", surname: "Lovelace", dob: "1990-12-10" }, { given: "Charles", surname: "Babbage", dob: "1991-12-26" }] },
    contact_email: "o-88@bookings.brij.fi" } });
  const page = { url: async () => "https://rail.test/book/passengers", evaluate: async () =>
    `<input name="first-0" value="Augusta"><input name="last-0" value="Lovelace"><input name="dob-0" value="1990-12-10">` +
    `<input name="first-1" value="Charles"><input name="last-1" value="Babbage"><input name="dob-1" value="1991-12-26">` +
    `<input name="email" value="o-88@bookings.brij.fi"><p>Paris → Lyon Standard</p>` };
  await dumpCase(() => page, { exit: 6 });
  const html = gunzipSync(readFileSync("case.html.gz")).toString();
  for (const pii of ["Augusta", "Lovelace", "1990-12-10", "Charles", "Babbage", "1991-12-26", "o-88@bookings.brij.fi"]) {
    check(`case(rail): ${pii.slice(0, 8)}… is redacted`, !html.includes(pii));
  }
  check("case(rail): the journey and the form's structure survive", html.includes("Paris → Lyon Standard") && html.includes('name="dob-1"'));
  process.chdir(cwd);
}
// The toy railway, end to end: every result it emits is one the validators accept.
{
  const run = (task, schema, data) => spawnSync(process.execPath, [new URL("./rail.example.com/recipe.mjs", import.meta.url).pathname], {
    encoding: "utf8", env: { ...process.env, TASK: task, RECIPE_INPUT: JSON.stringify({ schema, task, data }) } });
  const result = r => { const l = r.stdout.split("\n").find(x => x.startsWith(MARKERS.result)); return l ? JSON.parse(l.slice(MARKERS.result.length)) : null; };
  const search = { origin: "Paris", destination: "Lyon", depart_date: "2026-12-15" };
  const dr = run("discover", "rail-search.v1", { product: "rail", ...search, depart_after: "08:00", adults: 2 });
  const disc = result(dr);
  check("rail toy: discover exits 0 with journeys priced for the party", dr.status === 0 && disc?.count === 3 && disc.items[0].price_from === 91);
  const none = result(run("discover", "rail-search.v1", { product: "rail", origin: "Paris", destination: "Atlantis", depart_date: "2026-12-15", adults: 1 }));
  check("rail toy: no trains is an empty, valid answer", none?.count === 0 && none.items.length === 0);
  const ref = disc?.items[0].ref;
  const qr = result(run("quote", "quote.v1", { product: "rail", item: { ref, selections: { fare: "Standard" }, quantity: 1 }, context: { adults: 2, search } }));
  check("rail toy: quote is priced for the party and requires person", qr?.status === "priced" && qr.breakdown.merchant_total === 91 && qr.requires.includes("person"));
  const menu = result(run("quote", "quote.v1", { product: "rail", item: { ref, quantity: 1 }, context: { adults: 2, search } }));
  check("rail toy: no fare chosen is options_required", menu?.status === "options_required" && menu.menu[0].name === "fare");
  const br = run("buy", "buy.v1", { product: "rail", item: { ref, selections: { fare: "Standard" }, quantity: 1 },
    engaged: { merchant_total: 91, currency: "USD" }, contact_email: "o-1@bookings.brij.fi",
    fulfilment: { person: [{ given: "Ada", surname: "Lovelace", dob: "1990-12-10" }, { given: "Charles", surname: "Babbage", dob: "1991-12-26" }] } });
  const buy = result(br);
  check("rail toy: buy walks to a cashier with no ZIP, and never clicks Pay",
    br.status === 0 && buy?.payReachable === true && buy.payClicked === false && buy.cashier.merchant_total === 91 && !("ship_to_postal_code" in buy.cashier));
}
console.log(`SDK unit total (with rail): ${unit - unitFailed}/${unit} passed`);
if (unitFailed) process.exit(1);
