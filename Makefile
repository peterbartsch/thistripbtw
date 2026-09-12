# this trip, btw — common tasks. `make` or `make help` lists them.
.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

check: check-js check-decls check-css check-php check-secrets check-stripe check-links check-copy check-delete check-sitemap check-tokens check-mcp-version check-wellknown test-tools test-mcp ## All static checks (what CI runs)

check-mcp-version: ## Fail if the MCP version disagrees across package.json, serverInfo and server.json
	@node test/mcp-version.mjs

check-wellknown: ## Fail if /.well-known/mcp.json has drifted from mcp/server.json
	@node test/wellknown-drift.mjs

check-tokens: ## Fail if tokens.css or the Figma primitives drift from design/tokens.json
	@node test/token-drift.mjs

flow: ## Run the user flows in Chrome at both phone heights and write a findings report
	@node test/flow/run.mjs $(ARGS)

flow-diff: ## Fail only on a finding that is NEW against test/flow/baseline.json (§2bu)
	@node test/flow/diff.mjs

flow-baseline: ## Accept the newest run as the baseline — DELIBERATE, read the findings first
	@node scripts/flow-baseline.mjs

check-css: ## Fail on a stray */ in inline CSS — it silently discards every rule after it
	@./scripts/check-css.sh

check-decls: ## Fail if a client page uses a canary identifier it no longer declares
	@./scripts/check-decls.sh

check-sitemap: ## Fail if a sitemap <lastmod> no longer matches the file's commit date
	@php scripts/sitemap-lastmod.php --check

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

check-links: ## Fail if the payment links in new.html and api.php have drifted apart
	@php test/stripe-links.php

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
	@# 2026-08-02 (D-095): the ACCOUNT claim is PROMOTED out of the advisory list and now
	@#     GATES. CLAUDE.md had said it did for two days while it did not — verified by
	@#     putting "No account required" in the hero and watching the target exit 0.
	@#     WHAT MADE THE PROMOTION SAFE was not a better regex, it was fixing five lines of
	@#     copy. The old exclusion demanded the scope ATTACHED ("no account to build"), and
	@#     honest copy overwhelmingly puts scope FIRST ("Building a trip is free — no
	@#     account, no card, no email"), so gating it as written would have failed the build
	@#     on thirteen true sentences. The new exclusion accepts a scope word ANYWHERE on the
	@#     line; the five lines that had none — two on for-agents, one on what-you-get, one
	@#     in llms.txt, one comment in new.html — were reworded to name their path, which is
	@#     what D-086 asks for anyway. Deliberately looser than the claim: a bare "No account
	@#     required." on a line that also says "open" survives. That is the right error for a
	@#     GATE, where a false positive blocks honest copy and a false negative leaves us no
	@#     worse than the advisory list we had.
	@# 2026-08-02 (D-096): PERMANENCE promoted the same way, and CLAUDE.md was wrong about it
	@#     identically — it said the build failed on "permanent" while the claim only printed.
	@#     This one needed NO copy fixes: the tree was already clean, which is the ideal
	@#     moment to install a gate. What it needed instead was WIDER matching, because
	@#     D-059's claim is not the word "permanent" — it is the promise that a trip outlives
	@#     its term, and that promise says "yours forever", "never expires", "for life",
	@#     "keep it forever", "lasts forever" too. Every one of those has no true form: every
	@#     tier ends, at one year, five or ten.
	@#     THE FALSE POSITIVES ARE THE CORRECTIONS THEMSELVES. "Nothing is sold as permanent
	@#     — a one-person shop cannot honestly promise forever" is the right copy and says
	@#     both words; faq.html's whole paragraph explains why we stopped. So the exclusion
	@#     matches the RETRACTION verbs, not the words. Naively widening to bare "forever" /
	@#     "for good" was tried and rejected: it hit four JS comments, a delete-button promise
	@#     ("removes the trip and every photo, for good" — the OPPOSITE claim) and both
	@#     corrections. Verified eight claim phrasings caught, five true lines passed.
	@# 2026-08-02 (D-097): the never-ask / never-collect claims (D-036/D-067) promoted last.
	@#     TENSE is their test rather than scope, and the regex does it almost for free: \b on
	@#     a present-tense verb cannot match its own past. `\bask\b` passes "we never ASKED
	@#     who you are", which what-you-get.html:74 says truthfully about the pre-purchase
	@#     draft and which an earlier version of this rule failed on.
	@#     FOUR LINES HAD TO CHANGE, and two of them were live false claims, not phrasing:
	@#     privacy.html's Stripe row said "Stripe knows the buyer; we genuinely don't" ELEVEN
	@#     LINES BELOW the paragraph saying we make an account from the email Stripe collected.
	@#     Checked against api.php: we read customer_details.email and nothing else, so the row
	@#     now says we receive the address and never see the card, billing address or name.
	@#     faq.html said "the only personal thing we hold is the email you paid with", which
	@#     D-076 made incomplete the day open signup shipped — an account no longer implies a
	@#     purchase. The other two were source comments about the mailto share, true of that
	@#     feature and unreadable as such on one line; both now name it.
	@#     NOTHING IS ADVISORY ANY MORE. All three claim families gate.
	@# design/ joined the scan 2026-08-05. The design system is the REFERENCE other work is
	@# built from, and it was carrying five retired claims — "permanent" x3 and "forever" x2
	@# on the tier table, plus an unscoped "no account needed" — long after D-059/D-095/D-096
	@# retired them and while the live pages said one year, five and ten. A guard that skips
	@# the document people copy FROM lets the wrong copy back in through the front door.
	@DIRS="public/"; [ -d mcp ] && DIRS="$$DIRS mcp/"; [ -d design ] && DIRS="$$DIRS design/"; \
	  INC="--include=*.html --include=*.txt --include=*.md"; \
	  ACCT=$$(grep -rniE 'no ?accounts?\b|no sign-?ups?\b|nothing to sign up|without signing up' \
	     $$DIRS $$INC \
	     | grep -viE 'build|start|open|view|look|shar|send|join|sign up for something|no accounts? yet'); \
	  PERM=$$(grep -rniE '(is|are|it.s|its) permanent|permanently yours|permanent (address|trip|link)|yours forever|keeps? it forever|keep it forever|lasts? forever|last forever|never expires?|no expiry date|for life\b|one payment,? forever' \
	     $$DIRS $$INC \
	     | grep -viE 'nothing is sold as|stopped selling|cannot honestly|promise it c|promising to host|no longer sold|never sold as'); \
	  PRIV=$$(grep -rniE '(never|do ?n.t|does ?n.t)( even)? (ask|asks|know|knows)\b[^.]{0,24}(who you are|your name)|(never|do ?n.t|does ?n.t)( even)? (see|sees|collect|collects|store|stores|keep|keeps|hold|holds)\b[^.]{0,30}(e-?mails?|addresse?s?|names?)' \
	     $$DIRS $$INC \
	     | grep -viE 'building|to build|before you (pay|buy)|draft|never make an account|card number|billing|own mail client'); \
	  HARD=$$(grep -rniE 'no signup step|no sign-?up step|only possible after buying|sign-?in link|magic ?link' \
	     $$DIRS $$INC); \
	  if [ -n "$$PRIV" ]; then \
	    echo "FAIL: present-tense never-ask / never-collect claim (D-036/D-067) — buying makes"; \
	    echo "      an account from your email and D-076 lets anyone make one. Past tense about"; \
	    echo "      the pre-purchase draft is true and passes; a standing promise is not:"; \
	    printf '%s\n' "$$PRIV"; exit 1; \
	  fi; \
	  if [ -n "$$PERM" ]; then \
	    echo "FAIL: permanence claim with no true form (D-059) — every tier ends, at one year,"; \
	    echo "      five or ten. Say the term, or say nothing is sold as permanent:"; \
	    printf '%s\n' "$$PERM"; exit 1; \
	  fi; \
	  if [ -n "$$ACCT" ]; then \
	    echo "FAIL: account claim with no path named (D-086) — say which path it is true for,"; \
	    echo "      e.g. \"no account to build one\" / \"no account to open it\":"; \
	    printf '%s\n' "$$ACCT"; exit 1; \
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
	@php test/chat-rate-test.php
	@php test/pace-test.php
	@php test/gzip-test.php
	@php test/geo-cache-test.php
	@node test/replay-tz-test.mjs
	@node test/pickplace-test.mjs
	@node test/exif-gps-test.mjs
	@# TZ is load-bearing: the bug this guards against only appears west of Greenwich.
	@TZ=America/Los_Angeles node test/dochead-test.mjs
	@php test/tutorial-code-test.php
	@node test/import-export-test.mjs
	@node test/paste-test.mjs
	@TZ=America/Los_Angeles node test/ics-test.mjs
	@node test/geo-import-test.mjs
	@node test/places-iata-test.mjs
	@node test/skill-parity.mjs
	@node test/ring-test.mjs
	@node test/outbox-test.mjs
	@node test/post-arrival-test.mjs
	@node test/route-poly-test.mjs
	@node test/esc-test.mjs
	@php test/export-read-parity.php
	@php test/export-map-test.php

test: ## Run the smoke tests against local PHP+MySQL
	@bash test/smoke.sh

deploy: check ## Static checks, ship to the VPS, then run the flow guard against what just shipped
	@bash scripts/deploy.sh
	@echo ""
	@echo "── post-deploy guard — the site is LIVE; this says whether it regressed ──"
	@echo "   (a few minutes. SKIP_GUARD=1 make deploy to skip, and say so if you do.)"
ifndef SKIP_GUARD
	@$(MAKE) --no-print-directory flow >/dev/null 2>&1 || true
	@$(MAKE) --no-print-directory flow-diff || ( 	  echo ""; 	  echo "⚠ THE FINDINGS ABOVE ARE ON THE LIVE SITE, NOT ON A BRANCH."; 	  echo "  Fix forward or revert. Do not baseline them to make this quiet —"; 	  echo "  make flow-baseline is a person's decision and it means 'this is acceptable'."; 	  exit 1 )
endif

serve: ## Local PHP server on :8080
	@php -S 127.0.0.1:8080 index.php


.PHONY: help check check-links check-js check-php check-secrets check-stripe check-copy check-delete test-tools test-mcp test deploy serve

# The service worker's behaviour, which no other guard can see: `make check` is node --check
# (syntax, never references) and the suite never executes app.html's inline script. Needs the
# network and a deployed worker, so it is NOT part of `make check` — run it after a deploy that
# touches sw.js, index.php's /sw route, or the shell asset list.
.PHONY: offline
offline:
	@node test/offline-check.mjs

# §2bl — the interaction counts behind "dead simple to create/edit a trip". Needs the LOCAL stack
# (`make serve` on :8080) because a real EDIT needs a real edit phrase and production's demo link
# is a view key. Counts are LOWER BOUNDS: the harness knows where every control is.
.PHONY: friction
friction:
	@node test/friction.mjs
