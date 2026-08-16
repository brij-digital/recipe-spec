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
