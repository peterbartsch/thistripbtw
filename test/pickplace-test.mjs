/* pickPlace: the choice that turned "drive to portland" into Unorganized Kenora District.
 *
 * The bug was nearest-to-anchor. It was written to stop Nominatim putting "Reno" in Germany, and
 * it did — by putting it in Kansas. Distance alone always returns something, so a tiny nearby
 * administrative area beat a major city every time, and the chat presented the result with total
 * confidence. A wrong trip that looks right is worse than an error.
 *
 * This extracts the REAL function out of new.html rather than restating it — a restated copy
 * keeps passing after the source drifts — and runs it against candidate lists captured from the
 * live geocoder, with the anchor at the default map centre an empty draft actually uses.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");
const m = src.match(/const GEO_DIST_DIVISOR = \d+;\nfunction pickPlace\(cands, near\)\{[\s\S]*?\n\}/);
let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log("  ok   " + what); }
                             else      { fail++; console.log("  FAIL " + what); } };

ok("pickPlace was found in new.html", !!m);
if (!m) { console.log("\n1 failed"); process.exit(1); }
const pickPlace = new Function(m[0] + "; return pickPlace;")();

/* Captured from /api/geocode on 2026-08-02. Real importances, real coordinates. */
const PORTLAND = [
  { lat: 45.5202471, lon: -122.674194, importance: 0.7099, name: "Portland, Multnomah County" },
  { lat: 43.6573605, lon: -70.2586618, importance: 0.6039, name: "Portland, Cumberland County" },
  { lat: 27.8818828, lon: -97.3188666, importance: 0.4728, name: "Portland, San Patricio County" },
  { lat: -38.3462, lon: 141.6017, importance: 0.4520, name: "Portland, Victoria" },
];
const RENO = [
  { lat: 50.0,       lon: 7.0,          importance: 0.7180, name: "Rhine, Germany" },
  { lat: 39.5261206, lon: -119.8126581, importance: 0.6170, name: "Reno, Washoe County" },
  { lat: 37.9,       lon: -98.0,        importance: 0.5410, name: "Reno County, Kansas" },
  { lat: 32.9,       lon: -97.6,        importance: 0.4750, name: "Reno, Parker County" },
];

const US = { lat: 39.5, lng: -98.35 };          // the default map centre on an empty draft
const PNW = { lat: 45.5, lng: -122.6 };         // someone already drafting in the Pacific NW

ok('"portland" from the US centre resolves to OREGON, not Texas',
   pickPlace(PORTLAND, US).lat.toFixed(2) === "45.52");
ok('"reno" from the US centre resolves to NEVADA, not Kansas or Germany',
   pickPlace(RENO, US).lat.toFixed(2) === "39.53");
ok('"reno" still refuses Germany — the reason the anchor exists at all',
   Math.abs(pickPlace(RENO, US).lng + 119.81) < 0.01);

/* The anchor must still win between candidates of COMPARABLE standing — that is its whole job.
   It must NOT override a large importance gap: someone drafting in Portland who types "London"
   means England, not London, Ontario. An earlier version of this test asserted the opposite and
   was wrong about what good behaviour is. */
ok("between comparable candidates, the nearer one wins",
   pickPlace([{ lat: 45.52, lon: -122.67, importance: 0.50, name: "near" },
              { lat: 51.50, lon: -0.12,   importance: 0.55, name: "far" }], PNW).lat === 45.52);
ok("a far, much more important place still wins — the anchor is a nudge, not a veto",
   pickPlace([{ lat: 45.52, lon: -122.67, importance: 0.30, name: "near, obscure" },
              { lat: 51.50, lon: -0.12,   importance: 0.85, name: "far, famous" }], PNW).lat === 51.50);

/* Longitude must be scaled by cos(latitude), or east-west distance is overstated. R2 was this
   same error in app.html. At 60°N a degree of longitude is half a degree of latitude. */
const HIGH = { lat: 60, lng: 0 };
ok("longitude is scaled by cos(latitude), not treated as equal to latitude",
   pickPlace([{ lat: 60, lon: 8, importance: 0.5, name: "8 deg east" },
              { lat: 55, lon: 0, importance: 0.5, name: "5 deg south" }], HIGH).lng === 8);

ok("no anchor falls back to importance", pickPlace(PORTLAND, null).lat.toFixed(2) === "45.52");
ok("an empty list returns null", pickPlace([], US) === null);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
