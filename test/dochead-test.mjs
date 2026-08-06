/* The document header's date span (#15), against the real functions out of app.html.
 *
 * Date arithmetic is the one thing that has actually gone wrong in this codebase — R2 was an
 * unscaled longitude, D-089 was a replay window that ended a day early, D-092 was cos(latitude)
 * again. Every genuine defect the 2026-07-30 audit found came out of maths, and every false one
 * came out of staging an interaction. So this stages nothing: it extracts docDate/docSpan and
 * runs them.
 *
 * The specific trap: a stop's `date` is "YYYY-MM-DD" with no time and no zone. `new Date(str)`
 * parses that as UTC midnight, and formatting it in any zone west of Greenwich prints the day
 * BEFORE. A trip starting on the 4th would have read "3–7 Sep" for every customer in the
 * Americas — plausible enough to ship and wrong for the majority of them. The functions split
 * the string by hand and pin timeZone:"UTC"; these run under TZ=America/Los_Angeles to prove it.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const grab = (name) => {
  const m = src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}", "m"));
  if (!m) throw new Error("could not extract " + name + " from app.html");
  return m[0];
};
const { docDate, docSpan, docPlace } = new Function(
  grab("docDate") + "\n" + grab("docSpan") + "\n" + grab("docPlace")
  + "\nreturn {docDate, docSpan, docPlace};")();

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log("  ok   " + what); }
                             else      { fail++; console.log("  FAIL " + what); } };

ok("the test runs in a negative-offset zone, or it proves nothing",
   new Date().getTimezoneOffset() > 0);

/* The day must survive formatting. This is the whole point. */
ok('a single date keeps its day number west of Greenwich',
   docSpan(["2026-09-04"]).startsWith("4 ") || docSpan(["2026-09-04"]).includes("Sep 4"));
ok('a span keeps BOTH day numbers',
   /\b4\b/.test(docSpan(["2026-09-04", "2026-09-07"])) &&
   /\b7\b/.test(docSpan(["2026-09-04", "2026-09-07"])));

/* Shape. The FIRST version of docSpan built these strings by hand and produced "4–Sep 7, 2026"
   in en-US, because a day-only format and a full format order differently — and the first
   version of THIS test passed it, because it only asserted that "Sep" appeared once, which was
   true of the broken string. Assert the whole string now, not a property of it. */
const same  = docSpan(["2026-09-04", "2026-09-07"]);
const cross = docSpan(["2026-08-28", "2026-09-03"]);
const years = docSpan(["2026-12-30", "2027-01-02"]);
const one   = docSpan(["2026-09-04"]);
/* NOTE the separator. formatRange joins with U+2009 THIN SPACE, U+2013 EN DASH, U+2009 — not
   spaces and a hyphen. Written as escapes here because the two render identically and an
   assertion you cannot read is one somebody "fixes" by pasting a normal space back in. */
const R = "\u2009\u2013\u2009";
ok('within one month: "Sep 4' + R + '7, 2026" (got "' + same + '")',   same === "Sep 4" + R + "7, 2026");
ok('across months: "Aug 28' + R + 'Sep 3, 2026" (got "' + cross + '")', cross === "Aug 28" + R + "Sep 3, 2026");
ok('across years (got "' + years + '")', years === "Dec 30, 2026" + R + "Jan 2, 2027");
ok("the separator really is thin-space en-dash thin-space, not a hyphen",
   same.includes(R) && !same.includes(" - "));
ok('one date is not rendered as a range (got "' + one + '")',    one === "Sep 4, 2026");
ok('an identical pair collapses to one date too',
   docSpan(["2026-09-04", "2026-09-04"]) === "Sep 4, 2026");

/* Order must not depend on the caller: pins arrive in travel order, which is not date order
   when a stop is undated and inherits from the last dated one in its own track. */
ok("dates are sorted, not taken as given",
   docSpan(["2026-09-07", "2026-09-04"]) === docSpan(["2026-09-04", "2026-09-07"]));

/* An undated trip is legal — /quick makes them — and must produce no span rather than "Invalid
   Date", which is what a naive implementation prints in a header a customer is looking at. */
ok("no dates at all yields an empty span, not Invalid Date", docSpan([]) === "");
ok("undated stops are ignored rather than parsed", docSpan(["", null, undefined]) === "");
ok("a mix keeps only the real dates", docSpan(["", "2026-09-04", null]).includes("4"));
ok("a malformed date does not throw", (() => { try { docSpan(["nope"]); return true; }
                                              catch (e) { return false; } })());
ok("docDate refuses a malformed string rather than returning Invalid Date",
   docDate("nope") === null && docDate("2026-09-04") instanceof Date);
ok("docDate builds the day in UTC, not local",
   docDate("2026-09-04").toISOString().startsWith("2026-09-04T00:00:00"));

/* docPlace — added 2026-08-02 after a photo of a real phone. The header printed whole stop
   TITLES, and the convention in this product is "PLACE — note", so the live demo's header read
   "San Francisco — load up, coffee, go → Reno airport — Jordan's later flight, 6p" over three
   lines and pushed the tabs off the screen. These are that trip's actual titles. */
ok('a title with a note keeps only the place',
   docPlace("San Francisco — load up, coffee, go") === "San Francisco");
ok('and so does the other end of the same trip',
   docPlace("Reno airport — Jordan’s later flight, 6p") === "Reno airport");
ok('a hyphen with spaces counts too', docPlace("Moab - the arches one") === "Moab");
ok('a plain place is untouched',      docPlace("Denver, CO") === "Denver, CO");
ok('a hyphenated NAME is not a note separator — no spaces around it',
   docPlace("Winston-Salem, NC") === "Winston-Salem, NC");
ok('an em dash with no spaces is left alone too', docPlace("Baden—Baden") === "Baden—Baden");
ok('a long place is clamped at a word boundary, with an ellipsis',
   docPlace("Grand Teton National Park Visitor Center").length <= 27 &&
   docPlace("Grand Teton National Park Visitor Center").endsWith("…") &&
   !docPlace("Grand Teton National Park Visitor Center").includes(" …"));
ok('a long unbroken string is still cut rather than overflowing',
   docPlace("A".repeat(60)).length === 27);
ok('empty and missing are empty', docPlace("") === "" && docPlace(null) === "" && docPlace(undefined) === "");

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
