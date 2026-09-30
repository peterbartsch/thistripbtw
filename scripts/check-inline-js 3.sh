#!/usr/bin/env bash
# Syntax-check the inline <script> in every public/*.html.
#
# The client is deliberately framework-free single-file HTML (CLAUDE.md), so there is no
# bundler and nothing else ever parses this JS before a browser does. Three separate
# deploys have shipped a page whose script died on load — an unbalanced tag, and a const
# read before its initialiser. Both were a parse away from being caught. This is that parse.
set -u
fail=0
for f in public/*.html; do
  python3 - "$f" > /tmp/_inline.js <<'PY'
import re,sys
h=open(sys.argv[1],encoding="utf-8").read()
# inline blocks only: anything with src= is fetched, not embedded
# A data block is not JavaScript. application/ld+json (D-082) is JSON, and feeding it to
# node --check fails on a page that is perfectly fine — which took a deploy down. Skip any
# script carrying a type that is not JavaScript, rather than naming ld+json alone.
for m in re.finditer(r'<script(?![^>]*\bsrc=)((?:(?!>).)*)>(.*?)</script>', h, re.S|re.I):
    attrs = m.group(1) or ''
    t = re.search(r'\btype\s*=\s*["\']([^"\']+)["\']', attrs, re.I)
    if t and t.group(1).strip().lower() not in ('text/javascript', 'module', 'application/javascript'):
        continue
    print(m.group(2))
PY
  [ -s /tmp/_inline.js ] || { echo "− $f (no inline js)"; continue; }
  if ! node --check /tmp/_inline.js 2>/tmp/_inline.err; then
    echo "✗ $f"; head -6 /tmp/_inline.err | sed 's/^/    /'; fail=1
  else
    echo "✓ $f"
  fi
done
rm -f /tmp/_inline.js /tmp/_inline.err
[ $fail -eq 0 ] || { echo "inline JS has syntax errors — not deployable"; exit 1; }
echo "all inline JS parses"
