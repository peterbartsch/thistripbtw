<?php
/* The From header must survive RFC 5322 parsing. The brand contains a comma, and an unquoted
   display name with a comma parses as TWO addresses — Gmail rejected every message this system
   sent for weeks with 550-5.7.1, while the relay accepted them and send_mail() returned true. */
define('SECURE_ACCESS', true);
/* mail.php pulls in config.php, which defines env() — so no stub here, and no DB is touched
   because nothing below calls anything that connects. */
require_once __DIR__ . '/../lib/mail.php';
$pass=0; $fail=0;
function ok(string $w, bool $c){ global $pass,$fail; if($c){$pass++; echo "  ✓ $w\n";} else {$fail++; echo "  ✗ $w\n";} }

$from = 'info@thistripbtw.us';
$hdr  = 'From: "' . addcslashes(MAIL_FROM_NAME, '"\\') . '" <' . $from . '>';
ok('the brand still contains the comma that caused this', str_contains(MAIL_FROM_NAME, ','));
ok('the display name is quoted', preg_match('/^From: ".*" <[^>]+>$/', $hdr) === 1);

/* Parse it the way a receiving MTA does: split on commas OUTSIDE quotes. One address, or the
   header is malformed however good it looks. */
$parts = preg_split('/,(?=(?:[^"]*"[^"]*")*[^"]*$)/', substr($hdr, 6));
ok('it parses as exactly ONE address, not two', count($parts) === 1);
ok('and that address is the sender', str_contains($parts[0], "<$from>"));

$src = file_get_contents(__DIR__ . '/../lib/mail.php');
ok('no unquoted "From: " . MAIL_FROM_NAME left in the source',
   !preg_match("/'From: '\s*\.\s*MAIL_FROM_NAME/", $src));

/* ── D-074: the receipt must never carry the phrases ───────────────────────────────────────
   They ARE the key and are stored only as SHA-256, so a mailed working link is the secret
   itself, sitting in an inbox forever. This reads the actual send block out of api.php and
   fails if either token variable is ever referenced inside it — which is what a well-meaning
   "let's be helpful and include the link" edit would look like. */
$api = file_get_contents(__DIR__ . '/../api.php');
ok('the purchase receipt exists at all', str_contains($api, "'purchase');"));
$start = strpos($api, '/* D-074: the receipt.');
$end   = strpos($api, "'purchase');", (int)$start);
$blk   = $start !== false && $end !== false ? substr($api, $start, $end - $start) : '';
ok('the D-074 block was located', $blk !== '');
ok('it never references $editToken', !str_contains($blk, '$editToken'));
ok('it never references $viewToken', !str_contains($blk, '$viewToken'));
ok('it carries no reset token either (a standing key in an inbox)',
   !str_contains($blk, 'acct_reset_start') && !str_contains($blk, '/reset?t='));
ok('it does send the trip address, which opens nothing on its own',
   str_contains($blk, 'APEX . \'/\' . $slug'));
ok('it is wrapped, so a failed mail cannot fail a paid claim',
   str_contains($blk, 'try {') || str_contains(substr($api, (int)$start - 200, 220), 'try {'));

/* ── the export button 404'd because a hand-built URL omitted /api/ ────────────────────────
   Every other call goes through api(), which appends it. Anything that builds a URL against
   API_BASE by hand must include it, and nothing in review makes that omission visible. */
$app = file_get_contents(__DIR__ . '/../public/app.html');
preg_match_all('#\$\{API_BASE\}([^`\'"]*)#', $app, $mm);
$bad = array_values(array_filter($mm[1], fn($u) => !str_starts_with($u, '/api/')));
ok('every hand-built API_BASE url includes /api/ (' . count($mm[1]) . ' found)', $bad === []);
if ($bad) foreach ($bad as $b) echo "      offending: \${API_BASE}$b\n";

/* ── X3: the CSV export must not hand a formula to Excel ───────────────────────────────────
   Quoting is correct CSV and still unsafe: a cell starting = + - @ is executed as a formula by
   Excel, LibreOffice and Sheets. The export exists so a trip can be expensed, so the likely
   reader is an employer or an accountant — outside the trip entirely. */
$appjs = file_get_contents(__DIR__ . '/../public/app.html');
ok('csvCell neutralises a leading = + - @ (X3)',
   str_contains($appjs, '/^[=+\\-@\\t\\r]/.test(t)'));
ok('and it still doubles embedded quotes', str_contains($appjs, 'replace(/"/g, \'""\')'));

/* ── D-109: the attachment MIME, checked by parsing it ──────────────────────────────────
   A subtly wrong multipart arrives as an unreadable base64 dump and send_mail() still returns
   true — which is precisely how the unquoted comma in the From header hid for weeks. So this
   builds a message and reads it back rather than trusting the string concatenation. */
$zipBytes = "PK\x03\x04" . random_bytes(64);          // enough to be binary and non-empty
$base = ['From: "this trip, btw" <info@x.test>', 'MIME-Version: 1.0',
         'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];
[$h, $body] = mail_multipart($base, "Your trip ends on 1 August.\n", $zipBytes,
                             'Weekend at Tahoe.zip', 'application/zip');

$ct = implode("\n", $h);
ok('the top-level type becomes multipart/mixed', str_contains($ct, 'multipart/mixed; boundary="'));
ok('and the plain-text headers are REMOVED from the top level, not left beside it',
   !preg_match('/^Content-Type: text\/plain/m', $ct) &&
   !preg_match('/^Content-Transfer-Encoding:/m', $ct));

preg_match('/boundary="([^"]+)"/', $ct, $bm);
$boundary = $bm[1] ?? '';
ok('the boundary is present and non-trivial', strlen($boundary) > 12);
ok('the boundary never occurs inside the payload it delimits',
   substr_count($body, $boundary) === 3);   // open, separator, close

$parts = array_values(array_filter(explode("--$boundary", $body), fn($x) => trim($x, "-\n ") !== ''));
ok('there are exactly two parts', count($parts) === 2);
ok('the TEXT is first, so a client that cannot open the zip still shows the message',
   str_contains($parts[0], 'Your trip ends on 1 August'));
ok('the text part declares its own charset', str_contains($parts[0], 'text/plain; charset=UTF-8'));
ok('the attachment is base64 and named',
   str_contains($parts[1], 'Content-Transfer-Encoding: base64') &&
   str_contains($parts[1], 'filename="Weekend-at-Tahoe.zip"'));
/* Extract the VALUE and inspect it — the first version of this asserted
   `filename="[^"]*[\s"]` finds nothing, which can never pass, because `[\s"]` matches the
   closing quote. It was testing the delimiter, not the name. */
preg_match('/filename="([^"]*)"/', $parts[1], $fm);
ok('the filename is sanitised — a space or quote in a trip name cannot break the header',
   isset($fm[1]) && $fm[1] !== '' && !preg_match('/[\s"\\\\;]/', $fm[1]));
[$h2, $b2] = mail_multipart($base, "x\n", 'zz', 'Sam"s "trip"; rm -rf /.zip', 'application/zip');
preg_match('/filename="([^"]*)"/', $b2, $fm2);
ok('a hostile trip name cannot escape the header either',
   isset($fm2[1]) && !preg_match('/[\s"\\\\;]/', $fm2[1]));
ok('the body ends with the closing delimiter', str_ends_with(trim($body), "--$boundary--"));

/* The bytes must survive the round trip, or the zip a customer keeps is corrupt. */
preg_match('/\n\n(.*)$/s', $parts[1], $pm);
$decoded = base64_decode(preg_replace('/--$/', '', trim($pm[1] ?? '')), true);
ok('the attachment decodes back to exactly the bytes we put in', $decoded === $zipBytes);

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
