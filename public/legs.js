/* legs.js — the leg geometry both single-file pages need, in one place.
 *
 * WHY THIS FILE EXISTS. app.html and new.html cannot import from each other, so anything both
 * need has been copied into both, and copies drift. On 2026-08-07 that cost real money twice in
 * one day: `arcPoints` drew flight paths as a decorative Bézier that was **36° wrong** on a
 * Los Angeles → Tokyo route, and it had to be found and fixed TWICE because there were two of
 * it. The same afternoon, the two pages' lists of which leg modes could be traced had drifted in
 * OPPOSITE directions — app.html offered a bike route it would never draw, new.html would draw a
 * ferry route it never offered.
 *
 * `route-poly-test.mjs` was already written as a defence against exactly this, pinning the two
 * decoders byte-for-byte. That test is the smoke, not the fire. This is the fire put out:
 * ring.js and places.js were extracted for the same reason and neither has drifted since.
 *
 * 2026-08-08 it also carries how a leg is PAINTED, not only where it runs. D-159 gives every
 * transit mode its own colour and its own dash, and that table was about to be typed into both
 * pages — the precise setup that produced the arcPoints and canTrace divergences above. A
 * palette is not geometry, but it is page-state-free and it is needed identically in both files,
 * which is the test this module actually applies.
 *
 * WHAT BELONGS HERE: pure geometry with no page state — no map, no DOM, no API_BASE, no slug.
 * What does NOT: `fetchRoute` (app.html routes leg-by-leg during replay and schedules its own
 * redraw), `revName` (app.html lives under /{slug}/ and needs API_BASE; new.html does not), and
 * `drawMap`/`render`, which merely SHARE A NAME — app.html's drawMap is 14,091 bytes against
 * new.html's 267 and they are unrelated functions. Moving those would be a bug, not a cleanup.
 */
(function (global) {
  "use strict";

  /* Encoded polyline → [[lat,lng],…] (D-110). The server sends `geometries=polyline` because the
     same road is 15.9 KB encoded against 120.3 KB as coordinate pairs. Google's algorithm: each
     number is a zigzag-encoded delta from the previous one, sliced into 5-bit chunks low-first,
     every chunk but the last carrying bit 6, and 63 added so the result is printable ASCII.
     Precision 5 — hence 1e5. */
  function decodePoly(s){
    if(typeof s!=="string"||!s) return null;
    const out=[]; let i=0,lat=0,lng=0;
    while(i<s.length){
      let r=0,sh=0,b;
      do{ b=s.charCodeAt(i++)-63; r|=(b&31)<<sh; sh+=5; }while(b>=32);
      lat+=(r&1)?~(r>>1):(r>>1);
      r=0;sh=0;
      do{ b=s.charCodeAt(i++)-63; r|=(b&31)<<sh; sh+=5; }while(b>=32);
      lng+=(r&1)?~(r>>1):(r>>1);
      out.push([lat/1e5,lng/1e5]);
    }
    return out.length?out:null;
  }

  /* A GREAT CIRCLE, not a bow. Peter, 2026-08-07: "air routes should always follow the great
     circle route" — and this was a quadratic Bezier in raw lat/lng with a fixed perpendicular
     offset, which is a decoration that happens to look like a flight path on short domestic legs
     and is wildly wrong on long ones. Measured against the real geodesic:
       Chicago -> London   midpoint 38.8N  vs  55.7N   — 16.8 degrees out, and bowing SOUTH when
                                                         the true route goes north over Greenland
       LA -> Tokyo         midpoint 11.7N  vs  47.9N   — 36.3 degrees out, drawn through the
                                                         tropics instead of the Aleutians
       Chicago -> Reno     midpoint 43.6N  vs  41.9N   —  1.8 degrees out, which is exactly why
                                                         the demo never showed the problem
     Spherical linear interpolation between the two points. Degenerate case first: when the two
     ends coincide (sin d == 0) every weight divides by zero, so return the pair unchanged.
     LONGITUDES ARE UNWRAPPED as they are emitted. A great circle from Los Angeles to Tokyo
     crosses the antimeridian, and handing Leaflet a jump from +179 to -179 draws a line straight
     back across the whole map instead of over the Pacific. Each point is nudged by whole turns
     until it is within half a turn of the one before it, so the polyline stays continuous and
     simply runs past 180 into 181, 182 and so on, which is what Leaflet wants. */
  function arcPoints(a,b,steps=40){
    const R = Math.PI / 180;
    const la1 = a[0] * R, lo1 = a[1] * R, la2 = b[0] * R, lo2 = b[1] * R;
    const sinHalf = Math.sin((la2 - la1) / 2) ** 2
                  + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    const d = 2 * Math.asin(Math.min(1, Math.sqrt(sinHalf)));
    if (!(d > 1e-9)) return [[a[0], a[1]], [b[0], b[1]]];
    const sd = Math.sin(d), out = [];
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * d) / sd, B = Math.sin(f * d) / sd;
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      const lat = Math.atan2(z, Math.hypot(x, y)) / R;
      let lng = Math.atan2(y, x) / R;
      if (prev !== null) { while (lng - prev > 180) lng -= 360; while (prev - lng > 180) lng += 360; }
      prev = lng;
      out.push([lat, lng]);
    }
    return out;
  }

  /* SIMPLIFY A RECORDED TRACK DOWN TO A DRAWABLE PATH (D-103, the Strava import).
   *
   * WHY THIS CANNOT BE A SLICE. The draft encoder caps a leg at `PATH_MAX` 200 points and does
   * it with `slice(0, PATH_MAX)`. A Strava ride is commonly 5,000-20,000 trackpoints, so handing
   * one over raw keeps the first 200 - about four percent of the ride - and the line stops dead
   * partway along with nothing saying so. Truncation is not simplification.
   *
   * WHY IT IS NOT A TOLERANCE SEARCH EITHER, WHICH IS WHAT THIS WAS FIRST. Ordinary
   * Douglas-Peucker takes a distance tolerance, not a point budget, so the first version doubled
   * the tolerance until the result fitted. MEASURED on a 20,000-point track with realistic GPS
   * noise: that returns **2 points** - the leg collapses to exactly the chord this import exists
   * to replace. Bisecting between the last failing tolerance and the first passing one got it to
   * **12**. Both are bad for the same reason: DP keeps every wiggle above the tolerance and drops
   * every one below, so as the tolerance crosses a cluster of similar-sized wiggles the count
   * falls off a cliff, and no search finds a value that does not exist.
   *
   * So this budgets POINTS instead. Each step keeps the single point that is currently furthest
   * from the line being drawn - the one whose absence distorts the shape most - and splits there,
   * repeating until the budget is spent. That is DP run greediest-first, and it lands ON the cap
   * rather than wherever a power of two happened to fall: **200 points, every time**, against 2
   * or 12. It is also simpler, with no guard loop and nothing to tune.
   *
   * COS(LATITUDE), AND THIS FILE HAS BEEN BITTEN BY ITS ABSENCE BEFORE. A degree of longitude is
   * a degree of latitude times cos(lat) - about 0.71 in the Alps, 0.5 at 60N. Measuring
   * perpendicular distance in raw degrees treats a degree of longitude as a full degree, so a
   * north-south wiggle survives and an east-west one of the same real size gets dropped, harder
   * the further from the equator. `nearDist` in app.html carries the same correction for the same
   * reason (the Montana-and-the-Alps bug). One cosine for the whole track is right here: every
   * comparison is within one ride, so a shared scale factor keeps the ranking exact.
   */
  function simplifyPath(points, maxPts){
    const pts = (points || []).filter(p => Array.isArray(p) && p.length > 1
      && isFinite(p[0]) && isFinite(p[1]));
    const cap = Math.max(2, maxPts | 0);
    if (pts.length <= cap) return pts;

    const kx = Math.cos(pts[0][0] * Math.PI / 180) || 1e-6;   // longitude degrees -> latitude degrees
    /* Perpendicular distance from p to the segment a->b, in corrected degrees. The degenerate
       case (a and b coincident, which a stationary GPS produces plenty of) falls back to the
       point distance rather than dividing by zero. */
    const seg = (p, a, b) => {
      const px = (p[1] - a[1]) * kx, py = p[0] - a[0];
      const bx = (b[1] - a[1]) * kx, by = b[0] - a[0];
      const L = bx * bx + by * by;
      if (L === 0) return Math.hypot(px, py);
      let t = (px * bx + py * by) / L;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(px - t * bx, py - t * by);
    };
    /* The worst-fitting interior point of pts[lo..hi], and how far off it is. */
    const worst = (lo, hi) => {
      let far = -1, best = 0;
      for (let i = lo + 1; i < hi; i++) {
        const d = seg(pts[i], pts[lo], pts[hi]);
        if (d > best) { best = d; far = i; }
      }
      return { far, d: best };
    };

    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    let kept = 2;
    /* A plain array scanned for its maximum, not a heap: the budget is ~200, so this is a few
       tens of thousands of comparisons total and a heap would be more code to be wrong in. */
    const open = [];
    const push = (lo, hi) => { if (hi - lo > 1) { const w = worst(lo, hi); if (w.far > 0) open.push({ lo, hi, far: w.far, d: w.d }); } };
    push(0, pts.length - 1);
    while (kept < cap && open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].d > open[bi].d) bi = i;
      const s = open[bi];
      open.splice(bi, 1);
      /* NOT `> 0`. On a dead-straight line the perpendicular distances are float noise around
         1e-19 rather than exactly zero, so a zero test keeps splitting and pads a straight leg
         out to the full budget — 200 points to describe a line that needs 2. 1e-7 degrees is
         about a centimetre: orders of magnitude below the 5-decimal (~1 m) rounding the encoder
         applies anyway, so nothing a map could draw is lost, and far above the noise floor. */
      if (!(s.d > 1e-7)) break;            // the rest is straight; more points would add nothing
      keep[s.far] = 1; kept++;
      push(s.lo, s.far); push(s.far, s.hi);
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /* ── HOW A LEG IS PAINTED (D-159) ────────────────────────────────────────────────────────
   * Every transit mode distinct, in TWO channels: a colour AND a dash signature. Never hue
   * alone — seven hues is past what colour-vision deficiency separates, and §2y made print the
   * artifact, so a customer printing in black and white would get seven identical grey lines.
   * The dash survives both, and survives a 3.5px stroke on a phone.
   *
   * DRIVE AND FLY ARE ABSENT FROM THIS TABLE ON PURPOSE. They keep the TRACK colour, so two
   * crews on a shuttle trip still draw their drive legs in different colours and you can see
   * whose leg is whose. If mode took every hue that would be lost — D-042's "the truck went down
   * the river", arrived at backwards. Pins stay the vehicle's colour throughout.
   *
   * Rail is #9B5DE5 and NOT D-042's #8A6FB0: measured in CIELAB after simulating protanopia,
   * the old purple sat ΔE 1.8 from the rental track blue #3E7CB1 — rail already read as the
   * rental car — and this moves the worst pair in the whole set to ΔE 9.9. D-159 amends D-042.
   * Ferry has a colour here for the first time; it had none, so a ferry crossing drew in truck
   * amber, which was D-042's original complaint still live.
   *
   * Rail is dash-dot because that is what rail is on every paper map ever printed; ferry the
   * longest dash; water an even dash; bike and walk are dots differing in DENSITY, which is the
   * one distinction still readable when colour and print are both gone. `null` means solid.
   * DESIGN.md §"Route and mode colours" is the human-facing copy of this table; if you change a
   * value here, change it there in the same commit. */
  const MODE_COLORS = { train:"#9B5DE5", water:"#1B9AAA", ferry:"#C64191",
                        bike:"#2F8F52",  walk:"#8C6239" };
  const MODE_DASH   = { train:"12 5 2 5", ferry:"16 8", water:"6 6",
                        bike:"1 6",       walk:"1 3" };
  /* trackCol is the fallback, which is what makes drive and fly inherit the vehicle's colour. */
  function legColor(mode, trackCol){ return MODE_COLORS[mode] || trackCol; }
  function legDash(mode){ return MODE_DASH[mode] || null; }

  global.decodePoly   = decodePoly;
  global.arcPoints    = arcPoints;
  global.simplifyPath = simplifyPath;
  global.MODE_COLORS  = MODE_COLORS;
  global.MODE_DASH    = MODE_DASH;
  global.legColor     = legColor;
  global.legDash      = legDash;
})(window);
