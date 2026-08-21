// The toy recipe — the whole contract, offline, in one read.
//
// This file speaks every signal a real recipe speaks, with a pretend
// supplier instead of a browser: run it with plain node, no keys, no
// network, and watch the conversation your recipe is expected to have
// with the runtime. A real recipe replaces `pretendSupplier` with actual
// browsing (Stagehand/Playwright on the runtime-provided session); the
// contract around it — env in, signals out, exit codes — stays exactly this.
//
//   TASK=search RECIPE_INPUT='{"schema":"air-search.v1","task":"search","data":{
//     "origin_iata":"IBZ","destination_iata":"MAD","depart_date":"2026-12-03"}}' node example.com/recipe.mjs
//
//   TASK=offer-details RECIPE_INPUT='{"schema":"air-offer-details.v1","task":"offer-details","data":{
//     "origin_iata":"IBZ","destination_iata":"MAD","depart_date":"2026-12-03",
//     "flight":"2026-12-03T09:05|2026-12-03T10:20|EX"}}' node example.com/recipe.mjs
//
//   TASK=book RECIPE_INPUT='{"schema":"air-book.v1","task":"book","data":{
//     "origin_iata":"IBZ","destination_iata":"MAD","depart_date":"2026-12-03",
//     "flight":"2026-12-03T09:05|2026-12-03T10:20|EX",
//     "passengers":[{"given":"Jean","surname":"Martin","dob":"1979-10-25"}],
//     "contact_email":"o-abc123@bookings.brij.fi"}}' node example.com/recipe.mjs
//
//   Add CARD_NUMBER=... CARD_EXPIRATION=MM/YY CARD_CVV=... APPROVE_SIGNAL_FILE=/tmp/verdict
//   then: echo APPROVE > /tmp/verdict — the runtime's verdict, written by hand.
import { L, sleep, drain, emitResult, emitApproval, emit3DS, emitSession, emitPhase,
  makeBail, waitApproval, waitOTP, EXIT } from "../sdk/index.mjs";

// ── the job: ONE document, no fallback (§2.1 of the README) ──
// The environment says how to run; RECIPE_INPUT says what to do. Notice there
// is no `||default` on a single field below: a value the runtime did not send
// is a refusal, because a default here is this recipe deciding what to book.
const TASK=(process.env.TASK||"book").toLowerCase();
const IN=(()=>{
  const raw=process.env.RECIPE_INPUT;
  if(!raw){ L("ABORT: RECIPE_INPUT is required — this recipe has no environment fallback"); process.exit(EXIT.badInput); }
  let doc; try{ doc=JSON.parse(raw); }catch(e){ L("ABORT: RECIPE_INPUT is not JSON: "+e.message); process.exit(EXIT.badInput); }
  const want={ search:"air-search.v1", "offer-details":"air-offer-details.v1", book:"air-book.v1" }[TASK];
  if(!want){ L(`ABORT: unknown TASK ${TASK}`); process.exit(EXIT.badInput); }
  if(doc.schema!==want){ L(`ABORT: RECIPE_INPUT declares ${doc.schema}, TASK=${TASK} speaks ${want}`); process.exit(EXIT.badInput); }
  return doc.data||{};
})();
// Canonical in, supplier dialect out: the document is ISO + upper-case IATA,
// and this pretend supplier happens to want a compact date, so convert here.
const DCITY=String(IN.origin_iata||"").toLowerCase(), ACITY=String(IN.destination_iata||"").toLowerCase();
const DDATE=String(IN.depart_date||"").replace(/-/g,"");
const FLIGHT=IN.flight||"";
const FARE_PRICE=Number(IN.fare_price||0);
const CONTACT_EMAIL=IN.contact_email||"";   // the ORACLE address — give the supplier exactly this
const PAX=(IN.passengers||[])[0]||null;     // position 0 is the lead
// The only fact about spending this recipe is given: a card AND a gate to
// ask. Not a mode — a mode is a promise; this is a capability.
const APPROVE_SIGNAL_FILE=process.env.APPROVE_SIGNAL_FILE||"";
const HAS_CARD=!!(process.env.CARD_NUMBER&&process.env.CARD_EXPIRATION&&process.env.CARD_CVV);
const CAN_PAY=HAS_CARD&&!!APPROVE_SIGNAL_FILE;

// bail: narrate, clean up, flush stdout, exit with a contract code. A real
// recipe closes its browser session in the cleanup hook.
const bail=makeBail({ cleanup:async()=>L("(cleanup: a real recipe closes its browser here)") });

// ── the pretend supplier: three firm offers, one fare menu ──
// A real recipe gets these from the supplier's own pages/payloads. Note the
// offer id: departISO|arriveISO|airline — TIMES ARE THE IDENTITY, stable
// across a fresh search; never a DOM index, never a testid.
const iso=(hhmm)=>`${DDATE.slice(0,4)}-${DDATE.slice(4,6)}-${DDATE.slice(6,8)}T${hhmm}`;
const offer=(dep,arr,price)=>({ id:`${iso(dep)}|${iso(arr)}|EX`, airline:"Example Air", price, currency:"USD",
  departISO:iso(dep), arriveISO:iso(arr), durationMin:75, stops:"Direct", seats:5,
  from:DCITY.toUpperCase(), to:ACITY.toUpperCase(),
  segments:[{ flightNo:"EX123", airline:"EX", from:DCITY.toUpperCase(), to:ACITY.toUpperCase(), dep:iso(dep), arr:iso(arr) }] });
const pretendSupplier={
  offers:[ offer("09:05","10:20",49.9), offer("13:30","14:45",36.6), offer("21:10","22:25",64.0) ],
  fares:f=>[ { price:f.price, currency:"USD", seats:5, cabin:"economy", brand:"Basic",
               conditions:[{type:"baggage",text:"Personal item only"},{type:"refund",text:"Non-refundable"}] },
             { price:+(f.price+24).toFixed(2), currency:"USD", seats:5, cabin:"economy", brand:"Flex",
               conditions:[{type:"baggage",text:"Personal item · Carry-on"},{type:"refund",text:"Changes allowed"}] } ],
};

// ── TASK=search: FIRM offers only — a price you would not honor at book
//    must not be emitted here ──
if(TASK==="search"){
  emitPhase("search"); // timeline step — parsed into the evidence (README §2.8)
  const offers=pretendSupplier.offers.slice().sort((a,b)=>a.price-b.price);
  L(`search ${DCITY}->${ACITY} ${DDATE}: ${offers.length} firm offers`);
  emitResult("search", { route:`${DCITY}->${ACITY}`, ddate:DDATE, tripType:"ow", count:offers.length, offers });
  await drain();
  emitSession("");   // no browser session in the toy; a real BB run emits its session id on keep-alive
  process.exit(EXIT.ok);
}

// offer resolution, shared by details and book: by id — and if the offer is
// gone, that is EXIT.offerGone, never a substitute.
const resolve=()=>pretendSupplier.offers.find(o=>o.id===FLIGHT);

// ── TASK=offer-details: one offer's fare menu, live-read ──
if(TASK==="offer-details"){
  emitPhase("fare-menu");
  if(!FLIGHT) await bail(EXIT.badInput,"offer-details requires FLIGHT=<id> (from search)");
  const f=resolve();
  if(!f) await bail(EXIT.offerGone,`offer not found (no longer available?): ${FLIGHT}`);
  const fares=pretendSupplier.fares(f);
  L(`fares for ${FLIGHT}: ${fares.map(t=>`${t.brand} $${t.price}`).join(" | ")}`);
  emitResult("offer-details", { flight:FLIGHT, returnFlight:null, base:f.price, fares });
  await drain();
  process.exit(EXIT.ok);
}

// ── TASK=book: select → passenger → checkout → (gate) → pay → outcome ──
emitPhase("select");
if(!FLIGHT) await bail(EXIT.badInput,"book requires FLIGHT=<id> (from search)");
const f=resolve();
if(!f) await bail(EXIT.offerGone,`offer not found: ${FLIGHT}`);

// FARE_PRICE pins the fare BY PRICE against the live menu — the index is a
// tiebreak at most. Booking a price you did not verify is forbidden.
const menu=pretendSupplier.fares(f);
const fare=FARE_PRICE? menu.find(t=>Math.abs(t.price-FARE_PRICE)<0.011) : menu[0];
if(!fare) await bail(EXIT.offerGone,`fare at $${FARE_PRICE} not in the live menu (${menu.map(t=>t.price).join(", ")}) — never book an unverified price`);

// the outcome object: emitted EVEN on a crash after Pay (see the catch at
// the bottom of the reference recipe) — payClicked is what the runtime
// trusts to tell refund from uncertain.
const bookOutcome={ task:"book", payClicked:false, total:null, reason:"", reference:"", paymentStatus:"unverified" };

if(!PAX){ await bail(EXIT.badInput,"book with no passengers in the input document"); }
L(`passenger: ${PAX.given} ${PAX.surname}`);
if(CONTACT_EMAIL) L(`contact email given to the supplier: ${CONTACT_EMAIL} (the oracle address — principle 1)`);
await sleep(300);   // pretend: form filling
const total=fare.price;
bookOutcome.total=total;
// No ceiling is passed to you (§2.4): report the total honestly and the gate
// compares it to what the customer engaged. What you DO owe is a total you
// actually read — the gate cannot judge a number it never received.
L(`checkout total: $${total} USD`);
if(!(total>0)){ bookOutcome.reason="no readable cashier total"; await bail(EXIT.offerGone,"no readable checkout total — refusing"); }

// The one branch that matters, and it is not a mode (§2.2): were we handed
// the two things spending requires? Without them the walk still proved the
// whole flow, which is what a conformance run is for.
if(!CAN_PAY){
  bookOutcome.reason="no payment method or gate — walk-only run";
  L("walk-only run: stopping before Pay");
  emitResult("book", bookOutcome);
  await drain();
  process.exit(EXIT.ok);
}

// Park at the checkout, show the human everything, wait for the verdict.
{
  emitApproval({ task:"book-approve", sessionId:"toy", total, currency:"USD", flight:FLIGHT, returnFlight:null,
    fare:fare.brand, itinerary:`${f.airline} ${f.departISO}→${f.arriveISO}`, lead:`${PAX.given} ${PAX.surname}`,
    pax:1, screenshots:[] });
  const verdict=await waitApproval({ file:APPROVE_SIGNAL_FILE, timeoutS:Number(process.env.APPROVE_TIMEOUT_S||480) });
  if(verdict!=="APPROVE"){ bookOutcome.reason=`approval ${verdict}`; await bail(EXIT.offerGone,`human gate: ${verdict} — no Pay`); }
  L("approval received → paying");
}

// pay. payClicked flips BEFORE the click: if we die mid-payment the runtime
// must read "uncertain", never "failed".
bookOutcome.payClicked=true;
L("clicking Pay");
await sleep(300);

// pretend 3DS: real cards challenge sometimes. The code travels ONLY through
// the signal file the runtime owns.
if(process.env.OTP_SIGNAL_FILE){
  emit3DS({ sessionId:"toy", need:"otp", total, screenshots:[] });
  const otp=await waitOTP({ file:process.env.OTP_SIGNAL_FILE, timeoutS:Number(process.env.OTP_TIMEOUT_S||300) });
  if(!otp){ bookOutcome.reason="3DS: no code within the deadline"; emitResult("book", bookOutcome); await drain(); process.exit(EXIT.offerGone); }
  L("3DS code entered");
}

// completion: capture the supplier's order number — the JOIN KEY for the
// confirmation email, not proof of payment (principle 1).
bookOutcome.reference="EX-0000001";
bookOutcome.paymentStatus="paid";
L(`booked — supplier order ${bookOutcome.reference} (settlement still waits for the email oracle)`);
emitResult("book", bookOutcome);
await drain();
process.exit(EXIT.ok);
