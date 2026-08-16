// The toy recipe — the whole contract, offline, in one read.
//
// This file speaks every signal a real recipe speaks, with a pretend
// supplier instead of a browser: run it with plain node, no keys, no
// network, and watch the conversation your recipe is expected to have
// with the runtime. A real recipe replaces `pretendSupplier` with actual
// browsing (Stagehand/Playwright on the runtime-provided session); the
// contract around it — env in, signals out, exit codes — stays exactly this.
//
//   TASK=search DCITY=ibz ACITY=mad DDATE=20261203 node example.com/recipe.mjs
//   TASK=offer-details FLIGHT="2026-12-03T09:05|2026-12-03T10:20|EX" node example.com/recipe.mjs
//   TASK=book PURCHASE_MODE=dry FLIGHT="..." PAX_GIVEN=Jean PAX_SURNAME=Martin node example.com/recipe.mjs
//   TASK=book PURCHASE_MODE=approve ... APPROVE_SIGNAL_FILE=/tmp/verdict node example.com/recipe.mjs
//     (then: echo APPROVE > /tmp/verdict — that is the runtime's gate, simulated by hand)
import { L, sleep, drain, emitResult, emitApproval, emit3DS, emitSession,
  makeBail, waitApproval, waitOTP, EXIT } from "../sdk/index.mjs";

// ── the job, read from the environment (§2 of the README) ──
const TASK=(process.env.TASK||"book").toLowerCase();
const MODE=(process.env.PURCHASE_MODE||"dry").toLowerCase();
const DCITY=(process.env.DCITY||"ibz").toLowerCase(), ACITY=(process.env.ACITY||"mad").toLowerCase();
const DDATE=process.env.DDATE||"20261203";
const FLIGHT=process.env.FLIGHT||"";
const FARE_PRICE=Number(process.env.FARE_PRICE||0);
const CAP=Number(process.env.PRICE_CAP||500);
const CONTACT_EMAIL=process.env.CONTACT_EMAIL||"";   // the ORACLE address — a real recipe gives the supplier exactly this
const PAX={ given:process.env.PAX_GIVEN||"Jean", surname:process.env.PAX_SURNAME||"Martin" };

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
const bookOutcome={ task:"book", mode:MODE, payClicked:false, total:null, reason:"", reference:"", paymentStatus:"unverified" };

L(`passenger: ${PAX.given} ${PAX.surname}`);
if(CONTACT_EMAIL) L(`contact email given to the supplier: ${CONTACT_EMAIL} (the oracle address — principle 1)`);
await sleep(300);   // pretend: form filling
const total=fare.price;
bookOutcome.total=total;
L(`checkout total: $${total} (cap $${CAP})`);
if(total>CAP){ bookOutcome.reason="over cap"; await bail(EXIT.offerGone,`total $${total} exceeds PRICE_CAP $${CAP} — refusing`); }

// dry: the walk proves the flow; the card was never even in our env.
if(MODE==="dry"){
  bookOutcome.reason="dry mode — stopped before Pay";
  L("dry: stopping before Pay");
  emitResult("book", bookOutcome);
  await drain();
  process.exit(EXIT.ok);
}

// approve: park at the checkout, show the human everything, wait for the verdict.
if(MODE==="approve"){
  emitApproval({ task:"book-approve", sessionId:"toy", total, currency:"USD", flight:FLIGHT, returnFlight:null,
    fare:fare.brand, itinerary:`${f.airline} ${f.departISO}→${f.arriveISO}`, lead:`${PAX.given} ${PAX.surname}`,
    pax:1, cap:CAP, screenshots:[] });
  const verdict=await waitApproval({ file:process.env.APPROVE_SIGNAL_FILE||"", timeoutS:Number(process.env.APPROVE_TIMEOUT_S||480) });
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
