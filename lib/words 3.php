<?php
/* this trip, btw — trip password wordlist + phrase generator.
   Mirror of worker.js WORDS + phrase(). Road-vocabulary, on brand.
   The list is identical to worker.js; do NOT change it without a DECISIONS entry
   (D-005 — the wordlist is a locked product surface). */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

$WORDS = preg_split('/\s+/', trim(
  "cedar canyon motel dawn mesa vista prairie thunder pinyon juniper summit ridge ".
  "gravel asphalt beacon compass lantern ember willow aspen basin butte cactus desert ".
  "harbor island jetty timber meadow orchard pasture valley glacier geyser hotspring dune ".
  "marmot coyote falcon heron bison elk osprey raven sparrow trout pelican badger ".
  "sunset sunrise moonrise starlight midnight noon dusk daybreak golden amber copper rust ".
  "diner jukebox neon route detour overpass junction crossing milepost turnout switchback grade ".
  "tumbleweed sagebrush yucca redwood sequoia cypress magnolia dogwood maple birch alder fern ".
  "creek river rapids delta lagoon cove tide surf breaker driftwood boardwalk pier ".
  "wagon caravan convoy tailwind headlight dashboard fender chrome pickup camper trailer hitch ".
  "thermos matchbox postcard snapshot ledger atlas passport suitcase duffel canteen campfire skillet ".
  "granite marble slate flint quartz cobalt indigo scarlet crimson olive moss sage ".
  "whistle echo canyonwren songbird firefly cricket cicada chorus banjo fiddle harmonica drumline ".
  "frontier homestead outpost depot station roundhouse watertower windmill silo barnwood fencepost gate ".
  "north south east west upland lowland highdesert foothill timberline treeline shoreline skyline ".
  "drift breeze gust zephyr squall monsoon drizzle downpour rainbow thunderhead cloudbank fog ".
  "pebble boulder cairn summitpost trailhead saddle pass gap hollow gulch draw wash ".
  "lark plover killdeer curlew sandpiper gull tern cormorant loon grebe teal mallard ".
  "maplesyrup hotcake biscuit gravy chili brisket cornbread peach cherry huckleberry pecan walnut ".
  "lodestar sextant almanac odometer roadmap glovebox visor mirrorshine hubcap lugnut sparkplug piston ".
  "quiet steady rambling winding rolling soaring gliding drifting wandering roaming trailing homeward"
));

/* phrase(n) — n words joined by dashes, cryptographically random (random_int). */
function phrase($n = 4) {
  global $WORDS;
  $count = count($WORDS);
  $parts = [];
  for ($i = 0; $i < $n; $i++) $parts[] = $WORDS[random_int(0, $count - 1)];
  return implode('-', $parts);
}
