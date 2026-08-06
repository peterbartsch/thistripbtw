/* D-100: the builder can read back the file the product hands out.
 *
 * Until now the export was write-only — a paid trip produced a `trip.json` that nothing could
 * open, including us. That is the smallest possible version of "a PDF for travel" going unmet.
 *
 * The two shapes are genuinely different and that is the whole risk: the export is FLAT, one
 * entry per stop each carrying its own `track`; the builder holds `routes[i].origin` plus
 * `routes[i].legs[]`. A converter between them is exactly the kind of code that looks right and
 * silently drops the second vehicle, or turns the first stop into a leg, so this runs the REAL
 * function out of new.html against a fixture shaped like a real export.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");
const m = src.match(/function importedFromExport\(d\)\{[\s\S]*?\n\}/);
let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else    { fail++; console.log("  FAIL " + w); } };

ok("importedFromExport was found in new.html", !!m);
if (!m) { console.log("\n1 failed"); process.exit(1); }

/* TRACKS is a free variable inside the function — supply the real one from the same file, so a
   change to the track keys breaks this test rather than passing with a stale copy. */
const tracksSrc = src.match(/const TRACKS=\[.*?\];/s)[0];
const importedFromExport = new Function(tracksSrc + "\n" + m[0] + "\nreturn importedFromExport;")();

/* Shaped exactly like lib/export.php's trip.json: flat stops, per-stop track, notes not text. */
const EXPORT = {
  _readme: "Your trip, exported from thistripbtw.us.",
  name: "Weekend at Tahoe",
  tier: "keep",
  stops: [
    { id: "a", kind: "stop", track: "truck",  date: "2026-08-01", title: "San Francisco — load up, coffee, go",
      lat: 37.7749, lng: -122.4194, mode: "drive", craft: "", fly: 0, lodging: "", notes: "leave by 8" },
    { id: "b", kind: "stop", track: "truck",  date: "2026-08-01", title: "Sacramento — In-N-Out + gas",
      lat: 38.5816, lng: -121.4944, mode: "drive", craft: "", fly: 0, lodging: "", notes: "" },
    { id: "c", kind: "stop", track: "truck",  date: "2026-08-02", title: "Tahoe City — cabin check-in",
      lat: 39.1710, lng: -120.1450, mode: "drive", craft: "Kayak", fly: 0, lodging: "The cabin", notes: "code 4417",
      photo: "photos/x.jpg" },
    { id: "d", kind: "stop", track: "rental", date: "2026-08-01", title: "Reno–Tahoe (RNO)",
      lat: 39.4991, lng: -119.7681, mode: "fly", craft: "", fly: 1, lodging: "", notes: "" },
    { id: "e", kind: "stop", track: "rental", date: "2026-08-02", title: "Incline Village",
      lat: 39.2510, lng: -119.9720, mode: "drive", craft: "", fly: 0, lodging: "", notes: "" },
    { id: "p", kind: "post",   track: "truck", title: "we made it", lat: 39.17, lng: -120.14 },
    { id: "s", kind: "sealed", track: "truck", title: "", lat: 39.17, lng: -120.14 },
  ],
  notes: [{ id: "n1", text: "packing list", updated: 1 }],
};

const out = importedFromExport(EXPORT);
ok("an export converts to something the builder can load", !!out && Array.isArray(out.routes));
ok("the trip keeps its name", out.name === "Weekend at Tahoe");

/* The failure that matters most: a two-vehicle trip must not collapse into one route. */
ok("two tracks become two routes", out.routes.length === 2);
ok("and they are in TRACKS order — truck first, rental second",
   out.routes[0].origin.name.startsWith("San Francisco") &&
   out.routes[0].legs.length === 2 &&
   out.routes[1].origin.name.startsWith("Reno") &&
   out.routes[1].legs.length === 1);

/* The other silent-corruption case: the first stop is the ORIGIN, not a leg. Getting this wrong
   drops a stop from every route and nothing errors. */
ok("the first stop of a track is its origin, not a leg",
   out.routes[0].origin.lat === 37.7749 && out.routes[0].legs[0].to.lat === 38.5816);
ok("no stop is lost — 3 truck stops become 1 origin + 2 legs",
   1 + out.routes[0].legs.length === 3);

const cabin = out.routes[0].legs[1];
ok("a stop's own fields survive",     cabin.date === "2026-08-02" && cabin.mode === "drive");
ok("lodging becomes a stay",          cabin.stay && cabin.stay.lodging === "The cabin");
ok("notes become the leg note",       cabin.note === "code 4417");
ok("a craft rides along",             cabin.craft === "Kayak");
ok("no lodging means no stay object", out.routes[0].legs[0].stay === null);
ok("a flown leg keeps its mode",      out.routes[1].origin.name.startsWith("Reno") && out.routes[1].legs[0].mode === "drive");

/* Posts and sealed drops belong to a trip that exists. A draft has nobody to attribute them to
   and no way to keep a sealed drop sealed, so they are left behind — and SAID, not dropped
   silently, which is what `dropped` is for. */
ok("posts and sealed drops do not come across",
   out.routes.every(r => r.legs.every(l => l.to.name !== "we made it")));
ok("and the import knows it left them, so it can say so", out.dropped.posts === 2);
ok("it knows photos were left behind too",                out.dropped.photos === true);

/* A draft this builder saved is NOT an export and must not be run through the converter — it
   already has `routes`, and the caller checks that before calling. Belt and braces here. */
ok("a builder draft is not mistaken for an export",
   importedFromExport({ name: "x", routes: [{ origin: null, legs: [] }] }) === null);
ok("garbage returns null rather than a half-built trip",
   importedFromExport(null) === null && importedFromExport({}) === null &&
   importedFromExport({ stops: [] }) === null);
ok("a stop with no coordinates is skipped, not imported at 0,0",
   importedFromExport({ stops: [{ kind: "stop", track: "truck", title: "nowhere" }] }) === null);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
