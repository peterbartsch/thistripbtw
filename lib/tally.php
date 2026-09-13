<?php
/* this trip, btw — two daily integers, and nothing else (D-187, MASTER_PLAN §6a).
 *
 * WHAT THIS IS. A count of how many times /new was loaded today, and how many times an agent read
 * a kept trip today. Two numbers a day. The audit of 2026-09-10 found the product could not tell
 * fifty uptime monitors from fifty people, and could not tell "the agent channel is slow" from "the
 * agent channel is zero" — and the second is the only number the whole thesis turns on.
 *
 * WHAT THIS IS NOT, stated so nobody widens it: no IP, no user agent, no path beyond the two named
 * here, no timestamp finer than the day, no cookie, no id, nothing joined to anything. It cannot
 * say who, or whether two hits were one person. /privacy says exactly this, in one sentence, and
 * CLAUDE.md's never-add list is unchanged by it. If you find yourself wanting a third field, you are
 * building the tracker the product exists not to have — stop and read PRODUCT_VISION.md §"Where the
 * tension is REAL".
 *
 * HOW. One file per day per kind under var/tally/, one byte appended per hit. Append is atomic on a
 * local filesystem and needs no lock; the count is the file's size. var/ is denied by .htaccess rule
 * 2, and the audit's guard.deny.* checks would say so if that stopped being true. */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

function tally_dir(): string { return dirname(__DIR__) . '/var/tally'; }

/** Record one hit of $kind ('new' or 'kept_read') for today, UTC. Never throws, never blocks. */
function tally(string $kind): void {
    if (!preg_match('/^[a-z_]{1,24}$/', $kind)) return;
    /* Our own harness is not a visitor. `make deploy` runs the whole flow suite against production
       after every ship, and each run loads /new about a dozen times at two phone heights — so on
       2026-09-11, nine deploys produced most of a day's 361 and the count answered "how often did
       we deploy" instead of "did anyone arrive". test/flow/cdp.mjs now sends this header on every
       request it makes.

       It records NOTHING new: the request is simply not counted. It reads one header and stores
       no part of it, so the what-this-is-not list above is unchanged. Anyone can send it, and the
       only effect of doing so is to go uncounted — an undercount, never a leak or a profile. That
       is the right failure direction for an instrument whose whole promise is restraint. */
    if (($_SERVER['HTTP_X_TTB_HARNESS'] ?? '') === '1') return;
    $d = tally_dir();
    if (!is_dir($d) && !@mkdir($d, 0775, true)) return;
    @file_put_contents($d . '/' . gmdate('Y-m-d') . '.' . $kind, '.', FILE_APPEND);
}

/** Yesterday's and today's counts, for the nightly audit's info line. */
function tally_read(string $kind, string $ymd): int {
    $f = tally_dir() . '/' . $ymd . '.' . $kind;
    return is_file($f) ? (int)filesize($f) : 0;
}
