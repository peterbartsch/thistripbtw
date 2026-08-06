/* mcp-version.mjs — one version number lives in FOUR files. Make them agree, or fail the build.

   Written 2026-08-05 after finding `serverInfo.version` had said "1.0.0" for the entire life of
   1.1.0 — the release that ADDED read_trip_link. A client feature-detecting on version would
   have concluded the tool was not there. Nothing caught it: mcp-parity.php compares the .mjs to
   the PHP mirror, and the mirror has no serverInfo to disagree with.

   Bumping it then turned up two MORE copies in server.json, the registry manifest, still on the
   old number. Four places, one number, no guard — this is that guard. */
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const found = [];

const pkg = JSON.parse(read("mcp/package.json"));
found.push(["mcp/package.json", pkg.version]);

const mjs = read("mcp/thistripbtw-mcp.mjs");
const m = mjs.match(/serverInfo:\s*\{[^}]*version:\s*"([^"]+)"/);
found.push(["mcp/thistripbtw-mcp.mjs serverInfo", m ? m[1] : "(not found)"]);

/* server.json carries it twice — once for the server, once for the package entry. Both are
   walked rather than matched by a fixed path, so a third copy would be caught too. */
const srv = JSON.parse(read("mcp/server.json"));
(function walk(node, path) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "version" && typeof v === "string") found.push([`mcp/server.json ${path}version`, v]);
    else if (typeof v === "object") walk(v, `${path}${k}.`);
  }
})(srv, "");

const versions = [...new Set(found.map(([, v]) => v))];
let failed = 0;

if (versions.length === 1 && /^\d+\.\d+\.\d+$/.test(versions[0])) {
  console.log(`  ✓ every MCP version string agrees (${versions[0]}) — ${found.length} places checked`);
} else {
  failed = 1;
  console.log("  ✗ MCP version strings disagree:");
  for (const [where, v] of found) console.log(`      ${v}  ${where}`);
}

console.log(`\n${failed ? "1 failed" : "1 passed, 0 failed"}`);
process.exit(failed);
