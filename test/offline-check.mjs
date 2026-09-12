/* Does the trip page work with the network off? Behaviour, not loading.
 *
 * CLAUDE.md: `make check` is node --check — syntax, never references — and the suite never
 * executes app.html's inline script. So the only honest question here is whether the map DREW,
 * which is what D-167 cost a session to learn: canvas pixels answer *did it draw*, and computed
 * opacity answers *can it be seen*, and you need both. */
import { launch } from "./flow/cdp.mjs";

const BASE = process.env.TTB_BASE || "https://thistripbtw.us";
const TRIP = "/efevnwm/#k=treeline-downpour-rolling-switchback";
const out  = [];
const say  = (k, v) => { out.push([k, v]); console.log("  " + k.padEnd(34) + v); };

const p = await launch({ headless: true, port: 9611 });
try {
await p.viewport(390, 844);

/* 1. Cold and online: the worker must install and precache the whole shell. */
await p.goto(BASE + TRIP, 9000);
await new Promise(r => setTimeout(r, 4000));

say("worker controlling the page", await p.eval(`!!navigator.serviceWorker.controller`));
say("cached shell entries", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys())))).then(a=>a.flat().length)`));
say("mapstyle.js cached", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys()))))
     .then(a=>a.flat().some(r=>r.url.includes("mapstyle.js")))`));
say("the shell itself cached", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys()))))
     .then(a=>a.flat().some(r=>r.url.includes("__ttb_shell")))`));
say("NO api response cached (rule 1)", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys()))))
     .then(a=>!a.flat().some(r=>r.url.includes("/api/")))`));

/* 2. Kill the network at the protocol level. `navigator.onLine` is a report, not a switch. */
await p.send("Network.enable");
await p.send("Network.emulateNetworkConditions",
  { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

await p.goto(BASE + TRIP, 9000);
await new Promise(r => setTimeout(r, 5000));

say("OFFLINE — page has a body", await p.eval(`!!document.body && document.body.children.length > 3`));
say("OFFLINE — Leaflet loaded", await p.eval(`typeof L !== "undefined"`));
say("OFFLINE — trip data restored", await p.eval(
  `(()=>{ try{ return typeof pinsById !== "undefined" && pinsById.size > 0 ? pinsById.size + " pins" : "0 pins"; }
   catch(e){ return "threw: " + e.message; } })()`));
say("OFFLINE — stops rendered in DOM", await p.eval(
  `document.querySelectorAll(".place, .card, #list > *").length`));

/* D-167: painted and invisible are different questions, so ask both. */
say("OFFLINE — map canvases", await p.eval(`document.querySelectorAll(".leaflet-tile-pane canvas").length`));
say("OFFLINE — opaque colours drawn", await p.eval(`(()=>{
  const cs=[...document.querySelectorAll(".leaflet-tile-pane canvas")]; const seen=new Set();
  for(const c of cs){ try{ const g=c.getContext("2d"); if(!g) continue;
    const d=g.getImageData(0,0,c.width,c.height).data;
    for(let i=0;i<d.length;i+=4*997) seen.add(d[i]+","+d[i+1]+","+d[i+2]+","+d[i+3]); }catch(e){} }
  return [...seen].filter(s=>!s.endsWith(",0")).length; })()`));
say("OFFLINE — canvas opacity (D-167)", await p.eval(
  `[...new Set([...document.querySelectorAll(".leaflet-tile-pane canvas")].map(c=>getComputedStyle(c).opacity))].join(",") || "none"`));

/* 3. The escape hatch, tested ONLINE — and that is not a convenience.
   With the network off AND the worker bypassed there is nothing left to answer the navigation,
   so Chrome shows its own error page, which is a different context with no navigator.serviceWorker
   on it at all. The first run of this file threw there and it read like a broken kill switch. */
await p.send("Network.emulateNetworkConditions",
  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await p.goto(BASE + "/efevnwm/?nosw=1#k=treeline-downpour-rolling-switchback", 6000);
await new Promise(r => setTimeout(r, 2500));
say("?nosw=1 removed the worker", await p.eval(
  `navigator.serviceWorker.getRegistrations().then(r=>r.length===0)`));
/* ENTRIES, NOT NAMES. `caches.open()` creates a cache on a miss, so the worker re-creating an
   EMPTY one while the killing page finishes loading its own assets is not a failed kill — and
   asserting on names reported it as one. The question is whether anything is still stored. */
say("?nosw=1 emptied the caches", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys()))))
     .then(a=>{const n=a.flat().length; return n===0 ? true : n+" entries left";})`));

/* 4. FAIL IT ON PURPOSE. A guard that has never failed is not a guard — the rule this repo wrote
   after loosening the tap-target probe, and the single most important test in this file.
   The stated risk of a service worker is bricking a returning visitor forever. Network-first is
   the answer, so poison the cache with a shell that would brick, come back ONLINE, and confirm the
   network wins and the poison is replaced. Done in the browser rather than by deploying a broken
   shell to production, because the property under test is the worker's, not the server's. */
await p.goto(BASE + TRIP, 8000);
await new Promise(r => setTimeout(r, 3500));
await p.eval(`(async()=>{ const k=(await caches.keys()).find(x=>x.includes("shell"));
  const c=await caches.open(k);
  await c.put("/__ttb_shell", new Response("<html><body>BRICKED</body></html>",
    {status:200, headers:{"content-type":"text/html"}}));
  return 1; })()`);
say("poisoned the shell cache", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.match("/__ttb_shell")))))
     .then(rs=>rs.filter(Boolean)[0].text()).then(t=>t.includes("BRICKED"))`));

/* A REAL RELOAD, NOT A REPEAT OF THE SAME URL. `Page.navigate` to a URL that differs only by
   its #fragment — and TRIP carries one — is a SAME-DOCUMENT navigation: no network, no fetch
   event, no reload. The first version of this test did exactly that and reported the anti-brick
   property as broken, when the page under test had simply never been re-fetched. The worker's own
   log is what showed it: not one `nav` entry, ever. Instrument, not product — again. */
await p.eval(`location.reload()`);
await new Promise(r => setTimeout(r, 7000));
say("  worker saw the navigation", await p.eval(
  `swStats().then(s=>(s.log||[]).some(l=>l.startsWith("nav /")) ? true : JSON.stringify(s.log||s))`));
say("RECOVERED online (network-first)", await p.eval(
  `!document.body.textContent.includes("BRICKED") && typeof L !== "undefined"`));
say("poison replaced in the cache", await p.eval(
  `caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.match("/__ttb_shell")))))
     .then(rs=>{const r=rs.filter(Boolean)[0]; return r ? r.text().then(t=>!t.includes("BRICKED")) : "no shell";})`));

/* 5. THE PHOTO QUEUE (§2bm). The promise is "close the tab in a canyon, open it in town, the
   photo is still there", so the test closes the tab. Uses the REAL pqPush/flushPhotoQueue with a
   real JPEG made by the page — a File is a File, and stubbing the queue would only prove the stub
   works, which is the trap this repo already paid for once. */
console.log("  ── photo queue ──");
await p.send("Network.emulateNetworkConditions",
  { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await p.goto(BASE + TRIP, 9000);
await new Promise(r => setTimeout(r, 4000));

say("queue starts empty", await p.eval(`pqCount().then(n=>n===0 ? true : n+" left over")`));
say("a real photo enqueues offline", await p.eval(`(async()=>{
  const c=document.createElement("canvas"); c.width=800; c.height=600;
  const g=c.getContext("2d"); g.fillStyle="#035A83"; g.fillRect(0,0,800,600);
  const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.9));
  return pqPush({slug, blob, name:"test.jpg", type:"image/jpeg", lat:37.77, lng:-122.42,
                 author:"harness", ts:Date.now()});
})()`));
say("count after enqueue", await p.eval(`pqCount()`));
say("the banner says photo, not change", await p.eval(`(async()=>{ await paintOutbox();
  const t=document.getElementById("offline").textContent; return /photo/.test(t) ? t.trim() : "NO: "+t.trim(); })()`));

/* THE CORE PROMISE: it has to survive the tab closing, not just the page being busy. */
await p.goto(BASE + TRIP, 9000);
await new Promise(r => setTimeout(r, 4000));
say("SURVIVES a reload, still offline", await p.eval(`pqCount().then(n=>n===1 ? true : n+" found")`));

/* A DRAIN THAT FAILS MUST NOT LOSE THE PHOTO. Back online but with no valid edit key, so the
   upload really is refused — the honest version of "the server said no". Nothing may be deleted. */
await p.send("Network.emulateNetworkConditions",
  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
say("drain with a refused upload", await p.eval(
  `(async()=>{ READONLY=false; KEY="not-a-real-edit-phrase"; return await flushPhotoQueue(); })()`));
say("  photo NOT lost by the failure", await p.eval(`pqCount().then(n=>n===1 ? true : "LOST — "+n+" left")`));

await p.eval(`(async()=>{ for(const r of await pqMine()) await pqTx("readwrite",st=>st.delete(r.id)); })()`);
say("  cleaned up", await p.eval(`pqCount().then(n=>n===0)`));

/* 6. LEGIBLE DEGRADATION (§2bm). The rule is that offline must never produce something that
   LOOKS finished and is not — so the two silent ones get asserted: a route that failed for want
   of signal must stay retryable, and a stop that could not be named must be remembered. */
console.log("  ── degrades legibly ──");
await p.send("Network.emulateNetworkConditions",
  { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await p.goto(BASE + TRIP, 9000);
await new Promise(r => setTimeout(r, 4000));

say("a failed route is NOT cached", await p.eval(`(async()=>{
  const sig="harness-"+Date.now();
  await fetchRoute([[37.77,-122.42],[37.80,-122.40]], sig);
  /* undefined is "never asked" and is the ONLY value that retries; null would mean "asked, and
     there is no road", which is the answer a network failure must never be allowed to fake. */
  return routeCache.get(sig) === undefined ? true : "cached as "+String(routeCache.get(sig));
})()`));
say("an unnamed stop is remembered", await p.eval(`(async()=>{
  nameLater("harness-stop", 37.77, -122.42);
  return NAMELESS.has("harness-stop") && NAMELESS.size===1;
})()`));
say("  and it says so on screen", await p.eval(
  `/waiting|type one|fill itself/.test(document.body.textContent) ? true : "no message"`));

await p.send("Network.emulateNetworkConditions",
  { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
say("online: a real route now caches", await p.eval(`(async()=>{
  const sig="harness2-"+Date.now();
  await fetchRoute([[37.77,-122.42],[37.80,-122.40]], sig);
  return routeCache.get(sig) !== undefined ? true : "still unasked";
})()`));

const errs = p.pageErrors.filter(e => !/Failed to fetch|NetworkError|network error|load failed/i.test(e));
say("page errors (non-network)", errs.length ? errs.slice(0,3).join(" | ") : "none");

} finally {
  /* A THROWN ASSERTION MUST NOT LEAK A BROWSER. The first failing run left Chrome alive on
     9611, and the next run connected to that stale instance and hung on Page.enable — which reads
     like a broken harness rather than a leaked process. flow/run.mjs already closes in a finally;
     this file did not. */
  await p.close();
}
