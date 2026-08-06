#!/usr/bin/env node
/**
 * build-places-index.mjs — generates public/places-index.json, the local-first autosuggest
 * gazetteer. Run by hand when the data should refresh (yearly is plenty); the OUTPUT is
 * committed, the same pattern as tokens.css generated from tokens.json. No build step ships.
 *
 * WHY THIS EXISTS (audit 2026-07-29, measured on the live site): Nominatim is a geocoder,
 * not an autocompleter. It does no prefix matching — "sacram" returned a street in Portugal,
 * "lake ta" returned Lake County, Minnesota — no typo tolerance ("san fransisco" → three
 * villages in Ecuador), and fame-ranks raw results ("yosemite" → Sydney, Australia first).
 * The fix is a small local index searched instantly in the browser, with Nominatim kept for
 * the long tail (street addresses, obscure POIs). Same-origin static file: no new
 * sub-processor, no runtime third party, nothing about the person leaves the page.
 *
 * Sources, all fetched at BUILD time only:
 *   · GeoNames cities1000 / cities15000 + admin1 codes — CC-BY 4.0, geonames.org
 *   · OurAirports airports.csv — public domain, ourairports.com
 * Attribution for GeoNames (CC-BY) travels in the generated file's `_attribution` field and
 * in this header. D-002: US is the launch market, so US/CA/MX carry towns down to pop 1,000
 * while the rest of the world starts at 15,000 — Moab (pop 5k) matters to a trip planner;
 * a same-sized town in Kazakhstan can arrive via Nominatim once fully typed.
 *
 * Row format (arrays, to keep bytes down):  [name, region, cc, lat, lng, weight, kind, extra]
 *   kind: "c" city · "a" airport (extra = IATA, then ICAO when known) · "p" park
 *   weight: log10(population), airports 3.5-5 by size, parks 4 — comparable scale on purpose.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const TMP = process.env.TMPDIR || "/tmp";
const OUT = new URL("../public/places-index.json", import.meta.url).pathname;

function fetchTo(file, url) {
  const path = `${TMP}/${file}`;
  if (!existsSync(path)) {
    console.log(`  fetching ${url}`);
    execSync(`curl -sL -o ${path} "${url}"`, { stdio: "inherit" });
  }
  return path;
}
function unzip(zipPath, member) {
  const out = `${TMP}/${member}`;
  if (!existsSync(out)) execSync(`cd ${TMP} && unzip -o -q ${zipPath} ${member}`);
  return out;
}

/* ── admin1 names: "US.CO" → "Colorado"; US states also get "CO" for display ── */
const admin1 = {};
for (const line of readFileSync(
  fetchTo("admin1.txt", "https://download.geonames.org/export/dump/admin1CodesASCII.txt"), "utf8").split("\n")) {
  const [code, name] = line.split("\t");
  if (code && name) admin1[code] = name;
}
const US_ABBR = {};
for (const [code, name] of Object.entries(admin1))
  if (code.startsWith("US.")) US_ABBR[name] = code.slice(3);

/* ── cities ── */
const NEAR_MARKET = new Set(["US", "CA", "MX"]);
const rows = [];
const seen = new Set();
function addCity(f) {
  const [, name, ascii, , lat, lng, fclass, fcode, cc, , a1, , , , pop] = f;
  if (fclass !== "P") return;                       // populated places only
  if (["PPLX", "PPLQ", "PPLW", "PPLH"].includes(fcode)) return;  // sections/abandoned
  const p = +pop || 0;
  const regionName = admin1[`${cc}.${a1}`] || "";
  const region = cc === "US" ? (US_ABBR[regionName] || regionName) : regionName;
  const key = `${ascii.toLowerCase()}|${region}|${cc}`;
  if (seen.has(key)) return;
  seen.add(key);
  // Region strings ship only for the launch market (US/CA/MX) — for the rest of the world
  // the client renders the country name from the code via Intl.DisplayNames, which is built
  // into the browser and costs zero bytes here. Weight is log10(pop)×10 as a small int.
  rows.push([name, NEAR_MARKET.has(cc) ? region : "", cc, +(+lat).toFixed(4), +(+lng).toFixed(4),
             Math.round(Math.log10(Math.max(p, 10)) * 10), "c"]);
}
console.log("cities (US ≥1k, CA/MX ≥5k)…");
for (const line of readFileSync(unzip(
  fetchTo("cities1000.zip", "https://download.geonames.org/export/dump/cities1000.zip"),
  "cities1000.txt"), "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 15) continue;
  const cc = f[8], pop = +f[14];
  if (cc === "US" ? pop >= 1000 : (NEAR_MARKET.has(cc) && pop >= 5000)) addCity(f);
}
console.log("cities (world ≥15k)…");
for (const line of readFileSync(unzip(
  fetchTo("cities15000.zip", "https://download.geonames.org/export/dump/cities15000.zip"),
  "cities15000.txt"), "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 15) continue;
  if (!NEAR_MARKET.has(f[8]) && +f[14] >= 25000) addCity(f);
}

/* ── airports: scheduled service + IATA. "SFO" must be one keystrokes-cheap hit. ── */
console.log("airports…");
const csv = readFileSync(fetchTo("airports.csv",
  "https://davidmegginson.github.io/ourairports-data/airports.csv"), "utf8");
// tiny CSV parser (quoted fields with commas exist in airport names)
function* csvRows(text) {
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); yield row; row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); yield row; }
}
let head = null, nAir = 0;
for (const r of csvRows(csv)) {
  if (!head) { head = Object.fromEntries(r.map((h, i) => [h, i])); continue; }
  const type = r[head.type], iata = r[head.iata_code], sched = r[head.scheduled_service];
  if (sched !== "yes" || !iata || !/^[A-Z]{3}$/.test(iata)) continue;
  if (type !== "large_airport" && type !== "medium_airport") continue;
  const w = type === "large_airport" ? 50 : 38;     // rank majors like big cities
  /* ICAO too (D-112). Pilots, flight trackers and anyone reading a tail number type KORD, not
     ORD, and it is REAL DATA here rather than a rule — "K + the IATA code" holds across the
     contiguous US and nowhere else, and guessing it would turn PISA into Mount Isa, Australia.
     ~7 bytes per airport on a 2 MB file. */
  const icao = r[head.icao_code];
  const row = [r[head.name], r[head.municipality] || "", r[head.iso_country],
               +(+r[head.latitude_deg]).toFixed(4), +(+r[head.longitude_deg]).toFixed(4),
               w, "a", iata];
  if (/^[A-Z0-9]{4}$/.test(icao || "")) row.push(icao);
  rows.push(row);
  nAir++;
}
console.log(`  ${nAir} airports`);

/* ── output ── */
const out = {
  _attribution: "Cities: GeoNames.org (CC-BY 4.0). Airports: OurAirports (public domain). Generated by scripts/build-places-index.mjs.",
  v: 1,
  rows,
};
writeFileSync(OUT, JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`\n${rows.length} places → public/places-index.json (${(bytes/1048576).toFixed(2)} MB raw)`);
execSync(`gzip -k -9 -f ${OUT} && ls -l ${OUT}.gz && rm ${OUT}.gz`, { stdio: "inherit" });
