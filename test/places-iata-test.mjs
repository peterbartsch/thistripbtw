/* Airport codes in the place suggester, against the REAL 40k index.
 *
 * The bug this file exists to prevent: `searchLocal()` picks its candidates from a bucket keyed
 * by the first letter of the place's NAME, and an airport's name does not begin with its code.
 * "Chicago O'Hare International Airport" sits in bucket `c`, so typing ORD scanned bucket `o`
 * and never saw it. The widening pass could not rescue it either — it requires a 4-character
 * first token and every IATA code is three.
 *
 * Measured before the fix: 8 of these 25 returned NOTHING, and ORD returned **Ord, Nebraska**
 * (population ~2,000) with O'Hare absent from the list. That second failure is the dangerous
 * one — the cold-run rule is that a wrong stop which looks right is worse than an error, because
 * nobody checks a plausible answer.
 *
 * Every assertion here is a lookup against the shipped data. No network, no DOM, no staging —
 * CLAUDE.md's rule that a calculation you can check beats an interaction you have to stage.
 *
 * Run: node test/places-iata-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
let src = readFileSync(root + "public/places.js", "utf8");

/* places.js is an IIFE that exports only attachSuggest. Reach the internals by appending to the
   one export line rather than restructuring the shipped file — if that line ever moves, this
   throws loudly instead of testing a stale copy. */
const EXPORT = "global.attachSuggest = attachSuggest;";
if (!src.includes(EXPORT)) throw new Error("places.js export line moved — update this test");
src = src.replace(EXPORT, EXPORT + " global.__searchLocal = searchLocal; global.__load = loadIndex;");

const g = {};
const stubEl = () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { toggle() {} },
                        addEventListener() {} });
const doc = { readyState: "complete", addEventListener() {}, getElementById: () => ({}),
              createElement: stubEl, head: { appendChild() {} } };
const idxJson = readFileSync(root + "public/places-index.json", "utf8");
const fakeFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(idxJson)) });

new Function("global", "window", "document", "fetch", "getComputedStyle", src)(
  g, g, doc, fakeFetch, () => ({ position: "relative" }));

await g.__load();

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* Codes chosen so that more than half DISAGREE with their airport's first letter — that is the
   whole failure mode, and a list of only SFO/DEN/LAX would have passed against the broken
   version. MCO/EWR/BNA/MSY/DCA/IAD/MDW/HNL are the eight that returned nothing. */
const CODES = {
  RNO: "Reno", ORD: "O'Hare", SFO: "San Francisco", DEN: "Denver", LAX: "Los Angeles",
  JFK: "Kennedy", LGA: "LaGuardia", SEA: "Seattle", MIA: "Miami", PHX: "Phoenix",
  MCO: "Orlando", EWR: "Newark", BNA: "Nashville", MSY: "New Orleans", DCA: "Reagan",
  IAD: "Dulles", DFW: "Dallas", BOS: "Boston", SLC: "Salt Lake City", PDX: "Portland",
  AUS: "Austin", MDW: "Midway", HNL: "Inouye", OAK: "Oakland", SAN: "San Diego",
};

let hits = 0;
for (const [code, expect] of Object.entries(CODES)) {
  const top = (g.__searchLocal(code, null) || [])[0];
  const good = top && top.iata === code && top.name.includes(expect);
  if (good) hits++;
  else console.log(`       ${code} -> ${top ? top.iata + " " + top.name : "NOTHING"}`);
}
ok(`all ${Object.keys(CODES).length} airport codes resolve to their own airport (${hits} did)`,
   hits === Object.keys(CODES).length);

/* The specific regression, named, so a failure says what broke rather than just a count. */
const ord = (g.__searchLocal("ORD", null) || [])[0];
ok("ORD is O'Hare and NOT Ord, Nebraska", !!ord && ord.iata === "ORD" && ord.cc === "US");
ok("a code beats a same-spelled town outright, it does not merely appear in the list",
   !!ord && ord.name.includes("O'Hare"));

/* Lower case, and with the whitespace a real thumb leaves behind. */
ok("lower case works too",            (g.__searchLocal("ewr", null) || [])[0]?.iata === "EWR");
ok("surrounding spaces are trimmed",  (g.__searchLocal("  mco  ", null) || [])[0]?.iata === "MCO");

/* The fix must not cost the ordinary case. A three-letter query that is a real place name has
   to keep returning that place — this is how "san" or "ord" for a town would break. */
const san = g.__searchLocal("san francisco", null) || [];
ok("a full city name still returns the city, not its airport",
   san.length > 0 && !san[0].iata && san[0].name === "San Francisco");
ok("plain city search is unaffected",
   (g.__searchLocal("moab", null) || [])[0]?.name === "Moab");
ok("a non-existent code returns nothing rather than a wrong guess",
   !(g.__searchLocal("zzz", null) || []).some(r => r.iata === "ZZZ"));

/* ── ICAO, four letters (D-112) ──────────────────────────────────────────────────────── */
/* Real data from OurAirports' icao_code column, NOT "K + the IATA code" — that rule holds
   across the contiguous US and nowhere else, and applying it blindly turns PISA into Mount
   Isa, Australia. Before the field existed: KORD returned Kord Kuy (a town in Iran), PHNL
   returned Jan-Phyl Village, Florida, and KSFO/KLAX/CYYZ returned nothing at all. */
const ICAO = { KORD: "O'Hare", KSFO: "San Francisco", KLAX: "Los Angeles",
               PHNL: "Inouye", CYYZ: "Toronto", EGLL: "Heathrow", KJFK: "Kennedy" };
let ihits = 0;
for (const [code, expect] of Object.entries(ICAO)) {
  const top = (g.__searchLocal(code, null) || [])[0];
  if (top && top.icao === code && top.name.includes(expect)) ihits++;
  else console.log(`       ${code} -> ${top ? top.name : "NOTHING"}`);
}
ok(`all ${Object.keys(ICAO).length} ICAO codes resolve to their own airport (${ihits} did)`,
   ihits === Object.keys(ICAO).length);
ok("KORD is O'Hare and NOT Kord Kuy, Iran",
   (g.__searchLocal("KORD", null) || [])[0]?.icao === "KORD");

/* A code must not bury a city that is genuinely spelled that way. 69 codes in this index are
   also city names. The rule is that the city has to OUT-WEIGH the airport, so both of these
   must hold at once — one without the other is a rule that only looks right. */
ok("PALU is the Indonesian city, not an Alaskan radar station",
   (g.__searchLocal("PALU", null) || [])[0]?.kind === "c");
ok("ABA is the Nigerian city of 1.2m, not Abakan's airport",
   (g.__searchLocal("ABA", null) || [])[0]?.kind === "c");
ok("but SAN is still San Diego, not a town of 100,000 in Mali",
   (g.__searchLocal("SAN", null) || [])[0]?.iata === "SAN");
ok("and ORD is still O'Hare, not Ord",
   (g.__searchLocal("ORD", null) || [])[0]?.iata === "ORD");

/* Four-letter words that merely LOOK like codes must still be their city. This is what the
   K-prefix shortcut would have broken. */
ok("PISA is Pisa",  (g.__searchLocal("PISA", null) || [])[0]?.name === "Pisa");
ok("CORK is Cork",  (g.__searchLocal("CORK", null) || [])[0]?.name === "Cork");
ok("KOLN is Köln",  /K[oö]ln/.test((g.__searchLocal("KOLN", null) || [])[0]?.name || ""));

/* Proximity still has to work — the anchor is what keeps Portland in Oregon (see pickPlace). */
const nearPdx = g.__searchLocal("portland", { lat: 45.52, lng: -122.68 }) || [];
ok("the near-anchor still steers an ambiguous city",
   nearPdx.length > 0 && Math.abs(nearPdx[0].lat - 45.52) < 1);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
