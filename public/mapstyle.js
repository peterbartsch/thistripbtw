/* this trip, btw — the vector basemap's colours (?pm=1).
 *
 * protomapsL.paintRules(theme) and labelRules(theme) build the default rule set from a plain
 * object of colours. This is that object, twice: one for day, one for night. Nineteen paint keys
 * and twelve label keys, which is the whole surface — enumerated by handing the factories a Proxy
 * and recording what they asked for, rather than guessed at.
 *
 * ── THE ONE RULE THAT DECIDES EVERY COLOUR HERE ────────────────────────────────────────────
 * THE BASEMAP MUST RECEDE. It is the paper, not the drawing. What matters on this map is the
 * route and the pins: amber #F2A900, blue #3E7CB1, rail purple #8A6FB0, self-powered teal
 * #1B9AAA, gold stops, teal signs. A basemap with any saturation of its own fights all six.
 * That is why CARTO's Positron and Dark Matter are the two styles this product chose in the
 * first place, and matching their restraint matters more than matching their exact greys.
 *
 * So: no colour here is taken straight from the brand palette. The route ramp and the steel ramp
 * are the product's foreground; these are drawn from the same families, desaturated and pushed
 * toward the ends of the value scale until they stop competing.
 *
 * ── WHERE THE TWO THEMES ANCHOR ────────────────────────────────────────────────────────────
 * Night's land is #121821, which is the sheet's own background (rgb(18,24,29)) to within a
 * hair. That is deliberate: when the sheet is half open on a phone the map and the sheet should
 * read as one surface with a seam, not as two panels of different greys.
 * Day's land is a hair cooler than white and its roads are a step DARKER — see the note by
 * `major`. Positron goes the other way, white roads on grey land, but that only works with a
 * casing under each road and these default rules draw none.
 *
 * Shared, not copied into both pages: app.html and new.html cannot import from each other, so
 * anything living in both drifts. legs.js exists because arcPoints was wrong in both and had to
 * be fixed twice on the same day.
 */
(function (w) {
  'use strict';

  /* DAY. Near-white land, grey roads, pale blue-grey water. The whole range from land to
     building to water spans about 8% of the value scale — deliberately almost flat, so that a
     route line at full saturation is the only strong thing on screen. */
  var light = {
    earth:      '#F4F5F6',
    glacier:    '#FAFBFC',
    beach:      '#EFEDE6',
    sand:       '#EFEDE6',
    park_b:     '#E7EBE5',   // _b = the polygon fill; a faint green-grey, not a green
    scrub_b:    '#EAEDE7',
    industrial: '#EDECEA',
    school:     '#ECEBEA',
    hospital:   '#EFEAEA',
    zoo:        '#E9ECE7',
    aerodrome:  '#E9EBEE',
    runway:     '#DDE1E6',
    pier:       '#E6E8EA',
    buildings:  '#E2E4E7',
    water:      '#CBDDE7',
    wetland:    '#E6EAE8',   // wet GROUND, not standing water — barely off `earth`
    /* DARKER than the land, not lighter. Positron draws white roads with a grey casing; these
       default rules have no casing, so white-on-near-white measured 1.12:1 and simply vanished —
       a city block at z13 showed no street grid at all. Grey roads on near-white land is the
       other way to do it and needs no casing. */
    major:      '#DCE0E4',
    pedestrian: '#E9ECEF',
    railway:    '#D2D7DC',
    boundaries: '#B9C2CA',

    city_label:             '#2C3A47',   // --color-steel-1
    city_label_halo:        '#F4F5F6',
    city_circle:            '#8A9CAA',   // --color-steel-3
    city_circle_stroke:     '#F4F5F6',
    state_label:            '#7C8B99',
    state_label_halo:       '#F4F5F6',
    country_label:          '#6C7B89',
    ocean_label:            '#8FAAB9',
    roads_label_major:      '#6E7C89',
    roads_label_major_halo: '#FFFFFF',
    roads_label_minor:      '#8A9CAA',
    roads_label_minor_halo: '#FFFFFF'
  };

  /* NIGHT. Land darker than water, which is the inverse of daytime intuition and is what every
     good dark basemap does: water reads as a slightly lifted shape rather than a hole. Roads sit
     just above the land, never white — a white road grid at night is a lightbox, and the route
     line has to win. */
  var dark = {
    earth:      '#121821',   // the sheet's own background, so map and sheet read as one surface
    glacier:    '#1A222C',
    beach:      '#1A1F26',
    sand:       '#1A1F26',
    park_b:     '#141C1F',
    scrub_b:    '#151B20',
    industrial: '#171D25',
    school:     '#171C24',
    hospital:   '#1B1B24',
    zoo:        '#141C1D',
    aerodrome:  '#181E27',
    runway:     '#232B36',
    pier:       '#1B222B',
    buildings:  '#1B222C',
    water:      '#0F1A24',
    wetland:    '#151C22',   // wet GROUND, not standing water — barely off `earth`
    /* #46545F, not --color-steel-1. The brand's darkest steel measured 1.53:1 against this land
       and downtown Reno at z13 showed no street grid whatsoever — the token was the right family
       and the wrong value. 2.29:1 is present without glowing; a night basemap that shouts its
       roads competes with the route line, which is the one thing that must win. */
    major:      '#46545F',
    pedestrian: '#2A333D',
    railway:    '#232B36',
    boundaries: '#3A4550',

    city_label:             '#AEBEC8',   // --color-steel-4
    city_label_halo:        '#0C1016',
    city_circle:            '#556B7D',   // --color-steel-2
    city_circle_stroke:     '#0C1016',
    state_label:            '#7B8A97',
    state_label_halo:       '#0C1016',
    country_label:          '#8A9CAA',
    ocean_label:            '#3E5666',
    roads_label_major:      '#93A2AF',
    roads_label_major_halo: '#0C1016',
    roads_label_minor:      '#6E7C89',
    roads_label_minor_halo: '#0C1016'
  };

  /* ── OUR OWN RULES, and the library's are unusable here ────────────────────────────────
   * protomapsL.paintRules(theme) looked like the obvious way to do this and produces a map with
   * NOTHING on it but land and water. Its filters read `pmap:kind`; the Protomaps basemap v4
   * archive supplies `kind`. Straight from the minified source of a default road rule:
   *
   *     (e,t)=>{let n=Y(t.props,"pmap:kind"); return ["other","path"].includes(n)}
   *
   * So every filtered layer — every road, every building, every label — matched nothing, while
   * the two UNFILTERED fills (earth, water) drew fine. That is exactly what it looked like:
   * a plausible, quiet, empty map. Measured before this existed: 93.8% earth, 3.2% water,
   * ZERO road pixels, zero building pixels, zero label pixels, at z13 over downtown Reno.
   * `pmap:kind` is the older schema; the daily build moved to `kind`. Version numbers agreeing
   * (library 4.1.1, basemap 4.15.1) did not mean the schemas did.
   *
   * The kinds the v4 archive actually carries, read out of a real tile rather than assumed:
   *   roads      major_road, minor_road, highway, path, rail
   *   buildings  building
   *   places     locality
   *
   * Widths scale with zoom because a fixed width is either a hairline on a city block or a
   * smear across a state. The numbers are deliberately modest: this basemap is the paper. */
  function rules(night) {
    var P = w.protomapsL;
    if (!P) return null;
    var th = branded(night ? dark : light, night);
    var K = function (f) { return f.props.kind; };
    var has = function (list) { return function (z, f) { return list.indexOf(K(f)) !== -1; }; };
    /* `kind` OR `kind_detail`, because the archive uses both and which one depends on the zoom.
       See the water rules below for how that cost a fix its whole effect. */
    var hasEither = function (list) {
      return function (z, f) {
        return list.indexOf(f.props.kind) !== -1 || list.indexOf(f.props.kind_detail) !== -1;
      };
    };
    /* 🔴 A PolygonSymbolizer WILL HAPPILY FILL A LINESTRING, AND THAT WAS §2bv.
       Decoded out of the PER-TRIP archive, z10/169/390 over the Sierra, `water` layer, verbatim:

           #  geom     kind    kind_detail  rings  pts   widest ring span
           0  line     river   None             1  146   3584 /4096   <<<
           1  line     river   None             2  130   2414 /4096
           5  polygon  lake    None             3   51    330 /4096
           7  polygon  water   lake            26  457    738 /4096

       Five LINE features carrying `kind:'river'`, one spanning 3584 of 4096 units diagonally —
       filled as polygons, which is precisely the long pale diagonal band people reported for a
       week. The lakes on rows 5-7 are polygons and were always correct.
       WHY IT ONLY SHOWED ON THE TRIP LAYER: the per-trip archive is cut from build.protomaps.com
       and carries rivers as LINES; `world-z7.pmtiles.bin` carries them as POLYGONS
       (`kind:'water', kind_detail:'river'`). Two archives, two schemas, one set of rules — so the
       same rule was right on one layer and wrong on the other, and every fix aimed at WHICH
       polygons are water missed, because the geometry was never a polygon at all.
       MVT geometry types are 1=point 2=line 3=polygon and the vendored build passes the raw
       number through (`geomType: o.feature(c).type`), so this needs no library constant. */
    var poly = function (also) {
      return function (z, f) { return f.geomType === 3 && (!also || also(z, f)); };
    };
    var line = function (also) {
      return function (z, f) { return f.geomType === 2 && (!also || also(z, f)); };
    };
    /* Roads thicken with zoom. A highway at z8 wants a hairline; at z14 it wants to read as a
       road. Anything steeper than this starts competing with the route line. */
    var w2 = function (base) { return function (z) { return z < 9 ? base * 0.5 : z < 12 ? base * 0.75 : z < 14 ? base : base * 1.35; }; };

    var paint = [
      { dataLayer: 'earth',     symbolizer: new P.PolygonSymbolizer({ fill: th.earth }) },
      /* LANDCOVER, which the wide zooms live on. Without it everything from z5 to z10 is one flat
         sheet of `earth` — technically correct and visually dead, and on a road trip those are
         exactly the zooms you look at most. It is a low-zoom layer (absent by z11, where landuse
         and buildings take over), carrying forest, scrub, grassland, farmland, barren and
         urban_area. Painted directly over earth and under everything else. */
      { dataLayer: 'landcover', symbolizer: new P.PolygonSymbolizer({ fill: th.park_b }),
        filter: has(['forest']) },
      { dataLayer: 'landcover', symbolizer: new P.PolygonSymbolizer({ fill: th.scrub_b }),
        filter: has(['scrub', 'grassland', 'farmland']) },
      { dataLayer: 'landcover', symbolizer: new P.PolygonSymbolizer({ fill: th.sand }),
        filter: has(['barren']) },
      { dataLayer: 'landcover', symbolizer: new P.PolygonSymbolizer({ fill: th.industrial }),
        filter: has(['urban_area']) },
      { dataLayer: 'landuse',   symbolizer: new P.PolygonSymbolizer({ fill: th.park_b }),
        filter: has(['park', 'forest', 'wood', 'nature_reserve', 'grass', 'meadow', 'recreation_ground']) },
      { dataLayer: 'landuse',   symbolizer: new P.PolygonSymbolizer({ fill: th.scrub_b }),
        filter: has(['scrub', 'heath', 'farmland', 'orchard']) },
      { dataLayer: 'landuse',   symbolizer: new P.PolygonSymbolizer({ fill: th.aerodrome }),
        filter: has(['aerodrome']) },
      { dataLayer: 'landuse',   symbolizer: new P.PolygonSymbolizer({ fill: th.beach }),
        filter: has(['beach', 'sand']) },
      /* WETLAND LIVES HERE, and until now nothing drew it: it fell through every rule to bare
         `earth`. It is ground you would not walk across, so it reads as ground with a tint —
         never as water, which is the complaint this fixes. */
      { dataLayer: 'landuse',   symbolizer: new P.PolygonSymbolizer({ fill: th.wetland }),
        filter: has(['wetland', 'marsh', 'swamp', 'bog', 'fen', 'mud', 'saltmarsh']) },
      /* WATER IS NOT ONE THING, and the first attempt at this WAS A NO-OP — it filtered the water
         layer for 'wetland', 'swamp', 'marsh', 'playa', 'riverbank' and 'mud', and this archive
         has none of them, so every polygon kept full lake-blue and Peter saw the same false
         waterbodies twice.
         THE KINDS THIS ARCHIVE ACTUALLY CARRIES, decoded out of real z8 tiles rather than
         assumed (Everglades 8/70/108, Des Plaines 8/65/95, Tahoe 8/42/97):
           water     basin, canal, lake, ocean, reef, river, water
           landuse   …, wetland, wood, scrub, sand, bare_rock, …
         So **wetland is in LANDUSE, not water** — that is the whole bug, and it is the same
         family as the `pmap:kind` trap: a filter that matches nothing looks exactly like a
         feature that is not there.
         `basin` is the other half. OSM's landuse=basin is a retention or flood-control basin —
         dry most of the year — and it is what hugs the Des Plaines near O'Hare. Painting it lake
         blue is what drew the "flood zone" outline. It gets the wet-ground tone.
         Order matters: the specific rule paints over the general one. */
      { dataLayer: 'water',     symbolizer: new P.PolygonSymbolizer({ fill: th.water }),
        filter: poly() },
      /* AND THE SAME TRAP ONE ZOOM DOWN, found 2026-09-03 by decoding z7/20/48 and z7/20/49 out
         of world-z7.pmtiles.bin rather than assuming the z8 shape held.
         AT z7 EVERY WATER FEATURE HAS `kind: "water"`. What separates them is `kind_detail`:
           {kind:'ocean'} · {kind:'water', kind_detail:'lake'} · {kind:'water', kind_detail:'river'}
           {kind:'water'} · {kind:'water', kind_detail:'basin'} · {kind:'water', kind_detail:'canal'}
         So `has(['basin'])` on `kind` matched NOTHING at z7 and the basin rescue was a no-op —
         the identical failure the previous fix had, one zoom level lower. z8 really does carry
         `basin` as a kind; z7 does not, and the base archive is z0-7, which is every wide view.
         AND THE FEATURES ARE MULTIPOLYGONS: five features carry ALL the water in a tile, so one
         unrescued basin polygon paints every flood basin and rice paddy in the Central Valley
         lake-blue at once. That is the sheet of false water west of Tahoe.
         Checking BOTH props is the fix, and it is deliberately not a rewrite: if a future build
         moves the value back to `kind`, this keeps working. */
      { dataLayer: 'water',     symbolizer: new P.PolygonSymbolizer({ fill: th.wetland }),
        filter: poly(hasEither(['basin', 'wetland', 'marsh', 'swamp', 'playa', 'mud'])) },
      /* ...and now that they are no longer being FILLED, rivers and canals have to be DRAWN, or
         the fix trades a false lake for a missing river. They are lines in this archive, so they
         get a line: thin, water-coloured, under the roads. */
      { dataLayer: 'water',     symbolizer: new P.LineSymbolizer({ color: th.water, width: w2(0.9) }),
        filter: line() },
      { dataLayer: 'buildings', symbolizer: new P.PolygonSymbolizer({ fill: th.buildings }), minzoom: 13 },
      /* Order matters: paths under minor under major under highway, so a junction reads right. */
      { dataLayer: 'roads', symbolizer: new P.LineSymbolizer({ color: th.pedestrian, width: w2(0.7) }),
        filter: has(['path']), minzoom: 14 },
      { dataLayer: 'roads', symbolizer: new P.LineSymbolizer({ color: th.pedestrian, width: w2(0.9) }),
        filter: has(['minor_road']), minzoom: 12 },
      { dataLayer: 'roads', symbolizer: new P.LineSymbolizer({ color: th.railway, width: w2(0.7) }),
        filter: has(['rail']), minzoom: 11 },
      { dataLayer: 'roads', symbolizer: new P.LineSymbolizer({ color: th.major, width: w2(1.4) }),
        filter: has(['major_road']) },
      { dataLayer: 'roads', symbolizer: new P.LineSymbolizer({ color: th.major, width: w2(2.2) }),
        filter: has(['highway']) },
      { dataLayer: 'boundaries', symbolizer: new P.LineSymbolizer({ color: th.boundaries, width: 0.8 }) }
    ];

    /* Place names only. Road shields and POI labels are deliberately absent: the trip's own pins
       and leg chips are the labels that matter, and a basemap that names every street competes
       with them. This is the one place where less is a decision rather than a shortcut. */
    var labels = [
      { dataLayer: 'places', minzoom: 4,
        filter: function (z, f) { return K(f) === 'locality'; },
        symbolizer: new P.CenteredTextSymbolizer({
          labelProps: ['name'],
          fill: th.city_label, stroke: th.city_label_halo, width: 2,
          font: function (z) { return (z < 8 ? '600 11px ' : '600 12px ') + 'Barlow, system-ui, sans-serif'; }
        }) }
    ];

    return { paintRules: paint, labelRules: labels, backgroundColor: th.earth };
  }

  /** Layer options for a theme. The default background is #cccccc, a grey slab wherever the
   *  archive has no data; matching `earth` makes a region edge look like plain country. */
  /* ── ?brand=1 — THE MAP IN THE PRODUCT'S OWN COLOURS (prototype, 2026-09-03) ──────────────
     Peter: "can we style the maps to be more on brand and unique feeling". The reason it reads
     generic is a DECISION already in this file — the basemap is the paper, the palette spans
     about 8% of the value scale, and the gold route line is the figure. A vivid basemap fights
     the route, so this does NOT touch `earth` or raise saturation across the board. It changes
     the two things that are figure rather than ground:

       LABELS  place names are already set in Barlow, the brand face, and coloured neutral grey.
               Brand teal instead. Measured on `earth`: #035A83 gives 6.89:1, past AA with room,
               where the old #2C3A47 gave 10.67. Labels are the one map element a reader looks
               AT rather than through, so they can carry identity at no cost to the route.
       WATER   #CBDDE7 is Positron's blue. A teal-family water of the same value reads as ours
               and, usefully, separates water from wetland by FAMILY rather than by 5% of
               lightness: light water-vs-wetland goes 1.15:1 -> 1.20:1, so the thing Peter
               reported gets marginally better here even before the kind question is settled.

     Numbers, all measured rather than picked by eye — see the commit for the arithmetic. Dark
     lifts the wetland instead of dropping the water, because both were already near-black and
     dropping water made the pair WORSE. */
  /* LABELS SOFTENED 2026-09-03. Peter, on the first version: "labels are too much, water is
     right." The first pass used brand teal straight — #035A83, 6.89:1 — and the mistake was
     treating a label like a sign. A guide sign is meant to be read AT; a place name on a basemap
     is read THROUGH, on the way to the route. So the cast stays and the saturation goes: these
     are the ORIGINAL weights with a teal bias, #28414F at 9.82:1 against the old neutral's
     10.67, rather than a different colour at a different weight. Water is unchanged — it was
     the half that landed. */
  /* CITY NAMES ONLY, 2026-09-03, and the two corrections that got here are the point.
     First pass: brand teal on every label — "too much". Second: a teal CAST on every label at the
     original weight — measured right and read as no change at all, which is its own failure.
     The answer is neither strength nor spread but PLACEMENT. City names are the labels a person
     actually reads on a trip map; state, country, ocean and road labels are furniture. So the
     teal goes where it is looked at and nowhere else. Everything not listed here is deliberately
     ABSENT rather than restated, so it inherits the neutral original and a future change to that
     original is not silently overridden by a stale copy. */
  var brandLight = {
    water: '#C2DAE0',
    city_label: '#035A83'          /* brand teal, 6.89:1 on earth */
  };
  var brandDark = {
    water: '#0D1F28', wetland: '#1C2426',
    /* The brand teal is unreadable on a dark map, so dark takes the same HUE lifted to a legible
       value rather than the same hex: 9.21:1 against the dark earth. Same rule as light — city
       names only, everything else inherits. */
    city_label: '#8FC2D6'
  };
  /* Read once, here, rather than in each page: both /new and the trip page get the same map
     from `options()`, so the flag belongs with the style and not with either host. */
  var BRAND = (function () {
    /* THE HOST'S GLOBAL FIRST, and that is not belt-and-braces. This file is loaded DYNAMICALLY
       (new.html:1357, app.html:3695), so it executes AFTER the page's inline script has run its
       `history.replaceState(null,"",location.pathname)` — by which time `location.search` is
       empty and a flag read here would always be false. That is the same trap §2v hit when
       `?bar=1` on a trip page silently did nothing. The host captures the flag at boot and
       hands it over; the query read stays as a fallback for anyone loading this file directly. */
    if (w.TTB_BRAND === true) return true;
    try { return new URLSearchParams(w.location.search).has("brand"); } catch (e) { return false; }
  })();
  function branded(th, night) {
    if (!BRAND) return th;
    var out = {}, k;
    for (k in th) if (Object.prototype.hasOwnProperty.call(th, k)) out[k] = th[k];
    var over = night ? brandDark : brandLight;
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    return out;
  }

  function options(night) { return rules(night); }

  /* ── ?capwater=1 — MITIGATION for §2bv, the false water at z10+ ───────────────────────────
     The world archive (z0-7) paints water across land at three levels of overzoom. Six
     hypotheses are dead: the data is clean at z7/21/48, 20/48 and 20/49 (widest lake ring 625 of
     4096), the rings all wind the same way with 3 bbox overlaps in 1081, and the library starts
     every ring with moveTo. What is left is protomaps-leaflet 4.1.1's own overzoom path, and it
     is PINNED — 5.x targets schema v5 and renders nothing against this v4 build.
     So this treats the symptom, and only for the WORLD layer: above `z` its water polygons stop
     painting, leaving land where the false sheets were. It is not a fix and the comment should
     not pretend otherwise.
     WHY THE TRIP PAGE CAN AFFORD IT: the per-trip archive is z0-13 and cut to the route, so the
     water you are actually looking at — the lake beside your stops — is drawn by THAT layer,
     uncapped. What is lost is real distant water far from the trip, which is the trade to judge.
     `/new` must NOT use this: it has no per-trip archive, so capping there would delete every
     lake above z9.

     ⚠ TESTED 2026-09-04 AND IT DID NOT WORK — KEPT AS THE RECORD OF THAT, NOT AS A FIX.
     Measured off the screenshots with PIL: false water at z10 was 13.0% of the map area without
     the flag and 12.9% with it; z11 went 10.3% to 10.2%. The flag demonstrably APPLIED — a live
     probe returned `TTB_CAPWATER: true` with both water rules carrying `maxzoom: 9`.
     **So the false water is NOT painted by the world layer's water rules**, which disproves the
     conclusion §2bv had reached from the per-trip archive's coverage map. Whatever draws it is
     either the per-trip layer or a path nobody has looked at yet. Do not spend another round on
     the world layer. */
  function optionsWorld(night) {
    var st = rules(night);
    if (!CAPWATER || !st) return st;
    st.paintRules = st.paintRules.map(function (r) {
      if (r.dataLayer !== "water") return r;
      var c = {}; for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k];
      c.maxzoom = CAPWATER;          /* the library gates on h.maxzoom && z > h.maxzoom */
      return c;
    });
    return st;
  }
  var CAPWATER = (function () {
    if (w.TTB_CAPWATER === true) return 9;
    try { return new URLSearchParams(w.location.search).has("capwater") ? 9 : 0; } catch (e) { return 0; }
  })();

  w.ttbMapStyle = { light: light, dark: dark, options: options, optionsWorld: optionsWorld, rules: rules };
})(window);
