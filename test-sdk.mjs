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
