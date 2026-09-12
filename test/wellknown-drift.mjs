/* wellknown-drift.mjs — the FIFTH place the MCP's identity lives, and the one no guard watched.
 *
 * `public/.well-known/mcp.json` is what an agent fetches to discover this server FROM THE DOMAIN,
 * rather than from npm or the registry. It was a hand-written copy of `mcp/server.json` and it
 * drifted, silently, for five weeks. On 2026-09-11 the served file said:
 *
 *     name    io.github.peterbartsch/thistripbtw-mcp   (registry has us.thistripbtw/trips)
 *     version 1.0.0                                    (npm and the registry are at 1.3.1)
 *     remotes absent                                    (the hosted endpoint was invisible)
 *
 * The version being stale is the ordinary half. The NAME is the serious half: it advertised a
 * server that exists in no registry, and it is exactly the GitHub namespace `MCP_PUBLISHING.md`
 * records as the WRONG fix — the one that returns 403 and orphans the real entry. An agent that
 * found this site by its domain was handed an identity it could not look up.
 *
 * test/mcp-version.mjs guards four files by name and its own comment says why that was not
 * enough: "a guard that lists filenames cannot catch the file nobody added to it." This is that
 * file. So this guard does not check a version — it checks that the two manifests are the SAME
 * DOCUMENT, which cannot rot the way a list of fields can.
 */
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const A = "mcp/server.json", B = "public/.well-known/mcp.json";
const read = p => { try { return JSON.parse(readFileSync(root + p, "utf8")); }
                    catch (e) { console.log(`  ✗ ${p} — ${e.message}`); process.exit(1); } };
const a = read(A), b = read(B);
const norm = o => JSON.stringify(o, Object.keys(o).sort());

if (norm(a) === norm(b)) {
  console.log(`  ✓ ${B} matches ${A} (${a.name} ${a.version})`);
  process.exit(0);
}
console.log(`  ✗ ${B} has drifted from ${A} — an agent discovering this server by domain gets the wrong answer`);
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
  if (av !== bv) console.log(`      ${k}:\n        server.json:  ${av}\n        well-known:   ${bv}`);
}
console.log(`\n  run: cp ${A} ${B}`);
process.exit(1);
