# this trip, btw — common tasks. `make` or `make help` lists them.
.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

check: check-js check-php check-secrets check-stripe check-copy check-delete test-tools test-mcp ## All static checks (what CI runs)

check-js: ## Syntax-check inline <script> in public/*.html
	@./scripts/check-inline-js.sh

check-php: ## Syntax-check every PHP file
	@ERR=0; for f in $$(find . -name '*.php' -not -path './vendor/*' -not -path './reference/*'); do \
	  php -l "$$f" >/dev/null 2>&1 || { echo "✗ $$f"; ERR=1; }; done; \
	  [ $$ERR -eq 0 ] && echo "✓ PHP clean" || exit 1

check-secrets: ## Fail if key material is tracked
	@# This scanned for live keys only, so `.env.bak.1785374086` — a whole env file
	@# with DB_PASS and a test Stripe key — was committed and pushed on 2026-07-29
	@# with a green check. Three rules now, because the file, not the key pattern,
	@# is the thing that gets committed by accident.
	@! git grep -nE '(sk|rk)_(live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' -- . ':!Makefile' ':!.github' \
	  && echo "✓ no key material"
	@# An env file is never tracked. `.env.example` is the one template, values empty.
	@BAD=$$(git ls-files | grep -E '(^|/)\.env' | grep -v '^\.env\.example$$'); \
	  [ -z "$$BAD" ] && echo "✓ no env file tracked" || { echo "✗ env file tracked: $$BAD"; exit 1; }
	@# A secret name assigned a literal. Two things are deliberately not findings:
	@# `$$VAR` references (how test/run-local.sh passes them through) and an obvious
	@# placeholder (`sk_test_dummy`, which that same script writes into a temp .env).
	@# The pipeline's own exit status is the finding — no leading `!`, or it cancels
	@# against the inner `! grep` and the rule inverts.
	@git grep -nE '^(DB_PASS|STRIPE_SECRET|SMTP_PASS|ANTHROPIC_API_KEY|AERODATABOX_KEY)=[^$$[:space:]]' -- . ':!Makefile' ':!.env.example' \
	  | grep -vE '=(sk_test_)?(dummy|example|changeme|placeholder|…|\.\.\.)$$' \
	  | ( ! grep . ) && echo "✓ no secret assigned a literal"

check-stripe: ## Fail if a test-mode payment link is shipped to customers
	@# The Stripe live flip updated index.html and missed new.html, so the promoted default
	@# path sent every buyer to a test checkout that rejects real cards. Nothing caught it for
	@# a day. A test_ link in public/ is never right in a deployable tree.
	@! grep -rn 'buy\.stripe\.com/test_' public/ \
	  && echo "✓ no test-mode payment links"

check-copy: ## Fail if a retired claim is shipped to customers or to agents
	@# D-059 ended "permanent" and CLAUDE.md retired "no accounts", and both survived for a
	@# day on llms.txt and mcp/README.md - the two surfaces an assistant quotes verbatim, so a
	@# wrong claim there propagates into answers we never see. Matches the CLAIM, not the word:
	@# "nothing is sold as permanent" is the correction and must keep passing.
	@# `mcp/` is absent from the site's public tree — the MCP server is its own repo — so
	@# the directory list is built rather than hardcoded. One Makefile serves both trees.
	@# 2026-07-30: this guard matched the exact strings that were wrong when it was written,
	@# so two false privacy claims sat live for days - mission.html "we don't even ask who you
	@# are" and faq.html "we don't even collect names or emails", both retired by D-036/D-067.
	@# Match the CLAIM, in every phrasing it can take, not the sentence that happened to carry
	@# it. TENSE IS THE TEST, and it is load-bearing: present tense ("we never ASK who you
	@# are") is a standing promise and is false. Past tense ("we never ASKED who you are") is
	@# what-you-get.html:70 describing the pre-purchase draft, where it is true and must keep
	@# passing - a first version of this rule failed on exactly that line. Imperfect and
	@# deliberately so: a false negative here is a missed claim, a false positive blocks the
	@# build on honest copy.
	@# 2026-08-01 (D-086): third repeat of the same miss. This matched `no accounts` and
	@# `no account needed` while the live homepage said `no account,` and `nothing to sign
	@# up for` — the sentence that happened to carry the claim, not the claim. The account
	@# half now matches every phrasing and then SUBTRACTS the scoped forms, which D-086
	@# permits ("no sign-up to build"). Two stages because POSIX ERE has no lookahead and
	@# macOS grep has no -P. SCOPE IS THE TEST here, the way TENSE is the test above.
	@# Two lists, because they fail differently — and only one of them may stop a build.
	@# (1) SCOPED, ADVISORY: the account claim is TRUE of building and viewing, so it may be
	@#     written when it names that path. No regex can judge scope: about.html's "without
	@#     signing up for something that wanted our data" is about OTHER products and is a
	@#     false positive no pattern will ever fix. Tuning it quiet is what produced three
	@#     misses in a row. So it PRINTS and does not gate — a lead to read, not a verdict.
	@#     The exclusion requires the scope word ATTACHED to the claim ("no sign-up to
	@#     build"), not merely present on the line: "nothing to install · nothing to sign
	@#     up for" was silently discounted because `to install` sat elsewhere in it, which
	@#     hid the last unscoped claim on /new. It over-lists on purpose — subject-first
	@#     scope ("Building a trip asks nothing of you — no account") still shows up, and
	@#     on an advisory list one line to re-read beats one claim never seen.
	@# (2) HARD: assertions with no true form today. "no signup step" and "only possible
	@#     after buying" were both retired by D-076 the day it shipped; a "sign-in link"
	@#     has never existed — account/reset-request + account/reset require SETTING a
	@#     password, which CLAUDE.md warns is not a magic link. No scope makes these true.
	@DIRS="public/"; [ -d mcp ] && DIRS="$$DIRS mcp/"; \
	  INC="--include=*.html --include=*.txt --include=*.md"; \
	  SCOPED=$$(grep -rniE '(is|are|its|a|an) permanent|permanently yours|permanent address|no ?accounts?\b|no sign-?ups?\b|nothing to sign up|without signing up|(never|do ?n.t)( even)? ask who you are|(do ?n.t|never)( even)? (collect|store|keep|hold)[^.]{0,24}emails?\b' \
	     $$DIRS $$INC \
	     | grep -viE '(no ?accounts?|no sign-?ups?|nothing to sign up) to (build|start|open|install|join)|nothing is sold as|signing up for something'); \
	  HARD=$$(grep -rniE 'no signup step|no sign-?up step|only possible after buying|sign-?in link|magic ?link' \
	     $$DIRS $$INC); \
	  if [ -n "$$SCOPED" ]; then \
	    echo "note: unscoped account/permanence claim — read it, it may be fine:"; \
	    printf '%s\n' "$$SCOPED"; \
	  fi; \
	  if [ -n "$$HARD" ]; then \
	    echo "FAIL: claim with no true form (D-076, or a sign-in link that does not exist):"; \
	    printf '%s\n' "$$HARD"; exit 1; \
	  fi; \
	  echo "✓ no claim without a true form"

check-delete: ## Fail if a slug-keyed table is missing from delete_trip()
	@# delete_trip() already carried a comment saying "adding a slug-keyed table without adding
	@# it here is how that happens again" - and account_trips was added later and missed anyway,
	@# for three days. The comment was right and still did not work, because nothing checked it.
	@# "Delete everything" is a promise on help.html and in the README; this is what keeps it
	@# true when the next slug-keyed table lands.
	@php -r '$$sch = file_get_contents("schema.mysql.sql"); \
	  preg_match_all("/CREATE TABLE (\w+)\s*\((.*?)\n\)/s", $$sch, $$m, PREG_SET_ORDER); \
	  $$api = file_get_contents("api.php"); \
	  $$fn = substr($$api, strpos($$api, "function delete_trip")); \
	  $$fn = substr($$fn, 0, strpos($$fn, "catch (\\Throwable")); \
	  $$bad = []; \
	  foreach ($$m as $$t) { if (!preg_match("/^\s*slug\s/m", $$t[2])) continue; \
	    if (!preg_match("/DELETE FROM " . $$t[1] . "\b/", $$fn)) $$bad[] = $$t[1]; } \
	  if ($$bad) { fwrite(STDERR, "✗ slug-keyed table(s) missing from delete_trip(): " . implode(", ", $$bad) . "\n"); exit(1); } \
	  echo "✓ delete_trip covers every slug-keyed table\n";'

test-mcp: ## Self-test the MCP server (no deps, no network)
	@# Skips in the site's public tree, where mcp/ lives in its own repo. A skip says so
	@# out loud: a silently-passing check that ran nothing is worse than a failing one.
	@if [ -f mcp/thistripbtw-mcp.mjs ]; then node mcp/thistripbtw-mcp.mjs --selftest | tail -1; \
	  else echo "· mcp/ not in this tree (own repo) — test-mcp skipped"; fi

test-tools: ## Unit-test the chat-agent tool adapter (no DB, no network)
	@php test/tools-test.php
	@php test/mcp-parity.php
	@php test/structured-test.php
	@php test/mail-header-test.php
	@node test/replay-tz-test.mjs

test: ## Run the smoke tests against local PHP+MySQL
	@bash test/smoke.sh

deploy: check ## Static checks, then ship to the DreamHost VPS
	@bash scripts/deploy.sh

serve: ## Local PHP server on :8080
	@php -S 127.0.0.1:8080 index.php

.PHONY: help check check-js check-php check-secrets check-stripe check-copy check-delete test-tools test-mcp test deploy serve
