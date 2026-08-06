<?php
/**
 * lib/chat.php — the itinerary chat agent's server half.
 *
 * Shape of the thing (PLAN_chat_agent.md, D-035, D-039):
 *   browser holds the transcript  →  POST it here  →  we call Anthropic  →  tool calls are
 *   dispatched through lib/tools.php  →  reply + updated transcript go back.
 *
 * THE TRANSCRIPT IS NEVER STORED. It arrives in the request, lives for that request, and is
 * handed back to the browser to hold. Nothing is written to disk or DB. "Your conversation is
 * never stored" is a claim the product makes out loud, so it has to be true in the plainest
 * possible way: there is no table, no file, and no code path that writes it.
 *
 * Logging records token counts and tool NAMES only — never arguments, never message text,
 * never the trip slug. Same rule as lib/mail.php, which counts sends without ever recording
 * a recipient.
 *
 * Geocoding does not happen here (D-039). If the model names a place we have no coordinates
 * for, we stop and ask the BROWSER to resolve it, then resume. That keeps this server out of
 * the sub-processor list.
 */

declare(strict_types=1);
require_once __DIR__ . '/varstore.php';

require_once __DIR__ . '/tools.php';

/* Haiku, per D-035, which costs the global token ceiling out "at Haiku pricing" — the
   decision's whole spend argument assumes this tier. $1/$5 per Mtok against Sonnet 5's
   $3/$15, and this is structured extraction from a few sentences of trip text, not deep
   reasoning. 200K context is far more than a trip transcript will ever need. */
const CHAT_MODEL       = 'claude-haiku-4-5';
const CHAT_MAX_TOKENS  = 1024;
const CHAT_MAX_ROUNDS  = 6;                   // tool round-trips before we stop and answer with what we have
const CHAT_MAX_HISTORY = 24;                  // messages accepted from the client

/* D-035 bounds worst-case spend with a global monthly token ceiling. The decision leaned on
   this existing; it did not, so nothing capped runaway usage. ~5M tokens/month is single-digit
   dollars at Haiku's $1/$5 per Mtok, which is the figure D-035 argued from. */
function chat_token_ceiling() { return (int)env('CHAT_GLOBAL_MONTHLY_TOKENS', '5000000'); }

const CHAT_SYSTEM = <<<'TXT'
You help someone lay out a trip on a private map. They talk the way people actually describe
travel — "we drive to Portland Thursday, Mel flies in Saturday" — and you turn that into legs.

A LEG is the journey INTO a place. "Drive to Portland on the 14th" is one leg. The first leg
of a vehicle also says where it starts; every later leg begins where the previous one ended,
so never repeat the origin.

Rules, in order of importance:
1. Never invent anything. No dates, no times, no flight numbers, no places the person did not
   say. An undated leg is completely fine — leave it out rather than guess.
2. Never state a departure or arrival time you did not get back from lookup_flight. If the
   lookup fails, say you could not find it and add the leg without times.
3. The trip's current stops are listed for you below — do not add one that is already there.
4. Two vehicles exist at most. Use the second only when the person clearly describes a
   separate group moving on its own.
5. You can only add. You cannot edit or delete — if you get something wrong, say so plainly
   and tell them to remove it in the app; do not try to work around it.

Be brief. Confirm what you added in one sentence, in lowercase, plain words, no filler.
TXT;

/**
 * Month-to-date token spend, and the gate on it.
 *
 * Counts only — no message content, no slug, same rule as mail_count(). The ceiling is
 * checked BEFORE a call, so an over-budget month costs nothing rather than one more request.
 */
function chat_tokens_path() { return dirname(__DIR__) . '/var/chat-tokens.json'; }

function chat_tokens_used() {
    $f = chat_tokens_path();
    if (!is_file($f)) return 0;
    $j = json_decode((string)@file_get_contents($f), true);
    return is_array($j) ? (int)($j[date('Y-m')] ?? 0) : 0;
}

function chat_tokens_add($n) {
    // D-091: locked across read and write. This is the ceiling that turns the feature off by
    // itself; a counter that loses increments under load is a ceiling that does not hold.
    var_update(chat_tokens_path(), function (array $j) use ($n) {
        $k = date('Y-m');
        $j[$k] = (int)($j[$k] ?? 0) + max(0, (int)$n);
        return [$j, null];
    });
}

const CHAT_DRAFT_TURNS   = 2;    // D-035: 2 turns per draft, pre-purchase
const CHAT_DRAFT_PER_IP  = 12;   // requests per IP per day — ~6 drafts at 2 turns

/** Caller's address, preferring Cloudflare's header since every request comes through it. */
function chat_client_ip() {
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
        $v = $_SERVER[$k] ?? '';
        if ($v !== '') return trim(explode(',', $v)[0]);
    }
    return '';
}

/**
 * Per-IP daily cap for the unauthenticated draft chat.
 *
 * The address is NEVER stored. We keep a keyed hash whose salt rotates daily, so yesterday's
 * file cannot be linked to today's and neither can be reversed to an address — the counter
 * can answer "has this caller had 12 goes today" and nothing else. That keeps a necessary
 * abuse control from quietly becoming the visitor log D-016 forbids.
 */
function chat_rate_ok($ip) {
    if ($ip === '') return true;                       // never lock out on a missing header
    $day  = date('Y-m-d');
    $salt = env('RATE_SALT', '') !== '' ? env('RATE_SALT') : ($day . '|' . env('APEX', 'thistripbtw.us'));
    $key  = substr(hash('sha256', $ip . '|' . $salt), 0, 16);

    /* D-091: the check and the increment happen under ONE lock. They used to be a read, a
       comparison and a separate write — so parallel requests all read the same count and all
       passed, which is precisely how an abuser would hit an unauthenticated endpoint that
       spends tokens. The decision is returned from inside the lock it was made in. */
    return var_update(dirname(__DIR__) . '/var/chat-rate.json', function (array $j) use ($day, $key) {
        foreach (array_keys($j) as $d) if ($d !== $day) unset($j[$d]);   // yesterday is forgotten
        $n = (int)($j[$day][$key] ?? 0);
        if ($n >= CHAT_DRAFT_PER_IP) return [$j, false];
        $j[$day][$key] = $n + 1;
        return [$j, true];
    });
}

/** Compact view of what's already on the trip — replaces a whole list_trip round-trip. */
function chat_state_text(callable $listPins, $slug) {
    $stops = array_values(array_filter($listPins($slug), fn($p) => ($p['kind'] ?? '') === 'stop'));
    if (!$stops) return "The trip is empty — the first leg you add also sets where it starts.";
    $byTrack = [];
    foreach ($stops as $p) $byTrack[$p['track'] ?: 'truck'][] = $p;
    $out = ["Already on this trip (do not add these again):"];
    foreach ($byTrack as $tr => $arr) {
        usort($arr, fn($a, $b) => (int)$a['seq'] <=> (int)$b['seq']);
        $names = array_map(fn($p) => $p['title'] . ($p['date'] ? ' (' . $p['date'] . ')' : ''), $arr);
        $out[] = '  ' . $tr . ': ' . implode(' -> ', $names);
    }
    return implode("\n", $out);
}

/** Count tokens and tool names. Never content, never the slug. */
function chat_log(string $event, array $fields = []): void
{
    $safe = [];
    foreach ($fields as $k => $v) {
        if (in_array($k, ['in', 'out', 'rounds', 'tools', 'status'], true)) $safe[$k] = $v;
    }
    error_log('[chat] ' . $event . ' ' . json_encode($safe));
}

/** One call to Anthropic. Returns the decoded body, or throws with a safe message. */
function chat_call_model(array $messages, array $tools, string $system): array
{
    $key = env('ANTHROPIC_API_KEY', '');
    if ($key === '') throw new RuntimeException('chat is not configured');

    $payload = [
        'model'      => CHAT_MODEL,
        'max_tokens' => CHAT_MAX_TOKENS,
        'system'     => $system,
        'messages'   => $messages,
        'tools'      => $tools,
    ];

    $ch = curl_init('https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 45,
        CURLOPT_HTTPHEADER     => [
            'content-type: application/json',
            'x-api-key: ' . $key,
            'anthropic-version: 2023-06-01',
        ],
        CURLOPT_POSTFIELDS     => json_encode($payload),
    ]);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false || $code >= 500) throw new RuntimeException('the assistant is unavailable right now');
    $d = json_decode((string)$raw, true);
    if ($code === 429) throw new RuntimeException('too many requests — give it a moment');
    if ($code >= 400 || !is_array($d)) throw new RuntimeException('the assistant could not answer that');
    return $d;
}

/**
 * Run the agent loop for one user turn.
 *
 * $places maps a place name the model used → ['lat'=>..,'lng'=>..], resolved by the BROWSER.
 * If the model names something absent from that map we return `needs_places` and stop; the
 * client geocodes, then re-posts the same transcript with the map filled in.
 *
 * @return array{reply:string,messages:array,added:array,needs_places:array,usage:array}
 */
function chat_run(string $slug, bool $paid, array $messages, array $places, callable $listPins, callable $addPin): array
{
    $tools  = chat_tool_schemas($paid);
    $added  = [];
    $names  = [];
    $needs  = [];
    $usage  = ['in' => 0, 'out' => 0];

    // Trip state goes in the prompt instead of costing a list_trip round-trip every turn.
    // Today's date goes in too: without it the model resolves "August 14th" against its
    // training prior and silently invents a year — which is rule 1 of the system prompt
    // being broken by an omission in the system prompt.
    $system = CHAT_SYSTEM
        . "\n\nToday is " . date('l, j F Y') . ". A bare month and day means the next time that"
        . " date occurs from today; never assume a different year."
        . "\n\n" . chat_state_text($listPins, $slug);

    for ($round = 0; $round < CHAT_MAX_ROUNDS; $round++) {
        if (chat_tokens_used() >= chat_token_ceiling()) {
            chat_log('turn', ['status' => 'ceiling']);
            throw new RuntimeException('the assistant is resting until next month — add stops by hand for now');
        }
        $res = chat_call_model($messages, $tools, $system);
        $usage['in']  += (int)($res['usage']['input_tokens']  ?? 0);
        $usage['out'] += (int)($res['usage']['output_tokens'] ?? 0);
        chat_tokens_add((int)($res['usage']['input_tokens'] ?? 0) + (int)($res['usage']['output_tokens'] ?? 0));

        $content = $res['content'] ?? [];
        $messages[] = ['role' => 'assistant', 'content' => $content];

        $calls = array_values(array_filter($content, fn($b) => ($b['type'] ?? '') === 'tool_use'));
        if (!$calls) {
            $text = '';
            foreach ($content as $b) if (($b['type'] ?? '') === 'text') $text .= $b['text'];
            chat_log('turn', ['in' => $usage['in'], 'out' => $usage['out'], 'rounds' => $round + 1, 'tools' => $names, 'status' => 'ok']);
            return ['reply' => trim($text), 'messages' => $messages, 'added' => $added, 'needs_places' => [], 'usage' => $usage];
        }

        $results = [];
        foreach ($calls as $c) {
            $name  = (string)($c['name'] ?? '');
            $input = is_array($c['input'] ?? null) ? $c['input'] : [];
            $names[] = $name;

            // Attach browser-resolved coordinates before dispatch (D-039).
            foreach (['from', 'to'] as $slot) {
                $n = $input[$slot]['name'] ?? null;
                if (is_string($n) && isset($places[$n]['lat'], $places[$n]['lng'])) {
                    $input[$slot]['lat'] = $places[$n]['lat'];
                    $input[$slot]['lng'] = $places[$n]['lng'];
                }
            }

            $out = chat_tool_dispatch($slug, $paid, $name, $input, $listPins, $addPin);

            // A place we have no coordinates for: pause the whole turn and ask the browser.
            if (($out['error'] ?? '') === 'needs_coordinates') {
                foreach (['from', 'to'] as $slot) {
                    $n = $input[$slot]['name'] ?? null;
                    if (is_string($n) && $n !== '' && !isset($places[$n])) $needs[] = $n;
                }
            }
            if (!empty($out['ok']) && !empty($out['added'])) $added = array_merge($added, $out['added']);

            $results[] = ['type' => 'tool_result', 'tool_use_id' => (string)($c['id'] ?? ''), 'content' => json_encode($out)];
        }

        if ($needs) {
            chat_log('turn', ['in' => $usage['in'], 'out' => $usage['out'], 'rounds' => $round + 1, 'tools' => $names, 'status' => 'needs_places']);
            array_pop($messages);   // drop the half-finished assistant turn; the client resends with coordinates
            return ['reply' => '', 'messages' => $messages, 'added' => $added, 'needs_places' => array_values(array_unique($needs)), 'usage' => $usage];
        }

        $messages[] = ['role' => 'user', 'content' => $results];
    }

    chat_log('turn', ['in' => $usage['in'], 'out' => $usage['out'], 'rounds' => CHAT_MAX_ROUNDS, 'tools' => $names, 'status' => 'max_rounds']);
    return [
        'reply'        => "that took more steps than i can do at once — check what landed and tell me what's still missing.",
        'messages'     => $messages, 'added' => $added, 'needs_places' => [], 'usage' => $usage,
    ];
}

/** Count the caller's own turns — D-035 caps a pre-purchase draft at CHAT_DRAFT_TURNS. */
function chat_user_turns(array $messages) {
    $n = 0;
    foreach ($messages as $m) if (($m['role'] ?? '') === 'user' && is_string($m['content'] ?? null)) $n++;
    return $n;
}

/** Trim what the client sends: bounded length, only roles we expect. */
function chat_sanitize_history($messages): array
{
    if (!is_array($messages)) return [];
    $out = [];
    foreach ($messages as $m) {
        $role = $m['role'] ?? '';
        if ($role !== 'user' && $role !== 'assistant') continue;
        if (!isset($m['content'])) continue;
        $out[] = ['role' => $role, 'content' => $m['content']];
    }
    return array_slice($out, -CHAT_MAX_HISTORY);
}
