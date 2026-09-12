/* THE FLOWS — the paths a person actually takes, not the paths the code makes easy.
 *
 * Each step is { name, do } where `do` returns false if its control was not there. A step that
 * cannot find its control is a FINDING and the run continues, because "the button was not on the
 * screen at 375x500" is exactly the kind of roughness this is for.
 *
 * Adding a flow: keep it to what a stranger would do unaided. If a step needs knowledge of the
 * codebase to perform, it is not a flow, it is a unit test, and it belongs in test/. */

/* PRODUCTION, AND `TTB_BASE` DOES NOT MAKE A LOCAL RUN MEANINGFUL. Measured 2026-09-01: pointing
   this at `http://127.0.0.1:8080` produced 14 findings and 52 occurrences, and every one was the
   environment — a local server has no `/maps/*.bin` archives (so the basemap reports 1 opaque
   colour and the console fills with 404s) and no `efevnwm`, which is the trip `open-shared` opens.
   A local run is for driving a NEW flow while you write it. A green board only means something
   against the deployed site. */
export const BASE = process.env.TTB_BASE || "https://thistripbtw.us";
const DEMO = "/efevnwm/#k=treeline-downpour-rolling-switchback";

/* Shared steps — the ring and the sheet behave the same on both builder flows. */
/* THE RING CLOSES FROM ITS HUB, NOT FROM THE FAB — `body.ringing #fab{display:none}`, so the FAB
   is not even on screen while the ring is up, and clicking it was always going to miss. The hub is
   the centre button; the veil behind it is the second way out. */
const closeRing = async p => {
  if (!(await p.eval(`document.body.classList.contains("ringing")`))) return true;
  if (await p.click(".hub", 700)) return true;
  return p.click(".ttbr-veil.on", 700);
};
/* TYPING A PLACE AND PICKING IT IS THE FIRST ACT OF THE PRODUCT NOW (D-182), and three flows
   need it. One helper, so a change to the suggestion list cannot quietly break two flows while
   appearing to fix a third. It stashes the row's own label on `window` for the claims to compare
   against — the harness must not assume it knows what the list will offer. */
const pickPlace = q => async p => {
  await p.type("#pFind", q);
  await new Promise(r => setTimeout(r, 1200));
  const shown = await p.eval(`(()=>{const e=document.querySelector(".sg-item");
    if(!e) return false; window.__ttbPicked=(e.querySelector(".sg-name")||e).textContent.trim();
    return true;})()`);
  if (!shown) return false;
  return p.click(".sg-item", 2600);
};
const openList = async p => {
  const shown = `(()=>{const e=document.querySelector(".dl-row:not(.dl-origin),#rail .card");
    return !!e && e.getBoundingClientRect().height > 0;})()`;
  if (await p.eval(shown)) return true;
  return p.click("#sheetGrab");
};

export const FLOWS = [
  {
    id: "build-cold",
    title: "Build a trip from cold — the D-025 bar: a working link in fifteen minutes",
    url: "/new",
    steps: [
      { name: "the hero, before anything is tapped", do: async () => true },
      { name: "tap the primary CTA", do: p => p.click(".hero .cta") },
      { name: "the empty map — what a first-timer is looking at", do: async () => true },
      { name: "tap where you're starting", do: p => p.tapMap(0.42, 0.42) },
      { name: "tap where you're going — that is leg one", do: p => p.tapMap(0.62, 0.60) },
      /* THE RING OPENS ITSELF AFTER THE SECOND TAP, AND IT HIDES THE RAIL — `#railwrap` computes
         to display:none under `body.ringing`, so the trip list is genuinely unreachable until the
         ring is dismissed. That is the real sequence a person performs, so the flow performs it. */
      { name: "dismiss the ring the second tap opened", do: closeRing },
      { name: "open the trip list", do: openList },
      { name: "the dense rail with one leg in it (D-168)", do: async () => true },
      { name: "open the leg — the claim is 'one tap deeper, nothing lost'", do: p => p.click(".dl-row:not(.dl-origin)") },
      /* A zoomed card sets `body.carded`, and `body.carded #fab{display:none}` — so the FAB is
         legitimately gone while a card is open, and asking for it here was the flow's mistake,
         not the product's. Close the card the way a person does, with its own button. */
      { name: "close the leg card", do: p => p.click('[aria-label="Close this leg"],.zoombtn') },
      { name: "open the FAB ring", do: p => p.click("#fab") },
    ],
  },
  {
    id: "build-cards",
    title: "The same build with ?cards=1 — the rail D-168 replaced",
    url: "/new?cards=1",
    steps: [
      { name: "tap the primary CTA", do: p => p.click(".hero .cta") },
      { name: "tap where you're starting", do: p => p.tapMap(0.42, 0.42) },
      { name: "tap where you're going", do: p => p.tapMap(0.62, 0.60) },
      { name: "dismiss the ring the second tap opened", do: closeRing },
      { name: "open the trip list", do: openList },
      { name: "the one-card-per-leg rail, for comparison", do: async () => true },
    ],
  },
  {
    id: "build-find",
    /* §2bs. The FULL cold build on the link Peter actually tests, so the audit covers the whole
       flow rather than its first screen. Mirrors build-cold step for step — the pair at the same
       viewport is the evidence. */
    title: "The whole cold build with ?find=1 — the audited flow (§2bs)",
    url: "/new?find=1",
    steps: [
      { name: "the hero, before anything is tapped", do: async () => true },
      { name: "tap the primary CTA", do: p => p.click(".hero .cta") },
      { name: "the empty map — what a first-timer is looking at", do: async () => true },
      { name: "the ring on an EMPTY map — every wedge should be a move you can make", do: p => p.click("#fab") },
      { name: "close it again", do: closeRing },
      { name: "tap where you're starting", do: p => p.tapMap(0.45, 0.45) },
      { name: "the first tap's answer, settled", do: async () => { await new Promise(r=>setTimeout(r,1200)); return true; } },
      { name: "tap where you're going — that is leg one", do: p => p.tapMap(0.62, 0.60) },
      { name: "dismiss the ring, if D-170 left one", do: closeRing },
      { name: "open the trip list", do: openList },
      { name: "the dense rail with one leg in it", do: async () => true },
      { name: "open the leg — editing, which nothing has taught yet", do: p => p.click(".dl-row:not(.dl-origin)") },
      { name: "close the leg card", do: p => p.click('[aria-label="Close this leg"],.zoombtn') },
      { name: "open the FAB ring — where the untaught moves live", do: p => p.click("#fab") },
    ],
  },
  {
    id: "build-tall",
    /* D-183 PROMOTED THE SHORTER HALF, so this flow flipped from testing the candidate to testing
       the FALLBACK. `?low=1` is now a no-op and the 30dvh sheet is what `build-cold` and every
       other flow already walk; what needs its own coverage is `?tall=1`, the way back to 46dvh,
       because a promotion that deletes its own fallback needs it within the week (D-165/168/170/
       182). Renamed rather than repointed: rule 4 of `improve-loop` is that a flow named after a
       flag runs THAT flag, and `build-low` pointing at `?tall=1` would be the same dishonesty
       that let `build-type` never test `?type=1`. The id change orphans this flow's baseline
       entries by design — they described a sheet that is no longer what ships. */
    title: "The cold build with ?tall=1 — the 46dvh half D-183 replaced, kept reachable",
    url: "/new?tall=1",
    steps: [
      { name: "tap the primary CTA", do: p => p.click(".hero .cta") },
      { name: "tap where you're starting", do: p => p.tapMap(0.45, 0.45) },
      /* THE STEP NAME MATTERS BECAUSE THE FINDING CARRIES IT. This read "on a shorter sheet"
         after D-183 flipped the flow to the TALLER one, so the guard's own output would have
         described the opposite of what it was walking — and a finding's step name is most of what
         a person reads six weeks later. */
      { name: "tap where you're going — the reward, on the 46dvh sheet D-183 replaced", do: p => p.tapMap(0.62, 0.60) },
    ],
  },
  {
    id: "build-type",
    /* 🔴 A FLOW NAMED AFTER A FLAG MUST RUN THAT FLAG ALONE. This one did not — it opened
       `/new?find=1&low=1&type=1` while being called `build-type` — and that is the structural
       hole behind every regression of 2026-09-04. `?type=1` on its own told people to type over
       a screen with NO FIELD ON IT (`body.flowsheet .psearch` is display:none and only
       `body.find` ever showed it), and this flow could not see that, because it always brought
       `find` along. The same combination hid a subtitle with no plate and a field sitting on top
       of the zoom-out button. Three defects, one cause: the rules a flag depends on were being
       supplied by its neighbour, and nothing ever asked it to stand up by itself.
       So: typing is the DEFAULT now (D-182) and `build-cold` covers it plain. This flow keeps
       its combination and is named for what it actually is. When a flag is a promotion
       candidate, give it a flow of its own with nothing else in the URL. */
    title: "The cold build with find+low+type together — the COMBINATION, not the flag",
    url: "/new?find=1&low=1&type=1",
    steps: [
      { name: "the hero, unchanged by this flag", do: async () => true },
      { name: "tap the primary CTA — the cursor should land in the field", do: p => p.click(".hero .cta") },
      { name: "the first screen, asking for something she can already do", do: async () => true },
      { name: "type a place instead of tapping", do: async p => { await p.type("#pFind", "evan"); await new Promise(r=>setTimeout(r,1200)); return true; } },
      { name: "the suggestions, if they come", do: async () => true },
    ],
  },
  {
    id: "pick-place",
    /* 🔴 THE PATH NOTHING WALKED, AND IT WAS THE MAIN ONE. Since D-182 the first act in this
       product is typing a place and picking it from a list. No flow had ever picked one:
       `build-type` types "evan", screenshots the suggestions and stops. On 2026-09-04 Peter
       picked an airport on a handset and the product stored a DIFFERENT PLACE — "SFO — San
       Francisco International Airport" became "San Mateo County, California" — and drew a road
       route between two runways. Every instrument was green, because nothing was missing.
       The steps below therefore assert CLAIMS (a step returning a string is a finding). They are
       the two promises this screen makes: the place you picked is the place you get, and a leg
       between two airports is a flight. */
    title: "Type a place and pick it — the place you picked is the place you get",
    url: "/new?go=1",
    steps: [
      { name: "the build screen, field ready to type into", do: async p =>
          p.eval(`(()=>{const f=document.getElementById("pFind");
            return !!f && f.getBoundingClientRect().height > 0;})()`) },
      { name: "type an airport code", do: p => p.type("#pFind", "ORD") },
      { name: "the suggestions arrive", do: async p => {
          await new Promise(r => setTimeout(r, 1200));
          return p.eval(`(()=>{const e=document.querySelector(".sg-item");
            if(!e) return false; window.__ttbPicked = (e.querySelector(".sg-name")||e).textContent.trim();
            return true;})()`); } },
      { name: "pick the first one", do: p => p.click(".sg-item", 2600) },
      /* NORMALISED, NOT EQUAL. The list shows `IATA · Name` and the trip stores `IATA — Name`,
         so the separator differs by design; for a town the list shows "Evanston" and the trip
         stores "Evanston, IL", so the label is a PREFIX. Comparing letters and digits only,
         a stored name must START with what the row said. "O'Hare, Chicago" fails that against
         "ORD · Chicago O'Hare International Airport", and a county fails it outright. */
      /* ⚠ `window.origin` IS A BUILT-IN — it is the page's URL, not this app's variable, and the
         first version of this claim read it and reported "nothing was stored" against a product
         that was working. The tell was the shape of the failure, not the failure: the DESTINATION
         claim two steps later passed, and a broken pick cannot break the origin while leaving the
         leg intact. Unqualified `origin` resolves to the page's own top-level binding, which
         shadows the built-in. Same trap waits on `name`, `status`, `length` and `top`. */
      { name: "CLAIM: the origin is the place the list offered", do: p => p.eval(`(()=>{
          const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
          const O = (typeof origin !== "undefined" && origin && typeof origin === "object") ? origin
                  : (typeof pending !== "undefined" ? pending : null);
          const want = norm(window.__ttbPicked), got = norm((O||{}).name);
          if(!want) return "the suggestion label was never captured — instrument, not product";
          if(!got)  return "nothing was stored for the origin after picking a suggestion";
          return got.startsWith(want) ? true
            : 'picked "' + window.__ttbPicked + '" and stored "' + (O||{}).name + '" — a different place';})()`) },
      { name: "type a second airport", do: p => p.type("#pFind", "SFO") },
      { name: "the suggestions arrive again", do: async p => {
          await new Promise(r => setTimeout(r, 1200));
          return p.eval(`(()=>{const e=document.querySelector(".sg-item");
            if(!e) return false; window.__ttbPicked2 = (e.querySelector(".sg-name")||e).textContent.trim();
            return true;})()`); } },
      { name: "pick it — that is leg one", do: p => p.click(".sg-item", 2600) },
      { name: "CLAIM: the destination is the place the list offered", do: p => p.eval(`(()=>{
          const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
          const L = (typeof legs !== "undefined" && legs) ? legs : []; if(!L.length) return "picking a second place made no leg";
          const want = norm(window.__ttbPicked2), got = norm((L[L.length-1].to||{}).name);
          return got.startsWith(want) ? true
            : 'picked "' + window.__ttbPicked2 + '" and stored "' +
              (L[L.length-1].to||{}).name + '" — a different place';})()`) },
      { name: "CLAIM: two airports make a flight, not a drive", do: p => p.eval(`(()=>{
          const L = (typeof legs !== "undefined" && legs) ? legs : []; if(!L.length) return "no leg to read a mode from";
          const m = L[L.length-1].mode;
          return m === "fly" ? true
            : 'a leg between two airports came out as "' + m + '" — a road route between runways';})()`) },
      { name: "open the leg — the mode is one tap away either way", do: p => p.click(".dl-row:not(.dl-origin)") },
    ],
  },
  {
    id: "edit-leg",
    /* MOVE 3 OF SIX, AND THE ONE MOST RECENTLY CLAIMED AS TAUGHT. `improve-loop`'s scoreboard
       marked "change how / when / who" taught on 2026-09-04 because a chevron and a one-time hint
       now point at the leg card. A scoreboard entry that nothing verifies is a wish, so this walks
       it: open the row, read the modes, change one, close, and check the change survived. The
       repo's own audit called this card the best screen in the product — which is exactly why
       nobody had checked that it still works. */
    title: "Open a leg and change how you are travelling — scoreboard move 3",
    url: "/new?go=1",
    steps: [
      { name: "type the origin and pick it", do: pickPlace("Evanston") },
      { name: "type the destination and pick it — that is leg one", do: pickPlace("Madison") },
      { name: "CLAIM: two towns make a drive", do: p => p.eval(`(()=>{
          const L=(typeof legs!=="undefined"&&legs)?legs:[];
          if(!L.length) return "picking two towns made no leg";
          return L[L.length-1].mode==="drive" ? true
            : 'two towns came out as "'+L[L.length-1].mode+'" rather than a drive';})()`) },
      { name: "open the leg from the list", do: async p => { await openList(p);
          return p.click(".dl-row:not(.dl-origin)", 1200); } },
      { name: "CLAIM: the card offers the ways to travel, in words", do: p => p.eval(`(()=>{
          const chips=[...document.querySelectorAll(".card .chip[data-m]")]
            .filter(e=>e.getBoundingClientRect().height>0);
          if(chips.length<5) return "the leg card showed "+chips.length+" modes; HOW being one tap is the point of this screen";
          const wordless=chips.filter(e=>!(e.textContent||"").trim()).length;
          return wordless ? wordless+" mode chips carry an icon and no word" : true;})()`) },
      { name: "tap Fly", do: p => p.click('.card .chip[data-m="fly"]', 1200) },
      { name: "CLAIM: tapping Fly made it a flight", do: p => p.eval(`(()=>{
          const L=(typeof legs!=="undefined"&&legs)?legs:[];
          if(!L.length) return "the leg went away while its card was open";
          return L[L.length-1].mode==="fly" ? true
            : 'tapped Fly and the leg is still "'+L[L.length-1].mode+'"';})()`) },
      /* THE CLAIM THIS FLOW WAS WRITTEN AND IMMEDIATELY EARNED. Tapping a chip calls render(),
         which rebuilds the rail and destroyed the open card — so you set the mode and got thrown
         back to the list, three round trips for mode + when + who. Fixed 2026-09-04 by reopening
         the same leg; this is what stops it coming back. */
      { name: "CLAIM: changing the mode did not throw you out of the card", do: p => p.eval(`(()=>{
          const c=document.querySelector(".card.zoom");
          if(c) return true;
          return document.querySelector(".card")
            ? "the card is open but no longer zoomed after changing the mode"
            : "changing the mode closed the leg card — setting how, when and who is now three trips";})()`) },
      { name: "close the card", do: p => p.click(".card.zoom .zoombtn", 1200) },
      /* THE CLOSE IS THE HALF THAT BREAKS. Closing calls render(), which rebuilds the list from
         state — so a change that lived only in the card's DOM disappears here and nowhere else. */
      { name: "CLAIM: the change survived the close, in the state AND on the list", do: p => p.eval(`(()=>{
          const L=(typeof legs!=="undefined"&&legs)?legs:[];
          if(!L.length) return "the leg vanished when its card closed";
          if(L[L.length-1].mode!=="fly") return 'the mode reverted to ' + L[L.length-1].mode + ' when the card closed';
          const row=[...document.querySelectorAll(".dl-row:not(.dl-origin)")].pop();
          const t=row?(row.textContent||"").toLowerCase():"";
          return /fly/.test(t) ? true
            : 'the leg is a flight and its row still reads "'+(row?row.textContent.trim():"—")+'"';})()`) },
    ],
  },
  {
    id: "keep-it",
    /* THE MONEY MOMENT, WALKED UP TO THE THRESHOLD AND NOT ACROSS. This flow must never reach
       Stripe: those are LIVE payment links, and a harness that loads one on every deploy is both
       rude and a way to end up explaining traffic to a payment processor. So it stops at the tier
       choice and never picks one.
       ⚠ THE GUARD IN STEP 4 IS LOad-BEARING. `openKeepRing()` falls through to `keepIt("keep")`
       — a direct `location.href` to a live payment link — whenever the ring module is missing. If
       ring.js ever fails to load, a naive click here would send the harness to checkout. The step
       checks the ring exists FIRST and reports rather than clicking.
       Nothing here fires a native dialog either: `keepIt`'s confirm() is one step further on, and
       an unhandled JS dialog blocks the whole CDP session — a hang with no error. Keep it that
       way, or teach cdp.mjs to answer dialogs before extending this flow. */
    title: "Reach the money moment without crossing it — the draft must survive",
    url: "/new?go=1",
    steps: [
      { name: "type the origin and pick it", do: pickPlace("Evanston") },
      { name: "type the destination and pick it", do: pickPlace("Madison") },
      { name: "CLAIM: the trip is on the device BEFORE any money screen", do: p => p.eval(`(()=>{
          let raw=null;
          try{ raw=localStorage.getItem("ttb_scratch"); }
          catch(e){ return "localStorage is unreadable — cannot tell whether a draft survives checkout"; }
          if(!raw) return "nothing was saved before the keep step; leaving for Stripe would lose the trip";
          try{ JSON.parse(raw); }catch(e){ return "the saved draft is not readable JSON"; }
          return /evanston/i.test(raw) ? true : "a draft was saved but the origin is not in it";})()`) },
      /* THE GUARD IS STILL LOAD-BEARING, and D-190 moved what it has to check. openKeepRing()
         falls through to keepIt("keep") — a direct location.href to a LIVE payment link — only
         when neither the sheet nor the ring is available. The sheet is the default now, so the
         sheet is what must exist. */
      { name: "tap Keep — but only if something is there to catch it", do: async p => {
          const ok = await p.eval(`(()=>{ try{
            return document.body.classList.contains("keepsheet")
                || (typeof theRing==="function" && !!theRing()); }catch(e){ return false; } })()`);
          if (!ok) return "neither the keep sheet nor the ring is available, and openKeepRing() falls through to a LIVE payment link — the harness stopped rather than open Stripe";
          return p.click("#keepBtn", 1400); } },
      /* CONTAINER-AGNOSTIC ON PURPOSE. This asserted .ttbr .seg — the ring's wedges — and went
         red the moment D-190 made the sheet the default, which is a stale FLOW rather than a
         defect. Pin the PROMISE, not the markup carrying it: three priced terms, a way to compare,
         and — the half the ring could not hold — each option saying what that tier ADDS. Reads the
         sheet's plates or the ring's wedges, whichever is on screen. */
      { name: "CLAIM: the choice names the terms, what each adds, and a way to compare", do: p => p.eval(`(()=>{
          const plates=[...document.querySelectorAll(".keeptier")];
          const seg=[...document.querySelectorAll(".ttbr .seg")].map(e=>e.getAttribute("aria-label")||"");
          const opts = plates.length ? plates.map(b=>b.textContent.replace(/\s+/g," ").trim()) : seg;
          if(!opts.length) return "tapping Keep opened no choice at all";
          const priced=opts.filter(t=>t.indexOf("$")!==-1);
          if(priced.length<3) return "the keep choice shows "+priced.length+" priced options; there are three tiers";
          if(plates.length){
            const mute=plates.filter(b=>!((b.querySelector(".kt-adds")||{}).textContent||"").trim());
            if(mute.length) return mute.length+" tier(s) name a price and never say what that tier adds — the thing the ring could not carry";
          }
          const compare = /compare/i.test(opts.join(" "))
            || !!document.querySelector('.keepfoot a[href*="what-you-get"]');
          return compare ? true : "three prices and nothing that says what differs between them";})()`) },
      { name: "back out of it", do: closeRing },
      { name: "CLAIM: backing out of checkout did not cost the trip", do: p => p.eval(`(()=>{
          const L=(typeof legs!=="undefined"&&legs)?legs:[];
          if(!L.length) return "the trip was gone after backing out of the keep screen";
          let raw=null; try{ raw=localStorage.getItem("ttb_scratch"); }catch(e){}
          return raw ? true : "the leg is on screen but nothing is saved — a reload would lose it";})()`) },
    ],
  },
  {
    id: "crew",
    /* MOVE 4 OF SIX — "a second vehicle" (D-011), the last move nothing taught. `?crew=1` ALONE,
       because rule 4 of `improve-loop` exists precisely because `build-type` never ran its own
       flag by itself. What this walks is the chain: a second person on a leg is the moment
       "does everyone travel together?" becomes a real question, so that is where the move is
       introduced — not after the first leg, where it would be trivia. */
    /* D-184 PROMOTED THIS, so the flow walks the DEFAULT — `?crew=1` is now a no-op and pointing
       at it would test nothing, the same trap that let `build-type` spend its life never running
       `?type=1` alone. The fallback is `?perleg=1`. */
    title: "A second vehicle, and who is coming — the default since D-184 (move 4)",
    url: "/new?go=1",
    steps: [
      { name: "the ring before there is a trip", do: p => p.click("#fab", 1200) },
      /* THE CONTEXT-TUNING CLAIM. Peter, 2026-09-01: "the FAB needs to be fully tuned to context
         — so menus match need, always." On the default page it offered Undo and Hide before there
         was anything to undo or hide, because that tuning lived inside the ?find=1 branch. */
      { name: "CLAIM: it does not offer Undo before there is anything to undo", do: p => p.eval(`(()=>{
          const seg=[...document.querySelectorAll(".ttbr .seg")].map(e=>(e.getAttribute("aria-label")||"").toLowerCase());
          if(!seg.length) return "the FAB opened no ring at all";
          const dead=seg.filter(s=>/undo|hide|show/.test(s));
          return dead.length ? "the ring offers "+dead.join(" and ")+" on an empty trip" : true;})()`) },
      { name: "close it", do: closeRing },
      { name: "type the origin and pick it", do: pickPlace("Evanston") },
      { name: "type the destination and pick it", do: pickPlace("Madison") },
      { name: "open the ring now there is a trip", do: p => p.click("#fab", 1200) },
      { name: "CLAIM: a second vehicle is offered once one is possible", do: p => p.eval(`(()=>{
          const seg=[...document.querySelectorAll(".ttbr .seg")].map(e=>e.getAttribute("aria-label")||"");
          if(!seg.length) return "the FAB opened no ring at all";
          return /route/i.test(seg.join(" ")) ? true
            : "with a leg on the map the ring still does not offer a second route: "+seg.join(" · ");})()`) },
      { name: "close it", do: closeRing },
      { name: "open the leg", do: async p => { await openList(p);
          return p.click(".dl-row:not(.dl-origin)", 1200); } },
      { name: "add the first person", do: p => p.click(".card.zoom .addp", 900) },
      { name: "name them", do: p => p.type(".addp-in", "Mel") },
      { name: "tap away to commit", do: p => p.click(".card.zoom .ctype", 900) },
      { name: "add a second person — the moment the question becomes real", do: p => p.click(".card.zoom .addp", 900) },
      { name: "name them", do: p => p.type(".addp-in", "Sam") },
      { name: "tap away to commit", do: p => p.click(".card.zoom .ctype", 1200) },
      { name: "CLAIM: two people on a leg introduces the second vehicle", do: p => p.eval(`(()=>{
          const c=document.querySelector(".card.zoom");
          if(!c) return "the card closed while adding people — every field in it used to eject you";
          const h=document.querySelector(".crewhint");
          if(!h) return "two people are on the leg and nothing says they could travel separately";
          const r=h.getBoundingClientRect();
          if(r.height < 44) return "the line introducing a second vehicle is "+Math.round(r.height)+"px tall";
          return (r.top >= 0 && r.bottom <= innerHeight) ? true
            : "the line is there but off screen at "+Math.round(r.top);})()`) },
    ],
  },
  {
    id: "overzoom",
    /* §2bv. ONE CENTRE, FOUR ZOOMS. The world archive is z0-7, so z8..z11 is one to four levels of
       overzoom. If the false water scales with the overzoom factor, that is the mechanism.
       SCREENSHOTS, NOT PIXEL SAMPLING: the sampler gave three contradictory answers in one
       session (13.8%, then 14.4% with the layers removed, then 0% everywhere) and the artifact is
       unmistakable in an image. Instrument first, then the product. */
    title: "False water vs overzoom factor — one centre, z8 to z11 (§2bv)",
    url: "/efevnwm/#k=treeline-downpour-rolling-switchback",
    steps: [
      /* PIN THE SKY AND RELOAD. theme.js picks night/dawn/day/dusk off the WALL CLOCK, so a run at
         02:00 renders a dark map and a run at 13:00 a light one — and the reported bug is a DAY
         bug. A 02:51 run is also what made a pixel sampler report 0% water at every zoom: it was
         counting #cbdde7 while the map was painting #0D1F28. Pin it, reload so the layer is built
         with the right theme, and change NOTHING else — hiding chrome to "clean up" the shot left
         the basemap unrendered on the previous attempt. */
      { name: "pin the sky to day and reload", do: async p => {
          await p.eval(`(()=>{ try{ localStorage.setItem("ttb_theme","light"); }catch(e){} location.reload(); return 1;})()`);
          await new Promise(r => setTimeout(r, 6000));
          return true; } },
      { name: "z8 — one level of overzoom", do: async p => {
          await p.eval(`(async()=>{map.setView([39.35,-120.35],8);await new Promise(r=>setTimeout(r,5200));return 1;})()`); return true; } },
      { name: "z9 — two levels", do: async p => {
          await p.eval(`(async()=>{map.setView([39.35,-120.35],9);await new Promise(r=>setTimeout(r,5200));return 1;})()`); return true; } },
      { name: "z10 — three levels", do: async p => {
          await p.eval(`(async()=>{map.setView([39.35,-120.35],10);await new Promise(r=>setTimeout(r,5200));return 1;})()`); return true; } },
      { name: "z11 — four levels", do: async p => {
          await p.eval(`(async()=>{map.setView([39.35,-120.35],11);await new Promise(r=>setTimeout(r,5200));return 1;})()`); return true; } },
    ],
  },
  {
    id: "landing",
    title: "The landing page — the first thing a stranger meets",
    url: "/",
    steps: [
      /* A MARKETING PAGE IS A DIFFERENT SHAPE OF FLOW AND THE STEPS SAY SO. There is nothing to
         drive: the only question is whether what a person needs is on screen, reachable, and big
         enough to hit — at each depth they scroll to. So the flow scrolls the page the way a thumb
         does and lets the probe answer at each stop. CLAUDE.md records a 375x500 failure here that
         812 could not see: the fixed controls sat on the words. */
      { name: "above the fold — the sign, the promise, the first ask", do: async () => true },
      { name: "the primary CTA — tap it, the way a stranger would", do: p => p.click(".cta") },
      { name: "where that landed", do: async () => true },
      { name: "back on the landing page, the second ask", do: async p => { await p.goto(BASE + "/", 2500); return p.scrollTo(560); } },
      { name: "the phone mockup — is its map drawn, or a grey box", do: p => p.scrollTo(660) },
      { name: "midway — the explainer band", do: p => p.scrollTo(1400) },
      { name: "the deep CTA", do: p => p.scrollTo(3300) },
      { name: "the price, and the foot of the page", do: p => p.scrollTo(3820) },
    ],
  },
  {
    id: "open-shared",
    title: "Open a link somebody sent you — the path a viewer takes",
    url: DEMO,
    steps: [
      { name: "landing on a full-screen map behind a shut sheet", do: async () => true },
      /* `#openSheet` — the trip page's pill, NOT `/new`'s `#sheetGrab`. The two pages have
         different sheets and the flow was using the builder's handle on the viewer, so it clicked
         nothing. It looked like a defect for a while: `#sheet` itself is `translateY(100%)` when
         shut, which measures as fully off-screen at EVERY viewport — correct, because the pill is
         a separate element that stays behind. Measuring the wrong element made a working design
         read as broken at 390x664, 390x844 and 1372x869 alike, and "broken at every size" should
         have been the tell. */
      { name: "find the list behind the pill", do: p => p.click("#openSheet") },
      { name: "open the FAB ring", do: p => p.click("#fab") },
      { name: "take it — every format on one sheet", do: p => p.click("[aria-label*='ake it'],[aria-label*='ake-it']") },
    ],
  },
  {
    id: "describe",
    title: "Describe it in a sentence — the second way in",
    url: "/new",
    steps: [
      /* The describe route is offered ON THE HERO, so tapping the primary CTA first leaves the
         only place it exists. And since D-170 promoted calm, it is ONE TAP DEEPER — behind
         "other ways to start". That is the trade calm makes, so the flow walks it rather than
         reaching past it: this step now measures how far the second way in actually is. */
      { name: "open the other ways in", do: async p =>
          (await p.eval(`(()=>{const e=document.querySelector(".hero-alt");
            return !!e && e.getBoundingClientRect().height > 0;})()`)) || p.click(".calm-more.h") },
      { name: "take the describe route", do: p => p.click(".hero-alt") },
      { name: "type a trip", do: p => p.type("#askText", "drive to portland thursday") },
      { name: "send it", do: p => p.click("#askForm .chat-send") },
    ],
  },
  {
    id: "describe-legs",
    /* 🔴 THE SAME PANEL, WITH A TRIP ALREADY IN IT — the case `describe` structurally cannot reach.
       That flow enters from the HERO, so the trip is always empty when the panel opens. On
       2026-09-10 Peter photographed the panel's textarea drawn straight across the trip list; the
       overlap was 48px at 390x844 and it needs legs to happen at all, so twelve flows at two
       heights had never once seen it.
       A SEPARATE FLOW RATHER THAN TWO EXTRA STEPS IN `describe`, because the two paths are
       genuinely different: from the hero, describe is behind "other ways to start"; mid-build it
       is a FAB wedge, since the typing-first default (D-182) hides both `.pask` and the prompt's
       "or start another way". Bolting legs onto `describe` would have tested neither path
       honestly — rule 4 of `improve-loop`, applied to a flow instead of a flag. */
    title: "Describe it with a trip already on the map — the panel the empty flow never sees",
    url: "/new?go=1",
    steps: [
      { name: "type the origin and pick it", do: pickPlace("Evanston") },
      { name: "type the destination and pick it — that is leg one", do: pickPlace("Madison") },
      { name: "open the ring, where describe lives once you are building", do: p => p.click("#fab", 1200) },
      { name: "take the describe route", do: p => p.click('.ttbr .seg[aria-label="Describe"]', 1400) },
      { name: "CLAIM: the panel does not draw over the trip list", do: p => p.eval(`(()=>{
          const ta=document.getElementById("askText"), row=document.querySelector(".dl-row");
          if(!ta) return "the describe panel did not open";
          if(!row) return "the trip list is gone while the panel is open";
          const a=ta.getBoundingClientRect(), r=row.getBoundingClientRect();
          const over=Math.round(Math.max(0, Math.min(a.bottom,r.bottom)-Math.max(a.top,r.top)));
          if(over>0) return over+"px of the trip list is drawn under the text box — a flex child shrinks, its textarea does not";
          const mid=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
          return (mid && (mid===row || row.contains(mid))) ? true
            : "the first list row hit-tests to " + (mid ? (mid.id||mid.className||mid.tagName) : "nothing");})()`) },
      { name: "CLAIM: the list is still worth having open", do: p => p.eval(`(()=>{
          const rail=document.getElementById("rail"); if(!rail) return "no rail";
          const h=Math.round(rail.getBoundingClientRect().height);
          return h >= 96 ? true : "the trip list is "+h+"px with the panel open — pinning the panel crushes it, which is the OTHER half of this bug";})()`) },
      { name: "type a trip into it", do: p => p.type("#askText", "then portland thursday") },
      { name: "send it", do: p => p.click("#askForm .chat-send") },
    ],
  },
];

/* CLAUDE.md: "MEASURE AT TWO HEIGHTS: 375x812 AND 375x500." 812 is the one height at which the
   failures do not exist — a tall phone with no browser chrome. 500 is an iPhone SE with the URL
   bar showing, and any phone in landscape. A status that says "verified at 375x812" is half a
   status, so the runner does both and the report says both. */
/* PETER'S ACTUAL PHONE, made the default 2026-08-11. It reported `map 390x655` in a `?pmdiag=1`
   readout from the handset, so it is a 390pt device (iPhone 12-15) — the harness had been guessing
   an SE all day, and 375 is a width nobody here is holding.
   Both states, because Safari's chrome is not optional and cannot be hidden from a web page:
   844 is the standalone/no-chrome height, 664 is what you actually get with the URL bar up. */
const DEFAULT_VIEWPORTS = [
  { name: "390x844", w: 390, h: 844, note: "Peter's phone, no browser chrome" },
  { name: "390x664", w: 390, h: 664, note: "Peter's phone as it actually is — Safari, URL bar up" },
];

/* `--vp 375x812,375x500` overrides them, and that OLD pair is worth keeping in the back pocket:
   375x500 is the band where this repo's viewport failures have historically lived (an SE with
   chrome up, or a phone in landscape), and 664 is 164px taller than that. Re-measured on the day
   of the switch it found nothing extra — but a clean result today is not a guarantee for tomorrow,
   so run `--vp 375x500` before shipping anything that changes a fixed-position shell.
   Peter's own phone in LANDSCAPE is 844x390, shorter than either default. */
export const VIEWPORTS = (() => {
  const i = process.argv.indexOf("--vp");
  if (i < 0 || !process.argv[i + 1]) return DEFAULT_VIEWPORTS;
  const out = [];
  for (const part of process.argv[i + 1].split(",")) {
    const m = /^(\d{2,4})x(\d{2,4})$/.exec(part.trim());
    if (!m) throw new Error(`--vp wants WxH, got "${part}"`);
    out.push({ name: part.trim(), w: +m[1], h: +m[2], note: "requested with --vp" });
  }
  return out;
})();
