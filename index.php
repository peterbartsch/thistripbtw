<?php
/* this trip, btw — front controller (mirror of worker.js `fetch` routing).
   apex/www/reserved → landing · {slug}.apex → app shell · /api/* → JSON · /photos/* → media.
   Doubles as the `php -S` router for local dev (photos served here when Apache isn't). */
define('SECURE_ACCESS', true);

// never leak stack traces / SQL into responses; any uncaught error → clean JSON 500
ini_set('display_errors', '0');
set_exception_handler(function ($e) {
  if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json'); header('Cache-Control: no-store'); }
  echo json_encode(['error' => 'server error']);
});

require_once __DIR__ . '/lib/config.php';

/* CONSTANTS GO AT THE TOP, and this cost a debugging round: they sat beside send_body() near the
   bottom of the file and every page 500'd. Functions are hoisted, `const` is NOT — it executes
   where it is written, and the routing below calls serve_html() and exit()s long before control
   ever reaches the bottom of this file. So send_body() referenced a constant that did not exist
   yet and threw; the exception handler turned it into {"error":"server error"} and the response
   was 24 bytes with the ETag already on it. CLAUDE.md names this trap exactly, for an IIFE — it
   applies to any top-level code that runs above the declaration, which here is all of it.
   See send_body() for why the level is 1. */
const GZ_MIN_BYTES = 1024;      // below this the gzip header costs more than it saves
const GZ_LEVEL     = 1;

/* path-based routing (D-021): trips live at /{slug}, not {slug}.apex.
   /                     → landing
   /api/*                → apex API (claim)
   /{slug}               → app shell (client reads slug from the path)
   /{slug}/api/*         → trip API (sub = slug)
   /photos/{slug}/file   → media capability URL */
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rawurldecode($path);
$segs = array_values(array_filter(explode('/', $path), fn($s) => $s !== ''));

/* /photos/* → media (Apache serves real files directly; this is the php -S fallback) */
if (strpos($path, '/photos/') === 0) { serve_photo(substr($path, 8)); exit; }

/* apex API: /api/* (only /api/claim today) */
if (($segs[0] ?? null) === 'api') {
  require __DIR__ . '/api.php';
  api_main(null, implode('/', array_slice($segs, 1)));
  exit;
}

/* apex → landing.

   The post-checkout block ("Payment received — name your trip", both phrase fields, the
   password box) lives in index.html because its JavaScript does, and splitting a working
   paid-return flow across two files to move some markup is a bad trade. But it was in the DOM
   of every crawl: Google could index "Payment received" as homepage content, and every scraper
   and AI fetcher read a checkout confirmation as though it were the pitch.

   So it is stripped unless this request actually IS a return from Stripe — which is exactly
   when `session_id` is present, because that is what `claim` needs and what the block exists to
   consume. No redirect, no second file, no change to the Payment Links.

   The variant is folded into the ETag by serve_html(), or a cached 304 from one shape would be
   served for the other. */
if (!$segs) {
  serve_html(PUBLIC_DIR . '/index.html', isset($_GET['session_id']) ? null : 'claim');
  exit;
}

$slug = $segs[0];

/* THE SERVICE WORKER, AND IT IS SERVED EXTENSIONLESS ON PURPOSE (2026-08-26).
   Cloudflare ignores our Cache-Control (~4h edge TTL) and keys caching on the URL EXTENSION.
   `.js` is on its list, so `/sw.js` would sit stale at the edge for hours — and this is the one
   file where that is catastrophic, because the thing you ship to repair a bad service worker IS
   this file. You would be unable to push the fix, for four hours, to exactly the visitors stuck
   behind it. D-166 proved the mechanism from the other side: `.pmtiles` was not on Cloudflare's
   extension list and went DYNAMIC, `.bin` was and went HIT. An extensionless path is dynamic.
   Scope is the script's own directory, so `/sw` claims `/` with no Service-Worker-Allowed header.
   VERIFY `cf-cache-status` ON /sw AFTER ANY DEPLOY THAT TOUCHES THIS ROUTE. It must not be HIT. */
if (count($segs) === 1 && $slug === 'sw' && is_file(PUBLIC_DIR . '/sw.js')) {
  header('Content-Type: text/javascript; charset=utf-8');
  header('Cache-Control: no-store, must-revalidate');
  header('Service-Worker-Allowed: /');
  header('X-Content-Type-Options: nosniff');
  readfile(PUBLIC_DIR . '/sw.js');
  exit;
}

/* PER-TRIP MANIFEST — installing from a trip must install THAT trip (2026-08-26).
   A static /manifest.json would give every installed icon the same `start_url`, so tapping the
   thing you added from your own trip would open the landing page. That is worse than no install
   at all, because it looks like the trip is gone.

   THE PHRASE IS NOT IN HERE AND MUST NEVER BE. This file is not gated — anyone who can guess a
   slug can read it — so `start_url` carries the path and nothing else. It works because `KEY`
   already persists as `ttb_key_<slug>` in localStorage (app.html:1614) and a standalone launch
   is the same origin, so somebody who has been through the gate once is simply in.

   `scope` is the trip's own path, which keeps every other page of the site opening in the real
   browser where the address bar exists. That matters more here than in most apps: this product's
   artifact IS a URL, and an install that hides it everywhere would be hiding the product. */
if (count($segs) === 2 && $segs[1] === 'manifest.json'
    && preg_match('/^[a-hj-km-np-z2-9]{7}$/', $segs[0])) {
  header('Content-Type: application/manifest+json; charset=utf-8');
  header('Cache-Control: no-cache');
  header('X-Content-Type-Options: nosniff');
  $base = '/' . $segs[0] . '/';
  echo json_encode([
    'name'             => 'this trip, btw',
    'short_name'       => 'this trip',
    'start_url'        => $base,
    'scope'            => $base,
    'display'          => 'standalone',
    'orientation'      => 'portrait',
    'background_color' => '#0A4DA2',
    'theme_color'      => '#0A4DA2',
    'icons'            => [
      ['src' => '/icon-192.png?v=2', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
      ['src' => '/icon-512.png?v=2', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
    ],
  ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
  exit;
}

/* static content pages: /privacy, /about, /mission, /help, /what-you-get, /account, /tutorials */
if (count($segs) === 1 && in_array($slug, ['privacy','about','mission','help','terms','faq','what-you-get','account','for-agents','agent-ready','reset','starts','tutorials'], true)
    && is_file(PUBLIC_DIR . '/' . $slug . '.html')) {
  serve_html(PUBLIC_DIR . '/' . $slug . '.html'); exit;
}

/* static assets at root: /demo.jpg, /og.png, /site.css, etc. (single segment, known ext, exists in public/).
   Trip slugs are [a-z2-9]{7} with no dot, so this never shadows a trip. */
if (count($segs) === 1 && preg_match('/\.(jpg|jpeg|png|gif|webp|svg|css|ico|js|json|xml|txt|woff2?)$/i', $slug)
    && is_file(PUBLIC_DIR . '/' . $slug)) {
  serve_asset(PUBLIC_DIR . '/' . $slug); exit;
}

/* NESTED assets: the self-hosted fonts and vendored Leaflet (2026-07-30).
   The rule above is single-segment only, and .htaccess only lets Apache serve a file directly
   when it exists AT THE DOCROOT — assets live under public/, so they never do. Without this,
   a nested asset falls through and gets the LANDING PAGE back with HTTP 200 and
   Content-Type: text/html. That is the dangerous shape: the browser rejects the HTML as a font
   silently, and executes it as JavaScript, so leaflet.min.js dies on a syntax error and every
   map breaks while every status code says 200. Measured before this existed; not theoretical.

   Two directories only, and the path is rebuilt from a strict pattern rather than trusted, so
   `..` cannot appear. realpath() containment is the belt to that braces. */
if (count($segs) >= 2
    && preg_match('#^(fonts|vendor)/[A-Za-z0-9._/-]+\.(woff2?|css|js|png|svg)$#', implode('/', $segs))
    && !str_contains(implode('/', $segs), '..')) {
  $rel  = implode('/', $segs);
  $full = realpath(PUBLIC_DIR . '/' . $rel);
  $root = realpath(PUBLIC_DIR);
  if ($full !== false && $root !== false && str_starts_with($full, $root . '/') && is_file($full)) {
    serve_asset($full); exit;
  }
}

/* `.htaccess` blocks every dotted path EXCEPT `.well-known/`, so these are reachable, but they
   live under public/ and the single-segment asset rule above is single-segment only — without
   this they fall through to the 404.

   `mcp-registry-auth` carries the PUBLIC half of the domain-namespace key pair (D-090). It is
   meant to be world-readable: it is what proves to the MCP registry that thistripbtw.us is ours,
   which is what lets the listing bind a remote endpoint to this domain. The private half never
   goes near this repo. */
if (count($segs) === 2 && $segs[0] === '.well-known'
    && in_array($segs[1], ['mcp.json', 'mcp-registry-auth', 'api-catalog', 'security.txt'], true)
    && is_file(PUBLIC_DIR . '/.well-known/' . $segs[1])) {
  // no extension on mcp-registry-auth, so name the type rather than letting it guess
  if ($segs[1] === 'mcp-registry-auth') { header('Content-Type: text/plain; charset=utf-8'); header('Cache-Control: no-store'); readfile(PUBLIC_DIR . '/.well-known/mcp-registry-auth'); exit; }
  /* RFC 9727 wants application/linkset+json, and the file has no extension to infer it from.
     It lists ONE api, because there is one: the MCP endpoint. The trip API is per-trip and
     phrase-gated, so it is not a public API and does not belong in a public catalog. */
  if ($segs[1] === 'api-catalog') { header('Content-Type: application/linkset+json; charset=utf-8'); header('Cache-Control: public, max-age=3600'); readfile(PUBLIC_DIR . '/.well-known/api-catalog'); exit; }
  /* SERVE WHAT WAS ASKED FOR, not a hardcoded mcp.json. This line used to name that file
     directly, which was harmless while it was the only fallthrough and became a trap the moment
     a second one was added: security.txt was whitelisted above and then answered 200 with
     mcp.json's body and Content-Type: application/json. The whitelist and the is_file() check
     already constrain $segs[1] to a known name, so building the path from it is safe and the
     next file added works without touching this line. */
  serve_asset(PUBLIC_DIR . '/.well-known/' . $segs[1]); exit;
}

/* /.well-known/agent-skills/index.json — the skills discovery index. THREE segments, so the
   two-segment .well-known rule above cannot reach it, and .htaccess only opens `.well-known/`
   rather than serving what is inside it.

   We publish this one because we have a skill to publish: D-119's Claude Skill is real, tested by
   test/skill-parity.mjs, and until now was announced nowhere. That is the whole test applied to
   the rest of the agentic-web checklist too — an api-catalog, an OAuth issuer, an x402 wallet and
   an agent-registration endpoint were all declined on 2026-08-04 because we do not have those
   things and saying we do would be the same lie in machine-readable form. */
if (count($segs) === 3 && $segs[0] === '.well-known' && $segs[1] === 'agent-skills'
    && $segs[2] === 'index.json'
    && is_file(PUBLIC_DIR . '/.well-known/agent-skills/index.json')) {
  serve_asset(PUBLIC_DIR . '/.well-known/agent-skills/index.json'); exit;
}

/* /skill — the Claude Skill (D-119), served EXTENSIONLESS and only this one file.

   `.htaccess` denies every `.md` in the tree by FilesMatch, and FilesMatch is evaluated against
   the REQUESTED filename, so the rewrite to index.php cannot rescue it: /skill/SKILL.md is a hard
   403 no routing can undo. Exactly the trap /mcp/readme already works around, and I walked into
   it anyway — it 403'd in production while returning 200 locally, because the deny lives in
   Apache config that `php -S` never reads.

   `.py` is worse: it 500s, because the server tries to hand it to a handler. Not served at all.
   The skill references build_link.py as a path INSIDE the installed skill, never as a URL, so
   nothing needs it over HTTP.

   AND THE URL IS `/agent-skill`, NOT `/skill`, for a third reason found the same way. Adding
   `skill` to deploy.sh's allowlist puts a REAL DIRECTORY at the docroot, and Apache resolves a
   real path before it rewrites to index.php: `/skill` hit the directory, directory listing is
   off, and it 403'd — with this handler's Content-Type header on the response, which is how you
   can tell PHP ran and lost anyway. Any single-segment route whose name matches a shipped
   top-level directory has this problem. */
/* /agent-skill/build_link.py — the script the skill actually runs.
   The note above is right that an INSTALLED skill reaches this by relative path and never needs
   a URL. But `/.well-known/agent-skills/index.json` advertises `/agent-skill` to the world, and
   a model that fetches that gets a document telling it to run a file it was never given and has
   no way to get. The index made a promise the URL could not keep.
   PHP readfile()s it as text/plain for the same reason /agent-skill works: Apache never sees a
   real `.py` to hand to a handler, so the 500 documented above cannot happen on this path.
   `agent-skill` is not a shipped top-level directory, so the 403 trap does not apply either. */
if (count($segs) === 2 && $segs[0] === 'agent-skill' && $segs[1] === 'build_link.py'
    && is_file(__DIR__ . '/skill/scripts/build_link.py')) {
  header('Content-Type: text/plain; charset=utf-8');
  header('Cache-Control: public, max-age=3600');
  header('X-Content-Type-Options: nosniff');
  readfile(__DIR__ . '/skill/scripts/build_link.py');
  exit;
}
if (count($segs) === 1 && $segs[0] === 'agent-skill' && is_file(__DIR__ . '/skill/SKILL.md')) {
  header('Content-Type: text/markdown; charset=utf-8');
  header('Cache-Control: public, max-age=3600');
  header('X-Content-Type-Options: nosniff');
  readfile(__DIR__ . '/skill/SKILL.md');
  exit;
}

/* /maps/*.pmtiles — a self-hosted vector basemap (?pm=1 prototype).
   ON PRODUCTION APACHE NEVER REACHES THIS: maps/ is a real directory at the docroot, so rule 4's
   `-f` serves the file directly and Apache does Range natively. This is the `php -S` fallback,
   the same shape photos/ has — and it is not optional for dev, because PMTiles is built entirely
   on HTTP Range and the built-in server does not implement it. Without Range a client asking for
   one 4 KB tile is handed 11 MB.
   Name matched against a strict pattern and rebuilt rather than trusted, with realpath
   containment behind it — the same belt and braces as the vendor/fonts route above. */
/* Two shapes: /maps/<name>.pmtiles for the shared demo archive, and /maps/trips/<token>.pmtiles
   for a per-trip one. The token is HMAC(slug, TILES_SALT) and is handed out only by an
   authenticated trip/state — a per-trip basemap is a map of where somebody is going, so naming
   the file after the slug would leak the route to anyone holding a link. */
if (((count($segs) === 2 && $segs[0] === 'maps')
     || (count($segs) === 3 && $segs[0] === 'maps' && $segs[1] === 'trips'))
    && preg_match('/^[A-Za-z0-9._-]+\.pmtiles\.bin$/', $segs[count($segs) - 1])
    && !str_contains(implode('/', $segs), '..')) {
  $rel  = implode('/', array_slice($segs, 1));
  $full = realpath(__DIR__ . '/maps/' . $rel);
  $root = realpath(__DIR__ . '/maps');
  if ($full !== false && $root !== false && str_starts_with($full, $root . '/') && is_file($full)) {
    serve_range($full, 'application/octet-stream');
    exit;
  }
}

/* POST /mcp → the remote MCP endpoint (D-081). Connectors take a URL, and a URL is a click
   where a local Node path is a project. Single segment, so it never collides with the file
   routes just below it. */
if (count($segs) === 1 && $segs[0] === 'mcp') {
  require __DIR__ . '/lib/mcp.php';
  mcp_main();
  exit;
}

/* /mcp/* → the MCP server, its README, licence and manifests (D-080).
   `/for-agents` has always told people to run `node /path/to/thistripbtw-mcp.mjs`, and until
   now that path existed only in this repo — the URL returned the trip client with HTTP 200,
   so the single most important agent-distribution asset on the site was unobtainable by
   anyone reading the page that advertises it.

   These files live in mcp/ at the repo root, NOT under public/, so no other rule here can
   reach them and Apache cannot serve them either. Names are matched against a strict pattern
   and the path is rebuilt rather than trusted, with realpath containment behind that. */
if (count($segs) === 2 && $segs[0] === 'mcp'
    && preg_match('/^[A-Za-z0-9._-]+\.(mjs|js|json|md|txt)$/', $segs[1])
    && !str_contains($segs[1], '..')) {
  $full = realpath(__DIR__ . '/mcp/' . $segs[1]);
  $root = realpath(__DIR__ . '/mcp');
  if ($full !== false && $root !== false && str_starts_with($full, $root . '/') && is_file($full)) {
    serve_asset($full); exit;
  }
}
if (count($segs) === 2 && $segs[0] === 'mcp' && $segs[1] === 'LICENSE'
    && is_file(__DIR__ . '/mcp/LICENSE')) { serve_asset(__DIR__ . '/mcp/LICENSE'); exit; }
/* /mcp/readme, with no extension, is README.md. `.htaccess` denies every `.md` in the tree by
   FilesMatch, and FilesMatch is evaluated against the REQUESTED filename — the rewrite to
   index.php does not save it, so /mcp/README.md is a hard 403 no routing can undo. Weakening
   that deny to rescue one file would expose every other README and governance doc, so the file
   gets a name Apache has no opinion about instead. */
if (count($segs) === 2 && $segs[0] === 'mcp' && $segs[1] === 'readme'
    && is_file(__DIR__ . '/mcp/README.md')) {
  header('Content-Type: text/markdown; charset=utf-8');
  header('Cache-Control: no-cache');
  header('X-Content-Type-Options: nosniff');
  readfile(__DIR__ . '/mcp/README.md');
  exit;
}

/* ONE builder (D-120, §2e). There were three, all writing the same v3 draft: /quick's ring,
   /new's leg cards, and /quicktree's node tree. /new survives — it is the only INDEXABLE one,
   and it holds everything expensive: the chat, road routing, both import families, export, the
   `#d=` agent handover that /starts, /for-agents and /tutorials all hardcode, multi-route, crew,
   stays and the three-tier checkout. Six test files also extract real functions out of it by
   filename. The ring ported IN rather than /new porting out, as public/ring.js.

   /radial points straight at /new rather than at /quick, which now redirects too — a
   301 → 301 chain costs a round trip and every crawler that follows it reads a slower site. */
if (count($segs) === 1 && in_array($slug, ['radial', 'quick', 'quicktree'], true)) {
  header('Location: /new', true, 301); exit;
}
if (count($segs) === 1 && $slug === 'new'
    && is_file(PUBLIC_DIR . '/new.html')) {
  /* D-187: one byte to var/tally, no identity — "did anyone arrive today" is the question this
     product has been unable to answer since it launched. See lib/tally.php for what it is not. */
  require_once __DIR__ . '/lib/tally.php'; tally('new');
  serve_html(PUBLIC_DIR . '/new.html'); exit; }

/* a reserved word as the first segment is never a trip → landing */
if (in_array($slug, RESERVED, true)) { serve_html(PUBLIC_DIR . '/index.html'); exit; }

/* /{slug}/og.png → the trip's link-preview card (D-123). Public by design — it IS a preview —
   and it draws the trip's NAME and nothing else. See lib/ogcard.php for why that boundary is
   where it is, and why no scraper here can ever be authenticated. */
if (count($segs) === 2 && ($segs[1] ?? null) === 'og.png'
    && preg_match('/^[a-hj-km-np-z2-9]{7}$/', $slug)) {
  /* require_once, all three: config.php is ALREADY loaded at the top of this file, and a plain
     require re-declares its functions, which is a fatal — the endpoint 500'd on the server
     while rendering perfectly when run standalone. SECURE_ACCESS likewise may already be set. */
  if (!defined('SECURE_ACCESS')) define('SECURE_ACCESS', true);
  require_once __DIR__ . '/lib/config.php';
  require_once __DIR__ . '/lib/db.php';
  require_once __DIR__ . '/lib/ogcard.php';
  og_card_serve($slug);
  exit;
}

/* /{slug}/api/* → trip API */
if (($segs[1] ?? null) === 'api') {
  require __DIR__ . '/api.php';
  api_main($slug, implode('/', array_slice($segs, 2)));
  exit;
}

/* /{slug} → app shell, but ONLY where the path is shaped like a trip address. Everything
   that reaches here otherwise is a real 404.

   Until 2026-07-31 this line was unconditional, so EVERY unmatched path answered 200 with the
   whole 164KB trip client: /sitemap.xml, /openapi.json, /.well-known/mcp.json, /llms-full.txt,
   and any URL a crawler cared to invent. Two costs, one of them not obvious:

     - soft 404s at infinite scale, which is a known way to burn crawl budget, and
     - it broke robots.txt. Cloudflare looks for an existing robots.txt by asking for one,
       got HTTP 200 from THIS line, and prepended its managed block to a complete HTML
       document. The live file was 165KB: directives, then a web page.

   The alphabet is duplicated from api.php's SLUG_ALPHABET rather than shared, because
   index.php does not load api.php unless it is routing to the API and should not start.
   It is 'abcdefghjkmnpqrstuvwxyz23456789' — no 0/1/i/l/o — and the exclusions are load-bearing
   here: they are why /sitemap, /privacy, /account and most English words cannot be mistaken
   for a trip. Keep the two in step. */
if (count($segs) === 1 && preg_match('/^[a-hj-km-np-z2-9]{7}$/', $slug)) {
  serve_html(PUBLIC_DIR . '/app.html', null, $slug);
  exit;
}

serve_404();

/* ── local static helpers ────────────────────────────────── */

/* A real 404 with a real page. Kept separate from serve_html() on purpose: no ETag, no 304,
   no conditional GET. A cached "not found" is the one response you never want sticking to a
   URL, because the address it denies is often one that is about to start existing. */
function serve_404() {
  http_response_code(404);
  header('Content-Type: text/html; charset=utf-8');
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: DENY');
  header('Referrer-Policy: no-referrer');
  /* RFC 8288 discovery, using REGISTERED IANA relations only and pointing at two things that
     genuinely exist: the MCP manifest and the agent documentation. An agent-readiness checker
     flagged the absence 2026-08-04.
     Its other six findings were declined and the reason is worth keeping: four of them asked us
     to publish OAuth discovery, protected-resource metadata and an agent-registration auth.md.
     This product has no accounts on the agent path and no protected API — that is the whole
     differentiator /agent-ready is built on — so advertising auth endpoints would be a false
     claim, not a missing feature. DNS-AID was declined too: an IETF draft whose fix is signing
     the zone with DNSSEC, which misconfigured takes the domain offline. */
  header('Link: </.well-known/mcp.json>; rel="service-desc"; type="application/json", </for-agents>; rel="service-doc"; type="text/html"');
  header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; "
    . "style-src 'self' 'unsafe-inline'; font-src 'self'; "
    . "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  $file = PUBLIC_DIR . '/404.html';
  if (is_file($file)) { readfile($file); return; }
  echo 'not found';
}

/* ── compression ─────────────────────────────────────────────────────────────────────────
 *
 * The origin sent the 339 KB app shell uncompressed. Cloudflare compresses to the BROWSER, so
 * nobody was downloading 339 KB — but CF does not cache HTML by default and `no-cache` does not
 * change that, so every trip page view pulled the whole thing off the VPS. Measured: 339,036
 * bytes raw, 135,398 at gzip level 1.
 *
 * LEVEL 1, and the number is measured rather than picked. Returns fall off a cliff after it:
 *
 *   level 1  199 KB saved   5.1 ms   39 KB per ms
 *   level 3  209 KB saved   7.6 ms   28 KB per ms
 *   level 6  219 KB saved  16.6 ms   13 KB per ms
 *
 * Level 6 buys 20 KB more for 11 ms more CPU on every full send. Since CF re-compresses with
 * brotli on the way to the browser, a better origin ratio is invisible to the visitor — it only
 * shortens the origin-to-edge hop — so paying three times the CPU for 9% more of it is a bad
 * trade on a box with no headroom to spare.
 *
 * Only ever on a full send: a 304 has no body, which is most repeat traffic.
 */
function client_takes_gzip(): bool {
  return stripos((string)($_SERVER['HTTP_ACCEPT_ENCODING'] ?? ''), 'gzip') !== false;
}

/* ONE exit for every text body this file sends. Every branch used to readfile() or echo for
   itself, which is exactly how one of them would end up as the branch that forgets to compress —
   or worse, sets Content-Length from the uncompressed size and truncates the page. */
function send_body(string $body, bool $gz): void {
  if ($gz && strlen($body) >= GZ_MIN_BYTES) {
    $z = gzencode($body, GZ_LEVEL);
    if ($z !== false) {
      header('Content-Encoding: gzip');
      header('Content-Length: ' . strlen($z));
      echo $z;
      return;
    }
  }
  header('Content-Length: ' . strlen($body));
  echo $body;
}

/* $strip names a block id to remove before sending, or null to send the file as it is. */
/* $ogSlug points this trip's link preview at its OWN card (D-123). It is a string swap and
   deliberately touches no database: index.php does not load api.php unless it is routing to the
   API, and that stays true — the card endpoint does the lookup, so the page never has to. */
function serve_html($file, $strip = null, $ogSlug = null) {
  if (!is_file($file)) {
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    echo "not found";
    return;
  }
  header('Content-Type: text/html; charset=utf-8');
  header('Cache-Control: no-cache');   // revalidate so deploys show without a hard refresh
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: DENY');
  header('Referrer-Policy: no-referrer');
  header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
  header('Permissions-Policy: geolocation=(self), camera=(), microphone=()');
  /* RFC 8288 Link headers, so an agent that reads headers and never parses HTML can still find
     the three things worth finding. Deliberately SHORT: every relation here points at something
     that already exists and is already true. We do not advertise an api-catalog, an OAuth issuer
     or a payment endpoint, because there is no public agent-facing API, no authorization server,
     and paying is the human's step by decision rather than by omission — announcing any of them
     would be describing a product we did not build.
     Not on the trip shell: a trip is nobody's business but the people holding the phrase, and
     headers are as public as the page. */
  if (basename($file) !== 'app.html') {
    header('Link: </llms.txt>; rel="describedby"; type="text/plain", '
         . '</.well-known/mcp.json>; rel="service-desc"; type="application/json", '
         . '</for-agents>; rel="service-doc"; type="text/html"', false);
  }
  // CSP. app.html needs its external origins (Leaflet, Carto tiles, OSRM, Nominatim, Spotify);
  // landing + content pages are locked down tight.
  /* 2026-07-30: Leaflet and the fonts are served from here now, so cdnjs, fonts.googleapis and
     fonts.gstatic came out of BOTH lists — which is the trap CLAUDE.md names: there are two, and
     missing the map one means the map silently never loads. `font-src` needed the opposite edit:
     it allowed gstatic and never 'self', so self-hosted faces would have been blocked outright. */
  /* quick.html and quicktree.html left the repo 2026-08-07 (§2ac). Both routes have 301'd to
     /new since D-120 folded three builders into one, so neither file could be served — they
     were 65KB of dead HTML that shipped on every deploy and got scanned by check-copy on
     every run. deploy.sh never deletes, so they lingered on the server after leaving the repo —
     both were moved to ~/env-attic/retired-2026-08-07/ by hand on 2026-08-07 and the docroot is
     clean. The 301 above meant nothing could reach them either way. */
  if (in_array(basename($file), ['app.html', 'new.html'], true)) {
    header("Content-Security-Policy: default-src 'self'; "
      . "script-src 'self' 'unsafe-inline'; "
      . "style-src 'self' 'unsafe-inline'; "
      . "font-src 'self'; "
      /* `blob:` added 2026-08-07 for the offline tile cache, and it is the narrowest thing that
         makes it work. A blob: URL names data this page itself created — it opens no network
         origin, cannot be pointed at a third party, and is unguessable and same-origin by
         construction. Without it the cache read path is silently dead: tiles store correctly,
         every lookup HITS, and every one of those hits is then blocked, so the map falls back to
         the network and looks like it is simply not caching. The console said it in one line
         once I looked ("Loading the image 'blob:…' violates the following Content Security
         Policy directive"); nothing else did. */
      /* cartocdn is BACK 2026-08-09: D-162's vector basemap renders blank on a real iPhone, so
         the raster default was restored while that is diagnosed. This is the SECOND of the two
         CSP lists CLAUDE.md warns about — miss it and the map silently never loads. */
      . "img-src 'self' data: blob: https://*.basemaps.cartocdn.com; "
      . "connect-src 'self'; "
      . "media-src 'self'; frame-src https://open.spotify.com; frame-ancestors 'none'; base-uri 'none'");
  } else {
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; "
      . "style-src 'self' 'unsafe-inline'; font-src 'self'; "
      . "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  // conditional GET: revalidate cheaply (304) instead of re-downloading the whole shell
  $mtime = filemtime($file);
  $gz = client_takes_gzip();
  /* Vary goes out on EVERY response including the 304, and it is not optional: without it a
     shared cache can hand gzipped bytes to a client that never asked for them, which renders as
     a page of binary. */
  header('Vary: Accept-Encoding');
  // The stripped and unstripped shapes are different documents and must not share an ETag.
  /* The slug is part of the ETag because the body now differs per trip: without it, a cache
     holding one trip's HTML would answer 304 for another and hand over the wrong preview. */
  /* …and the ENCODING is part of it for the same reason one step further out: gzipped and plain
     are two representations of one resource, so sharing an ETag between them lets a cache
     revalidate the wrong one. Vary alone is the polite answer; a distinct ETag is the one that
     still works when something in the chain ignores it. */
  $etag  = '"' . dechex($mtime) . '-' . dechex(filesize($file)) . ($strip ? '-s' : '')
         . ($ogSlug ? '-' . $ogSlug : '') . ($gz ? '-gz' : '') . '"';
  header('ETag: ' . $etag);
  header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
  $inm = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
  $ims = $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '';
  if ($inm === $etag || ($ims && @strtotime($ims) >= $mtime)) { http_response_code(304); exit; }
  /* Swap the site-wide card for this trip's own (D-123). str_replace on the exact literal, so
     if that markup ever changes shape the page ships unmodified rather than half-rewritten.
     $strip is the homepage's post-payment block and $ogSlug is a trip: they are never both set,
     and combining them is not silently half-handled — it is refused. */
  if ($ogSlug !== null) {
    if ($strip !== null) { send_body((string)file_get_contents($file), $gz); return; }
    send_body(str_replace(
      'content="https://thistripbtw.us/og.png?v=3"',   // MUST track the ?v= on the pages' og:image — an exact match, so a bump here-or-there-only silently drops every trip's own card
      'content="https://thistripbtw.us/' . $ogSlug . '/og.png"',
      (string)file_get_contents($file)), $gz);
    return;
  }
  if ($strip === null) { send_body((string)file_get_contents($file), $gz); return; }

  /* Remove <div id="{$strip}"> ... its matching close. Counted, not regexed: the block contains
     nested divs and a lazy match would cut it short, leaving stray markup that renders. If the
     shape is ever not what we expect, send the page whole rather than send it broken. */
  $html = (string)file_get_contents($file);
  $open = strpos($html, '<div id="' . $strip . '"');
  if ($open === false) { send_body($html, $gz); return; }
  $i = strpos($html, '>', $open);
  if ($i === false) { send_body($html, $gz); return; }
  $depth = 1; $p = $i + 1; $len = strlen($html);
  while ($p < $len && $depth > 0) {
    $nextOpen  = strpos($html, '<div', $p);
    $nextClose = strpos($html, '</div>', $p);
    if ($nextClose === false) { send_body($html, $gz); return; }   // malformed — send it whole
    if ($nextOpen !== false && $nextOpen < $nextClose) { $depth++; $p = $nextOpen + 4; }
    else { $depth--; $p = $nextClose + 6; }
  }
  send_body(substr($html, 0, $open) . substr($html, $p), $gz);
}

/* A byte-range sender, because PMTiles is nothing but ranged reads: the client fetches a header,
   then a directory, then one tile, out of an archive that may be gigabytes. Apache does this for
   free in production; `php -S` does not do it at all, and without it the prototype cannot be
   tested locally at all.
   Single ranges only. Multipart ranges are legal HTTP and no PMTiles client asks for them, so the
   honest answer to one is the whole file rather than a half-implemented multipart body. */
function serve_range($file, $type) {
  $size = filesize($file);
  header('Content-Type: ' . $type);
  header('Accept-Ranges: bytes');
  header('Cache-Control: public, max-age=86400');
  header('X-Content-Type-Options: nosniff');
  $range = $_SERVER['HTTP_RANGE'] ?? '';
  if ($range === '' || !preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m)) {
    header('Content-Length: ' . $size);
    readfile($file);
    return;
  }
  $start = $m[1] === '' ? null : (int)$m[1];
  $end   = $m[2] === '' ? null : (int)$m[2];
  if ($start === null) {                 // bytes=-N — the LAST n bytes
    $len = min((int)$end, $size); $start = $size - $len; $end = $size - 1;
  } else {
    if ($end === null || $end >= $size) $end = $size - 1;
    $len = $end - $start + 1;
  }
  if ($start < 0 || $start >= $size || $len <= 0) {
    http_response_code(416);
    header('Content-Range: bytes */' . $size);
    return;
  }
  http_response_code(206);
  header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
  header('Content-Length: ' . $len);
  $fh = fopen($file, 'rb');
  if (!$fh) return;
  fseek($fh, $start);
  /* Streamed in chunks rather than read whole: the point of a range request is not to hold the
     archive in memory, and an 11 MB file today is a 2 GB one the moment somebody extracts a
     bigger region. */
  $left = $len;
  while ($left > 0 && !feof($fh)) {
    $buf = fread($fh, (int)min(262144, $left));
    if ($buf === false || $buf === '') break;
    echo $buf; $left -= strlen($buf);
  }
  fclose($fh);
}

function serve_photo($key) {
  // capability key: <slug>/<random>.<ext> — same validation as worker.servePhoto
  if (!preg_match('#^[a-z2-9]+/[A-Za-z0-9]+\.[a-z0-9]+$#', $key)) {
    http_response_code(404); header('Content-Type: application/json');
    echo json_encode(['error' => 'not found']); return;
  }
  $file = PHOTOS_DIR . '/' . $key;
  if (!is_file($file)) {
    http_response_code(404); header('Content-Type: application/json');
    echo json_encode(['error' => 'not found']); return;
  }
  $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
  static $types = [
    'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif',
    'webp' => 'image/webp', 'heic' => 'image/heic', 'mp4' => 'video/mp4', 'mov' => 'video/quicktime',
    'webm' => 'video/webm',
  ];
  header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
  header('Cache-Control: public, max-age=31536000, immutable');
  header('Content-Length: ' . filesize($file));
  readfile($file);
}

function serve_asset($file) {
  $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
  static $types = [
    'jpg'=>'image/jpeg','jpeg'=>'image/jpeg','png'=>'image/png','gif'=>'image/gif',
    'webp'=>'image/webp','svg'=>'image/svg+xml','css'=>'text/css','ico'=>'image/x-icon','json'=>'application/json','xml'=>'application/xml',
    'js'=>'text/javascript','mjs'=>'text/javascript','md'=>'text/markdown; charset=utf-8','txt'=>'text/plain; charset=utf-8','woff'=>'font/woff','woff2'=>'font/woff2',
  ];
  header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
  header('X-Content-Type-Options: nosniff');
  // CSS/JS change often during active dev — revalidate every load (cheap 304s via ETag),
  // so a deploy is never shadowed by a stale Cloudflare-edge or browser copy. Media gets a
  // short TTL. To bust a currently-stale edge entry, append a throwaway ?v= to the URL: the
  // new cache key forces a fresh origin fetch, and no-cache keeps it fresh thereafter.
  if ($ext === 'css' || $ext === 'js') {
    header('Cache-Control: no-cache');
  } else {
    header('Cache-Control: public, max-age=3600');
  }
  /* Text compresses; a jpg, woff2 or png is already compressed and gzipping it burns CPU to make
     the file very slightly bigger. Fonts especially — woff2 IS brotli — so the list is what
     genuinely benefits and nothing else. Leaflet's 147 KB of JS is the one that matters here. */
  static $squash = ['css' => 1, 'js' => 1, 'mjs' => 1, 'json' => 1, 'xml' => 1, 'svg' => 1,
                    'md' => 1, 'txt' => 1];
  $gz = isset($squash[$ext]) && client_takes_gzip();
  header('Vary: Accept-Encoding');
  $mtime = filemtime($file);
  $etag  = '"' . dechex($mtime) . '-' . dechex(filesize($file)) . ($gz ? '-gz' : '') . '"';
  header('ETag: ' . $etag);
  if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
  send_body((string)file_get_contents($file), $gz);
}
