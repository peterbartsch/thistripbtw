<?php
/* this trip, btw — remote MCP endpoint (D-081), Streamable HTTP transport.
 *
 * WHY THIS EXISTS. `mcp/thistripbtw-mcp.mjs` is the same tool over stdio, and it works, but it
 * asks the reader to have Node, fetch a file and wire a local path. Claude and ChatGPT
 * connectors take a URL. A URL is a click where a local Node path is a project, so this is the
 * version most people can actually use.
 *
 * WHAT IT DOES NOT DO, and this is the whole reason it is cheap: the tool base64url-encodes
 * JSON into a `#d=` fragment. There is no auth, no session, no per-user state, no database and
 * no meaningful compute. A fragment is never transmitted by a browser, so the trip does not
 * reach this server even when someone opens the link — the privacy claim on /for-agents stays
 * literally true for the remote path too, which it would not if we minted trips here.
 *
 * ── THE DRIFT PROBLEM, AND HOW IT IS HELD ────────────────────────────────────────────────────
 * There are now TWO implementations of one contract. Two implementations of anything drift, and
 * a drift here is silent: both return a plausible link and they differ, so the same itinerary
 * hands over differently depending on which the caller used.
 *
 * Two things hold them together, and neither is a comment:
 *   1. The tool schema is NOT written twice. `mcp/tool-schema.json` is generated from the .mjs
 *      by asking the real server for tools/list, and this file only reads it.
 *   2. `test/mcp-parity.php` feeds identical input to both and demands byte-identical URLs.
 *      That test is the contract. If it fails, this file is wrong and the .mjs is right.
 *
 * Key ORDER is load-bearing for that: the base64 is of JSON.stringify output, so `{o,l,n}` and
 * legs as `{to,mode,date,note,who,subtype,craft,flight,stay}` must be built in exactly that
 * sequence. PHP preserves insertion order, so the arrays below are written in the .mjs's order
 * rather than a tidier one. JSON_UNESCAPED_SLASHES and JSON_UNESCAPED_UNICODE are required for
 * the same reason: JSON.stringify escapes neither and PHP escapes both by default.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

/* read_kept_trip (D-172) reads the database directly rather than calling our own API over
   loopback, and it shares ONE implementation of the phrase check and the sealing rule with
   api.php — see lib/trip.php's header for why that mattered more than convenience. */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/trip.php';

const MCP_MODES = ['drive','fly','train','ferry','water','bike','walk'];
const MCP_SUBTYPES = ['own','rental','rideshare','taxi','bus','rv','commercial','private','heli',
                      'intercity','commuter','subway','tram','passenger','carferry','sail','motor',
                      'canoe','kayak','walk','hike','run','ebike'];
const MCP_CRAFT     = ['Bike','Canoe','Kayak'];
const MCP_MAX_LEGS  = 40;
const MCP_NAME_MAX  = 120;
const MCP_TRIP_MAX  = 60;
const MCP_NOTE_MAX  = 400;
const MCP_PROTOCOL  = '2025-06-18';

/** Mirrors the .mjs `clamp`: stringify, then cut to n. */
function mcp_clamp($v, int $n): string {
    return mb_substr($v === null ? '' : (string)$v, 0, $n, 'UTF-8');
}

/** Mirrors `point()`. Throws with the same refusal to guess coordinates (D-039). */
function mcp_point($o, string $where): array {
    if (!is_array($o)) throw new RuntimeException("$where is missing");
    $lat = isset($o['lat']) && is_numeric($o['lat']) ? (float)$o['lat'] : NAN;
    $lng = isset($o['lng']) && is_numeric($o['lng']) ? (float)$o['lng'] : NAN;
    if (!is_finite($lat) || !is_finite($lng))
        throw new RuntimeException("$where needs numeric lat and lng — resolve the place name to coordinates first, this tool will not guess");
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180)
        throw new RuntimeException("$where has coordinates outside the world: lat $lat, lng $lng");
    return ['name' => mcp_clamp(($o['name'] ?? '') !== '' ? $o['name'] : 'Stop', MCP_NAME_MAX),
            'lat' => $lat, 'lng' => $lng];
}

/** Mirrors `buildLink()`. Returns ['url' => ..., 'legs' => n]. */
/* Mirrors legsOf() in the .mjs: legs sent as a STRING are read as JSON, and legs that are present
   but not a list get told so — instead of falling through to "needs at least one leg", which
   sent a model off to re-plan a trip that was fine (its own report, 2026-09-10). */
function mcp_legs_of(array $input): array {
    $legs = $input['legs'] ?? null;
    if (is_string($legs)) {
        $d = json_decode($legs, true);
        if (json_last_error() !== JSON_ERROR_NONE)
            throw new RuntimeException('legs arrived as text that is not valid JSON (' . json_last_error_msg() . ') — this usually means a quote is unbalanced or the array was encoded twice. Send legs as a JSON array, not a string');
        $legs = $d;
    }
    if ($legs === null) return [];
    if (!is_array($legs) || ($legs !== [] && array_keys($legs) !== range(0, count($legs) - 1)))
        throw new RuntimeException('legs must be an array — got ' . gettype($legs) . '. Each leg is an object with a "to" place');
    foreach ($legs as $i => $l)
        if (!is_array($l) || ($l !== [] && array_keys($l) === range(0, count($l) - 1)))
            throw new RuntimeException('leg ' . ($i + 1) . ' is ' . ($l === null ? 'null' : (is_array($l) ? 'an array' : 'a ' . gettype($l))) . ', not an object with a "to" place');
    return $legs;
}
function mcp_build_link(array $input): array {
    $origin = mcp_point($input['origin'] ?? null, 'origin');
    $legsIn = mcp_legs_of($input);
    if (!$legsIn) throw new RuntimeException('a trip needs at least one leg — where are they going?');
    if (count($legsIn) > MCP_MAX_LEGS)
        throw new RuntimeException(count($legsIn) . ' legs is more than the ' . MCP_MAX_LEGS . ' a link can carry');

    $legs = [];
    foreach ($legsIn as $i => $l) {
        if (!is_array($l)) $l = [];
        $leg = ['to' => mcp_point($l['to'] ?? null, 'leg ' . ($i + 1) . ' destination')];
        // An unrecognised mode becomes drive rather than failing — a trip that arrives is worth
        // more than a tool call that errors over one word.
        $leg['mode'] = in_array($l['mode'] ?? null, MCP_MODES, true) ? $l['mode'] : 'drive';
        if (!empty($l['date'])) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$l['date']))
                throw new RuntimeException('leg ' . ($i + 1) . ' date should be YYYY-MM-DD, got "' . $l['date'] . '"');
            $leg['date'] = (string)$l['date'];
        }
        if (!empty($l['note'])) $leg['note'] = mcp_clamp($l['note'], MCP_NOTE_MAX);
        if (isset($l['who']) && is_array($l['who']) && $l['who']) {
            $who = [];
            foreach (array_slice(array_values($l['who']), 0, 8) as $w) {
                $c = mcp_clamp($w, 40);
                if ($c !== '') $who[] = $c;
            }
            $leg['who'] = $who;
        }
        if (in_array($l['subtype'] ?? null, MCP_SUBTYPES, true)) $leg['subtype'] = $l['subtype'];
        if (in_array($l['craft'] ?? null, MCP_CRAFT, true))      $leg['craft']   = $l['craft'];
        if (!empty($l['flight']) && preg_match('/^[A-Za-z0-9 ]{2,10}$/', (string)$l['flight']))
            $leg['flight'] = mb_strtoupper((string)$l['flight'], 'UTF-8');
        if (!empty($l['lodging']))
            $leg['stay'] = ['lodging' => mcp_clamp($l['lodging'], 120),
                            'note'    => mcp_clamp($l['stayNote'] ?? '', MCP_NOTE_MAX)];
        $legs[] = $leg;
    }

    $payload = ['o' => $origin, 'l' => $legs];
    if (!empty($input['name'])) $payload['n'] = mcp_clamp($input['name'], MCP_TRIP_MAX);

    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $b64  = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
    return ['url' => 'https://' . APEX . '/new#d=' . $b64, 'legs' => count($legs)];
}

/** The ceiling nobody here can enforce — see longLinkNote() in the .mjs for the full reasoning.
 *  The short of it: the whole trip rides in the fragment, a twelve-leg trip is about 3,000
 *  characters, and many chat clients cut a pasted URL near 2,000. `/new` has refused over its
 *  own decoder limit since it shipped; this server had no ceiling at all, so it handed back
 *  links that break in the channel they exist to travel through.
 *
 *  A NOTE, not an error: the link is valid and most trips are nowhere near it. The point is
 *  that the failure lands on the RECIPIENT, who gets a truncated fragment and no route back to
 *  whoever built it, so the builder has to hear it while they can still act.
 *
 *  This text is byte-identical to longLinkNote() in mcp/thistripbtw-mcp.mjs (D-081), and
 *  test/mcp-parity.php asserts that against both real servers — including that a trip under the
 *  ceiling gets no note at all. Change one side and the suite fails; change both.
 */
const MCP_LINK_SOFT_MAX = 2000;
function mcp_long_link_note(string $url): string {
    if (strlen($url) <= MCP_LINK_SOFT_MAX) return '';
    return "\n\nHeads-up: this link is " . number_format(strlen($url)) . " characters, and many "
         . "chat apps cut a link near " . number_format(MCP_LINK_SOFT_MAX) . ". If it has to travel "
         . "through one, say so — keeping the trip turns it into a short link that cannot be cut.";
}

/** The inverse of mcp_build_link — see readLink() in the .mjs for why it exists and why a
 *  kept trip's #k= link is refused rather than fumbled. Mirrored here because the remote
 *  endpoint must offer the same tools as the stdio one; test/mcp-parity.php pins them. */
function mcp_read_link(array $input): array {
    $raw = trim((string)($input['link'] ?? ''));
    if ($raw === '') throw new \InvalidArgumentException('no link given');

    $at = strpos($raw, '#d=');
    if ($at !== false)              $b64 = substr($raw, $at + 3);
    elseif (str_contains($raw, '#k='))
        throw new \InvalidArgumentException("that is a kept trip's link — the #k= fragment is its password, not the trip. Its contents live on the server and only the people holding that link can read them; there is nothing here to decode");
    elseif (preg_match('~^https?://~i', $raw))
        throw new \InvalidArgumentException('that URL carries no trip — a readable trip link has a #d= fragment holding the itinerary');
    else                            $b64 = $raw;

    $b64 = preg_split('/[?&\s#]/', $b64)[0] ?? '';
    if ($b64 === '') throw new \InvalidArgumentException('the link has an empty #d= fragment');

    $json = base64_decode(strtr($b64, '-_', '+/'), false);
    $payload = $json === false ? null : json_decode($json, true);
    if (!is_array($payload))
        throw new \InvalidArgumentException('that fragment did not decode to a trip — it may have been truncated when the link was pasted');
    if (empty($payload['o']) || !isset($payload['l']) || !is_array($payload['l']))
        throw new \InvalidArgumentException('that decoded, but it is not shaped like a trip');

    $legs = [];
    foreach ($payload['l'] as $l) {
        $out = ['to' => $l['to'] ?? null, 'mode' => $l['mode'] ?? 'drive'];
        foreach (['date','note','who','subtype','craft','flight'] as $k)
            if (array_key_exists($k, $l)) $out[$k] = $l[$k];
        if (!empty($l['stay']['lodging'])) {
            $out['lodging'] = $l['stay']['lodging'];
            if (!empty($l['stay']['note'])) $out['stayNote'] = $l['stay']['note'];
        }
        $legs[] = $out;
    }
    $trip = ['name' => $payload['n'] ?? '', 'origin' => $payload['o'], 'legs' => $legs];

    $where = fn($p) => (is_array($p) && !empty($p['name'])) ? $p['name'] : 'an unnamed place';
    $lines = [];
    foreach ($legs as $i => $l) {
        $bits = array_values(array_filter([
            $l['date'] ?? null, $l['mode'] ?? null, $l['flight'] ?? null,
            !empty($l['who']) ? implode(' & ', (array)$l['who']) : null,
            !empty($l['lodging']) ? 'stay: ' . $l['lodging'] : null,
        ]));
        $lines[] = ($i + 1) . '. ' . $where($l['to'] ?? null) . ($bits ? '  —  ' . implode(' · ', $bits) : '');
    }
    $n = count($legs);
    $summary = (($trip['name'] !== '') ? $trip['name'] : 'Untitled trip') . " — {$n} leg" . ($n === 1 ? '' : 's') . "\n"
             . 'Starts: ' . $where($payload['o']) . "\n" . implode("\n", $lines);

    return ['trip' => $trip, 'summary' => $summary, 'legs' => $n];
}

/** The tool as the model sees it — read from the file the .mjs generated, never retyped. */
function mcp_read_tool(): array {
    static $t = null;
    if ($t === null) {
        $raw = @file_get_contents(dirname(__DIR__) . '/mcp/tool-schema-read.json');
        $t = $raw ? (json_decode($raw, true) ?: []) : [];
    }
    return $t;
}
function mcp_tool(): array {
    static $t = null;
    if ($t === null) {
        $raw = @file_get_contents(dirname(__DIR__) . '/mcp/tool-schema.json');
        $t = $raw ? (json_decode($raw, true) ?: []) : [];
    }
    return $t;
}
function mcp_schema_file(string $f): array {
    $raw = @file_get_contents(dirname(__DIR__) . '/mcp/' . $f);
    return $raw ? (json_decode($raw, true) ?: []) : [];
}
function mcp_find_tool(): array  { static $t = null; return $t ??= mcp_schema_file('tool-schema-find.json'); }
function mcp_amend_tool(): array { static $t = null; return $t ??= mcp_schema_file('tool-schema-amend.json'); }
function mcp_add_tool(): array   { static $t = null; return $t ??= mcp_schema_file('tool-schema-add.json'); }
function mcp_kept_tool(): array {
    static $t = null;
    if ($t === null) {
        $raw = @file_get_contents(dirname(__DIR__) . '/mcp/tool-schema-kept.json');
        $t = $raw ? (json_decode($raw, true) ?: []) : [];
    }
    return $t;
}

/* ── read_kept_trip, the hosted half (D-172) ────────────────────────────────────────────────
   The .mjs reaches this data over HTTPS because it runs on somebody's laptop. This copy runs ON
   the origin, so it reads the database directly — no loopback request, no second network hop.

   IT SHARES THE AUTH AND THE SEALING RATHER THAN RESTATING THEM. `access_level()` and
   `seal_pin()` come from lib/trip.php, which is where they moved so that this file would not need
   its own copy of the auth choke point. That is the whole reason that file exists: two
   implementations of a link builder drifting is a bug, and two implementations of the phrase check
   drifting is a breach.

   The projection below IS duplicated — the field allowlist and the summary wording exist in both
   servers — and test/mcp-parity.php compares the two outputs on the same trip, which is the same
   defence D-081 already applies to the link builder. */

const MCP_KEPT_STOP_FIELDS = ['kind','track','seq','date','title','lat','lng','mode','craft',
                              'fly','lodging','notes','spotify','author','path'];

/** Pull the slug and the phrase out of a kept-trip link. Mirrors keptParts() in the .mjs. */
function mcp_kept_parts(string $raw): array {
    $raw = trim($raw);
    if ($raw === '') throw new RuntimeException('no link given');
    if (str_contains($raw, '#d='))
        throw new RuntimeException('that is a DRAFT link — it carries the trip inside it, so use read_trip_link, which needs no network and no password');
    $hash = strpos($raw, '#k=');
    if ($hash === false)
        throw new RuntimeException("that link has no #k= phrase. A kept trip's link looks like https://" . APEX . "/abc1234#k=four-word-phrase — the part after #k= is its password, and without it there is nothing to ask for");
    $phrase = strtolower(trim((string)preg_split('/[?&\s#]/', substr($raw, $hash + 3))[0]));
    if ($phrase === '') throw new RuntimeException('the #k= fragment is empty');
    // strip a query string before reading the slug: /efevnwm?pmdiag=1&cb=3#k=… is a real link
    $before = rtrim(explode('?', substr($raw, 0, $hash))[0], '/');
    $parts  = array_values(array_filter(explode('/', $before), fn($s) => $s !== ''));
    $slug   = $parts ? end($parts) : '';
    if (!preg_match('/^[A-Za-z0-9_-]{4,40}$/', $slug))
        throw new RuntimeException('could not find the trip\'s address in that link — got "' . ($slug !== '' ? $slug : 'nothing') . '" before the #k=');
    return [$slug, $phrase];
}

function mcp_read_kept(array $args): array {
    [$slug, $phrase] = mcp_kept_parts((string)($args['link'] ?? ''));

    $acc = access_level($slug, $phrase);          // the SHARED choke point, phrase supplied
    $level = $acc['level'] ?? null;
    if (!$level && !empty($acc['expired']))
        throw new RuntimeException('that trip reached its end date and was deleted. Every tier has one, so this is the product working rather than a fault');
    if (!$level)
        throw new RuntimeException("not it — that phrase is not accepted for this trip. Check with whoever sent you the link. This counted as one guess against the trip's hourly limit, so it was not retried");

    /* D-187 — the hosted half of the same count. AFTER the phrase is accepted, not before it.
       It sat two lines up, ahead of access_level(), until 2026-09-11, so it counted ATTEMPTS: a
       wrong phrase, an expired trip and a malformed slug were all "reads". The first two days of
       data were exactly two, and both were a deliberate wrong-phrase probe from an audit — the
       one number this product's thesis turns on was measuring its own test. A rejected phrase
       is not an agent reading a kept trip, and the tally's own header says that is what it counts. */
    require_once __DIR__ . '/tally.php'; tally('kept_read');

    $trip = $acc['trip'];
    $who  = trim((string)($acc['member'] ?? ''));   // D-047: identity from the token, never a name

    $rows  = q_all('SELECT * FROM pins  WHERE slug=? ORDER BY updated ASC, id ASC', [$slug]);
    $notes = q_all('SELECT * FROM notes WHERE slug=? ORDER BY ord ASC, id ASC', [$slug]);

    $stops = [];
    foreach ($rows as $r) {
        $p = seal_pin(normalize_pin($r), $who);     // the one line that keeps a drop sealed
        if (!empty($p['deleted'])) continue;        // a deletion is a row, not an absence
        $out = [];
        foreach (MCP_KEPT_STOP_FIELDS as $k)
            if (isset($p[$k]) && $p[$k] !== null && $p[$k] !== '') $out[$k] = $p[$k];
        $stops[] = $out;
    }
    $noteTexts = [];
    foreach ($notes as $n) {
        if (!empty($n['deleted'])) continue;
        $t = (string)($n['body'] ?? '');
        if ($t !== '') $noteTexts[] = $t;
    }

    $expires = $trip['expires'] !== null ? gmdate('Y-m-d', intdiv((int)$trip['expires'], 1000)) : null;
    $out = [
        'address' => 'https://' . APEX . '/' . $slug,
        'name'    => (string)$trip['name'],
        'access'  => $level,
        'tier'    => (string)$trip['tier'],
        'expires' => $expires,
        'tracks'  => json_decode((string)$trip['labels_json'], true),
        'stops'   => $stops,
        'notes'   => $noteTexts,
    ];

    $dates = array_values(array_filter(array_map(fn($s) => $s['date'] ?? null, $stops)));
    sort($dates);
    $n = count($stops);
    $lines = [];
    foreach ($stops as $i => $s) {
        $bits = array_values(array_filter([
            $s['date'] ?? null,
            isset($s['track']) ? 'track ' . $s['track'] : null,
            $s['mode'] ?? null,
            isset($s['lodging']) ? 'stay: ' . $s['lodging'] : null,
        ]));
        $lines[] = ($i + 1) . '. ' . (($s['title'] ?? '') !== '' ? $s['title'] : 'an unnamed place')
                 . implode('', array_map(fn($b) => '  —  ' . $b, $bits));
    }
    $summary = ($out['name'] !== '' ? $out['name'] : 'Untitled trip')
        . " — $n stop" . ($n === 1 ? '' : 's')
        . ($dates ? ', ' . $dates[0] . ' to ' . $dates[count($dates) - 1] : ', no dates set')
        . "\nYou are reading it with " . ($level === 'edit' ? 'an EDIT phrase' : 'a VIEW phrase')
        . ($expires !== null ? ", and it ends $expires" : '') . ".\n"
        . ($lines ? implode("\n", $lines) : 'Nothing has been added to it yet.')
        . "\n\nAnything left sealed for somebody else comes back with empty text: it was never "
        . "readable by this phrase and is not readable here.";

    return ['trip' => $out, 'summary' => $summary, 'stops' => $n];
}

/* ── amend_trip_link (hosted): read → merge → build, no network, mirrors amendLink() ──────── */
function mcp_amend_link(array $input): array {
    $r = mcp_read_link(['link' => (string)($input['link'] ?? '')]);
    $trip = $r['trip'];
    $next = ['name' => $trip['name'] ?? '', 'origin' => $trip['origin'], 'legs' => $trip['legs']];
    $changed = ['name' => false, 'origin' => false, 'replaced' => false, 'added' => 0, 'removed' => false];
    if (array_key_exists('name', $input))   { $next['name']   = $input['name'];   $changed['name'] = true; }
    if (array_key_exists('origin', $input)) { $next['origin'] = $input['origin']; $changed['origin'] = true; }
    if (array_key_exists('legs', $input))   { $next['legs']   = mcp_legs_of(['legs' => $input['legs']]); $changed['replaced'] = true; }
    $add = mcp_legs_of(['legs' => $input['add'] ?? null]);
    if ($add) { $next['legs'] = array_merge($next['legs'], $add); $changed['added'] = count($add); }
    if (array_key_exists('remove', $input)) {
        $idx = $input['remove']; $n = count($next['legs']);
        if (!is_int($idx) || $idx < 1 || $idx > $n) throw new RuntimeException("remove must be a leg number from 1 to $n");
        array_splice($next['legs'], $idx - 1, 1); $changed['removed'] = true;
    }
    $built = mcp_build_link($next);
    return $built + ['changed' => $changed];
}

/* ── find_place (hosted): the geocoder, directly — no loopback ─────────────────────────── */
function mcp_find_place(array $input): array {
    $q = trim((string)($input['query'] ?? ''));
    if ($q === '') throw new RuntimeException('no place given — send a name like "Moab, UT" or an airport code');
    if (mb_strlen($q) > 120) throw new RuntimeException('that query is longer than a place name');
    require_once __DIR__ . '/geocode.php';
    $results = [];
    foreach (array_slice(geo_search($q), 0, 6) as $r)
        $results[] = ['name' => $r['name'], 'where' => $r['full'], 'lat' => $r['lat'], 'lng' => $r['lon']];
    if (!$results) throw new RuntimeException("nothing found for \"$q\" — try adding the state or country, or an airport's IATA code");
    $lines = [];
    foreach ($results as $i => $r) $lines[] = ($i + 1) . ". {$r['name']} — {$r['lat']}, {$r['lng']}\n   {$r['where']}";
    $n = count($results);
    $summary = "$n match" . ($n === 1 ? '' : 'es') . " for \"$q\":\n" . implode("\n", $lines)
             . ($n > 1 ? "\n\nPick the one in the right region; the first is not always it." : '');
    return ['results' => $results, 'summary' => $summary];
}

/* ── add_to_kept_trip (hosted): the write half of D-172 ────────────────────────────────────
   Same choke point as reading — access_level() with the phrase supplied — and the SAME insert
   the browser uses, insert_pin() in lib/trip.php, moved there for exactly this. A view phrase
   reads and is told it cannot write; an edit or member phrase writes one stop. */
function mcp_add_to_kept(array $args): array {
    [$slug, $phrase] = mcp_kept_parts((string)($args['link'] ?? ''));
    $acc = access_level($slug, $phrase);
    $level = $acc['level'] ?? null;
    if (!$level && !empty($acc['expired'])) throw new RuntimeException('that trip reached its end date and was deleted');
    if (!$level) throw new RuntimeException("not it — that phrase is not accepted for this trip. This counted as one guess against the trip's hourly limit");
    if ($level !== 'edit') throw new RuntimeException('that is a VIEW phrase — it can read this trip but not add to it. Ask the person for the edit link');
    $st = is_array($args['stop'] ?? null) ? $args['stop'] : [];
    $pt = mcp_point($st, 'the stop');
    $date = (string)($st['date'] ?? '');
    if ($date !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) throw new RuntimeException('date must be YYYY-MM-DD');
    $mode = (string)($st['mode'] ?? 'drive');
    $p = ['kind' => 'stop', 'title' => $pt['name'], 'lat' => $pt['lat'], 'lng' => $pt['lng'],
          'date' => $date !== '' ? $date : null, 'mode' => in_array($mode, MCP_MODES, true) ? $mode : 'drive',
          'notes' => mcp_clamp($st['note'] ?? '', 4000), 'track' => ($st['track'] ?? null) ?: null,
          'author' => trim((string)($acc['member'] ?? ''))];
    $id = insert_pin($slug, $p, now_ms());
    $read = mcp_read_kept($args);
    $n = $read['stops'];
    return ['id' => $id, 'stops' => $n,
            'summary' => 'Added "' . $pt['name'] . '" to ' . ($read['trip']['name'] !== '' ? $read['trip']['name'] : 'the trip') . ". It now has $n stop" . ($n === 1 ? '' : 's') . '.'];
}

/** The version, READ from mcp/package.json rather than retyped — same rule as the schema above.
 *  It was a literal until 2026-08-11 and had sat at 1.0.0 since 1.1.0, so the hosted endpoint
 *  told every client it predated `read_trip_link` while serving it. That is the exact bug
 *  test/mcp-version.mjs was written to stop, and it missed this copy because the guard checks
 *  files it knows about and nobody added this one. Deriving it means there is nothing to miss.
 *  The fallback only matters if mcp/ is absent, and mcp-parity.php fails loudly if it is. */
function mcp_version(): string {
    static $v = null;
    if ($v === null) {
        $raw = @file_get_contents(dirname(__DIR__) . '/mcp/package.json');
        $pkg = $raw ? (json_decode($raw, true) ?: []) : [];
        $v = (string)($pkg['version'] ?? '0.0.0');
    }
    return $v;
}

function mcp_ok($id, array $result): array {
    return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
}
function mcp_err($id, int $code, string $message): array {
    return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]];
}

/**
 * Handle one JSON-RPC message. Returns the response array, or null for a notification —
 * a notification has no id and the spec says answer it with 202 and no body.
 */
function mcp_handle(array $msg): ?array {
    $method = (string)($msg['method'] ?? '');
    $id     = $msg['id'] ?? null;
    $params = is_array($msg['params'] ?? null) ? $msg['params'] : [];

    // Notifications carry no id and expect no response, notifications/initialized among them.
    if (!array_key_exists('id', $msg)) return null;

    if ($method === 'initialize') {
        /* Echo the client's protocol version when it sends one. A client speaking an older
           revision is answered in its own dialect rather than being told to upgrade. */
        $ver = (string)($params['protocolVersion'] ?? '');
        return mcp_ok($id, [
            'protocolVersion' => $ver !== '' ? $ver : MCP_PROTOCOL,
            'capabilities'    => ['tools' => new stdClass()],
            'serverInfo'      => ['name' => 'thistripbtw', 'version' => mcp_version()],
        ]);
    }
    if ($method === 'ping')       return mcp_ok($id, new stdClass());
    if ($method === 'tools/list') return mcp_ok($id, ['tools' => [mcp_tool(), mcp_find_tool(), mcp_amend_tool(), mcp_read_tool(), mcp_kept_tool(), mcp_add_tool()]]);
    /* We declare only `tools`, so a client that follows the spec never asks for resources or
       prompts — and -32601 is the correct answer when it does. But scanners ask anyway: Smithery's
       2026-08-03 scan logged "Failed to list resources" and "Failed to list prompts" as WARNINGS
       on our public directory page, which reads as a fault in the server rather than a capability
       we never claimed. An empty list is true, costs two lines, and says the same thing without
       looking broken. */
    if ($method === 'resources/list') return mcp_ok($id, ['resources' => []]);
    if ($method === 'prompts/list')   return mcp_ok($id, ['prompts'   => []]);

    if ($method === 'tools/call') {
        $name = (string)($params['name'] ?? '');
        if ($name === 'read_trip_link') {
            $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
            try {
                $r = mcp_read_link($args);
                return mcp_ok($id, ['content' => [['type' => 'text',
                    'text' => $r['summary'] . "\n\nAs build_trip_link arguments:\n"
                            . "```json\n" . json_encode($r['trip'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n```"]],
                    /* The same data the text carries, in the shape tools/list promises. Text for
                       the model, structuredContent for code — see the .mjs for the rule. */
                    'structuredContent' => ['trip' => $r['trip'], 'legs' => $r['legs'], 'summary' => $r['summary']]]);
            } catch (\Throwable $e) {
                return mcp_ok($id, ['content' => [['type' => 'text', 'text' => 'Could not read that: ' . $e->getMessage()]], 'isError' => true]);
            }
        }
        $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
        if ($name === 'find_place') {
            try { $r = mcp_find_place($args);
                return mcp_ok($id, ['content' => [['type' => 'text', 'text' => $r['summary'] . "\n\nAs data:\n```json\n" . json_encode($r['results'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n```"]],
                    'structuredContent' => ['results' => $r['results'], 'summary' => $r['summary']]]);
            } catch (\Throwable $e) { return mcp_ok($id, ['content' => [['type' => 'text', 'text' => 'Could not find that: ' . $e->getMessage()]], 'isError' => true]); }
        }
        if ($name === 'amend_trip_link') {
            try { $r = mcp_amend_link($args); $c = $r['changed'];
                $what = implode(', ', array_filter([$c['added'] ? "added {$c['added']}" : null, $c['removed'] ? 'removed one' : null,
                    $c['replaced'] ? 'replaced the legs' : null, $c['name'] ? 'renamed' : null, $c['origin'] ? 'moved the start' : null])) ?: 'no change';
                return mcp_ok($id, ['content' => [['type' => 'text', 'text' => "Trip link ({$r['legs']} " . ($r['legs'] === 1 ? 'leg' : 'legs') . ", $what):\n{$r['url']}\n\nThis replaces the earlier link — give the person this one." . mcp_long_link_note($r['url'])]],
                    'structuredContent' => ['link' => $r['url'], 'legs' => $r['legs'], 'changed' => $r['changed']]]);
            } catch (\Throwable $e) { return mcp_ok($id, ['content' => [['type' => 'text', 'text' => 'Could not amend that: ' . $e->getMessage()]], 'isError' => true]); }
        }
        if ($name === 'add_to_kept_trip') {
            try { $r = mcp_add_to_kept($args);
                return mcp_ok($id, ['content' => [['type' => 'text', 'text' => $r['summary']]],
                    'structuredContent' => ['id' => $r['id'], 'stops' => $r['stops'], 'summary' => $r['summary']]]);
            } catch (\Throwable $e) { return mcp_ok($id, ['content' => [['type' => 'text', 'text' => 'Could not add that: ' . $e->getMessage()]], 'isError' => true]); }
        }
        if ($name === 'read_kept_trip') {
            $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
            try {
                $r = mcp_read_kept($args);
                return mcp_ok($id, ['content' => [['type' => 'text',
                    'text' => $r['summary'] . "\n\nThe trip as data:\n"
                            . "```json\n" . json_encode($r['trip'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n```"]],
                    'structuredContent' => ['trip' => $r['trip'], 'stops' => $r['stops'], 'summary' => $r['summary']]]);
            } catch (\Throwable $e) {
                return mcp_ok($id, ['content' => [['type' => 'text', 'text' => 'Could not read that: ' . $e->getMessage()]], 'isError' => true]);
            }
        }
        if ($name !== 'build_trip_link') return mcp_err($id, -32602, "no tool called \"$name\"");
        $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
        try {
            $r = mcp_build_link($args);
            $text = "Trip link ({$r['legs']} " . ($r['legs'] === 1 ? 'leg' : 'legs') . "):\n{$r['url']}\n\n"
                  . "Give this to the person rather than opening it yourself. It costs nothing and "
                  . "asks for nothing; if they want it to last, they can keep it from that page."
                  . mcp_long_link_note($r['url']);
            return mcp_ok($id, ['content' => [['type' => 'text', 'text' => $text]],
                                'structuredContent' => ['link' => $r['url'], 'legs' => $r['legs']]]);
        } catch (\Throwable $e) {
            /* A tool error is a RESULT with isError, not a JSON-RPC error. The model reads it,
               fixes the argument and calls again — a protocol error would just look broken. */
            /* The prefix is not decoration — it is what the .mjs sends, and test/mcp-parity.php
               compares the two at this layer. Drop it and the same bad argument reads
               differently depending on which server the model reached. */
            return mcp_ok($id, ['content' => [['type' => 'text',
                                'text' => 'Could not build that: ' . $e->getMessage()]],
                                'isError' => true]);
        }
    }

    return mcp_err($id, -32601, "unknown method \"$method\"");
}

/** The HTTP surface. POST carries one message or a batch; GET and DELETE are not supported. */
function mcp_main(): void {
    header('Cache-Control: no-store');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'OPTIONS') { http_response_code(204); exit; }

    if ($method !== 'POST') {
        /* No SSE stream and no sessions, so there is nothing for GET or DELETE to do. 405 with
           Allow is what the transport says to answer, and it tells a client the endpoint is
           real rather than missing. */
        http_response_code(405);
        header('Allow: POST');
        header('Content-Type: application/json');
        echo json_encode(['jsonrpc' => '2.0', 'error' => ['code' => -32000,
              'message' => 'this endpoint speaks JSON-RPC over POST only']]);
        exit;
    }

    $raw = file_get_contents('php://input');
    if (strlen((string)$raw) > 262144) {                 // 256 KB — 40 legs is nowhere near it
        http_response_code(413);
        header('Content-Type: application/json');
        echo json_encode(mcp_err(null, -32600, 'that request is too large'));
        exit;
    }
    $body = json_decode((string)$raw, true);
    if (!is_array($body)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(mcp_err(null, -32700, 'parse error'));
        exit;
    }

    $batch = array_keys($body) === range(0, count($body) - 1) && $body !== [];
    $msgs  = $batch ? $body : [$body];
    $out   = [];
    foreach ($msgs as $m) {
        if (!is_array($m)) { $out[] = mcp_err(null, -32600, 'invalid request'); continue; }
        $r = mcp_handle($m);
        if ($r !== null) $out[] = $r;
    }

    if (!$out) { http_response_code(202); exit; }        // notifications only
    header('Content-Type: application/json');
    echo json_encode($batch ? $out : $out[0], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
