/* §2ad(c)/D-155: the outbox — a write with no signal waits instead of dying.
 *
 * This is the newest thing in the client and the only one that holds a CUSTOMER'S UNSENT WORK on
 * their phone. Until now it was proved by hand in a browser, and hand-proof does not survive the
 * next edit — which is exactly how the bug it fixes got in.
 *
 * The functions are EXTRACTED FROM app.html rather than restated here. A restated copy keeps
 * passing after the source drifts, which is the failure mode `route-poly-test.mjs` was written
 * against and the one that let arcPoints be wrong in two files at once.
 *
 * What is deliberately covered, because each of these was a real decision that could regress:
 *   · the WHITELIST — an endpoint whose response is the point (a rotate returns the new password
 *     ONCE) must never be queued, and a sealed drop is opened by being there, not later
 *   · ORDER — flushOutbox is serial and stops at the first network failure, because order is the
 *     only conflict rule there is (D-155)
 *   · a 4xx is DROPPED and the queue keeps going; a 5xx and a 401 are KEPT
 *   · the caps, so a queue cannot grow until setItem throws and takes the trip cache with it
 *
 * Run: node test/outbox-test.mjs
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const app  = readFileSync(root + "public/app.html", "utf8");

let pass = 0, fail = 0;
const ok = (w, c) => { if (c) { pass++; console.log("  ok   " + w); }
                       else { fail++; console.log("  FAIL " + w); } };

/* ── lift the real source out of the page ─────────────────────────────────────────────── */
function slice(from, to, what) {
  const i = app.indexOf(from);
  if (i < 0) throw new Error("not found in app.html: " + what);
  const j = app.indexOf(to, i);
  if (j < 0) throw new Error("no end for: " + what);
  return app.slice(i, j + to.length);
}
const src = [
  slice("const OUTBOX_SAFE = [", "};", "OUTBOX_SAFE + outboxSafe"),
  slice("const outboxKey   =", "function outboxCount(){ return outboxRead().length; }", "storage helpers"),
  slice("let flushing = false;", "\n}", "flushing + flushOutbox"),
].join("\n");

ok("app.html still carries the outbox (whitelist, storage, flush)", src.length > 800);

/* ── the world the page assumes ───────────────────────────────────────────────────────── */
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
let calls = [];            // every request the flush actually made, in order
let responder = () => ({ ok: true, status: 200 });
const fetchStub = async (url, opts) => {
  const r = responder(url, opts);
  if (r instanceof Error) throw r;
  calls.push({ url, method: opts.method, body: opts.body });
  return r;
};
const ctx = {
  slug: "t", API_BASE: "", KEY: "phrase",
  localStorage, fetch: fetchStub,
  say: () => {}, paintOutbox: () => {},
  flushing: false,
};
const build = new Function(
  "slug","API_BASE","KEY","localStorage","fetch","say","paintOutbox",
  src + "\nreturn {outboxSafe, outboxAdd, outboxRead, outboxWrite, outboxCount, flushOutbox," +
        " OUTBOX_MAX, OUTBOX_TTL};"
);
const ob = build(ctx.slug, ctx.API_BASE, ctx.KEY, ctx.localStorage, ctx.fetch, ctx.say, ctx.paintOutbox);
const reset = () => { store.clear(); calls = []; };

/* ── 1. the whitelist ─────────────────────────────────────────────────────────────────── */
const SAFE = ["trip/pins", "trip/pins/pABC", "trip/notes", "trip/notes/n1", "trip/config"];
const UNSAFE = [
  ["trip/rotate",        "a rotate's RESPONSE is the new password — queueing it locks the owner out"],
  ["trip/members",       "a member's phrase is returned once — queueing it makes an orphan row"],
  ["trip",               "deleting a trip late is a surprise, not a retry"],
  ["trip/members/m1",    "removing a member is an owner action, not a road one"],
  ["trip/pins/pABC/open","a sealed drop is opened by BEING there (D-047), not from the next town"],
];
SAFE.forEach(p => ok(`queues plain trip content: ${p}`, ob.outboxSafe(p) === true));
UNSAFE.forEach(([p, why]) => ok(`refuses ${p} — ${why}`, ob.outboxSafe(p) === false));
ok("a query string does not smuggle a path past the whitelist",
   ob.outboxSafe("trip/pins/pABC?x=1") === true && ob.outboxSafe("trip/rotate?x=1") === false);
ok("a leading slash does not either", ob.outboxSafe("/trip/config") === true);
ok("an endpoint nobody has classified is NOT queued (whitelist, not blacklist)",
   ob.outboxSafe("trip/something-invented-next-year") === false);

/* ── 2. storage round-trip and caps ───────────────────────────────────────────────────── */
reset();
ob.outboxAdd("trip/pins/p1", "PATCH", JSON.stringify({ title: "a" }));
ok("an add is readable back", ob.outboxCount() === 1 &&
   ob.outboxRead()[0].path === "trip/pins/p1" && ob.outboxRead()[0].method === "PATCH");
ok("it persists under a per-trip key", store.has("ttb_outbox_t"));

reset();
for (let i = 0; i < ob.OUTBOX_MAX + 25; i++) ob.outboxAdd("trip/pins/p" + i, "PATCH", "{}");
ok(`the queue is capped at ${ob.OUTBOX_MAX}, oldest dropped`, ob.outboxCount() === ob.OUTBOX_MAX &&
   ob.outboxRead()[ob.OUTBOX_MAX - 1].path === "trip/pins/p" + (ob.OUTBOX_MAX + 24));

reset();
const garbage = ["not json", "{}", '[{"no":"path"}]'];
garbage.forEach(g => { store.set("ttb_outbox_t", g); ob.outboxRead(); });
ok("a corrupt queue reads as empty rather than throwing", ob.outboxRead().length === 0);

/* ── 3. flush: order, and stopping at the first network failure ───────────────────────── */
reset();
["A", "B", "C"].forEach(v => ob.outboxAdd("trip/pins/p1", "PATCH", JSON.stringify({ title: v })));
responder = () => ({ ok: true, status: 200 });
await ob.flushOutbox();
ok("replays in the order queued — order is the only conflict rule (D-155)",
   calls.map(c => JSON.parse(c.body).title).join("") === "ABC");
ok("and empties the queue when every one lands", ob.outboxCount() === 0);

reset();
["A", "B", "C"].forEach(v => ob.outboxAdd("trip/pins/p1", "PATCH", JSON.stringify({ title: v })));
let n = 0;
responder = () => (++n === 2 ? new TypeError("Failed to fetch") : { ok: true, status: 200 });
await ob.flushOutbox();
ok("stops at the first network failure instead of skipping past it", calls.length === 1);
ok("and keeps the unsent ones, still in order", ob.outboxCount() === 2 &&
   JSON.parse(ob.outboxRead()[0].body).title === "B");

/* ── 4. what each status does ─────────────────────────────────────────────────────────── */
reset();
ob.outboxAdd("trip/pins/gone", "PATCH", JSON.stringify({ title: "ghost" }));
ob.outboxAdd("trip/pins/p1",   "PATCH", JSON.stringify({ title: "real" }));
responder = url => (url.includes("gone") ? { ok: false, status: 404 } : { ok: true, status: 200 });
await ob.flushOutbox();
ok("a 4xx is dropped rather than retried forever", ob.outboxCount() === 0);
ok("and the good write BEHIND it still lands — a 4xx cannot block the queue",
   calls.some(c => c.body && JSON.parse(c.body).title === "real"));

reset();
ob.outboxAdd("trip/pins/p1", "PATCH", "{}");
responder = () => ({ ok: false, status: 503 });
await ob.flushOutbox();
ok("a 5xx is KEPT — the server is unwell, the edit is not wrong", ob.outboxCount() === 1);

reset();
ob.outboxAdd("trip/pins/p1", "PATCH", "{}");
responder = () => ({ ok: false, status: 401 });
await ob.flushOutbox();
ok("a 401 is KEPT — the gate is the problem, not the queue", ob.outboxCount() === 1);

/* ── 5. age ───────────────────────────────────────────────────────────────────────────── */
reset();
ob.outboxWrite([
  { t: Date.now() - (ob.OUTBOX_TTL + 60000), path: "trip/pins/old", method: "PATCH", body: "{}" },
  { t: Date.now(), path: "trip/pins/new", method: "PATCH", body: "{}" },
]);
responder = () => ({ ok: true, status: 200 });
await ob.flushOutbox();
ok("an entry older than the TTL is dropped, not sent",
   !calls.some(c => c.url.includes("old")) && calls.some(c => c.url.includes("new")));

console.log("\n" + (fail ? fail + " failed, " : "") + pass + " passed");
process.exit(fail ? 1 : 0);
