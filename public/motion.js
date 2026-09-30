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

  /* ── 6. the address types itself ─────────────────────────────────────────────────────────
     Step 1 ends with `thistripbtw.us/xvsbe4r`, and that string IS the product — the thing you
     are given, the thing you send. It arrived fully formed like any other label. Typed out, in
     one pass, it reads as an address being MINTED, which is what the step above it describes.
     Slug only: the domain is not news, and animating it would make a seven-character reveal
     take three times as long. */
  function mintAddress() {
    const chip = document.querySelector(".step .addr");
    if (!chip) return;
    const full = chip.textContent.trim();
    const cut = full.lastIndexOf("/");
    if (cut < 0 || cut === full.length - 1) return;
    const stem = full.slice(0, cut + 1), slug = full.slice(cut + 1);
    /* The box must not resize as characters land — a chip that grows mid-animation shoves the
       card's layout around, which is the one thing motion may never do. Fixed to its own
       measured width first. */
    const w = chip.getBoundingClientRect().width;
    if (w) chip.style.width = w + "px";
    chip.setAttribute("aria-label", full);          // a screen reader gets the finished thing
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.disconnect();
        let i = 0;
        chip.textContent = stem;
        const tick = () => {
          chip.textContent = stem + slug.slice(0, ++i);
          if (i < slug.length) setTimeout(tick, 55);
        };
        setTimeout(tick, 260);
      }
    }, { threshold: .6 });
    io.observe(chip);
  }

  /* ── 7. the ticks are made, not printed ──────────────────────────────────────────────────
     Four promises with a tick beside each. A tick that fades in is a bullet; a tick that is
     DRAWN is somebody agreeing with you. The mark is a two-segment SVG path so the stroke can
     draw — the CSS "✓" cannot — and it replaces the pseudo-element's glyph only when this file
     runs, so the plate is correct with no JS. */
  function tickMarks() {
    const items = [...document.querySelectorAll(".pillars li")];
    if (!items.length) return;
    items.forEach((li, i) => {
      if (li.querySelector(".m-tick")) return;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "m-tick"); svg.setAttribute("viewBox", "0 0 20 20");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M4.5 10.6 L8.4 14.2 L15.5 6.2");
      svg.appendChild(path); li.appendChild(svg);
      const len = 18;
      path.style.strokeDasharray = len + " " + len;
      path.style.strokeDashoffset = len;
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.disconnect();
          const a = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
            { duration: 260, delay: 120 + i * 90, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" });
          a.addEventListener("finish", () => { path.style.strokeDashoffset = "0"; });
        }
      }, { threshold: .8 });
      io.observe(li);
    });
  }

  /* ── 8. the mile markers land ────────────────────────────────────────────────────────────
     They already turn under a pointer. On the way in they now arrive like a plate being set:
     a short drop and one overshoot, each a beat behind its own card. */
  function markersLand() {
    const cards = [...document.querySelectorAll("#pricing .card")];
    cards.forEach((card, i) => {
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.disconnect();
          card.classList.add("m-marked");
          /* The marker is a ::after, which script cannot animate directly — so the card carries
             a class and the CSS animates the pseudo-element. */
        }
      }, { threshold: .4 });
      io.observe(card);
    });
  }

  /* ── 9. the examples arrive as a list ────────────────────────────────────────────────────
     "Also understood:" is three chips that appeared together, which reads as a block of text.
     Staggered, they read as three separate things the thing can do. */
  function examples() {
    const chips = [...document.querySelectorAll(".alsotry code")];
    if (!chips.length) return;
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.disconnect();
        chips.forEach((c, i) => animate(c,
          [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
          { duration: 220, delay: i * 80, easing: E.out }));
      }
    }, { threshold: .5 });
    io.observe(chips[0].parentElement || chips[0]);
  }

  /* ── 10. the shield is a real sign, and it leans ────────────────────────────────────────
     A road sign is a physical plate on a post: you see its edge when you pass it. The mark tilts
     toward the pointer — a few degrees of perspective, tracking where the cursor actually is on
     the plate, so it reads as a thing with a front and a back rather than a picture that scales.

     POINTER ONLY, and never on touch: a phone has no hover, and a tilt that fires on tap would
     fight the tap. Reduced motion never reaches this function at all.

     Cheap on purpose — `transform` and nothing else, so it composites and never touches layout.
     The listener is on the WRAPPER rather than the image, because the image is the thing being
     transformed and moving it under the cursor would feed its own events back in. */
  function tiltSign() {
    if (!matchMedia("(hover:hover) and (pointer:fine)").matches) return;
    const marks = [...document.querySelectorAll(".brand-logo, .pagehead .sign img, .hero .brand-logo")];
    const MAX = 9;                       // degrees; more than this and it reads as a toy
    for (const img of marks) {
      const box = img.parentElement || img;
      box.style.perspective = "700px";
      img.style.transformOrigin = "50% 55%";   // a sign pivots nearer its post than its middle
      let raf = 0, tx = 0, ty = 0;
      const paint = () => {
        raf = 0;
        img.style.transform = `rotateX(${ty}deg) rotateY(${tx}deg) translateZ(6px)`;
      };
      box.addEventListener("pointermove", (e) => {
        const r = img.getBoundingClientRect();
        if (!r.width) return;
        /* -1 … 1 across the plate, then eased so the middle is calm and the edges lean most. */
        const px = (e.clientX - r.left) / r.width * 2 - 1;
        const py = (e.clientY - r.top) / r.height * 2 - 1;
        tx =  Math.max(-1, Math.min(1, px)) * MAX;
        ty = -Math.max(-1, Math.min(1, py)) * MAX;
        if (!raf) raf = requestAnimationFrame(paint);
      });
      box.addEventListener("pointerleave", () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        /* Settles back rather than snapping: the overshoot is the same easing the sign arrives
           with, so leaving looks like the same object as landing. */
        img.style.transition = "transform .42s cubic-bezier(.34,1.32,.64,1)";
        img.style.transform = "none";
        setTimeout(() => { img.style.transition = ""; }, 460);
      });
      box.addEventListener("pointerenter", () => { img.style.transition = ""; });
    }
  }

  function start() {
    root.classList.add("m-on");
    if (reduced.matches) return;          // the page is already right; add nothing
    reveals();
    signSettles();
    mintAddress();
    tickMarks();
    markersLand();
    examples();
    tiltSign();
    copyStamp();
    exitTabs();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
