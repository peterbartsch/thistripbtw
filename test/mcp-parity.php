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
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; } else { $fail++; echo "  ✗ $what\n"; }
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
$fromJs  = $live['result']['tools'][0] ?? null;
ok('committed tool-schema.json still matches the .mjs', $fromJs !== null && $fromJs == mcp_tool());

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
