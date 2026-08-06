/* Token drift — does what ships match what the design system says?
 *
 * `design/tokens.json` is the system of record (D-026, W3C DTCG format). Two things are supposed
 * to be derived from it and never hand-edited:
 *
 *   public/tokens.css                      what every page actually renders with
 *   design/tokens-studio/primitives.json   what Figma imports
 *
 * Nothing checked that any of the three agreed. The palette moved once already (D-061 changed
 * both brand colours) and the note in TODO_PETE about Figma still showing the old teal and
 * orange is exactly the failure this catches — except a to-do file only knows what somebody
 * remembered to write down, and this knows every time it runs.
 *
 * The direction is deliberate: tokens.json is right by definition, and the other two are wrong
 * if they disagree with it. Colours only, matching what primitives.json actually carries — this
 * asserts what is true rather than inventing coverage it does not have.
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log("  ok   " + what); }
  else { fail++; console.log("  FAIL " + what + (detail ? " — " + detail : "")); }
};

/** Flatten a DTCG tree to { "brand.teal": "#035A83", … }, colours only. */
function flatten(node, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$")) continue;
    if (v && typeof v === "object") {
      if (v.$type === "color" && typeof v.$value === "string") out[prefix + k] = v.$value.toUpperCase();
      else flatten(v, prefix + k + ".", out);
    }
  }
  return out;
}

const record = flatten(JSON.parse(readFileSync(root + "design/tokens.json", "utf8")).color || {});
const figma  = flatten(JSON.parse(readFileSync(root + "design/tokens-studio/primitives.json", "utf8")).color || {});

/* tokens.css names them --color-<group>-<name>, which is the dotted path with dashes. */
const css = {};
for (const m of readFileSync(root + "public/tokens.css", "utf8")
       .matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g))
  css[m[1]] = m[2].toUpperCase();

ok("the system of record defines colours at all", Object.keys(record).length > 0);

/* 1. Figma's file against the record. Every token Figma carries must match; the record may
      hold more than Figma does, which is fine — primitives.json is explicitly colours-only. */
let figmaBad = [];
for (const [path, value] of Object.entries(figma))
  if (record[path] && record[path] !== value) figmaBad.push(`${path}: figma ${value} vs record ${record[path]}`);
ok(`Figma primitives match the system of record (${Object.keys(figma).length} colours)`,
   figmaBad.length === 0, figmaBad.join("; "));

/* 2. The shipped CSS against the record — the one that would actually be visible to a customer. */
let cssBad = [], checked = 0;
for (const [path, value] of Object.entries(record)) {
  const key = path.replace(/\./g, "-");
  if (!(key in css)) continue;             // the CSS need not ship every token
  checked++;
  if (css[key] !== value) cssBad.push(`--color-${key}: css ${css[key]} vs record ${value}`);
}
ok(`shipped tokens.css matches the system of record (${checked} colours)`,
   cssBad.length === 0, cssBad.join("; "));

/* 3. The two brand colours by name, spelled out. D-061 moved exactly these, so a regression
      here is the one with a name and a history rather than an anonymous hex. */
for (const [path, cssKey] of [["brand.teal", "brand-teal"], ["brand.orange", "brand-orange"]])
  ok(`${path} agrees across record, Figma and CSS (${record[path]})`,
     record[path] && record[path] === figma[path] && record[path] === css[cssKey],
     `record ${record[path]}, figma ${figma[path]}, css ${css[cssKey]}`);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
