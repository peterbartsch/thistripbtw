<?php
/* this trip, btw — outbound mail (D-032: sent from our own VPS, no third-party sender,
   so privacy.html's "here's the whole list" of processors stays complete).

   Deliverability rules baked in (HANDOFF_ACCOUNTS_BUILD phase A):
     - plain text first; HTML is optional and minimal
     - NO images, NO tracking pixels, NO link shorteners, NO redirect-through-us links
       (all three hurt deliverability AND would violate D-016)
     - the recipient address is NEVER written to a log. We count sends, nothing else.
*/
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }
require_once __DIR__ . '/config.php';

const MAIL_FROM_NAME = 'this trip, btw';

function mail_from()    { return env('MAIL_FROM',     'hello@'   . env('APEX', 'thistripbtw.us')); }
function mail_replyto() { return env('MAIL_REPLY_TO', 'support@' . env('APEX', 'thistripbtw.us')); }

/* Count sends by kind so we can see volume without ever storing who was mailed. */
function mail_count($kind) {
    $dir = dirname(__DIR__) . '/var';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f = $dir . '/mail-counts.json';
    $c = [];
    if (is_file($f)) { $j = json_decode((string)@file_get_contents($f), true); if (is_array($j)) $c = $j; }
    $key = date('Y-m') . ':' . $kind;
    $c[$key] = ($c[$key] ?? 0) + 1;
    @file_put_contents($f, json_encode($c), LOCK_EX);
}

/**
 * Send a plain-text-first message.
 * @param string $to      recipient (never logged)
 * @param string $subject
 * @param string $text    plain-text body — the real message
 * @param string $kind    short label for counting only, e.g. 'login', 'offer'
 * @param string|null $unsubscribe  absolute URL; adds List-Unsubscribe (required on offers)
 */
function send_mail($to, $subject, $text, $kind = 'generic', $unsubscribe = null) {
    $to = trim($to);
    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) return false;

    // header injection guard — never let a newline into a header
    $subject = trim(preg_replace('/[\r\n]+/', ' ', $subject));

    $from    = mail_from();
    $reply   = mail_replyto();
    $apex    = env('APEX', 'thistripbtw.us');

    $headers = [
        /* QUOTED, and the quotes are load-bearing. The brand is "this trip, btw" — with a
           comma — and RFC 5322 reads a bare comma in a display name as the separator between
           two addresses. Unquoted, this header parses as `this trip` plus `btw <info@...>`:
           two malformed addresses rather than one valid sender. Gmail rejects the whole message
           with 550-5.7.1 "missing a valid address in From: header", the relay accepts it happily
           first, and send_mail() returns true — so every mail this system sent was refused
           silently for weeks. Found 2026-08-01 from a MailChannels bounce. Do not unquote this. */
        'From: "' . addcslashes(MAIL_FROM_NAME, '"\\') . '" <' . $from . '>',
        'Reply-To: ' . $reply,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'X-Auto-Response-Suppress: OOF, AutoReply',
        'Auto-Submitted: auto-generated',
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $apex . '>',
    ];
    if ($unsubscribe) {
        // one-click unsubscribe; a signed single-purpose URL, never a session
        $headers[] = 'List-Unsubscribe: <' . $unsubscribe . '>';
        $headers[] = 'List-Unsubscribe-Post: List-Unsubscribe=One-Click';
    }

    // normalise line endings; keep lines short so nothing is soft-wrapped oddly
    $body = preg_replace("/\r\n?/", "\n", trim($text)) . "\n";

    // Relay through DreamHost when configured (see smtp_send); otherwise hand to the local MTA.
    $ok = env('SMTP_HOST', '') !== ''
        ? smtp_send($to, $subject, $body, $headers, $from)
        : @mail($to, $subject, $body, implode("\r\n", $headers), '-f' . $from);

    mail_count($kind . ($ok ? '' : '.fail'));
    return $ok;
}

/**
 * Deliver one message by talking SMTP to the host's own relay.
 *
 * Why not the local MTA: nothing signs mail leaving this box. There is no OpenDKIM and no
 * milter, and no root access to add one. Relaying through the hosting provider's SMTP,
 * authenticated as a real mailbox, means their servers send it — so they DKIM-sign it and
 * SPF still passes. No root needed, no new sub-processor (the host already serves the site),
 * and the config lives in .env with everything else rather than in an /etc file that a
 * server rebuild would silently drop.
 *
 * The password is read from the environment and never logged, never echoed in an error.
 */
function smtp_send($to, $subject, $body, array $headers, $from) {
    // No default: the relay is deployment config, and a provider-specific default only
    // works for one deployment while looking like it works for all of them.
    $host = env('SMTP_HOST', '');
    if ($host === '') return false;
    $port = (int)env('SMTP_PORT', '587');
    $user = env('SMTP_USER', $from);
    $pass = env('SMTP_PASS', '');
    if ($pass === '') return false;

    $ctx = stream_context_create(['ssl' => [
        'verify_peer'       => true,      // do not weaken: a MITM here would see the password
        'verify_peer_name'  => true,
        'SNI_enabled'       => true,
        'peer_name'         => $host,
    ]]);
    $fp = @stream_socket_client("tcp://$host:$port", $errno, $errstr, 20,
                                STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) return false;
    stream_set_timeout($fp, 20);

    // Read one SMTP reply, following multiline continuations ("250-" ... "250 ").
    $read = function () use ($fp) {
        $out = '';
        while (($line = fgets($fp, 1024)) !== false) {
            $out .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break;
        }
        return $out;
    };
    $cmd = function ($line, $expect) use ($fp, $read) {
        if ($line !== null) fwrite($fp, $line . "\r\n");
        $r = $read();
        return (int)substr($r, 0, 3) === $expect;
    };

    $ehlo = 'EHLO ' . env('APEX', 'thistripbtw.us');
    $ok =
        $cmd(null,       220) &&
        $cmd($ehlo,      250) &&
        $cmd('STARTTLS', 220);
    if ($ok) {
        $ok = stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
    }
    if ($ok) {
        $ok =
            $cmd($ehlo,                       250) &&   // must re-EHLO inside TLS
            $cmd('AUTH LOGIN',                334) &&
            $cmd(base64_encode($user),        334) &&
            $cmd(base64_encode($pass),        235) &&
            $cmd('MAIL FROM:<' . $from . '>', 250) &&
            $cmd('RCPT TO:<' . $to . '>',     250) &&
            $cmd('DATA',                      354);
    }
    if ($ok) {
        // dot-stuff: a line that is just "." would otherwise end the message early
        $data = implode("\r\n", array_merge($headers, ['To: ' . $to, 'Subject: ' . $subject]))
              . "\r\n\r\n"
              . preg_replace('/^\./m', '..', preg_replace("/\n/", "\r\n", $body));
        fwrite($fp, $data . "\r\n.\r\n");
        $ok = (int)substr($read(), 0, 3) === 250;
    }
    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
    return $ok;
}
