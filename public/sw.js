/* THE SERVICE WORKER — the shell, and nothing but the shell.
 *
 * WHY THIS EXISTS. Four offline features were already built and all four were unreachable:
 * the trip cache (`ttb_trip_<slug>`), the map archive in IndexedDB, the outbox, and the crew
 * roster. Every one of them sits on the device, intact, behind a page that could not boot with
 * no signal. This is the page booting.
 *
 * WHY IT WAS NOT BUILT BEFORE, AND WHY IT IS NOW. app.html's own comment: a service worker is
 * "the better product" but "one of the few ways to brick a web app permanently for returning
 * visitors, which is not a thing to ship days before a real trip." The trip is over. That is a
 * decision coming due, not a decision being second-guessed.
 *
 * ── THE FOUR RULES, AND EVERY ONE IS LOAD-BEARING ────────────────────────────────────────────
 *
 * 1. SHELL ONLY. NEVER THE API. Trip state already has its own cache in app.html with the
 *    seal_pin() reasoning worked out: we keep only what the SERVER chose to send, and an unopened
 *    sealed drop was blanked before it left the server, so the words were never on the device.
 *    A second cache here would make that judgement again, in a second place, and put sealed drops
 *    behind two locks with one key. Sealed drops are a hard constraint. /api/ is passed through
 *    untouched and there is no code path in this file that can cache one.
 *
 * 2. NETWORK-FIRST, ALWAYS. Not cache-first. A slow load beats a stale one, and network-first is
 *    the only variant that cannot brick: any successful fetch replaces what is cached, so a bad
 *    entry survives exactly one online load. THIS IS THE ANSWER TO THE COMMENT ABOVE.
 *
 * 3. THE KILL SWITCH SHIPS IN VERSION ONE. You cannot add an escape hatch to a worker that is
 *    already serving a broken shell. Three ways out: `?nosw=1` on any URL bypasses this file
 *    entirely (checked BEFORE anything else), postMessage({type:"KILL"}) empties every cache and
 *    unregisters, and skipWaiting/clients.claim mean a new worker takes over on the next load
 *    rather than waiting for every tab to close.
 *
 * 4. RANGE REQUESTS AND /maps/ ARE UNTOUCHABLE. The PMTiles archives are served over HTTP Range
 *    and the world archive is 178 MB. A service worker that answers a Range request with a whole
 *    cached body produces D-166's exact signature — repeating whole-file GETs — from a fourth
 *    cause. The offline archive has its own IndexedDB store and its own fetch patch in the page,
 *    which sits ABOVE this file and never reaches it when a saved copy is in hand.
 *
 * ── THE CLOUDFLARE TRAP, WHICH IS WHY THIS FILE IS SERVED AS `/sw` ───────────────────────────
 *
 * Cloudflare ignores the origin Cache-Control (~4h edge TTL) and keys its caching on the URL
 * EXTENSION. `.js` is on its list. So `/sw.js` would sit stale at the edge for hours — and this
 * is the one file where that is catastrophic, because the thing you ship to repair a bad worker
 * IS this file. You would be unable to push the fix, for four hours, to exactly the people stuck.
 * D-166 established the mechanism from the other side: `.pmtiles` was not on the list and went
 * DYNAMIC, `.bin` was and went HIT. So index.php routes the EXTENSIONLESS `/sw` and serves these
 * bytes with a JavaScript content type. Scope defaults to the script's directory, which is `/`.
 * VERIFY `cf-cache-status` ON `/sw` AFTER ANY DEPLOY THAT TOUCHES THE ROUTE. It must not be HIT.
 */

/* Set by KILL, and checked at the top of every fetch. Without it the kill is not total: the page
   that tears the worker down is still loading its own assets, those requests still reach the fetch
   handler, and `caches.open()` CREATES a cache on a miss — so an emptied cache name reappears
   moments after being deleted. Harmless (the entries really were gone) but it makes the escape
   hatch look like it failed, and an escape hatch you cannot trust the readout of is not one. */
let KILLED = false;

/* A ring of what the fetch handler actually decided, readable from the page via a MessageChannel
   (`swStats()` in app.html). Added 2026-08-26 after theorising twice about why a poisoned shell
   survived a controlled reload — the repo's own rule is that every false finding came from an
   instrument and every real one came from arithmetic, and neither is available while the decision
   is invisible. Bounded, so it cannot grow; carries no URLs beyond the path, which is already in
   the address bar. */
const LOG = [];
const note = m => { LOG.push(m); if (LOG.length > 40) LOG.shift(); };

const V     = "ttb-shell-v3";   // v3: the logo recoloured to the palette (D-192); activate() drops v2
const SHELL = V + "-shell";
const RUN   = V + "-runtime";

/* The page itself, cached under ONE key for EVERY trip. index.php:311 streams app.html unchanged
   for any slug and all trip data arrives from the API, so the shell is byte-identical across
   trips and one cached copy serves them all. */
const SHELL_KEY = "/__ttb_shell";

/* Read out of app.html 2026-08-26. `?v=` values are part of the URL and therefore part of the
   cache key, which is what makes a deploy that bumps one self-invalidating.
   mapstyle.js IS THE ONE YOU WILL FORGET: it is fetched at runtime (app.html:3180, :3322), not a
   <script src>, so it does not appear in any grep for tags. Missing it means an offline page with
   no basemap — the exact failure D-167 and cbda85b each cost this repo days over. */
const ASSETS = [
  "/tokens.css?v=6",
  "/fonts.css?v=1",
  "/vendor/leaflet-1.9.4/leaflet.min.css?v=1",
  "/vendor/leaflet-1.9.4/leaflet.min.js?v=1",
  "/legs.js?v=3",
  "/ring.js?v=3",
  "/sheet.js?v=1",
  "/places.js?v=5",
  "/mapstyle.js?v=5",
  "/logo.svg?v=2",
  "/fonts/barlow-400.woff2",
  "/fonts/barlow-500.woff2",
  "/fonts/barlow-600.woff2",
  "/fonts/barlow-condensed-500.woff2",
  "/fonts/barlow-condensed-600.woff2",
  "/fonts/barlow-condensed-700.woff2",
];

/* NOT precached, cached on first use: places-index.json is 2 MB (40k cities and airports) and
   places.js is local-first, so once it has been fetched once, place search works with no signal.
   Precaching it would make every install pay 2 MB for something a given visitor may never open. */
const RUNTIME_OK = [/^\/places-index\.json/];

/* The trip slug alphabet, identical to index.php:311 — note it excludes i, l, o and 1.
   THE TRAILING SLASH IS NOT OPTIONAL TO ALLOW FOR: every real link this product hands out is
   `/{slug}/#k=…`, so an anchored `$` after the seven characters matched the shape nobody uses.
   Measured 2026-08-26 — the navigation branch never fired once against a genuine trip URL. */
const SLUG = /^\/[a-hj-km-np-z2-9]{7}\/?$/;

self.addEventListener("install", e => {
  /* addAll() is atomic: one 404 and NOTHING caches, which is the honest behaviour — a half
     cached shell is a page that loads and then dies on a missing script. */
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUN) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  const d = e.data || {};

  /* Kill switch, rule 3. Empties every cache and unregisters; the page reloads itself after. */
  if (d.type === "KILL") {
    KILLED = true;
    e.waitUntil((async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
    })());
    return;
  }

  /* THE PAGE HAS TO HAND US THE SHELL, AND FINDING THAT OUT COST A MEASUREMENT.
     A navigation is only routed through a worker that was ALREADY controlling the page, and the
     navigation that installs a worker is by definition not. So on a first visit nothing ever
     reached the fetch handler with the shell in it, and the cache stayed empty — while the page
     still appeared to work offline, because Chrome's own HTTP cache answered. That is the worst
     shape a test can take: a real failure wearing a pass. The page now tells us its own URL once
     it is controlled, and we fetch and store it under the single shared key. */
  if (d.type === "STATS" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ killed: KILLED, log: LOG.slice() });
    return;
  }

  if (d.type === "CACHE_SHELL" && typeof d.url === "string") {
    e.waitUntil((async () => {
      try {
        const res = await fetch(d.url, { credentials: "same-origin" });
        if (res && res.status === 200) {
          await (await caches.open(SHELL)).put(SHELL_KEY, res.clone());
          note("CACHE_SHELL stored " + d.url);
        } else note("CACHE_SHELL status " + (res && res.status));
      } catch (err) { note("CACHE_SHELL threw " + err.name); }
    })());
  }
});

/* Network-first with a cache fallback, and the cache is only written on a real 200.
   An opaque or errored response is never stored — that is how a CDN hiccup becomes permanent.
 *
 * THE EVENT IS A PARAMETER BECAUSE THE PUT MUST BE INSIDE waitUntil, AND THAT COST A MEASUREMENT.
 * A fetch handler may return its response and let the worker terminate immediately; a `cache.put`
 * that nobody is waiting on is simply dropped when it does. The symptom was exact and misleading:
 * the shell cached fine on a first visit (CACHE_SHELL happens to run inside waitUntil) and then a
 * deliberately poisoned entry survived every subsequent online load — so the anti-brick property
 * looked broken when what was actually broken was the write that repairs it. `res.type` was
 * "basic" and the status was 200 the whole time, which is why reading the response taught nothing.
 * Fire-and-forget is not a style choice in a service worker; it is a lost write. */
async function netFirst(e, req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === "basic") {
      e.waitUntil(cache.put(key || req, res.clone()));
      note("put " + (key || req.url));
    } else note("no-put status=" + (res && res.status) + " type=" + (res && res.type));
    return res;
  } catch (err) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", e => {
  if (KILLED) return;
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* RULE 3, CHECKED FIRST AND BEFORE ANYTHING ELSE: an escape hatch that runs after other logic
     is an escape hatch that a bug can stand in front of. */
  if (url.searchParams.has("nosw")) return;

  if (url.origin !== self.location.origin) return;   // nothing we ship is third-party anyway
  if (req.headers.has("range")) return;              // rule 4 — never answer a Range from a cache
  if (url.pathname.startsWith("/api/")) return;      // rule 1 — the API is not ours to hold
  if (url.pathname.includes("/api/")) return;        // /{slug}/api/* is the real shape
  if (url.pathname.startsWith("/photos/")) return;   // media, and some of it is sealed
  if (url.pathname.startsWith("/maps/")) return;     // rule 4 — archives have their own store
  if (url.pathname === "/sw") return;                // never cache the escape hatch itself

  /* A trip page. Cached under one key for every slug (see SHELL_KEY).
     DELIBERATELY NOT /new: creating a trip needs the server to mint a slug and take a payment, so
     an offline builder shell would load into a dead end. Scope stays on the surface people paid
     for until there is a reason to widen it. */
  if (req.mode === "navigate" && SLUG.test(url.pathname)) {
    note("nav " + url.pathname);
    e.respondWith(netFirst(e, req, SHELL, SHELL_KEY));
    return;
  }
  if (req.mode === "navigate") note("nav UNMATCHED " + url.pathname);

  const path = url.pathname + url.search;
  if (ASSETS.includes(path)) { e.respondWith(netFirst(e, req, SHELL)); return; }
  if (RUNTIME_OK.some(re => re.test(url.pathname))) { e.respondWith(netFirst(e, req, RUN)); return; }
  /* Everything else falls through to the network untouched. A allowlist, not a denylist: the
     failure mode of a denylist here is caching something private by omission. */
});
