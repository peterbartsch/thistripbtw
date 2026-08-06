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
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); } else { fail++; console.log("  FAIL " + w); } };

const { parseGeoFile, geoToDraft } = new Function(
  [cut("function xmlText("), cut("function parseGeoFile("), cut("function geoToDraft(")].join("\n") +
  "\nreturn {parseGeoFile, geoToDraft};")();

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

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
