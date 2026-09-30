/* webmcp.js — the trip builder, offered as tools to an agent inside the browser.
 *
 * WHAT THIS IS. The WebMCP API (navigator.modelContext) lets a page hand its own actions to an
 * assistant running in the browser — no server, no connector, no install. This file registers
 * four tools that are exactly what /new already does when a person taps: find a place, add a
 * stop, read the trip back, and get the link.
 *
 * WHY IT IS THE RIGHT SHAPE FOR THIS PRODUCT. The MCP server hands somebody a link. This hands
 * the PAGE to an agent sitting beside a person who already has it open — the assistant fills in
 * the trip while they watch it draw. Same six ideas, one less hop, and nothing leaves the
 * browser: the draft lives in the URL fragment either way.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 * EVERY TOOL GOES THROUGH THE PAGE'S OWN FUNCTIONS. `add_stop` calls `addLeg()`, the same
 * function the tap handler calls; `get_trip_link` calls `sendableDraft()`, which validates by
 * decoding the link it just built. A second path that writes trips would drift from the first —
 * that is the whole lesson of `lib/mcp.php` being held to the .mjs by a parity test. There is no
 * parity test that can reach in here, so the defence is that there is no second implementation.
 *
 * ── AND WHAT IT WILL NOT DO ─────────────────────────────────────────────────────────────────
 * No destructive tool. Nothing here deletes a leg, clears the draft or navigates away: the same
 * reasoning as the MCP server's missing delete (D-072), one level down. An agent can build and
 * read; a person still decides what goes away.
 *
 * Feature-detected and silent: on a browser with no navigator.modelContext this file does
 * nothing at all, which is every browser today except Chrome's trial.
 */
(function () {
  "use strict";

  var ctx = typeof navigator !== "undefined" && navigator.modelContext;
  if (!ctx || typeof ctx.registerTool !== "function") return;

  /* BARE IDENTIFIERS, NOT window.*, and that distinction cost the first run of this file.
     new.html declares `routes` with `let`, and a top-level `let` is a global LEXICAL binding —
     visible to every other classic script on the page, but never a property of `window`. So
     `window.routes` was undefined, `ready()` said this was not /new, and the page registered
     nothing at all while looking perfectly healthy. `function` declarations do land on window;
     mixing the two styles is what made it look like the file had not loaded.
     If any of these is missing this is not /new — register nothing rather than register
     something that throws when an agent calls it. */
  function ready() {
    try {
      return typeof addLeg === "function"
          && typeof sendableDraft === "function"
          && Array.isArray(routes);
    } catch (e) { return false; }          // a ReferenceError here just means "not this page"
  }

  var text = function (s) { return { content: [{ type: "text", text: s }] }; };

  /* One controller for the lot: when the page goes away, so do the tools. The spec's own way of
     saying "these are no longer callable", and without it an agent can hold a stale handle. */
  var ac = new AbortController();
  addEventListener("pagehide", function () { ac.abort(); });

  function register() {
    if (!ready()) return;

    ctx.registerTool({
      name: "find_place",
      description:
        "Turn a place name, airport code or landmark into coordinates, so it can be added to the " +
        "trip on this page. Returns up to six candidates with lat/lng and where each one is — pick " +
        "the right one rather than assuming the first. Never invent coordinates: if nothing is " +
        "found, ask the person which place they meant.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "A town, city, airport code (RNO), park or trailhead." } },
        required: ["query"]
      },
      async execute(args) {
        var q = String((args && args.query) || "").trim();
        if (!q) return text("Give me a place name to look up.");
        var r = await fetch("/api/geocode?q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } });
        if (!r.ok) return text("Could not look that up right now (" + r.status + ").");
        var d = await r.json();
        var rows = (d && d.results ? d.results : []).slice(0, 6).map(function (x) {
          return { name: x.name, where: x.full, lat: x.lat, lng: x.lon };
        });
        if (!rows.length) return text('Nothing found for "' + q + '" — try adding the state or country, or an airport code.');
        return {
          content: [{ type: "text", text: rows.map(function (x, i) {
            return (i + 1) + ". " + x.name + " — " + x.lat + ", " + x.lng + (x.where ? "\n   " + x.where : "");
          }).join("\n") }],
          structuredContent: { results: rows }
        };
      }
    }, { signal: ac.signal });

    ctx.registerTool({
      name: "add_stop",
      description:
        "Add a stop to the trip on this page — the first one becomes where the trip starts, every " +
        "one after that becomes a leg ending there. The map draws it immediately, so the person " +
        "watching sees the trip grow. Coordinates are required: call find_place first.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: 'How a person would say it, e.g. "Moab, UT".' },
          lat:  { type: "number", description: "Latitude, -90 to 90." },
          lng:  { type: "number", description: "Longitude, -180 to 180." },
          mode: { type: "string", enum: ["drive", "fly", "train", "ferry", "water", "bike", "walk"],
                  description: "How they travel to this stop. Defaults to drive." }
        },
        required: ["lat", "lng"]
      },
      async execute(args) {
        var a = args || {};
        var lat = Number(a.lat), lng = Number(a.lng);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
          return text("Those coordinates are not on Earth — use find_place to get real ones.");
        var to = { name: String(a.name || "Stop").slice(0, 80), lat: lat, lng: lng };
        var rt = routes[typeof active === "number" ? active : 0];
        if (!rt.origin && !rt.legs.length) {
          rt.origin = to;
          if (typeof render === "function") render();
          if (typeof frameTrip === "function") frameTrip(true);
          return text('"' + to.name + '" is where the trip starts. Add the next stop and it becomes the first leg.');
        }
        addLeg(to);
        /* The page owns the mode; setting it after the fact keeps addLeg's own defaulting
           (nextMode) as the single source of what a leg is when nobody said. */
        if (a.mode && rt.legs.length) {
          var last = rt.legs[rt.legs.length - 1];
          if (["drive", "fly", "train", "ferry", "water", "bike", "walk"].indexOf(a.mode) >= 0) {
            last.mode = a.mode;
            if (typeof render === "function") render();
          }
        }
        return text('Added "' + to.name + '". The trip now has ' + rt.legs.length +
                    " leg" + (rt.legs.length === 1 ? "" : "s") + ".");
      }
    }, { signal: ac.signal });

    ctx.registerTool({
      name: "read_trip",
      description:
        "Read back the trip currently on this page — where it starts, every leg in order, the mode " +
        "and date of each. Use it before changing anything, and to tell the person what they have.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        var rt = routes[typeof active === "number" ? active : 0];
        if (!rt || (!rt.origin && !rt.legs.length)) return text("Nothing on the page yet — the trip is empty.");
        var out = { origin: rt.origin || null, legs: rt.legs.map(function (l) {
          return { to: l.to, mode: l.mode || "drive", date: l.date || null, note: l.note || "" };
        }) };
        var lines = out.legs.map(function (l, i) {
          return (i + 1) + ". " + ((l.to && l.to.name) || "an unnamed place") +
                 (l.date ? "  —  " + l.date : "") + "  —  " + l.mode;
        });
        return {
          content: [{ type: "text", text: "Starts: " + ((out.origin && out.origin.name) || "not set") +
                       (lines.length ? "\n" + lines.join("\n") : "\nNo legs yet.") }],
          structuredContent: out
        };
      }
    }, { signal: ac.signal });

    ctx.registerTool({
      name: "get_trip_link",
      description:
        "Get the shareable link for the trip on this page and give it to the person. The whole trip " +
        "is encoded in the link itself, so it needs no account to open and nothing was sent anywhere. " +
        "Hand them the link rather than describing it.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        var s = sendableDraft();
        if (s.why === "empty")  return text("Nothing to link yet — add a stop first.");
        if (s.why === "toobig") return text("This trip is too big for a link. The person can keep it instead and share that.");
        if (s.why)              return text("Could not build a link this page can read back, so there is nothing safe to hand over.");
        var note = s.lostTracks > 0
          ? "\n\nNot included: " + s.lostTracks + " other vehicle" + (s.lostTracks === 1 ? "" : "s") + "."
          : "";
        return {
          content: [{ type: "text", text: s.url + note }],
          structuredContent: { link: s.url, characters: s.chars }
        };
      }
    }, { signal: ac.signal });
  }

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", register);
  else register();
})();
