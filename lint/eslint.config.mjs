// Recipe rules, as AST checks.
//
// These are the files the marketplace runs: every submission is linted
// before its dry run and again at activation, in the recipe sandbox image,
// which refuses to build if lint-fixture.mjs finds a hostile line that got
// through. The marketplace vendors this folder from the pinned recipe-spec
// commit, so an author checking locally runs exactly the gate's rules.
//
// The security boundary is elsewhere: the Cloudflare Sandbox isolates the
// process, Browserbase's allowedDomains bounds where the browser may go, and
// a recipe only reaches the card once a human activated its exact bytes.
// These rules do not make a hostile recipe safe. What they do is make the
// things a reviewer must catch impossible to write accidentally and hard to
// write deceptively — which is what turns "read 1500 lines" into "read the
// diff".
//
// Where they stop, deliberately: inside page.evaluate the DOM has dozens of
// ways to make a request — img.src, link prefetch, form.action, a CSS url().
// Catching those means taint analysis, and a taint engine on submitted code
// is a large machine that still loses to the next spelling. The rules refuse
// the named channels; the human review of the activated version is what stands
// between a recipe and the card.
//
// Each rule is calibrated against the two live recipes: every one of them
// passes today, at zero cost. A rule that fails honest code gets disabled,
// and a disabled rule protects nothing.

// The whole import surface of a recipe: the browser drivers, a schema
// library, and the SDK by relative path. An allowlist rather than a list of
// forbidden builtins — "node:fs" is only one of hundreds of ways to reach the
// filesystem, and a denylist is a promise to have thought of all of them.
// Exactly four specifiers. Not "any relative path": a recipe is one file, and
// a helper worth sharing belongs in the SDK where it is reviewed once.
const ALLOWED_MODULES = ["@browserbasehq/stagehand", "playwright", "zod", "../sdk/index.mjs"];

// The only two things a recipe legitimately touches on `process`. An
// allowlist rather than a list of forbidden members: getBuiltinModule was the
// second name for require(), binding() and dlopen() are the next two.
const PROCESS_SURFACE = ["env", "exit"];

// Writing one of these is how in-page code makes the browser fetch a URL of
// its choosing. READING them stays legal — iframe.src is how a recipe detects
// the 3-D Secure challenge.
const WRITE_SINKS = ["src", "srcset", "href", "action", "formaction", "innerHTML", "outerHTML"];
const SINK_ELEMENTS = ["img", "script", "iframe", "link", "embed", "object", "audio", "video", "source"];
const URL_LITERAL = /^(https?|wss?):\/\//i;

// Names that ARE a network channel. The check is on the reference, not on the
// call: `const send = fetch` is the same channel one alias later.
const NETWORK_NAMES = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"];

// Objects that hand out globals by name, which is how a reference disappears
// from a grep: globalThis["fe" + "tch"].
const GLOBAL_OBJECTS = ["globalThis", "global", "self", "window", "top", "parent", "frames"];

const IN_PAGE_ESCAPES = ["evaluate", "evaluateHandle", "addInitScript", "addScriptTag", "exposeFunction", "exposeBinding"];

const isGlobalObject = node => node?.type === "Identifier" && GLOBAL_OBJECTS.includes(node.name);
const propertyName = node =>
  node.computed
    ? (node.property?.type === "Literal" ? String(node.property.value) : null)
    : (node.property?.type === "Identifier" ? node.property.name : null);

const isEnv = node =>
  node?.type === "MemberExpression" &&
  node.object?.type === "Identifier" && node.object.name === "process" &&
  ((node.property?.type === "Identifier" && node.property.name === "env") ||
   (node.property?.type === "Literal" && node.property.value === "env"));

const callee = node => node.callee?.type === "MemberExpression" ? node.callee.property?.name : node.callee?.name;

const plugin = {
  rules: {
    // eval and its family: the only reason to build code at runtime inside a
    // recipe is to keep a reviewer from reading it.
    "no-dynamic-code": {
      meta: { type: "problem", schema: [] },
      create: ctx => ({
        CallExpression(node) {
          const name = callee(node);
          if (name === "eval") ctx.report({ node, message: "eval() builds code at runtime — write the logic in the clear" });
          if (name === "Function") ctx.report({ node, message: "the Function constructor builds code at runtime" });
          if (name === "require" && node.arguments[0] && node.arguments[0].type !== "Literal") {
            ctx.report({ node, message: "require() must take a literal" });
          }
        },
        NewExpression(node) {
          if (node.callee?.name === "Function") ctx.report({ node, message: "the Function constructor builds code at runtime" });
        },
        // Dynamic import is its own node type, not a call with an "Import"
        // callee — the shape most people write this rule against, and the one
        // that let `await import(computed)` through the first draft.
        ImportExpression(node) {
          if (node.source?.type !== "Literal") {
            ctx.report({ node, message: "import() must take a literal: a computed module specifier hides what is loaded" });
          }
        },
      }),
    },
    // The recipe process talks to the runtime and to nothing else. Its
    // network is the browser's, which Browserbase bounds by domain.
    //
    // Checked on REFERENCES, through scope analysis: an identifier that
    // resolves to nothing is the global one, whether it is called, aliased,
    // passed as an argument or read through globalThis. The first draft only
    // matched calls whose callee was literally named `fetch`, so `const send
    // = fetch; send(url)` walked through it.
    "no-network-globals": {
      meta: { type: "problem", schema: [] },
      create(ctx) {
        const source = ctx.sourceCode ?? ctx.getSourceCode();
        return {
          "Program:exit"(node) {
            // Both kinds of reference to a global: unresolved (no declaration
            // anywhere) and resolved-to-a-declared-global. The config declares
            // browser globals so `no-undef` can work, which makes `fetch`
            // RESOLVE — and a rule that only read `through` went blind the day
            // that happened.
            let global = source.getScope(node);
            while (global.upper) global = global.upper;
            const refs = [...global.through];
            for (const variable of global.variables) {
              if (NETWORK_NAMES.includes(variable.name)) refs.push(...variable.references);
            }
            for (const ref of refs) {
              if (NETWORK_NAMES.includes(ref.identifier.name)) {
                ctx.report({
                  node: ref.identifier,
                  message: `${ref.identifier.name} is a direct network channel — a recipe drives the browser instead`,
                });
              }
            }
          },
          MemberExpression(node) {
            if (!isGlobalObject(node.object)) return;
            const name = propertyName(node);
            if (name === null) {
              ctx.report({ node, message: `${node.object.name}[expression] resolves a global by name — nobody can read what this reaches` });
            } else if (NETWORK_NAMES.includes(name)) {
              ctx.report({ node, message: `${node.object.name}.${name} is a direct network channel — a recipe drives the browser instead` });
            }
          },
        };
      },
    },
    // Whatever a recipe legitimately needs from node, the SDK already does
    // (filesystem, signal files, screenshots, the local browser). So the
    // import surface is closed rather than filtered: three packages and the
    // SDK's relative path. This is the rule `await import("node:fs")` walked
    // through when it only inspected static import declarations.
    "no-unlisted-imports": {
      meta: { type: "problem", schema: [] },
      create(ctx) {
        const check = (node, spec) => {
          if (ALLOWED_MODULES.includes(spec)) return;
          ctx.report({ node, message: `"${spec}" is not one of the recipe's four imports (${ALLOWED_MODULES.join(", ")})` });
        };
        return {
          ImportDeclaration: node => check(node, node.source.value),
          ImportExpression(node) {
            if (node.source?.type === "Literal") check(node, String(node.source.value));
          },
          CallExpression(node) {
            const direct = node.callee?.type === "Identifier" ? node.callee.name : null;
            if (direct === "require" && node.arguments[0]?.type === "Literal") {
              check(node, String(node.arguments[0].value));
            }
            // process.getBuiltinModule("node:fs") is require() under another
            // name, and it needs no import statement to reach the filesystem.
          },
        };
      },
    },
    // `process` is reachable only in two exact SHAPES: process.env.NAME and
    // process.exit(...). Not a member allowlist — that was the previous
    // version, and `const p = process` walked around it, as did
    // `const env = process.env; Object.entries(env)`. Once the object is in a
    // variable, every rule about its members is about a name nobody uses.
    //
    // Checked syntactically rather than through scope analysis, so a local
    // binding named `process` does not launder the reference.
    "no-process-surface": {
      meta: { type: "problem", schema: [] },
      create(ctx) {
        const shapeOf = id => {
          const member = id.parent;
          if (member?.type !== "MemberExpression" || member.object !== id || member.computed) return null;
          const name = propertyName(member);
          // process.exit(…) — the call, not the function as a value.
          if (name === "exit") {
            return member.parent?.type === "CallExpression" && member.parent.callee === member ? "exit" : null;
          }
          // process.env.NAME — a named read, so a reviewer sees every
          // variable the recipe touches. Not process.env passed anywhere.
          if (name === "env") {
            const read = member.parent;
            return read?.type === "MemberExpression" && read.object === member && !read.computed ? "env" : null;
          }
          return null;
        };
        return {
          Identifier(node) {
            if (node.name !== "process") return;
            // A property named `process` on some other object is not this.
            if (node.parent?.type === "MemberExpression" && node.parent.property === node && !node.parent.computed) return;
            if (node.parent?.type === "Property" && node.parent.key === node) return;
            if (!shapeOf(node)) {
              ctx.report({ node, message: "a recipe touches process only as process.env.NAME or process.exit(…) — anything else, including holding it in a variable, is outside the contract" });
            }
          },
        };
      },
    },
    // Naming a variable is how a reviewer sees what a recipe reads. Reading
    // the environment dynamically is how it reads the card without naming it.
    "no-dynamic-env": {
      meta: { type: "problem", schema: [] },
      create: ctx => ({
        MemberExpression(node) {
          if (isEnv(node.object) && node.computed && node.property.type !== "Literal") {
            ctx.report({ node, message: "process.env[expression] hides what is read — name the variable" });
          }
        },
        CallExpression(node) {
          const name = callee(node);
          if (["keys", "values", "entries", "assign"].includes(name) &&
              node.arguments.some(a => isEnv(a))) {
            ctx.report({ node, message: `Object.${name}(process.env) reads every variable, including the card` });
          }
        },
        VariableDeclarator(node) {
          if (node.id?.type === "ObjectPattern" && isEnv(node.init) &&
              node.id.properties.some(p => p.type === "RestElement")) {
            ctx.report({ node, message: "destructuring the rest of process.env reads variables nobody listed" });
          }
        },
      }),
    },
    // page.evaluate runs INSIDE the page, which has the network Browserbase
    // does not restrict (allowedDomains covers main-frame navigation only).
    // Reading the DOM there is the job. Making the page issue a request is
    // not, and it does not take a fetch: an <img> whose src is assigned, a
    // beacon, document.write. So what is refused is the WRITE — reading
    // iframe.src is how a recipe detects the 3-D Secure challenge, and stays
    // legal.
    "no-sinks-in-evaluate": {
      meta: { type: "problem", schema: [] },
      create(ctx) {
        const escapes = [];
        const inPage = () => escapes.length > 0;
        const report = (node, message) => ctx.report({ node, message });
        const objectName = node =>
          node?.type === "Identifier" ? node.name
            : node?.type === "MemberExpression" ? propertyName(node) : null;
        return {
          CallExpression(node) {
            if (IN_PAGE_ESCAPES.includes(callee(node))) escapes.push(node);
            if (!inPage()) return;
            const name = callee(node);
            const owner = node.callee?.type === "MemberExpression" ? objectName(node.callee.object) : null;
            if (["sendBeacon", "importScripts", "insertAdjacentHTML"].includes(name)) {
              report(node, `${name}() inside page code makes the page act on a URL of its own`);
            }
            if (name === "open" && GLOBAL_OBJECTS.includes(owner)) report(node, "window.open() inside page code navigates somewhere allowedDomains never saw");
            if (["assign", "replace"].includes(name) && owner === "location") report(node, `location.${name}() inside page code navigates somewhere allowedDomains never saw`);
            if (["write", "writeln"].includes(name) && owner === "document") report(node, "document.write() injects markup the reviewer never read");
            if (name === "createElement" && node.arguments[0]?.type === "Literal" &&
                SINK_ELEMENTS.includes(String(node.arguments[0].value).toLowerCase())) {
              report(node, `createElement("${node.arguments[0].value}") builds an element whose job is to fetch a URL`);
            }
            if (name === "setAttribute" && node.arguments[0]?.type === "Literal" &&
                WRITE_SINKS.includes(String(node.arguments[0].value).toLowerCase())) {
              report(node, `setAttribute("${node.arguments[0].value}", …) is the same write as assigning it`);
            }
          },
          "CallExpression:exit"(node) {
            if (escapes[escapes.length - 1] === node) escapes.pop();
          },
          AssignmentExpression(node) {
            if (!inPage() || node.left?.type !== "MemberExpression") return;
            const name = propertyName(node.left);
            if (name === null) return report(node, "assigning a property by computed name inside page code hides what is written");
            if (WRITE_SINKS.includes(name)) {
              report(node, `writing .${name} inside page code makes the page fetch a URL — reading it is fine, writing it is the channel`);
            }
          },
          Identifier(node) {
            if (!inPage()) return;
            if (NETWORK_NAMES.includes(node.name) && node.parent?.property !== node) report(node, `${node.name} inside page code reaches hosts allowedDomains does not bound`);
            // navigator.sendBeacon.bind(navigator) is a channel held by a
            // variable — the alias bug again, one object deeper.
            if (node.name === "sendBeacon") report(node, "sendBeacon inside page code is a one-way request out");
          },
          NewExpression(node) {
            if (inPage() && [...NETWORK_NAMES, "Image", "Audio"].includes(node.callee?.name)) {
              report(node, `new ${node.callee.name} inside page code fetches a URL`);
            }
          },
          Literal(node) {
            if (inPage() && typeof node.value === "string" && URL_LITERAL.test(node.value)) {
              report(node, "an absolute URL inside page code — page code reads the page, the recipe decides where to go");
            }
          },
        };
      },
    },
  },
};

export default [
  {
    // Every .mjs, wherever it sits: a pattern that does not match a file makes
    // eslint answer "0 errors" for it, silently (measured: nested/x/recipe.mjs
    // passed clean with a fetch in it).
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023, sourceType: "module",
      // Node's globals AND the browser's: a recipe runs in node, but the
      // bodies it passes to page.evaluate run in the page, and eslint sees
      // one file. Both sets are declared so the undefined names that remain
      // are the real ones.
      globals: Object.fromEntries([
        "process", "console", "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
        "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone",
        "AbortController", "AbortSignal", "fetch", "Response", "Request", "Headers", "crypto", "performance",
        "document", "window", "navigator", "location", "localStorage", "sessionStorage", "getComputedStyle",
        "Image", "Audio", "Element", "HTMLElement", "Node", "NodeList", "MutationObserver", "DOMParser",
        "XMLHttpRequest", "WebSocket", "EventSource", "requestAnimationFrame", "atob", "btoa", "alert",
        "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "FormData", "Blob", "File",
      ].map(name => [name, "readonly"])),
    },
    plugins: { brij: plugin },
    rules: {
      "brij/no-dynamic-code": "error",
      "brij/no-network-globals": "error",
      "brij/no-unlisted-imports": "error",
      "brij/no-dynamic-env": "error",
      // An identifier nobody defines only throws when its line runs, and the
              // END log runs after the result is emitted — which is how
              // trip.com lost `KEEP` for a day while every check stayed green.
              "no-undef": "error",
      "brij/no-sinks-in-evaluate": "error",
      "brij/no-process-surface": "error",
    },
  },
];
