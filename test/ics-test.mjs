/* D-102: .ics in. The real functions, out of new.html.
 *
 * Two things carry the risk. Unfolding — RFC 5545 wraps long lines and continues them with a
 * leading space, so a real address arrives split in three and a parser that reads before
 * unfolding truncates it silently. And the DATE, which has hurt this codebase three times
 * (R2, D-089, D-092): `20260904T140000Z` parsed as a Date and formatted locally prints the 3rd
 * in any negative-offset zone. Run under TZ=America/Los_Angeles so that failure is caught here
 * rather than by someone in California.
 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");
/* Pull a whole top-level function out by name: everything from its signature to the first
   closing brace in column 0. Fragile only if the source stops being formatted that way, in
   which case this throws loudly rather than testing a stale copy. */
const cut = (label) => {
  const i = src.indexOf(label);
  if (i < 0) throw new Error("not found in new.html: " + label);
  const j = src.indexOf("\n}", i);
  return src.slice(i, j + 2);
};
const grab = n => cut("function " + n + "(");
const async_grab = n => cut("async function " + n + "(");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); } else { fail++; console.log("  FAIL " + w); } };

const { parseIcs, icsDate, icsToDraft } = new Function(
  [grab("icsUnfold"), grab("icsText"), grab("icsDate"), grab("parseIcs"), async_grab("icsToDraft")].join("\n") +
  "\nreturn {parseIcs, icsDate, icsToDraft};")();

ok("running in a negative-offset zone, where the date bug shows",
   new Date().getTimezoneOffset() > 0);

/* ── the date, all three forms ──────────────────────────────────────────────────────── */
ok("a date-only DTSTART is the day it says",       icsDate("20260904") === "2026-09-04");
ok("a UTC timestamp keeps its UTC date",           icsDate("20260904T140000Z") === "2026-09-04");
ok("and a UTC time that is EVENING in UTC does not slip back a day locally",
   icsDate("20260904T233000Z") === "2026-09-04");
ok("a zoned wall-clock keeps the digits as written", icsDate("20260904T060000") === "2026-09-04");
ok("garbage yields no date rather than a wrong one",
   icsDate("") === "" && icsDate("not a date") === "" && icsDate(null) === "");
ok("an impossible month is refused",               icsDate("20261304") === "");

/* ── unfolding ──────────────────────────────────────────────────────────────────────── */
const FOLDED = [
  "BEGIN:VCALENDAR", "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260904",
  "SUMMARY:Check in",
  /* Folded the way real producers fold: at exactly 75 octets, wherever that lands — MID-WORD.
     The leading space is the fold marker and is NOT part of the value, so rejoining must be
     seamless. My first fixture split at word boundaries and expected a space back, which made
     a correct parser look broken. The instrument, not the product — again. */
  "LOCATION:1600 Amphitheatre Parkway\\, Mo",
  " untain View\\, CA 94043\\, United States o",
  " f America",
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const folded = parseIcs(FOLDED);
ok("a folded LOCATION is rejoined, not truncated",
   folded[0].location === "1600 Amphitheatre Parkway, Mountain View, CA 94043, United States of America");
ok("escaped commas are unescaped", !folded[0].location.includes("\\,"));

/* ── ordering and selection ─────────────────────────────────────────────────────────── */
const CAL = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "DTSTART:20260906T140000Z", "SUMMARY:Denver", "LOCATION:Denver, CO", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260904", "SUMMARY:Omaha", "LOCATION:Omaha, NE", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:Somewhere undated", "LOCATION:Lincoln, NE", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260905", "SUMMARY:With coords", "GEO:41.0;-96.0", "END:VEVENT",
  "BEGIN:VTODO", "SUMMARY:not an event", "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");
const evs = parseIcs(CAL);
ok("only VEVENTs are read — a VTODO is not a stop", evs.length === 4);
ok("dated events come out in date order",
   evs[0].summary === "Omaha" && evs[1].summary === "With coords" && evs[2].summary === "Denver");
ok("an undated event holds its place behind the dated ones, it does not vanish",
   evs[3].summary === "Somewhere undated");
ok("GEO is read when it is there", evs[1].geo.lat === 41 && evs[1].geo.lng === -96);
ok("an empty calendar yields nothing rather than throwing", parseIcs("").length === 0);

/* ── the draft, with the geocoder injected ──────────────────────────────────────────── */
const fake = async (q) => /denver/i.test(q) ? { lat: 39.7392, lng: -104.9903 }
                        : /omaha/i.test(q)  ? { lat: 41.2565, lng: -95.9345 }
                        : null;                       // Lincoln is unresolvable, on purpose

const d = await icsToDraft(evs, fake);
ok("the first placed event is the ORIGIN, not a leg", d.routes[0].origin.name === "Omaha");
ok("and the rest are legs in order",
   d.routes[0].legs.length === 2 &&
   d.routes[0].legs[0].to.name === "With coords" &&
   d.routes[0].legs[1].to.name === "Denver");
ok("GEO is used directly rather than geocoded", d.routes[0].legs[0].to.lat === 41);
ok("dates survive onto the legs", d.routes[0].legs[1].date === "2026-09-06");
ok("the location becomes the note when the summary is the title",
   d.routes[0].legs[1].note === "Denver, CO");

/* Peter's call: drop it, and NAME it. A count is something to worry about; a list is
   something to act on. */
ok("an event with no findable place is dropped", d.dropped.length === 1);
ok("and it is named, not counted", d.dropped[0] === "Somewhere undated");
ok("nothing unplaceable leaks into the route",
   !JSON.stringify(d.routes).includes("Somewhere undated"));

const none = await icsToDraft(parseIcs(
  "BEGIN:VEVENT\r\nSUMMARY:Nowhere\r\nLOCATION:Nowhere at all\r\nEND:VEVENT"), fake);
ok("a calendar where nothing resolves returns no routes rather than an empty trip",
   none.routes === null && none.dropped.length === 1);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
