// The toy RAILWAY — protocol 2, product rail (discover + quote + buy),
// offline, in one read.
//
// Same idea as shop.example.com/recipe.mjs: every signal a real rail recipe
// speaks, with a pretend timetable instead of a browser. Run it with plain
// node, no keys, no network. A real recipe replaces `pretendJourneys` with
// the supplier's results page (read over CDP — captureJSON on its own
// search API is the usual way) and the cashier with the page's basket.
//
//   TASK=discover RECIPE_INPUT='{"schema":"rail-search.v1","task":"discover","data":{
//     "product":"rail","origin":"Paris","destination":"Lyon","depart_date":"2026-12-15",
//     "depart_after":"08:00","adults":2}}' node rail.example.com/recipe.mjs
//
//   TASK=quote RECIPE_INPUT='{"schema":"quote.v1","task":"quote","data":{"product":"rail",
//     "item":{"ref":"rx:paris-lyon:2026-12-15T08:04","selections":{"fare":"Standard"},"quantity":1},
//     "context":{"adults":2,"search":{"origin":"Paris","destination":"Lyon","depart_date":"2026-12-15"}}}}' \
//     node rail.example.com/recipe.mjs
//
//   (drop "selections" to see status "options_required")
//
//   TASK=buy RECIPE_INPUT='{"schema":"buy.v1","task":"buy","data":{"product":"rail",
//     "item":{"ref":"rx:paris-lyon:2026-12-15T08:04","selections":{"fare":"Standard"},"quantity":1},
//     "engaged":{"merchant_total":91,"currency":"USD"},
//     "fulfilment":{"person":[{"given":"Ada","surname":"Lovelace","dob":"1990-12-10"},
//                             {"given":"Charles","surname":"Babbage","dob":"1991-12-26"}]},
//     "contact_email":"o-abc123@bookings.brij.fi"}}' node rail.example.com/recipe.mjs
//
// There is no CARD_* anywhere in this file, and there never is in a
// protocol-2 recipe: a buy is your WALK to the cashier, then the
// marketplace's payer (cashier: trainline) takes the session and pays.
import { L, drain, emitResult, emitPhase, makeBail, readInput, EXIT } from "../sdk/index.mjs";

const TASK = (process.env.TASK || "").toLowerCase();
const bail = makeBail({ cleanup: async () => L("(cleanup: a real recipe detaches from the session here)") });

// ── the job: ONE document (README §2.1) — readInput refuses anything else ──
let IN;
try { IN = readInput(TASK); } catch (e) { await bail(EXIT.badInput, "ABORT: " + e.message); }
if (!["discover", "quote", "buy"].includes(TASK)) await bail(EXIT.badInput, `this recipe speaks discover, quote and buy, not ${TASK}`);
if (IN.product !== "rail") await bail(EXIT.badInput, `product ${IN.product} is not one this recipe sells`);

// The question: discover carries it at the top level, quote carries it back
// in context.search — so the journey can be found again on a fresh session,
// where a supplier's own ids rarely survive. The contract does not promise a
// buy its context, so this toy's refs carry the route and date themselves
// (rx:<origin>-<destination>:<date>T<time>), and a buy's party is its persons.
const fromRef = ref => {
  const m = String(ref || "").match(/^rx:([a-z]+)-([a-z]+):(\d{4}-\d{2}-\d{2})T/);
  return m ? { origin: m[1], destination: m[2], depart_date: m[3] } : {};
};
const Q = TASK === "discover" ? IN : IN.context?.search || fromRef(IN.item?.ref);
const ADULTS = TASK === "discover" ? IN.adults : IN.context?.adults ?? (Array.isArray(IN.fulfilment?.person) ? IN.fulfilment.person.length : undefined);
if (!Q.origin || !Q.destination || !/^\d{4}-\d{2}-\d{2}$/.test(Q.depart_date || "")) await bail(EXIT.badInput, "origin, destination and depart_date are required");
if (!Number.isInteger(ADULTS) || ADULTS < 1 || ADULTS > 4) await bail(EXIT.badInput, `adults ${ADULTS} is outside this recipe's coverage (1..4)`);

// ── the pretend timetable ──
// Free-text places resolved to stations: yours to do, at your own door.
const STATIONS = { paris: "Paris Gare de Lyon", lyon: "Lyon Part-Dieu", london: "London Euston", manchester: "Manchester Piccadilly", madrid: "Madrid Atocha", barcelona: "Barcelona Sants" };
const station = s => STATIONS[String(s).trim().toLowerCase()] || null;
const FARES = [{ name: "Standard", per_adult: 45.5 }, { name: "Flex", per_adult: 79 }];
const pretendJourneys = (q) => {
  const from = station(q.origin), to = station(q.destination);
  if (!from || !to) return [];
  const slug = `${q.origin}-${q.destination}`.toLowerCase().replace(/[^a-z-]/g, "");
  return [["08:04", "10:02", 0, "SNCF"], ["09:00", "11:04", 0, "SNCF"], ["12:30", "15:15", 1, "SNCF"]].map(([dep, arr, changes, operator]) => {
    const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    return { ref: `rx:${slug}:${q.depart_date}T${dep}`, dep, arr, from, to, changes, operator, duration_min: mins(arr) - mins(dep) };
  }).filter(j => !q.depart_after || j.dep >= q.depart_after);
};
const cents = n => Math.round(n * 100) / 100;

// ── TASK=discover: the journeys, each priced from its cheapest fare for the WHOLE party ──
if (TASK === "discover") {
  emitPhase("results");
  const journeys = pretendJourneys(Q);
  const items = journeys.map(j => ({
    ref: j.ref,
    title: `${j.from} → ${j.to} ${j.dep}–${j.arr}`,
    price_from: cents(Math.min(...FARES.map(f => f.per_adult)) * ADULTS),
    currency: "USD",
    summary: { departs_at: `${Q.depart_date}T${j.dep}`, arrives_at: `${Q.depart_date}T${j.arr}`, origin: j.from, destination: j.to,
      changes: j.changes, duration_min: j.duration_min, operator: j.operator },
  }));
  // No trains is an answer (count 0), never an error.
  emitResult("discover", { count: items.length, items });
  await drain();
  process.exit(EXIT.ok);
}

// ── quote / buy: find the journey again, then the fare ──
emitPhase("journey");
const ITEM = IN.item || {};
const journey = pretendJourneys({ ...Q, depart_after: undefined }).find(j => j.ref === ITEM.ref) || null;
if (!journey) {
  if (TASK === "quote") { emitResult("quote", { status: "unavailable", reason: "not_found" }); await drain(); process.exit(EXIT.ok); }
  await bail(EXIT.itemUnavailable, `no such journey: ${ITEM.ref}`);
}
const fareName = ITEM.selections?.fare;
const fare = FARES.find(f => f.name.toLowerCase() === String(fareName || "").trim().toLowerCase()) || null;
if (!fare) {
  // Standard or Flex is the traveller's call, never the recipe's.
  if (TASK === "quote") { emitResult("quote", { status: "options_required", menu: [{ name: "fare", values: FARES.map(f => f.name) }] }); await drain(); process.exit(EXIT.ok); }
  await bail(EXIT.badInput, "no fare selected — a buy is only ever for what was quoted");
}
const title = `${journey.from} → ${journey.to} ${journey.dep}–${journey.arr}, ${ADULTS} adult${ADULTS > 1 ? "s" : ""}, ${fare.name}`;
const total = cents(fare.per_adult * ADULTS);

// ── TASK=quote: the CHECKOUT's price for the whole party ──
// One journey is one item (quantity 1); the party is in the price. Nothing
// ships, so shipping is 0; the operator's booking fee, if the basket shows
// one, is a merchant_fee — named, never folded into the fare.
if (TASK === "quote") {
  emitPhase("basket");
  emitResult("quote", {
    status: "priced",
    item: { ref: journey.ref, title, selections: { fare: fare.name }, quantity: 1, unit_price: total },
    breakdown: { items: total, shipping: 0, tax: 0, merchant_fees: 0, merchant_total: total },
    currency: "USD",
    // When the service is over: the journey's own day. The escrow hold is sized from it.
    service_ends_at: Q.depart_date,
    requires: ["person"],
  });
  await drain();
  process.exit(EXIT.ok);
}

// ── TASK=buy: the WALK. Journey → fare → travellers → cashier → stop. ──
const people = IN.fulfilment?.person;
if (!Array.isArray(people) || people.length !== ADULTS || !people.every(p => p?.given && p?.surname && p?.dob)) {
  await bail(EXIT.badInput, `fulfilment.person must hold ${ADULTS} traveller(s) with given, surname and dob`);
}
emitPhase("basket");
emitPhase("passenger-form");
// real: type each person into the form, lead first; the contact email is the
// order's own address (IN.contact_email) or the e-ticket never reaches settlement.
L(`travellers: ${people.length} (lead first); contact ${IN.contact_email ? "set" : "MISSING"}`);
emitPhase("cashier");
// real: read every figure off the basket — the Total from its labelled row.
// Untick nothing, tick nothing: seat reservations, insurance and "flexibility"
// upgrades are paid add-ons the payer refuses outright.
const cashier = { merchant_total: total, currency: "USD", lines: [{ title, quantity: 1, amount: total }] };
L(`cashier: ${cashier.currency} ${cashier.merchant_total} (engaged ${IN.engaged?.merchant_total}) — the payer compares them, not this recipe`);
emitResult("buy", { payClicked: false, paymentStatus: "unverified", payReachable: true, cashier,
  reason: "walk complete — the payer takes the session" });
await drain();
process.exit(EXIT.ok);
