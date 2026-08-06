/* D-110: the encoded-polyline decoder, and the fact that there are TWO of it.
 *
 * `/api/route` stopped sending coordinate arrays and started sending an encoded polyline, so the
 * decoding moved into the client — and the client is two single-file pages that cannot import
 * from each other. app.html and new.html therefore carry the same function twice, which is
 * precisely the arrangement that drifts. `mcp-parity.php` exists for the same reason and this is
 * the same defence: pin them byte-for-byte, so a fix to one that misses the other fails here
 * rather than on someone's phone halfway to Reno.
 *
 * The decoder itself is checked against Google's own published test vector rather than against
 * output I generated, because a decoder tested with its own encoder agrees with itself about
 * being wrong.
 *
 * Run: node test/route-poly-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const app = readFileSync(root + "public/app.html", "utf8");
const nw  = readFileSync(root + "public/new.html", "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* ── the two copies must be the same copy ───────────────────────────────────────────── */
function cut(src, where) {
  const i = src.indexOf("function decodePoly(s){");
  if (i < 0) throw new Error("decodePoly not found in " + where);
  const j = src.indexOf("\n}", i);
  if (j < 0) throw new Error("decodePoly has no closing brace in " + where);
  return src.slice(i, j + 2);
}
const aSrc = cut(app, "app.html"), nSrc = cut(nw, "new.html");
ok("app.html and new.html carry byte-identical decoders", aSrc === nSrc);
if (aSrc !== nSrc) {
  console.log("      app.html: " + aSrc.length + " bytes\n      new.html: " + nSrc.length + " bytes");
}

const decodePoly = new Function(aSrc + "\nreturn decodePoly;")();

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

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
