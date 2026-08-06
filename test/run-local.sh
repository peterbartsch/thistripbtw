#!/usr/bin/env bash
# this trip, btw — boot the app locally and run the API smoke test.
# Wires up: the Stripe mock, a temp .env, and `php -S` serving index.php,
# then runs test/smoke.sh and tears everything down.
#
# Prereqs: php CLI + a reachable MySQL that already has schema.mysql.sql applied.
# Point it at your MySQL via env (defaults shown):
#   DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=ttb_main DB_USER=root DB_PASS=
#   APP_PORT=8080 MOCK_PORT=4242
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

DB_HOST="${DB_HOST:-127.0.0.1}"; DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-ttb_main}";  DB_USER="${DB_USER:-root}"; DB_PASS="${DB_PASS:-}"
APP_PORT="${APP_PORT:-8080}";    MOCK_PORT="${MOCK_PORT:-4242}"
MYSQL_BIN="${MYSQL_BIN:-mysql}"; PHP_BIN="${PHP_BIN:-php}"

# temp .env for the run — back up any real one and restore on exit
ENVBAK=""
if [ -f .env ]; then ENVBAK=".env.testbak.$$"; mv .env "$ENVBAK"; fi
cat > .env <<EOF
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
APEX=localhost
STRIPE_SECRET=sk_test_dummy
STRIPE_API_BASE=http://127.0.0.1:$MOCK_PORT
EOF

PIDS=()
cleanup(){
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -f .env
  [ -n "$ENVBAK" ] && mv "$ENVBAK" .env
}
trap cleanup EXIT

"$PHP_BIN" -S 127.0.0.1:"$MOCK_PORT" test/mock-stripe.php >/dev/null 2>&1 & PIDS+=($!)
"$PHP_BIN" -S 127.0.0.1:"$APP_PORT"  index.php           >/dev/null 2>&1 & PIDS+=($!)

# wait for the app to answer
for _ in $(seq 1 30); do curl -s "http://127.0.0.1:$APP_PORT/" >/dev/null 2>&1 && break; sleep 0.3; done

MYSQL_CMD="$MYSQL_BIN --protocol=tcp -u $DB_USER"
[ -n "$DB_PASS" ] && MYSQL_CMD="$MYSQL_CMD -p$DB_PASS"
MYSQL_CMD="$MYSQL_CMD -h $DB_HOST -P $DB_PORT $DB_NAME"

BASE_URL="http://127.0.0.1:$APP_PORT" APEX_HOST="localhost" MYSQL_CMD="$MYSQL_CMD" \
  bash test/smoke.sh
RC=$?

# D-098: needs the same database and none of the HTTP surface, so it rides along here rather
# than in test-tools, which is deliberately DB-free.
echo
echo "expiry notice (D-098)"
"$PHP_BIN" test/expiry-test.php || RC=1
exit $RC
