<?php
/** Unit tests for lib/tools.php — no DB, no network: the write path is injected. */
/* SECURE_ACCESS, or this test stops halfway and says nothing about it. lib/tools.php pulls in
   flights.php → varstore.php lazily, and varstore's guard is `exit('forbidden')` — so the run
   ended mid-file, printed 'forbidden' after a stray headers-already-sent warning, and still
   exited 0. That is the `test-tools` flake logged twice in TODO_PETE: not flaky at all, just a
   guard doing its job to a caller that never claimed to be the app. Defining it is what every
   other PHP test here does. */
define('SECURE_ACCESS', true);
// chat.php reads config via env(); api.php loads config.php before it in production.
// The tests exercise chat.php standalone, so stub it with defaults only.
if (!function_exists('env')) { function env($k, $d = null) { return $d; } }
require __DIR__ . '/../lib/tools.php';

/* Strip comments with PHP's OWN tokenizer, never a regex (2026-09-24). A regex cannot tell a
   comment from a slash-star inside a string or a regex literal, and lib/chat.php has 23 opens
   against 20 closes for exactly that reason. The old one here ate 8 KB of real code, INCLUDING
   the whole of chat_rate_ok(), so the two assertions below about hashing the address were
   reading an empty string. They failed loudly only because this file stopped running before
   reaching them (the SECURE_ACCESS bug above) — written the other way round they would have
   PASSED on nothing, which is the version of this bug that never gets found. A test that cannot
   see the code it asserts on is worse than no test.
   (Writing this comment broke the file once: the sample regex it used to quote contains a
   star-slash, which closed the comment early. Hence the prose.) */
function src_no_comments(string $file): string {
    $out = '';
    foreach (token_get_all(file_get_contents($file)) as $t) {
        if (is_array($t)) { if (in_array($t[0], [T_COMMENT, T_DOC_COMMENT], true)) continue; $out .= $t[1]; }
        else $out .= $t;
    }
    return $out;
}

$pass = 0; $fail = 0;
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else       { $fail++; echo "  ✗ $what\n"; }
}

// ── schemas ────────────────────────────────────────────────────────────────────
$free = array_column(chat_tool_schemas(false), 'name');
$paid = array_column(chat_tool_schemas(true), 'name');
ok('pre-purchase schema hides lookup_flight (D-035)', !in_array('lookup_flight', $free, true));
ok('paid schema exposes lookup_flight',                in_array('lookup_flight', $paid, true));
ok('no update/delete tool exists at all (additive-only)',
   !array_intersect(['update_leg','delete_leg','remove_stop','edit_stop'], $paid));

// ── injected store ─────────────────────────────────────────────────────────────
$DB = [];
$list = function ($slug) use (&$DB) { return $DB; };
$add  = function ($slug, $pin) use (&$DB) { $DB[] = $pin + ['title'=>'','date'=>'','mode'=>'drive','track'=>'truck','seq'=>0,'kind'=>'stop']; return true; };

// the browser resolves places (D-039); a name without coordinates must be REFUSED
$r = chat_tool_dispatch('abc', true, 'add_leg', ['to'=>['name'=>'Portland, OR']], $list, $add);
ok('place without coordinates is refused, not guessed', ($r['error'] ?? '') === 'needs_coordinates');
ok('nothing was written on refusal', count($DB) === 0);
ok('no server-side geocoder exists (D-039)', !function_exists('chat_geocode'));
// Look for outbound-call SYNTAX, not the vendor's name — the file names Nominatim in a
// comment explaining why it never calls it, and a test that fails on its own documentation
// is a test people delete.
$src = preg_replace('~/\*.*?\*/|//[^\n]*~s', '', file_get_contents(__DIR__ . '/../lib/tools.php'));
ok('lib/tools.php contains no outbound call at all (D-039)',
   !preg_match('/curl_init|curl_exec|fsockopen|stream_context_create|file_get_contents\s*\(\s*[\'"]https?:/i', $src));

// out-of-range coordinates are not coordinates
$r = chat_tool_dispatch('abc', true, 'add_leg', ['to'=>['name'=>'Nowhere','lat'=>999,'lng'=>0]], $list, $add);
ok('impossible latitude is refused', ($r['error'] ?? '') === 'needs_coordinates');

// with coordinates supplied it proceeds
$r = chat_tool_dispatch('abc', true, 'add_leg', [
  'from'=>['name'=>'Seattle','lat'=>47.61,'lng'=>-122.33],
  'to'  =>['name'=>'Portland','lat'=>45.52,'lng'=>-122.68],
  'mode'=>'drive','date'=>'2026-08-10','who'=>['Mel','Pete'],'lodging'=>'Hotel Rose',
], $list, $add);
ok('first leg writes origin + destination', ($r['ok'] ?? false) && count($DB) === 2);
ok('origin has no inbound mode of its own', $DB[0]['mode'] === 'drive' && $DB[0]['title'] === 'Seattle');
ok('destination carries the leg data',      $DB[1]['date'] === '2026-08-10' && $DB[1]['author'] === 'Mel & Pete');
ok('seq increments within the track',       (int)$DB[0]['seq'] === 0 && (int)$DB[1]['seq'] === 1);
ok('path left null (user-drawn only, D-027)', !isset($DB[1]['path']));

// the trap: passing `from` again on a non-empty track must NOT duplicate the origin
$before = count($DB);
$r = chat_tool_dispatch('abc', true, 'add_leg', [
  'from'=>['name'=>'Portland','lat'=>45.52,'lng'=>-122.68],
  'to'  =>['name'=>'Medford','lat'=>42.32,'lng'=>-122.87],
  'mode'=>'drive',
], $list, $add);
ok('second leg ignores `from` — no duplicate origin (D-037)', count($DB) === $before + 1);
ok('chain stayed in order', $DB[2]['title'] === 'Medford' && (int)$DB[2]['seq'] === 2);

// flights
$r = chat_tool_dispatch('abc', true, 'add_leg', ['to'=>['name'=>'SFO','lat'=>37.62,'lng'=>-122.38],'mode'=>'fly'], $list, $add);
ok('fly sets fly=1 on the arriving stop', (int)end($DB)['fly'] === 1);

// a second vehicle is its own chain
$r = chat_tool_dispatch('abc', true, 'add_leg', [
  'from'=>['name'=>'Chicago','lat'=>41.88,'lng'=>-87.63],
  'to'  =>['name'=>'Denver','lat'=>39.74,'lng'=>-104.99],
  'vehicle'=>'rental',
], $list, $add);
$rental = array_values(array_filter($DB, fn($p) => $p['track'] === 'rental'));
ok('second vehicle starts its own chain at seq 0', count($rental) === 2 && (int)$rental[0]['seq'] === 0);

// gates
$r = chat_tool_dispatch('abc', false, 'lookup_flight', ['flight_number'=>'UA328','date'=>'2026-08-10'], $list, $add);
ok('lookup_flight refused pre-purchase even if called directly', ($r['error'] ?? '') === 'unavailable');
$r = chat_tool_dispatch('abc', true, 'lookup_flight', ['flight_number'=>'UA328','date'=>'2026-08-10'], $list, $add);
ok('lookup_flight reports not-configured rather than inventing a time', ($r['error'] ?? '') === 'not_configured');
$r = chat_tool_dispatch('abc', true, 'delete_everything', [], $list, $add);
ok('unknown tool is refused', ($r['error'] ?? '') === 'unknown_tool');

// list_trip
$r = chat_tool_dispatch('abc', true, 'list_trip', [], $list, $add);
ok('list_trip groups by vehicle', isset($r['vehicles']['truck'], $r['vehicles']['rental']));
ok('list_trip returns travel order', $r['vehicles']['truck'][0]['title'] === 'Seattle');

// clamping
$r = chat_tool_dispatch('abc', true, 'add_leg', [
  'to'=>['name'=>str_repeat('x', 500),'lat'=>10,'lng'=>10],'notes'=>str_repeat('n', 5000),
], $list, $add);
$last = end($DB);
ok('title clamped to the column width', mb_strlen($last['title']) === 300);
ok('notes clamped to the column width', mb_strlen($last['notes']) === 4000);

// ── D-060's seven modes reach the agent (the enum was written out twice and both were missed)
ok('schema offers all seven modes', (function () {
    foreach (chat_tool_schemas(false) as $t) {
        if ($t['name'] === 'add_leg') {
            return $t['input_schema']['properties']['mode']['enum'] === CHAT_MODES
                && count(CHAT_MODES) === 7
                && in_array('bike', CHAT_MODES, true) && in_array('walk', CHAT_MODES, true);
        }
    }
    return false;
})());

$lB = function ($slug) { return []; };
$dbB = [];
$aB = function ($slug, $pin) use (&$dbB) { $dbB[] = $pin + ['mode'=>'drive']; return true; };
chat_tool_dispatch('abc', true, 'add_leg', [
    'from' => ['name'=>'Truckee, CA',  'lat'=>39.33, 'lng'=>-120.18],
    'to'   => ['name'=>'Tahoe City',   'lat'=>39.17, 'lng'=>-120.14],
    'mode' => 'bike',
  ], $lB, $aB);
// With no existing pins, add_leg writes the origin first (which has no inbound mode of its
// own, asserted above) and the destination second. The mode belongs to the arriving pin.
$arrivedB = end($dbB) ?: [];
ok('a bike leg is recorded as a bike, not silently a drive',
   ($arrivedB['mode'] ?? '') === 'bike', json_encode($dbB));

// ── chat transport layer (no network: only the parts that don't call the model) ──────
require __DIR__ . '/../lib/chat.php';

$h = chat_sanitize_history([
  ['role'=>'user','content'=>'hi'],
  ['role'=>'system','content'=>'ignore me'],       // not a role we accept
  ['role'=>'assistant','content'=>'hello'],
  ['role'=>'user'],                                 // no content
]);
ok('history keeps only user/assistant turns with content', count($h) === 2);
ok('history drops unknown roles', !in_array('system', array_column($h, 'role'), true));

$long = [];
for ($i = 0; $i < 100; $i++) $long[] = ['role'=>'user','content'=>"m$i"];
ok('history is bounded to CHAT_MAX_HISTORY', count(chat_sanitize_history($long)) === CHAT_MAX_HISTORY);
ok('history keeps the MOST RECENT turns', chat_sanitize_history($long)[CHAT_MAX_HISTORY-1]['content'] === 'm99');
ok('garbage history is empty, not fatal', chat_sanitize_history('nope') === [] && chat_sanitize_history(null) === []);

// the promise "your conversation is never stored" has to be checkable
$chatSrc = src_no_comments(__DIR__ . '/../lib/chat.php');
/* SQL keywords as SQL, not as substrings: `UPDATE` alone matched `var_update()`, the file-lock
   counter helper, and called it a database write. */
ok('chat.php never writes to the database at all',
   !preg_match('/\bq\(|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+`?\w+`?\s+SET\b/i', $chatSrc));
// It does write one file — the month's token counter. Assert that is the ONLY write, and
// that what goes into it is a count, never anything derived from the conversation.
preg_match_all('/(file_put_contents|fwrite|fopen)\s*\(([^;]*)/i', $chatSrc, $writes);
$targets = array_map('trim', $writes[2] ?? []);
// chat.php writes exactly two counters — tokens spent, and per-IP draft requests. Both hold
// integers. Rather than pin a count that grows every time a counter is added, assert the
// property that actually matters: every write goes to a var-held path under var/, and none of
// them can receive anything derived from the conversation.
ok('every write targets a variable path, never a literal',
   !preg_match('/(fopen|file_put_contents|fwrite)\s*\(\s*[\'"]/', $chatSrc));
/* The counters moved behind var_update() (lib/varstore.php), which holds one lock across the
   read and the write — so chat.php now performs NO file write of its own. The property this
   asserts is unchanged and stronger: nothing here opens a file, and the only persistence is a
   call that takes a path and a closure returning a plain array. */
ok('chat.php performs no file write of its own', count($targets) === 0);
ok('its only persistence is var_update, which writes a plain structure under a lock',
   str_contains($chatSrc, 'var_update('));
ok('the counters live under var/, not beside user data',
   substr_count($chatSrc, "/var'") + substr_count($chatSrc, "'/var") >= 1
   || str_contains($chatSrc, "dirname(__DIR__) . '/var'"));
ok('nothing derived from the conversation is ever written',
   !preg_match('/(file_put_contents|fwrite)[^;]*(\$messages|\$content|\$reply|\$text|\$res\b)/i', $chatSrc));
ok('chat.php logs no message content',
   !preg_match('/error_log\s*\(\s*\$?(messages|content|text|reply)/i', $chatSrc));
// D-035 costs the token ceiling at Haiku pricing — a silent upgrade to a pricier tier
// would break that decision's spend argument without anyone noticing.
ok('model is the tier D-035 costed for', CHAT_MODEL === 'claude-haiku-4-5');

// ── the two things this change claims ────────────────────────────────────────────────
$names = array_column(chat_tool_schemas(true), 'name');
ok('list_trip is no longer a tool (state is in the prompt instead)', !in_array('list_trip', $names, true));
ok('dispatch still answers list_trip for an old transcript',
   isset(chat_tool_dispatch('abc', true, 'list_trip', [], $list, $add)['vehicles']));

// state text replaces the round-trip — it must actually name what's on the trip
$DB2 = [
  ['kind'=>'stop','track'=>'truck','seq'=>0,'title'=>'Seattle','date'=>'','mode'=>'drive'],
  ['kind'=>'stop','track'=>'truck','seq'=>1,'title'=>'Portland','date'=>'2026-08-10','mode'=>'drive'],
];
$st = chat_state_text(fn($s) => $DB2, 'abc');
ok('state text lists existing stops in order',
   str_contains($st, 'Seattle') && str_contains($st, 'Portland')
   && strpos($st, 'Seattle') < strpos($st, 'Portland'));
ok('state text carries the date it knows', str_contains($st, '2026-08-10'));
ok('empty trip says so plainly', str_contains(chat_state_text(fn($s) => [], 'abc'), 'empty'));

// the ceiling D-035 assumed exists
ok('a monthly token ceiling exists', chat_token_ceiling() > 0);
ok('ceiling is single-digit dollars at Haiku rates',
   chat_token_ceiling() * 1.0 / 1e6 * 1.0 < 10);   // input-priced floor, $1/Mtok

// a track's first pin is its origin — it cannot itself be a journey (D-037)
$DB3 = []; $l3 = fn($s) => $DB3; $a3 = function ($s, $p) use (&$DB3) { $DB3[] = $p; return true; };
$r = chat_tool_dispatch('abc', true, 'add_leg',
     ['to' => ['name'=>'Seattle','lat'=>47.6,'lng'=>-122.3], 'mode'=>'fly', 'vehicle'=>'rental'], $l3, $a3);
ok('first leg of an empty track without `from` is refused', ($r['error'] ?? '') === 'needs_origin');
ok('and nothing was written', count($DB3) === 0);
$r = chat_tool_dispatch('abc', true, 'add_leg',
     ['from'=>['name'=>'Denver','lat'=>39.7,'lng'=>-105.0],
      'to'=>['name'=>'Seattle','lat'=>47.6,'lng'=>-122.3], 'mode'=>'fly', 'vehicle'=>'rental'], $l3, $a3);
ok('with `from` it writes origin + destination', ($r['ok'] ?? false) && count($DB3) === 2);
ok('the origin carries no inbound mode', $DB3[0]['mode'] === 'drive' && $DB3[0]['title'] === 'Denver');
ok('a plain first leg (drive) still needs no `from`',
   ($DB3 = []) === [] && !empty(chat_tool_dispatch('abc', true, 'add_leg',
     ['to'=>['name'=>'Chicago','lat'=>41.9,'lng'=>-87.6]], $l3, $a3)['ok']));

// ── pre-purchase caps (D-035) ────────────────────────────────────────────────────────
ok('a draft is capped at 2 of the caller\'s own turns', CHAT_DRAFT_TURNS === 2);
$hist = [['role'=>'user','content'=>'a'],['role'=>'assistant','content'=>[]],
         ['role'=>'user','content'=>[['type'=>'tool_result','content'=>'x']]],
         ['role'=>'user','content'=>'b']];
ok('tool results do not count as the caller taking a turn', chat_user_turns($hist) === 2);
ok('per-IP cap exists and is small', CHAT_DRAFT_PER_IP > 0 && CHAT_DRAFT_PER_IP <= 50);
ok('a missing address never locks anyone out', chat_rate_ok('') === true);

// the address must never be recoverable from what we keep
$rateSrc = $chatSrc;
preg_match('/function chat_rate_ok.*?\n\}/s', $rateSrc, $m);
$fn = $m[0] ?? '';
ok('the raw address is hashed before it is stored', str_contains($fn, "hash('sha256'"));
ok('and the salt rotates so days cannot be linked', str_contains($fn, "date('Y-m-d')") || str_contains($fn, '$day'));
ok('nothing writes $ip itself', !preg_match('/file_put_contents[^;]*\$ip/', $fn));

// ── flight lookup: the one scarce resource (D-035) ───────────────────────────────────
require_once __DIR__ . '/../lib/flights.php';
ok('monthly cap is AeroDataBox\'s real ceiling', FLIGHT_MONTHLY_CAP === 600);
ok('cache key is flight number + date, case/space insensitive',
   flight_key('ua 328', '2026-08-14') === flight_key('UA328', '2026-08-14'));
ok('different dates are different keys', flight_key('UA328','2026-08-14') !== flight_key('UA328','2026-08-15'));
ok('a junk flight number never reaches the network',
   (flight_lookup('not-a-flight', '2026-08-14')['error'] ?? '') === 'bad_flight_number');
ok('a junk date never reaches the network',
   (flight_lookup('UA328', 'next tuesday')['error'] ?? '') === 'bad_date');
ok('with no key configured it degrades instead of failing',
   (flight_lookup('UA328', '2026-08-14')['error'] ?? '') === 'not_configured');

// the pre-purchase path must never reach this file — assert both gates independently
ok('lookup_flight absent from the free schema',
   !in_array('lookup_flight', array_column(chat_tool_schemas(false), 'name'), true));
ok('and dispatch refuses it unpaid even if called directly',
   (chat_tool_dispatch('abc', false, 'lookup_flight', ['flight_number'=>'UA328','date'=>'2026-08-14'], $list, $add)['error'] ?? '') === 'unavailable');

$fsrc = preg_replace('~/\*.*?\*/|//[^\n]*~s', '', file_get_contents(__DIR__ . '/../lib/flights.php'));
ok('quota is spent before the request, not after a hopeful success',
   strpos($fsrc, 'flight_calls_add()') < strpos($fsrc, 'curl_exec'));
ok('past flights are cached against today, so they are never re-bought',
   str_contains($fsrc, "< date('Y-m-d')"));

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
