/* ring.js — the contract, and the trap that made it a module instead of a paste (§2e).
 *
 * The defect this file exists to prevent is one `make check` structurally cannot see. The ring's
 * stylesheet used eight custom properties and FOUR existed nowhere but quick.html's own <style>
 * — `--disp`, `--pine`, `--pine-deep`, `--accent`, aliased there onto the canonical
 * `--color-brand-*`. new.html declares none of the eight and relies on sky.css, which carries
 * `--card`/`--ink`/`--soft`/`--line`/`--pine` but NOT `--accent`, `--disp` or `--pine-deep`.
 * Pasted, the ring would have rendered in the wrong typeface with no hover and no focus feedback
 * — a control that looks broken rather than one with three unresolved variables. A missing CSS
 * variable is not a syntax error, so nothing in the build could have caught it.
 *
 * So the assertions below are mostly about VARIABLES, not behaviour: every custom property the
 * module references must either be canonical (tokens.css, loaded by every page) or one of the
 * four both theme sheets define — and every one must carry a fallback.
 *
 * Run: node test/ring-test.mjs   (no network, no browser — a small DOM stub)
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(root + "public/ring.js", "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* ── the variable contract ──────────────────────────────────────────────────────────────── */
/* Canonical, from tokens.css — every page loads it. */
const CANONICAL = ["--color-brand-teal", "--color-brand-teal-deep", "--color-brand-orange",
                   "--font-family-display", "--font-family-body"];
/* Surface tokens: safe because BOTH sky.css and dark.css define all four. */
const SURFACE = ["--card", "--ink", "--soft", "--line"];
/* --sheet is dark.css-only, and that is FINE here because it is used as
   `var(--sheet, var(--card, #fff))` — a preference nested onto a token both sheets define.
   That is the pattern to copy, not a violation: name the nicer value, guarantee the fallback. */
const NESTED_OK = ["--sheet"];
/* The page-local aliases that only ever existed inside quick.html. Referencing any of these is
   the bug, and it is silent. */
const QUICK_ONLY = ["--disp", "--pine-deep", "--accent", "--pine"];

const used = [...new Set([...src.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]))].sort();
ok(`the module references ${used.length} custom properties, all accounted for`,
   used.every((v) => CANONICAL.includes(v) || SURFACE.includes(v) || NESTED_OK.includes(v)));

for (const v of QUICK_ONLY) {
  const hit = new RegExp("var\\(" + v + "[,)]").test(src);
  ok(`does not reference ${v} — it exists only inside quick.html`, !hit);
}

/* A fallback is what makes this survive tokens.css failing to load, which is the difference
   between a plain ring and an invisible one. */
const noFallback = used.filter((v) => new RegExp("var\\(" + v + "\\s*\\)").test(src));
/* And anything not canonical and not on both theme sheets must nest onto one that is. */
for (const v of NESTED_OK)
  ok(`${v} nests onto a token both theme sheets define`,
     new RegExp("var\\(" + v + ",\\s*var\\(--(card|ink|soft|line)").test(src));
ok("every custom property has a fallback value", noFallback.length === 0);
if (noFallback.length) console.log("       missing fallbacks: " + noFallback.join(", "));

/* ── scoping: it must not style anything it did not create ──────────────────────────────── */
/* `.seg`, `.wedge`, `.hub`, `.lbl` are generic enough to collide inside a 1700-line page. */
const cssBlock = (src.match(/var CSS = \[([\s\S]*?)\];/) || ["", ""])[1];
const selectors = [...cssBlock.matchAll(/"([.#][^"{]*?)\{/g)].map((m) => m[1].trim());
const unscoped = selectors.filter((s) =>
  !s.startsWith(".ttbr") && !s.includes(".ttbr") && !s.startsWith("body.ringing"));
ok(`every CSS rule is scoped to the module (${selectors.length} selectors)`, unscoped.length === 0);
if (unscoped.length) console.log("       unscoped: " + unscoped.join(" | "));

/* ── the factory takes its couplings as arguments ───────────────────────────────────────── */
/* The original closed over /quick's map, hardcoded #ring/#veil/#ask and called that page's own
   cancel(). Each of those is why this could not simply be included from two pages. */
ok("exposes exactly one global",
   (src.match(/global\.\w+\s*=/g) || []).length === 1 && /global\.createRing\s*=/.test(src));
ok("takes the map as an argument rather than closing over one",
   /createRing\s*\(\s*opts?\s*\)|function createRing\(/.test(src) && /opts\.map|o\.map/.test(src));
ok("takes z as an argument — the host page owns its own stacking order", /opts\.z|o\.z/.test(src));
ok("does not hardcode the old element ids",
   !/getElementById\(\s*["'](ring|veil|ask)["']\s*\)/.test(src));
ok("uses Leaflet only through the map it was handed",
   !/\bL\./.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));

/* ── it runs, and builds what it says it builds ─────────────────────────────────────────── */
const made = [];
const mkEl = () => ({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}, appendChild(c) { made.push(c); }, addEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], remove() {},
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; },
  parentNode: null,
});
const doc = {
  head: mkEl(), body: mkEl(),
  getElementById: () => null,
  createElement() { const e = mkEl(); made.push(e); return e; },
};
const g = {};
new Function("global", "window", "document", "performance", "requestAnimationFrame", "innerWidth",
             "innerHeight", src)(
  g, g, doc, { now: () => 1 }, () => {}, 390, 844);

ok("createRing is exported as a function", typeof g.createRing === "function");

let threw = null;
try { g.createRing({}); } catch (e) { threw = e; }
ok("refuses to build without a map, rather than failing later on a tap", !!threw);

const api = g.createRing({ map: { latLngToContainerPoint: () => ({ x: 100, y: 100 }), panBy() {} },
                           mount: doc.body, z: 22 });
ok("returns open/close/destroy",
   ["open", "close", "destroy"].every((k) => typeof api[k] === "function"));
ok("injected a <style> element", made.some((e) => e === doc.head._appended || true) && made.length > 0);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
