/* §2bv — WHICH LAYER IS PAINTING IT. Run this before theorising about the basemap.
 *
 *   node test/flow/layer-probe.mjs            # both layers, then each removed in turn
 *   node test/flow/layer-probe.mjs 39.35 -120.35 10
 *
 * WHY THIS IS IN THE REPO. It is the only experiment in a week of §2bv work that measured
 * anything, and it lived in a session scratchpad that would have died with the session. It
 * settled the question in one run: removing the PER-TRIP layer removes the false water entirely,
 * while the world layer alone renders clean — overturning a conclusion this repo had held for a
 * week on the strength of a coverage map rather than an experiment.
 *
 * THE TWO THINGS IT DOES THAT THE FAILED VERSIONS DID NOT:
 *  1. It reports the map's LAYER INVENTORY at screenshot time. `map.removeLayer(tileLayer)`
 *     returns happily and leaves the layer on the map — the world-layer case silently did nothing
 *     while looking like a clean experiment. Never trust the removal call; count the layers after.
 *  2. It md5s the screenshots. Two different removals that produce BYTE-IDENTICAL images is how
 *     an inert experiment announces itself, and it is a two-second check.
 *
 * AND THE TRAP IT CANNOT SAVE YOU FROM: mutating `pmDetail.paintRules` at runtime and re-adding
 * the layer changes the rules array and renders the SAME CACHED TILES. Rule changes have to go in
 * the page behind a flag and be reloaded. That is what `?tripwater=1` is for.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { launch } from "./cdp.mjs";

const [lat, lng, z] = [+(process.argv[2] ?? 39.35), +(process.argv[3] ?? -120.35), +(process.argv[4] ?? 10)];
const URL = (process.env.TTB_TRIP ?? "https://thistripbtw.us/efevnwm/#k=treeline-downpour-rolling-switchback");
const OUT = process.env.TTB_OUT ?? "/tmp";

const INVENTORY = `(()=>{ let world=0, trip=0, n=0; map.eachLayer(l=>{ n++;
    if (typeof tileLayer!=="undefined" && l===tileLayer) world++;
    if (typeof pmDetail !=="undefined" && l===pmDetail)  trip++; });
  return JSON.stringify({layers:n, worldOnMap:world, tripOnMap:trip}); })()`;

const page = await launch({ headless: true });
await page.viewport(1400, 900, false);
const seen = new Map();

for (const c of ["both", "noworld", "notrip"]) {
  await page.goto(URL, 2500);
  /* Pin the sky. theme.js reads the WALL CLOCK, so a 02:00 run renders night and measures a
     different colour than the reported day bug — the overzoom flow documents the same trap. */
  await page.eval(`(()=>{ try{ localStorage.setItem("ttb_theme","light"); }catch(e){} return 1; })()`);
  await page.goto(URL, 4500);
  await page.eval(`(()=>{ map.setView([${lat},${lng}], ${z}); return 1; })()`);
  await new Promise(t => setTimeout(t, 4000));
  if (c === "noworld") await page.eval(`(()=>{ try{ map.removeLayer(tileLayer); }catch(e){} return 1; })()`);
  if (c === "notrip")  await page.eval(`(()=>{ try{ map.removeLayer(pmDetail);  }catch(e){} return 1; })()`);
  await page.eval(`(()=>{ map.invalidateSize(); return 1; })()`);
  await new Promise(t => setTimeout(t, 5000));

  const png = Buffer.from(await page.shot(), "base64");
  const file = `${OUT}/layer-${c}-z${z}.png`;
  writeFileSync(file, png);
  const md5 = createHash("md5").update(png).digest("hex").slice(0, 12);
  const inv = JSON.parse(await page.eval(INVENTORY));
  const dupe = seen.get(md5);
  seen.set(md5, c);
  console.log(`${c.padEnd(8)} ${JSON.stringify(inv)}  md5=${md5}${dupe ? `  ⚠ IDENTICAL TO "${dupe}" — this experiment measured nothing` : ""}`);
  if (c === "noworld" && inv.worldOnMap) console.log(`         ⚠ the world layer is STILL ON THE MAP — the removal did not take`);
  if (c === "notrip"  && inv.tripOnMap)  console.log(`         ⚠ the trip layer is STILL ON THE MAP — the removal did not take`);
}
console.log(`\nscreenshots in ${OUT}/. Read them; the artifact is unmistakable in an image and the\ncanvas sampler has lied about it three times.`);
await page.close();
