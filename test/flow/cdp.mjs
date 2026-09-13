/* A Chrome driver in ~120 lines, with NO dependencies.
 *
 * This repo has no package.json and CLAUDE.md forbids npm deps in the client. Playwright would
 * have been one command, and it would also have been the first node_modules/ in the tree, a
 * lockfile, and a browser download — for a harness whose entire job is to open a page and read it.
 * Node 22 ships a global WebSocket and Chrome ships the DevTools Protocol, so this needs neither.
 *
 * Deliberately small: launch, eval, click, type, screenshot, console. Anything more and it starts
 * being a framework nobody asked for. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
];

export async function launch({ headless = true, port = 9337 } = {}) {
  const bin = CHROME.find(p => { try { return existsSync(p); } catch { return false; } });
  if (!bin) throw new Error("no Chrome found — looked in:\n  " + CHROME.join("\n  "));

  /* A FRESH PROFILE EVERY RUN, and it is not hygiene — it is the point.
     /new keeps its draft in localStorage, so a second run against a warm profile starts on a trip
     the first run built and never sees the cold empty state, which is the state this harness
     exists to measure. */
  const dir = mkdtempSync(join(tmpdir(), "ttb-flow-"));
  const args = [
    "--remote-debugging-port=" + port, "--user-data-dir=" + dir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling",   // else a slow step gets 1Hz timers (CLAUDE.md)
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",        // and rAF stops, which freezes every fade
    "--force-device-scale-factor=1",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(bin, args, { stdio: "ignore" });

  const ws = await waitForTarget(port);
  const sock = new WebSocket(ws);
  await new Promise((ok, no) => { sock.onopen = ok; sock.onerror = () => no(new Error("cdp connect failed")); });

  let id = 0; const pending = new Map(); const consoleLog = []; const pageErrors = [];
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, no } = pending.get(m.id); pending.delete(m.id);
      m.error ? no(new Error(m.error.message)) : ok(m.result);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      consoleLog.push((m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "));
    if (m.method === "Runtime.exceptionThrown")
      pageErrors.push(m.params.exceptionDetails?.exception?.description
                   || m.params.exceptionDetails?.text || "unknown");
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id; pending.set(n, { ok, no });
    sock.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); no(new Error(method + " timed out")); } }, 30000);
  });

  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  /* Tell lib/tally.php this is us. Every harness that drives Chrome comes through this launch(),
     including the post-deploy flow guard that runs against PRODUCTION — so this one line is what
     stops D-187's daily count measuring our own deploys. Set on the Network domain so it rides
     every request the page makes, navigations included, which is where tally('new') fires.
     Same-origin only in practice (nothing we ship loads from anybody else), so it adds no CORS
     preflight to a fetch that did not already have one. */
  await send("Network.enable");
  await send("Network.setExtraHTTPHeaders", { headers: { "X-TTB-Harness": "1" } });

  const page = {
    consoleLog, pageErrors,

    /* Raw CDP passthrough. Added 2026-08-26 for the offline verification, which needs
       Network.emulateNetworkConditions and there is no way to express "the network is gone"
       through eval — `navigator.onLine` is a report, not a switch. Kept general rather than
       adding an `offline()` helper, because the next thing that needs a raw domain will need a
       different one. */
    send,

    clearErrors() { consoleLog.length = 0; pageErrors.length = 0; },

    async viewport(width, height, mobile = true) {
      await send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile,
        screenWidth: width, screenHeight: height,
      });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
    },

    async goto(url, settleMs = 2500) {
      await send("Page.navigate", { url });
      await new Promise(r => setTimeout(r, settleMs));
    },

    async eval(expr, awaitPromise = true) {
      const r = await send("Runtime.evaluate", {
        expression: expr, returnByValue: true, awaitPromise,
        userGesture: true,            // some handlers gate on it, and a real finger always has one
      });
      if (r.exceptionDetails)
        throw new Error("page threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result?.value;
    },

    /* Click by CSS selector, at the element's real centre, as a touch-ish mouse event.
       Returns false rather than throwing when nothing matches — a flow step that cannot find its
       control is a FINDING, not a crash, and the report wants to say so. */
    async click(sel, settleMs = 900, waitMs = 2500) {
      /* POLL FOR A VISIBLE BOX RATHER THAN ASKING ONCE. Half the "control not found" findings in
         the first runs were timing: a ring that animates in, a sheet that slides, a rail that
         renders on the next frame. A harness that asks once and gives up reports the product as
         broken when it was merely slower than the harness, and that is the most expensive kind of
         false finding — it looks exactly like a real one. */
      let box = null;
      for (const t0 = Date.now(); Date.now() - t0 < waitMs; ) {
        /* SCROLL IT INTO VIEW FIRST, BECAUSE A PERSON WOULD. At 844x390 — Peter's phone in
           landscape — the hero's primary CTA lays out at y379 with height 44, so its centre is
           BELOW a 390px fold and `elementFromPoint` returns null. Clicking there hits nothing and
           the harness called the control missing. It is not missing; it is below the fold on a
           hero that scrolls. Scrolling first keeps the two findings separate, which matters: the
           probe already reports "below the fold but reachable" as prose and "unreachable" as a
           defect, and a click that silently fails would have collapsed both into "missing". */
        box = await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
          if(!e) return null; const r0=e.getBoundingClientRect();
          if(r0.width===0||r0.height===0) return null;
          if(r0.top < 0 || r0.bottom > innerHeight) e.scrollIntoView({block:"center"});
          const r=e.getBoundingClientRect();
          if(r.width===0||r.height===0) return null;
          return {x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height,
                  offscreen: r.top<0 || r.bottom>innerHeight};})()`);
        if (box && !box.offscreen) break;
        box = null;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!box) return false;
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      await new Promise(r => setTimeout(r, settleMs));
      return true;
    },

    async tapMap(dx, dy, settleMs = 1400) {
      const p = await page.eval(`(()=>{const m=document.getElementById("map")||document.querySelector(".leaflet-container");
        if(!m) return null; const r=m.getBoundingClientRect();
        return {x:r.x+r.width*${dx}, y:r.y+r.height*${dy}};})()`);
      if (!p) return false;
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
      await new Promise(r => setTimeout(r, settleMs));
      return true;
    },

    async type(sel, text) {
      if (!await page.click(sel, 150)) return false;
      for (const ch of text) await send("Input.dispatchKeyEvent", { type: "char", text: ch });
      await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(e){e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));}})()`);
      return true;
    },

    /* Scroll the PAGE, for flows whose only verb is reading. Returns true always — a page that
       cannot reach the requested offset is not a missing control, it is a shorter page, and the
       probe reports what is actually on screen wherever it lands. */
    async scrollTo(y, settleMs = 700) {
      await page.eval(`(()=>{window.scrollTo(0, ${+y}); return 1;})()`);
      await new Promise(r => setTimeout(r, settleMs));
      return true;
    },

    async shot() { return (await send("Page.captureScreenshot", { format: "png" })).data; },

    /* WIPE BETWEEN FLOWS, NOT JUST BETWEEN RUNS. The fresh profile makes the FIRST flow cold; the
       three after it were inheriting whatever trip the first one built, because /new keeps its
       draft in localStorage. It showed up as `hasleg` on a page that had just been opened, and it
       makes every "cold start" step after the first one a lie. */
    async reset(origin) {
      await send("Page.navigate", { url: origin + "/new" });
      await new Promise(r => setTimeout(r, 900));
      await page.eval(`(()=>{ try{ localStorage.clear(); sessionStorage.clear(); }catch(e){}
        try{ indexedDB.databases && indexedDB.databases().then(ds =>
          ds.forEach(d => indexedDB.deleteDatabase(d.name))); }catch(e){} return 1; })()`);
    },

    async close() {
      try { sock.close(); } catch {}
      try { proc.kill(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
  return page;
}

/* Connect to a PAGE target, not the browser one.
   `/json/version` hands back the browser-level socket, which speaks Target.* and Browser.* and
   answers `'Page.enable' wasn't found` to everything this harness needs. The page targets are in
   `/json/list`, and on a fresh profile they take a moment to appear. */
async function waitForTarget(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Chrome opened a debugging port but never produced a page target");
}
