/* ring.js v1 — the radial picker, lifted out of /quick so /new can have it too.
 *
 * createRing({map, mount, z, onCancel}) -> {open, ask, close, destroy, el}
 *
 * WHY THIS IS A FILE AND NOT A PASTE (§2e, and D-063 said so first): copying is how the mode
 * enum came to be written twice and both copies missed D-060. There is one ring now, and the
 * two builders differ in what they DO with it, not in how it draws.
 *
 * WHY A FACTORY AND NOT GLOBALS. The original closed over /quick's `map`, hardcoded the ids
 * #ring/#veil/#ask, and fell back to /quick's own cancel() on hub-back — three couplings to one
 * page's state machine. /new has a different map object, a different element stack and a
 * different idea of what cancelling means, so all three are arguments now.
 *
 * WHY IT INJECTS ITS OWN CSS, AND AGAINST THE CANONICAL TOKENS. Measured 2026-08-03: the ring
 * used eight custom properties and FOUR of them existed nowhere but quick.html's own <style>
 * (--disp, --pine, --pine-deep, --accent, declared at its lines 34-36 as aliases onto
 * --color-brand-*). new.html declares none of the eight and relies on sky.css, which carries
 * --card/--ink/--soft/--line/--pine but NOT --accent, --disp or --pine-deep. A paste would have
 * lost the hover fill, the display face and the hub hover, rendering a ring that looks broken
 * rather than one with three unresolved variables — and `make check` reads source, not computed
 * style, so nothing would have caught it. So: brand colours and the display face come from
 * tokens.css, which every page loads, each with a hex fallback. Only the surface tokens
 * (--card/--ink/--soft/--line) are left to the theme sheet, because both dark.css and sky.css
 * define all four.
 *
 * WHY THE SELECTORS ARE SCOPED. `.seg`, `.wedge`, `.hub`, `.lbl` are generic enough to collide
 * in a 1700-line page. Every rule is under the container class, so the ring cannot style
 * anything it did not create.
 *
 * WHY z IS AN ARGUMENT. /quick is a flat page and 30/40/45 was free. /new stacks prompt 14,
 * rail 16, bar 20, keepbar 22, card.zoom 40, toast 650, drawbar 700, menu 900 — a ring at 40
 * ties the zoomed card and a veil at inset:0 z30 swallows the keepbar. The collision is a
 * property of the host page, so the host page settles it.
 *
 * No dependencies. Leaflet is used only through the `map` you hand in (latLngToContainerPoint
 * and panBy), so this file does not care which version is loaded or whether one is at all.
 */
(function (global) {
  "use strict";

  var CSS_ID = "ttb-ring-css";
  var CSS = [
    /* Container. Positioned by place(); z-index set per instance from opts.z. */
    ".ttbr{position:fixed;opacity:0;pointer-events:none;transform:scale(.88);",
    "  transition:opacity .15s ease,transform .15s ease}",
    ".ttbr.show{opacity:1;transform:scale(1);pointer-events:auto}",
    "@media (prefers-reduced-motion:reduce){.ttbr{transition:none}}",
    ".ttbr svg{display:block;overflow:visible;filter:drop-shadow(0 10px 26px rgba(0,0,0,.3))}",
    ".ttbr-veil{position:fixed;inset:0;display:none}",
    ".ttbr-veil.on{display:block}",

    ".ttbr .seg{cursor:pointer}",
    ".ttbr .seg .wedge{fill:var(--card,#fff);stroke:var(--ink,#141414);stroke-width:2;transition:fill .1s}",
    ".ttbr .seg:hover .wedge,.ttbr .seg:focus-visible .wedge{fill:var(--color-brand-orange,#F7B304)}",
    ".ttbr .seg:focus-visible{outline:none}",
    ".ttbr .seg:focus-visible .wedge{stroke-width:3.5}",
    ".ttbr .seg .lbl{font-family:var(--font-family-display,\"Barlow Condensed\",sans-serif);",
    "  font-weight:700;letter-spacing:.05em;text-transform:uppercase;fill:var(--ink,#141414);",
    "  pointer-events:none;text-anchor:middle;dominant-baseline:middle}",
    ".ttbr .seg .gly{fill:none;stroke:var(--ink,#141414);stroke-width:1.9;stroke-linecap:round;",
    "  stroke-linejoin:round;pointer-events:none}",
    ".ttbr .hub{fill:var(--color-brand-teal,#035A83);stroke:#fff;stroke-width:3}",
    ".ttbr .hub-t{font-family:var(--font-family-display,\"Barlow Condensed\",sans-serif);font-weight:700;",
    "  font-size:10px;letter-spacing:.12em;text-transform:uppercase;fill:rgba(255,255,255,.66);",
    "  text-anchor:middle}",
    ".ttbr .hub-p{font-family:var(--font-family-display,\"Barlow Condensed\",sans-serif);font-weight:700;",
    "  fill:#fff;text-anchor:middle}",
    ".ttbr .hub-back{cursor:pointer}",
    ".ttbr .hub-back:hover .hub{fill:var(--color-brand-teal-deep,#024260)}",

    /* Typing gets a card. A ring cannot hold a keyboard. */
    ".ttbr-ask{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);",
    "  width:min(320px,calc(100vw - 28px));background:var(--card,#fff);border:2px solid var(--ink,#141414);",
    "  border-radius:16px;box-shadow:0 14px 40px rgba(0,0,0,.3);padding:16px;display:none}",
    ".ttbr-ask.on{display:block}",
    ".ttbr-ask h2{font-family:var(--font-family-display,\"Barlow Condensed\",sans-serif);font-weight:700;",
    "  font-size:18px;letter-spacing:.03em;text-transform:uppercase;margin:0 0 3px;color:var(--ink,#141414)}",
    ".ttbr-ask p{margin:0 0 11px;font-size:13px;color:var(--soft,#5b5b5b);line-height:1.45}",
    ".ttbr-ask input{width:100%;min-height:46px;padding:11px 13px;border:2px solid var(--line,#d8d8d8);",
    "  border-radius:11px;background:var(--sheet,var(--card,#fff));color:var(--ink,#141414);",
    "  font-size:16px;font-family:var(--font-family-body,\"Barlow\",system-ui,sans-serif)}",   /* canonical: --body is a pages.css/quick.html alias and new.html loads neither */
    ".ttbr-ask input:focus{outline:0;border-color:var(--color-brand-teal,#035A83)}",
    ".ttbr-ask .row{display:flex;gap:8px;margin-top:11px}",
    ".ttbr-ask button{flex:1;min-height:46px;border-radius:11px;",
    "  font-family:var(--font-family-display,\"Barlow Condensed\",sans-serif);font-weight:700;font-size:14px;",
    "  letter-spacing:.05em;text-transform:uppercase;border:2px solid var(--line,#d8d8d8);",
    "  background:var(--card,#fff);color:var(--ink,#141414)}",
    ".ttbr-ask button.go{background:var(--color-brand-orange,#F7B304);",
    "  border-color:var(--color-brand-orange,#F7B304);color:#141414}"
  ].join("");

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectCss);
  else injectCss();

  function esc(t) {
    var d = document.createElement("div");
    d.textContent = t == null ? "" : t;
    return d.innerHTML;
  }

  /* ── geometry ───────────────────────────────────────────────────────────────────────── */
  function polar(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }

  function wedgePath(cx, cy, r0, r1, a0, a1) {
    var p0 = polar(cx, cy, r1, a0), p1 = polar(cx, cy, r1, a1);
    var p2 = polar(cx, cy, r0, a1), p3 = polar(cx, cy, r0, a0);
    var big = (a1 - a0) > Math.PI ? 1 : 0;
    return "M" + p0[0] + " " + p0[1] + "A" + r1 + " " + r1 + " 0 " + big + " 1 " + p1[0] + " " + p1[1] +
           "L" + p2[0] + " " + p2[1] + "A" + r0 + " " + r0 + " 0 " + big + " 0 " + p3[0] + " " + p3[1] + "Z";
  }

  /* Sized from the viewport. A fixed ring covers the map on a small phone and looks lost on a
     desktop, and this control is meant to sit ON the thing it is about. */
  function dims(n) {
    var v = Math.min(innerWidth, innerHeight);
    /* Retuned 2026-08-03 (Peter, on a phone: "make the ring smaller").
       The old numbers — 0.29 of the smaller dimension, floored at 96 — produced a 262px ring on
       a 375px screen: 70% of the width, on EVERY phone, because the floor bound before the
       factor did. They were chosen for /quick, a page with no other chrome, where a ring that
       large was the whole interface. On /new it is a chooser over a map.
       These land it at ~51% of width across the phone range and still grow on a desktop. The
       inner radius floor came down with it: at the old 54 the hub would have eaten most of a
       smaller ring and left no band to write a label in. */
    var r1 = Math.max(72, Math.min(116, v * 0.215));
    var r0 = Math.max(42, r1 * (n > 5 ? 0.48 : 0.52));
    return { r0: r0, r1: r1, pad: 16, fs: v < 380 ? 11 : 12.5 };
  }

  /* W5: "Tomorrow" overran its wedge. `fs` comes from dims(n) — the NUMBER of wedges — and never
     from the length of the word in one, so a long label simply spilled past the segment.

     The wedge gives a real bound: at radius rm the chord across an angle of stepA is
     2·rm·sin(stepA/2). Estimate the label at ~0.63em per glyph for the condensed display face
     in uppercase WITH .05em tracking (0.52, mixed case and untracked, under-read by a fifth),
     and when it does not fit hand SVG the width and let it compress. Only shrinks the labels
     that need it, so nothing else on the ring moves. */
  function fit(label, fs, rm, stepA) {
    var avail = 2 * rm * Math.sin(stepA / 2) * 0.86;   // 0.86 leaves the wedge edges alone
    var est = String(label).length * fs * 0.63;
    return est <= avail ? "" : ' textLength="' + avail.toFixed(1) + '" lengthAdjust="spacingAndGlyphs"';
  }

  /* ── the instance ───────────────────────────────────────────────────────────────────── */
  function createRing(opts) {
    opts = opts || {};
    var map = opts.map;
    if (!map) throw new Error("createRing needs {map}");
    var mount = opts.mount || document.body;
    /* `z` takes either a base NUMBER or {veil, ring, ask}. It used to take only the object,
       and `createRing({z: 100})` was accepted in silence — `(100).veil` is undefined, so every
       layer fell back to /quick's defaults and the ring rendered at 40 on a page whose
       .card.zoom is also 40. A wrong type that looks like it worked is worse than a throw, and
       a single base is what a caller actually wants to say. */
    var zo = (typeof opts.z === "number") ? { veil: opts.z, ring: opts.z + 10, ask: opts.z + 20 }
                                          : (opts.z || {});
    var zVeil = zo.veil == null ? 30 : zo.veil;
    var zRing = zo.ring == null ? 40 : zo.ring;
    var zAsk = zo.ask == null ? 45 : zo.ask;
    /* The host decides what cancelling means. /quick clears pending, draft, step, editing,
       insertAt and armed then re-renders; /new will mean something else. Default is to close
       and nothing more, which is correct for a host that keeps no ring state. */
    var onCancel = typeof opts.onCancel === "function" ? opts.onCancel : function () { close(); };

    var veil = document.createElement("div");
    veil.className = "ttbr-veil";
    veil.style.zIndex = zVeil;

    var ring = document.createElement("div");
    ring.className = "ttbr";
    ring.setAttribute("role", "menu");
    ring.setAttribute("aria-label", opts.label || "Choose");
    ring.style.zIndex = zRing;

    var ask = document.createElement("div");
    ask.className = "ttbr-ask";
    ask.setAttribute("role", "dialog");
    ask.setAttribute("aria-modal", "true");
    ask.style.zIndex = zAsk;
    var askId = "ttbr-ask-t-" + Math.round(performance.now() * 1000).toString(36);
    ask.innerHTML =
      '<h2 id="' + askId + '"></h2><p></p><input><div class="row">' +
      '<button class="skip" type="button">Skip</button>' +
      '<button class="go" type="button">Next</button></div>';
    ask.setAttribute("aria-labelledby", askId);
    var askH = ask.querySelector("h2"), askP = ask.querySelector("p"),
        askI = ask.querySelector("input"), askGo = ask.querySelector(".go"),
        askSkip = ask.querySelector(".skip");

    mount.appendChild(veil);
    mount.appendChild(ring);
    mount.appendChild(ask);

    veil.addEventListener("click", function () { onCancel(); });

    /* Anchor the ring ON the point. Pan only if it would fall off an edge, and only by as much
       as it takes — panning every time is what made the first pass feel like the map was
       fighting you. */
    function place(latlng, size) {
      var p = map.latLngToContainerPoint(latlng);
      var half = size / 2, m = 8;
      var barH = opts.barH == null ? 74 : opts.barH;
      var topH = opts.topH == null ? 62 : opts.topH;
      var dx = 0, dy = 0;
      if (p.x - half < m) dx = (p.x - half) - m;
      else if (p.x + half > innerWidth - m) dx = (p.x + half) - (innerWidth - m);
      if (p.y - half < topH) dy = (p.y - half) - topH;
      else if (p.y + half > innerHeight - barH) dy = (p.y + half) - (innerHeight - barH);
      if (dx || dy) map.panBy([dx, dy], { animate: true, duration: 0.25 });
      ring.style.left = ((p.x - dx) - half) + "px";
      ring.style.top = ((p.y - dy) - half) + "px";
    }

    function open(at, title, sub, items, onPick, onBack) {
      var n = items.length, d = dims(n), c = d.r1 + d.pad, size = c * 2;
      var stepA = (Math.PI * 2) / n, start = -Math.PI / 2 - stepA / 2;
      var svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">';
      items.forEach(function (it, i) {
        var a0 = start + i * stepA, a1 = a0 + stepA * 0.96, mid = (a0 + a1) / 2, rm = (d.r0 + d.r1) / 2;
        var l = polar(c, c, rm, mid);
        svg += '<g class="seg" role="menuitem" tabindex="0" data-i="' + i + '" aria-label="' + esc(it.label) + '">' +
               '<path class="wedge" d="' + wedgePath(c, c, d.r0, d.r1, a0, a1) + '"/>' +
               (it.gly ? '<g class="gly" transform="translate(' + (l[0] - 11) + ' ' + (l[1] - 23) + ') scale(.9)">' + it.gly + '</g>' : "") +
               '<text class="lbl" style="font-size:' + d.fs + 'px"' + fit(it.label, d.fs, rm, stepA) +
               ' x="' + l[0] + '" y="' + (it.gly ? l[1] + 13 : l[1]) + '">' + esc(it.label) + "</text></g>";
      });
      svg += '<g class="hub-back" role="menuitem" tabindex="0" aria-label="' + (onBack ? "Back" : "Cancel") + '">' +
             '<circle class="hub" cx="' + c + '" cy="' + c + '" r="' + (d.r0 - 7) + '"/>' +
             '<text class="hub-t" x="' + c + '" y="' + (c - 11) + '">' + esc(title) + "</text>" +
             '<text class="hub-p" style="font-size:' + (d.fs + 3) + 'px" x="' + c + '" y="' + (c + 9) + '">' +
             esc(sub) + "</text></g></svg>";

      ring.innerHTML = svg;
      place(at, size);
      ring.classList.add("show");
      veil.classList.add("on");
      /* Kept on <body>, not on the container: /quick hides its "you are here" marker with
         `body.ringing .leaflet-marker-icon.is-here{opacity:0}`, which is the host's rule about
         the host's marker. The class is the contract; the rule stays with whoever owns it. */
      document.body.classList.add("ringing");

      ring.querySelectorAll(".seg").forEach(function (g) {
        var i = +g.dataset.i;
        var go = function (e) { e.preventDefault(); e.stopPropagation(); onPick(items[i], i); };
        g.addEventListener("click", go);
        g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") go(e); });
      });
      var hub = ring.querySelector(".hub-back");
      var back = function (e) { e.preventDefault(); e.stopPropagation(); if (onBack) onBack(); else onCancel(); };
      hub.addEventListener("click", back);
      hub.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") back(e); });
      requestAnimationFrame(function () { var f = ring.querySelector(".seg"); if (f) f.focus(); });
    }

    function close() {
      ring.classList.remove("show");
      ring.innerHTML = "";
      veil.classList.remove("on");
      document.body.classList.remove("ringing");
    }

    /* The card, for the places a keyboard is genuinely needed: a flight number, a rental
       pickup, an arbitrary date. */
    function askFor(title, hint, placeholder, onDone) {
      askH.textContent = title;
      askP.textContent = hint;
      askI.value = "";
      askI.placeholder = placeholder;
      ask.classList.add("on");
      close();
      requestAnimationFrame(function () { askI.focus(); });
      var done = function (v) { ask.classList.remove("on"); onDone(v); };
      askGo.onclick = function () { done(askI.value.trim()); };
      askSkip.onclick = function () { done(""); };
      askI.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); done(askI.value.trim()); } };
    }

    function destroy() {
      close();
      ask.classList.remove("on");
      [veil, ring, ask].forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    }

    /* The card's parts are exposed, not just the card. /quick drives the same surface a second
       way — a place SEARCH, with suggestions attached to the input, a "Cancel" skip label and no
       close-on-Enter, because Enter there picks a suggestion. That is a different interaction
       from ask(), not a variant of it, so the module lends the furniture rather than growing an
       option for every host that wants a text field. `askOn` is the honest way to answer "is the
       card up?" without reading a class name from outside. */
    return {
      open: open,
      ask: askFor,
      close: close,
      destroy: destroy,
      askOpen: function () { return ask.classList.contains("on"); },
      askShow: function () { ask.classList.add("on"); },
      askHide: function () { ask.classList.remove("on"); },
      el: {
        veil: veil, ring: ring, ask: ask,
        askTitle: askH, askHint: askP, askInput: askI, askGo: askGo, askSkip: askSkip
      }
    };
  }

  global.createRing = createRing;
})(window);
