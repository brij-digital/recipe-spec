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
// emitPhase marks a step of the run ("search", "select", "passenger-form",
// "cashier"…). The runtime parses these into the evidence timeline; the last
// phase before a failing exit becomes the structured failure_phase an author
// (or an agent) iterates on. Cheap, honest, worth sprinkling.
const PHASE_T0 = Date.now();
export const emitPhase = name => { if (name) console.log(MARKERS.phase + JSON.stringify({ phase: String(name), at: Date.now() - PHASE_T0, v: PROTOCOL_VERSION })); };

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
export const connectRuntimeBrowser = async ({ task } = {}) => {
  const connectUrl = (process.env.BB_CONNECT_URL || "").trim();
  const sessionId = (process.env.BB_SESSION_ID || "").trim();
  const extensionId = (process.env.BB_EXTENSION_ID || "").trim();
  if (!connectUrl) {
    throw new Error("BB_CONNECT_URL is required: the runtime owns the browser session and this recipe cannot create one");
  }
  if (task !== "book") {
    return { browser: null, sessionId: sessionId || "runner-owned", connectUrl };
  }
  if (!extensionId) {
    throw new Error("BB_EXTENSION_ID is required for book: Stagehand attaches to the runner's session by its preloaded extension");
  }
  const { localBrowser } = await import("@browserbasehq/stagehand");
  const browser = await localBrowser.connect({ cdpUrl: connectUrl, extensionId });
  return { browser, sessionId: sessionId || "runner-owned", connectUrl };
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
