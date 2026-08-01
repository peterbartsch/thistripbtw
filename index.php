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

/* static content pages: /privacy, /about, /mission, /help, /what-you-get, /account */
if (count($segs) === 1 && in_array($slug, ['privacy','about','mission','help','terms','faq','what-you-get','account','for-agents','reset','starts'], true)
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

/* /.well-known/mcp.json — discovery. `.htaccess` blocks every dotted path EXCEPT
   `.well-known/`, so this is reachable, but it lives under public/ and the single-segment
   asset rule above is single-segment only, so without this it falls through to the 404. */
if (count($segs) === 2 && $segs[0] === '.well-known' && $segs[1] === 'mcp.json'
    && is_file(PUBLIC_DIR . '/.well-known/mcp.json')) {
  serve_asset(PUBLIC_DIR . '/.well-known/mcp.json'); exit;
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

/* /quick → the ring builder, and the promoted way to START a trip (D-063). /new is where a
   trip is EDITED, by leg card, and holds the chat and the road routing. /quicktree is the
   previous node builder, kept routed as the fallback. All three write the same v3 draft. */
if (count($segs) === 1 && $slug === 'radial') {          // /radial moved; keep old links alive
  header('Location: /quick', true, 301); exit;
}
if (count($segs) === 1 && in_array($slug, ['new', 'quick', 'quicktree'], true)
    && is_file(PUBLIC_DIR . '/' . $slug . '.html')) { serve_html(PUBLIC_DIR . '/' . $slug . '.html'); exit; }

/* a reserved word as the first segment is never a trip → landing */
if (in_array($slug, RESERVED, true)) { serve_html(PUBLIC_DIR . '/index.html'); exit; }

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
  serve_html(PUBLIC_DIR . '/app.html');
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
  header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; "
    . "style-src 'self' 'unsafe-inline'; font-src 'self'; "
    . "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  $file = PUBLIC_DIR . '/404.html';
  if (is_file($file)) { readfile($file); return; }
  echo 'not found';
}

/* $strip names a block id to remove before sending, or null to send the file as it is. */
function serve_html($file, $strip = null) {
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
  // CSP. app.html needs its external origins (Leaflet, Carto tiles, OSRM, Nominatim, Spotify);
  // landing + content pages are locked down tight.
  /* 2026-07-30: Leaflet and the fonts are served from here now, so cdnjs, fonts.googleapis and
     fonts.gstatic came out of BOTH lists — which is the trap CLAUDE.md names: there are two, and
     missing the map one means the map silently never loads. `font-src` needed the opposite edit:
     it allowed gstatic and never 'self', so self-hosted faces would have been blocked outright. */
  if (in_array(basename($file), ['app.html', 'new.html', 'quick.html', 'quicktree.html'], true)) {
    header("Content-Security-Policy: default-src 'self'; "
      . "script-src 'self' 'unsafe-inline'; "
      . "style-src 'self' 'unsafe-inline'; "
      . "font-src 'self'; "
      . "img-src 'self' data: https://*.basemaps.cartocdn.com; "
      . "connect-src 'self'; "
      . "media-src 'self'; frame-src https://open.spotify.com; frame-ancestors 'none'; base-uri 'none'");
  } else {
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; "
      . "style-src 'self' 'unsafe-inline'; font-src 'self'; "
      . "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  // conditional GET: revalidate cheaply (304) instead of re-downloading the whole shell
  $mtime = filemtime($file);
  // The stripped and unstripped shapes are different documents and must not share an ETag.
  $etag  = '"' . dechex($mtime) . '-' . dechex(filesize($file)) . ($strip ? '-s' : '') . '"';
  header('ETag: ' . $etag);
  header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
  $inm = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
  $ims = $_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '';
  if ($inm === $etag || ($ims && @strtotime($ims) >= $mtime)) { http_response_code(304); exit; }
  if ($strip === null) { readfile($file); return; }

  /* Remove <div id="{$strip}"> ... its matching close. Counted, not regexed: the block contains
     nested divs and a lazy match would cut it short, leaving stray markup that renders. If the
     shape is ever not what we expect, send the page whole rather than send it broken. */
  $html = (string)file_get_contents($file);
  $open = strpos($html, '<div id="' . $strip . '"');
  if ($open === false) { echo $html; return; }
  $i = strpos($html, '>', $open);
  if ($i === false) { echo $html; return; }
  $depth = 1; $p = $i + 1; $len = strlen($html);
  while ($p < $len && $depth > 0) {
    $nextOpen  = strpos($html, '<div', $p);
    $nextClose = strpos($html, '</div>', $p);
    if ($nextClose === false) { echo $html; return; }          // malformed — send it whole
    if ($nextOpen !== false && $nextOpen < $nextClose) { $depth++; $p = $nextOpen + 4; }
    else { $depth--; $p = $nextClose + 6; }
  }
  echo substr($html, 0, $open) . substr($html, $p);
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
    'js'=>'text/javascript','mjs'=>'text/javascript','md'=>'text/markdown; charset=utf-8','txt'=>'text/plain','woff'=>'font/woff','woff2'=>'font/woff2',
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
  $mtime = filemtime($file);
  $etag  = '"' . dechex($mtime) . '-' . dechex(filesize($file)) . '"';
  header('ETag: ' . $etag);
  if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
  header('Content-Length: ' . filesize($file));
  readfile($file);
}
