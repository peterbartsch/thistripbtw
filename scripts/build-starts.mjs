#!/usr/bin/env node
/**
 * build-starts.mjs — generates public/starts.html and the block of links in llms.txt.
 *
 * BLANK STARTS, not itineraries (Peter, 2026-07-29: "lots of blank start templates to show the
 * wide utility for this to agents"). Each one is a SHAPE — two vehicles converging, a rail
 * loop, a bike tour, a household move — with placeholder anchors the person or agent replaces.
 * That distinction is the whole design:
 *
 *   · A curated itinerary is an editorial claim about a good trip, and the "we record, we do
 *     not verify" line (item 12) cuts hardest when WE are the author. A shape claims nothing:
 *     no roads to check, no opening hours to go stale, nothing to be wrong about.
 *   · An agent reading /for-agents learns the FORMAT. It does not learn the RANGE — that this
 *     handles a canoe leg, a crew joining midway, a move with two vehicles. Shapes teach range
 *     in one glance, which is what makes them a marketing surface as much as a starter.
 *   · Zero backend. A start IS a #d= link — the same fragment agents build. No table, no route,
 *     no new privacy surface, nothing to deploy but a static page.
 *
 * Regenerate after editing SHAPES below:  node scripts/build-starts.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const SITE = "https://thistripbtw.us";

/* Anchors are real coordinates so the map draws something sane, and deliberately generic so
   nobody mistakes them for a recommendation. Dates are omitted everywhere: an undated leg
   holds its position (D-044), so a shape stays a shape. */
const SHAPES = [
  { id: "road-trip", title: "Classic road trip",
    blurb: "One vehicle, several stops, there and back. The shape most trips actually are.",
    o: ["Denver, CO", 39.7392, -104.9903],
    l: [["Grand Junction, CO", 39.0639, -108.5506, "drive"],
        ["Moab, UT", 38.5733, -109.5498, "drive"],
        ["Denver, CO", 39.7392, -104.9903, "drive"]] },

  { id: "fly-then-drive", title: "Fly in, drive around",
    blurb: "Arrive by air, pick up a car, loop, fly home. Swap the airports for yours.",
    o: ["DEN — Denver International Airport", 39.8561, -104.6737],
    l: [["Boulder, CO", 40.015, -105.2705, "drive"],
        ["Estes Park, CO", 40.3772, -105.5217, "drive"],
        ["DEN — Denver International Airport", 39.8561, -104.6737, "drive"]] },

  { id: "two-vehicles", title: "Two vehicles, meeting in the middle",
    blurb: "Some drive, someone flies in partway. Both paths on one map — the trip this was built for.",
    o: ["Chicago, IL", 41.8781, -87.6298],
    l: [["Omaha, NE", 41.2565, -95.9345, "drive"],
        ["Denver, CO", 39.7392, -104.9903, "drive"],
        ["Salt Lake City, UT", 40.7608, -111.891, "fly"]] },

  { id: "rail-europe", title: "Multi-city by rail",
    blurb: "City to city on trains, no car anywhere in it.",
    o: ["Paris, France", 48.8566, 2.3522],
    l: [["Lyon, France", 45.764, 4.8357, "train"],
        ["Zürich, Switzerland", 47.3769, 8.5417, "train"],
        ["Milan, Italy", 45.4642, 9.19, "train"]] },

  { id: "the-move", title: "A move",
    blurb: "One-way, loaded, with the overnight stops that make it survivable.",
    o: ["Chicago, IL", 41.8781, -87.6298],
    l: [["St. Louis, MO", 38.627, -90.1994, "drive"],
        ["Oklahoma City, OK", 35.4676, -97.5164, "drive"],
        ["Albuquerque, NM", 35.0844, -106.6504, "drive"],
        ["Phoenix, AZ", 33.4484, -112.074, "drive"]] },

  { id: "bike-tour", title: "Bike tour",
    blurb: "Under your own power, day by day. Ferry legs and rest days welcome.",
    o: ["San Francisco, CA", 37.7749, -122.4194],
    l: [["Half Moon Bay, CA", 37.4636, -122.4286, "bike"],
        ["Santa Cruz, CA", 36.9741, -122.0308, "bike"],
        ["Monterey, CA", 36.6002, -121.8947, "bike"]] },

  { id: "island-hop", title: "Island hopping",
    blurb: "Boats between islands, walking once you land.",
    o: ["Athens, Greece", 37.9838, 23.7275],
    l: [["Mykonos, Greece", 37.4467, 25.3289, "ferry"],
        ["Naxos, Greece", 37.1036, 25.3767, "ferry"],
        ["Santorini, Greece", 36.3932, 25.4615, "ferry"]] },

  { id: "parks-loop", title: "National parks loop",
    blurb: "Long drives, gateway towns, a paddle or a hike in the middle.",
    o: ["Las Vegas, NV", 36.1699, -115.1398],
    l: [["Springdale, UT", 37.1889, -112.9986, "drive"],
        ["Bryce Canyon City, UT", 37.6725, -112.157, "drive"],
        ["Page, AZ", 36.9147, -111.4558, "drive"],
        ["Grand Canyon Village, AZ", 36.0544, -112.1401, "drive"]] },

  { id: "crew-joins", title: "The crew joins along the way",
    blurb: "You start alone; people arrive at different stops. Tag who is on which leg once it is yours.",
    o: ["Seattle, WA", 47.6062, -122.3321],
    l: [["Portland, OR", 45.5152, -122.6784, "drive"],
        ["Bend, OR", 44.0582, -121.3153, "drive"],
        ["PDX — Portland International Airport", 45.5887, -122.5975, "fly"]] },

  { id: "city-break", title: "One city, a few days",
    blurb: "Barely a route — a base and the places you mean to reach on foot.",
    o: ["Lisbon, Portugal", 38.7223, -9.1393],
    l: [["Belém, Lisbon", 38.6971, -9.2065, "walk"],
        ["Alfama, Lisbon", 38.7139, -9.1276, "walk"]] },

  { id: "weekend-water", title: "Out on the water",
    blurb: "Drive to the put-in, paddle, come back. The canoe gets its own vehicle (D-048).",
    o: ["Minneapolis, MN", 44.9778, -93.265],
    l: [["Ely, MN", 47.9032, -91.867, "drive"],
        ["Basswood Lake, MN", 48.0833, -91.55, "water"],
        ["Ely, MN", 47.9032, -91.867, "water"]] },

  { id: "one-way-flight", title: "Simple one-way",
    blurb: "Two points and a flight. The smallest trip worth keeping a record of.",
    o: ["JFK — John F. Kennedy International Airport", 40.6413, -73.7781],
    l: [["LHR — London Heathrow Airport", 51.4700, -0.4543, "fly"]] },
];

const enc = (o) => Buffer.from(JSON.stringify(o), "utf8")
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const link = (s) => `${SITE}/new#t=start&d=` + enc({
  n: s.title,
  o: { name: s.o[0], lat: s.o[1], lng: s.o[2] },
  l: s.l.map(([name, lat, lng, mode]) => ({ to: { name, lat, lng }, mode })),
});

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ── the page ─────────────────────────────────────────────────────────────── */
const cards = SHAPES.map((s) => `      <li class="start">
        <a class="start-go" href="/new#t=start&amp;d=${enc({ n: s.title, o: { name: s.o[0], lat: s.o[1], lng: s.o[2] }, l: s.l.map(([n2, la, lo, m]) => ({ to: { name: n2, lat: la, lng: lo }, mode: m })) })}">
          <b>${esc(s.title)}</b>
          <span>${esc(s.blurb)}</span>
          <em>${s.l.length} leg${s.l.length > 1 ? "s" : ""} &middot; open and change everything &rarr;</em>
        </a>
      </li>`).join("\n");

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting points — this trip, btw</title>
<meta name="description" content="Blank starting shapes for a trip: road trip, two vehicles meeting, rail, bike tour, a move. Open one and change everything — free, no account.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='16' fill='%23035A83'/%3E%3Cpath d='M0 68h100v16a16 16 0 0 1-16 16H16A16 16 0 0 1 0 84z' fill='%23F7B304'/%3E%3C/svg%3E">
<style>
  .starts{list-style:none;display:grid;gap:12px;margin:0;padding:0}
  .start-go{display:block;padding:15px 17px;text-decoration:none;border-radius:12px;
    background:var(--card);border:2px solid var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.15)}
  .start-go b{display:block;font-family:var(--font-family-display);font-weight:700;
    font-size:19px;letter-spacing:.02em;color:var(--ink)}
  .start-go span{display:block;margin:3px 0 7px;font-size:14.5px;color:var(--soft);line-height:1.5}
  .start-go em{font-style:normal;font-family:var(--font-family-display);font-weight:700;
    font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--link)}
  .start-go:hover{transform:translateY(-1px)}
</style>
<link rel="stylesheet" href="/tokens.css?v=2">
<link rel="stylesheet" href="/sky.css?v=4">
<link rel="stylesheet" href="/pages.css?v=21">
<script>var h=new Date().getHours(),s=h<5?"night":h<8?"dawn":h<18?"day":h<21?"dusk":"night";document.documentElement.setAttribute("data-sky",s);</script>
</head>
<body>
<button id="menuBtn" aria-label="Menu" aria-haspopup="true" aria-expanded="false" aria-controls="menu">&#9776;</button>
<nav id="menu">
  <a href="/">Home</a><a href="/what-you-get">What's free</a><a href="/about">About</a><a href="/help">Help</a><a href="/faq">FAQ</a>
</nav>

<header class="pagehead">
  <a class="sign" href="/"><b>this trip, btw</b></a>
  <h1>Starting points</h1>
  <p class="lede">Shapes, not itineraries. Open one and change every part of it.</p>
</header>

<main class="pagebody sheet">
  <section>
    <p>None of these is a recommendation &mdash; they are the <strong>shapes</strong> trips come
    in, with placeholder places you replace. Opening one costs nothing and asks for nothing: no
    account, no card, no email. It is yours to edit the moment it loads, and only yours until
    you decide to keep it.</p>
    <ul class="starts">
${cards}
    </ul>
  </section>

  <section>
    <h2>If you are an assistant</h2>
    <p>Each of these is an ordinary <code>#d=</code> handover link &mdash; the same format
    described on <a href="/for-agents">the agent page</a>. Hand one to someone as a starting
    point, or read them as worked examples of the range: two vehicles converging, a canoe leg,
    a rail loop, a crew joining partway. Build your own the same way.</p>
  </section>
</main>

<footer class="pagefoot"><a href="/">home</a><span class="sep">&middot;</span><a href="/about">about</a><span class="sep">&middot;</span><a href="/for-agents">for agents</a><span class="sep">&middot;</span><a href="/help">help</a><span class="sep">&middot;</span><a href="/faq">faq</a><span class="sep">&middot;</span><a href="/privacy">privacy</a><span class="sep">&middot;</span><a href="/terms">terms</a><br><a href="mailto:support@thistripbtw.us">support@thistripbtw.us</a></footer>
<script src="/pages.js?v=1"></script>
</body>
</html>
`;

writeFileSync(new URL("../public/starts.html", import.meta.url), page);

/* ── the llms.txt block, between markers so this is re-runnable ───────────── */
const llmsPath = new URL("../public/llms.txt", import.meta.url);
let llms = readFileSync(llmsPath, "utf8");
const BEGIN = "<!--starts-->", END = "<!--/starts-->";
// Names and blurbs only — NOT the encoded links. Twelve base64 strings is ~5KB of opaque
// data in a file whose entire job is to be read; the gallery carries the actual links, one
// fetch away, and an agent that wants one builds it from the format above anyway.
const block = [
  BEGIN,
  "## Starting shapes",
  "",
  `Ready-made starting points at ${SITE}/starts — each card is an ordinary \`#d=\` link you can`,
  "hand someone, and together they show the range this format carries. Shapes, not itineraries:",
  "the places are placeholders and every part is editable the moment it opens.",
  "",
  ...SHAPES.map((s) => `- **${s.title}** — ${s.blurb}`),
  END,
].join("\n");
llms = llms.includes(BEGIN)
  ? llms.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block)
  : llms.replace("## Pages", block + "\n\n## Pages");
writeFileSync(llmsPath, llms);

console.log(`${SHAPES.length} starting shapes → public/starts.html + llms.txt block`);
for (const s of SHAPES) console.log(`  ${s.id.padEnd(16)} ${link(s).length} chars`);
