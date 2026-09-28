/* motion.js — the site's microinteractions. DEFAULT since D-195 (2026-09-26); it was behind
 * ?motion=1 for two days first.
 *
 * NO LIBRARY, deliberately. motion.dev is a wrapper over the Web Animations API the browser
 * already ships, and CLAUDE.md's first hard constraint is no frameworks and no npm deps in the
 * client. Everything here is WAAPI, CSS transitions and one IntersectionObserver. If springs are
 * ever worth it, that is a self-hosted file and a DECISIONS entry — not a CDN tag.
 *
 * THE RULE THIS FILE IS WRITTEN UNDER: motion carries meaning or it does not ship. Every
 * animation below says something the page is already saying — the road is a road, a sign settles
 * onto its post, a copied link is a stamp, the list you just added to admits it changed. Nothing
 * loops forever, nothing moves while it is being read, nothing delays an action.
 *
 * REDUCED MOTION IS A FULL STOP, not a slower version. `prefers-reduced-motion: reduce` returns
 * early and the page renders in its final state — which is why every effect here is an ADDITION
 * to a page that is already correct and visible without it. If this file never loads, nothing is
 * missing. That is also why it loads with `defer` and is never awaited: nothing on any page
 * waits for this file, and a page whose motion.js 404s is a page that simply does not move.
 *
 * NOT LOADED ON THE TRIP PAGE. app.html has its own motion — the sheet, the replay, the FAB arc —
 * tuned against a map that is already animating, and a second vocabulary layered on top of that
 * one is how a product starts feeling busy. If the trip page wants any of this, it takes the
 * rules from here deliberately rather than by inheriting the file.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  /* One vocabulary, so two animations written a month apart still feel like one product.
     Durations are short on purpose: the longest thing here is 420ms, because a person tapping
     "add a leg" is not watching a transition, they are waiting for a leg. */
  const T = { tap: 110, quick: 180, settle: 260, draw: 420 };
  const E = {
    /* Out-quint: fast, then a long tail. Reads as weight rather than as a computer easing. */
    out: "cubic-bezier(.22,1,.36,1)",
    /* A sign coming to rest overshoots a hair. One overshoot, not a wobble. */
    sign: "cubic-bezier(.34,1.32,.64,1)",
  };

  const animate = (el, frames, opts) => {
    if (reduced.matches || !el || !el.animate) return null;
    return el.animate(frames, Object.assign({ duration: T.quick, easing: E.out, fill: "both" }, opts));
  };

  /* ── 1. things arrive as you reach them ──────────────────────────────────────────────────
     The landing page is a scroll, and everything on it currently exists before you get there.
     A card that admits it arrived is the cheapest way to make a page feel built rather than
     printed. Once each — `unobserve` — because a thing that re-animates every time it crosses
     the fold is a thing you learn to scroll past.
     STAGGER IS PER GROUP, not per page: the three steps arrive as three steps, 55ms apart, so
     the eye reads them as a sequence rather than as one block that moved. */
  function reveals() {
    const groups = [
      [".pillars li", 45],
      [".step", 55],
      ["#pricing .card", 55],
      [".sentby, .promise, .saidbox, .priv, .receipts", 0],
      [".pagebody.sheet > section, .pagebody .card, .principle", 40],
    ];
    const seen = new WeakSet();
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const delay = +e.target.dataset.mDelay || 0;
        animate(e.target, [
          { opacity: 0, transform: "translateY(10px)" },
          { opacity: 1, transform: "none" },
        ], { duration: T.settle, delay, easing: E.out });
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });

    for (const [sel, step] of groups) {
      const els = [...document.querySelectorAll(sel)];
      els.forEach((el, i) => {
        if (seen.has(el)) return;
        seen.add(el);
        el.dataset.mDelay = String(i * step);
        io.observe(el);
      });
    }
  }

  /* ── 2. the sign settles ─────────────────────────────────────────────────────────────────
     Once per tab, not once per page view: a mark that bounces on every navigation is a mark
     that is performing. sessionStorage rather than localStorage so a new visit still gets it
     — it is a greeting, and a greeting you have had this minute is noise. */
  function signSettles() {
    const mark = document.querySelector(".brand-logo, .pagehead .sign img");
    if (!mark) return;
    let greeted = false;
    try { greeted = sessionStorage.getItem("ttb_m_sign") === "1"; } catch (e) {}
    if (greeted) return;
    try { sessionStorage.setItem("ttb_m_sign", "1"); } catch (e) {}
    animate(mark, [
      { transform: "translateY(-8px) scale(.985)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: T.draw, easing: E.sign });
  }

  /* ── 3. the road draws itself ────────────────────────────────────────────────────────────
     The dashed centreline down the landing page is the one piece of pure ornament D-193 added,
     so it is the one place where motion is allowed to be simply pleasing. It draws downward as
     it comes into view — the road being laid — and then stops. Clip-path rather than height:
     height would reflow the column it sits beside; a clip is composited and touches nothing. */
  function drawRoad() {
    const main = document.querySelector("main.wrap");
    if (!main) return;
    const draw = () => root.classList.add("m-road-drawn");

    /* NO WIDTH GATE HERE, and that was a bug worth keeping the note for: the first version asked
       `matchMedia("(min-width:980px)")` once, at load, and returned early below that — so a
       window that started narrow and was widened kept the line clipped out of existence for the
       rest of the session. The CSS already draws the centreline only at >=980px; clipping a
       thing that is not rendered costs nothing, so the gate bought nothing and hid the line. */
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.disconnect();
        draw();
      }
    }, { threshold: 0.02 });
    io.observe(main);

    /* Deep links and restored scroll positions land PAST the trigger, where an observer that
       has only ever seen "not intersecting" will wait for a scroll that may never come. If the
       column is already behind us, the road is already laid. */
    if (main.getBoundingClientRect().top < innerHeight) { io.disconnect(); draw(); }
  }

  /* ── 4. a press that answers ─────────────────────────────────────────────────────────────
     Buttons already press down in CSS. What they do not do is acknowledge the SPECIFIC thing a
     copy button does, which is take something invisible. The stamp is the sign metaphor: the
     link is stamped, briefly, like a permit. */
  function copyStamp() {
    document.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".copybtn, [data-copy], .chipcopy");
      if (!btn) return;
      animate(btn, [
        { transform: "scale(1)" },
        { transform: "scale(.88)", offset: .3 },
        { transform: "scale(1.06)", offset: .62 },
        { transform: "scale(1)" },
      ], { duration: T.settle, easing: E.sign });
    }, { passive: true });
  }

  /* ── 5. the exit tab a finger is on ──────────────────────────────────────────────────────
     Hover is a mouse idea, so this is pointer-aware: on a touch screen the tab responds to the
     tap instead, and on neither does it move on its own. */
  function exitTabs() {
    if (!matchMedia("(hover:hover)").matches) return;
    for (const step of document.querySelectorAll(".step")) {
      const tab = step.querySelector(".n");
      if (!tab) continue;
      step.addEventListener("pointerenter", () => {
        animate(tab, [{ transform: "none" }, { transform: "translateY(-3px)" }],
                { duration: T.tap, easing: E.out });
      });
      step.addEventListener("pointerleave", () => {
        animate(tab, [{ transform: "translateY(-3px)" }, { transform: "none" }],
                { duration: T.quick, easing: E.out });
      });
    }
  }

  function start() {
    root.classList.add("m-on");
    if (reduced.matches) return;          // the page is already right; add nothing
    reveals();
    signSettles();
    drawRoad();
    copyStamp();
    exitTabs();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
