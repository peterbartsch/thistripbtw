/* goo-fab.js v1 — the FAB as a liquid tree (Peter, 2026-10-13: "I want this animation and
 * function" — libraries.dev/gooey — "and really want it to be a 3 level deep branching tree for
 * navigation: a click on the + gives 3 options, clicking on any of those 3 loads a branch from it
 * of more options").
 *
 * createGooFab({fab, veil, z, radii, size, onPick}) -> {open, close, isOpen, back, destroy}
 *
 *   open(tree)   tree = [{key, label, kids?: [...]}, ...] — level one, usually three. A node with
 *                kids opens its branch; a node without is a leaf and calls onPick(key, node).
 *   back()       one level up. close() everything home.
 *
 * HOW THE GOO IS DRAWN, AND WHY NOT WITH A CSS FILTER ON THE BUTTONS. The classic gooey effect
 * is blur + an alpha contrast step. Run over real UI it costs the text its edges and Safari
 * renders `filter:url()` on HTML wrong. So, as liquid-gooey does, the effect is split in two: an
 * SVG SILHOUETTE underneath carries the goo (filters on SVG content render everywhere), and the
 * real buttons ride crisp on top with no background of their own. Two silhouette layers, both
 * through the same filter: an ink layer two pixels larger than a card layer, which is how the
 * merged shape keeps the same 2px ink outline the plates have always had, through every bridge.
 *
 * HOW THE TREE MOVES. Level one grows out of the FAB on the quarter arc the old #fabArc used
 * (up to left: the corner eats the rest). Tapping a branch keeps that plate where it is, melts
 * its siblings back into the FAB, and grows its children out of IT on the next ring; tapping the
 * same plate again (it is the hub now, orange) melts the children back and brings the siblings
 * out again. Each plate and its two silhouette circles share one WAAPI animation, so the goo and
 * the button never disagree. Reduced motion: no travel, the plates are simply there.
 *
 * WHERE DO THEY BELONG (Peter, 2026-10-13, second look: "when you pick a nav item and it has two
 * choices within it, those options are badly placed and spaced on the arc … hard to understand
 * their relation to the ring below that triggered them"). A branch's children no longer share
 * the whole quarter: they sit on the next ring in a tight group centred on the door that opened
 * them, one plate's width apart, slid along the ring only when the corner is in the way; and a
 * faint spoke runs from the hub to each child (and from the FAB to each level-one door), so the
 * tree reads as a tree. Level one, with nothing to belong to, still spreads over the quarter.
 *
 * WHERE AM I (Peter, 2026-10-13, after seeing it: "the 'where am I?' becomes a thing quick").
 * Two anchors. The doors you did not choose do not vanish: they stay where they were at half
 * strength, for reference, and a tap on one switches to that branch. And behind the whole menu,
 * faint concentric rings at the three radii, with a soft disc, so the eye has a frame; the ring
 * of the level you are on is a shade stronger than the others.
 *
 * NO DEPENDENCIES, and nothing here knows what the keys mean: the page builds the tree from its
 * own state when it opens (as fabItems() did) and acts on the key it is handed back.
 */
(function (global) {
  "use strict";

  var CSS_ID = "ttb-gfab-css";
  var CSS = [
    ".gfab{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none}",
    ".gfab[hidden]{display:none}",
    ".gfab-svg{position:absolute;display:block;overflow:visible;pointer-events:none;",
    "  filter:drop-shadow(0 3px 10px rgba(0,0,0,.22))}",
    ".gfab-ink{fill:var(--ink,#141414)}",
    ".gfab-card{fill:var(--card,#fff)}",
    ".gfab-hub{fill:var(--accent,var(--color-brand-orange,#F26A1B))}",
    /* The doors not chosen: half strength, still there, still a way to switch. Drawn outside the
       goo (a half-transparent shape inside the filter would be made solid by its contrast step). */
    ".gfab-ghosts{opacity:.5}",
    ".gfab-b.is-ghost{opacity:.5}",
    /* The frame behind the menu: three rings at the three radii, and a soft disc. */
    ".gfab-rings{opacity:0;transition:opacity .35s ease}",
    ".gfab-rings.on{opacity:1}",
    ".gfab-ring{fill:none;stroke:var(--ink,#141414);stroke-opacity:.14;stroke-width:1.5}",
    ".gfab-ring.is-level{stroke-opacity:.38;stroke-width:2}",
    ".gfab-disc{fill:url(#ttb-gfab-disc)}",
    /* A spoke from the hub to each of its children: the relation, drawn. Fades in once they land. */
    ".gfab-spoke{stroke:var(--ink,#141414);stroke-width:2;stroke-linecap:round;stroke-opacity:0;transition:stroke-opacity .3s ease}",
    ".gfab-spoke.on{stroke-opacity:.3}",
    ".gfab-spoke.is-ghost{stroke-opacity:.12}",
    "@media (prefers-reduced-motion:reduce){.gfab-spoke{transition:none}}",
    "@media (prefers-reduced-motion:reduce){.gfab-rings{transition:none}}",
    ".gfab-b{position:absolute;margin:0;padding:0;border:0;background:none;border-radius:50%;",
    "  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;",
    "  color:var(--ink,#141414);font-family:var(--disp,var(--font-family-display,\"Barlow Condensed\",sans-serif));",
    "  font-weight:700;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;line-height:1.05;",
    "  text-align:center;white-space:nowrap;-webkit-tap-highlight-color:transparent}",
    ".gfab-b:focus{outline:none}",
    ".gfab-b:focus-visible{box-shadow:0 0 0 3px var(--accent,var(--color-brand-orange,#F26A1B))}",
    /* The hub is the branch you are in: the same orange as the FAB, and its label says "back". */
    ".gfab-b.is-hub{color:#141414}",
    ".gfab-veil{position:fixed;inset:0;background:rgba(8,12,16,.42);opacity:0;pointer-events:none;",
    "  transition:opacity .18s ease}",
    ".gfab-veil.on{opacity:1;pointer-events:auto}",
    "@media (prefers-reduced-motion:reduce){.gfab-veil{transition:none}}"
  ].join("");

  var NS = "http://www.w3.org/2000/svg";
  var FILTER_ID = "ttb-gfab-goo";
  var EASE = "cubic-bezier(.34,1.56,.64,1)";   // the demo's overshoot: a droplet that lands, then settles
  var DUR = 520, STAGGER = 40, HOME_DUR = 300;

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* The goo filter, once per page: blur, then an alpha contrast step that turns the soft
     overlap of two circles into one solid bridge; `atop` keeps the colours of the source
     inside that shape, so an orange hub and white plates stay their own colour. */
  function ensureFilter() {
    if (document.getElementById(FILTER_ID)) return;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    svg.innerHTML =
      '<defs><filter id="' + FILTER_ID + '" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b"/>' +
      '<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo"/>' +
      '<feComposite in="SourceGraphic" in2="goo" operator="atop"/>' +
      '</filter>' +
      '<radialGradient id="ttb-gfab-disc"><stop offset="0" stop-color="#141414" stop-opacity=".16"/><stop offset=".55" stop-color="#141414" stop-opacity=".07"/><stop offset="1" stop-color="#141414" stop-opacity="0"/></radialGradient>' +
      '</defs>';
    document.body.appendChild(svg);
  }

  function reduced() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function create(opts) {
    opts = opts || {};
    var fab = typeof opts.fab === "string" ? document.querySelector(opts.fab) : opts.fab;
    if (!fab) throw new Error("goo-fab: no fab element");
    var size = opts.size || 44;
    var radii = opts.radii || [86, 162, 238];
    var onPick = typeof opts.onPick === "function" ? opts.onPick : function () {};
    injectCss();
    ensureFilter();

    var root = document.createElement("div");
    root.className = "gfab";
    root.hidden = true;
    root.style.zIndex = String(opts.z || 32);
    var ext = radii[radii.length - 1] + size;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "gfab-svg");
    svg.setAttribute("width", String(ext * 2)); svg.setAttribute("height", String(ext * 2));
    svg.setAttribute("viewBox", (-ext) + " " + (-ext) + " " + (ext * 2) + " " + (ext * 2));
    svg.style.left = (-ext) + "px"; svg.style.top = (-ext) + "px";
    var frame = document.createElementNS(NS, "g"); frame.setAttribute("class", "gfab-rings");
    var disc = document.createElementNS(NS, "circle"); disc.setAttribute("class", "gfab-disc"); disc.setAttribute("r", String(ext)); frame.appendChild(disc);
    var rings = radii.map(function (R) { var c = document.createElementNS(NS, "circle"); c.setAttribute("class", "gfab-ring"); c.setAttribute("r", String(R)); frame.appendChild(c); return c; });
    var spokes = document.createElementNS(NS, "g"); spokes.setAttribute("class", "gfab-spokes"); frame.appendChild(spokes);
    svg.appendChild(frame);
    var inkLayer = document.createElementNS(NS, "g"); inkLayer.setAttribute("filter", "url(#" + FILTER_ID + ")");
    var cardLayer = document.createElementNS(NS, "g"); cardLayer.setAttribute("filter", "url(#" + FILTER_ID + ")");
    var ghosts = document.createElementNS(NS, "g"); ghosts.setAttribute("class", "gfab-ghosts");
    var ghostInk = document.createElementNS(NS, "g"); ghostInk.setAttribute("filter", "url(#" + FILTER_ID + ")");
    var ghostCard = document.createElementNS(NS, "g"); ghostCard.setAttribute("filter", "url(#" + FILTER_ID + ")");
    ghosts.appendChild(ghostInk); ghosts.appendChild(ghostCard);
    svg.appendChild(ghosts); svg.appendChild(inkLayer); svg.appendChild(cardLayer);
    function levelRing(level) {
      rings.forEach(function (c, i) { c.setAttribute("class", "gfab-ring" + (i === Math.min(level, rings.length - 1) ? " is-level" : "")); });
    }
    function ghost(blob, on) {
      blob.btn.classList.toggle("is-ghost", on);
      if (blob.spoke) blob.spoke.classList.toggle("is-ghost", on);
      blob.btn.setAttribute("aria-expanded", "false");
      (on ? ghostInk : inkLayer).appendChild(blob.cIn);
      (on ? ghostCard : cardLayer).appendChild(blob.cCa);
    }
    /* The FAB's own body in the silhouette, under the real button, so the bridges grow from it. */
    var fabInk = circle(inkLayer, "gfab-ink", size / 2 + 2), fabCard = circle(cardLayer, "gfab-hub", size / 2);
    root.appendChild(svg);

    var veil = typeof opts.veil === "string" ? document.querySelector(opts.veil) : opts.veil;
    var ownVeil = false;
    if (!veil) {
      veil = document.createElement("div");
      veil.className = "gfab-veil";
      veil.style.zIndex = String((opts.z || 32) - 1);
      ownVeil = true;
      document.body.appendChild(veil);
    }
    document.body.appendChild(root);
    veil.addEventListener("click", close);

    var levels = [];      // [{nodes, blobs, parent}] from level one outward
    var isOpen = false;

    function circle(layer, cls, r) {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("class", cls);
      c.setAttribute("r", String(r));
      c.setAttribute("cx", "0"); c.setAttribute("cy", "0");
      layer.appendChild(c);
      return c;
    }

    /* The quarter the menu lives on: from straight up (-90°) round to straight left (-180°); the
       corner of the screen eats the rest. Angles run downward from HI to LO. */
    var HI = -Math.PI / 2, LO = -Math.PI;
    var GAP = 14;   // between two plates on the same ring, edge to edge

    /* Where level L's n plates sit. Level one: evenly over the quarter. A branch's children: on
       the next ring, one plate's width apart, centred on the door that opened them (the hub),
       slid along the ring only as far as the corner demands; if they would not fit in the
       quarter at all, the even spread. First child nearest "up", last nearest "left", always. */
    function targets(level, n, parent) {
      var R = radii[Math.min(level, radii.length - 1)];
      var angles = [], k;
      var step = (size + GAP) / R;
      if (parent && (n - 1) * step <= HI - LO) {
        var pa = Math.atan2(parent.y, parent.x);
        if (pa > 0) pa -= Math.PI * 2;                       // the same angle, on our side of the circle
        var span = (n - 1) * step;
        var start = pa + span / 2;                            // the "up" end of the group
        if (start > HI) start = HI;
        if (start - span < LO) start = LO + span;
        for (k = 0; k < n; k++) angles.push(start - k * step);
      } else {
        for (k = 0; k < n; k++) angles.push(HI - (n === 1 ? 0.5 : k / (n - 1)) * (HI - LO));
      }
      return angles.map(function (ang) { return [Math.round(Math.cos(ang) * R), Math.round(Math.sin(ang) * R)]; });
    }

    function place(el, x, y, scale) {
      el.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
    }
    function placeCircle(c, x, y, scale) {
      c.setAttribute("transform", "translate(" + x + " " + y + ") scale(" + scale + ")");
    }

    /* One journey for a plate and its two circles: from (fx,fy) to (tx,ty), growing or shrinking. */
    function travel(blob, from, to, fromScale, toScale, delay, dur, done) {
      var settled = false;
      var land = function () {
        if (settled) return;
        settled = true;
        place(blob.btn, to[0], to[1], toScale); placeCircle(blob.cIn, to[0], to[1], toScale); placeCircle(blob.cCa, to[0], to[1], toScale);
        if (done) done();
      };
      if (reduced() || typeof blob.btn.animate !== "function") {
        land();
        return;
      }
      var frames = [
        { transform: "translate(" + from[0] + "px," + from[1] + "px) scale(" + fromScale + ")" },
        { transform: "translate(" + to[0] + "px," + to[1] + "px) scale(" + toScale + ")" }
      ];
      var timing = { duration: dur, delay: delay, easing: toScale >= fromScale ? EASE : "cubic-bezier(.4,0,.6,1)", fill: "forwards" };
      var a = blob.btn.animate(frames, timing);
      blob.cIn.animate(frames, timing);
      blob.cCa.animate(frames, timing);
      a.onfinish = land;
      /* A journey always lands, even in a tab the browser has put to sleep (where finish events
         can wait indefinitely): otherwise a plate melted into the FAB would stay there, over it. */
      setTimeout(land, delay + dur + 120);
    }

    function makeBlob(node, level) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gfab-b";
      btn.style.width = size + "px"; btn.style.height = size + "px";
      btn.style.left = (-size / 2) + "px"; btn.style.top = (-size / 2) + "px";
      btn.textContent = node.label;
      btn.setAttribute("aria-label", node.label);
      if (node.kids && node.kids.length) btn.setAttribute("aria-haspopup", "true");
      var blob = { node: node, level: level, btn: btn,
        cIn: circle(inkLayer, "gfab-ink", size / 2 + 2), cCa: circle(cardLayer, "gfab-card", size / 2), x: 0, y: 0 };
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        choose(blob);
      });
      root.appendChild(btn);
      return blob;
    }

    function removeBlob(blob) {
      blob.btn.remove(); blob.cIn.remove(); blob.cCa.remove();
      if (blob.spoke) blob.spoke.remove();
    }

    /* Grow a level's plates out of a point: the FAB for level one, the hub plate for a branch. */
    function grow(nodes, level, from, parent) {
      var tg = targets(level, nodes.length, parent);
      var blobs = nodes.map(function (node, k) {
        var b = makeBlob(node, level);
        b.x = tg[k][0]; b.y = tg[k][1];
        place(b.btn, from[0], from[1], .4); placeCircle(b.cIn, from[0], from[1], .4); placeCircle(b.cCa, from[0], from[1], .4);
        /* The spoke from where they grew (the hub, or the FAB) to where they land; shown once they do. */
        var ln = document.createElementNS(NS, "line");
        ln.setAttribute("class", "gfab-spoke");
        ln.setAttribute("x1", String(from[0])); ln.setAttribute("y1", String(from[1]));
        ln.setAttribute("x2", String(b.x)); ln.setAttribute("y2", String(b.y));
        spokes.appendChild(ln);
        b.spoke = ln;
        return b;
      });
      void root.offsetWidth;   // commit the start before the journey, or it is a jump (the arc learned this)
      blobs.forEach(function (b, k) { travel(b, from, [b.x, b.y], .4, 1, k * STAGGER, DUR); });
      var lit = function () { blobs.forEach(function (b) { if (b.spoke) b.spoke.classList.add("on"); }); };
      if (reduced()) lit(); else setTimeout(lit, DUR + (blobs.length - 1) * STAGGER);
      levels.push({ nodes: nodes, blobs: blobs, parent: parent || null });
      if (blobs.length && !reduced()) setTimeout(function () { if (isOpen) blobs[0].btn.focus({ preventScroll: true }); }, DUR);
    }

    /* Melt a set of plates back into a point and take them away once they are there. */
    function melt(blobs, into, done) {
      var left = blobs.length;
      if (!left) { if (done) done(); return; }
      blobs.forEach(function (b) { if (b.spoke) b.spoke.classList.remove("on"); });   // the spokes go first
      blobs.forEach(function (b, k) {
        travel(b, [b.x, b.y], into, 1, .4, k * 18, HOME_DUR, function () {
          removeBlob(b);
          if (--left === 0 && done) done();
        });
      });
    }

    function choose(blob) {
      var lv = levels[blob.level];
      if (!lv) return;
      var next = levels[blob.level + 1];
      if (next && next.parent === blob) return back();   // the hub tapped again: one level up
      if (blob.level !== levels.length - 1) {
        // A ghost (a door not chosen at an inner level): come back to its level, then take it.
        while (levels.length - 1 > blob.level) backOne(false);
        if (levels[blob.level].parent === blob) return;
      }
      var kids = blob.node.kids;
      if (!kids || !kids.length) {
        var key = blob.node.key, node = blob.node;
        close();
        onPick(key, node);
        return;
      }
      /* A branch: this plate becomes the hub and stays; its siblings melt into the FAB; its
         children grow out of it on the next ring. */
      blob.btn.classList.add("is-hub");
      blob.btn.setAttribute("aria-expanded", "true");
      blob.cCa.setAttribute("class", "gfab-hub");
      /* The doors not chosen stay, at half strength, for reference and as a way to switch. */
      lv.blobs.forEach(function (b) { if (b !== blob) ghost(b, true); });
      grow(kids, blob.level + 1, [blob.x, blob.y], blob);
      levelRing(blob.level + 1);
    }

    /* One level up: the children melt into their hub; the hub is a door again, its siblings whole. */
    function backOne(focus) {
      var top = levels.pop();
      var hub = top.parent;
      melt(top.blobs, [hub.x, hub.y]);
      hub.btn.classList.remove("is-hub");
      hub.btn.setAttribute("aria-expanded", "false");
      hub.cCa.setAttribute("class", "gfab-card");
      var lv = levels[levels.length - 1];
      lv.blobs.forEach(function (b) { if (b !== hub) ghost(b, false); });
      levelRing(hub.level);
      if (focus) hub.btn.focus({ preventScroll: true });
    }

    function back() {
      if (levels.length < 2) { close(); return; }
      backOne(true);
    }

    function open(tree) {
      if (isOpen) { close(); return; }
      if (!tree || !tree.length) return;
      var r = fab.getBoundingClientRect();
      root.style.transform = "translate(" + Math.round(r.left + r.width / 2) + "px," + Math.round(r.top + r.height / 2) + "px)";
      root.hidden = false;
      isOpen = true;
      fab.setAttribute("aria-expanded", "true");
      veil.classList.add("on");
      grow(tree, 0, [0, 0], null);
      levelRing(0);
      void frame.getBBox;
      frame.setAttribute("class", "gfab-rings on");
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      fab.setAttribute("aria-expanded", "false");
      veil.classList.remove("on");
      frame.setAttribute("class", "gfab-rings");
      var all = [];
      levels.forEach(function (lv) { lv.blobs.forEach(function (b) { if (all.indexOf(b) < 0) all.push(b); }); });
      levels = [];
      all.forEach(function (b) { if (b.btn.classList.contains("is-ghost")) ghost(b, false); });
      melt(all, [0, 0], function () { if (!isOpen) root.hidden = true; });
      if (!all.length) root.hidden = true;
    }

    function onKey(e) {
      if (!isOpen) return;
      if (e.key === "Escape") { e.preventDefault(); levels.length > 1 ? back() : close(); }
    }
    document.addEventListener("keydown", onKey);

    function destroy() {
      close();
      document.removeEventListener("keydown", onKey);
      root.remove();
      if (ownVeil) veil.remove();
    }

    return { open: open, close: close, back: back, isOpen: function () { return isOpen; }, destroy: destroy, el: root };
  }

  global.createGooFab = create;
})(window);
