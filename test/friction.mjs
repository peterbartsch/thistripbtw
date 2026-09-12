/* §2bl — COUNT THE INTERACTIONS. The field finding was "dead simple to create/edit a trip (with
 * permissions)" and "dead simple" is unfalsifiable without a number, so this produces one.
 *
 * WHAT AN INTERACTION IS: one tap, one drag, one committed field, one permission dialog answered,
 * one page navigation. Scrolling a list is NOT counted as an interaction — but needing to scroll
 * IS recorded, because it is where a person's extra taps come from.
 *
 * THE METRIC IS THE NAVIGATION SHARE, NOT THE TOTAL. §2bc's original count is the model: "five
 * interactions, and the first two are navigation." Dead simple means the navigation share goes to
 * near zero. Three work-taps and no nav taps is dead simple; two work-taps and four nav taps is
 * the thing Peter came home from.
 *
 * ── WHAT THIS CANNOT ANSWER, AND IT MUST BE SAID FIRST ───────────────────────────────────────
 * THIS HARNESS KNOWS WHERE EVERY CONTROL IS AND A PERSON DOES NOT. Every count here is therefore
 * a LOWER BOUND — the number of interactions for somebody who already knows the path perfectly.
 * The gap between this and a real person is hesitation, and only a moderated cold run — one
 * non-designer, watched, building a trip — measures that. So each step also records whether its
 * target was ON SCREEN and
 * UNCOVERED at the moment it was needed: a control you must go looking for is the closest thing
 * a machine can measure to a control you cannot find.
 *
 * Runs against the LOCAL stack, because a real EDIT needs a real edit phrase and production's
 * demo link is a view key. `rstepqa` / `local-only-replay-test-phrase` (CLAUDE.md).
 */
import { launch } from "./flow/cdp.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.TTB_BASE || "http://127.0.0.1:8080";
const TRIP = "/rstepqa/#k=local-only-replay-test-phrase";
const VPS  = [{name:"390x844", w:390, h:844}, {name:"390x664", w:390, h:664}];

/* Was this control on screen, and could a finger actually land on it? Not "does it exist". */
const SEEN = sel => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return "missing";
  const r=e.getBoundingClientRect(), s=getComputedStyle(e);
  if(r.width===0||r.height===0||s.display==="none"||s.visibility==="hidden"||+s.opacity===0) return "hidden";
  if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth) return "offscreen";
  const t=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  if(t && (t===e || e.contains(t) || t.contains(e))) return "onscreen";
  /* NAME THE COVERER. "covered" on its own is a vague reading and this repo's rule is that a
     measurement you cannot act on is not one — the question is always WHICH element is in the way. */
  if(!t) return "centre below the fold";   // elementFromPoint answers only INSIDE the viewport
  return "covered by " + (t.id || (t.className||"").toString().split(" ")[0] || t.tagName);})()`;

/* kind: "nav" = getting to where the work happens. "work" = the change itself.
   "outside" = an interaction that leaves this application entirely. */
const TASKS = [
  {
    id: "edit",
    title: "EDIT — change one stop's date on a trip you can edit",
    note: "§2bc counted this at 5 on 2026-08-12. Re-measured at 4 on 08-26 with HALF of it navigation, and both nav taps were dragging the sheet — the date was behind the 'Add detail' fold AND below the fold of the screen. §2bl's fix makes the printed date the way you change it.",
    url: TRIP,
    steps: [
      { kind:"nav",  what:"open the sheet if it is not already resting open",
        sel:"#openSheet", skipIf:`document.getElementById("sheet")?.classList.contains("half")||document.getElementById("sheet")?.classList.contains("full")` },
      { kind:"nav",  what:"reach the stop you mean (the rail is a horizontal swipe)",
        sel:"#list .card", scrollOnly:true },
      { kind:"work", what:"tap the date printed on the card", sel:"#list .card .whendate" },
      { kind:"work", what:"set the date", sel:"#list .card .f-date", setValue:"2026-09-14" },
    ],
  },
  {
    id: "photo",
    title: "PHOTO — attach one photo to the trip",
    note: "§2bd aimed at ~2 and the first measurement found 3, TWO of them travel — 67%, the worst share of the four. #photoMap (§2bl) is the fix: the camera is on the map, so there is no menu to open.",
    url: TRIP,
    steps: [
      { kind:"work", what:"tap the camera on the map", sel:"#photoMap" },
      { kind:"work", what:"choose the photo (OS picker — counted, not performed)", counted:true },
    ],
  },
  {
    id: "permission",
    /* THIS TASK MINTS A REAL MEMBER EVERY RUN, so it removes it again — a harness that pollutes
       its own fixture drifts the very thing it measures. Eighteen leftover members had already
       accumulated on `rstepqa` before anyone noticed, which lengthens the settings sheet and so
       lengthens the scroll this task reports. Distinctive handle, deleted through the same API
       the remove button uses. */
    cleanup: `(async()=>{ try{
      const r = await api("trip/state?since=0");
      const roster = (r && r.roster) || [];
      for(const m of roster) if(/^zz-harness/.test(m.handle||"")) await api("trip/members/"+m.id,{method:"DELETE"});
      return true;
    }catch(e){ return "cleanup failed: "+e.message; } })()`,
    title: "PERMISSION — get a second person editing on their own phone",
    note: "NEVER MEASURED BEFORE. The model is settled (D-023/D-071/D-072); the flow has never been looked at.",
    url: TRIP,
    steps: [
      { kind:"nav",  what:"open the action ring", sel:"#fab" },
      { kind:"nav",  what:"tap Settings", sel:"[aria-label*='Settings'],[aria-label*='settings']" },
      { kind:"nav",  what:"reach the crew section", sel:".crew-name", scrollOnly:true },
      { kind:"work", what:"tap the name field", sel:".crew-name" },
      { kind:"work", what:"type their name", sel:".crew-name", type:"zz-harness" },
      { kind:"work", what:"tap + Add & send — this mints the link AND opens the share sheet", sel:".crew-add" },
      /* NOT COUNTED ANY MORE, AND THE REASON IS THE FIX. Minting and handing over used to be two
         taps with nothing between them; the share sheet now opens on its own (§2bl). It is only
         counted when the browser refuses — `navigator.share` is absent, or transient activation
         was lost across the await — in which case the link box is the fallback it always was.
         So this flow is 6 where the OS sheet exists and 7 where it does not. */
      { kind:"work", what:"the OS share sheet (counted only if the browser refused)",
        sel:".crew-share,.crew-mail,.crew-copy",
        skipIf:`!!navigator.share` },
      { kind:"outside", what:"they open the link on their phone", counted:true },
    ],
  },
  {
    id: "create",
    title: "CREATE — from cold to a trip with two stops, at the point payment begins",
    note: "NEVER COUNTED, EVER. The cold run said 'too hard to create / follow through' and we answered with a hero change (D-170), upstream of the actual work.",
    url: "/new",
    cold: true,
    steps: [
      { kind:"nav",  what:"tap the primary CTA on the hero", sel:".hero .cta,.cta" },
      { kind:"work", what:"tap where you're starting", tapMap:[0.42,0.42] },
      { kind:"work", what:"tap where you're going", tapMap:[0.62,0.60] },
      { kind:"nav",  what:"dismiss the ring the second tap opened",
        sel:".hub", skipIf:`!document.body.classList.contains("ringing")` },
      { kind:"nav",  what:"find the way to buy", sel:".kb-one", scrollOnly:true },
      { kind:"work", what:"tap it — payment begins here", sel:".kb-one", terminal:true,
        stop:"everything past this point is Stripe's hosted checkout, which is not our surface" },
    ],
  },
];

const results = [];

for (const vp of VPS) {
  const p = await launch({ headless: true, port: 9640 + VPS.indexOf(vp) });
  try {
    await p.viewport(vp.w, vp.h);
    for (const task of TASKS) {
      if (task.cold) await p.reset(BASE);
      await p.goto(BASE + task.url, 8000);
      await new Promise(r => setTimeout(r, 2500));
      const log = [];
      for (const st of task.steps) {
        if (st.skipIf) {
          let skip = false;
          try { skip = await p.eval(`!!(${st.skipIf})`); } catch (e) {}
          if (skip) { log.push({ ...st, outcome: "not needed", counts: false }); continue; }
        }
        if (st.counted) { log.push({ ...st, outcome: "counted", counts: true, seen: "—" }); continue; }
        if (st.raiseSheet) {
          const ok = await p.eval(`(()=>{ try{ setSheet("full"); return true; }catch(e){ return false; } })()`);
          await new Promise(r => setTimeout(r, 700));
          log.push({ ...st, outcome: ok ? "done" : "NO SHEET", counts: true, seen: "—" });
          continue;
        }
        if (st.tapMap) {
          const ok = await p.tapMap(st.tapMap[0], st.tapMap[1]);
          log.push({ ...st, outcome: ok ? "done" : "NO MAP", counts: true, seen: "onscreen" });
          continue;
        }
        const seen = await p.eval(SEEN(st.sel));
        if (st.scrollOnly) {
          /* Not an interaction — but if it was not already on screen, the person had to go and
             find it, and that is the number this row exists to produce. */
          log.push({ ...st, outcome: seen === "onscreen" ? "already there" : "had to go find it",
                     counts: false, seen });
          continue;
        }
        if (st.setValue) {
          const ok = await p.eval(`(()=>{const e=document.querySelector(${JSON.stringify(st.sel)});
            if(!e) return false; e.value=${JSON.stringify(st.setValue)};
            e.dispatchEvent(new Event("input",{bubbles:true}));
            e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
          log.push({ ...st, outcome: ok ? "done" : "NOT FOUND", counts: true, seen });
          continue;
        }
        if (st.type) {
          const ok = await p.type(st.sel, st.type);
          log.push({ ...st, outcome: ok ? "done" : "NOT FOUND", counts: true, seen });
          continue;
        }
        const ok = await p.click(st.sel, 1100);
        /* A control that did not exist when the PREVIOUS step ended is not "missing" — it was
           rendered by that step. Re-reading after a successful click keeps the report from
           printing `done [missing]`, which reads as a contradiction and is really a stale look. */
        const seenNow = (ok && seen === "missing") ? "appeared after the previous step" : seen;
        log.push({ ...st, outcome: ok ? "done" : "NOT FOUND", counts: true, seen: seenNow });
        if (!ok && st.terminal) break;
      }
      if (task.cleanup) {
        const c = await p.eval(task.cleanup).catch(e => "threw: " + e.message);
        if (c !== true) console.log("  ⚠ " + task.id + " cleanup: " + c);
      }
      const counted = log.filter(l => l.counts);
      results.push({
        vp: vp.name, task,
        total: counted.length,
        nav:   counted.filter(l => l.kind === "nav").length,
        work:  counted.filter(l => l.kind === "work").length,
        outside: counted.filter(l => l.kind === "outside").length,
        hunted: log.filter(l => l.outcome === "had to go find it").length,
        misses: log.filter(l => /NOT FOUND|NO MAP/.test(l.outcome)).length,
        log,
      });
    }
  } finally { await p.close(); }
}

/* ── report ──────────────────────────────────────────────────────────────────────────────── */
const pct = r => r.total ? Math.round((r.nav / r.total) * 100) : 0;
console.log("\n  task         viewport   total   nav   work  outside  nav-share  had-to-hunt  missing");
console.log("  " + "─".repeat(84));
for (const r of results)
  console.log("  " + r.task.id.padEnd(12) + r.vp.padEnd(11) +
    String(r.total).padStart(4) + String(r.nav).padStart(6) + String(r.work).padStart(6) +
    String(r.outside).padStart(8) + (pct(r) + "%").padStart(10) +
    String(r.hunted).padStart(12) + String(r.misses).padStart(9));

const stamp = new Date(Number(process.env.TTB_STAMP || 0) || 1).toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = "var/friction/" + (process.env.TTB_STAMP_NAME || "latest");
mkdirSync(dir, { recursive: true });
let md = "# §2bl — the interaction counts\n\n**Lower bounds.** This harness knows where every control is and a person does not; the gap is hesitation, which only a cold run measures.\n\n";
md += "| task | viewport | total | nav | work | outside | nav share | had to hunt | missing |\n|---|---|---|---|---|---|---|---|---|\n";
for (const r of results)
  md += `| ${r.task.id} | ${r.vp} | **${r.total}** | ${r.nav} | ${r.work} | ${r.outside} | **${pct(r)}%** | ${r.hunted} | ${r.misses} |\n`;
for (const r of results) {
  md += `\n## ${r.task.id} @ ${r.vp} — ${r.task.title}\n\n> ${r.task.note}\n\n`;
  for (const l of r.log)
    md += `- ${l.counts ? "**" + l.kind + "**" : "_(not counted)_"} — ${l.what} → ${l.outcome}${l.seen && l.seen !== "—" ? ` \`[${l.seen}]\`` : ""}\n`;
}
writeFileSync(dir + "/report.md", md);
console.log("\n  → " + dir + "/report.md");
