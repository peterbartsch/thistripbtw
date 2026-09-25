<?php
/* D-081: the remote MCP endpoint and mcp/thistripbtw-mcp.mjs are two implementations of one
   contract, and two implementations drift. This is the thing that stops them.
   Identical arguments in, byte-identical URL out — anything less and the same itinerary hands
   over differently depending on which one the caller reached. The .mjs is the authority: if a
   case here fails, lib/mcp.php is wrong. */
define('SECURE_ACCESS', true);
if (!defined('APEX')) define('APEX', 'thistripbtw.us');
require __DIR__ . '/../lib/mcp.php';

$pass = 0; $fail = 0;
/* $detail prints ONLY on failure, and it is the reason this signature exists: four call sites were
   already passing a third argument that PHP silently discarded, so a parity failure named the
   assertion and hid the two values that disagreed — the one thing you need to fix it. */
function ok(string $what, bool $cond, string $detail = '') {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else { $fail++; echo "  ✗ $what" . ($detail !== '' ? "\n      $detail" : '') . "\n"; }
}

/* Ask the real server, over its real transport, rather than reimplementing its extraction. */
function js_call(array $args): string {
    $msg = json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                        'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
    $desc = [0=>['pipe','r'], 1=>['pipe','w'], 2=>['pipe','w']];
    $p = proc_open('node ' . escapeshellarg(dirname(__DIR__).'/mcp/thistripbtw-mcp.mjs'), $desc, $pipes);
    if (!is_resource($p)) return '';
    fwrite($pipes[0], $msg . "\n"); fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); fclose($pipes[1]); fclose($pipes[2]); proc_close($p);
    $j = json_decode(trim(explode("\n", trim($out))[0]), true);
    $text = $j['result']['content'][0]['text'] ?? '';
    return preg_match('#(https://\S+)#', $text, $m) ? $m[1] : ('ERR:' . $text);
}
/* Goes through mcp_handle, NOT mcp_build_link — the same layer js_call reaches. Comparing
   the builders directly hides any difference the tools/call wrapper introduces, and the first
   run of this test did exactly that: five cases "failed" only because one side had been read
   below the wrapper that adds "Could not build that: ". */
function php_call(array $args): string {
    $r = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                     'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
    $text = $r['result']['content'][0]['text'] ?? '';
    return preg_match('#(https://\S+)#', $text, $m) ? $m[1] : ('ERR:' . $text);
}

$P = fn($n,$lat,$lng) => ['name'=>$n,'lat'=>$lat,'lng'=>$lng];

$cases = [
  'minimal one leg' => ['origin'=>$P('Denver',39.7392,-104.9903),
                        'legs'=>[['to'=>$P('Moab',38.5733,-109.5498)]]],
  'every field populated' => ['name'=>'Big One','origin'=>$P('Denver',39.7392,-104.9903),
     'legs'=>[['to'=>$P('Moab',38.5733,-109.5498),'mode'=>'drive','date'=>'2026-08-14',
               'note'=>'long day','who'=>['Mel','Sam'],'subtype'=>'rental','craft'=>'Bike',
               'flight'=>'ua328','lodging'=>'Cabin','stayNote'=>'by the river']]],
  'unknown mode falls back to drive' => ['origin'=>$P('A',1,2),
     'legs'=>[['to'=>$P('B',3,4),'mode'=>'teleport']]],
  'unknown subtype is dropped, not fatal' => ['origin'=>$P('A',1,2),
     'legs'=>[['to'=>$P('B',3,4),'subtype'=>'hovercraft']]],
  'who is clamped to 8 and non-array who is dropped' => ['origin'=>$P('A',1,2),
     'legs'=>[['to'=>$P('B',3,4),'who'=>['a','b','c','d','e','f','g','h','i','j']]]],
  'overlong trip name is clamped' => ['name'=>str_repeat('x',500),'origin'=>$P('A',1,2),
     'legs'=>[['to'=>$P('B',3,4)]]],
  'unicode survives identically' => ['name'=>'Café — Zürich','origin'=>$P('Café',48.85,2.35),
     'legs'=>[['to'=>$P('Zürich',47.37,8.54),'note'=>'crème brûlée & a “quote”']]],
  'a slash in a name is not escaped differently' => ['origin'=>$P('A/B',1,2),
     'legs'=>[['to'=>$P('C/D',3,4)]]],
  'missing origin refuses the same way' => ['legs'=>[['to'=>$P('B',3,4)]]],
  'no legs refuses the same way' => ['origin'=>$P('A',1,2),'legs'=>[]],
  'a place without coordinates is refused, never guessed' => ['origin'=>['name'=>'Portland, OR'],
     'legs'=>[['to'=>$P('B',3,4)]]],
  'coordinates off the world are refused' => ['origin'=>$P('A',999,2),
     'legs'=>[['to'=>$P('B',3,4)]]],
  'a bad date is refused the same way' => ['origin'=>$P('A',1,2),
     'legs'=>[['to'=>$P('B',3,4),'date'=>'14/08/2026']]],
  'negative and fractional coordinates round-trip' => ['origin'=>$P('A',-33.8688,151.2093),
     'legs'=>[['to'=>$P('B',-0.1276,-51.5074)]]],
];

foreach ($cases as $label => $args) {
    $js = js_call($args); $php = php_call($args);
    ok($label, $js !== '' && $js === $php);
    if ($js !== $php) { echo "      js : $js\n      php: $php\n"; }
}

/* The schema is generated from the .mjs and only read here. If it is stale, tools/list lies. */
$live = json_decode(shell_exec("printf '%s\\n' '" . json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/list'])
      . "' | node " . escapeshellarg(dirname(__DIR__).'/mcp/thistripbtw-mcp.mjs') . " 2>/dev/null") ?: '{}', true);
$byName = [];
foreach (($live['result']['tools'] ?? []) as $t) $byName[$t['name']] = $t;
ok('committed tool-schema.json still matches the .mjs',
   isset($byName['build_trip_link']) && $byName['build_trip_link'] == mcp_tool());
/* Added with read_trip_link: the remote endpoint must offer the SAME TOOLS as the stdio one.
   A tool added to one server and not the other is a client that works over npx and fails over
   HTTP, which is the exact class of divergence this file exists to catch. */
ok('committed tool-schema-read.json still matches the .mjs',
   isset($byName['read_trip_link']) && $byName['read_trip_link'] == mcp_read_tool());
/* 1.3.0 added three: the same rule, three more files. A tool added to one server and not the
   other is a client that works over npx and fails over HTTP. */
ok('committed tool-schema-find.json still matches the .mjs',
   isset($byName['find_place']) && $byName['find_place'] == mcp_find_tool());
ok('committed tool-schema-amend.json still matches the .mjs',
   isset($byName['amend_trip_link']) && $byName['amend_trip_link'] == mcp_amend_tool());
ok('committed tool-schema-add.json still matches the .mjs',
   isset($byName['add_to_kept_trip']) && $byName['add_to_kept_trip'] == mcp_add_tool());
$phpList = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/list']);
$phpNames = array_column($phpList['result']['tools'] ?? [], 'name');
sort($phpNames); $jsNames = array_keys($byName); sort($jsNames);
ok('both servers list the same tools', $phpNames === $jsNames, implode(',', $phpNames) . ' vs ' . implode(',', $jsNames));

/* read_trip_link must decode identically in both, or an agent gets a different itinerary
   depending on which transport it happened to use. */
$sample = mcp_build_link(['name'=>'Round trip','origin'=>['name'=>'Chicago, IL','lat'=>41.8781,'lng'=>-87.6298],
  'legs'=>[['to'=>['name'=>'Moab, UT','lat'=>38.5733,'lng'=>-109.5498],'mode'=>'drive','date'=>'2026-09-04',
            'who'=>['Mel','Sam'],'lodging'=>'Hotel Maverick','stayNote'=>'late check-in']]]);
$phpRead = mcp_read_link(['link'=>$sample['url']]);
/* amend must produce the SAME link from the same change on both servers — it is build + read
   composed, so a drift in either shows here first. */
$amended = mcp_amend_link(['link' => $sample['url'], 'add' => [['to' => ['name'=>'Denver, CO','lat'=>39.7392,'lng'=>-104.9903]]], 'name' => 'Longer']);
$jsAmend = json_decode(shell_exec("printf '%s\n' " . escapeshellarg(json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
    'params'=>['name'=>'amend_trip_link','arguments'=>['link'=>$sample['url'],'add'=>[['to'=>['name'=>'Denver, CO','lat'=>39.7392,'lng'=>-104.9903]]],'name'=>'Longer']]]))
  . ' | node ' . escapeshellarg(dirname(__DIR__).'/mcp/thistripbtw-mcp.mjs') . ' 2>/dev/null') ?: '{}', true);
$jsAmendUrl = preg_match('~(https://\S+#d=\S+)~', $jsAmend['result']['content'][0]['text'] ?? '', $mm) ? $mm[1] : '';
ok('amend_trip_link builds the identical link on both servers', $jsAmendUrl !== '' && $jsAmendUrl === $amended['url'], substr($jsAmendUrl,0,60) . ' vs ' . substr($amended['url'],0,60));

$jsRead = json_decode(shell_exec("printf '%s\n' " . escapeshellarg(json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
    'params'=>['name'=>'read_trip_link','arguments'=>['link'=>$sample['url']]]]))
  . ' | node ' . escapeshellarg(dirname(__DIR__).'/mcp/thistripbtw-mcp.mjs') . ' 2>/dev/null') ?: '{}', true);
$jsText = $jsRead['result']['content'][0]['text'] ?? '';
$phpText = $phpRead['summary'];
ok('read_trip_link summarises identically in both servers', str_starts_with($jsText, $phpText),
   'php: ' . str_replace("\n", ' / ', $phpText));
ok('read_trip_link round-trips back to the same link in PHP',
   mcp_build_link($phpRead['trip'])['url'] === $sample['url']);

/* The two servers must answer the same set of METHODS, not just produce the same link. Added
   2026-08-03 after Smithery's scan logged "Failed to list resources" and "Failed to list prompts"
   as warnings on the public listing — correct per the spec, since we declare only `tools`, but it
   reads as a broken server. Both now answer an empty list, and both must keep doing so: a fix
   applied to one server and not the other is exactly what this file exists to catch. */
$root = dirname(__DIR__);   // not defined above; this file uses dirname(__DIR__) inline
$mjs = file_get_contents("$root/mcp/thistripbtw-mcp.mjs");
$php = file_get_contents("$root/lib/mcp.php");
foreach (['resources/list' => 'resources', 'prompts/list' => 'prompts'] as $method => $key) {
  ok("the stdio server answers $method",  str_contains($mjs, '"' . $method . '"'));
  ok("the hosted server answers $method", str_contains($php, "'" . $method . "'"));
  /* Whitespace-tolerant: the PHP is column-aligned, so a literal match fails on alignment
     rather than on the thing being wrong. */
  ok("and both return an EMPTY $key rather than an error",
     preg_match('/' . $key . ':\s*\[\s*\]/', $mjs) &&
     preg_match("/'" . $key . "'\s*=>\s*\[\s*\]/", $php));
}
ok('neither has quietly started declaring a capability it does not have',
   !str_contains($mjs, "resources: {") && !str_contains($php, "'resources' => new stdClass"));

ok('committed tool-schema-kept.json still matches the .mjs',
   isset($byName['read_kept_trip']) && $byName['read_kept_trip'] == mcp_kept_tool());

/* read_kept_trip's LINK PARSER is the one part of it that exists twice — the auth and the sealing
   are shared through lib/trip.php, but each server picks the slug and phrase out of the link
   itself. So compare the parser, which is pure and needs no database: every one of these refuses
   before anything is read, and the MESSAGE is what a model acts on, so a drift in the wording is a
   drift in behaviour. The happy path needs MySQL and is covered in test/run-local.sh. */
$keptCases = [
  'a draft link is sent to the other tool' => 'https://' . APEX . '/new#d=eyJvIjp7fX0',
  'a link with no phrase says so'          => 'https://' . APEX . '/abc1234',
  'an empty #k= is named'                  => 'https://' . APEX . '/abc1234#k=',
  'a slug that cannot be one is quoted'    => 'https://' . APEX . '/!!#k=a-b-c-d',
  'nothing at all'                         => '',
];
foreach ($keptCases as $what => $link) {
  $jsOut = json_decode(shell_exec("printf '%s\n' " . escapeshellarg(json_encode(
      ['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
       'params'=>['name'=>'read_kept_trip','arguments'=>['link'=>$link]]]))
    . ' | node ' . escapeshellarg("$root/mcp/thistripbtw-mcp.mjs") . ' 2>/dev/null') ?: '{}', true);
  $jsText = $jsOut['result']['content'][0]['text'] ?? '(no reply)';
  $phpOut = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                        'params'=>['name'=>'read_kept_trip','arguments'=>['link'=>$link]]]);
  $phpText = $phpOut['result']['content'][0]['text'] ?? '(no reply)';
  ok("read_kept_trip refuses identically in both servers — $what", $jsText === $phpText,
     "js:  $jsText\n      php: $phpText");
}

/* Both servers must report the SAME version, and this asks the real initialize handlers rather
   than matching literals. Added 2026-08-11: the PHP said 1.0.0 while the .mjs said 1.1.1, so the
   HOSTED endpoint told clients it predated read_trip_link while serving it — the same bug
   test/mcp-version.mjs exists to prevent, in the one copy that guard does not read. It checks
   files it knows the names of; this checks what a client is actually told. */
$jsInit = json_decode(shell_exec("printf '%s\n' " . escapeshellarg(json_encode(
    ['jsonrpc'=>'2.0','id'=>1,'method'=>'initialize','params'=>['protocolVersion'=>MCP_PROTOCOL]]))
  . ' | node ' . escapeshellarg("$root/mcp/thistripbtw-mcp.mjs") . ' 2>/dev/null') ?: '{}', true);
$jsVer  = $jsInit['result']['serverInfo']['version'] ?? '(none)';
$phpVer = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'initialize',
                      'params'=>['protocolVersion'=>MCP_PROTOCOL]])['result']['serverInfo']['version'] ?? '(none)';
ok('both servers report the same serverInfo version', $jsVer === $phpVer, "js: $jsVer  php: $phpVer");
ok('and it is the version in mcp/package.json',
   $phpVer === (json_decode(file_get_contents("$root/mcp/package.json"), true)['version'] ?? '?'),
   "reported: $phpVer");

/* The long-link note must be byte-identical in both servers, and it is the one piece of build
   output the URL-extracting helpers above cannot see — they match `https://\S+` and the note
   comes after it. A comment saying "keep these in sync" is not a guard, so this is one.

   Both halves matter. A trip under the ceiling must get NO note (a warning on every link is a
   warning on nothing), and a trip over it must get the SAME note from either server, down to
   the thousands separator — number_format() and toLocaleString("en-US") agree on "3,009" and
   that agreement is an assumption worth failing on rather than trusting. */
$noteOf = function (array $args, bool $js) use ($root) {
    if ($js) {
        $msg = json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                            'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
        $out = shell_exec('printf %s ' . escapeshellarg($msg . "\n")
             . ' | node ' . escapeshellarg("$root/mcp/thistripbtw-mcp.mjs") . ' 2>/dev/null');
        $j = json_decode(trim(explode("\n", trim((string)$out))[0]), true);
        $text = $j['result']['content'][0]['text'] ?? '';
    } else {
        $r = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                         'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
        $text = $r['result']['content'][0]['text'] ?? '';
    }
    $at = strpos($text, 'Heads-up:');
    return $at === false ? '' : substr($text, $at);
};

$shortTrip = ['origin'=>$P('Denver',39.7392,-104.9903),
              'legs'=>[['to'=>$P('Moab',38.5733,-109.5498)]]];
ok('a short link carries no long-link note (js)',  $noteOf($shortTrip, true)  === '');
ok('a short link carries no long-link note (php)', $noteOf($shortTrip, false) === '');

/* Twelve legs with notes and crews — the shape that measured 3,009 characters in the
   2026-09-10 UX audit, which is what put this guard here. */
$longLegs = [];
for ($i = 0; $i < 12; $i++) {
    $longLegs[] = ['to'=>$P("Waypoint number $i on the long road", 39.0 + $i / 10, -109.0 - $i / 10),
                   'mode'=>'drive', 'date'=>'2026-08-' . str_pad((string)($i + 1), 2, '0', STR_PAD_LEFT),
                   'note'=>"a note long enough to matter on leg $i, written the way a person writes one",
                   'who'=>['Mel','Sam','Alex','Jo'], 'lodging'=>"Somewhere to sleep in waypoint $i"];
}
$longTrip = ['name'=>'The long one','origin'=>$P('Denver International Airport',39.8561,-104.6737),
             'legs'=>$longLegs];
$jsNote  = $noteOf($longTrip, true);
$phpNote = $noteOf($longTrip, false);
ok('a link over the ceiling gets a long-link note at all', $jsNote !== '' && $phpNote !== '',
   "js: '" . substr($jsNote, 0, 40) . "'  php: '" . substr($phpNote, 0, 40) . "'");
ok('and both servers word it identically', $jsNote === $phpNote,
   "js:  $jsNote\n      php: $phpNote");

/* ── 1.3.3: annotations and output schemas ────────────────────────────────────────────────
   Both are new SURFACE, so both are new places to drift. The rule they add: a tool that
   declares an output schema must return structuredContent on every non-error result, and the
   two servers must return the SAME structuredContent for the same arguments — otherwise the
   npx path and the hosted path hand code two different objects for one itinerary, which is the
   text-level bug this file was written for, one layer down. */
$annotated = [];
foreach ($byName as $n => $t) {
    $a = $t['annotations'] ?? null;
    if (!is_array($a) || !isset($a['title'], $a['readOnlyHint'], $a['destructiveHint'],
                                $a['idempotentHint'], $a['openWorldHint'])) $annotated[] = $n;
    if (!isset($t['outputSchema']['type'])) $annotated[] = $n . ' (no output schema)';
}
ok('every tool carries full annotations and an output schema', $annotated === [], implode(', ', $annotated));

/* The honest ones, asserted rather than assumed: only the writer is not read-only, and only the
   three that reach thistripbtw.us are open-world. Change the server and this test says so. */
ok('add_to_kept_trip is the only tool that is not read-only',
   array_keys(array_filter($byName, fn($t) => ($t['annotations']['readOnlyHint'] ?? true) === false)) === ['add_to_kept_trip']);
$open = array_keys(array_filter($byName, fn($t) => ($t['annotations']['openWorldHint'] ?? false) === true));
sort($open);
ok('exactly the three network tools are open-world', $open === ['add_to_kept_trip', 'find_place', 'read_kept_trip'],
   implode(',', $open));
ok('nothing is marked destructive — there is no delete tool (D-072)',
   array_filter($byName, fn($t) => ($t['annotations']['destructiveHint'] ?? false) === true) === []);

/* The PHP mirror serves the committed schema files, so this also proves the files were
   regenerated after the .mjs changed — a stale file would lose the annotations here. */
$phpByName = [];
foreach (($phpList['result']['tools'] ?? []) as $t) $phpByName[$t['name']] = $t;
$mismatch = [];
foreach ($byName as $n => $t) {
    if (($phpByName[$n]['annotations'] ?? null) != ($t['annotations'] ?? null)) $mismatch[] = "$n annotations";
    if (($phpByName[$n]['outputSchema'] ?? null) != ($t['outputSchema'] ?? null)) $mismatch[] = "$n outputSchema";
}
ok('both servers publish the same annotations and output schemas', $mismatch === [], implode(', ', $mismatch));

/* structuredContent, compared the way the URLs above are: through tools/call on both sides. */
$structured = function (array $args, bool $js) {
    if ($js) {
        $req = json_encode(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                            'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
        $out = shell_exec("printf '%s\\n' " . escapeshellarg($req) . ' | node '
             . escapeshellarg(dirname(__DIR__) . '/mcp/thistripbtw-mcp.mjs') . ' 2>/dev/null');
        $j = json_decode(trim(explode("\n", trim((string)$out))[0]), true);
        return $j['result']['structuredContent'] ?? null;
    }
    $r = mcp_handle(['jsonrpc'=>'2.0','id'=>1,'method'=>'tools/call',
                     'params'=>['name'=>'build_trip_link','arguments'=>$args]]);
    return $r['result']['structuredContent'] ?? null;
};
$sc = $structured($shortTrip, true);
ok('build_trip_link returns structuredContent matching its schema',
   is_array($sc) && isset($sc['link'], $sc['legs']) && str_starts_with((string)$sc['link'], 'https://') && $sc['legs'] === 1,
   json_encode($sc));
ok('and both servers return the same structuredContent', $sc == $structured($shortTrip, false),
   json_encode($sc) . ' vs ' . json_encode($structured($shortTrip, false)));

/* A refusal has no structuredContent — the schema describes success, and an isError result that
   carried a half-filled object would be worse than none. */
ok('a refused build carries no structuredContent', $structured(['legs'=>[]], true) === null);

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
