/* WHAT THIS CAN AND CANNOT ANSWER — read before trusting a green run.
 *
 * It cannot tell you where somebody hesitated. Hesitation is the finding a moderated cold run —
 * one non-designer, watched, building a trip — exists to produce, and no harness replaces it.
 *
 * It CAN tell you every mechanical way a step is rough, and those are the ones that survive
 * being counted: a control under 44px, a control below the fold on a shell that cannot scroll,
 * a step that needs more taps than it looks like, a control that is present but dead, an error
 * thrown into an empty console. Every rule below is one this repo already committed to and has
 * been burned by — see DESIGN.md §3 and CLAUDE.md's "MEASURE AT TWO HEIGHTS".
 *
 * The whole probe is one expression so it can be handed to Runtime.evaluate as-is. */

export const PROBE = `(() => {
  const out = { url: location.pathname + location.search, vp: [innerWidth, innerHeight] };

  /* Rule 0 from the verify-render skill: if the instrument is frozen, every number below is a
     stale one and the report has to say so instead of listing findings that are not real. */
  out.instrument = { visible: document.visibilityState === "visible" };
  {
    const p = document.createElement("div");
    p.style.cssText = "position:fixed;top:0;left:0;width:8px;height:8px;pointer-events:none";
    document.body.appendChild(p); p.style.transform = "translateY(700px)";
    out.instrument.layoutLive = Math.round(p.getBoundingClientRect().top) > 600;
    p.remove();
  }

  const vis = el => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
    if (el.hasAttribute("hidden")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = el => (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.value || el.tagName)
    .trim().replace(/\\s+/g, " ").slice(0, 44) || el.tagName;

  /* EXEMPTIONS, AND EACH ONE IS A REAL CATEGORY RATHER THAN A CONVENIENCE.
     The first run produced 106 tap-target findings and 100 of them were these — attribution links
     (legally required, never meant to be thumbed), map markers (map CONTENT, sized by the
     cartography, and the numbered pins are deliberately 30px), and the hidden file input that a
     visible button proxies for. A report where the real findings are 6% of the rows is a report
     nobody reads twice, so these are classified out rather than counted. Map markers are still
     REPORTED, just under their own heading, because "the pins are small" is a design question and
     not the same question as "this button is too small to hit". */
  const exempt = el =>
    el.closest(".leaflet-control-attribution") ||
    el.classList.contains("vh") || el.closest(".vh") ||
    (el.tagName === "INPUT" && el.type === "file") ||
    /* A CONTROL YOU CANNOT TAP IS NOT A TAP TARGET. On a view link the whole card is
       pointer-events:none — those date fields measured 141x25 and were reported for two runs
       before anyone asked whether a finger could reach them at all. It cannot; there is nothing
       to fix. Checked on the element AND its ancestors, since the rule is usually set on a
       container. */
    getComputedStyle(el).pointerEvents === "none" ||
    (el.parentElement && getComputedStyle(el.parentElement).pointerEvents === "none");
  const isMarker = el => el.closest(".leaflet-marker-icon,.leaflet-div-icon,.leaflet-marker-pane");

  const all = [...document.querySelectorAll("button,a[href],input,select,textarea,[role=button],[onclick]")].filter(vis);
  const ctrls = all.filter(el => !exempt(el) && !isMarker(el));
  out.controls = ctrls.length;
  out.markers = all.filter(isMarker).length;
  out.markersSmall = [...new Set(all.filter(isMarker).map(el => { const r = el.getBoundingClientRect();
    return Math.round(r.width) + "\u00d7" + Math.round(r.height); }))].filter(d => {
      const [w, h] = d.split("\u00d7").map(Number); return w < 44 || h < 44; });

  /* 44px is DESIGN.md §3, non-negotiable, and the sweep that established it found several at 32-42.
     MEASURE THE HIT AREA, NOT THE BOX. The first pass read getBoundingClientRect and would have
     gone on reporting five controls forever after they were fixed, because the standard fix grows
     the touch region with a centred pseudo-element and deliberately does NOT move the box. So
     hit-test instead: from the centre, probe +/-21px on each axis and ask whether the point still
     lands on this control. That is technique-agnostic — padding, a pseudo overlay or a bigger box
     all pass, and all three genuinely work under a thumb.
     A point outside the viewport returns null and counts as a miss, which is correct: you cannot
     tap what is off screen. */
  /* AN ANCESTOR IS NOT A HIT. The first version accepted t.contains(el), which let a 20px link
     inside a 46px bar pass because the tap landed on the bar — and tapping the bar does nothing.
     A hit is the control itself or something inside it. */
  const hits = (el, x, y) => { const t = document.elementFromPoint(x, y);
    return !!t && (t === el || el.contains(t)); };
  out.small = ctrls.map(el => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      /* 20.5, not 22. A box measured at exactly 44.00 fails a +/-22 probe and can fail +/-21 too,
         because the outermost pixel column hit-tests as the PARENT — measured 2026-08-11 on a
         footer link whose rect was 44.00x44.00 and whose right-edge probe returned the <footer>.
         That is sub-pixel rasterisation, not reachability: 44px means the box is 44px, and nobody
         taps the last pixel column. A 41px span still fails anything genuinely undersized. */
      const okV = hits(el, cx, cy - 20.5) && hits(el, cx, cy + 20.5);
      const okH = hits(el, cx - 20.5, cy) && hits(el, cx + 20.5, cy);
      return { what: label(el),
               w: okH ? Math.max(Math.round(r.width), 44) : Math.round(r.width),
               h: okV ? Math.max(Math.round(r.height), 44) : Math.round(r.height),
               box: Math.round(r.width) + "x" + Math.round(r.height) }; })
    .filter(c => c.h < 44 || c.w < 44);

  /* BELOW THE FOLD IS NOT A DEFECT. UNREACHABLE IS. That distinction is the entire lesson of
     2026-08-05: an overflowing list that scrolls is fine, a fixed app shell that clips is not.
     So for anything under the fold, walk up and ask whether ANY ancestor can actually scroll. */
  const reachable = el => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return true;
      n = n.parentElement;
    }
    return document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 4;
  };
  /* AND A CONTROL INSIDE A SHUT SHEET IS NOT CLIPPED EITHER — IT IS PUT AWAY.
     The first clean run called 360 of these clipped, and nearly all were the trip panel's contents
     sitting below the fold because the panel was closed, which is the design working. What makes
     them distinguishable is that a sheet is moved by a TRANSFORM or a height class, not by
     overflowing: so if any ancestor is a sheet-like container that is currently collapsed, the
     control is filed as STOWED and reported separately. **A stowed control that never becomes
     reachable after its opener is tapped IS a defect** — but that is a question about the next
     step, not this one, and the runner is what compares them. */
  const stowed = el => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const cls = (n.className || "") + " " + (n.id || "");
      if (/railwrap|sheet|drawer|panel/i.test(cls)) {
        const s = getComputedStyle(n);
        if (s.transform !== "none" || /sh-shut|shut|collapsed/.test(cls)) return true;
        if (n.getBoundingClientRect().height < innerHeight * 0.25) return true;
      }
      n = n.parentElement;
    }
    return false;
  };
  out.belowFold = ctrls.filter(el => el.getBoundingClientRect().top > innerHeight - 8)
    .map(el => ({ what: label(el), top: Math.round(el.getBoundingClientRect().top),
                  reachable: reachable(el), stowed: stowed(el) }));
  out.clipped = out.belowFold.filter(c => !c.reachable && !c.stowed);
  out.stowed = out.belowFold.filter(c => c.stowed).length;

  /* A control that is visible, sized and has no handler of any kind. Present-but-dead is the
     failure that reads as "I tapped it and nothing happened", which is worse than a missing
     button because it costs trust as well as a tap. Anchors and inputs are exempt. */
  out.dead = ctrls.filter(el => {
    if (el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return false;
    if (el.getAttribute("onclick") || el.onclick) return false;
    if (el.form || el.type === "submit") return false;
    if (el.closest("label")) return false;
    return !(el.__events || el.dataset.wired);   // best-effort; addEventListener is invisible from here
  }).length;

  out.text = [...document.querySelectorAll("h1,h2,p,.prompt b,.prompt span,.hint,.reassure")]
    .filter(vis).map(e => e.textContent.trim().replace(/\\s+/g, " ")).filter(t => t && t.length < 120).slice(0, 8);

  /* The map is the product on both pages, so its render state is part of every step's report —
     and painted-but-invisible is checked separately from painted, because that is D-167. */
  const cvs = [...document.querySelectorAll(".leaflet-tile-pane canvas")];
  if (cvs.length) {
    const op = [...new Set(cvs.map(c => getComputedStyle(c).opacity))];
    let opaque = 0; const seen = new Set();
    for (const c of cvs) { try { const g = c.getContext("2d"); if (!g) continue;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i]+","+d[i+1]+","+d[i+2]+","+d[i+3]);
      } catch (e) {} }
    opaque = [...seen].filter(s => !s.endsWith(",0")).length;
    out.map = { tiles: cvs.length, opacity: op, opaqueColours: opaque,
                drewButInvisible: opaque > 0 && op.every(o => +o === 0) };
  } else out.map = { tiles: 0 };

  /* -- 2bt ASSERTIONS. Each exists because a real regression got past every other guard on
     2026-09-01, and each names the one it would have caught. They measure MECHANICS. None of
     them can see what three cold runs found -- read the top of this file.
     NO BACKTICKS ANYWHERE BELOW: this whole probe is one template literal, so a backtick in a
     COMMENT ends it. That cost one build of this very block. */

  out.sky = document.documentElement.dataset.sky || "";

  /* A1 -- THE USABLE MAP BAND. frameTrip() pads fitBounds by the top and bottom chrome, and on
     2026-09-01 the padding exceeded the viewport: 262 + 412 on a 664 screen, a band of MINUS
     TEN, so the route rendered as a sliver at the edge. Walk the centre column and ask what a
     finger actually meets. EXCLUDE BY ANCESTOR, NOT BY HIT: .prompt is pointer-events:none, so
     taps pass through while its plates are visually opaque -- hit-testing alone calls that
     column clear and misses the defect entirely. 150 is MIN_BAND in public/new.html; if one
     number moves, move both. */
  {
    const chrome = ".prompt,.bar,.railwrap,.keepbar,#fab,.hero,.leaflet-control";
    const x = Math.round(innerWidth / 2);
    let best = 0, run = 0, bestEnd = 0;
    for (let y = 0; y < innerHeight; y += 4) {
      const t = document.elementFromPoint(x, y);
      const clear = !!t && !t.closest(chrome) &&
                    (t.id === "map" || !!t.closest("#map,.leaflet-container"));
      if (clear) { run += 4; if (run > best) { best = run; bestEnd = y; } }
      else run = 0;
    }
    /* SCOPED after the first run, which fired 0px on "open the leg" ten times. A zoomed leg card
       is SUPPOSED to cover the map -- that is the card working, and an assertion that calls it a
       defect is measuring the wrong moment. Only the map-first states are judged. The threshold
       is untouched; the scope is what was wrong. */
    /* ...and the ring, for the same reason: body.ringing is a deliberate full-map overlay, and it
       already hides the rail and the prompt by design. An overlay covering the map is the overlay
       working; the band question is only meaningful in the map-first states. */
    /* ...and body.asking, added 2026-09-10 with the describe-legs flow. toggleAsk's own comment
       states the rule this exemption follows: "the panel owns the map while it is up" — which is
       why body.asking hides the prompt and the FAB, and why the sheet goes full underneath it.
       Judging the clear band while a panel is deliberately covering the map measures the wrong
       moment, exactly as with a zoomed card or the ring. 2bu's rule holds: a red is a real defect
       or a MIS-SCOPED assertion, never a threshold to widen — and this is the second kind. The
       assertion still fires everywhere it should; build-tall's accepted 112px is the control.
       NO BACKTICKS IN THIS FILE'S COMMENTS: the whole probe is one template literal and a
       backtick ends it. That is what the first version of this comment did. */
    const carded = document.body.classList.contains("carded") || !!document.querySelector(".card.zoom")
                || document.body.classList.contains("ringing")
                || document.body.classList.contains("asking");
    out.band = { px: best, top: Math.max(0, bestEnd - best), bottom: bestEnd, carded: carded,
                 hasLeg: document.body.classList.contains("hasleg") && !carded };
    if (best > innerHeight) out.band.impossible = true;   /* verify-render: an impossible number is the instrument */
  }

  /* A3 -- TEXT BARE ON THE SKY. DESIGN.md section 3 and 2ax: the board is what keeps text
     legible on every sky, and a quiet line is quiet by being SMALL, never by being faint. Two
     failures of exactly this shipped -- .calm-more resolving to a var(--muted) fallback, and a
     subtitle written as bare ink on the night gradient on 2026-09-01. Walk up for a plate; if
     the walk reaches body there is none. Computed style cannot see a gradient, so this is the
     WALK and deliberately not a pixel sample -- sampling paint is the stale-paint trap. */
  {
    const skipBare = el => el.closest(".hero,.leaflet-control-attribution,.sign,.brand-logo");
    const opaque = el => {
      const st = getComputedStyle(el);
      if (st.backgroundImage && st.backgroundImage !== "none") return true;
      const m = (st.backgroundColor || "").match(/rgba?\\(([^)]+)\\)/);
      if (!m) return false;
      const parts = m[1].split(",").map(Number);
      return parts.length < 4 || parts[3] >= 0.8;
    };
    out.bare = [...document.querySelectorAll("#pTitle,#pSub,.prompt b,.prompt span,.calm-more,.reassure span,.hint,.popen-h,.demo-link")]
      .filter(el => vis(el) && (el.textContent || "").trim() && !skipBare(el))
      .filter(el => { let n = el; while (n && n !== document.body) { if (opaque(n)) return false; n = n.parentElement; } return true; })
      .map(el => label(el));
  }

  /* A4 -- ONE CONTROL ON TOP OF ANOTHER. The instruction pill sat over the zoom plus button and
     the 44px check passed it, because a fully covered 44px control still measures 44x44: that
     check finds SMALL, never COVERED. Geometric rather than hit-tested, because
     pointer-events:none makes the two disagree and the visual overlap is the one that hid it. */
  {
    /* SCOPED after the first run, which produced 60 pairs, nearly all of them controls inside a
       COLLAPSED sheet -- a shut panel stacks its rows on one rect, so everything "covers" almost
       everything at 91%. The probe already knows what stowed means; overlap has to use it, or it
       reports the sheet being shut as a defect. Same category as the 106 tap-target findings this
       file already exempts: a real class, not a convenience. */
    /* AND ONLY WITHIN ONE LAYER. The second run still produced 52 pairs and they were a modal
       sitting over the page: "Add a stay covers 79% of Share", "Everything.zip covers 91% of
       Close". A sheet covering the keepbar beneath it is a sheet working -- the defect this
       assertion is for is a control covering its PEER, the way the instruction pill covered the
       zoom plus. So each control gets the overlay it lives in, and only same-layer pairs are
       compared. Three passes to scope, and the threshold never moved. */
    /* WHO ACTUALLY BURIES IT -- three tries to get this right, and the first two were heuristics.
       Grouping by container silenced the take-it sheet and would also have silenced the pill over
       the zoom, which is the defect this exists for. Detecting a full-viewport overlay missed the
       leg card. The precise question is not what layer a control is in, it is WHAT A FINGER MEETS
       at its centre:
         - the control itself  -> it is on top, so a peer overlapping it is worth reporting
                                  (the pill case: .prompt is pointer-events:none, so the zoom still
                                  hit-tests to itself while the pill visually covers it)
         - the OTHER control   -> that control genuinely covers it. The strongest form.
         - anything else       -> a third thing is over it, which is a modal doing its job. Skip.
       Measured, not assumed: with the take sheet open the zoom reports z-index 1000 against the
       sheet's 70 and still hit-tests to a row inside the sheet, because Leaflet's 1000 lives in
       the map's own stacking context. */
    const topAt = el => { const r = el.getBoundingClientRect();
      return document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); };
    const buriedByOther = (victim, peer) => {
      const t = topAt(victim);
      if (!t) return true;                                  /* off screen: not this check's business */
      if (t === victim || victim.contains(t)) return false;  /* on top */
      if (t === peer || peer.contains(t)) return false;      /* the peer covers it -- the real case */
      return true;                                           /* a third thing covers it */
    };
    const onScreen = ctrls.filter(el => !stowed(el));
    const pairs = [];
    for (let i = 0; i < onScreen.length; i++) for (let j = i + 1; j < onScreen.length; j++) {
      const a = onScreen[i], b = onScreen[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (buriedByOther(a, b) || buriedByOther(b, a)) continue;
      /* A STICKY CONTROL OVER ITS OWN SCROLLER IS THAT CONTROL WORKING. 2v pinned the take-it
         sheet Close with position:sticky precisely so it cannot scroll out of reach at 375x500,
         so it passes over the rows beneath it by design. Exempting the mechanism rather than the
         pair, so the next sticky header does not have to be discovered the same way. */
      if (getComputedStyle(a).position === "sticky" || getComputedStyle(b).position === "sticky") continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      const small = Math.min(ra.width * ra.height, rb.width * rb.height) || 1;
      const frac = (w * h) / small;
      if (frac >= 0.25) pairs.push({ a: label(a), b: label(b), pct: Math.round(frac * 100) });
    }
    out.overlap = pairs.slice(0, 12);
  }

  /* A5 -- AN ICON BUTTON THAT DREW NOTHING. icon() on /new falls back to P[n] || "", so a name
     missing from that table returns an EMPTY svg -- which is how the leg card close control
     shipped as a blank white disc: unconfirmable from a screenshot, obvious from the table. */
  out.glyphless = [...document.querySelectorAll("button,[role=button]")].filter(vis)
    .filter(el => !(el.textContent || "").trim())
    .filter(el => { const g = el.querySelector("svg"); return !!g && !g.querySelector("path,circle,rect,line,polyline,polygon,ellipse"); })
    .map(el => label(el)).slice(0, 8);

  return out;
})()`;
