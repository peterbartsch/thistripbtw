/* webmcp.js — what the page offers a browser-side agent (D-201).
 *
 * This is a SOURCE test, not a browser one: no shipping browser has navigator.modelContext yet,
 * so the live check is a shim driven by hand (see the decision entry). What it guards is intent,
 * and intent is exactly what drifts: that every tool goes through the page's own functions, that
 * nothing destructive is ever registered, and that the file stays silent where the API is absent. */
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../public/webmcp.js", import.meta.url), "utf8");
/* ASSERT ON CODE, NOT PROSE. The first run of this test failed twice on its own subject's
   COMMENTS — the file explains why it does not delete anything and why window.routes was the
   trap, and a plain search for those strings found the explanations. Same shape as the regex
   stripper in tools-test.php that ate 8 KB of lib/chat.php: a test that cannot tell code from
   commentary is testing the wrong document. This strip is deliberately simple, and it is checked
   below — webmcp.js contains no string or regex literal carrying a comment marker. */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const page = readFileSync(new URL("../public/new.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log("  ok   " + what); }
  else { fail++; console.log("  FAIL " + what + (detail ? " — " + detail : "")); }
};

const tools = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map(m => m[1]);
ok("registers exactly the four page tools",
   JSON.stringify(tools) === JSON.stringify(["find_place", "add_stop", "read_trip", "get_trip_link"]),
   tools.join(","));

/* Every tool an agent can call needs a description it can decide from, and a schema. */
ok("every tool has a description and an inputSchema",
   (src.match(/description:/g) || []).length >= 4 && (src.match(/inputSchema:/g) || []).length === 4);

/* THE RULE: no second implementation. If this file ever encodes a link itself, it will drift from
   the page the way lib/mcp.php would drift from the .mjs without a parity test — and there is no
   parity test that can reach in here. */
ok("the link comes from the page's own builder", src.includes("sendableDraft()"));
ok("stops go in through the page's own addLeg", /(^|[^.\w])addLeg\(to\)/m.test(src));
ok("it does not encode a link itself", !/btoa|encodeDraft|#d=/.test(src));

/* Nothing destructive, the same reasoning as the MCP server's missing delete (D-072). */
for (const verb of ["splice", "delete ", "clearTrip", "location.href", "reload("])
  ok(`nothing calls ${verb.trim()}`, !src.includes(verb));

ok("feature-detected: absent API means nothing is registered",
   src.includes("navigator.modelContext") && /if \(!ctx \|\| typeof ctx\.registerTool !== "function"\) return;/.test(src));
ok("tools are unregistered when the page goes away",
   src.includes("AbortController") && src.includes("pagehide") && src.includes("ac.signal"));

/* Bare identifiers, not window.* — a top-level `let` is a global binding and never a window
   property, and mixing the two is what made the first version register nothing at all. */
ok("no window.routes / window.addLeg (the trap that cost the first run)",
   !/window\.(routes|addLeg|sendableDraft|active)\b/.test(src));

ok("the comment strip left the code intact", src.includes("registerTool") && src.split("\n").length > 40);

ok("/new loads it, deferred", /<script src="\/webmcp\.js\?v=\d+" defer><\/script>/.test(page));
ok("the page exports sendableDraft on purpose", page.includes("window.sendableDraft = sendableDraft;"));
ok("coordinates are validated before anything is added",
   src.includes("not on Earth") && /lat < -90 \|\| lat > 90/.test(src));

console.log("\n" + (fail ? `\x1b[31m${fail} failed\x1b[0m, ` : "") + `\x1b[32m${pass}\x1b[0m passed`);
process.exit(fail ? 1 : 0);
