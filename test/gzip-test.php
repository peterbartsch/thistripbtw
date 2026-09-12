<?php
/**
 * Origin compression — that it happens, that it is negotiated, and that Content-Length is honest.
 *
 * The origin sent the 339 KB app shell uncompressed. Cloudflare compresses to the BROWSER, so
 * nobody was downloading 339 KB and nothing looked wrong — but CF does not cache HTML by default
 * and `no-cache` does not change that, so every trip page view pulled the whole file off the VPS.
 * Measured on the wire after the change: 339,044 -> 135,404 (60% off), and Leaflet's 147 KB ->
 * 51 KB.
 *
 * THREE WAYS THIS BREAKS SILENTLY, which is why it is tested against a real server rather than by
 * reading send_body():
 *
 *   · Content-Length left at the UNCOMPRESSED size. The browser waits for bytes that never come,
 *     or truncates the page. Nothing throws.
 *   · gzip handed to a client that never asked. Renders as binary.
 *   · one ETag shared by both representations, so a cache revalidates the wrong one and serves
 *     compressed bytes to a plain client — the same failure, arriving later and harder to trace.
 *
 * There is also a fourth, already paid for once: `const` is NOT hoisted in PHP, and the two gzip
 * constants originally sat beside send_body() at the bottom of index.php, below all the routing
 * that calls it. Every page 500'd. The constants are at the top now and the assertion that they
 * are reachable is the first one below.
 *
 * Run: php test/gzip-test.php            (starts and stops its own server on port 8079)
 */
declare(strict_types=1);

$pass = 0; $fail = 0;
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else       { $fail++; echo "  ✗ $what\n"; }
}

$root = dirname(__DIR__);

/* Port 8079, deliberately NOT 8080: a preview server on 8080 makes the local suite fail ~40
   assertions against somebody else's process, and CLAUDE.md has the scar. */
$port = 8079;
$php  = PHP_BINARY;
$cmd  = escapeshellarg($php) . ' -S 127.0.0.1:' . $port . ' ' . escapeshellarg($root . '/index.php')
      . ' > /dev/null 2>&1 & echo $!';
$pid  = (int)shell_exec($cmd);
register_shutdown_function(function () use ($pid) { if ($pid > 0) @exec("kill $pid 2>/dev/null"); });

for ($i = 0; $i < 50; $i++) {                    // wait for it to answer, rather than sleeping a guess
    $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
    if ($c) { fclose($c); break; }
    usleep(100000);
}

/** GET a URL, returning [status, headers(lower-keyed), body]. */
function fetch(int $port, string $path, ?string $accept): array {
    $ctx = stream_context_create(['http' => [
        'method'        => 'GET',
        'header'        => $accept === null ? '' : "Accept-Encoding: $accept\r\n",
        'ignore_errors' => true,
        'timeout'       => 10,
    ]]);
    $body = @file_get_contents("http://127.0.0.1:$port$path", false, $ctx);
    $h = []; $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $status = (int)$m[1]; continue; }
        $p = explode(':', $line, 2);
        if (count($p) === 2) $h[strtolower(trim($p[0]))] = trim($p[1]);
    }
    return [$status, $h, (string)$body];
}

/* PHP's stream wrapper sends its own Accept-Encoding and does NOT decode, which is exactly what
   this test wants: the raw bytes, so Content-Length can be checked against what arrived. */
[$st, $h, $body] = fetch($port, '/', 'gzip');

/* ── the constant-hoisting failure, first, because it made every page a 500 ────────────── */
ok('the landing page is a 200, not the exception handler (const hoisting)',
   $st === 200 && strpos($body, 'server error') === false);

/* ── a gzip client gets gzip, and Content-Length is the COMPRESSED length ──────────────── */
ok('a gzip-capable client is served gzip', ($h['content-encoding'] ?? '') === 'gzip');
ok('Content-Length matches the bytes actually sent',
   (int)($h['content-length'] ?? -1) === strlen($body));
ok('the body really is a gzip stream', substr($body, 0, 2) === "\x1f\x8b");
$plainFromGz = @gzdecode($body);
ok('and it decodes', is_string($plainFromGz) && $plainFromGz !== '');

/* ── Vary is present, or a shared cache will hand these bytes to a client that cannot read them ── */
ok('Vary: Accept-Encoding is set', stripos($h['vary'] ?? '', 'accept-encoding') !== false);

/* ── a client that does not ask gets plain bytes, byte-identical to the decoded ones ───── */
[$st2, $h2, $body2] = fetch($port, '/', 'identity');
ok('a client that asks for identity is NOT served gzip', !isset($h2['content-encoding']));
ok('its Content-Length is honest too', (int)($h2['content-length'] ?? -1) === strlen($body2));
ok('compressed and plain are the same document', $plainFromGz === $body2);
ok('compression actually saved something (' . strlen($body) . ' vs ' . strlen($body2) . ' bytes)',
   strlen($body) < strlen($body2) * 0.75);

/* ── the two representations do not share an ETag ─────────────────────────────────────── */
ok('gzip and plain carry different ETags',
   ($h['etag'] ?? 'a') !== ($h2['etag'] ?? 'b'));

/* ── conditional GET still works, per representation ──────────────────────────────────── */
$ctx = stream_context_create(['http' => ['method' => 'GET', 'ignore_errors' => true, 'timeout' => 10,
    'header' => "Accept-Encoding: gzip\r\nIf-None-Match: " . ($h['etag'] ?? '') . "\r\n"]]);
@file_get_contents("http://127.0.0.1:$port/", false, $ctx);
$code = 0;
foreach ($http_response_header ?? [] as $line)
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $code = (int)$m[1]; break; }
ok('presenting the gzip ETag revalidates to 304', $code === 304);

/* ── already-compressed formats are left alone ────────────────────────────────────────── */
[, $hp, ] = fetch($port, '/og.png', 'gzip');
ok('a png is not gzipped — it is already compressed', !isset($hp['content-encoding']));
$woff = glob(dirname(__DIR__) . '/public/fonts/*.woff2');
if ($woff) {
    [, $hw, ] = fetch($port, '/fonts/' . basename($woff[0]), 'gzip');
    ok('a woff2 is not gzipped — woff2 IS brotli', !isset($hw['content-encoding']));
}

/* ── and the big text asset, which is the other half of the win ───────────────────────── */
[, $hj, $bj] = fetch($port, '/vendor/leaflet-1.9.4/leaflet.min.js', 'gzip');
ok('leaflet.min.js is gzipped', ($hj['content-encoding'] ?? '') === 'gzip');
ok('…and its Content-Length is honest', (int)($hj['content-length'] ?? -1) === strlen($bj));

echo "\n" . ($fail ? $fail . " failed, " : "") . $pass . " passed\n";
exit($fail ? 1 : 0);
