/* D-119: the Skill and the MCP server must produce the SAME link, byte for byte.
 *
 * There are now three implementations of one format — `mcp/thistripbtw-mcp.mjs` over stdio, the
 * hosted endpoint in `lib/mcp.php`, and `skill/scripts/build_link.py`. The first two are already
 * pinned to each other by `mcp-parity.php`. This pins the third, for the same reason and against
 * the same failure: a fix applied to one copy and missed on another produces links that both
 * "work" and disagree, and nobody notices until two people compare what they were sent.
 *
 * A port between languages has its own hazards, and a same-language test would not have found
 * them. Three are checked explicitly below because each silently changes the bytes while leaving
 * valid JSON behind:
 *
 *   · separators — Python's json.dumps writes `", "` and `": "`; JSON.stringify writes neither.
 *   · ensure_ascii — Python escapes non-ASCII to \uXXXX by default; JSON.stringify emits UTF-8,
 *     so a trip through Zürich diverges on that word alone.
 *   · key order — both languages serialise in insertion order, so the Python dicts have to be
 *     BUILT in the same order as the JS objects, not merely contain the same keys.
 *
 * Run: node test/skill-parity.mjs   (no network, no DB)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* The JS side, reached the same way the MCP parity test reaches it: run the real file. */
function viaMcp(trip) {
  const init = { jsonrpc: "2.0", id: 0, method: "initialize",
                 params: { protocolVersion: "2025-11-25", capabilities: {},
                           clientInfo: { name: "parity", version: "1" } } };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "build_trip_link", arguments: trip } };
  const out = execFileSync("node", [root + "mcp/thistripbtw-mcp.mjs"],
                           { input: JSON.stringify(init) + "\n" + JSON.stringify(call) + "\n" }).toString();
  const msg = out.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 1);
  const text = msg?.result?.content?.[0]?.text ?? "";
  return (text.match(/https:\/\/\S+#d=[A-Za-z0-9_-]+/) || [null])[0];
}

function viaSkill(trip) {
  return execFileSync("python3", [root + "skill/scripts/build_link.py", JSON.stringify(trip)])
           .toString().trim();
}

/* ── the fixtures. Each exists to break a specific way a port goes wrong. ────────────────── */
const FIXTURES = {
  "a minimal trip": {
    origin: { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
    legs: [{ to: { name: "Omaha, NE", lat: 41.2565, lng: -95.9345 } }],
  },
  "every optional field at once — catches key ORDER": {
    name: "The works",
    origin: { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
    legs: [{
      to: { name: "Omaha, NE", lat: 41.2565, lng: -95.9345 },
      mode: "drive", date: "2026-09-04", note: "swap drivers here",
      who: ["Mel", "Sam"], subtype: "rental", craft: "Canoe",
      flight: "UA328", lodging: "Hotel Maverick", stayNote: "late check-in",
    }],
  },
  "non-ASCII names — catches ensure_ascii": {
    name: "Über den Alpen",
    origin: { name: "Zürich", lat: 47.3769, lng: 8.5417 },
    legs: [{ to: { name: "München", lat: 48.1351, lng: 11.582 }, mode: "train" }],
  },
  "an unknown mode, which must become drive rather than fail": {
    origin: { name: "A", lat: 1, lng: 1 },
    legs: [{ to: { name: "B", lat: 2, lng: 2 }, mode: "teleport" }],
  },
  "values past their clamps": {
    name: "x".repeat(200),
    origin: { name: "y".repeat(300), lat: 1, lng: 1 },
    legs: [{ to: { name: "z".repeat(300), lat: 2, lng: 2 }, note: "n".repeat(900) }],
  },
  "junk in the optional fields, which must be dropped identically": {
    origin: { name: "A", lat: 1, lng: 1 },
    legs: [{ to: { name: "B", lat: 2, lng: 2 }, subtype: "hovercraft", craft: "Submarine",
             flight: "not a flight number!", who: [] }],
  },
  "negative and fractional coordinates": {
    origin: { name: "S", lat: -33.8688, lng: 151.2093 },
    legs: [{ to: { name: "N", lat: -36.8485, lng: 174.7633 }, mode: "fly" }],
  },
  "a multi-leg trip with a paddle in the middle": {
    name: "Kishwaukee",
    origin: { name: "Arlington Heights, IL", lat: 42.0812, lng: -87.9802 },
    legs: [
      { to: { name: "Blackhawk Springs", lat: 42.1996, lng: -88.9808 }, mode: "drive" },
      { to: { name: "Baumann Park", lat: 42.2342, lng: -88.9556 }, mode: "drive" },
      { to: { name: "Blackhawk Springs", lat: 42.1996, lng: -88.9808 }, mode: "water",
        craft: "Canoe", who: ["Pete", "Jim"] },
    ],
  },
};

for (const [what, trip] of Object.entries(FIXTURES)) {
  const a = viaMcp(trip), b = viaSkill(trip);
  ok(what, !!a && a === b);
  if (a !== b) console.log(`       mcp:   ${a}\n       skill: ${b}`);
}

/* ── the refusals must match too ────────────────────────────────────────────────────────── */
/* A port that accepts what the original rejects is worse than one that formats differently:
   it produces a link that opens somewhere nobody chose. */
function skillRejects(trip) {
  try { viaSkill(trip); return false; } catch { return true; }
}
ok("both refuse an origin with no coordinates",
   skillRejects({ origin: { name: "Chicago" }, legs: [{ to: { lat: 1, lng: 1 } }] }));
ok("both refuse a trip with no legs",
   skillRejects({ origin: { name: "A", lat: 1, lng: 1 }, legs: [] }));
ok("both refuse coordinates outside the world",
   skillRejects({ origin: { name: "A", lat: 91, lng: 1 }, legs: [{ to: { lat: 2, lng: 2 } }] }));
ok("both refuse a malformed date",
   skillRejects({ origin: { name: "A", lat: 1, lng: 1 },
                  legs: [{ to: { lat: 2, lng: 2 }, date: "4th Sept" }] }));

/* ── the constants must not drift apart ─────────────────────────────────────────────────── */
/* The lists are the contract. If one file learns a new subtype and the other does not, every
   fixture above still passes — none of them uses it — and the divergence ships. */
const js = readFileSync(root + "mcp/thistripbtw-mcp.mjs", "utf8");
const py = readFileSync(root + "skill/scripts/build_link.py", "utf8");
const listOf = (src, name) => {
  const m = src.match(new RegExp(name + "\\s*=\\s*\\[([\\s\\S]*?)\\]"));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
};
for (const name of ["MODES", "SUBTYPES", "CRAFT"]) {
  const a = listOf(js, name), b = listOf(py, name);
  ok(`${name} is identical in both files (${a?.length} values)`,
     !!a && !!b && a.join("|") === b.join("|"));
}
/* Match the DECLARATION, not the first mention. `NAME_MAX\D+(\d+)` looked reasonable and read
   the wrong number out of the Python file the moment a comment above the constant mentioned it
   by name — it ran past the word and captured the next digits it found, which belonged to a
   different constant entirely. Anchor to `NAME = <digits>` with only spaces between. */
for (const name of ["MAX_LEGS", "NAME_MAX", "TRIP_MAX", "NOTE_MAX"]) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(\\d+)`, "m");
  const a = (js.match(re) || [])[1], b = (py.match(re) || [])[1];
  ok(`${name} matches (${a})`, !!a && a === b);
}

/* ── the discovery index must describe the file it points at ──────────────────────────────
   /.well-known/agent-skills/index.json advertises a sha256 for SKILL.md. Nothing checked it,
   so editing the skill silently left the index vouching for a document that no longer exists —
   and a WRONG checksum is worse than none: it reads as tampering to anything that verifies. */
{
  const { createHash } = await import("node:crypto");
  const idx = JSON.parse(readFileSync(root + "public/.well-known/agent-skills/index.json", "utf8"));
  const md  = readFileSync(root + "skill/SKILL.md", "utf8");
  const want = createHash("sha256").update(md).digest("hex");
  const got  = idx.skills?.[0]?.sha256;
  ok("the skills index advertises the sha256 SKILL.md actually has", got === want);
  ok("the skills index points at a url this repo serves",
     idx.skills?.[0]?.url === "https://thistripbtw.us/agent-skill");
}

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
