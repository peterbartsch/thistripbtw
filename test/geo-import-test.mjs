/* D-103: GPX and KML in. The real functions, out of new.html.
 *
 * These carry real coordinates, so there is no geocoder to be uncertain about — which means the
 * only way to get this wrong is arithmetic, and this codebase's every real defect has come out
 * of arithmetic (timezone maths, cos(latitude), byte counts). Here it is coordinate ORDER:
 * **GPX writes lat and lon as named attributes; KML writes them lon,lat** — reversed. Swap them
 * and Denver lands in the Indian Ocean, silently, with a perfectly plausible-looking map.
 * That is the assertion this file exists for.
 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");
const cut = (label) => {
  const i = src.indexOf(label);
  if (i < 0) throw new Error("not found in new.html: " + label);
  const j = src.indexOf("\n}", i);
  return src.slice(i, j + 2);
};
let pass = 0, fail = 0;
const plen = x => (x && x.length) || 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); } else { fail++; console.log("  FAIL " + w); } };

/* legs.js is loaded for real rather than stubbed: geoToDraft leans on simplifyPath to get a
   recorded ride under PATH_MAX, and a stubbed simplifier would let a truncation bug pass. */
const legsSrc = readFileSync(new URL("../public/legs.js", import.meta.url), "utf8");
const { parseGeoFile, geoToDraft, trackMode, simplifyPath, pathsFromTracks, zipFindKml, kmzToKml } = new Function(
  "const window = {};\n" + legsSrc +
  "\nconst simplifyPath = window.simplifyPath;\n" +
  [cut("function xmlText("), cut("function parseGeoFile("), cut("function trackMode("),
   cut("function pathsFromTracks("), cut("function geoToDraft("), cut("function zipFindKml("),
   cut("async function kmzToKml(")].join("\n") +
  "\nreturn {parseGeoFile, geoToDraft, trackMode, simplifyPath, pathsFromTracks, zipFindKml, kmzToKml};")();

/* Denver is the fixture on purpose: its lat/lng are 39.7392 / -104.9903, and a swap puts it at
   -104.99 latitude, which is not a place on Earth. A reader can see the failure. */
const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <wpt lat="39.7392" lon="-104.9903"><name>Denver</name><time>2026-09-06T14:00:00Z</time></wpt>
  <wpt lat="41.2565" lon="-95.9345"><name><![CDATA[Omaha & co]]></name></wpt>
  <trk><name>the drive</name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>
</gpx>`;

const g = parseGeoFile(GPX);
ok("GPX waypoints are read",                    g.pts.length === 2);
ok("GPX lat is latitude and lon is longitude",  g.pts[0].lat === 39.7392 && g.pts[0].lng === -104.9903);
ok("names come through, CDATA and entities included", g.pts[1].name === "Omaha & co");
ok("a date is taken from <time> without a Date object",
   g.pts[0].date === "2026-09-06" && g.pts[1].date === "");
ok("a recorded track is counted, not turned into stops", g.skipped.tracks === 1);

/* KML: the reversal. Same two places, written the other way round. */
const KML = `<?xml version="1.0"?>
<kml><Document>
  <Placemark><name>Denver</name><Point><coordinates>-104.9903,39.7392,1609</coordinates></Point></Placemark>
  <Placemark><name>Omaha</name><Point><coordinates>-95.9345,41.2565</coordinates></Point></Placemark>
  <Placemark><name>the walk</name><LineString><coordinates>-1,1 -2,2 -3,3</coordinates></LineString></Placemark>
</Document></kml>`;

const k = parseGeoFile(KML);
ok("KML placemarks are read",                   k.pts.length === 2);
ok("KML coordinates are lon,lat — NOT lat,lng — and are un-reversed",
   k.pts[0].lat === 39.7392 && k.pts[0].lng === -104.9903);
ok("the altitude third value is ignored",       k.pts[0].lat === 39.7392);
ok("GPX and KML of the same place agree exactly",
   g.pts[0].lat === k.pts[0].lat && g.pts[0].lng === k.pts[0].lng);
ok("a LineString is counted, not turned into stops", k.skipped.lines === 1 && k.pts.length === 2);

/* The guard that catches a swap even when nobody is looking: latitude cannot exceed 90. */
const SWAPPED = `<kml><Placemark><name>bad</name><Point>
  <coordinates>39.7392,-104.9903</coordinates></Point></Placemark></kml>`;
ok("a genuinely reversed file is refused rather than mapped to nowhere",
   parseGeoFile(SWAPPED).pts.length === 0);

ok("junk yields nothing rather than something wrong",
   parseGeoFile("").pts.length === 0 && parseGeoFile("<html>hi</html>").pts.length === 0);

/* ── the draft ──────────────────────────────────────────────────────────────────────── */
const d = geoToDraft(g);
ok("the first place is the ORIGIN, not a leg",  d.routes[0].origin.name === "Denver");
ok("and the rest are legs",                     d.routes[0].legs.length === 1 &&
                                                d.routes[0].legs[0].to.name === "Omaha & co");
ok("coordinates survive into the draft unchanged",
   d.routes[0].origin.lat === 39.7392 && d.routes[0].origin.lng === -104.9903);
ok("the skipped track is reported by name, not just counted",
   d.dropped.length === 1 && /recorded track/.test(d.dropped[0]));

const empty = geoToDraft(parseGeoFile("<gpx><trk><trkseg/></trk></gpx>"));
ok("a file with only a track gives no routes and says why",
   empty.routes === null && /recorded track/.test(empty.dropped[0]));

/* ── D-103b: a recorded track is a LEG'S PATH (the Strava import) ────────────────────────
   A Strava export has no <wpt> at all — only <trk> — so before this it imported as nothing,
   which made the single most common GPX file in the world a no-op. */
/* The track always covers the same ~23 km; HOURS is what makes it a drive, a ride or a walk,
   which is the only variable trackMode's speed fallback actually reads. */
const ride = (n, kind, hours) => {
  let pts = "", t = Date.parse("2026-08-08T13:00:00Z");
  const stepH = (hours == null ? 1 : hours) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    /* A plausible ride rather than a zigzag: a steady climb with the small wander a GPS
       actually records, so the simplifier is asked the question a real file asks. */
    const f = i / Math.max(1, n - 1);
    const lat = 39.1677 + f * 0.18 + Math.sin(i / 9) * 0.0016;
    const lng = -120.1445 + f * 0.12 + Math.cos(i / 7) * 0.0016;
    pts += `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><ele>1900</ele>`
         + `<time>${new Date(t + i * stepH * 3600e3).toISOString()}</time></trkpt>`;
  }
  return `<?xml version="1.0"?><gpx version="1.1" creator="StravaGPX"><trk><name>${n}</name>`
       + (kind ? `<type>${kind}</type>` : "") + `<trkseg>${pts}</trkseg></trk></gpx>`;
};

const t1 = parseGeoFile(ride(500, "ride"));
ok("a Strava-shaped GPX yields a track, not stops", t1.pts.length === 0 && t1.tracks.length === 1);
ok("every trackpoint is read",                      t1.tracks[0].line.length === 500);
ok("lat is latitude here too",                      Math.abs(t1.tracks[0].line[0][0] - 39.1677) < 1e-6);
ok("<type> and <time> come through",                t1.tracks[0].type === "ride" && /^2026-08-08/.test(t1.tracks[0].t0));

const dr = geoToDraft(t1);
ok("the track becomes ONE leg",                     dr.routes[0].legs.length === 1);
ok("the leg carries a traced path",                 Array.isArray(dr.routes[0].legs[0].path));
ok("the ride's own type sets the mode",             dr.routes[0].legs[0].mode === "bike");
ok("the date comes off the first trackpoint",       dr.routes[0].legs[0].date === "2026-08-08");
ok("origin is the track's start, leg is its end",
   Math.abs(dr.routes[0].origin.lat - 39.1677) < 1e-6 &&
   Math.abs(dr.routes[0].legs[0].to.lat - t1.tracks[0].line[499][0]) < 1e-9);
ok("a used track is NOT reported as dropped",       dr.dropped.length === 0 && dr.tracksUsed === 1);

/* THE ONE THAT MATTERS. PATH_MAX is 200 and the encoder enforces it with slice(), so an
   unsimplified 20,000-point ride would keep the first four percent and stop dead mid-ride. */
const big = geoToDraft(parseGeoFile(ride(20000, "ride")));
const bp  = big.routes[0].legs[0].path;
ok("a 20,000-point ride is simplified under PATH_MAX", bp.length <= 200);
/* The ride climbs 0.18° of latitude end to end. A TRUNCATED path keeps the first 200 of 20,000
   points and spans about 1% of that; a SIMPLIFIED one spans nearly all of it. The number is what
   tells the two apart, so it is asserted rather than the point count alone. */
ok("...and it is SIMPLIFIED, not TRUNCATED — the far end of the ride survives",
   (bp[bp.length-1][0] - bp[0][0]) > 0.17);
ok("...and a truncation would have failed this: 200/20000 points spans ~0.0018°",
   (bp[bp.length-1][0] - bp[0][0]) > 0.17 && bp.length > 2);

/* Mode inference falls back to speed when <type> is absent — arithmetic, not a guess. */
/* ~23 km in 0.3 h is 76 km/h; in 1 h, 23 km/h; in 6 h, 3.8 km/h. Wide bands on purpose — the
   average includes every stop at a light, so it only has to separate three things. */
ok("no <type>, ~76 km/h -> drive", trackMode(parseGeoFile(ride(60, "", 0.3)).tracks[0]) === "drive");
ok("no <type>, ~23 km/h -> bike",  trackMode(parseGeoFile(ride(60, "", 1)).tracks[0])   === "bike");
ok("no <type>, ~4 km/h  -> walk",  trackMode(parseGeoFile(ride(60, "", 6)).tracks[0])   === "walk");
ok("an unknown <type> still infers rather than throwing",
   ["drive","bike","walk","water","train"].includes(trackMode(parseGeoFile(ride(60,"kitesurf",1)).tracks[0])));
ok("a paddle is water",  trackMode({type:"kayaking", line:[[0,0],[0,1]], t0:"", t1:""}) === "water");
ok("a run is walk",      trackMode({type:"trailrun",  line:[[0,0],[0,1]], t0:"", t1:""}) === "walk");

/* Waypoints still win: a mixed file behaves exactly as it did before this landed. */
ok("waypoints still define the trip when both are present",
   d.routes[0].origin.name === "Denver" && d.dropped.length === 1);

/* simplifyPath itself — cos(latitude) is the correction this repo keeps getting hurt by. */
ok("simplifyPath returns the input untouched when it already fits",
   simplifyPath([[0,0],[1,1],[2,2]], 200).length === 3);
ok("a dead-straight line collapses to its two ends",
   simplifyPath(Array.from({length:900},(_,i)=>[i*0.001,0]), 200).length === 2);
ok("simplifyPath keeps first and last exactly",
   (()=>{ const src=Array.from({length:900},(_,i)=>[39+i*0.001,-120+Math.sin(i)*0.01]);
          const out=simplifyPath(src,200);
          return out[0][0]===src[0][0] && out[out.length-1][0]===src[src.length-1][0]; })());
/* COS(LATITUDE) — the correction this repo has been bitten by twice (nearDist, the Montana-and-
   the-Alps bug). It only changes an ANSWER where a track turns, because one cosine scales every
   longitude delta equally: a straight run ranks the same either way. So the fixture is an L at
   60N, where cos = 0.5. The north run's deviations are perpendicular to LONGITUDE, the east
   run's to LATITUDE, and they are sized so the raw-degrees winner and the real-world winner are
   DIFFERENT points: lng 0.0018deg is only 0.00090 on the ground, against the lat bump's 0.00100.
   With the correction the LAT bump is kept. Without it the LNG bump is, and the leg keeps the
   smaller real wiggle while dropping the larger one. Verified failing with kx forced to 1. */
ok("cos(latitude): the larger REAL deviation wins, not the larger in raw degrees",
   (()=>{ const T=[];
     for(let i=0;i<=40;i++) T.push([60+i*0.0005, i===20 ? 0.0018 : 0]);
     for(let i=1;i<=40;i++) T.push([60.02 + (i===20 ? 0.0010 : 0), i*0.001]);
     const inner = simplifyPath(T,4).slice(1,-1);
     return inner.some(p => Math.abs(p[0]-60.021) < 1e-9)          // the LAT bump survived
         && !inner.some(p => Math.abs(p[1]-0.0018) < 1e-9); })());  // the LNG bump did not

ok("a corner is kept where a straight run is dropped",
   (()=>{ const L=[]; for(let i=0;i<400;i++) L.push([39+i*0.001, -120]);
          for(let i=0;i<400;i++) L.push([39.4, -120+i*0.001]);
          const out=simplifyPath(L,200);
          return out.length<=200 && out.some(p=>Math.abs(p[0]-39.4)<1e-9 && Math.abs(p[1]+120)<1e-9); })());

/* ── OUR OWN .gpx ROUND-TRIPPED, PATHS INTACT ────────────────────────────────────────────
   lib/export.php writes one <trk> per vehicle as [stop, path…, stop, path…, stop] and formats
   BOTH <wpt> and <trkpt> through export_coord — 6 decimals, trailing zeros trimmed. So the
   fixture below is our export's exact shape, and the split has to come back byte-exact. */
const c6 = v => String(+(+v).toFixed(6));
const ourExport = (stops, paths) => {
  let w = "", line = [];
  stops.forEach((s, i) => {
    w += `<wpt lat="${c6(s[0])}" lon="${c6(s[1])}"><name>${s[2]}</name></wpt>`;
    if (i > 0) (paths[i] || []).forEach(p => line.push(p));
    line.push([s[0], s[1]]);
  });
  const trk = line.map(p => `<trkpt lat="${c6(p[0])}" lon="${c6(p[1])}"/>`).join("");
  return `<?xml version="1.0"?><gpx version="1.1" creator="thistripbtw.us">${w}`
       + `<trk><name>Sam's Subaru</name><trkseg>${trk}</trkseg></trk></gpx>`;
};

const stops = [[39.1677,-120.1445,"Tahoe City"],[38.9540,-120.1050,"Emerald Bay"],
               [39.5052,-119.7602,"Reno"]];
const drawn = { 1:[[39.15,-120.11],[39.08,-120.085],[39.00,-120.07]], 2:[[39.20,-119.95]] };
const rt = geoToDraft(parseGeoFile(ourExport(stops, drawn)));

ok("our own export still reads its stops",       rt.routes[0].legs.length === 2);
ok("the traced path comes BACK on the right leg",
   plen(rt.routes[0].legs[0].path) === 3);
ok("...and its points are the ones that went in",
   plen(rt.routes[0].legs[0].path) === 3 &&
   Math.abs(rt.routes[0].legs[0].path[1][0] - 39.08) < 1e-9 &&
   Math.abs(rt.routes[0].legs[0].path[1][1] + 120.085) < 1e-9);
ok("the second leg gets its own path, not the first's",
   plen(rt.routes[0].legs[1].path) === 1 &&
   plen(rt.routes[0].legs[1].path) === 1 &&
   Math.abs(rt.routes[0].legs[1].path[0][0] - 39.20) < 1e-9);
ok("a consumed track is no longer reported as dropped", rt.dropped.length === 0);
ok("and the count is reported for the summary",  rt.pathsRecovered === 2 && rt.pathPoints === 4);

/* A leg with no drawn path must stay null rather than inheriting its neighbour's. */
const rt2 = geoToDraft(parseGeoFile(ourExport(stops, { 2:[[39.20,-119.95]] })));
ok("an untraced leg stays null", rt2.routes[0].legs[0].path === null &&
                                 plen(rt2.routes[0].legs[1].path) === 1);

/* THE REVISITED STOP. The demo returns to Tahoe City and to Reno twice; a global
   coordinate lookup would hand the second visit's path to the first visit's leg. */
const there = [[39.1677,-120.1445,"Tahoe City"],[38.9540,-120.1050,"Emerald Bay"],
               [39.1677,-120.1445,"Tahoe City again"],[39.5052,-119.7602,"Reno"]];
const rt3 = geoToDraft(parseGeoFile(ourExport(there,
  { 1:[[39.15,-120.11]], 2:[[39.05,-120.09],[39.10,-120.10]], 3:[[39.30,-119.90]] })));
ok("a revisited stop does not steal the other visit's path",
   plen(rt3.routes[0].legs[0].path) === 1 &&
   plen(rt3.routes[0].legs[1].path) === 2 &&
   plen(rt3.routes[0].legs[2].path) === 1);

/* A recorded ride that does NOT start on one of our stops is somebody else's line: it must not
   be claimed as the geometry between two waypoints. */
const mixed = parseGeoFile(ourExport(stops, drawn).replace(
  '<trk><name>', '<trk><name>x</name><trkseg><trkpt lat="1.0" lon="1.0"/><trkpt lat="1.1" lon="1.1"/></trkseg></trk><trk><name>'));
const rt4 = geoToDraft(mixed);
ok("a track that does not run through our stops is left alone",
   plen(rt4.routes[0].legs[0].path) === 3 && rt4.pathsRecovered === 2);


/* ── .kmz: A ZIPPED KML, WHICH IS WHAT GOOGLE MY MAPS ACTUALLY HANDS OUT ─────────────────
   Checked against Wanderlog's own FAQ, not a blog: Wanderlog has NO file export — PDF, Print,
   and "Export to Google Maps". So the only working route out of it is
   Wanderlog -> My Maps -> Download KML/KMZ -> here, and My Maps gives KMZ for a map with
   several placemarks. We read .kml and refused .kmz, so the last hop of the only path failed.
   The fixtures are REAL zips built by node's own zlib, not mocks: one DEFLATED (method 8, what
   My Maps produces) and one STORED (method 0, which a deflate-only reader fails on — and it is
   always the smallest file somebody tries first). */
const { deflateRawSync } = await import("node:zlib");
const zipOf = (entries) => {          // entries: [[name, Buffer, method]]
  const locals = [], central = []; let off = 0;
  for (const [name, raw, method] of entries) {
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    /* The LOCAL header carries an extra field the CENTRAL one does not. That asymmetry is the
       trap this fixture exists to spring: a reader that uses the central directory's lengths to
       find the data lands 9 bytes in and inflates garbage. */
    const extra = Buffer.from("EXTRAFLD"); lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, nm, extra, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(0, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + extra.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  const all = Buffer.concat([...locals, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
};

const MYMAPS_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Japan trip</name>
<Folder><name>Untitled layer</name>
<Placemark><name>Tokyo Station</name><Point><coordinates>139.7671,35.6812,0</coordinates></Point></Placemark>
<Placemark><name>Kyoto Station</name><Point><coordinates>135.7583,34.9858,0</coordinates></Point></Placemark>
</Folder></Document></kml>`;

const deflated = zipOf([["doc.kml", Buffer.from(MYMAPS_KML), 8],
                        ["images/icon.png", Buffer.from("fake"), 8]]);
const stored   = zipOf([["doc.kml", Buffer.from(MYMAPS_KML), 0]]);

ok("a KMZ's doc.kml is found past a sibling entry", zipFindKml(deflated)?.name === "doc.kml");
ok("...and its compression method is read", zipFindKml(deflated)?.method === 8);
const fromKmz = await kmzToKml(deflated);
ok("a DEFLATED kmz inflates to its kml",  /Tokyo Station/.test(fromKmz));
ok("a STORED kmz reads without inflating", /Tokyo Station/.test(await kmzToKml(stored)));
const kd = geoToDraft(parseGeoFile(fromKmz));
ok("the unpacked kml becomes a draft",     plen(kd.routes?.[0]?.legs) === 1);
ok("lon,lat is still un-reversed through the zip",
   Math.abs((kd.routes?.[0]?.origin?.lat ?? 0) - 35.6812) < 1e-9 &&
   Math.abs((kd.routes?.[0]?.origin?.lng ?? 0) - 139.7671) < 1e-9);
ok("Folders do not hide Placemarks",       kd.routes?.[0]?.origin?.name === "Tokyo Station");
/* A corrupt deflate stream must come back EMPTY, not as a rejected promise: the caller turns ""
   into one plain sentence, and a throw here would surface as an unhandled rejection carrying a
   zlib error code — §2ad's "Upload failed — Failed to fetch" mistake in a new coat. This is also
   what lets the local-header assertion below FAIL rather than crash the run. */
const corrupt = (() => { const b = Buffer.from(new Uint8Array(deflated).slice());
  /* doc.kml's local header is 30 + 7 ("doc.kml") + 8 (extra) = 45 bytes, so the deflate stream
     starts at 45. Mauling there corrupts the DATA rather than the directory, which is the case
     a truncated or half-written download actually produces. */
  for (let i = 50; i < 70; i++) b[i] ^= 0xff;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })();
ok("a corrupt kmz returns empty rather than throwing", (await kmzToKml(corrupt)) === "");

ok("a zip with no kml in it yields nothing rather than something wrong",
   zipFindKml(zipOf([["notes.txt", Buffer.from("hi"), 8]])) === null);
ok("junk bytes are refused, not guessed at",
   zipFindKml(Buffer.from("not a zip at all").buffer) === null);


console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
