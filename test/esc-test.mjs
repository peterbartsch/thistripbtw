/* The HTML escapers, pinned — because one of them was wrong in the way that looks right.
 *
 * new.html's esc() was `document.createElement("div"); d.textContent = t; return d.innerHTML`.
 * That is the idiom everyone reaches for, and it does not do what the callers need: it serialises
 * a TEXT node, and the HTML serialisation algorithm escapes quotes only when serialising an
 * ATTRIBUTE VALUE. So `&`, `<` and `>` came back escaped and `"` came back untouched, while most
 * of the callers interpolate into `value="${esc(...)}"`.
 *
 * Reachable, and reached: `#d=` carries a draft a stranger composed. fromHash() shape-checks
 * every field, range-checks coordinates, matches modes against a fixed set and clamps every
 * length — but it never filters CHARACTERS, correctly assuming the sink escapes. A place name of
 *   X" onfocus="…" autofocus data-z="
 * put `onfocus` on the leg-card input as a live event handler; CSP is script-src 'self'
 * 'unsafe-inline', so it ran. localStorage is scoped to the ORIGIN and app.html stores trip
 * phrases at ttb_key_<slug>, so an injection on the builder reads keys to trips it never touches.
 * The fragment is never transmitted, so none of it appears in a server log.
 *
 * Two things are asserted, and the first matters more than the second:
 *   1. NEITHER escaper touches the DOM. An escaper built out of document.createElement CANNOT
 *      escape a quote, whatever else it does — so the shape is the bug, and the shape is pinned.
 *   2. Both escape all five of & < > " ', and the exact payload above comes back inert.
 *
 * The two are still separate functions with deliberately different null-handling (app.html maps
 * 0 and false to "", new.html stringifies them), so this pins the ESCAPING and not that.
 *
 * Run: node test/esc-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const app  = readFileSync(root + "public/app.html", "utf8");
const nw   = readFileSync(root + "public/new.html", "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* ── pull each esc out of its page ─────────────────────────────────────────────────────── */
function escFrom(src, name) {
  const m = src.match(/^const esc\s*=\s*(.+?);$/m);
  if (!m) { ok(`${name} defines a one-line const esc`, false); return null; }
  ok(`${name} defines a one-line const esc`, true);
  /* No document, no window — deliberately. A stub DOM would quietly behave unlike the shipped
     one, which is the trap CLAUDE.md names: every false finding in the 2026-07-30 audit came
     from the instrument. So the escaper runs bare, and reaching for the DOM is CAUGHT and
     reported as a failure rather than thrown, so the suite still ends in the house format
     ("N failed, M passed") instead of a stack trace that hides the assertions below it. */
  try {
    const fn = new Function(`"use strict"; return (${m[1]});`)();
    fn("probe");                       // a DOM-built escaper dies here, not at definition
    return fn;
  } catch (e) {
    ok(`${name}'s esc runs without a DOM — ${e.message}`, false);
    return null;
  }
}

const escs = [["app.html", escFrom(app, "app.html")], ["new.html", escFrom(nw, "new.html")]];

/* ── 1. the shape: a DOM-built escaper cannot escape a quote ───────────────────────────── */
for (const [name, src] of [["app.html", app], ["new.html", nw]]) {
  const line = (src.match(/^const esc\s*=.+$/m) || [""])[0];
  ok(`${name}'s esc is a pure string function — no createElement`,
     !/createElement|textContent|innerHTML/.test(line));
}

/* ── 2. all five characters, in both ───────────────────────────────────────────────────── */
const MUST = [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]];
for (const [name, esc] of escs) {
  if (!esc) continue;
  for (const [ch, want] of MUST)
    ok(`${name} escapes ${JSON.stringify(ch)} to ${want}`, esc(ch) === want);
  ok(`${name} leaves ordinary text alone`, esc("Portland, OR") === "Portland, OR");
  ok(`${name} escapes & FIRST, so entities are not double-built`,
     esc("&lt;") === "&amp;lt;");
}

/* ── 3. the payload that actually executed, and the attribute it closed ────────────────── */
const PAYLOAD = 'X" onfocus="window.__XSS=1" autofocus data-z="';
for (const [name, esc] of escs) {
  if (!esc) continue;
  const out = esc(PAYLOAD);
  ok(`${name}: the #d= payload comes back with no bare double quote`, !out.includes('"'));
  ok(`${name}: nor a bare single quote`, !esc("x' onfocus='y").includes("'"));
  /* The invariant the callers actually depend on: whatever esc() returns can be dropped between
     two double quotes and cannot close them. Checked as a string, not by parsing HTML, because
     there is no DOM here and the point is that none is needed. */
  ok(`${name}: value="${"${esc(name)}"}" cannot be closed`,
     !`<input value="${out}">`.slice('<input value="'.length, -2).includes('"'));
}

/* ── 4. the sinks are still attributes, so this test still has a job ───────────────────── */
/* If these ever stop matching, do not delete the assertion — find out whether the templates
   moved to textContent (good, and then this file can go) or merely moved (and it still applies). */
const ATTR_SINKS = [
  ["new.html", nw, /value="\$\{esc\(l\.to\.name\)\}"/],
  ["new.html", nw, /value="\$\{esc\(l\.stay\.lodging\)\}"/],
  ["app.html", app, /value="\$\{esc\(CONFIG\.name\|\|""\)\}"/],
];
for (const [name, src, re] of ATTR_SINKS)
  ok(`${name} still interpolates esc() into a double-quoted attribute (${re.source.slice(0, 34)}…)`,
     re.test(src));

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
