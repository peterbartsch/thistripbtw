/* diff.mjs — is this run WORSE than the accepted one? (§2bu)
 *
 * `make flow` reports what it finds; this decides whether that matters. The board carries six
 * standing findings (§2bu) and a permanently red board teaches people to ignore red, so the
 * signal has to be "something NEW", not "something".
 *
 * Exit 1 on a finding absent from the baseline. Exit 0 otherwise — a finding that has GONE is
 * printed and never fails, because fixing something must never break the build.
 *
 * WHAT THIS CANNOT ANSWER, and it is printed on every run rather than left in a doc: three cold
 * runs failed on findability while every number here was green, and every number here would STILL
 * be green. It sees mechanics — a band that shrank, text landed bare, a control covered, a glyph
 * gone. It cannot see that a pill reads as a label, that a continent is not a tappable
 * instruction, or that somebody stopped and thought for twenty seconds. Only a moderated cold run
 * measures against the bar, which is "grandma would be lost, but she can text".
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const runsDir = root + "var/flow";
const basePath = root + "test/flow/baseline.json";

/* A key has to survive a number changing — "only 92px" and "only 88px" are ONE finding, not two,
   or every run invents new ones and the differ is noise. Digits collapse to #. */
const keyOf = f => [f.flow, f.vp, f.kind, String(f.text).replace(/\d+/g, "#")].join(" | ");

const runs = existsSync(runsDir)
  ? readdirSync(runsDir).filter(d => existsSync(`${runsDir}/${d}/findings.json`)).sort()
  : [];
if (!runs.length) { console.error("no run with findings.json under var/flow — run `make flow` first"); process.exit(2); }
const latest = runs[runs.length - 1];
const run = JSON.parse(readFileSync(`${runsDir}/${latest}/findings.json`, "utf8"));

const baseline = existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : { accepted: [] };
const accepted = new Map((baseline.accepted || []).map(a => [a.key, a.why || ""]));

const nowKeys = new Set(run.findings.map(keyOf));
const fresh = [...nowKeys].filter(k => !accepted.has(k));
const gone = [...accepted.keys()].filter(k => !nowKeys.has(k));

console.log(`run ${latest} · ${run.base} · ${run.findings.length} occurrence(s), ${nowKeys.size} distinct`);
console.log(`baseline ${baseline.stamp || "(none)"} · ${accepted.size} accepted\n`);

if (gone.length) {
  console.log(`${gone.length} accepted finding(s) NO LONGER PRESENT — fix confirmed, or the step stopped running:`);
  for (const k of gone) console.log(`  gone   ${k}`);
  console.log("");
}
if (fresh.length) {
  console.log(`${fresh.length} NEW finding(s) — this is the signal:`);
  for (const k of fresh) console.log(`  NEW    ${k}`);
} else {
  console.log("no new findings.");
}

console.log("\nThis compares MECHANICS only. It cannot see hesitation, and a green diff is not a");
console.log("usable product — watch one non-designer build a trip. The bar is: grandma can text.");
process.exit(fresh.length ? 1 : 0);
