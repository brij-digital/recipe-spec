// The rules are only worth what the fixture proves. Running eslint and
// checking it exited non-zero says one line was caught; this says which.
// Run at image build: an image whose rules miss a hostile line never ships.
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = "fixtures/hostile.mjs";
const marked = new Set();
const legal = new Set();
readFileSync(`${HERE}/${FIXTURE}`, "utf8").split("\n").forEach((line, i) => {
  if (line.includes("// HOSTILE")) marked.add(i + 1);
  // Lines a recipe must still be able to write. A rule that refuses honest
  // code gets disabled, and a disabled rule protects nothing — so the
  // fixture pins both directions.
  if (line.includes("// LEGAL")) legal.add(i + 1);
});
if (marked.size === 0) throw new Error("the fixture marks no hostile line");
if (legal.size === 0) throw new Error("the fixture marks no legal line");

const [result] = await new ESLint({ cwd: HERE }).lintFiles([FIXTURE]);
const caught = new Set(result.messages.filter(m => m.severity === 2).map(m => m.line));
const missed = [...marked].filter(line => !caught.has(line));
const overreach = [...legal].filter(line => caught.has(line));

for (const line of missed) console.error(`MISSED line ${line}`);
for (const line of overreach) {
  const why = result.messages.filter(m => m.line === line).map(m => m.ruleId).join(", ");
  console.error(`OVERREACH line ${line}: honest code refused by ${why}`);
}
console.log(`hostile fixture: ${marked.size - missed.length}/${marked.size} refused, ${legal.size - overreach.length}/${legal.size} honest lines untouched`);
if (missed.length || overreach.length) {
  console.error(missed.length ? "a hostile pattern walked through the rules" : "the rules refuse honest code");
  process.exit(1);
}
