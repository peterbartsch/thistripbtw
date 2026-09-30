<?php
/* markdown.php — a markdown rendering of a page, for agents that asked for one.
 *
 * WHY THIS EXISTS. An assistant reading /what-you-get gets 13 KB of HTML wrapped around 2 KB of
 * sentences: a nav it cannot use, a theme button, inline SVG, a footer, and the CSP-shaped
 * furniture of a real page. Content negotiation hands it the sentences instead — same URL, same
 * content, one header.
 *
 * WHY AT THE ORIGIN. Cloudflare converts HTML to markdown at the edge, but it is a Pro-plan zone
 * setting and this zone is free. Fifty lines here beats a plan upgrade, and it keeps the output
 * ours: nothing decides what an agent reads except this file.
 *
 * ── THE RULE IT IS WRITTEN UNDER ─────────────────────────────────────────────────────────────
 * THE MARKDOWN AND THE PAGE MUST SAY THE SAME THING. Not a summary, not an expansion, not a
 * cheerier version for robots. `make check-copy` reads the HTML and would never see a claim that
 * only exists in the markdown — so this converts, and never composes. Every sentence below comes
 * out of the page it was asked about.
 *
 * ── WHAT IT DELIBERATELY DROPS ───────────────────────────────────────────────────────────────
 * <script>, <style>, <svg>, <nav>, <button>, <footer>, and anything marked aria-hidden or .vh —
 * chrome, decoration and screen-reader scaffolding. What is left is the header's h1 and lede and
 * the <main>, which is the page.
 *
 * ── AND WHAT IT MUST NOT DO ──────────────────────────────────────────────────────────────────
 * NEVER the trip page. `app.html` is a shell whose contents arrive from the API under a phrase;
 * rendering it would either produce an empty husk or, worse, invite the idea that trip contents
 * have a public markdown form. index.php never calls this for app.html, and the guard here is a
 * second lock on the same door.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

/** Does this request want markdown? True only for an explicit text/markdown in Accept.
 *
 *  Deliberately strict: `*​/*` is what every browser and most bots send, and treating it as
 *  "markdown is fine" would serve markdown to people. The header must NAME the type. */
function md_wants_markdown(string $accept): bool {
    if ($accept === '') return false;
    foreach (explode(',', strtolower($accept)) as $part) {
        $type = trim(explode(';', $part)[0]);
        if ($type === 'text/markdown' || $type === 'text/x-markdown') return true;
    }
    return false;
}

/** A rough token count for the x-markdown-tokens header.
 *
 *  APPROXIMATE, AND SAID SO WHERE IT IS SENT. There is no tokenizer here and adding one would be
 *  a dependency for a hint. ~4 characters per token is the usual English rule of thumb; it is
 *  right to within a fifth or so, which is all a caller can use it for. */
function md_token_estimate(string $md): int { return (int)ceil(strlen($md) / 4); }

/** Convert one of our HTML pages to markdown. Returns '' if there is nothing worth sending. */
function md_from_html(string $html): string {
    $doc = new DOMDocument();
    /* Our pages are UTF-8 and libxml assumes Latin-1 without being told; the meta hint is the
       cheapest way to say so without mangling the em dashes this site is full of. */
    $prev = libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="utf-8" ?>' . $html);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    $xp = new DOMXPath($doc);

    foreach ($xp->query('//script|//style|//svg|//nav|//button|//footer|//*[@aria-hidden="true"]|//*[contains(@class,"vh")]') as $n) {
        if ($n->parentNode) $n->parentNode->removeChild($n);
    }

    $out = [];
    $title = $xp->query('//header[contains(@class,"pagehead")]//h1|//header//h1|//h1');
    if ($title->length) $out[] = '# ' . md_text($title->item(0));
    $lede = $xp->query('//header//*[contains(@class,"lede")]|//header//*[contains(@class,"lead")]');
    if ($lede->length) { $t = md_text($lede->item(0)); if ($t !== '') $out[] = $t; }

    $main = $xp->query('//main');
    $root = $main->length ? $main->item(0) : $doc->documentElement;
    md_walk($root, $out);

    /* Collapse the blank lines the walk leaves behind, then trim: three paragraphs with two gaps
       between them is markdown, five gaps is a formatting bug in someone else's parser. */
    $md = preg_replace("/\n{3,}/", "\n\n", implode("\n\n", array_filter($out, fn($l) => trim($l) !== '')));
    return trim($md) . "\n";
}

/** The text of a node, with inline links and emphasis kept and whitespace collapsed. */
function md_text(DOMNode $node): string {
    $s = '';
    foreach ($node->childNodes as $c) {
        if ($c->nodeType === XML_TEXT_NODE) { $s .= $c->nodeValue; continue; }
        if (!($c instanceof DOMElement)) continue;   // DOMElement, not DOMNode: getAttribute below
        $tag = strtolower($c->nodeName);
        $inner = md_text($c);
        if ($tag === 'a') {
            $href = $c->getAttribute('href');
            /* A relative href is useless to an agent that fetched an absolute URL, so it is made
               absolute here rather than left for the reader to guess at. */
            if ($href !== '' && $href[0] === '/') $href = 'https://thistripbtw.us' . $href;
            $s .= ($href === '' || $inner === '') ? $inner : "[$inner]($href)";
        } elseif ($tag === 'strong' || $tag === 'b') { $s .= $inner === '' ? '' : "**$inner**";
        } elseif ($tag === 'em' || $tag === 'i')     { $s .= $inner === '' ? '' : "*$inner*";
        } elseif ($tag === 'code')                   { $s .= $inner === '' ? '' : "`$inner`";
        } elseif ($tag === 'br')                     { $s .= "\n";
        } else                                        { $s .= $inner; }
    }
    return trim(preg_replace('/[ \t]*\n[ \t]*/', "\n", preg_replace('/[ \t]+/', ' ', $s)));
}

/** Walk the body, emitting one markdown block per structural element. */
function md_walk(DOMNode $node, array &$out): void {
    foreach ($node->childNodes as $c) {
        if (!($c instanceof DOMElement)) continue;   // getElementsByTagName is DOMElement's
        $tag = strtolower($c->nodeName);
        switch ($tag) {
            case 'h1': case 'h2': case 'h3': case 'h4':
                $t = md_text($c);
                if ($t !== '') $out[] = str_repeat('#', (int)substr($tag, 1)) . ' ' . $t;
                break;
            case 'p':
                $t = md_text($c); if ($t !== '') $out[] = $t;
                break;
            case 'ul': case 'ol':
                $i = 1; $lines = [];
                foreach ($c->getElementsByTagName('li') as $li) {
                    if ($li->parentNode !== $c) continue;          // nested lists are walked by their own <ul>
                    $t = md_text($li);
                    if ($t !== '') $lines[] = ($tag === 'ol' ? ($i++) . '. ' : '- ') . $t;
                }
                if ($lines) $out[] = implode("\n", $lines);
                break;
            case 'table':
                foreach ($c->getElementsByTagName('tr') as $tr) {
                    $cells = [];
                    foreach ($tr->childNodes as $cell) {
                        if ($cell->nodeType === XML_ELEMENT_NODE && in_array(strtolower($cell->nodeName), ['td','th'], true))
                            $cells[] = md_text($cell);
                    }
                    if ($cells) $out[] = '- ' . implode(' — ', array_filter($cells, fn($x) => $x !== ''));
                }
                break;
            case 'pre':
                $t = trim($c->textContent);
                if ($t !== '') $out[] = "```\n$t\n```";
                break;
            case 'blockquote':
                $t = md_text($c);
                if ($t !== '') $out[] = '> ' . str_replace("\n", "\n> ", $t);
                break;
            default:
                md_walk($c, $out);                                  // a wrapper; its children are the content
        }
    }
}

/** Serve the markdown form of $file, or return false if there is nothing to serve. */
function md_serve(string $file): bool {
    if (basename($file) === 'app.html') return false;               // never the trip page
    $html = @file_get_contents($file);
    if ($html === false) return false;
    $md = md_from_html($html);
    if (strlen(trim($md)) < 40) return false;                        // a husk is worse than a fallback

    header('Content-Type: text/markdown; charset=utf-8');
    header('Vary: Accept');
    /* NO-STORE, and it is not paranoia. Cloudflare's free plan is in front of this and the repo
       has watched it ignore origin cache headers before; a cached markdown variant served to a
       browser would be the whole site rendered as source. The HTML path keeps its own caching. */
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('x-markdown-tokens: ' . md_token_estimate($md));          // approximate: ~4 chars/token
    echo $md;
    return true;
}
