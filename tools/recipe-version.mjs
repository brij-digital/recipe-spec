// A recipe's VERSION: the hash the marketplace registers, activates and shows
// on GET /recipes (`version`, `sdk_version`) and GET /recipes/source/{domain}.
// It is NOT the sha256 of a file. It is a content hash over a set of files,
// framed so that two different sets can never hash alike:
//
//   for each covered file, sorted by its slash-separated relative path
//   (bytewise):  <path> LF <length in bytes> LF <bytes>
//
// Not covered: anything under node_modules/, and documentation (.md, .png,
// .jpg, .jpeg, .gif, .webp, any case). A submission is recipe.mjs +
// manifest.yaml; the sdk is the folder sdk/ (today: index.mjs alone).
//
// The marketplace's Go implementation (pkg/recipelock) pins the same test
// vector as tools/recipe-version.test.mjs: if the two ever disagree, one of
// them is red.
//
//   node tools/recipe-version.mjs sdk                     # a folder
//   node tools/recipe-version.mjs --submission my.com/recipe.mjs my.com/manifest.yaml
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENTATION = new Set([".md", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// hashFiles takes { "relative/path": Buffer|string } and returns the version.
export function hashFiles(files) {
  const entries = Object.entries(files)
    .filter(([path]) => !DOCUMENTATION.has(extname(path).toLowerCase()))
    .map(([path, body]) => [path, Buffer.isBuffer(body) ? body : Buffer.from(body)])
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const sum = createHash("sha256");
  for (const [path, body] of entries) {
    sum.update(`${path}\n${body.length}\n`);
    sum.update(body);
  }
  return sum.digest("hex");
}

// hashDir walks a folder the way the marketplace does: regular files only
// (anything else is an error, never a skip), node_modules left out.
export function hashDir(dir) {
  const files = {};
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        if (name !== "node_modules") walk(full);
        continue;
      }
      if (!stat.isFile()) throw new Error(`${full}: not a regular file`);
      files[relative(dir, full).split(sep).join("/")] = readFileSync(full);
    }
  };
  walk(dir);
  return hashFiles(files);
}

// A submission, named as the registry names its two files.
export const hashSubmission = (recipeJS, manifestYAML) =>
  hashFiles({ "recipe.mjs": recipeJS, "manifest.yaml": manifestYAML });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--submission" && args.length === 3) {
    console.log(hashSubmission(readFileSync(args[1]), readFileSync(args[2])));
  } else if (args.length === 1) {
    console.log(hashDir(args[0]));
  } else {
    console.error("usage: recipe-version.mjs <dir> | --submission <recipe.mjs> <manifest.yaml>");
    process.exit(1);
  }
}
