<?php
/**
 * lib/tools.php — tool definitions + dispatch for the itinerary chat agent.
 *
 * The spec this comes from (PLAN_chat_agent.md gap 2) describes an `add_leg` tool over
 * `legs` and `stops` tables. This repo has neither, and never has: there is ONE `pins`
 * table (D-008), and since D-037 a "leg" is a *view* over two adjacent pins in a track —
 * the arriving pin owns the mode, date, who and path. So the model still gets to think in
 * legs, because that is how a person describes a trip, and this file is the only place
 * that translation happens. Do not add a legs table.
 *
 * Two non-negotiables carried over from the spec:
 *   1. Gate before spend — nothing here is reachable without a paid trip + valid edit
 *      token, and lookup_flight is unavailable pre-purchase (D-035).
 *   2. Additive only — no update, no delete. A misread adds a wrong row, which a person
 *      can remove in one tap. It can never wreck a trip that already exists.
 *
 * The model never writes SQL and never sees the database. It picks a tool name and an
 * argument object; everything below validates and clamps before anything is written.
 *
 * Place names arrive here already resolved to lat/lng by the browser (D-039). There is no
 * geocoder in this file on purpose — see chat_resolve().
 */

declare(strict_types=1);

const CHAT_MAX_STOPS_PER_CALL = 12;   // one turn cannot flood a trip
const CHAT_TRACKS = ['truck', 'rental'];   // D-011; labels are editable, keys are not

/* D-060's seven. A constant because this list was written out twice — in the schema and in
   dispatch — and both were missed when bike and walk landed, so the agent silently recorded a
   bike leg as a drive. That is the exact failure D-060 exists to prevent, and it happened here
   because the list was copied rather than named. `bus` is accepted by the API but deliberately
   not offered: D-060 calls it a subtype of drive, not a mode. */
const CHAT_MODES = ['drive', 'fly', 'train', 'ferry', 'water', 'bike', 'walk'];

/**
 * Tool schemas handed to the model.
 *
 * $paid = false is the pre-purchase path (D-035): structure only. lookup_flight is the
 * scarce resource — AeroDataBox is capped at 600/month for the whole product — so it
 * stays entirely behind payment. Its absence from the schema is the enforcement; a model
 * cannot call a tool it was never told about, and dispatch refuses it a second time.
 */
function chat_tool_schemas(bool $paid): array
{
    $place = [
        'type' => 'object',
        'properties' => [
            'name' => ['type' => 'string', 'description' => 'Place as a person would say it, e.g. "Portland, OR" or "SFO".'],
            'lat'  => ['type' => 'number', 'description' => 'Only if the user stated coordinates outright. Otherwise omit — the app resolves the name.'],
            'lng'  => ['type' => 'number'],
        ],
        'required' => ['name'],
    ];

    /* No list_trip tool: the trip's current stops are put in the system prompt instead
       (chat_state_text). Reading state was costing a whole extra model round-trip on every
       turn — ~31% of the cost of a turn — to fetch something the server already had.
       Dispatch still answers list_trip if an old transcript calls it. */
    $tools = [
        [
            'name' => 'add_leg',
            'description' =>
                'Add one leg of the trip: travelling to a place, and how. A leg is the journey '
                . 'INTO a destination — "drive to Portland on the 14th" is one leg. '
                . 'Include `from` ONLY for the very first leg of a vehicle, to say where it starts; '
                . 'every later leg begins where the previous one ended, so passing `from` again '
                . 'would create a duplicate stop. Never guess a date, a flight number or a time — '
                . 'omit what the user did not say.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'from'    => array_merge($place, ['description' => 'FIRST leg of this vehicle only. Where it starts.']),
                    'to'      => array_merge($place, ['description' => 'Where this leg ends. Required.']),
                    'mode'    => [
                        'type' => 'string',
                        'enum' => CHAT_MODES,
                        'description' => 'How they travel this leg. "water", "bike" and "walk" are routes the '
                            . 'user draws themselves. Use them when the user says so — never round a bike ride '
                            . 'or a hike up to "drive".',
                    ],
                    'date'    => ['type' => 'string', 'description' => 'Arrival date, YYYY-MM-DD. Omit if not stated — an undated leg is fine and holds its position.'],
                    'who'     => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Who is on this leg, if the user said.'],
                    'vehicle' => [
                        'type' => 'string',
                        'enum' => CHAT_TRACKS,
                        'description' => 'Which of the two travel tracks. Use "truck" unless the user clearly describes a second, separately-moving group.',
                    ],
                    'lodging' => ['type' => 'string', 'description' => 'Where they stay at the destination, if stated.'],
                    'notes'   => ['type' => 'string', 'description' => 'Anything else the user said about this leg.'],
                ],
                'required' => ['to'],
            ],
        ],
    ];

    if ($paid) {
        $tools[] = [
            'name' => 'lookup_flight',
            'description' =>
                'Look up a real flight by number and date, to get its airports and times. '
                . 'ONLY use this when the user gave an actual flight number. '
                . 'NEVER state a departure or arrival time that did not come back from this tool — '
                . 'if the lookup fails, say you could not find it and add the leg without times.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'flight_number' => ['type' => 'string', 'description' => 'e.g. "UA328", "AA1902".'],
                    'date'          => ['type' => 'string', 'description' => 'Departure date, YYYY-MM-DD.'],
                ],
                'required' => ['flight_number', 'date'],
            ],
        ];
    }

    return $tools;
}

/** Clamp to the column widths in schema.mysql.sql so the DB never truncates silently. */
function chat_clamp(?string $s, int $max): string
{
    $s = trim((string)$s);
    return mb_substr($s, 0, $max);
}

/**
 * Execute one tool call. Returns a plain array that gets handed straight back to the model
 * as the tool result, so every failure is a *described* failure the model can recover from
 * rather than an exception that kills the turn.
 *
 * @param callable $listPins  fn(string $slug): array  — current non-deleted pins
 * @param callable $addPin    fn(string $slug, array $pin): bool — the ONLY write path
 */
function chat_tool_dispatch(
    string $slug,
    bool $paid,
    string $name,
    array $input,
    callable $listPins,
    callable $addPin
): array {
    // Second gate. The schema already withholds this pre-purchase; this is the one that
    // holds if a model is ever handed a stale tool list or replays an old transcript.
    if ($name === 'lookup_flight' && !$paid) {
        return ['error' => 'unavailable', 'message' => 'Flight lookup needs a purchased trip.'];
    }

    switch ($name) {
        case 'list_trip':
            $stops = array_values(array_filter($listPins($slug), fn($p) => ($p['kind'] ?? '') === 'stop'));
            $byTrack = [];
            foreach ($stops as $p) {
                $byTrack[$p['track'] ?: 'truck'][] = [
                    'title' => $p['title'], 'date' => $p['date'] ?: null,
                    'mode'  => $p['mode'],  'seq'  => (int)$p['seq'],
                ];
            }
            foreach ($byTrack as &$arr) {
                usort($arr, fn($a, $b) => $a['seq'] <=> $b['seq']);
            }
            unset($arr);
            return ['vehicles' => $byTrack, 'total_stops' => count($stops)];

        case 'add_leg':
            $to = $input['to'] ?? null;
            if (!is_array($to) || trim((string)($to['name'] ?? '')) === '') {
                return ['error' => 'bad_input', 'message' => 'A leg needs a destination.'];
            }

            $track = in_array($input['vehicle'] ?? '', CHAT_TRACKS, true) ? $input['vehicle'] : 'truck';
            $mode  = in_array($input['mode'] ?? '', CHAT_MODES, true) ? $input['mode'] : 'drive';

            $existing = array_values(array_filter(
                $listPins($slug),
                fn($p) => ($p['kind'] ?? '') === 'stop' && ($p['track'] ?: 'truck') === $track
            ));
            if (count($existing) >= CHAT_MAX_STOPS_PER_CALL * 8) {
                return ['error' => 'too_many', 'message' => 'This trip already has a lot of stops; add the rest by hand.'];
            }
            $seq = 0;
            foreach ($existing as $p) {
                $seq = max($seq, (int)$p['seq'] + 1);
            }

            // A track's first pin IS its origin (D-037) — it has no inbound leg. Starting an
            // empty track with a mode and no `from` produces "starts at Seattle, by air",
            // which is nonsense. Send the model back for the origin rather than writing it.
            if (!$existing && empty($input['from']['name']) && $mode !== 'drive') {
                return ['error' => 'needs_origin', 'message' =>
                    'This is the first leg of ' . $track . ', so it needs `from` — where does this '
                    . 'vehicle start? A track\'s first stop is its origin and cannot itself be a '
                    . 'journey. Re-send this leg with `from` set.'];
            }

            $made = [];

            // `from` is only meaningful when the track is empty. Otherwise the previous
            // destination already IS this leg's origin (D-037), and writing it again would
            // put a duplicate pin in the middle of the chain.
            if (!empty($input['from']['name']) && !$existing) {
                $pt = chat_resolve($input['from']);
                if (!$pt) {
                    return ['error' => 'needs_coordinates', 'message' => 'No coordinates arrived for "' . chat_clamp($input['from']['name'], 80) . '". The app resolves places; ask the user to name a nearby city it can find.'];
                }
                $addPin($slug, [
                    'kind' => 'stop', 'track' => $track, 'seq' => $seq++,
                    'lat' => $pt['lat'], 'lng' => $pt['lng'],
                    'title' => chat_clamp($input['from']['name'], 300),
                    'mode' => 'drive',   // an origin has no inbound leg, so it has no mode of its own
                ]);
                $made[] = $input['from']['name'];
            }

            $pt = chat_resolve($to);
            if (!$pt) {
                return ['error' => 'needs_coordinates', 'message' => 'No coordinates arrived for "' . chat_clamp($to['name'], 80) . '". The app resolves places; ask the user to name a nearby city it can find.'];
            }

            $pin = [
                'kind' => 'stop', 'track' => $track, 'seq' => $seq,
                'lat'  => $pt['lat'], 'lng' => $pt['lng'],
                'title' => chat_clamp($to['name'], 300),
                'mode' => $mode,
                'fly'  => $mode === 'fly' ? 1 : 0,
                // `path` stays null on purpose: it is user-drawn boat/rail geometry (D-027)
                // and an invented polyline is worse than none.
            ];
            if (!empty($input['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $input['date'])) {
                $pin['date'] = $input['date'];
            }
            if (!empty($input['who']) && is_array($input['who'])) {
                $pin['author'] = chat_clamp(implode(' & ', $input['who']), 40);
            }
            if (!empty($input['lodging'])) {
                $pin['lodging'] = chat_clamp($input['lodging'], 300);
            }
            if (!empty($input['notes'])) {
                $pin['notes'] = chat_clamp($input['notes'], 4000);
            }

            $addPin($slug, $pin);
            $made[] = $to['name'];

            return ['ok' => true, 'added' => $made, 'vehicle' => $track, 'mode' => $mode];

        case 'lookup_flight':
            // Reached only on a paid trip — the gate at the top of this function and the
            // absence of the tool from the free schema both had to pass first (D-035).
            require_once __DIR__ . '/flights.php';
            return flight_lookup((string)($input['flight_number'] ?? ''), (string)($input['date'] ?? ''));
    }

    return ['error' => 'unknown_tool', 'message' => 'No such tool: ' . chat_clamp($name, 40)];
}

/**
 * A place is usable only if it arrives WITH coordinates.
 *
 * There is deliberately no geocoding here and there must never be one (D-039). The model
 * names a place, the *browser* resolves it against Nominatim — as it already does for
 * every pin — and passes lat/lng through with the tool result. This server never sends a
 * customer's typed place names to a third party, so the sub-processor inventory in
 * privacy.html stays true without adding a line.
 *
 * If a name shows up here without coordinates, that is the browser skipping its half of
 * the contract. Refuse it. Do not add a fallback lookup; a fallback is how the server
 * quietly becomes a caller again.
 */
function chat_resolve(array $place): ?array
{
    if (isset($place['lat'], $place['lng']) && is_numeric($place['lat']) && is_numeric($place['lng'])) {
        $lat = (float)$place['lat'];
        $lng = (float)$place['lng'];
        if ($lat >= -90 && $lat <= 90 && $lng >= -180 && $lng <= 180) {
            return ['lat' => $lat, 'lng' => $lng];
        }
    }
    return null;
}
