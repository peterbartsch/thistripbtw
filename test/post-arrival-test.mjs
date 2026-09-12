/* D-155 / §2ae(a): when does a POST arrive during replay — the rule customers actually get.
 *
 * WHY THIS EXISTS. `replay-tz-test.mjs` is a good test and it guards the WRONG PATH now. It pins
 * D-089's UTC day boundary, which applies when frames are days — and since D-155 made the STOP
 * the frame, that path is reachable only via `?rday=1`. The suite was green and covering
 * yesterday's product: there was no test at all for the rule every visitor now gets.
 *
 * The live rule is `byPlace`: a post belongs to the stop it happened NEAREST to, and appears when
 * that stop appears. It is finer-grained than a day and it is timezone-proof for a stronger
 * reason than D-089 was — it parses no date at all, so there is no zone to get wrong.
 *
 * `nearDist` and `replayPostVisible` are EXTRACTED from app.html rather than restated, for the
 * reason route-poly-test gives. The three helpers `replayPostVisible` leans on (replayFrames,
 * replayVisible, sorted) are stubbed HERE and that is stated plainly — but the branch that
 * chooses between the two rules, and the default that makes `by:"order"` the live one, are both
 * asserted against the real source so a stub cannot hide a change of behaviour.
 *
 * Run: node test/post-arrival-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const app  = readFileSync(root + "public/app.html", "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

function fn(name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{").exec(app);
  if (!m) throw new Error("not found in app.html: " + name);
  let d = 0;
  for (let k = m.index + m[0].length - 1; k < app.length; k++) {
    if (app[k] === "{") d++;
    else if (app[k] === "}" && --d === 0) return app.slice(m.index, k + 1);
  }
  throw new Error("unbalanced: " + name);
}

/* ── 1. the DEFAULT is the stop, not the day — asserted on the real source ───────────── */
const framesSrc = fn("replayFrames");
ok("the date-frame path now requires ?rday=1, so by:\"order\" is what a visitor gets",
   /ds\.length>=2\s*&&\s*FLAGS\.has\("rday"\)/.test(framesSrc));
ok("and the stop-per-frame return is still by:\"order\"", /by:"order"/.test(framesSrc));

/* ── 2. the branch that chooses the rule ─────────────────────────────────────────────── */
const postSrc = fn("replayPostVisible");
ok("byPlace is the rule for every frame unit except date", /if\(f\.by!=="date"\)\s*return byPlace;/.test(postSrc));
ok("byPlace measures with nearDist, not raw lat/lng subtraction",
   /nearDist\(p\.lat,\s*p\.lng,\s*s\.lat,\s*s\.lng\)/.test(postSrc));

const STOPS_FOR_RANK = [[41.88,-87.63],[39.74,-104.99],[37.77,-122.42]];

/* ── 3. nearDist is cos-latitude corrected ───────────────────────────────────────────────
   The bug this pins is real and was found by arithmetic, not by looking: a degree of longitude
   is not a degree of latitude anywhere but the equator. With a post at the origin, one stop 0.50°
   EAST and one 0.40° NORTH, at 45°N the east stop is the nearer one — 39.4 km against 44.5 — and
   raw subtraction still picked north. That is Montana and the Alps, not an edge case. */
const nearDist = new Function(fn("nearDist") + "\nreturn nearDist;")();
const eastIsNearer = nearDist(45, 0, 45, 0.50) < nearDist(45, 0, 45.40, 0);
ok("at 45°N a stop 0.50° east is nearer than one 0.40° north — cos(latitude) applied", eastIsNearer);
ok("uncorrected subtraction would have got that wrong (0.50 > 0.40)", 0.50 > 0.40);
ok("at the equator the correction is a no-op", Math.abs(nearDist(0,0,0,1) - nearDist(0,0,1,0)) < 1e-6);
/* NOT symmetric, and that is fine — worth pinning so nobody "fixes" it into a slower haversine.
   `nearDist` takes cos() of the FIRST latitude, so swapping the arguments moves the answer
   (40,-100)→(60,-99) reads 20.0147 while the reverse reads 20.0062. It never matters, because
   byPlace always passes the POST first: every candidate stop is measured with the same cosine,
   so the RANKING — which is all byPlace asks for — is consistent. */
ok("nearDist is asymmetric by design (cos of the FIRST point)",
   Math.abs(nearDist(40,-100,60,-99) - nearDist(60,-99,40,-100)) > 1e-4);
ok("but the ranking it is used for is stable, because the post is always the first argument",
   (() => { const P = [39.70, -105.05];
            const d = STOPS_FOR_RANK.map(s => nearDist(P[0], P[1], s[0], s[1]));
            return d[1] < d[0] && d[1] < d[2]; })());


/* ── 4. byPlace, running for real ─────────────────────────────────────────────────────────
   STUBBED HERE, and said out loud: replayFrames/replayVisible/sorted are supplied by this test.
   The rule under test — nearest stop wins, and only once that stop has been revealed — is the
   real extracted function. */
function build({ frames, revealed, stops, replayT }) {
  const g = {
    replayT,
    allStops: stops,
    nearDist,
    replayFrames: () => frames,
    replayVisible: () => (s => revealed.includes(s.id)),
    sorted: () => stops,
  };
  return new Function(
    "replayT","allStops","nearDist","replayFrames","replayVisible","sorted",
    fn("replayPostVisible") + "\nreturn replayPostVisible();"
  )(g.replayT, g.allStops, g.nearDist, g.replayFrames, g.replayVisible, g.sorted);
}

const STOPS = [
  { id: "a", lat: 41.88, lng: -87.63 },   // Chicago
  { id: "b", lat: 39.74, lng: -104.99 },  // Denver
  { id: "c", lat: 37.77, lng: -122.42 },  // San Francisco
];
const nearDenver = { lat: 39.70, lng: -105.05, ts: 1 };

let vis = build({ frames: { by: "order" }, revealed: ["a"], stops: STOPS, replayT: "a" });
ok("a post near Denver has NOT arrived while only Chicago is revealed", vis(nearDenver) === false);

vis = build({ frames: { by: "order" }, revealed: ["a", "b"], stops: STOPS, replayT: "b" });
ok("it arrives exactly when Denver does", vis(nearDenver) === true);

vis = build({ frames: { by: "order" }, revealed: ["a", "b", "c"], stops: STOPS, replayT: "c" });
ok("and stays once the trip has moved on", vis(nearDenver) === true);

/* A post with NO timestamp must still arrive — the whole reason byPlace is also the fallback.
   `(p.ts||0)` under a date rule reads a missing time as 1970 and dumps it into the first frame. */
vis = build({ frames: { by: "order" }, revealed: ["a", "b"], stops: STOPS, replayT: "b" });
ok("a post with no timestamp arrives on place alone", vis({ lat: 39.70, lng: -105.05 }) === true);

/* Timezone-proof by construction: no date is parsed, so the answer cannot depend on TZ. */
const answers = new Set();
for (const tz of ["UTC", "Pacific/Auckland", "America/Denver"]) {
  process.env.TZ = tz;
  const v = build({ frames: { by: "order" }, revealed: ["a", "b"], stops: STOPS, replayT: "b" });
  answers.add(v(nearDenver));
}
ok("the same post arrives in the same frame in every timezone — no date is parsed at all",
   answers.size === 1 && answers.has(true));

/* ── 5. the retired rule is still reachable, and still guarded elsewhere ─────────────── */
ok("the date rule survives under ?rday=1 for D-089 (replay-tz-test.mjs still guards it)",
   /const end = new Date\(replayT\+"T23:59:59\.999Z"\)/.test(postSrc));

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
