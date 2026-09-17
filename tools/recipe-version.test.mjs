// The cross-language vector. The marketplace's Go half
// (pkg/recipelock TestCrossLanguageVector) pins the same string.
//   node tools/recipe-version.test.mjs
import assert from "node:assert/strict";
import { hashFiles } from "./recipe-version.mjs";

const got = hashFiles({
  "manifest.yaml": "domain: example.com\n",
  "recipe.mjs": "export const run = () => 1;\n",
  "lib/util.mjs": "// util\n",
  "CHANGELOG.md": "# ignored\n",
});
assert.equal(got, "8d7901efa6e154a20b1dee36d5b20bad929a0f5e1f116260acc03471de5e987d");
console.log("recipe-version: cross-language vector OK");
