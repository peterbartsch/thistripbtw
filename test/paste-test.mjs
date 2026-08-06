/* D-101: pasting is a different act from typing, and the notice has to fire before Send.
 *
 * The parser does not care whether the words were typed or pasted — but the PERSON should. A
 * typed sentence discloses a sentence; a pasted confirmation discloses a booking reference, a
 * full name, sometimes a home address. The rule this pins is that the threshold catches a real
 * paste and does NOT nag someone writing a normal instruction, because a warning that fires on
 * every message is a warning nobody reads.
 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");
const m = src.match(/const PASTE_NOTICE_AT[\s\S]*?\nfunction pasteAdvice\(text\)\{[\s\S]*?\n\}/);
let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); } else { fail++; console.log("  FAIL " + w); } };
ok("pasteAdvice was found in new.html", !!m);
if (!m) { console.log("\n1 failed"); process.exit(1); }
const { pasteAdvice, PASTE_MAX, PASTE_NOTICE_AT } =
  new Function(m[0] + "\nreturn {pasteAdvice, PASTE_MAX, PASTE_NOTICE_AT};")();

ok("a normal typed instruction gets no notice at all",
   pasteAdvice("drive from Denver to Moab on the 4th, then fly home from Salt Lake") === null);
ok("even a chatty one stays quiet", pasteAdvice("x".repeat(PASTE_NOTICE_AT - 1)) === null);
ok("empty and missing are silent",
   pasteAdvice("") === null && pasteAdvice(null) === null && pasteAdvice(undefined) === null);

const conf = pasteAdvice("Booking reference ABC123\n".repeat(40));
ok("a pasted confirmation does get a notice", !!conf && conf.block === false);
ok("and the notice names WHO sees it — the whole point of saying it",
   /Anthropic/.test(conf.msg));
ok("and names what to take out, specifically",
   /booking reference/i.test(conf.msg) && /card/i.test(conf.msg));

const huge = pasteAdvice("x".repeat(PASTE_MAX + 1));
ok("past the cap it BLOCKS rather than warning", !!huge && huge.block === true);
ok("and the block says the limit and what to do instead",
   /6,000|6000/.test(huge.msg) && /itinerary/i.test(huge.msg));
ok("exactly at the cap is still allowed", pasteAdvice("x".repeat(PASTE_MAX)).block === false);

/* The threshold has to sit above a real instruction and below a real confirmation, or it is
   either noise or useless. A short airline confirmation is comfortably over 400 characters. */
ok("the notice threshold is above a sentence and below a confirmation",
   PASTE_NOTICE_AT > 200 && PASTE_NOTICE_AT < 1000);
ok("the cap fits a long confirmation but not an inbox",
   PASTE_MAX >= 4000 && PASTE_MAX <= 20000);

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
