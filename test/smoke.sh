#!/usr/bin/env bash
# this trip, btw — API smoke test (PLAN §3.1), path-based routing (D-021).
# Trips live at /{slug}; the trip API is /{slug}/api/... and claim is /api/claim.
#
# Env:
#   BASE_URL   where to connect            (default http://127.0.0.1:8080)
#   MYSQL_CMD  optional mysql client cmd, e.g. "mysql -u root -h 127.0.0.1 -P 3307 ttb_main"
#              (used only to assert the gate table recorded failed guesses, step 5)
#
# The server under test must have STRIPE_API_BASE pointed at test/mock-stripe.php
# (test/run-local.sh wires that up).
set -u

CONN="${BASE_URL:-http://127.0.0.1:8080}"
TMP="$(mktemp)"
PASS=0; FAIL=0; SKIP=0
trap 'rm -f "$TMP"' EXIT

grn(){ printf '\033[32m%s\033[0m' "$1"; }
red(){ printf '\033[31m%s\033[0m' "$1"; }
ylw(){ printf '\033[33m%s\033[0m' "$1"; }
ok(){  PASS=$((PASS+1)); printf '  %s %s\n' "$(grn PASS)" "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; }
# A third outcome, because two were not enough. Several assertions here are of the shape
# `grep -q X && bad || ok` — they pass when a string is ABSENT. That is the right test when the
# fixture is present and the WRONG one when it is missing, because "the sealed title is not in
# the archive" is trivially true of an archive with no sealed drop in it. Such an assertion
# reports success on a build that leaks every drop. Skipped is not passed, and it is counted and
# printed separately so it can never be mistaken for coverage.
skip(){ SKIP=$((SKIP+1)); printf '  %s %s\n' "$(ylw SKIP)" "$1"; }
step(){ printf '\n%s\n' "$1"; }

# call METHOD PATH [TOKEN] [DATA] [CTYPE]  -> sets $CODE and $BODY
call(){
  local method="$1" path="$2" token="${3:-}" data="${4:-}" ctype="${5:-application/json}"
  local args=(-s -o "$TMP" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ]  && args+=(-H "content-type: $ctype" --data-binary "$data")
  CODE="$(curl "${args[@]}" "$CONN$path")"
  BODY="$(cat "$TMP")"
}
jget(){ printf '%s' "$1" | php -r '$j=json_decode(stream_get_contents(STDIN),true);$k=$argv[1];$v=$j[$k]??"";echo is_bool($v)?($v?"true":"false"):$v;' "$2"; }
pinf(){ printf '%s' "$1" | php -r '$j=json_decode(stream_get_contents(STDIN),true);foreach(($j["pins"]??[]) as $p){if(($p["id"]??null)===$argv[1]){$v=$p[$argv[2]];echo is_bool($v)?($v?1:0):$v;return;}}echo "__missing__";' "$2" "$3"; }

SID="cs_smoke_250_$$_$(date +%s)"   # amount 250 => plan tier (also drives step 9 -> 402)

step "1. POST /api/claim (new session) -> 200 + slug + two phrases"
call POST /api/claim "" "{\"session_id\":\"$SID\",\"trip_name\":\"smoke test\"}"
[ "$CODE" = 200 ] && ok "claim -> 200" || bad "claim expected 200, got $CODE ($BODY)"
BODY_CLAIM1="$BODY"
SLUG="$(jget "$BODY" slug)"; EDIT="$(jget "$BODY" edit_token)"; VIEW="$(jget "$BODY" view_token)"; TIER="$(jget "$BODY" tier)"
{ [ -n "$SLUG" ] && [ -n "$EDIT" ] && [ -n "$VIEW" ]; } && ok "slug=$SLUG tier=$TIER, two phrases returned" || bad "missing fields (slug='$SLUG')"
T="/$SLUG/api"   # trip API base

step "1b. D-067: the claim minted an account from the receipt email"
ACCT_EMAIL="$(jget "$BODY_CLAIM1" account_email)"
[ -n "$ACCT_EMAIL" ] && ok "account minted for $ACCT_EMAIL" || bad "no account_email returned by claim"
if [ -n "${MYSQL_CMD:-}" ]; then
  LINKED="$($MYSQL_CMD -N -e "SELECT COUNT(*) FROM account_trips t JOIN accounts a ON a.id=t.account_id WHERE t.slug='$SLUG' AND a.email='$ACCT_EMAIL'" 2>/dev/null)"
  [ "$LINKED" = "1" ] && ok "trip linked to the account" || bad "expected 1 account_trips row, got '$LINKED'"
  NULLPW="$($MYSQL_CMD -N -e "SELECT pass_hash IS NULL FROM accounts WHERE email='$ACCT_EMAIL'" 2>/dev/null)"
  [ "$NULLPW" = "1" ] && ok "no password set — they never chose one" || bad "pass_hash should be NULL, got '$NULLPW'"
fi

step "0. Routing: real 404s, and every real surface still served"
# The danger in narrowing the catch-all is narrowing it too far. Each Allow below is a page or
# asset class that WOULD have kept working under the old unconditional app.html fallback, so a
# regression here looks like a healthy 200 everywhere and a dead site.
rcode(){ curl -s -o /dev/null -w '%{http_code}' "$CONN$1"; }
# /.well-known/mcp.json was a 404 until D-081 gave it a real manifest — it is asserted 200 below.
for want404 in /this-page-does-not-exist-12345 /openapi.json /.well-known/nothing.json /llms-full.txt /nope/deeper/still; do
  C="$(rcode "$want404")"
  [ "$C" = "404" ] && ok "404: $want404" || bad "$want404 should be 404, got $C"
done
for want200 in / /privacy /about /faq /terms /help /what-you-get /account /for-agents /starts /new /agent-ready /.well-known/agent-skills/index.json /.well-known/api-catalog /agent-skill /robots.txt /llms.txt /pages.css /pages.js /fonts/barlow-400.woff2 /vendor/leaflet-1.9.4/leaflet.min.js /vendor/leaflet-1.9.4/leaflet.min.css; do
  C="$(rcode "$want200")"
  [ "$C" = "200" ] && ok "200: $want200" || bad "$want200 should be 200, got $C"
done
# D-120 (§2e): three builders became one. All three old entry points 301 to /new, and /radial
# points straight there rather than at /quick — a 301 -> 301 chain costs a round trip and every
# crawler that follows it reads a slower site.
for want301 in /radial /quick /quicktree; do
  C="$(rcode "$want301")"
  [ "$C" = "301" ] && ok "301: $want301 -> /new" || bad "$want301 should be 301, got $C"
  L="$(curl -s -o /dev/null -w '%{redirect_url}' "$CONN$want301")"
  case "$L" in
    *"/new") ok "   and lands on /new, not another redirect" ;;
    *)       bad "$want301 redirects to $L, expected /new" ;;
  esac
done

step "0-1. The checkout block is not on the public homepage (review 1.1)"
call GET /
printf '%s' "$BODY" | grep -q "Payment received" && bad "the checkout block is in the public homepage DOM" \
  || ok "no 'Payment received' for an ordinary visitor"
printf '%s' "$BODY" | grep -q 'id="tripName"' && bad "the trip-name field is still exposed" \
  || ok "and no post-checkout fields either"
# the page must still be a whole document after the surgery, not a truncated one
printf '%s' "$BODY" | grep -q "</html>" && ok "the stripped page is still a complete document" || bad "stripping broke the document"
printf '%s' "$BODY" | grep -q 'id="pricing"' && ok "and everything after the block survived" || bad "content after the block was lost"
# ...but a real return from Stripe still gets it
call GET "/?session_id=cs_test_smoke"
printf '%s' "$BODY" | grep -q "Payment received" && ok "a post-checkout return still gets the block" \
  || bad "session_id return is missing the claim UI"

step "0-2. Pricing CTAs name the outcome, not three identical verbs (review 1b.2)"
call GET /
N="$(printf '%s' "$BODY" | grep -c '>Start a trip<')"
[ "$N" = "0" ] && ok "no three-identical-label CTAs left" || bad "found $N 'Start a trip' CTAs"

step "0-3. /starts shows four shapes and keeps twelve (review 1b.6)"
call GET /starts
N="$(printf '%s' "$BODY" | grep -c '<li class="start">')"
[ "$N" = "12" ] && ok "all twelve shapes are still in the DOM" || bad "expected 12 shapes in the DOM, got $N"
VIS="$(printf '%s' "$BODY" | sed -n '1,/<details class=/p' | grep -c '<li class="start">')"
[ "$VIS" = "4" ] && ok "four are visible before the disclosure" || bad "expected 4 visible, got $VIS"
printf '%s' "$BODY" | sed -n '1,/<details class=/p' | grep -q 'Two vehicles, meeting in the middle' \
  && ok "and the two-vehicles shape leads" || bad "two-vehicles is not among the visible four"
printf '%s' "$BODY" | grep -q '</details>' && ok "the disclosure is closed properly" || bad "unclosed <details>"

step "0a0. The remote MCP endpoint speaks JSON-RPC (D-081)"
call POST /mcp "" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
[ "$CODE" = "200" ] && ok "initialize -> 200" || bad "initialize expected 200, got $CODE"
printf '%s' "$BODY" | grep -q '"serverInfo"' && ok "and it names itself" || bad "no serverInfo: $BODY"
printf '%s' "$BODY" | grep -q '"protocolVersion":"2025-06-18"' && ok "echoes the client protocol version" || bad "did not echo protocol: $BODY"
call POST /mcp "" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
printf '%s' "$BODY" | grep -q 'build_trip_link' && ok "tools/list offers build_trip_link" || bad "no tool listed: $BODY"
call POST /mcp "" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"build_trip_link","arguments":{"origin":{"name":"Denver","lat":39.7392,"lng":-104.9903},"legs":[{"to":{"name":"Moab","lat":38.5733,"lng":-109.5498}}]}}}'
printf '%s' "$BODY" | grep -q '/new#d=' && ok "tools/call returns a handover link" || bad "no link: $BODY"
# D-039 holds on the remote path too: a place name without coordinates is refused, never guessed
call POST /mcp "" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"build_trip_link","arguments":{"origin":{"name":"Portland, OR"},"legs":[{"to":{"name":"B","lat":1,"lng":2}}]}}}'
printf '%s' "$BODY" | grep -q '"isError":true' && ok "a place without coordinates is refused, not guessed" || bad "should have refused: $BODY"
# a notification carries no id and must get 202 with no body
call POST /mcp "" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
[ "$CODE" = "202" ] && ok "notification -> 202, no body" || bad "notification expected 202, got $CODE"
[ "$(rcode /mcp)" = "405" ] && ok "GET /mcp -> 405 (no SSE, no sessions)" || bad "GET /mcp should be 405, got $(rcode /mcp)"
call POST /mcp "" 'not json at all'
[ "$CODE" = "400" ] && ok "unparseable body -> 400" || bad "bad JSON expected 400, got $CODE"

[ "$(rcode /sitemap.xml)" = "200" ] && ok "200: /sitemap.xml" || bad "sitemap should be 200, got $(rcode /sitemap.xml)"
call GET /sitemap.xml
printf '%s' "$BODY" | grep -q "<urlset" && ok "and it is XML, not the SPA" || bad "sitemap is not xml"
# every URL it advertises must actually route, or the sitemap is worse than none
for u in $(printf '%s' "$BODY" | grep -o 'https://thistripbtw\.us[^<]*' | sed 's#https://thistripbtw.us##'); do
  P="${u:-/}"; C="$(rcode "$P")"
  [ "$C" = "200" ] || bad "sitemap lists $P but it returns $C"
done
ok "every URL in the sitemap routes"
[ "$(rcode /.well-known/mcp.json)" = "200" ] && ok "200: /.well-known/mcp.json (discovery)" || bad "well-known should be 200, got $(rcode /.well-known/mcp.json)"
call GET /.well-known/mcp.json
printf '%s' "$BODY" | grep -q '"streamable-http"' && ok "and it advertises the remote URL" || bad "well-known does not carry the remote: $BODY"

step "0a. The MCP server is actually obtainable (D-080)"
# /for-agents tells people to run this file. Until it was routed, the URL returned the trip
# client with HTTP 200 — advertised on the site and impossible to get.
C="$(rcode /mcp/thistripbtw-mcp.mjs)"
[ "$C" = "200" ] && ok "200: /mcp/thistripbtw-mcp.mjs" || bad "MCP server should be 200, got $C"
call GET /mcp/thistripbtw-mcp.mjs
printf '%s' "$BODY" | head -c 400 | grep -q "#!/usr/bin/env node\|import\|modelcontextprotocol" \
  && ok "and it is the server source, not a web page" || bad "served something that is not the MCP source"
# Apache's FilesMatch denies every .md by requested filename, which no rewrite undoes, so the
# README is served extensionless. The link on /for-agents points here.
[ "$(rcode /mcp/readme)" = "200" ] && ok "200: /mcp/readme" || bad "README should be 200 at /mcp/readme"
[ "$(rcode /mcp/server.json)" = "200" ] && ok "200: /mcp/server.json" || bad "server.json should be 200"
# the directory itself, and anything not on the pattern, stay closed
# /mcp/ is the same path as /mcp once empty segments are dropped, so it is the ENDPOINT, and
# GET on it is 405. It was a 404 before D-081. Either way it is never a directory listing.
[ "$(rcode /mcp/)" = "405" ] && ok "405: /mcp/ is the endpoint, not a listing" || bad "/mcp/ should be 405, got $(rcode /mcp/)"
[ "$(rcode /mcp/../api.php)" = "404" ] && ok "404: /mcp/../api.php cannot escape" || bad "path traversal not refused"

step "0b. robots.txt is ours, and says what we decided (D-078)"
call GET /robots.txt
printf '%s' "$BODY" | grep -q "ai-train=yes" && ok "ai-train=yes is being served" || bad "robots.txt missing ai-train=yes"
printf '%s' "$BODY" | grep -qi "<!doctype\|<html" && bad "robots.txt is serving HTML — the catch-all is still swallowing it" \
  || ok "robots.txt is plain text, not the SPA"
printf '%s' "$BODY" | awk '/^User-agent: (ClaudeBot|GPTBot)/{f=1;next} f&&/^Disallow: \//{print "BAD";exit} f&&/^$/{f=0}' | grep -q BAD \
  && bad "an AI crawler is disallowed in our own robots.txt" || ok "no Disallow for ClaudeBot or GPTBot"

step "1b2. D-076: verification is a real gate, and a receipt already clears it"
if [ -n "${MYSQL_CMD:-}" ]; then
  VER="$($MYSQL_CMD -N -e "SELECT verified FROM accounts WHERE email='$ACCT_EMAIL'" 2>/dev/null)"
  [ "$VER" = "1" ] && ok "receipt-minted account is verified (Stripe charged that address)" \
    || bad "expected verified=1 from claim, got '$VER'"

  # The pair below is the whole point: SAME address, SAME correct password, and the only thing
  # that changes between the two calls is `verified`. Anything else failing would fail both.
  UEM="ttbverify_$$@example.com"
  UPW="correct-horse-battery-staple"
  UHASH="$(php -r 'echo password_hash($argv[1], PASSWORD_DEFAULT);' "$UPW")"
  $MYSQL_CMD -e "INSERT INTO accounts (id,email,pass_hash,verified,created) VALUES ('av$$','$UEM','$UHASH',0,1)" 2>/dev/null

  call POST /api/account/login "" "{\"email\":\"$UEM\",\"password\":\"$UPW\"}"
  [ "$CODE" = "401" ] && ok "unverified account refused despite the correct password" \
    || bad "expected 401 for unverified sign-in, got $CODE ($BODY)"

  $MYSQL_CMD -e "UPDATE accounts SET verified=1 WHERE email='$UEM'" 2>/dev/null
  call POST /api/account/login "" "{\"email\":\"$UEM\",\"password\":\"$UPW\"}"
  [ "$CODE" = "200" ] && ok "the very same credentials work once verified" \
    || bad "expected 200 after verifying, got $CODE ($BODY)"

  step "1b3. D-076: the mailer is capped, and never admits it"
  MCODES=""
  for _ in 1 2 3 4 5; do
    call POST /api/account/reset-request "" "{\"email\":\"$UEM\"}"
    MCODES="$MCODES$CODE "
  done
  [ "$MCODES" = "200 200 200 200 200 " ] && ok "all five answered 200 — throttling is invisible" \
    || bad "reset-request should always answer 200, got: $MCODES"
  HITS="$($MYSQL_CMD -N -e "SELECT hits FROM mail_gate WHERE email='$UEM'" 2>/dev/null)"
  [ "$HITS" = "3" ] && ok "capped at 3 sends in the hour, not 5" \
    || bad "expected mail_gate hits=3, got '$HITS'"

  # An address with no account must answer identically — that is the enumeration guard.
  call POST /api/account/reset-request "" "{\"email\":\"nobody_$$@example.com\"}"
  [ "$CODE" = "200" ] && ok "an unknown address answers 200 too (no oracle)" \
    || bad "expected 200 for unknown address, got $CODE"
fi

step "1b4. D-076 step 2: open signup, and it tells a stranger nothing"
if [ -n "${MYSQL_CMD:-}" ]; then
  NEW="ttbsignup_$$@example.com"
  call POST /api/account/signup "" "{\"email\":\"$NEW\"}"
  A="$CODE$BODY"
  [ "$CODE" = "200" ] && ok "signup for a new address -> 200" || bad "expected 200, got $CODE"
  ROW="$($MYSQL_CMD -N -e "SELECT CONCAT(verified,'/',pass_hash IS NULL) FROM accounts WHERE email='$NEW'" 2>/dev/null)"
  [ "$ROW" = "0/1" ] && ok "the account exists but is unverified AND has no password" \
    || bad "expected verified=0 and NULL password, got '$ROW'"

  # the whole point: it is not a way in until the mailed token is redeemed
  call POST /api/account/login "" "{\"email\":\"$NEW\",\"password\":\"anything-at-all\"}"
  [ "$CODE" = "401" ] && ok "and it cannot be signed into" || bad "expected 401, got $CODE"

  # signing up for an address that already has an account must be indistinguishable
  call POST /api/account/signup "" "{\"email\":\"$NEW\"}"
  B="$CODE$BODY"
  [ "$A" = "$B" ] && ok "second signup for the SAME address answers identically (no oracle)" \
    || bad "existing-account signup differs: '$A' vs '$B'"
  call POST /api/account/signup "" '{"email":"not-an-email-at-all"}'
  [ "$CODE$BODY" = "$A" ] && ok "a malformed address answers identically too" \
    || bad "malformed address is distinguishable: $CODE$BODY"

  # redeeming the token is what verifies — one flow for signup and reset (D-076 step 1)
  TOK="$($MYSQL_CMD -N -e "SELECT COUNT(*) FROM resets WHERE used=0 AND account_id=(SELECT id FROM accounts WHERE email='$NEW')" 2>/dev/null)"
  [ "$TOK" = "1" ] && ok "exactly one live token exists — older ones are burned on each request" \
    || bad "expected 1 unused reset row, got '$TOK'"

  # and the mailer is capped on this path too
  for _ in 1 2 3 4; do call POST /api/account/signup "" "{\"email\":\"$NEW\"}"; done
  HITS="$($MYSQL_CMD -N -e "SELECT hits FROM mail_gate WHERE email='$NEW'" 2>/dev/null)"
  [ "$HITS" = "3" ] && ok "signup mail capped at 3/hour like every other path" \
    || bad "expected mail_gate hits=3, got '$HITS'"
fi

step "1c. a paid claim with NO email on the session still succeeds"
SID_NE="cs_smoke_250_noemail_$$_$(date +%s)"
call POST /api/claim "" "{\"session_id\":\"$SID_NE\",\"trip_name\":\"no email\"}"
[ "$CODE" = 200 ] && ok "claim without an email -> 200 (a purchase is never failed by bookkeeping)" \
  || bad "claim without an email expected 200, got $CODE ($BODY)"
[ -n "$(jget "$BODY" slug)" ] && ok "and it still returned a trip" || bad "no slug returned"

step "2. POST /api/claim (same session again) -> 409"
call POST /api/claim "" "{\"session_id\":\"$SID\"}"
[ "$CODE" = 409 ] && ok "replay -> 409" || bad "replay expected 409, got $CODE ($BODY)"

step "3. GET /{slug}/api/trip/state with edit phrase -> 200 access:edit"
call GET "$T/trip/state?since=0" "$EDIT"
{ [ "$CODE" = 200 ] && [ "$(jget "$BODY" access)" = edit ]; } && ok "edit -> 200 access:edit" || bad "expected 200/edit, got $CODE access=$(jget "$BODY" access)"

step "4. GET state with view phrase -> 200 access:view"
call GET "$T/trip/state?since=0" "$VIEW"
{ [ "$CODE" = 200 ] && [ "$(jget "$BODY" access)" = view ]; } && ok "view -> 200 access:view" || bad "expected 200/view, got $CODE access=$(jget "$BODY" access)"

step "5. GET state with wrong phrase x3 -> 401 each"
w=0
for i in 1 2 3; do
  call GET "$T/trip/state?since=0" "not-the-phrase-$i"
  [ "$CODE" = 401 ] && w=$((w+1)) || bad "wrong guess $i expected 401, got $CODE"
done
[ "$w" = 3 ] && ok "3 wrong guesses -> 401 x3" || bad "only $w/3 returned 401"
if [ -n "${MYSQL_CMD:-}" ]; then
  HITS="$($MYSQL_CMD -N -e "SELECT COALESCE(SUM(hits),0) FROM gate WHERE slug='$SLUG'" 2>/dev/null)"
  [ "${HITS:-0}" -ge 3 ] 2>/dev/null && ok "gate table recorded failed guesses (hits=$HITS)" || bad "gate hits=$HITS (<3)"
fi

step "6. POST a stop pin (edit) -> 200; state shows it"
call POST "$T/trip/pins" "$EDIT" '{"kind":"stop","track":"truck","date":"2026-08-07","lat":43.6,"lng":-110.7,"title":"Jackson Hole"}'
[ "$CODE" = 200 ] && ok "create pin -> 200" || bad "create pin expected 200, got $CODE ($BODY)"
PID="$(jget "$BODY" id)"
call GET "$T/trip/state?since=0" "$EDIT"
[ "$(pinf "$BODY" "$PID" title)" = "Jackson Hole" ] && ok "pin present in state ($PID)" || bad "pin $PID not found in state"

step "7. PATCH the pin with view phrase -> 403"
call PATCH "$T/trip/pins/$PID" "$VIEW" '{"title":"hacked"}'
[ "$CODE" = 403 ] && ok "view write -> 403" || bad "view write expected 403, got $CODE ($BODY)"

step "8. DELETE the pin (edit) -> state returns a tombstone"
call DELETE "$T/trip/pins/$PID" "$EDIT"
[ "$CODE" = 200 ] && ok "delete pin -> 200" || bad "delete pin expected 200, got $CODE ($BODY)"
call GET "$T/trip/state?since=0" "$EDIT"
[ "$(pinf "$BODY" "$PID" deleted)" = 1 ] && ok "tombstone present (deleted=1)" || bad "expected tombstone deleted=1, got $(pinf "$BODY" "$PID" deleted)"

step "8b. per-person member (D-023): add -> auth as member -> roster -> revoke"
call POST "$T/trip/members" "$EDIT" '{"handle":"Scott"}'
{ [ "$CODE" = 200 ] && [ "$(jget "$BODY" handle)" = Scott ]; } && ok "add member -> 200 handle:Scott" || bad "add member expected 200/Scott, got $CODE ($BODY)"
MTOK="$(jget "$BODY" token)"; MID="$(jget "$BODY" id)"
call GET "$T/trip/state?since=0" "$MTOK"
{ [ "$CODE" = 200 ] && [ "$(jget "$BODY" access)" = edit ] && [ "$(jget "$BODY" me)" = Scott ]; } \
  && ok "member phrase -> 200 access:edit me:Scott" || bad "member auth expected 200/edit/me:Scott, got $CODE access=$(jget "$BODY" access) me=$(jget "$BODY" me)"
INROSTER="$(printf '%s' "$BODY" | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo in_array("Scott",$j["members"]??[],true)?"y":"n";')"
[ "$INROSTER" = y ] && ok "roster includes Scott" || bad "roster missing Scott"
ROSTERID="$(printf '%s' "$BODY" | php -r '$j=json_decode(stream_get_contents(STDIN),true);foreach($j["roster"]??[] as $m){if(($m["handle"]??"")==="Scott"){echo $m["id"];return;}}echo "";')"
[ -n "$ROSTERID" ] && [ "$ROSTERID" = "$MID" ] && ok "roster carries member id (revoke UI)" || bad "roster id mismatch: got '$ROSTERID' want '$MID'"
call DELETE "$T/trip/members/$MID" "$EDIT"
[ "$CODE" = 200 ] && ok "revoke member -> 200" || bad "revoke expected 200, got $CODE ($BODY)"
call GET "$T/trip/state?since=0" "$MTOK"
[ "$CODE" = 401 ] && ok "revoked member phrase -> 401" || bad "revoked member expected 401, got $CODE ($BODY)"

step "8c. D-085: export, and a sealed drop must not ride out in it"
# A sealed drop authored by somebody else. The edit phrase carries no member identity, so this
# is shut for the exporter — and an export is exactly the side door that skips the check the
# on-screen path enforces.
# THE FIXTURE IS ITSELF AN ASSERTION. Everything below about sealed content is of the form
# "this string is not present", which an empty archive satisfies perfectly. So prove the drop
# exists before trusting a single absence, and let the insert's error be SEEN rather than sent
# to /dev/null — a swallowed error here is indistinguishable from a product that works.
SEALED_FIXTURE=0
if [ -n "${MYSQL_CMD:-}" ]; then
  SEAL_ERR="$($MYSQL_CMD -e "INSERT INTO pins (id,slug,kind,lat,lng,title,notes,author,opened_by,seq,updated) VALUES ('pseal$$','$SLUG','sealed',40.1,-105.1,'SEALEDTITLEXYZ','SEALEDNOTESXYZ','Mel','[\\\"OPENEDBYXYZ\\\"]',9,1)" 2>&1)"
  SEAL_ROWS="$($MYSQL_CMD -N -e "SELECT COUNT(*) FROM pins WHERE id='pseal$$' AND slug='$SLUG'" 2>/dev/null | tr -d '[:space:]')"
  [ "$SEAL_ROWS" = "1" ] && SEALED_FIXTURE=1
fi
if [ "$SEALED_FIXTURE" = "1" ]; then
  ok "fixture: the sealed drop is in the database"
elif [ -z "${MYSQL_CMD:-}" ]; then
  skip "no MYSQL_CMD — the sealed-drop assertions cannot be trusted and are not run"
else
  bad "fixture insert FAILED, so every sealed assertion below would have passed vacuously: ${SEAL_ERR:-no error reported}"
fi
curl -s -o /tmp/exp.zip -w '%{http_code}' -H "Authorization: Bearer $EDIT" "$CONN$T/trip/export" > /tmp/expcode
[ "$(cat /tmp/expcode)" = "200" ] && ok "export with the edit phrase -> 200" || bad "export expected 200, got $(cat /tmp/expcode)"
[ "$(head -c2 /tmp/exp.zip)" = "PK" ] && ok "and it is a real zip" || bad "not a zip archive"
if command -v unzip >/dev/null 2>&1; then
  NAMES="$(unzip -Z1 /tmp/exp.zip 2>/dev/null | tr '\n' ' ')"
  case "$NAMES" in *trip.json*) ok "carries trip.json" ;; *) bad "no trip.json: $NAMES" ;; esac
  case "$NAMES" in *itinerary.html*) ok "carries a standalone itinerary.html" ;; *) bad "no itinerary.html" ;; esac
  BODY_ALL="$(unzip -p /tmp/exp.zip 2>/dev/null)"
  # Gated on the fixture: an absence only proves something was withheld if it was there to
  # withhold. Ungated, these two were green on any run where the insert did not happen.
  if [ "$SEALED_FIXTURE" = "1" ]; then
    printf '%s' "$BODY_ALL" | grep -q "SEALEDTITLEXYZ" && bad "A SEALED DROP TITLE IS IN THE EXPORT" \
      || ok "the sealed title is NOT in the archive"
    printf '%s' "$BODY_ALL" | grep -q "SEALEDNOTESXYZ" && bad "A SEALED DROP NOTE IS IN THE EXPORT" \
      || ok "the sealed notes are NOT in the archive"
  else
    skip "the sealed title is NOT in the archive (no fixture to withhold)"
    skip "the sealed notes are NOT in the archive (no fixture to withhold)"
  fi
  # Matches "not opened yet", NOT the noun in front of it. This assertion said "still shut" and
  # went red the day §2a renamed sealed drops to easter eggs across nine renderable strings —
  # including lib/export.php:218, which is what this line reads. The export was correct
  # throughout: it withheld the content AND said so. Only the wording moved.
  # So key on the part that is the POINT — that something exists and is not open — rather than
  # on whatever it is currently called, and the next copy pass cannot turn a passing product
  # into a failing suite.
  if [ "$SEALED_FIXTURE" = "1" ]; then
    printf '%s' "$BODY_ALL" | grep -q "not opened yet" && ok "and the itinerary says a drop was withheld, rather than hiding it" \
      || bad "sealed drop vanished silently instead of being acknowledged"
  else
    skip "and the itinerary says a drop was withheld (no fixture)"
  fi
fi
# S1: the content was blanked and the GUEST LIST was not — you could see who else had opened
# theirs. Withheld with the content now.
call GET "$T/trip/state" "$EDIT"
# Same gate as the archive assertions above, and for the same reason. The comment below already
# recorded that an earlier version of the opened_by check "gave a false PASS" by matching
# nothing — the fix then was to pick a string that appears nowhere else, which stops it matching
# the WRONG thing but does nothing about it matching NOTHING. That second half is what this gate
# closes.
if [ "$SEALED_FIXTURE" = "1" ]; then
  printf '%s' "$BODY" | grep -q 'SEALEDTITLEXYZ' && bad "sealed title is on the wire" || ok "sealed title withheld in state"
  printf '%s' "$BODY" | grep -q 'OPENEDBYXYZ' && bad "S1: opened_by leaks who has opened the drop" \
    || ok "S1: opened_by is withheld for a drop you have not opened"
  printf '%s' "$BODY" | grep -q '"author":"Mel"' && ok "but the author still shows — a drop from Dad is the point" \
    || bad "author should NOT be withheld"
else
  skip "sealed title withheld in state (no fixture)"
  skip "S1: opened_by is withheld for a drop you have not opened (no fixture)"
  skip "but the author still shows — a drop from Dad is the point (no fixture)"
fi

VCODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VIEW" "$CONN$T/trip/export")"
[ "$VCODE" = "403" ] && ok "a view link cannot export (403)" || bad "view export expected 403, got $VCODE"
NCODE="$(curl -s -o /dev/null -w '%{http_code}' "$CONN$T/trip/export")"
[ "$NCODE" = "401" ] && ok "and no phrase at all cannot either (401)" || bad "unauthenticated export expected 401, got $NCODE"

step "8d. The gate offers the account route (D-071 was unreachable from it)"
call GET "/$SLUG"
printf '%s' "$BODY" | grep -q 'gate-alt' && ok "the gate names signing in as a way through" \
  || bad "the gate still offers only a phrase"
printf '%s' "$BODY" | grep -q 'href="/account"' && ok "and links to /account" || bad "no /account link on the gate"

step "8e. D-091: claim-trip shares the gate limiter, and tells a stranger nothing"
# The same secret the front door checks, so it must cost the same to guess at.
call POST /api/account/signup "" '{"email":"claimprobe@example.com"}'
# a real trip, a wrong phrase, and a slug that does not exist must be indistinguishable
call POST /api/account/claim-trip "" "{\"slug\":\"$SLUG\",\"phrase\":\"not-a-real-phrase-at-all\"}"
A="$CODE"
call POST /api/account/claim-trip "" '{"slug":"zzzzzzz","phrase":"not-a-real-phrase-at-all"}'
B="$CODE"
# both should be 401 (not signed in) here — the point is they MATCH, never 404 vs 403
[ "$A" = "$B" ] && ok "a real slug and a nonexistent one answer identically ($A)" \
  || bad "slug existence is distinguishable: real=$A fake=$B"
if [ -n "${MYSQL_CMD:-}" ]; then
  # the limiter must be the trip's own gate counter, not a second one
  $MYSQL_CMD -e "DELETE FROM gate WHERE slug='$SLUG'" 2>/dev/null
  GATE0="$($MYSQL_CMD -N -e "SELECT COALESCE(SUM(hits),0) FROM gate WHERE slug='$SLUG'" 2>/dev/null)"
  ok "gate counter starts at $GATE0 for this trip"
fi

step "8f. D-093: the paid chat has a per-trip turn cap"
if [ -n "${MYSQL_CMD:-}" ]; then
  COL="$($MYSQL_CMD -N -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='trips' AND column_name='chat_turns'" 2>/dev/null)"
  [ "$COL" = "1" ] && ok "trips.chat_turns exists" || bad "chat_turns column missing"
  # burn the allowance without spending a single token, then confirm the endpoint refuses
  $MYSQL_CMD -e "UPDATE trips SET chat_turns=40 WHERE slug='$SLUG'" 2>/dev/null
  call POST "$T/trip/chat" "$EDIT" '{"messages":[{"role":"user","content":"add a stop"}]}'
  [ "$CODE" = "429" ] && ok "an exhausted trip -> 429 before any outbound call" \
    || bad "expected 429 at the cap, got $CODE ($BODY)"
  printf '%s' "$BODY" | grep -q "40" && ok "and the refusal names the allowance" || bad "refusal does not name the cap"
  # the counter must not move once the cap is refusing — the guard is before the increment
  N1="$($MYSQL_CMD -N -e "SELECT chat_turns FROM trips WHERE slug='$SLUG'" 2>/dev/null)"
  call POST "$T/trip/chat" "$EDIT" '{"messages":[{"role":"user","content":"again"}]}'
  N2="$($MYSQL_CMD -N -e "SELECT chat_turns FROM trips WHERE slug='$SLUG'" 2>/dev/null)"
  [ "$N1" = "$N2" ] && ok "a refused request does not burn a turn ($N1)" || bad "counter moved on a refusal: $N1 -> $N2"
  $MYSQL_CMD -e "UPDATE trips SET chat_turns=0 WHERE slug='$SLUG'" 2>/dev/null
fi

step "8e. D-172: read_kept_trip — a kept trip read through the MCP server itself"
# Drives the REAL stdio server against this local app (TTB_SITE), rather than reimplementing what
# it does. Both halves of the tool that can leak are checked here, because neither is visible to
# make check: sealing comes from lib/trip.php's seal_pin(), and the deleted filter is mine.
if ! command -v node >/dev/null 2>&1; then
  skip "read_kept_trip's happy path (no node on this machine)"
else
  kept_call(){   # $1 = link -> echoes the tool's text
    printf '%s\n' "$(php -r 'echo json_encode(["jsonrpc"=>"2.0","id"=>1,"method"=>"tools/call",
      "params"=>["name"=>"read_kept_trip","arguments"=>["link"=>$argv[1]]]]);' "$1")" \
    | TTB_SITE="$CONN" node mcp/thistripbtw-mcp.mjs \
    | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo $j["result"]["content"][0]["text"]??"(no reply)";'
  }
  KEPT="$(kept_call "$CONN/$SLUG#k=$EDIT")"
  printf '%s' "$KEPT" | grep -q "Could not read that" \
    && bad "read_kept_trip could not read a trip it just made: $(printf '%s' "$KEPT" | head -c 160)" \
    || ok "read_kept_trip reads a kept trip with the edit phrase"
  printf '%s' "$KEPT" | grep -q '"access": "edit"' \
    && ok "and reports the access level it was granted" || bad "no access level in the payload"
  # The two keys that are NOT itinerary and must never reach an agent: the offline-basemap token
  # (a map of where somebody is going) and the roster ids, which are what revoke takes.
  printf '%s' "$KEPT" | grep -qE '"tiles"|"roster"' \
    && bad "THE RAW STATE LEAKED — tiles or roster is in the tool's output" \
    || ok "neither the tiles token nor the roster rides out"

  # A wrong phrase must be refused, and must not be retried into somebody's guess budget.
  printf '%s' "$(kept_call "$CONN/$SLUG#k=not-the-phrase-at-all")" | grep -q "not it" \
    && ok "a wrong phrase is refused in the product's own voice" || bad "a wrong phrase was not refused cleanly"

  if [ "$SEALED_FIXTURE" = "1" ]; then
    printf '%s' "$KEPT" | grep -q "SEALEDTITLEXYZ" \
      && bad "A SEALED DROP TITLE CAME OUT OF read_kept_trip" || ok "the sealed title is NOT in the tool's output"
    printf '%s' "$KEPT" | grep -q "OPENEDBYXYZ" \
      && bad "THE SEALED DROP'S GUEST LIST CAME OUT OF read_kept_trip" || ok "nor is its guest list"
  else
    skip "the sealed title is NOT in read_kept_trip's output (no fixture to withhold)"
    skip "nor is its guest list (no fixture to withhold)"
  fi

  # The deleted filter. `trip/state` returns deletions as rows with deleted=1 so the polling client
  # can learn about them, and the first version of this tool listed them as real stops — the live
  # test passed anyway because that trip happened to have none. Same fixture discipline as 8c: an
  # absence proves nothing unless the row was there to be dropped.
  if [ -n "${MYSQL_CMD:-}" ]; then
    DEL_ERR="$($MYSQL_CMD -e "INSERT INTO pins (id,slug,kind,lat,lng,title,seq,updated,deleted) VALUES ('pdel$$','$SLUG','stop',41.5,-88.2,'DELETEDTITLEXYZ',11,1,1)" 2>&1)"
    if [ -z "$DEL_ERR" ]; then
      ok "fixture: a deleted pin is in the database"
      printf '%s' "$(kept_call "$CONN/$SLUG#k=$EDIT")" | grep -q "DELETEDTITLEXYZ" \
        && bad "A DELETED STOP IS IN THE ITINERARY" || ok "a deleted stop is NOT in read_kept_trip's output"
    else
      bad "deleted-pin fixture FAILED, so the assertion below would have passed vacuously: $DEL_ERR"
    fi
  else
    skip "a deleted stop is NOT in read_kept_trip's output (no MYSQL_CMD, no fixture)"
  fi
fi

step "9. D-088: photos from \$5 up, video only at \$10"
call POST "$T/trip/media?ext=jpg" "$EDIT" "fakejpegbytes" "image/jpeg"
[ "$CODE" = 402 ] && ok "photo on the \$2.50 plan tier -> 402" || bad "photo expected 402, got $CODE ($BODY)"
call POST "$T/trip/media?ext=mp4" "$EDIT" "fakevideobytes" "video/mp4"
[ "$CODE" = 402 ] && ok "video on the \$2.50 plan tier -> 402" || bad "video expected 402, got $CODE ($BODY)"

# A $5 "keep it" trip is the whole point of the split: it must TAKE a photo and REFUSE a video.
SID_K="cs_smoke_500_$$_$(date +%s)"
call POST /api/claim "" "{\"session_id\":\"$SID_K\",\"trip_name\":\"keep tier\"}"
KSLUG="$(jget "$BODY" slug)"; KEDIT="$(jget "$BODY" edit_token)"; KTIER="$(jget "$BODY" tier)"
[ "$KTIER" = "keep" ] && ok "a \$5 payment makes a keep-tier trip" || bad "expected tier=keep, got '$KTIER'"
if [ -n "$KSLUG" ]; then
  call POST "/$KSLUG/api/trip/media?ext=mp4" "$KEDIT" "fakevideobytes" "video/mp4"
  [ "$CODE" = 402 ] && ok "video on the \$5 keep tier -> 402" || bad "video on keep expected 402, got $CODE ($BODY)"
  printf '%s' "$BODY" | grep -q '\$10' && ok "and the refusal names the tier that takes video" || bad "refusal does not name the \$10 tier: $BODY"
  # the photo must NOT be refused for tier reasons — anything but 402 means the gate let it through
  call POST "/$KSLUG/api/trip/media?ext=jpg" "$KEDIT" "fakejpegbytes" "image/jpeg"
  KURL="$(jget "$BODY" url)"
  [ "$CODE" != "402" ] && ok "photo on the \$5 keep tier is allowed (got $CODE, not a tier refusal)" \
    || bad "photo on keep was refused as a tier problem: $BODY"
  # state must advertise both allowances separately
  call GET "/$KSLUG/api/trip/state" "$KEDIT"
  [ "$(jget "$BODY" photo)" = "true" ] && ok "state says photo=true on keep" || bad "state photo should be true"
  [ "$(jget "$BODY" video)" = "false" ] && ok "state says video=false on keep" || bad "state video should be false"
fi

step "9b. D-094: the aggregate media cap, counted from bytes actually written"
if [ -n "${MYSQL_CMD:-}" ] && [ -n "$KSLUG" ]; then
  # step 9 already put one 13-byte photo on this trip
  B1="$($MYSQL_CMD -N -e "SELECT media_bytes FROM trips WHERE slug='$KSLUG'" 2>/dev/null)"
  [ "$B1" = "13" ] && ok "the write was counted, in bytes actually written ($B1)" \
    || bad "expected media_bytes=13 after one 13-byte photo, got '$B1'"

  # a full trip refuses, and refuses before writing anything
  BEFORE="$(ls "${PHOTOS_DIR:-photos}/$KSLUG" 2>/dev/null | wc -l | tr -d ' ')"
  $MYSQL_CMD -e "UPDATE trips SET media_bytes=2147483648 WHERE slug='$KSLUG'" 2>/dev/null
  call POST "/$KSLUG/api/trip/media?ext=jpg" "$KEDIT" "morebytes" "image/jpeg"
  [ "$CODE" = "413" ] && ok "a full trip -> 413" || bad "expected 413 when full, got $CODE ($BODY)"
  printf '%s' "$BODY" | grep -q "2 GB" && ok "and the refusal names the allowance" || bad "refusal does not name the cap: $BODY"
  AFTER="$(ls "${PHOTOS_DIR:-photos}/$KSLUG" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$BEFORE" = "$AFTER" ] && ok "and no file was written ($AFTER)" || bad "a refused upload still wrote a file: $BEFORE -> $AFTER"

  # deleting media gives the space back, or "remove something first" is advice nobody can act on
  $MYSQL_CMD -e "UPDATE trips SET media_bytes=13 WHERE slug='$KSLUG'" 2>/dev/null
  call POST "/$KSLUG/api/trip/pins" "$KEDIT" "{\"kind\":\"post\",\"lat\":1,\"lng\":1,\"photo\":\"$KURL\"}"
  MPID="$(jget "$BODY" id)"          # the server assigns the id; it does not take the one you send
  call DELETE "/$KSLUG/api/trip/pins/$MPID" "$KEDIT"
  B2="$($MYSQL_CMD -N -e "SELECT media_bytes FROM trips WHERE slug='$KSLUG'" 2>/dev/null)"
  [ "$B2" = "0" ] && ok "deleting the photo returned its bytes ($B2)" || bad "expected media_bytes=0 after delete, got '$B2'"

  # and the counter can never go negative — a second delete, or a pre-D-094 file, must not underflow
  $MYSQL_CMD -e "UPDATE trips SET media_bytes=0 WHERE slug='$KSLUG'" 2>/dev/null
  B3="$($MYSQL_CMD -N -e "SELECT media_bytes >= 0 FROM trips WHERE slug='$KSLUG'" 2>/dev/null)"
  [ "$B3" = "1" ] && ok "the counter is floored at zero" || bad "media_bytes went negative"
fi

step "10. DELETE /{slug}/api/trip -> 200; any further call -> 401"
call DELETE "$T/trip" "$EDIT"
{ [ "$CODE" = 200 ] && [ "$(jget "$BODY" gone)" = true ]; } && ok "delete trip -> 200 gone:true" || bad "delete trip expected 200/gone, got $CODE ($BODY)"
call GET "$T/trip/state?since=0" "$EDIT"
[ "$CODE" = 401 ] && ok "post-delete call -> 401" || bad "post-delete expected 401, got $CODE ($BODY)"

printf '\n──────────────\n%s passed, %s failed%s\n' "$(grn "$PASS")" "$( [ "$FAIL" -gt 0 ] && red "$FAIL" || printf '%s' 0 )" \
  "$( [ "$SKIP" -gt 0 ] && printf ', %s skipped — NOT covered' "$(ylw "$SKIP")" || printf '' )"
[ "$FAIL" -eq 0 ]
