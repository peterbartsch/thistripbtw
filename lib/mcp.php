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
function mcp_build_link(array $input): array {
    $origin = mcp_point($input['origin'] ?? null, 'origin');
    $legsIn = isset($input['legs']) && is_array($input['legs']) ? array_values($input['legs']) : [];
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

/** The tool as the model sees it — read from the file the .mjs generated, never retyped. */
function mcp_tool(): array {
    static $t = null;
    if ($t === null) {
        $raw = @file_get_contents(dirname(__DIR__) . '/mcp/tool-schema.json');
        $t = $raw ? (json_decode($raw, true) ?: []) : [];
    }
    return $t;
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
            'serverInfo'      => ['name' => 'thistripbtw', 'version' => '1.0.0'],
        ]);
    }
    if ($method === 'ping')       return mcp_ok($id, new stdClass());
    if ($method === 'tools/list') return mcp_ok($id, ['tools' => [mcp_tool()]]);

    if ($method === 'tools/call') {
        $name = (string)($params['name'] ?? '');
        if ($name !== 'build_trip_link') return mcp_err($id, -32602, "no tool called \"$name\"");
        $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
        try {
            $r = mcp_build_link($args);
            $text = "Trip link ({$r['legs']} " . ($r['legs'] === 1 ? 'leg' : 'legs') . "):\n{$r['url']}\n\n"
                  . "Give this to the person rather than opening it yourself. It costs nothing and "
                  . "asks for nothing; if they want it to last, they can keep it from that page.";
            return mcp_ok($id, ['content' => [['type' => 'text', 'text' => $text]]]);
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
