// The toy STORE — protocol 2 (quote + buy), offline, in one read.
//
// Same idea as example.com/recipe.mjs: every signal a real Shopify recipe
// speaks, with a pretend store instead of a browser. Run it with plain node,
// no keys, no network. A real recipe replaces the two `pretend*` values with
// the SDK's page helpers — shopify.product(page, ref) for the product
// document, shopify.addToCart / toCheckout / priceTo / fillShipping /
// readCashier for the checkout — and keeps everything else as it is here:
// the PURE half (pickVariant, menu, describe, parseCashier, breakdown) is
// exactly what runs in production.
//
//   TASK=quote RECIPE_INPUT='{"schema":"quote.v1","task":"quote","data":{"product":"shop",
//     "item":{"ref":"https://shop.example.com/products/classic-tee","selections":{"Size":"M","Color":"Black"},"quantity":2},
//     "context":{"ship_to":{"country":"US","region":"CA","postal_code":"94107"}}}}' node shop.example.com/recipe.mjs
//
//   (drop "selections" to see status "options_required"; ask for Size L to see "unavailable")
//
//   TASK=buy RECIPE_INPUT='{"schema":"buy.v1","task":"buy","data":{"product":"shop",
//     "item":{"ref":"https://shop.example.com/products/classic-tee","selections":{"Size":"M","Color":"Black"},"quantity":2},
//     "engaged":{"merchant_total":50.47,"currency":"USD"},
//     "fulfilment":{"recipient":{"given":"Ada","surname":"Lovelace","phone":"+14155550100"},
//       "address.shipping":{"line1":"2 Market St","city":"San Francisco","region":"CA","postal_code":"94107","country":"US"}},
//     "contact_email":"o-abc123@bookings.brij.fi"}}' node shop.example.com/recipe.mjs
//
// There is no CARD_* anywhere in this file, and there never is in a
// protocol-2 recipe: a buy is your WALK to the cashier, then the
// marketplace's payer takes the session and pays. Your recipe cannot pay.
import { L, drain, emitResult, emitPhase, makeBail, readInput, shopify, EXIT } from "../sdk/index.mjs";

const TASK = (process.env.TASK || "").toLowerCase();
const bail = makeBail({ cleanup: async () => L("(cleanup: a real recipe detaches from the session here)") });

// ── the job: ONE document (README §2.1) — readInput refuses anything else ──
let IN;
try { IN = readInput(TASK); } catch (e) { await bail(EXIT.badInput, "ABORT: " + e.message); }
if (TASK !== "quote" && TASK !== "buy") await bail(EXIT.badInput, `this recipe speaks quote and buy, not ${TASK}`);
if (IN.product !== "shop") await bail(EXIT.badInput, `product ${IN.product} is not one this recipe sells`);
const ITEM = IN.item || {};

// ── the pretend store ──
// Exactly the shape <origin>/products/<handle>.js serves: options as
// objects, variant prices in CENTS, a protocol-relative image. A real
// recipe gets this from `await shopify.product(page, ITEM.ref)`.
const pretendProduct = {
  id: 7001, title: "Classic Tee", handle: "classic-tee",
  options: [{ name: "Size", position: 1, values: ["S", "M", "L"] }, { name: "Color", position: 2, values: ["Black", "White"] }],
  featured_image: "//cdn.shopify.com/s/files/classic-tee.jpg",
  variants: [
    { id: 4241, title: "S / Black", option1: "S", option2: "Black", price: 1999, sku: "TEE-S-BLK", available: true },
    { id: 4242, title: "M / Black", option1: "M", option2: "Black", price: 1999, sku: "TEE-M-BLK", available: true },
    { id: 4243, title: "M / White", option1: "M", option2: "White", price: 1999, sku: "TEE-M-WHT", available: true },
    { id: 4244, title: "L / Black", option1: "L", option2: "Black", price: 2199, sku: "TEE-L-BLK", available: false },
    { id: 4245, title: "L / White", option1: "L", option2: "White", price: 2199, sku: "TEE-L-WHT", available: false },
  ],
};
// The checkout's order summary, as its innerText. A real recipe reads it
// with `await shopify.readCashier(page)` (or priceTo for a quote).
const pretendCheckout = (item, quantity, zip) => {
  const items = Math.round(item.unit_price * quantity * 100) / 100;
  const shipping = 6.99, tax = Math.round(items * 0.0875 * 100) / 100;
  const total = Math.round((items + shipping + tax) * 100) / 100;
  const $ = n => "$" + n.toFixed(2);
  return {
    text: ["Order summary", `${quantity}`, item.title, $(items), "Subtotal", $(items), "Shipping",
      "Standard (3-5 business days)", $(shipping), "Estimated taxes", $(tax), "Total", "USD", $(total)].join("\n"),
    rows: [`${quantity}\n${item.title}\n${$(items)}`],
    zip,
  };
};

// ── resolve the item: the variant the ref or the selections name ──
// Emitted as a quote outcome (quote) or a clean exit (buy) — never guessed.
emitPhase("product");
const product = shopify.parseProduct(JSON.stringify(pretendProduct), { origin: "https://shop.example.com", url: ITEM.ref });
if (shopify.handle(ITEM.ref) !== product.handle) {
  if (TASK === "quote") { emitResult("quote", { status: "unavailable", reason: "not_found" }); await drain(); process.exit(EXIT.ok); }
  await bail(EXIT.itemUnavailable, `no such product: ${ITEM.ref}`);
}
const byId = shopify.variantParam(ITEM.ref);
const variant = byId ? product.variants.find(v => String(v.id) === byId) || null : shopify.pickVariant(product, ITEM.selections || {});
if (!variant) {
  // Not one variant: the buyer must choose. Never pick the first for them.
  if (TASK === "quote") { emitResult("quote", { status: "options_required", menu: shopify.menu(product) }); await drain(); process.exit(EXIT.ok); }
  await bail(EXIT.badInput, "the selections do not name exactly one variant — a buy is only ever for what was quoted");
}
if (!variant.available) {
  if (TASK === "quote") { emitResult("quote", { status: "unavailable", reason: "out_of_stock" }); await drain(); process.exit(EXIT.ok); }
  await bail(EXIT.itemUnavailable, `${variant.title} is sold out`);
}
const item = { ...shopify.describe(product, variant), quantity: ITEM.quantity };
L(`item: ${item.title} × ${item.quantity} @ $${item.unit_price}`);

// ── TASK=quote: the CHECKOUT's price for this destination ──
if (TASK === "quote") {
  const shipTo = IN.context?.ship_to || {};
  if (shipTo.country !== "US") { emitResult("quote", { status: "unavailable", reason: "not_shippable" }); await drain(); process.exit(EXIT.ok); }
  emitPhase("checkout");
  // real: await shopify.addToCart(page, variant.id, item.quantity); await shopify.toCheckout(page);
  //       const summary = await shopify.priceTo(page, shipTo);
  const summary = shopify.parseCashier(pretendCheckout(item, item.quantity, shipTo.postal_code));
  const { breakdown, reason } = shopify.breakdown(summary);
  if (!breakdown) await bail(EXIT.checkoutFail, reason);
  if (summary.currency !== "USD") await bail(EXIT.checkoutFail, `checkout priced in ${summary.currency || "an unread currency"}`);
  // When the parcel will have arrived: the escrow hold is sized from it.
  // Honest and generous — a hold that ends with the parcel in the van
  // refunds a buyer who is about to receive it.
  const serviceEnds = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
  emitResult("quote", { status: "priced", item, breakdown, currency: summary.currency,
    shipping_method: "Standard (3-5 business days)", service_ends_at: serviceEnds, requires: ["recipient", "address.shipping"] });
  await drain();
  process.exit(EXIT.ok);
}

// ── TASK=buy: the WALK. Cart → checkout → shipping form → cashier → stop. ──
emitPhase("checkout");
// real: await shopify.addToCart(page, variant.id, item.quantity); await shopify.toCheckout(page);
emitPhase("shipping-form");
const plan = shopify.fieldPlan(IN.fulfilment || {}, IN.contact_email);
// real: const { missing } = await shopify.fillShipping(page, IN.fulfilment, IN.contact_email);
//       if (missing.includes("postalCode")) await bail(EXIT.fulfilmentRejected, "…");
L(`shipping form: ${plan.map(f => f.field).join(", ")} (the contact email is the order's address — principle 1)`);
emitPhase("cashier");
// real: const cashier = await shopify.readCashier(page);
const summary = shopify.parseCashier(pretendCheckout(item, item.quantity, IN.fulfilment?.["address.shipping"]?.postal_code));
const cashier = { merchant_total: summary.merchant_total, currency: summary.currency, lines: summary.lines, ship_to_postal_code: summary.ship_to_postal_code };
L(`cashier: ${cashier.currency} ${cashier.merchant_total} (engaged ${IN.engaged?.merchant_total}) — the payer compares them, not this recipe`);
// payReachable: you located Pay, present, enabled and uncovered. You do NOT
// click it: payClicked is always false in a walk. The payer takes it from here.
emitResult("buy", { payClicked: false, paymentStatus: "unverified", payReachable: true, cashier,
  reason: "walk complete — the payer takes the session" });
await drain();
process.exit(EXIT.ok);
