<?php
/* Phase A acceptance harness (HANDOFF_ACCOUNTS_BUILD §3A).
   Sends ONE plain-text message from the VPS so deliverability can be scored.

   Usage on the server:
     cd ~/thistripbtw.us && php scripts/mailtest.php <address>

   To score it: get a fresh address from https://www.mail-tester.com, send to it,
   then reload that page. Target is >= 9/10. Also send to a real Gmail, Outlook and
   iCloud account and confirm it lands in the INBOX, not spam.

   Prints nothing sensitive; the address is echoed back only to this terminal so you
   know where it went. It is never written to any log. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }
define('SECURE_ACCESS', true);
require_once __DIR__ . '/../lib/mail.php';

$to = $argv[1] ?? '';
if ($to === '') { fwrite(STDERR, "usage: php scripts/mailtest.php <address>\n"); exit(1); }

$apex = env('APEX', 'thistripbtw.us');
$subject = 'Your sign-in link for this trip, btw';   // shaped like the real thing, so the score is honest
$text = <<<TXT
Here's your sign-in link:

https://{$apex}/login?t=deliverability-test-not-a-real-token

It works once and expires in 15 minutes. If you didn't ask for it, you can ignore
this — nothing happens until the link is opened.

—
this trip, btw
{$apex}
TXT;

echo "From:    " . mail_from() . "\n";
echo "ReplyTo: " . mail_replyto() . "\n";
echo "To:      {$to}\n";
$ok = send_mail($to, $subject, $text, 'phase-a-test');
echo $ok ? "\nhanded to sendmail OK — now check the inbox / mail-tester score\n"
         : "\nsendmail REJECTED it — check the VPS mail queue (mailq) and PHP error log\n";
exit($ok ? 0 : 1);
