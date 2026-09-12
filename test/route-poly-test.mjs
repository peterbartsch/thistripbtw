/* D-110 + §2ae(d): the encoded-polyline decoder and the great-circle arc, now in ONE file.
 *
 * This test was written when there were TWO of each — app.html and new.html cannot import from
 * each other, so anything both needed was copied, and copies drift. It pinned the two decoders
 * byte-for-byte so that a fix to one that missed the other failed here rather than on somebody's
 * phone halfway to Reno.
 *
 * That defence was the smoke, not the fire. On 2026-08-07 `arcPoints` — the OTHER duplicated
 * function, which had no such pin — was found drawing flight paths 36° off a Los Angeles → Tokyo
 * great circle, and had to be fixed twice because there were two of it. Both now live in
 * `public/legs.js`, the way `ring.js` and `places.js` already did, so the test changes shape: it
 * no longer compares two copies, it asserts there is only one and checks it.
 *
 * The decoder is checked against Google's own published test vector rather than against output I
 * generated, because a decoder tested with its own encoder agrees with itself about being wrong.
 * The arc is checked against a geodesic written fresh here, for the same reason.
 *
 * Run: node test/route-poly-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const app  = readFileSync(root + "public/app.html", "utf8");
const nw   = readFileSync(root + "public/new.html", "utf8");
const legs = readFileSync(root + "public/legs.js",  "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* ── there must be exactly ONE of each, and both pages must load it ─────────────────── */
for (const [name, src] of [["app.html", app], ["new.html", nw]]) {
  ok(`${name} does not carry its own decodePoly`, !/function\s+decodePoly\s*\(/.test(src));
  ok(`${name} does not carry its own arcPoints`,  !/function\s+arcPoints\s*\(/.test(src));
  ok(`${name} loads legs.js`, /src="\/legs\.js/.test(src));
}
ok("legs.js defines both", /function\s+decodePoly\s*\(/.test(legs) && /function\s+arcPoints\s*\(/.test(legs));

const mod = {};
new Function("window", legs + "\n")(mod);
const { decodePoly, arcPoints } = mod;
ok("and exports them on window", typeof decodePoly === "function" && typeof arcPoints === "function");

/* ── Google's published test vector ─────────────────────────────────────────────────── */
const VECTOR = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const EXPECT = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
const got = decodePoly(VECTOR);
ok("the reference vector decodes to the right number of points", !!got && got.length === 3);
ok("and to the right coordinates, to full precision",
   !!got && got.every((p, i) => Math.abs(p[0] - EXPECT[i][0]) < 1e-9 &&
                                Math.abs(p[1] - EXPECT[i][1]) < 1e-9));

/* Deltas accumulate, so an error in point 2 silently poisons every point after it. Check the
   LAST point specifically — a decoder that resets its accumulator passes on point 1 alone. */
ok("the final point is right, which is what proves deltas accumulate",
   !!got && Math.abs(got[2][0] - 43.252) < 1e-9 && Math.abs(got[2][1] + 126.453) < 1e-9);

/* Negative deltas take the zigzag branch (`~(r>>1)`) — the second point moves north and WEST,
   so both signs are exercised above; assert it explicitly so a sign flip is named. */
ok("a negative longitude delta decodes as negative", !!got && got[1][1] < got[0][1]);
ok("a positive latitude delta decodes as positive",  !!got && got[1][0] > got[0][0]);

/* ── the shapes that arrive when something upstream went wrong ──────────────────────── */
ok("null in, null out",            decodePoly(null) === null);
ok("undefined in, null out",       decodePoly(undefined) === null);
ok("empty string in, null out",    decodePoly("") === null);
ok("a non-string in, null out",    decodePoly([[1, 2]]) === null && decodePoly(42) === null);
/* Must TERMINATE rather than spin: charCodeAt past the end is NaN, NaN >= 32 is false, so the
   inner do/while exits. Worth pinning — an infinite loop here freezes the map thread. */
let finished = false;
try { decodePoly("~~~"); finished = true; } catch (e) { finished = true; }
ok("malformed input terminates instead of hanging", finished);

/* ── a real road, at the fidelity that was the whole point ──────────────────────────── */
/* Chicago→Omaha at overview=simplified was 22 points for 470 miles and drew as a bent straight
   line. This is a genuine OSRM `full` response, truncated to its first 40 characters — enough
   to prove the decoder handles a long real string and that consecutive points are CLOSE
   together, which is what "follows the road" actually means. */
const REAL = "_kn~Fnb|uOfBlUp@lIvClb@`@lFj@nHh@bH^dFj@bIn@|I";
const road = decodePoly(REAL);
ok("a real OSRM fragment decodes", !!road && road.length > 5);
ok("consecutive points are metres apart, not degrees — this is road shape, not a straight line",
   !!road && road.every((p, i) => i === 0 ||
     Math.hypot(p[0] - road[i - 1][0], p[1] - road[i - 1][1]) < 0.05));
ok("every point is a plausible coordinate",
   !!road && road.every(p => p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180));

/* ── the server must not still be asking for the decimated geometry ─────────────────── */
const php = readFileSync(root + "lib/routing.php", "utf8");
/* Read the line that BUILDS the URL, not the file — the comment above it names the old value
   on purpose, to explain why it changed, and a whole-file grep flagged that as the bug. */
const urlLine = (php.match(/^\s*\$url = .*$/m) || [""])[0];
ok("the request URL was found in routing.php", urlLine.includes("RT_HOST"));
ok("the server asks OSRM for FULL geometry", urlLine.includes("overview=full"));
ok("and never for simplified again",         !urlLine.includes("overview=simplified"));
ok("and asks for it encoded",                urlLine.includes("geometries=polyline"));
ok("the cache key was bumped past the v1 arrays", php.includes("'v2|'"));

/* Both clients must read the new key. Reading `d.path` would silently draw nothing. */
ok("app.html reads d.poly", /typeof d\.poly==="string"/.test(app));
ok("new.html reads d.poly", /typeof d\.poly==="string"/.test(nw));
ok("neither client still reads d.path",
   !/d\s*&&\s*d\.path/.test(app) && !/d&&d\.path/.test(nw));

/* ── coordinate ORDER, both clients ──────────────────────────────────────────────────── */
/* The bug this catches shipped for weeks and was invisible. `pts` are Leaflet pairs — [lat,lng]
   — and app.html built "lng,lat" because that is OSRM's order and the browser used to call
   OSRM directly. Item 14 put our own endpoint in front and ours takes lat,lng. new.html was
   updated; app.html was not, so every request arrived with lat=-122, failed rt_route()'s range
   check, and came back null. null means "no road exists", so the map drew its dashed
   straight-line fallback — it looked unfinished, not broken, and nobody could tell the
   difference. Road routing never once worked in the trip view.
   Assert the ORDER, because a passing round-trip test would not have caught this: the request
   was well-formed, just backwards. */
const appReq = (app.match(/const coords=pts\.map\([^)]*\)/) || [""])[0];
const newReq = (nw.match(/pts\.map\(p=>p\[\d\]\+","\+p\[\d\]\)/) || [""])[0];
ok("app.html sends lat,lng (p[0] then p[1]) — NOT OSRM's lng,lat",
   /p\[0\]\s*\+\s*","\s*\+\s*p\[1\]/.test(appReq));
ok("new.html sends lat,lng too", /p\[0\]\+","\+p\[1\]/.test(newReq));
ok("both clients agree on the order", !!appReq && !!newReq);

/* And the server must actually REJECT the flipped form, so a future flip fails loudly here
   rather than degrading into a dashed line nobody reads as a defect. */
ok("the server range-checks latitude, which is what made the flip silent",
   /\$lat < -90 \|\| \$lat > 90/.test(php));

/* ── the arc is a GREAT CIRCLE (§2ae c) ─────────────────────────────────────────────────
   The bug this pins: arcPoints was a quadratic Bezier in raw lat/lng with a fixed perpendicular
   offset. It looks like a flight path on a short domestic leg and is wildly wrong on a long one,
   and it bowed the WRONG WAY — the control point for Chicago→London sat SOUTH of both ends while
   the true route runs north over Greenland. A reference geodesic is written here rather than
   reused from the source, so the test cannot agree with the source about being wrong. */
function geodesic(a, b, steps = 40) {
  const R = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a[0]*R, a[1]*R, b[0]*R, b[1]*R];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2-la1)/2)**2 +
            Math.cos(la1)*Math.cos(la2)*Math.sin((lo2-lo1)/2)**2));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i/steps, A = Math.sin((1-f)*d)/Math.sin(d), B = Math.sin(f*d)/Math.sin(d);
    const x = A*Math.cos(la1)*Math.cos(lo1) + B*Math.cos(la2)*Math.cos(lo2);
    const y = A*Math.cos(la1)*Math.sin(lo1) + B*Math.cos(la2)*Math.sin(lo2);
    const z = A*Math.sin(la1) + B*Math.sin(la2);
    out.push([Math.atan2(z, Math.hypot(x,y))/R, Math.atan2(y,x)/R]);
  }
  return out;
}
const ROUTES = [
  ["Chicago→London", [41.88,-87.63], [51.51,-0.13]],
  ["LA→Tokyo",       [34.05,-118.24], [35.68,139.65]],
  ["Chicago→Reno",   [41.97,-87.90], [39.50,-119.77]],
];
for (const [name, a, b] of ROUTES) {
  const got = arcPoints(a, b), want = geodesic(a, b);
  const err = Math.max(...got.map((p, i) => Math.abs(p[0] - want[i][0])));
  ok(`${name} follows the great circle (max latitude error ${err.toExponential(1)}°)`, err < 1e-9);
}
/* Chicago→London specifically: the Bezier put the midpoint at 38.8°N, SOUTH of both endpoints.
   A great circle puts it at 55.7°N, north of both. Pin the direction, not just the distance. */
{
  const mid = arcPoints([41.88,-87.63], [51.51,-0.13])[20][0];
  ok("Chicago→London bows NORTH of both ends, as a real flight does", mid > 51.51);
}
/* LA→Tokyo crosses the antimeridian. Handing Leaflet a jump from +179 to -179 draws a line
   straight back across the whole map, so longitudes must be unwrapped and continuous. */
{
  const lngs = arcPoints([34.05,-118.24], [35.68,139.65]).map(p => p[1]);
  const jump = Math.max(...lngs.slice(1).map((v, i) => Math.abs(v - lngs[i])));
  ok(`LA→Tokyo longitudes stay continuous across the antimeridian (max step ${jump.toFixed(1)}°)`, jump < 20);
}
ok("two identical points do not divide by zero", arcPoints([10,10],[10,10]).length === 2);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
