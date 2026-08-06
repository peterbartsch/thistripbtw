<?php
/* this trip, btw — the one notice before a trip lapses (D-098).
 *
 * MASTER_PLAN §6c set the shape before the code: "One email to someone who paid, before their
 * trip lapses, is honest. Two is a campaign. The difference is a decision, not an implementation
 * detail, and the product was explicitly built against the second thing."
 *
 * So the whole design problem here is ONCE. The sweep runs daily and the window is fourteen days
 * wide; the naive version sends fourteen emails and turns a courtesy into exactly the thing this
 * product exists in opposition to. Everything below is about making that impossible:
 *
 *   · `trips.expiry_notified` is claimed with a CONDITIONAL UPDATE before anything is sent, so two
 *     concurrent runs cannot both win the row. The gate limiter uses MySQL's atomicity for the
 *     same reason; a read-then-write here would have the same defect D-091 measured in var/.
 *   · A send that FAILS releases the claim, so a relay outage retries tomorrow rather than
 *     swallowing the only notice a customer gets. A send that SUCCEEDS keeps it forever.
 *   · Trips that have already lapsed are excluded. The same cron run deletes them, and "your trip
 *     ends in -3 days" is worse than silence.
 *
 * Who gets it: the BUYER, and only the buyer. `account_trips.role='owner'` is the one link from a
 * trip to an address. Members have no email stored at all (D-036) and viewers have nothing, so
 * there is nobody else to reach and nothing to decide. A trip claimed without an email — which is
 * allowed, and smoke.sh asserts it — has no owner row and is silently skipped. That is correct:
 * they were never asked for an address, so we do not have one to surprise them at.
 *
 * Kept out of the cron script and behind an injectable sender so the selection logic can be
 * tested against a real database without standing up SMTP. CLAUDE.md: prefer a calculation you
 * can check to an interaction you have to stage.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

/* Fourteen days: long enough to notice and act on, short enough that it is still true when they
   read it. Every tier is at least a year, so no term is shorter than the window. */
const EXPIRY_NOTICE_DAYS = 14;
/* A photo-less zip is a few KB; this is a backstop against a trip with an implausible number of
   notes, not a real limit. Past it the notice still goes — without the attachment, and saying so. */
const EXPIRY_ATTACH_MAX = 4194304;   // 4 MB

/** Trips lapsing within the window, with a buyer to tell, that we have not told yet. */
function expiry_due(int $now): array {
    return q_all(
        'SELECT t.slug, t.name, t.expires, a.email
           FROM trips t
           JOIN account_trips at ON at.slug = t.slug AND at.role = \'owner\'
           JOIN accounts a       ON a.id = at.account_id
          WHERE t.expires IS NOT NULL
            AND t.expiry_notified IS NULL
            AND t.expires >  ?
            AND t.expires <= ?
          ORDER BY t.expires ASC',
        [$now, $now + EXPIRY_NOTICE_DAYS * 86400000]);
}

/** The message. Split out so a test can read it without sending anything. */
function expiry_message(array $row, int $now, bool $attached = false): array {
    $slug  = (string)$row['slug'];
    $name  = trim((string)($row['name'] ?? ''));
    $when  = gmdate('j F Y', (int)($row['expires'] / 1000));
    $days  = (int)max(1, round(((int)$row['expires'] - $now) / 86400000));
    $url   = 'https://' . APEX . '/' . $slug;

    $subject = 'Your trip ends on ' . $when . ' — ' . APEX . '/' . $slug;

    /* Says the date, says what happens, says the one thing they can do, and says this is the only
       email. No renewal is offered because none exists — inventing a "keep it going" line for a
       button that is not there would be the first dishonest sentence this product has sent. */
    $text =
      ($name !== '' ? "Your trip \"$name\" ends on $when" : "Your trip ends on $when")
        . ", in $days days.\n\n" .
      "$url\n\n" .
      "On that date it deletes itself — the stops, the notes, the photos, all of it. That is the " .
      "term that was bought, and we are not going to quietly keep a copy of it instead.\n\n" .
      ($attached
        ? "A copy is attached to this email. Open the zip and there is a page you can read with no " .
          "internet, and the data behind it. It needs nothing from us, now or later.\n\n" .
          "The photos are not in it — they would make this too big to send. They are in the full " .
          "download until the date above: open the trip, then Info → Trip settings → Download a copy.\n\n"
        : "If you want to keep it, download it before then. Open the trip, then Info → Trip settings " .
          "→ Download a copy. You get a zip with the whole trip in it: the data, a readable page that " .
          "opens with no internet, and your photos at the size you uploaded them. It needs nothing " .
          "from us afterwards.\n\n") .
      "If you have lost the phrases, sign in at https://" . APEX . "/account with this address — " .
      "the trip is on your account.\n\n" .
      "There is no renew button, and this is the only email you will get about it.\n";

    return ['subject' => $subject, 'text' => $text];
}

/**
 * Notify everything due. Returns [sent, skipped, failed].
 *
 * $send is (email, subject, text) => bool, so a test can count messages instead of sending them.
 * Defaults to the real mailer.
 */
function expiry_notify(int $now, ?callable $send = null): array {
    if ($send === null) {
        require_once __DIR__ . '/mail.php';
        require_once __DIR__ . '/export.php';
        $send = function ($to, $subject, $text, $attach = null) {
            return send_mail($to, $subject, $text, 'expiry', null, $attach);
        };
    }
    $sent = 0; $skipped = 0; $failed = 0;

    foreach (expiry_due($now) as $row) {
        /* Claim it FIRST, and only if nobody else has. The WHERE ... IS NULL is the whole
           once-only guarantee; without it two overlapping cron runs each send a copy. */
        $st = q('UPDATE trips SET expiry_notified = ? WHERE slug = ? AND expiry_notified IS NULL',
                [$now, $row['slug']]);
        if ($st->rowCount() === 0) { $skipped++; continue; }

        /* D-109: attach the trip, so the notice IS the keeping rather than an instruction to go
           and keep it. Photos are left out — a `works` trip can hold 2 GB and no mail system will
           take that; the readable page and the data are what must survive, and the full download
           is still there until the day it goes.
           Built per-trip, and a failure here must never stop the notice: the mail is the promise,
           the zip is the courtesy. */
        $zip = null; $tmp = null;
        try {
            if (function_exists('export_build')) {
                $trip = q_first('SELECT * FROM trips WHERE slug=?', [$row['slug']]);
                if ($trip) {
                    /* $who = '' ON PURPOSE. seal_pin() withholds a sealed drop unless the
                       reader is the person it was left for, and a mailed copy has no reader to
                       check — an inbox is a less protected place than a signed-in session. So a
                       drop left for someone else stays shut here, exactly as D-047 requires,
                       and the itinerary says so where one is missing. */
                    $tmp = export_build((string)$row['slug'], $trip, '', false);
                    if ($tmp && is_file($tmp) && filesize($tmp) > 0 && filesize($tmp) <= EXPIRY_ATTACH_MAX) {
                        $base = preg_replace('/[^A-Za-z0-9]+/', '-', (string)($trip['name'] ?: 'trip'));
                        $zip = ['name' => trim($base, '-') . '.zip', 'path' => $tmp,
                                'type' => 'application/zip'];
                    }
                }
            }
        } catch (\Throwable $e) { $zip = null; }

        $m = expiry_message($row, $now, $zip !== null);
        $okSent = $send((string)$row['email'], $m['subject'], $m['text'], $zip);
        if ($tmp && is_file($tmp)) @unlink($tmp);
        if ($okSent) {
            $sent++;
        } else {
            /* Release, so a relay outage costs a day rather than the only notice they get. */
            q('UPDATE trips SET expiry_notified = NULL WHERE slug = ?', [$row['slug']]);
            $failed++;
        }
    }
    return [$sent, $skipped, $failed];
}
