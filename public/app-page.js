/* ═════════ identity: slug (from host OR path) + word-phrase key ═════════ */
/* D-021 put trips at /{slug}. Subdomains — {slug}.thistripbtw.us — are being added back on top
   of that, so BOTH shapes must resolve to the same trip, the same API and the same stored key.
   The origin only ever serves the path shape (a Cloudflare routing Worker rewrites the
   subdomain to it), so everything here is about which shape the BROWSER is on, never what the
   server sees. Path URLs keep working permanently and deliberately: they are the escape hatch
   if the Worker is down, so a routing outage degrades to an ugly URL instead of an outage. */
const HOST_PARTS = location.hostname.split(".");
/* A trip subdomain is one extra label in front of the apex ({slug}.thistripbtw.us → 3 parts) or
   in front of a bare dev host ({slug}.localhost → 2). The test is the
   slug's own shape: 7 chars of SLUG_ALPHABET, which has no o/i/l/0/1 — hence [a-hj-km-np-z2-9]
   rather than [a-z2-9]. That exclusion is doing real work: a plain a-z class matches "account",
   a RESERVED word of exactly 7 letters, so account.thistripbtw.us would have been read as a
   trip. Caught by testing the hostnames rather than the regex. With o/i/l excluded, no RESERVED
   word can pass — the 7-letter ones ("privacy", "mission", "account") all contain one. */
const HOST_SLUG = (/^[a-hj-km-np-z2-9]{7}$/.test(HOST_PARTS[0])
                   && (HOST_PARTS.length >= 3
                       || (HOST_PARTS.length === 2 && HOST_PARTS[1] === "localhost")))
                  ? HOST_PARTS[0] : "";
const slug = HOST_SLUG || location.pathname.split("/").filter(Boolean)[0] || "";
/* On a subdomain the slug IS the host, so the API sits at /api/*; on a path it stays at
   /{slug}/api/*. Every fetch goes through this — a hardcoded "/"+slug+"/api" is correct in
   exactly one of the two shapes and silently 404s in the other. */
const API_BASE = HOST_SLUG ? "" : "/" + slug;
/* Links a human copies must match the shape they are already on, or they paste a URL with a
   doubled slash or a missing slug. */
const TRIP_BASE = HOST_SLUG ? location.origin : location.origin + "/" + slug;
// key: #k= fragment wins (then scrub from URL bar), else localStorage, else gate
const hashKey = new URLSearchParams(location.hash.slice(1)).get("k");
let KEY = hashKey || localStorage.getItem("ttb_key_" + slug) || "";
/* §2v: read any prototype flag BEFORE the scrub below, which replaces the whole URL with
   the bare path — query string included. A flag read later sees `location.search === ""`
   and silently does nothing, which is exactly how ?bar=1 appeared to be broken on the
   deployed page while the code was in fact present and correct. */
const FLAGS = new URLSearchParams(location.search);
/* mapstyle.js loads dynamically, so it would read an empty search after the replaceState
   below. FLAGS is captured at boot for exactly this reason — hand the map its flag here. */
try{ window.TTB_BRAND = FLAGS.has("brand"); }catch(e){}
try{ window.TTB_CAPWATER = FLAGS.has("capwater"); }catch(e){}
try{ window.TTB_TRIPWATER = FLAGS.has("tripwater"); }catch(e){}
/* ?join=1 — move 6: tell an editor recipient the trip is theirs to add to. */
try{ if(FLAGS.has("join")) document.body.classList.add("join"); }catch(e){}
/* ?topbanner=1 — the account offer back across the top, the way it was until 2026-09-10. */
try{ if(FLAGS.has("topbanner")) document.body.classList.add("topbanner"); }catch(e){}
/* TRACK LETTERS ARE THE DEFAULT SINCE 2026-09-10 (D-185) — a letter on the pins when a trip has
   more than one vehicle, so two stops numbered 4 stop reading as duplicates, with the track chips
   carrying the same letter as the legend. `?nolabels=1` is the way back; `?tracks=1` still works
   and now changes nothing. Default-on in the catch, same reason as D-168/D-182/D-183/D-184. */
try{ if(!FLAGS.has("nolabels")) document.body.classList.add("tracks"); }catch(e){ document.body.classList.add("tracks"); }
/* KEEP THE QUERY. The scrub exists to get `#k=<phrase>` out of the address bar; taking the query
   with it was collateral. FLAGS above means a flag still WORKS on the load that carried it — but
   the address bar loses it, so a pull-to-refresh silently drops back to the default and the next
   thing you look at is not the thing you think you are looking at. On a handset, where every one
   of these flags is judged, that is an instrument that lies about which variant is on screen.
   §2ab fixed exactly this on /new when a copied draft link died at one hop; same defect, same
   fix. The fragment still goes, which is the whole point of the scrub. */
if (hashKey) history.replaceState(null, "", location.pathname + location.search);
let CURRENT_NAME = localStorage.getItem("ttb_name") || "";

const TRACK_COLORS = {
  light:{truck:"#F26A1B", rental:"#0A4DA2"},
  dark: {truck:"#F26A1B", rental:"#5B8FE0"}   /* D-197; the night blue is lifted or it is 2.2:1 on the dark basemap */
};
const trackColor = t => TRACK_COLORS[document.documentElement.dataset.theme==="dark"?"dark":"light"][t];
/* A leg you travel under your own power is not the vehicle, and drawing it in the vehicle's
   colour says the truck went down the river (D-042). Water and rail get their own line
   colour; the PINS stay the vehicle's colour, because the stops still belong to its chain. */
/* Self-powered legs share one colour on purpose: the distinction worth carrying on the map is
   "under your own power" versus "in a vehicle", and the icon already says which of the three it
   is. D-048's point was that colour had been papering over a modelling question — this is the
   colour finally meaning the category rather than standing in for it. */
const SELF_POWERED = ["water","bike","walk"];
/* CAN THIS LEG BE TRACED, AND IS IT DRAWN STRAIGHT UNTIL IT IS? Same answer to both, which is
   the point of having one predicate. A drive leg follows the road (`drawRoadRun`) and a flight
   gets an arc; everything else — boat, rail, ferry, bike, walk — is a straight line between two
   points until somebody draws the real one, and a straight line between two points goes wherever
   the geometry sends it, including through a mountain or across a headland.

   THIS REPLACES TWO LISTS THAT DISAGREED, in opposite directions, in the two files:
     · app.html offered "Draw the bike route" and "Draw the walking route" but `drawMap` only
       honoured a path for `water` and `train` — so a bike or walking route somebody traced by
       hand was stored and then SILENTLY NEVER DRAWN. The control did nothing visible.
     · new.html was the mirror image: its renderer honoured a path for any non-fly leg, but it
       only offered the button for water and train, so ferry/bike/walk could never get one.
   One rule now: if it is not driven and not flown, it can be traced, and its trace is drawn. */
const canTrace = m => !!m && m !== "drive" && m !== "fly";
/* WHICH LEGS FOLLOW ROADS. Drive always did, through the road RUN. Bike and walk drew a straight
   chord, and on the Tahoe demo that is a bike line across the lake — Peter, 2026-08-08: "the bike
   path is just crazy on this trip, it should route to at least roads."
   READ THE CLAIM CAREFULLY, BECAUSE IT IS NARROWER THAN IT LOOKS. This is a ROAD route, not a
   bike route. Measured against `router.project-osrm.org` on 2026-08-08: /route/v1/bike, /foot,
   and even the nonsense /cycling and /walking all return BYTE-IDENTICAL geometry to /driving —
   same weight 4410, same duration 1128.5, same distance 14202.2 on a Tahoe pair. The demo server
   ignores the profile segment entirely and answers with the car profile every time, so there is
   no cycling graph upstream to ask. Sending `bike` in the URL would have looked like bike routing
   and been car routing with a label, which is worse than being plain about it.
   So the honest statement is the one the nudge now makes: it follows roads, and if you took a
   trail, trace it. That is why canTrace still returns true for bike and walk — a road is a better
   default than a chord and still not the towpath somebody actually rode. A hand-drawn path wins
   over a routed one wherever both exist (D-117: a traced line exists once).
   RAIL, BOAT AND FERRY ARE DELIBERATELY ABSENT. A train does not follow the road network, and a
   routed rail leg would be a confident, plausible, wrong line — the failure §2aa exists to stop,
   arrived at from the other direction. They keep the chord and the tracer. */
const ROAD_MODES = ["drive", "bike", "walk"];
const followsRoads = m => ROAD_MODES.includes(m || "drive");
const TRACE_NOUN = {water:"boat", train:"rail", ferry:"ferry", bike:"bike", walk:"walking"};
/* MODE COLOURS AND DASH SIGNATURES LIVE IN legs.js (D-159), because they are needed identically
   here and in new.html and a table typed into both pages drifts — §2ae(3) measured seven such
   functions, and arcPoints had to be fixed twice in one day. `legColor(mode, trackCol)` and
   `legDash(mode)` come from there; DESIGN.md carries the human-facing table. Drive and fly are
   deliberately absent from it, so they fall back to trackCol and keep vehicle identity. */
/* D-048: a craft is a small self-powered boat/bike that belongs to the trip, not to a vehicle.
   One field carries both halves of that, because the leg's mode already says which half:
     · water + a craft  → the craft IS the vehicle for that leg, and it is the only one shown
     · anything else + a craft → the craft is CARGO on that leg, riding on the vehicle's chain
   D-042 gave the paddle its own colour, which papered over exactly this: the question was
   never colour, it was whose leg it is. */
const isCraftLeg = s => !!(s && s.craft && SELF_POWERED.includes(s.mode));
const CRAFT_COLOR = "#1B9AAA";
let TRACK_LABELS = { truck:"Vehicle 1", rental:"Vehicle 2" };

const SEAL_RADIUS_MI = 30;      // sealed drops (D-010)
/* D-124: a custom geofence prints in the unit a person would use. The server's own
   "still N feet too far" message switches at a mile, so this matches it rather than
   inventing a second convention. */

function miles(aLat,aLng,bLat,bLng){
  const R=3958.8, d=Math.PI/180;
  const x=(bLat-aLat)*d, y=(bLng-aLng)*d;
  const h=Math.sin(x/2)**2 + Math.cos(aLat*d)*Math.cos(bLat*d)*Math.sin(y/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
/* `'` and `>` added 2026-08-07 alongside the new.html fix. This one was NOT vulnerable: it
   already escaped `"`, and every attribute it feeds happens to be double-quoted. That is a fact
   about today's templates, not a property of the function — the first single-quoted attribute
   anyone writes turns it into the same hole new.html actually had. The `(v||"")` head is kept
   deliberately rather than unified with new.html's String(): it maps 0 and false to "", and
   callers here rely on that. test/esc-test.mjs pins the escaping, not the null-handling. */
const esc=v=>(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function spotifyEmbed(url){
  const m=(url||"").match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/);
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
}
/* ── PHOTO-FIRST (§2bc) ───────────────────────────────────────────────────────────────────
   The field finding, 2026-08-12, from the road: "too much friction to make changes to the plan."
   Adding a photo cost FIVE interactions and the first two were navigation, because the app made
   you find the STOP before it would take a picture. This inverts it — the photo arrives first and
   the photo says where it belongs.

   THE LOCATION RIDES IN THE FILE. A camera writes GPS into the JPEG's own EXIF, so we need no
   browser geolocation permission and learn nothing about anybody who does not use this. That also
   sidesteps §2z-b entirely, which is an OPEN decision about geolocating without asking.

   READ IT BEFORE THE UPLOAD, NOT AFTER: `shrinkImage()` re-encodes through a canvas and canvas
   output carries NO EXIF, so by the time the bytes reach `uploadPhoto` the coordinates are gone.
   This is the one ordering that matters in the whole feature. */
function exifLatLng(file){
  return new Promise(res => {
    const fr = new FileReader();
    fr.onerror = () => res(null);
    fr.onload = () => {
      try{
        const v = new DataView(fr.result);
        if(v.byteLength < 16 || v.getUint16(0) !== 0xFFD8) return res(null);   // not a JPEG
        let off = 2, app1 = -1;
        while(off + 4 < v.byteLength){
          const marker = v.getUint16(off);
          if((marker & 0xFF00) !== 0xFF00) break;
          const len = v.getUint16(off + 2);
          if(marker === 0xFFE1){ app1 = off + 4; break; }
          off += 2 + len;
        }
        if(app1 < 0) return res(null);
        // "Exif\0\0" then a TIFF header whose byte order the file declares itself
        if(v.getUint32(app1) !== 0x45786966) return res(null);
        const tiff = app1 + 6;
        const le = v.getUint16(tiff) === 0x4949;
        const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
        if(u16(tiff + 2) !== 0x002A) return res(null);
        const ifd0 = tiff + u32(tiff + 4);
        let gps = 0;
        const n0 = u16(ifd0);
        for(let i = 0; i < n0; i++){
          const e = ifd0 + 2 + i * 12;
          if(u16(e) === 0x8825){ gps = tiff + u32(e + 8); break; }
        }
        if(!gps) return res(null);
        /* A GPS coordinate is three RATIONALs — degrees, minutes, seconds — each a pair of
           32-bit ints, and the hemisphere is a separate ASCII tag. Reading only the degrees
           puts you in the right country and the wrong town. */
        const rat = o => { const d = u32(o), n = u32(o + 4); return n ? d / n : 0; };
        const dms = o => rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600;
        let lat = null, lng = null, ns = "N", ew = "E";
        const ng = u16(gps);
        for(let i = 0; i < ng; i++){
          const e = gps + 2 + i * 12, tag = u16(e), val = tiff + u32(e + 8);
          if(tag === 0x0001) ns = String.fromCharCode(v.getUint8(e + 8));
          if(tag === 0x0002) lat = dms(val);
          if(tag === 0x0003) ew = String.fromCharCode(v.getUint8(e + 8));
          if(tag === 0x0004) lng = dms(val);
        }
        if(lat == null || lng == null) return res(null);
        if(ns === "S") lat = -lat;
        if(ew === "W") lng = -lng;
        if(!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return res(null);
        res({lat, lng});
      }catch(e){ res(null); }
    };
    /* 256 KB is past every EXIF block I have measured and far short of reading the picture. */
    fr.readAsArrayBuffer(file.slice(0, 262144));
  });
}

/* cos(latitude) or the longitude term is wrong by a third at this latitude — the same correction
   the path simplifier needs, and the same one an earlier audit got wrong (CLAUDE.md). */
function milesBetween(a, b){
  const dLat = (a.lat - b.lat) * 69.0;
  const dLng = (a.lng - b.lng) * 69.0 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/* ONE opener for the camera, so the map button and anything else that ever wants it cannot
   drift apart. `value=""` first, or picking the SAME file twice in a row fires no change event
   and the second photo silently never arrives. */
function tapPhoto(){
  const i = document.getElementById("photoFirst");
  if(i){ i.value = ""; i.click(); }
}
async function photoFirst(file){
  if(!file) return;
  const say = m => { const b = document.getElementById("fab"); if(b) b.title = m; console.log("[photo] " + m); };
  let where = await exifLatLng(file);
  let how;
  if(where){
    how = "from the photo";
  }else{
    /* NO EXIF is normal, not an error — screenshots have none, and iOS strips it when Location
       is off for the camera. Falling back to the middle of the map is honest and correctable;
       refusing the photo is not. */
    const c = map.getCenter();
    where = {lat: c.lat, lng: c.lng};
    how = "at the middle of your map — the photo carried no location";
  }
  /* NEAREST STOP, so the caption can name a place rather than a coordinate. Half a mile is close
     enough to be "at" somewhere on a road trip and far enough not to swallow the next town. */
  let near = null, best = Infinity;
  try{
    for(const st of (allStops || [])){
      if(typeof st.lat !== "number" || typeof st.lng !== "number") continue;
      const d = milesBetween(where, st);
      if(d < best){ best = d; near = st; }
    }
  }catch(e){}
  const at = (near && best <= 0.5) ? (near.place || near.title || "") : "";
  try{
    const url = await store.uploadPhoto(file);
    await store.addPost({ ts: Date.now(), type: "post", author: CURRENT_NAME || "",
                          lat: where.lat, lng: where.lng, caption: "", photo: url });
    say(at ? ("Photo added at " + at) : ("Photo added " + how));
    try{ map.setView([where.lat, where.lng], Math.max(map.getZoom(), 13)); }catch(e){}
  }catch(e){
    /* NO SIGNAL IS NOT A FAILURE, IT IS A WAIT (§2bm). Distinguish it from a real refusal: an
       expired phrase or a rejected file must still say so loudly, because retrying those forever
       is its own kind of lie. `auth` is named explicitly since showGate() has already fired. */
    const msg = String((e && e.message) || "");
    const netFail = (!navigator.onLine || /fetch|network|load failed|failed to fetch/i.test(msg)) && msg !== "auth";
    if(netFail){
      const r = await pqPush({ slug, blob: file, name: file.name || "photo.jpg",
                               type: file.type || "", lat: where.lat, lng: where.lng,
                               author: CURRENT_NAME || "", ts: Date.now() });
      if(r === "queued"){
        const n = await pqCount().catch(() => 1);
        say(n === 1 ? "No signal — the photo is saved on this phone and will send itself."
                    : ("No signal — " + n + " photos saved on this phone, waiting to send."));
        paintOutbox();
        return;
      }
      if(r === "full"){
        say("No signal, and this phone has no room left to hold the photo.");
        alert("No signal, and there is no storage left on this phone to hold the photo until there is."
            + (OFFLINE_ARCHIVE ? "\n\nThe saved offline map is using some of that room. Removing it from the take-it sheet would free it." : ""));
        return;
      }
    }
    /* §2ad: a write that fails now says so. The person is on a road with one bar. */
    say("Photo did not upload — " + (msg || "try again"));
    alert("That photo did not upload: " + (msg || "unknown error"));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const i = document.getElementById("photoFirst");
  if(i) i.addEventListener("change", e => { const f = e.target.files && e.target.files[0]; if(f) photoFirst(f); });
});

async function shrinkImage(file,max=1600){
  const img=await createImageBitmap(file);
  const k=Math.min(1,max/Math.max(img.width,img.height));
  const c=document.createElement("canvas");
  c.width=Math.round(img.width*k); c.height=Math.round(img.height*k);
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);
  return new Promise(res=>c.toBlob(res,"image/jpeg",.82));
}

/* ═════════ REST store (drop-in for the old Firebase store) ═════════ */
let ACCESS="view", MEDIA=false, CAN_PHOTO=false, CAN_VIDEO=false, TIER="plan", EXPIRES=null;
let QA=false;   // D-114: in-house QA trip
/* Which ids are currently standing behind a cluster badge. Module-level because the LIST
   needs it: tapping a card zooms to 8, which is a zoom where clustering is on, so without
   this you ask for a stop and get a badge. Rebuilt on every drawMap. */
const CLUSTERED=new Set();
/* SPIDER lives beside CLUSTERED because it is the same kind of state — which ids the map is
   currently treating specially — and because `let` is NOT hoisted: declared below its first
   reader, one early `drawMap()` would throw a ReferenceError and take the whole inline script
   with it, which is how this page has shipped blank before (CLAUDE.md). */
let SPIDER=null;
let ME=null, MEMBERS=[], MEMBER_ROSTER=[];  // D-023: your handle (if a personal link) + roster (handles; +ids for revoke)
let CONFIG={name:"", labels:{...TRACK_LABELS}};
let READONLY=true;
/* PREVIEW AS A GUEST (Peter, 2026-08-12). An editor can see exactly what the people they sent the
   view link to are seeing, without opening a second link or a private window.
   IT CAN ONLY EVER TAKE CAPABILITY AWAY. `READONLY` is `ACCESS!=="edit" || PREVIEW_VIEW`, so a
   view-phrase holder is readonly no matter what this flag says, and flipping it can only make the
   page MORE restrictive. That asymmetry is the whole safety argument — and the server gates every
   write on the phrase regardless, so this is honesty about the UI, never a permission.
   IN MEMORY ONLY, deliberately: a reload returns you to editing, so there is no way to get stuck
   in a preview you cannot find your way out of. */
let PREVIEW_VIEW=false;
const cbs={stops:null,notes:null,posts:null,config:null};
let SINCE=0;
const pinsById=new Map(), notesById=new Map();

async function api(path, opts={}){
  const method = (opts.method||"GET").toUpperCase();
  let r;
  try{
    r = await fetch(API_BASE+"/api/"+path, {...opts, cache:"no-store",   // D-021 path-based
      headers:{"content-type":"application/json", authorization:"Bearer "+KEY, ...(opts.headers||{})}});
  }catch(netErr){
    /* THE NETWORK IS THE ONLY THING WE QUEUE FOR. `fetch` rejects on a dead connection and on
       nothing else — an HTTP error resolves with `ok:false` and is handled below — so this
       branch is exactly "no signal", which is the case an outbox exists for. A GET is never
       queued: replaying a read achieves nothing, and `restoreTrip()` already answers it. */
    if(method !== "GET" && outboxSafe(path) && outboxAdd(path, method, opts.body)){
      const e = new Error("queued"); e.queued = true; throw e;
    }
    throw netErr;
  }
  if(r.status===401){ showGate(); throw new Error("auth"); }
  // 410 is the one-year "plan it" life ending. Say that plainly instead of leaving someone
  // to read "not it" and go hunting for a phrase that will never work again, and drop the
  // saved key — it unlocks nothing now, and keeping it only produces the error again.
  if(r.status===410){ let m; try{ m=(await r.json()).error; }catch(e){}
    showExpired(m||"this trip reached its one-year end and was deleted");
    throw new Error("expired"); }
  if(!r.ok){ let m; try{ m=(await r.json()).error; }catch(e){} throw new Error(m||String(r.status)); }
  return r.json();
}

/* ═════════ §2ad(c): THE OUTBOX — a write with no signal waits instead of dying ═════════
   Before this, an edit made in a canyon was destroyed silently: the write threw, the field went
   on showing what had been typed so it looked saved, and the next successful poll replaced it
   with the server's old value. Reproduced end to end 2026-08-07.

   THE RULE, and it is a decision rather than a discovery: LAST WRITE WINS, replayed in the order
   it was queued. The server carries no version or etag on a pin, so there is nothing to detect a
   conflict WITH — adding one is a schema change nobody has decided on. A trip is a small trusted
   crew editing a shared document, not a wiki, so the person who typed most recently is almost
   always the person who is right. Signed off as D-155, which also states the cost plainly: an
   edit made in a canyon silently replaces one made from the motel, and per-field merging would
   narrow that without solving it.

   WHAT IS NOT QUEUED, deliberately: reads (replaying one achieves nothing) and photo uploads,
   which go through their own `fetch` at trip/media because a File cannot be put in
   localStorage — a queued photo would be a promise we could not keep, which is the exact bug
   this replaces.

   BOUNDED ON PURPOSE. localStorage is small and shared with the trip cache, so the queue is
   capped by count and by age; the oldest go first. A queue that grew without limit would one
   day throw on setItem and take the trip cache down with it. */
/* A WHITELIST, NOT A BLACKLIST, and the direction matters: an endpoint added later is NOT
   queued until somebody decides it is safe to replay, which is the failure that can be noticed
   rather than the one that cannot. Four are excluded on purpose and each would do real harm:

     · `trip/rotate` — the RESPONSE IS THE NEW PASSWORD. It is generated once, server-side, and
       returned once. Replay it and the phrase is set on the server and shown to nobody: the
       owner is locked out of their own trip by a queue that thought it was helping.
     · `trip/members` (POST) — same shape, returns the person's phrase once. A replayed one
       leaves a member row whose phrase exists nowhere recoverable. There is already exactly one
       of those on a live trip and it is in TODO_PETE; this would manufacture more.
     · `trip` (DELETE) — destroying a trip long after the person watched it fail is not a retry,
       it is a surprise.
     · `trip/pins/{id}/open` — a sealed drop is opened by BEING THERE (D-047). Replayed from the
       next town it opens something nobody stood next to, which is the whole feature undone.

   Everything below is a plain edit to trip content: safe to replay, and last-write-wins is the
   rule for it (D-155). The `/open` suffix is what keeps a sealed drop out of the pins line. */
const OUTBOX_SAFE = [
  /^trip\/pins$/,                        // add a stop or a post
  /^trip\/pins\/[A-Za-z0-9_-]+$/,        // edit or remove one — NOT .../open
  /^trip\/notes$/,
  /^trip\/notes\/[A-Za-z0-9_-]+$/,
  /^trip\/config$/
];
const outboxSafe = path => {
  const clean = String(path||"").split("?")[0].replace(/^\/+/, "");
  return OUTBOX_SAFE.some(re => re.test(clean));
};
const outboxKey   = () => "ttb_outbox_" + slug;
const OUTBOX_MAX  = 200;
const OUTBOX_TTL  = 7 * 24 * 60 * 60 * 1000;      // a week — older than that is not a pending edit
function outboxRead(){
  try{
    const v = JSON.parse(localStorage.getItem(outboxKey()) || "[]");
    return Array.isArray(v) ? v.filter(e => e && e.path && e.method) : [];
  }catch(e){ return []; }
}
function outboxWrite(q){
  try{ localStorage.setItem(outboxKey(), JSON.stringify(q.slice(-OUTBOX_MAX))); }
  catch(e){ return false; }                        // quota: better to lose the queue than the trip
  paintOutbox();
  return true;
}
function outboxAdd(path, method, body){
  const q = outboxRead();
  q.push({ t: Date.now(), path, method, body: (typeof body === "string" ? body : null) });
  return outboxWrite(q);
}
function outboxCount(){ return outboxRead().length; }

let flushing = false;
/* Serial, and it STOPS at the first network failure rather than skipping past it — order is the
   only conflict rule there is, so a later write must never overtake an earlier one. */
async function flushOutbox(){
  if(flushing || !KEY) return 0;
  let sent = 0, dropped = 0;
  flushing = true;
  try{
    for(;;){
      const q = outboxRead();
      if(!q.length) break;
      const e = q[0];
      if(Date.now() - (e.t||0) > OUTBOX_TTL){ outboxWrite(q.slice(1)); dropped++; continue; }
      let r;
      try{
        r = await fetch(API_BASE + "/api/" + e.path, { method: e.method, body: e.body,
          cache: "no-store",
          headers: {"content-type":"application/json", authorization: "Bearer " + KEY} });
      }catch(net){ break; }                        // still no signal — keep everything, try later
      if(r.status === 401 || r.status === 410) break;          // gate/expiry: the queue is not the problem
      if(r.ok){ outboxWrite(q.slice(1)); sent++; continue; }
      if(r.status >= 400 && r.status < 500){       // the server refused it and always will
        outboxWrite(q.slice(1)); dropped++; continue;
      }
      break;                                       // 5xx — server trouble, not ours; retry later
    }
  } finally { flushing = false; }
  if(sent)    try{ say(sent + (sent===1 ? " change sent." : " changes sent."), 4000); }catch(_){}
  if(dropped) try{ say(dropped + (dropped===1 ? " change could not be sent" : " changes could not be sent")
                    + " — the trip may have moved on without it.", 6000); }catch(_){}
  return sent;
}
/* ── §2bm: PHOTOS WAIT FOR SIGNAL TOO ──────────────────────────────────────────────────────
   The outbox above deliberately did NOT queue photo uploads, and said why: "a File cannot be put
   in localStorage." That was true and it stopped being the whole story the day the offline map
   archive shipped, because that stores a 52 MB Blob in IndexedDB. The machinery was already in
   this file, built for the basemap, and nothing connected the two.

   WHY IT MATTERS MORE THAN IT LOOKS. §2bd made photo-first the best thing this product does on a
   road: take the picture, let the EXIF say where it belongs. The offline comment above names
   Yellowstone, Monument Valley and Death Valley as the reason offline exists — which are exactly
   the places with no bars, and exactly the places somebody takes a photograph. Until now that
   returned "Try again when you have bars" and the moment was gone.

   A SEPARATE DATABASE, NOT A SECOND STORE IN `ttb_maps`. Adding a store means bumping that
   database's version, and the thing on the other side of that upgrade is a 52 MB archive somebody
   deliberately downloaded before leaving. Photos are not worth putting it at risk.

   THE ORIGINAL FILE GOES IN, and it costs nothing to get right here: `shrinkImage()` runs INSIDE
   `uploadPhoto`, so what arrives at this point is still the camera's own bytes with their EXIF
   intact. We keep the resolved coordinates alongside anyway — the parse already happened, and
   re-deriving at drain time would be a second implementation of the same thing. */
const PQDB = "ttb_photoq", PQSTORE = "pending";
function pqDb(){
  return new Promise((res, rej) => {
    let r; try{ r = indexedDB.open(PQDB, 1); }catch(e){ return rej(e); }
    r.onupgradeneeded = () => { try{ r.result.createObjectStore(PQSTORE, {keyPath:"id", autoIncrement:true}); }catch(e){} };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
function pqTx(mode, fn){
  return pqDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(PQSTORE, mode), st = tx.objectStore(PQSTORE);
    let req; try{ req = fn(st); }catch(e){ return rej(e); }
    if(req && typeof req === "object" && "onsuccess" in req){
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    }else tx.oncomplete = () => res(undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
/* Scoped to THIS trip. One phone can hold several, and a queue that drained another trip's photos
   into the one you happen to have open is the kind of bug you cannot apologise your way out of. */
async function pqMine(){
  try{ const all = await pqTx("readonly", st => st.getAll()); return (all||[]).filter(r => r && r.slug === slug); }
  catch(e){ return []; }
}
async function pqCount(){ return (await pqMine()).length; }

/* Returns "queued" | "full" | "no". A failure to enqueue is reported, never swallowed: the whole
   point is that the person knows where their photograph is. */
async function pqPush(rec){
  try{ await pqTx("readwrite", st => st.add(rec)); return "queued"; }
  catch(e){
    /* THE QUOTA IS A REAL CEILING AND IT IS SHARED WITH THE MAP ARCHIVE, which may already be
       holding tens of megabytes that somebody chose on purpose. Say so rather than discovering it
       on a highway — and do not evict the archive to make room, because they asked for that and
       they did not ask for this. */
    return (e && /quota/i.test(e.name + " " + e.message)) ? "full" : "no";
  }
}

/* Drains in insertion order and STOPS at the first failure, so nothing jumps the queue and
   nothing is deleted until the server has it. */
async function flushPhotoQueue(){
  if(!navigator.onLine || READONLY) return 0;
  let sent = 0;
  for(const rec of await pqMine()){
    try{
      const f = new File([rec.blob], rec.name || "photo.jpg", {type: rec.type || "image/jpeg"});
      const url = await store.uploadPhoto(f);
      await store.addPost({ ts: rec.ts || Date.now(), type: "post", author: rec.author || "",
                            lat: rec.lat, lng: rec.lng, caption: "", photo: url });
      await pqTx("readwrite", st => st.delete(rec.id));
      sent++;
    }catch(e){ break; }
  }
  return sent;
}

/* The banner is the only place with room to say how many are waiting, and a number is the thing
   that turns "did that save?" into a fact. */
async function paintOutbox(){
  const o = document.getElementById("offline"); if(!o) return;
  const n = outboxCount();
  const ph = await pqCount().catch(() => 0);
  if(!n && !ph) return;
  const bits = [];
  if(n)  bits.push(n  + (n ===1 ? " change"  : " changes"));
  if(ph) bits.push(ph + (ph===1 ? " photo"   : " photos"));
  o.innerHTML = icon("alert",14) + " No signal — " + bits.join(" and ") + " waiting to send.";
  o.classList.add("show");
}
/* The moment the browser says the network is back, do not wait out the ten-second poll. */
/* AND ON LOAD, because `online` only fires on a TRANSITION. Somebody who queued photos in a
   canyon, closed the tab and opened it again in town never crosses that edge — the browser was
   already online when the page started. Without this the queue would sit there looking correct
   and never send. */
addEventListener("load", () => { setTimeout(() => {
  flushPhotoQueue().then(n => { if(n){ say(n===1 ? "1 photo sent." : (n + " photos sent."));
    sync().catch(()=>{}); paintOutbox(); } });
}, 3000); });

addEventListener("online", () => {
  flushOutbox().then(n => { if(n) sync().catch(()=>{}); });
  flushPhotoQueue().then(n => { if(n){ say(n===1 ? "1 photo sent." : (n + " photos sent."));
    sync().catch(()=>{}); paintOutbox(); } });
});

/* field-mapping adapters (PLAN §2.5): UI objects ⇄ API pins/notes */
const fromStopPin = p => ({id:p.id, track:p.track, date:p.date||"", place:p.title,
  lat:p.lat, lng:p.lng, lodging:p.lodging, notes:p.notes, here:!!p.here, fly:!!p.fly,
  mode:p.mode||(p.fly?"fly":"drive"), craft:p.craft||"", seq:p.seq||0, author:p.author||"", path:Array.isArray(p.path)?p.path:null});
const fromPostPin = p => ({id:p.id, ts:p.ts, type:p.kind, author:p.author, lat:p.lat, lng:p.lng,
  caption:p.title, photo:p.photo, spotify:p.spotify,
  openedBy:(()=>{try{return JSON.parse(p.opened_by||"[]");}catch(e){return [];}})(),
  nearOnly:!!p.near_only, radiusMi:(p.radius_mi ?? null), claimedTeam:p.claimed_team, claimedBy:p.claimed_by});
const fromNote = n => ({id:n.id, title:n.title, body:n.body, order:n.ord});
const STOP_KEYS={place:"title"};  // remaining UI stop keys map 1:1
function stopPatch(patch){ const o={}; for(const k in patch) o[STOP_KEYS[k]||k]=patch[k]; return o; }
const POST_KEYS={caption:"title", openedBy:"opened_by", nearOnly:"near_only", radiusMi:"radius_mi", claimedTeam:"claimed_team", claimedBy:"claimed_by"};
function postPatch(patch){ const o={}; for(const k in patch){ if(k==="claimTs") continue; o[POST_KEYS[k]||k]=patch[k]; } return o; }

function livePins(){ return [...pinsById.values()].filter(p=>!p.deleted); }
function liveNotes(){ return [...notesById.values()].filter(n=>!n.deleted); }

/* ── the offline copy ────────────────────────────────────────────────────────────────────
   This product is used on remote highways and in national parks — Yellowstone, Monument
   Valley, Death Valley — and until now the trip came off the network every single time. No
   bars meant no itinerary, no lodging, no notes, and no easter eggs, at exactly the stop you
   were standing at. GPS needs no signal, so a geofence would fire correctly into a page that
   could not load.

   Originally localStorage and NOT a service worker: the worker is the better product, and it is
   one of the few ways to brick a web app permanently for returning visitors, which was not a
   thing to ship days before a real trip. THE TRIP IS OVER AND THE WORKER SHIPPED 2026-08-26 —
   see `public/sw.js` and `registerWorker()` below. It caches the SHELL ONLY and never the API,
   because this cache already exists and a second one would make the sealing judgement twice.
   This half is still reversible by clearing one key; the worker's own escape hatch is `?nosw=1`.

   Privacy: we cache only what the SERVER chose to send. `seal_pin()` has already blanked any
   drop this person has not opened, so an unopened surprise cannot be read out of the cache —
   the words were never on the device. Someone whose access is later revoked keeps whatever
   they had already been shown, which is true of any page they had already loaded. */
/* ── the shell, so all of the above is reachable with no signal (2026-08-26) ──────────────
   Everything below this line — the trip cache, the map archive in IndexedDB, the outbox — was
   already built and already working, and none of it could be reached, because the PAGE came off
   the network every time. Four offline features behind a door that needed a connection to open.

   `/sw`, not `/sw.js`: Cloudflare keys caching on the extension and would hold `.js` at the edge
   for ~4 hours — on the one file whose job is to repair a bad worker. index.php serves it
   extensionless with a JS content type. D-166's lesson, run backwards.

   THE ESCAPE HATCH IS CHECKED FIRST AND UNCONDITIONALLY. `?nosw=1` on any URL tears the worker
   down and empties every cache, and it runs before registration is even considered, so a bug in
   the registration path cannot stand in front of the way out. */
async function registerWorker(){
  if(!("serviceWorker" in navigator)) return;
  if(new URLSearchParams(location.search).has("nosw")){
    try{
      const rs = await navigator.serviceWorker.getRegistrations();
      for(const r of rs){ if(r.active) r.active.postMessage({type:"KILL"}); await r.unregister(); }
      if(window.caches){
        const keys = await caches.keys();
        for(const k of keys) await caches.delete(k);
        window.__ttbKilled = {regs: rs.length, caches: keys};
      }
      console.log("[ttb] service worker removed");
    }catch(e){}
    return;
  }
  /* Registered AFTER load on purpose: install fetches the whole shell list, and racing that
     against the page's own first paint makes a cold visit slower to be faster later. */
  try{ await navigator.serviceWorker.register("/sw", {scope:"/"}); }catch(e){}

  /* AND THEN HAND IT THIS PAGE, WHICH IS NOT OPTIONAL AND IS NOT OBVIOUS.
     A navigation only passes through a worker that was ALREADY controlling the page, and the
     visit that installs one never is — so on a first visit the shell is never cached, while the
     page still LOOKS like it works offline because Chrome's HTTP cache answers instead. Measured
     exactly that on 2026-08-26: 17 pins restored with the network off and `__ttb_shell` empty.
     A real failure wearing a pass. So tell the worker what to store, rather than hoping a second
     navigation happens before the person needs it. */
  try{
    const reg = await navigator.serviceWorker.ready;
    /* `registration.active`, NOT `navigator.serviceWorker.controller`. `ready` resolves as soon
       as there is an ACTIVE worker, but this client is only "controlled" once claim() has
       propagated to it — so on the visit that installs the worker, `controller` is still null at
       this moment and the message went nowhere. Measured: the shell stayed uncached through two
       deploys while every other cache entry landed. `active` is set the instant the worker is. */
    const sw = reg.active || navigator.serviceWorker.controller;
    if(sw) sw.postMessage({type:"CACHE_SHELL", url: location.pathname});
  }catch(e){}
}
/* Read the worker's own account of what it decided. Exposed on window so a harness (and a
   `?swdiag=1` session on a handset) can ask, the same way `?pmdiag=1` exists for the basemap. */
/* Point the manifest at THIS trip. Doing it here rather than in the markup is what makes the
   installed icon open the trip you installed it from — app.html is byte-identical for every slug
   (index.php:311 streams it unchanged), so the href cannot be baked in. */
try{
  const ml = document.getElementById("wmanifest");
  if(ml && slug) ml.href = "/" + slug + "/manifest.json";
}catch(e){}

window.swStats = () => new Promise(res => {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if(!sw) return res({error:"not controlled"});
  const ch = new MessageChannel();
  ch.port1.onmessage = e => res(e.data);
  sw.postMessage({type:"STATS"}, [ch.port2]);
  setTimeout(()=>res({error:"timeout"}), 2000);
});

if(document.readyState === "complete") registerWorker();
else addEventListener("load", registerWorker, {once:true});

const TRIP_CACHE_V = 2;
const tripCacheKey = () => "ttb_trip_" + slug;
function cacheTrip(){
  try{
    localStorage.setItem(tripCacheKey(), JSON.stringify({
      v:TRIP_CACHE_V, at:Date.now(), access:ACCESS, media:MEDIA, tier:TIER, expires:EXPIRES,
      qa:QA, photo:CAN_PHOTO, video:CAN_VIDEO, me:ME, members:MEMBERS, roster:MEMBER_ROSTER,
      config:CONFIG, pins:[...pinsById.values()], notes:[...notesById.values()]
    }));
  }catch(e){}   /* quota or private mode — caching must never break a page that works */
}
function clearTripCache(){ try{ localStorage.removeItem(tripCacheKey()); }catch(e){} }
/* Replays a payload — live or cached — through exactly one path, so the two cannot drift. */
function applyState(s){
  /* The trip's own basemap, if one has been cut. Swapping PM_URL is not enough on its own —
     the layer is already built by now, so applyTheme() rebuilds it against the new archive. */
  if(s.tiles && s.tiles !== PM_URL){
    /* THE TRIP ARCHIVE NO LONGER REPLACES THE WORLD ONE — IT SITS ON TOP OF IT. Replacing was
       the prototype's shape and it had a hole you could see: a per-trip archive is cut to the
       clusters the route touches, so panning off the route drew NOTHING. Measured on the live
       demo at z8 over Tokyo: 1 distinct colour, a flat sheet. Now the world archive stays as the
       base and the trip's own detail is painted over it, so off-route is coarse rather than
       blank. See buildPmLayers() for why the top layer can be transparent at all.
       13 is what scripts/trip-tiles.php cuts (--maxzoom, default 13). Getting it wrong is silent
       both ways: too high and it asks for tiles that do not exist, too low and it overzooms
       detail it already has. */
    PM_TRIP = s.tiles;
    /* If this phone already has the archive, adopt it BEFORE the layers rebuild, so the very
       first range request is answered from disk rather than going out and failing in a canyon. */
    archiveGet(PM_TRIP).then(blob => {
      if(blob) OFFLINE_ARCHIVE = { url: PM_TRIP, blob };
    }).catch(()=>{}).then(() => { try{ applyTheme(); }catch(e){} });
  }
  ACCESS=s.access; MEDIA=s.media; TIER=s.tier; EXPIRES=s.expires;
  QA = !!s.qa; document.body.classList.toggle("qa", QA);
  CAN_PHOTO = s.photo !== undefined ? s.photo : s.media;
  CAN_VIDEO = s.video !== undefined ? s.video : s.media;
  ME=s.me||null; MEMBERS=Array.isArray(s.members)?s.members:[]; MEMBER_ROSTER=Array.isArray(s.roster)?s.roster:[];
  if(ME && CURRENT_NAME!==ME){ CURRENT_NAME=ME; localStorage.setItem("ttb_name",CURRENT_NAME); } // a personal link identifies you — no name screen
  CONFIG={name:s.config.name, labels:s.config.labels||{}};
  TRACK_LABELS={...TRACK_LABELS, ...CONFIG.labels};
  for(const p of s.pins) pinsById.set(p.id,p);
  for(const n of s.notes) notesById.set(n.id,n);
  hideGate();
  emitAll();
}
/** Render the last saved copy. Returns false if there isn't one worth showing. */
function restoreTrip(){
  let c=null;
  try{ c=JSON.parse(localStorage.getItem(tripCacheKey())||"null"); }catch(e){}
  if(!c || c.v!==TRIP_CACHE_V || !Array.isArray(c.pins) || !c.config) return false;
  applyState(c);
  return true;
}

async function sync(){
  /* No &who= any more (D-047). The server used to take the viewer's name from this query
     string, which meant typing someone else's name read their drops. Identity now comes
     from the token itself, so there is nothing useful to send. */
  const s=await api("trip/state?since="+SINCE);
  SINCE=s.serverTime;
  /* D-088: photo and video are separate allowances now. `s.media` is still sent for a
     client loaded before the split; fall back to it so a stale tab keeps working. */
  applyState(s);
  /* Cache AFTER a good sync only, and cache the ACCUMULATED state rather than this delta —
     `since=` means s.pins holds only what changed, so caching the response itself would save
     a trip that shrinks to nothing on the second poll. */
  cacheTrip();
}
/* D-113: the keep-this-trip bar, for VIEW-phrase holders only.
 *
 * `ACCESS==="view"` is the whole audience test and it is exact: access_level() returns "edit"
 * for an edit phrase, for a member phrase AND for an account session, so a single check
 * excludes the buyer, the crew and anyone already signed in. Nobody who has an account is ever
 * asked to make one.
 *
 * WHETHER THEY HAVE SEEN IT BEFORE IS ANSWERED ON THEIR OWN DEVICE, NEVER BY US. Asking the
 * server "has this person met a trip before" is cross-trip linkage — the precise thing the
 * product promises not to build, and the bar's own copy claims we don't. localStorage is their
 * browser remembering their own dismissal; it leaves no record here and links nothing to
 * anyone. Per-slug, so dismissing one trip's bar does not silently answer for the next.
 *
 * It also waits for the trip to have actually loaded. A bar that appears over a gate, or over
 * an empty map, is asking someone to keep a thing they have not seen yet. */
/* MOVE 6 OF SIX — ?join=1. The scoreboard's last untaught move is "(recipient) open and add",
   and the reason it sat at HALF is exact: `maybeKeepBar` returns early unless `ACCESS==="view"`,
   so the account strip is a VIEWER's screen — and a viewer cannot add anything, so it was never
   move 6 at all. **The editor recipient gets nothing.** They open a link somebody sent them,
   land in a trip with fifteen stops already in it, and not one word says the trip is theirs to
   add to. The empty-state line that DOES say it ("Start the map — add your first stop") only
   renders on an EMPTY trip, which is precisely the trip a recipient never receives.
   One line, once per trip per device, in the sheet the editor already arrives with open. It
   names the two things they can do and where, and retires itself the first time they do either —
   the same shape as the leg hint and the crew hint on /new, and the same Mario rule: 1-1 does not
   keep the first sign up for the rest of the level. */
function joinHintKey(){ return "ttb_joinhint_" + slug; }
function retireJoinHint(){
  const el = document.getElementById("joinHint");
  if(el) el.remove();
  try{ localStorage.setItem(joinHintKey(), "1"); }catch(e){}
}
function maybeJoinHint(){
  if(!document.body.classList.contains("join")) return;
  if(ACCESS === "view") return;                       // a viewer has nothing to add
  if(document.getElementById("joinHint")) return;
  try{ if(localStorage.getItem(joinHintKey()) === "1") return; }catch(e){}
  const head = document.getElementById("docHead"); if(!head) return;
  const b = document.createElement("button");
  b.type = "button"; b.id = "joinHint"; b.className = "joinhint";
  b.textContent = MEDIA
    ? "this trip is yours to add to — tap the map for a stop, or the \u22ef button for a photo"
    : "this trip is yours to add to — tap the map to drop a stop";
  b.setAttribute("aria-label", b.textContent);
  b.onclick = retireJoinHint;
  head.insertAdjacentElement("afterend", b);
}
let keepBarDone=false;
function maybeKeepBar(){
  if(keepBarDone) return;
  const el=document.getElementById("keepBar"); if(!el) return;
  if(ACCESS!=="view") return;
  let seen=false;
  try{ seen = localStorage.getItem("ttb_keep_"+slug)==="1"; }catch(e){}
  if(seen) return;
  keepBarDone=true;
  /* Into the sheet, under the trip's own name — unless ?topbanner=1 asks for the old strip. */
  const top = document.body.classList.contains("topbanner");
  if(!top){
    const head = document.getElementById("docHead");
    if(head) head.insertAdjacentElement("afterend", el);
  }
  el.hidden=false;
  /* Only the FIXED strip covers the masthead, so only the fixed strip needs #topbar moved. */
  if(top) document.body.classList.add("has-keepbar");
  document.getElementById("keepX").addEventListener("click",()=>{
    el.hidden=true;
    document.body.classList.remove("has-keepbar");
    try{ localStorage.setItem("ttb_keep_"+slug,"1"); }catch(e){}
  });
}
/* THE SAME PILL MUST NOT SAY THE SAME THING TO TWO DIFFERENT PEOPLE. A real viewer's "View only"
   is a statement about what they hold. An editor who has tapped into preview needs to know they
   are still the editor and how to come back — telling them "View only" would read as having lost
   the edit link, which is the one alarming thing this feature could do. */
function syncModeTag(){
  const v = document.getElementById("viewTag"), e = document.getElementById("editTag");
  if(!v || !e) return;
  const canPreview = ACCESS === "edit";
  const lbl = v.querySelector(".lbl");
  if(canPreview){
    if(lbl) lbl.textContent = "Viewing as guest";
    v.title = "This is what the view link shows. Tap to go back to editing.";
    e.title = "You have the edit link — changes are live for everyone. Tap to preview as a guest.";
    v.setAttribute("role","button"); e.setAttribute("role","button");
    v.tabIndex = 0; e.tabIndex = 0;
    v.setAttribute("aria-pressed", PREVIEW_VIEW ? "true" : "false");
  }else{
    if(lbl) lbl.textContent = "View only";
    v.title = "view-only link";
    v.removeAttribute("role"); v.removeAttribute("aria-pressed"); v.removeAttribute("tabindex");
  }
}
function toggleModePreview(){
  if(ACCESS !== "edit") return;           // the guard, restated where it is acted on
  PREVIEW_VIEW = !PREVIEW_VIEW;
  /* DELIBERATELY NOT `emitAll()`. That function is the "a sync arrived" pipeline — it re-renders
     the config, the doc head, the stops, the posts and the notes, and it reads state that only a
     completed sync guarantees. A mode toggle is not a sync. Calling it here threw
     `allStops.forEach of undefined` the first time it was exercised, and even where it survives it
     does five renders to change one class. So the toggle does exactly its own job. */
  READONLY = ACCESS !== "edit" || PREVIEW_VIEW;
  document.body.classList.toggle("readonly", READONLY);
  syncModeTag();
  /* The rail is built FROM `READONLY`, so without this the chrome flips and the fields stay
     editable — which would be the worst version of this feature: a preview that lies. */
  try{ render(); }catch(err){}
}
document.addEventListener("DOMContentLoaded", () => {
  for(const id of ["viewTag","editTag"]){
    const el = document.getElementById(id); if(!el) continue;
    el.addEventListener("click", toggleModePreview);
    el.addEventListener("keydown", ev => {
      if(ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); toggleModePreview(); }
    });
  }
});

let sheetDefaulted=false;
function emitAll(){
  READONLY = ACCESS!=="edit" || PREVIEW_VIEW;
  document.body.classList.toggle("readonly", READONLY);
  /* Only an edit phrase gets the switch. Set here rather than at boot because ACCESS is not known
     until the first sync answers. */
  document.body.classList.toggle("can-preview", ACCESS==="edit");
  syncModeTag();
  /* The resting sheet, decided once access is actually known (Peter, 2026-08-02): a VIEWER is
     looking, so the map is the whole screen and the pill offers the list; an EDITOR is working,
     so the list is already at peek and adding a stop is one tap rather than two.
     ONCE, and only once — emitAll runs on every sync, so re-applying it would slam the sheet
     back open every ten seconds after someone deliberately closed it. */
  /* HALF, NOT PEEK (§2bc, the field finding from the road). The sentence above was already right
     about intent and wrong about height. `peek` rests at `--sheet-rest`, 112px — the grab handle
     and the head — so an editor was told a list existed and shown none of it, and reaching any
     stop meant dragging the sheet up and only then scrolling. Measured at 390x664: resting sheet
     at y552, first card at y729, all 15 below the fold.
     RAISING `peek` DOES NOT FIX IT, which is worth writing down because it is the obvious move:
     there is ~227px of chrome — handle, head, tabs — above the first card, so 248px of sheet
     exposes a 21px sliver and the list still will not scroll. Showing one whole card needs ~430px,
     which is 65% of a short phone. `half` is the state that was already designed for this: it
     exposes 65px of the rail at 390x664 and 144px at 390x844, with the map still on 56% of the
     screen at both.
     AND THE LIST IS A HORIZONTAL RAIL, which is the fact that makes 65px enough — `#list.rail` is
     `overflow-x:auto` at 390/5215, so stops are a sideways SWIPE, not a vertical scroll. You need
     enough card HEIGHT to get a thumb on it, not enough to see the whole card. I measured the
     vertical axis twice before noticing (`overflow-y:hidden`, `355/355`, "nothing scrolls") and
     concluded the list was broken when it was working in the other direction.
     A VIEWER IS UNCHANGED — shut, then the pill. They are looking, not working, and D-…'s reading
     that the map is the screen's job still holds for them. */
  if(!sheetDefaulted){ sheetDefaulted=true;
    if(!READONLY){ setSheet("half"); if(window.syncGrab) syncGrab(); } }
  maybeKeepBar();
  maybeJoinHint();
  cbs.config && cbs.config({name:CONFIG.name, labels:CONFIG.labels});
  cbs.stops  && cbs.stops(livePins().filter(p=>p.kind==="stop").map(fromStopPin));
  cbs.posts  && cbs.posts(livePins().filter(p=>p.kind!=="stop").map(fromPostPin));
  cbs.notes  && cbs.notes(liveNotes().map(fromNote));
}

const store = {
  subscribe(f){ cbs.stops=f; },
  subscribeNotes(f){ cbs.notes=f; },
  subscribePosts(f){ cbs.posts=f; },
  subscribeConfig(f){ cbs.config=f; },
  async add(s){ try{ retireJoinHint(); }catch(e){}   /* they did it — the sign comes down */
    const r=await api("trip/pins",{method:"POST",body:JSON.stringify({
      kind:"stop", track:s.track, date:s.date, lat:s.lat, lng:s.lng, title:s.place,
      lodging:s.lodging, notes:s.notes, here:!!s.here, mode:s.mode||"drive", author:CURRENT_NAME})}); await sync(); return r; },
  async update(id,patch){ await api("trip/pins/"+id,{method:"PATCH",body:JSON.stringify(stopPatch(patch))}); await sync(); },
  async remove(id){ await api("trip/pins/"+id,{method:"DELETE"}); await sync(); },
  async reorder(idA,seqA,idB,seqB){   // swap two stops' seq (manual arrange)
    await api("trip/pins/"+idA,{method:"PATCH",body:JSON.stringify({seq:seqA})});
    await api("trip/pins/"+idB,{method:"PATCH",body:JSON.stringify({seq:seqB})});
    await sync();
  },
  async setHere(id,track){
    const inTrack=livePins().filter(p=>p.kind==="stop" && p.track===track);
    const target=inTrack.find(p=>p.id===id);
    const want=!(target && target.here);
    const calls=[];
    for(const p of inTrack){
      const v=p.id===id ? want : false;
      if(!!p.here !== v) calls.push(api("trip/pins/"+p.id,{method:"PATCH",body:JSON.stringify({here:v})}));
    }
    await Promise.all(calls); await sync();
  },
  async addNote(n){ await api("trip/notes",{method:"POST",body:JSON.stringify({title:n.title,body:n.body,ord:n.order})}); await sync(); },
  async updateNote(id,patch){ await api("trip/notes/"+id,{method:"PATCH",body:JSON.stringify(patch)}); await sync(); },
  async removeNote(id){ await api("trip/notes/"+id,{method:"DELETE"}); await sync(); },
  async addPost(p){ try{ retireJoinHint(); }catch(e){}
    await api("trip/pins",{method:"POST",body:JSON.stringify({
      kind:p.type, ts:p.ts, author:p.author, lat:p.lat, lng:p.lng, title:p.caption,
      photo:p.photo||"", spotify:p.spotify||"", near_only:p.nearOnly?1:0,
      radius_mi:(p.radiusMi ?? null),
      claimed_team:p.claimedTeam||"", claimed_by:p.claimedBy||""})}); await sync(); },
  async updatePost(id,patch){ await api("trip/pins/"+id,{method:"PATCH",body:JSON.stringify(postPatch(patch))}); await sync(); },
  async removePost(id){ await api("trip/pins/"+id,{method:"DELETE"}); await sync(); },
  async setLabel(t,v){ await api("trip/config",{method:"PATCH",body:JSON.stringify({labels:{[t]:v}})}); await sync(); },
  async setName(v){ await api("trip/config",{method:"PATCH",body:JSON.stringify({name:v})}); await sync(); },
  async uploadPhoto(file){
    let blob=file, ext=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"");
    if((file.type||"").startsWith("image/")){ try{ blob=await shrinkImage(file); ext="jpg"; }catch(e){} }
    const r=await fetch(API_BASE+"/api/trip/media?ext="+encodeURIComponent(ext||"jpg"),{
      method:"POST", headers:{authorization:"Bearer "+KEY, "content-type":file.type||"application/octet-stream"}, body:blob});
    if(r.status===401){ showGate(); throw new Error("auth"); }
    if(!r.ok){ let m; try{ m=(await r.json()).error; }catch(e){} throw new Error(m||"upload failed"); }
    return (await r.json()).url;
  }
};

/* ── §2ad: A WRITE THAT FAILS NOW SAYS SO ────────────────────────────────────────────────
   Measured 2026-08-07 on a real trip with `fetch` forced to fail: the customer edited a stop
   with no signal, the write threw, the rejection went UNHANDLED — not one call site had a
   `.catch` and there was no global handler — the field went on showing what they had typed, so
   it looked saved, and when signal came back the 10s poll quietly replaced it with the server's
   old value. Nothing was ever said. That is silent data loss on exactly the road this product
   is for.

   This does not make the write survive; only an outbox does that, and what happens when two
   people edited the same stop is a decision nobody has made. What it does is make the failure
   VISIBLE at the moment it happens, so the person knows to write it on their hand.

   Wrapped over the whole `store` rather than added to each method, because there are eighteen
   of them and the nineteenth would have forgotten. Rethrows: two callers use the return value
   (`store.add` at the map tap, `store.uploadPhoto`), and swallowing would hand them undefined.
   The listener below is the backstop for anything that still escapes; `__told` keeps a single
   failure from toasting twice. */
function reportWriteFailure(e){
  if(!e || e.__told) return;
  try{ e.__told = true; }catch(_){}
  const msg = String((e && e.message) || e || "");
  if(msg === "auth") return;                 // the gate is already up — that IS the message
  /* QUEUED IS NOT FAILED. The outbox has it and will replay it, so this is the one path here
     that gets to be reassuring — and it is the sentence the old banner told before it was true. */
  if(e.queued){
    try{ say("No signal — saved on this phone, will send when you're back.", 4500); }catch(_){}
    try{ paintOutbox(); }catch(_){}
    return;
  }
  const offline = !navigator.onLine
    || /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
  try{
    say(offline ? "Not saved — no signal. Try again when you have bars."
                : "Not saved — " + (msg || "something went wrong"), 5000);
  }catch(_){}
  if(offline){ try{ const o=document.getElementById("offline"); if(o) o.classList.add("show"); }catch(_){} }
}
for(const k of Object.keys(store)){
  if(typeof store[k] !== "function" || k.indexOf("subscribe") === 0) continue;
  const fn = store[k].bind(store);
  store[k] = async function(){
    try{ return await fn.apply(null, arguments); }
    catch(e){ reportWriteFailure(e); throw e; }
  };
}
addEventListener("unhandledrejection", e => reportWriteFailure(e && e.reason));

/* ═════════ info panel — the marketing pages, without leaving the trip ═════════
   Fetch the real page once, lift its <main class="pagebody"> out, cache it. Every info page
   carries that wrapper, which is what makes this cheap: no iframe, no second stylesheet, no
   server-side fragment route to keep in step with the pages themselves.

   The links keep their href, so cmd-click and middle-click still open a real tab, and if this
   script ever dies the menu is still a working set of links. The arrow in the corner is the
   deliberate way out for anyone who wants the standalone page. */
const infoCache = new Map();
let infoReturn = null;                    // where focus goes when the panel closes

function infoStrip(html){
  // Same-origin pages we wrote, but parse in an inert document and drop anything executable
  // anyway — a panel that injects HTML should not be the one place that trusts its input.
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,link,iframe,object,embed").forEach(n=>n.remove());
  const main = doc.querySelector("main.pagebody");
  const h1   = doc.querySelector(".pagehead h1");
  return { title: h1 ? h1.textContent.trim() : "", html: main ? main.innerHTML : "" };
}

/* ── the read view (D-106) ───────────────────────────────────────────────────────────
   Rendered from what the client already has, in the same travel order the map and the rail use
   (`sorted()` — CLAUDE.md is explicit that nothing else decides order). Nothing is fetched: a
   viewer sees exactly what they were already allowed to see, because seal_pin() filtered it
   server-side before it arrived. */
/* Read as arrival, not as a label. MODE_LABEL's nouns ("Drive", "Fly") work beside an arrow in
   the rail; on a page they read as a description of the place. */
const READ_MODE = {drive:"by car", fly:"by air", train:"by rail", ferry:"by ferry",
                   water:"by boat", bike:"by bike", walk:"on foot"};
/* One export action, called from the settings button and from the read view's nudge. It was
   inline on the button, which is why the read view could not offer the one thing a person
   reading their trip in a canyon actually needs. */
async function downloadTrip(btn){
  const was = btn ? btn.textContent : "";
  if(btn){ btn.disabled = true; btn.textContent = "Packing…"; }
  try{
    /* API_BASE has no /api on it — api() appends it. Getting that wrong here made the button
       404 while every other call worked, because nothing else builds a URL by hand. */
    const r = await fetch(`${API_BASE}/api/trip/export`, {headers:{Authorization:`Bearer ${KEY}`}});
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || "could not build it");
    const blob = await r.blob();
    const cd = r.headers.get("content-disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    const u = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = u; a.download = m ? m[1] : "trip.zip"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(u), 4000);
    toast("Downloaded — keep the photos folder next to the html file");
  }catch(e){ toast(e.message || "could not build it"); }
  finally{ if(btn){ btn.disabled = false; btn.textContent = was; } }
}

/* ── printing a paid trip WITH its map (D-122) ───────────────────────────────────────────
   The print stylesheet re-sizes #map to a page-shaped block, and Leaflet has no idea: it
   renders tiles for the container size it last measured, so without this the printed map is a
   band of correct tiles and a lot of empty grey. invalidateSize() tells it, fitBounds() frames
   the trip rather than wherever the reader had panned to, and the promise waits for the new
   tiles to actually arrive — printing before they land is exactly how this ships looking broken.

   Two callers, deliberately: our own Print buttons AWAIT this, which is the reliable path;
   `beforeprint` (Cmd-P, the browser's own menu) gets the same preparation on a best-effort
   basis, because that event cannot be held open while tiles download. */
let printRestore = null;
function preparePrintMap(){
  return new Promise(resolve => {
    if(typeof map === "undefined" || !map || !document.body.classList.contains("reading"))
      return resolve();
    const c = map.getCenter(), z = map.getZoom();
    /* PAPER IS NOT A SCREEN, AND IT IS NEVER IN NIGHT MODE. Someone reading in dark theme was
       getting the dark_all basemap on the page — a solid black sheet that soaks a cartridge and
       reads worse than the free draft's plain list, which is the opposite of what the paid
       version is for. Print always uses the light basemap, whatever the reader's theme, and the
       screen goes back to its own tiles afterwards. Caught by looking at the render; the CSS and
       the tile count were both perfectly happy. */
    const wasDark = typeof darkMode !== "undefined" && darkMode && tileLayer;
    /* A VECTOR LAYER HAS NO setUrl — the colours are baked into its paint rules, not into a URL,
       so the raster trick of swapping the tile template does nothing under ?pm. The theme has to
       be rebuilt instead: flip darkMode, applyTheme() constructs both layers from the light
       palette, and the restore flips it back. Same outcome for both paths, one branch. */
    if(wasDark){
      if(PM_FLAG){ darkMode = false; applyTheme(); }
      else if(tileLayer && tileLayer.setUrl) tileLayer.setUrl(TILE_LIGHT);
    }
    printRestore = () => { try{
      if(wasDark){
        if(PM_FLAG){ darkMode = true; applyTheme(); }
        else if(tileLayer && tileLayer.setUrl) tileLayer.setUrl(TILE_DARK);
      }
      map.invalidateSize(); map.setView(c, z, {animate:false});
    }catch(e){} };
    let done = false;
    const finish = () => { if(done) return; done = true; resolve(); };
    try{
      map.invalidateSize();
      const pts = clusterFit(allStops.filter(s=>!hidden[s.track] && placeableStop(s)).map(s=>[s.lat,s.lng]));
      if(pts.length) map.fitBounds(pts, {padding:[18,18], animate:false});
      /* `load` fires when every visible tile for the current view has arrived. The timeout is
         the honest half: on a slow connection we print what we have rather than hang. */
      if(tileLayer) tileLayer.once("load", finish);
      setTimeout(finish, 1800);
    }catch(e){ finish(); }
  });
}
window.addEventListener("beforeprint", () => { preparePrintMap(); });
window.addEventListener("afterprint", () => { if(printRestore){ printRestore(); printRestore = null; } });

/* ── WHAT A LEG IS, IN WORDS (§2bk) ────────────────────────────────────────────────────────
   `go.remap.earth` gives every generated route a name, a stat line and one plain sentence —
   "Riverside giving way to parkland. Lumpy in places, 184 m." — and that sentence is what makes
   a computed thing feel authored. We hold the raw material for the same trick: mode, both
   endpoints, and geometry when a leg has been routed.

   🔴 NO DURATION, AND THAT IS THE DECISION IN THIS BLOCK. We have distance and we do NOT have a
   travel time: nothing in `/api/route`'s response carries one, so any hours figure would be
   distance divided by a speed somebody made up. A stated duration is read as a fact and planned
   around, and this product's whole argument is that it does not invent things about your trip.
   Remap can print "2h 9m" because a routing engine gave it one. When ours does, this is where it
   goes.

   AND THE DISTANCE SAYS WHICH KIND IT IS. A routed leg sums its real road geometry; an unrouted
   one is a great-circle chord, which on a road trip is a meaningful understatement — so it is
   labelled "direct" rather than quietly presented as driving miles. Same rule as §2bm: never let
   an unresolved thing look finished. */
function legMiles(prev, s){
  if(!prev || typeof s.lat!=="number" || typeof s.lng!=="number") return null;
  const A=[+prev.lat,+prev.lng], B=[+s.lat,+s.lng];
  let geo=null;
  try{ if(ROAD_ROUTING && followsRoads(s.mode)) geo = cachedRoute(runSig([A,B])) || null; }catch(e){}
  if(geo && geo.length>1){
    let m=0;
    for(let i=1;i<geo.length;i++) m += milesBetween({lat:geo[i-1][0],lng:geo[i-1][1]},{lat:geo[i][0],lng:geo[i][1]});
    return {miles:Math.round(m), road:true};
  }
  const m = milesBetween({lat:A[0],lng:A[1]},{lat:B[0],lng:B[1]});
  return {miles:Math.round(m), road:false};
}
/* One sentence, assembled only from things that are true of THIS trip. The comparative is
   remap's other good idea (§2bk) applied honestly: we hold every leg, so we can say which one is
   the longest without guessing anything — and a superlative is only offered when there are at
   least three legs to be superlative among, or "the longest" is a boast about a field of two. */
/* EVERY LEG IN THE TRIP, not every leg in a track, and the difference is a false sentence.
   Legs are consecutive pairs WITHIN a track, so the first version compared each leg only against
   its own vehicle's — and then printed "the longest leg of the trip". On a two-crew trip that
   phrase appeared TWICE. Either the comparison widens or the words narrow; the words are better,
   so the comparison widens. Computed once per render rather than per leg, because it was O(n²)
   and every call re-summed the same routed geometry. */
function tripLegMiles(ord){
  const out = [];
  for(const t of [...new Set(ord.map(x=>x.track))]){
    const legs = ord.filter(x=>x.track===t);
    for(let i=1;i<legs.length;i++){ const d=legMiles(legs[i-1],legs[i]); if(d && d.miles) out.push(d.miles); }
  }
  return out;
}
const nMiles = n => n.toLocaleString("en-US");
function legSay(prev, s, allMiles){
  const d = legMiles(prev, s); if(!d || !d.miles) return "";
  /* HOW the distance was got, in the leg's own terms. "Direct" is the honest word for a chord we
     never routed — but a FLIGHT is direct, so calling it that says nothing and reads as a hedge
     about a number that is not hedged. Air miles are air miles. */
  const how = s.mode === "fly" ? " by air" : (d.road ? " by road" : " direct");
  const bits = [nMiles(d.miles) + (d.miles === 1 ? " mile" : " miles") + how];
  if(allMiles && allMiles.length >= 3){
    const max = Math.max(...allMiles), min = Math.min(...allMiles);
    if(d.miles === max && max !== min) bits.push("the longest leg of the trip");
    else if(d.miles === min && max !== min) bits.push("the shortest");
  }
  if(s.craft) bits.push(isCraftLeg(s) ? ("on the " + s.craft) : ("with the " + s.craft + " along"));
  return bits.join(" · ");
}

function drawRead(){
  const body = document.getElementById("readBody"); if(!body) return;
  const ord = sorted();
  const name = (CONFIG.name||"").trim() || "This trip";
  const span = docSpan(ord.map(s=>s.date));
  const route = ord.length ? docRoute(ord) : "";
  const allMiles = ord.length ? tripLegMiles(ord) : [];
  const bits = [route, span].filter(Boolean).join('<span class="sep"> · </span>');

  let h = `<h1>${esc(name)}</h1>` + (bits ? `<p class="rsub">${bits}</p>` : "");

  if(!ord.length){
    h += `<p class="rempty">No stops yet.</p>`;
  } else {
    /* Grouped by vehicle only when there IS a second one — a one-vehicle trip should not be
       made to look like it has a category it does not have. */
    const tracks = [...new Set(ord.map(s=>s.track))].filter(t=>ord.some(x=>x.track===t));
    const many = tracks.length > 1;
    for(const t of tracks){
      const legs = ord.filter(s=>s.track===t);
      if(many) h += `<h2>${esc(TRACK_LABELS[t]||t)}</h2>`;
      else     h += `<h2>The route</h2>`;
      legs.forEach((s,i)=>{
        /* A stop's `mode` is how you got TO it, not what the stop is. The first stop of a track
           has no leg into it, so printing "Drive" beside it says something false — the live demo
           labelled "Chicago O'Hare — 9:40a flight to Reno" as a Drive, because that is where Alex
           STARTS. In the card UI an arrow carries that direction; a document has no arrow, so the
           preposition does the work and the origin simply gets none. */
        const arrive = i === 0 ? "" : (READ_MODE[s.mode] || "");
        const meta = [s.date ? fmtDate(s.date) : "", arrive,
                      s.craft ? esc(s.craft) : ""].filter(Boolean).join(" · ");
        /* The origin has no leg into it, so it gets no sentence — same reason it gets no mode. */
        const say = i === 0 ? "" : legSay(legs[i-1], s, allMiles);
        h += `<div class="rleg"><div class="rnum">${i+1}</div><div>`
          +  `<p class="rwhere">${esc((s.place||"").trim()||"Unnamed stop")}</p>`
          +  (meta ? `<p class="rmeta">${meta}</p>` : "")
          +  (say ? `<p class="rsay">${esc(say)}</p>` : "")
          +  (s.lodging ? `<p class="rstay"><b>stay</b>${esc(s.lodging)}</p>` : "")
          +  (s.notes ? `<p class="rnote">${esc(s.notes)}</p>` : "")
          +  `</div></div>`;
      });
    }
  }

  /* Posts and notes belong in a document of the trip; a sealed drop that is still sealed does
     not, and cannot be here anyway — the server withheld its text. */
  const posts = (allPosts||[]).filter(p=>(p.caption||"").trim() || (p.photo||"").trim());
  if(posts.length){
    h += `<h2>Posts</h2>`;
    for(const p of posts)
      h += `<div class="rleg"><div class="rnum">·</div><div>`
        +  `<p class="rnote">${esc((p.caption||"").trim() || "A photo")}</p>`
        +  (p.author ? `<p class="rmeta">${esc(p.author)}</p>` : "") + `</div></div>`;
  }
  const ns = (allNotes||[]).filter(n=>(n.title||n.body||"").trim());
  if(ns.length){
    h += `<h2>Notes</h2>`;
    for(const n of ns)
      h += `<div class="rleg"><div class="rnum">·</div><div>`
        +  (n.title ? `<p class="rwhere">${esc(n.title)}</p>` : "")
        +  (n.body ? `<p class="rnote">${esc(n.body)}</p>` : "") + `</div></div>`;
  }
  /* The one place this belongs: somebody reading their trip is the person who will want it in a
     canyon. The map goes blank without signal and this page goes with it — the zip is the only
     thing here that does not. Said where it is useful rather than in a settings drawer.
     .noprint because a download button is nonsense on paper: whoever holds the printout has
     already taken it with them. */
  h += `<div class="noprint"><h2>Take it with you</h2>`
    +  `<p class="rnote">Going somewhere without signal? <b>Download a copy first.</b> This page `
    +  `needs the internet; that file does not — it opens on any device with nothing installed, `
    +  `and it keeps working after the trip's term ends.</p>`
    +  `<p class="rnote"><button type="button" class="readdl">Download a copy</button></p></div>`;
  body.innerHTML = h;
  const dl = body.querySelector(".readdl");
  if(dl) dl.onclick = () => downloadTrip(dl);
}
function openRead(){
  drawRead();
  document.body.classList.add("reading");
  document.getElementById("readPanel").classList.add("show");
}
function closeRead(){
  document.getElementById("readPanel").classList.remove("show");
  document.body.classList.remove("reading");
}
document.getElementById("readBtn").onclick   = openRead;

/* ── §2v PROTOTYPE wiring: the trip action bar (?bar=1) ────────────────────────────────
   Every verb REUSES the handler that already exists — this proposes a place to put things,
   it does not reimplement any of them. Share falls back to the clipboard where the native
   sheet is absent; Take-it opens Info, which is where export lives today (consolidating
   those four surfaces into one sheet is proposal (b), and Peter's call, not this flag's). */
/* app.html has no toast, and a previous `toast && toast(...)` on this page threw a
   ReferenceError that killed the entire inline script (CLAUDE.md). This is the least thing
   that discharges the need — one element, made on demand, hidden on a timer. It is not a
   notification system and must not grow into one. */
/* `ms` because 1.8s is right for "Link copied" — you already know what you did — and wrong for
   the end of a replay, which is the one line that has to survive being read by someone who was
   watching the map and not the caption. Peter: "the end msg needs to be there longer." */
function say(msg, ms){
  let t = document.getElementById("sayer");
  if(!t){ t = document.createElement("div"); t.id = "sayer";
          t.setAttribute("role","status"); t.setAttribute("aria-live","polite");
          document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(say._t);
  say._t = setTimeout(() => t.classList.remove("on"), ms || 1800);
}
function tripAct(act){
  if(act==="here"){ addStopHere(); return; }
  if(act==="photo"){ tapPhoto(); return; }
  if(act==="replay"){ tapPlay(); return; }   // same one-tap rule as the header button
  if(act==="read"){ openRead(); return; }
  if(act==="share"){
    const url = `${TRIP_BASE}/#k=${KEY}`;
    if(navigator.share) navigator.share({title: CURRENT_NAME || "our trip", url}).catch(()=>{});
    else {
      /* app.html has NO toast() — `toast && toast(...)` would have thrown a ReferenceError
         and killed the whole inline script, taking the page with it (CLAUDE.md). Say it on
         the button instead, which is where the person is looking anyway. */
      navigator.clipboard.writeText(url).catch(()=>{});
      /* A copy that happens in silence is a link you are not sure you have, and would not
         paste. This used to write onto the #tripActs Share button; that bar is gone. */
      say("Link copied");
    }
    return;
  }
  if(act==="take") openTake();
  if(act==="settings") openSettings();
}

/* §2v(d): SETTINGS IS BUILT FRESH EVERY TIME IT OPENS, deliberately. The card reads CONFIG,
   MEMBER_ROSTER, ME, EXPIRES and KEY at build time and wires its handlers to the element it
   returns, so a cached copy would show a stale crew after somebody was added and a stale name
   after a rename — and rotate/delete would still be bound to it. Rebuilding is also what keeps
   this a MOVE rather than a fork: settingsCard() is untouched and still has exactly one
   definition, so nothing here can drift from what it did inside the Info tab. */
function openSettings(){
  const s = document.getElementById("setSheet"), body = document.getElementById("setBody");
  if(!s || !body || ACCESS !== "edit") return;
  setReturn = document.activeElement;
  body.innerHTML = "";
  body.appendChild(settingsCard());
  applyReadonly();                 // same pass the list gets, so edit-only controls behave
  s.hidden = false;
  const first = body.querySelector("input,button");
  if(first && first.focus) first.focus();
}
function closeSettings(){
  const s = document.getElementById("setSheet");
  if(!s || s.hidden) return;
  s.hidden = true;
  document.getElementById("setBody").innerHTML = "";   // never leave a live delete button parked
  if(setReturn && setReturn.focus) setReturn.focus();
}
let setReturn = null;
try{
  const ss = document.getElementById("setSheet");
  if(ss){
    ss.onclick = e => { if(e.target === ss) closeSettings(); };
    const x = document.getElementById("setClose"); if(x) x.onclick = closeSettings;
    document.addEventListener("keydown", e => { if(e.key === "Escape") closeSettings(); });
  }
}catch(e){}

/* §2v prototype (b): one sheet for every way out. Each row calls the SAME function the
   scattered buttons already call — nothing here is a second implementation, so nothing here
   can drift from what the Info tab and the settings card do. */
function openTake(){
  const s = document.getElementById("takeSheet");
  if(!s) return;
  takeReturn = document.activeElement;
  const dated = sorted().filter(x => x.date).length;
  /* The offline row's three states, decided the same way the calendar row decides its own:
     no per-trip archive cut yet → disabled WITH THE REASON, because a dead control that does not
     say why reads as a broken feature. */
  (async () => {
    const row = s.querySelector('[data-take="offline"]'), sub = row && row.querySelector(".tk-off");
    if(!row || !sub) return;
    if(!PM_TRIP){
      row.disabled = true;
      sub.textContent = "this trip's map is still being prepared — check back tomorrow";
      return;
    }
    const have = await archiveGet(PM_TRIP);
    if(have){
      row.dataset.state = "saved";
      sub.textContent = "saved on this phone, " + Math.round(have.size/1048576) + " MB — the map works with no signal. Tap to remove.";
    }else{
      row.dataset.state = "none";
      const b = await archiveSize(PM_TRIP);
      sub.textContent = (b ? Math.round(b/1048576) + " MB — " : "") + "save it now and the map still works where there is no signal";
    }
  })();
  const ics = s.querySelector('[data-take="ics"]');
  /* The calendar is the one format that can come out empty, and the existing card already
     refuses in that case — say why on the row instead of alerting after the tap. */
  ics.disabled = !dated;
  ics.querySelector("span").textContent = dated
    ? `.ics — ${dated} dated stop${dated===1?"":"s"}, for any calendar app`
    : ".ics — needs a date on at least one stop first";
  s.hidden = false;
  const first = s.querySelector(".tk-row:not([disabled])");
  if(first) first.focus();
}
function closeTake(){
  const s = document.getElementById("takeSheet");
  if(!s || s.hidden) return;
  s.hidden = true;
  if(takeReturn && takeReturn.focus) takeReturn.focus();
}
let takeReturn = null;
function takeAct(what, btn){
  if(what === "close"){ closeTake(); return; }
  if(what === "ics"){ download(tripToIcs(), "text/calendar;charset=utf-8", "ics"); closeTake(); return; }
  if(what === "csv"){ download(tripToCsv(), "text/csv;charset=utf-8", "csv"); closeTake(); return; }
  if(what === "print"){
    /* Print the DOCUMENT, with its map. Opening the read view first is what makes the printed
       page a trip rather than a screenshot of an interface (the rule the print CSS already
       encodes), and awaiting the map prep is what stops it printing before the tiles land. */
    closeTake();
    const wasReading = document.body.classList.contains("reading");
    if(!wasReading) openRead();
    preparePrintMap().then(() => window.print());
    return;
  }
  if(what === "offline"){
    /* Keeps its own state on the row and does NOT close the sheet — a 25 MB download over a motel
       connection needs somewhere to show progress, and the sheet is where the person is looking. */
    const sub = btn && btn.querySelector(".tk-off");
    if(!PM_TRIP || !sub) return;
    if(btn.dataset.state === "saved"){
      mapTx("readwrite", st => st.delete(PM_TRIP)).then(() => {
        OFFLINE_ARCHIVE = null; btn.dataset.state = "none";
        sub.textContent = "removed from this phone";
      }).catch(() => { sub.textContent = "could not remove it"; });
      return;
    }
    btn.disabled = true;
    archiveSave(PM_TRIP, (got, total) => {
      sub.textContent = total ? "saving… " + Math.round(got/total*100) + "%"
                              : "saving… " + Math.round(got/1048576) + " MB";
    }).then(bytes => {
      btn.disabled = false; btn.dataset.state = "saved";
      sub.textContent = "saved on this phone, " + Math.round(bytes/1048576) + " MB — the map works with no signal. Tap to remove.";
      try{ applyTheme(); }catch(e){}      // rebuild so the layers read the cached copy from now on
    }).catch(() => {
      btn.disabled = false;
      sub.textContent = "could not save it — check the connection, or free some space on the phone";
    });
    return;
  }
  if(what === "zip"){ downloadTrip(btn); return; }   // keeps its own "Packing…" state on the row
}
/* The take sheet is wired UNCONDITIONALLY. It sat inside the ?bar=1 block, which was right
   while #tripActs was the only thing that could open it — but #fab reaches openTake() on the
   DEFAULT path now, and a sheet whose every button does nothing is worse than no sheet.
   The flag still gates the action BAR. It no longer gates the sheet. */
try{
  const ts = document.getElementById("takeSheet");
  if(ts){
    ts.querySelectorAll("[data-take]").forEach(b => b.onclick = () => takeAct(b.dataset.take, b));
    /* Tapping the scrim closes it; tapping the card must not. */
    ts.onclick = e => { if(e.target === ts) closeTake(); };
    document.addEventListener("keydown", e => { if(e.key === "Escape") closeTake(); });
  }
}catch(e){}
/* ── #fab: the trip page's four verbs, in the ring ───────────────────────────────────────
   Same surface /new uses, so the two pages behave alike. Four wedges is comfortably inside
   what ring.js sizes for (it steps its inner radius down past five, and D-120's "visual mess"
   was eight), so nothing nests here.
   Replay is offered only when there IS something to replay — the same >=2-frames rule
   syncReplayBtn and the action bar both use. A wedge that cannot work is worse than a wedge
   that is absent, and unlike the bar the ring has no disabled state to explain itself with. */
/* The arc, not ring.js. Replay is offered only when there is something to replay — the same
   >=2-frames rule syncReplayBtn uses — so the arc is three or four plates, never a hole. */
function fabItems(){
  /* No Replay wedge. It moved OUT of here to #playMap on the map, because Peter could not find
     it: "not hidden in FAB nav and labled replay". A verb this central should not need a menu
     opened to reach it, and calling it "Replay" made it sound like a repeat of something you
     had already watched rather than the way to watch it. */
  /* "Take it", NOT "Print". This wedge has always opened the take-it sheet — Print is only its
     FIRST ROW — so the label named one of four ways out and hid the other three. Somebody who
     wants their trip as a calendar, a spreadsheet, or a map file for Google Earth does not press
     Print, so .ics, .csv and trip.kml/trip.gpx were reachable and unfindable. That is the same
     failure §2y(4) fixed for Replay ("not hidden in FAB nav and labled replay") and the same one
     §2v measured across four surfaces: the feature existed and the word did not say so. */
  /* Settings is EDIT-ONLY and last. A view-phrase holder has nothing to set — no rotate, no
     crew, no delete — so offering the wedge would be a door onto a locked room. The ring's
     radius already scales with the count (R = 78 + 12*items.length), so four plates space
     themselves; this was written for four verbs. */
  /* PHOTO IS FIRST AND EDIT-ONLY (§2bc, the field finding). On the road the gesture is "here,
     now, this", and until 2026-08-12 a photo cost five interactions because you had to find the
     STOP before the app would take one. This wedge inverts that: the picture arrives first and
     says where it belongs. A view-phrase holder cannot write, so they do not get the door. */
  /* READONLY, not ACCESS — so previewing as a guest hides the writer's verbs too. A preview that
     still offered Photo and Settings would be showing you a screen no viewer has ever seen. */
  /* HERE is first and PHOTO second: both are road verbs, and the one that changes the PLAN comes
     before the one that decorates it. Read/Take it/Share are desk verbs and follow. */
  const items = [];
  if(!READONLY) items.push({key:"here", label:"Here"});
  /* NO PHOTO WEDGE ANY MORE (§2bl). It moved OUT to #photoMap on the map, exactly as Replay
     did, because the measurement said two of its three interactions were spent reaching it.
     Keeping both would have added a control to a product Peter had already called busy while
     leaving the slow path in place for anyone who found it first. `act==="photo"` still routes
     to `tapPhoto()` so nothing that calls it breaks. The ring is back to the five verbs its
     radius comment was written around. */
  items.push({key:"read", label:"Read"}, {key:"take", label:"Take it"}, {key:"share", label:"Share"});
  if(!READONLY) items.push({key:"settings", label:"Settings"});
  return items;
}
/* THE FAB IS A LIQUID TREE (goo-fab.js, 2026-10-13; Peter: "a click on the + gives 3 options,
   clicking on any of those 3 loads a branch from it of more options"). The three doors and
   what is behind each, built from state the way fabItems() always was, so a viewer never sees
   a writer's verb:
     Add   → Here · Photo · Play (when there is something to play)        writers only
     Keep  → Read · Take it → Print · Calendar · Sheet · More… · Settings (writers)
     Share → Share… · Copy link (one tap when the phone cannot share: it copies)
   "Take it" is the branch that goes three deep: Print, the calendar file and the spreadsheet
   act at once; "More…" opens the take-it sheet for the two rows that need it (offline map,
   map file), which keep their own progress state there. */
let gooFab = null;
function fabTree(){
  const keys = fabItems().map(it => it.key);
  const tree = [];
  if(keys.includes("here")){
    const add = [{key:"here", label:"Here"}, {key:"photo", label:"Photo"}];
    const play = document.getElementById("playMap");
    if(play && !play.hidden) add.push({key:"replay", label:"Play"});
    tree.push({key:"add", label:"Add", kids:add});
  }
  const keep = [{key:"read", label:"Read"},
    {key:"take", label:"Take it", kids:[{key:"print", label:"Print"}, {key:"ics", label:"Calendar"}, {key:"csv", label:"Sheet"}, {key:"takemore", label:"More…"}]}];
  if(keys.includes("settings")) keep.push({key:"settings", label:"Settings"});
  tree.push({key:"keep", label:"Keep", kids:keep});
  tree.push(navigator.share
    ? {key:"sharing", label:"Share", kids:[{key:"share", label:"Share…"}, {key:"copy", label:"Copy link"}]}
    : {key:"share", label:"Share"});
  return tree;
}
function fabPick(key){
  if(key === "print" || key === "ics" || key === "csv"){ takeAct(key, null); return; }
  if(key === "takemore"){ openTake(); return; }
  if(key === "copy"){
    navigator.clipboard.writeText(`${TRIP_BASE}/#k=${KEY}`).catch(()=>{});
    say("Link copied");
    return;
  }
  tripAct(key);
}
function closeTripFab(){
  if(gooFab) gooFab.close();
}
/* ── ?rdiag=1: what the phone can tell us that a desktop cannot ───────────────────────────
   Two counters, and the difference between them IS the diagnosis:
     · "tick"  advances only when the replay interval actually fires.
     · "alive" advances on its own 1s interval regardless.
   If alive keeps climbing while tick freezes, the replay timer stopped being called and the
   page is fine — a throttled or suspended interval. If BOTH freeze, the whole page is being
   suspended. If tick reports THREW, it is an exception and the message is right there.
   Flag-gated; nothing renders without ?rdiag=1. */
let rdiagEl=null, rdiagBeats=0;
function rdiag(msg){
  if(!rdiagEl){
    rdiagEl=document.createElement("div");
    rdiagEl.style.cssText="position:fixed;left:8px;top:calc(env(safe-area-inset-top) + 8px);"+
      "z-index:9999;background:#111;color:#0f0;font:12px/1.45 ui-monospace,monospace;"+
      "padding:8px 10px;border-radius:8px;max-width:70vw;white-space:pre-wrap;pointer-events:none";
    document.body.appendChild(rdiagEl);
    setInterval(()=>{ rdiagBeats++; rdiagPaint(); }, 1000);
  }
  rdiagEl.dataset.last=msg;
  rdiagPaint();
}
function rdiagPaint(){
  if(!rdiagEl) return;
  rdiagEl.textContent =
    "alive " + rdiagBeats + "s\n" +
    "last  " + (rdiagEl.dataset.last||"—") + "\n" +
    "timer " + (replayTimer ? "running" : "stopped") + "\n" +
    "frame " + (document.getElementById("replaySlider")||{}).value + "\n" +
    "vis   " + document.visibilityState;
}

function openTripFab(){
  if(!gooFab){
    if(typeof createGooFab !== "function") return;   // module absent: the button does nothing rather than throwing
    gooFab = createGooFab({fab:"#fab", veil:"#fabVeil", z:32, onPick:fabPick});
  }
  gooFab.open(fabTree());
}
document.getElementById("fabVeil").addEventListener("click", closeTripFab);
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeTripFab(); });
document.getElementById("readBack").onclick  = closeRead;
/* Same wait as the Take-it sheet's Print row — this button is already inside the read view,
   so it only needs the map framed and its tiles down before the dialog opens. */
document.getElementById("readPrint").onclick = () => preparePrintMap().then(() => window.print());
/* Escape closes it, like the info panel and the gate. */
document.addEventListener("keydown", e => {
  if(e.key === "Escape" && document.getElementById("readPanel").classList.contains("show")) closeRead();
});

async function openInfo(page){
  const panel=document.getElementById("infoPanel"), body=document.getElementById("infoBody");
  const title=document.getElementById("infoTitle"), out=document.getElementById("infoOpen");
  infoReturn = document.activeElement;
  out.href = "/" + page;
  title.textContent = "…";
  body.innerHTML = "";
  panel.classList.add("show");
  trapFocus(panel);
  document.getElementById("menu").classList.remove("show");

  let got = infoCache.get(page);
  if(!got){
    try{
      const r = await fetch("/" + page, {headers:{"Accept":"text/html"}});
      if(!r.ok) throw new Error(r.status);
      got = infoStrip(await r.text());
      if(!got.html) throw new Error("no body");
      infoCache.set(page, got);
    }catch(e){
      // Say what happened and give the way out, rather than an empty panel.
      title.textContent = page.replace(/-/g," ");
      body.innerHTML = '<p>That page didn\u2019t load — you may be offline.</p>'
        + '<p><a class="btn" href="/'+page+'" target="_blank" rel="noopener">Open it in a new tab</a></p>';
      body.focus();
      return;
    }
  }
  title.textContent = got.title || page.replace(/-/g," ");
  body.innerHTML = got.html;
  // These pages were written for a browser tab, so they end in "start a trip" and "see the
  // tiers". Followed from inside a trip those walk the person straight off it — the thing
  // this panel exists to stop. Info pages stay in the panel (handled below); everything else
  // gets its own tab, so the map is still here when they come back.
  body.querySelectorAll("a[href]").forEach(a=>{
    const h=a.getAttribute("href");
    if(/^\/(help|faq|about|mission|privacy|terms|what-you-get)$/.test(h)) return;
    if(h.startsWith("#")) return;
    a.target="_blank"; a.rel="noopener";
  });
  body.scrollTop = 0;
  body.focus();
}

function closeInfo(){
  const panel=document.getElementById("infoPanel");
  if(!panel.classList.contains("show")) return false;
  panel.classList.remove("show");
  if(infoReturn && infoReturn.focus) infoReturn.focus();
  infoReturn = null;
  return true;
}

document.getElementById("infoBack").onclick = closeInfo;
// Capture phase, and swallow the key once it has closed the panel: another Escape handler
// further down dismisses a different bit of UI, and one press should undo one thing.
document.addEventListener("keydown", e=>{
  if(e.key==="Escape" && closeInfo()){ e.stopPropagation(); e.preventDefault(); }
}, true);
document.getElementById("menu").addEventListener("click", e=>{
  const a = e.target.closest("a[data-info]");
  if(!a) return;
  if(e.metaKey || e.ctrlKey || e.shiftKey || e.button===1) return;   // let a real new tab happen
  e.preventDefault();
  openInfo(a.dataset.info);
});
// Links inside the panel that point at another info page stay in the panel.
document.getElementById("infoBody").addEventListener("click", e=>{
  const a = e.target.closest("a"); if(!a) return;
  if(e.metaKey || e.ctrlKey || e.shiftKey) return;
  const m = (a.getAttribute("href")||"").match(/^\/(help|faq|about|mission|privacy|terms|what-you-get)$/);
  if(m){ e.preventDefault(); openInfo(m[1]); }
});

/* ═════════ gate + name screens ═════════ */
const gateEl=document.getElementById("gate"), nameEl=document.getElementById("namegate");
function trapFocus(el){
  if(el._trapped) return; el._trapped=true;
  el.addEventListener("keydown",e=>{
    if(e.key!=="Tab" || !el.classList.contains("show")) return;
    const f=[...el.querySelectorAll('button,input,[href],select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(x=>x.offsetParent!==null);
    if(!f.length) return;
    const first=f[0], last=f[f.length-1];
    if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  });
}
function showName(){
  nameEl.classList.add("show"); trapFocus(nameEl);
  requestAnimationFrame(()=>{ const i=document.getElementById("nameInput"); if(i) i.focus(); });
}
/* The trip is gone, so the gate becomes a notice: no input, nothing to try. */
function showExpired(msg){
  /* The trip is gone or its term ended — drop the offline copy too, or it would keep
     rendering a trip that no longer exists, on a page telling the reader it does not. */
  try{ localStorage.removeItem("ttb_key_"+slug); }catch(e){}
  clearTripCache();
  const p=gateEl.querySelector("p"), inp=document.getElementById("gateInput"),
        btn=document.getElementById("gateBtn");
  if(p) p.textContent=msg;
  if(inp) inp.hidden=true;
  if(btn) btn.hidden=true;
  document.getElementById("gateErr").textContent="";
  gateEl.classList.add("show");
}
function showGate(){ gateEl.classList.add("show"); trapFocus(gateEl);
  requestAnimationFrame(()=>{ const i=document.getElementById("gateInput"); if(i) i.focus(); }); }
function hideGate(){ gateEl.classList.remove("show"); }

/* F-13: `#k=` is read once, at boot. Change only the hash and the browser fires `hashchange`
   and navigates nothing — so the page kept the gate up, kept the old error on screen, and
   ignored the phrase sitting in the address bar.

   That is not a corner case, it is the ordinary recovery path: someone types the phrase, gets
   it wrong, then gives up and taps the link they were actually sent. The link is right and the
   page says "Not it". */
addEventListener("hashchange", () => {
  const k = new URLSearchParams(location.hash.slice(1)).get("k");
  if (!k) return;
  KEY = k;
  history.replaceState(null, "", location.pathname + location.search);   // scrub it, same as at boot
  // ...and "same as at boot" now includes keeping the query — see the note there.
  const err = document.getElementById("gateErr"); if (err) err.textContent = "";
  sync().then(onAuthed).catch(() => {});               // a wrong key just reopens the gate via api()
});
async function submitGate(){
  const btn=document.getElementById("gateBtn");
  const v=document.getElementById("gateInput").value.trim().toLowerCase().replace(/\s+/g,"-"); // spaces OR hyphens both work
  if(!v) return;
  KEY=v; document.getElementById("gateErr").textContent="";
  btn.disabled=true; const lbl=btn.textContent; btn.textContent="Opening…";
  try{
    await sync();
    onAuthed();                       // persists the key, now that the server has accepted it
  }catch(e){
    document.getElementById("gateErr").textContent =
      (e.message==="auth"||e.message==="401") ? "Not it — check with whoever sent you." : e.message;
  }finally{ btn.disabled=false; btn.textContent=lbl; }
}
document.getElementById("gateBtn").onclick=submitGate;
document.getElementById("gateInput").addEventListener("keydown",e=>{ if(e.key==="Enter") submitGate(); });

function onAuthed(){
  /* Persist here, not at the call sites: both paths (typing the phrase, and tapping a
     #k= link) reach this only after sync() has proved the key to the server. The link
     path never stored it, so a shared link worked exactly once — and since the key is
     scrubbed from the URL bar on arrival, a refresh left the person with no way back in. */
  try{ if(KEY) localStorage.setItem("ttb_key_"+slug, KEY); }catch(e){}
  // no first-run wizard (D-009): an empty trip drops straight onto the map, and the
  // ROUTE empty-state ("add your first stop") carries it. Only the name is still asked.
  /* Ask about the TRIP, not about this browser. `CURRENT_NAME` is seeded from
     localStorage("ttb_name") — one global key with no slug in it — so on any device that had
     never named a trip it was "", and a trip the server had already named threw up the
     "name your trip" gate ON TOP of itself. Every crew member opening an edit link on their
     own phone hit it, and so did the buyer on a second device: found 2026-08-04 while
     measuring something else, with the gate covering a trip whose name ("Kishwaukee canoe")
     was on screen behind it in both the header and the pill. CONFIG.name is the server's
     answer and is populated by sync() before either onAuthed path runs. */
  if(ACCESS==="edit" && !(CONFIG.name||"").trim() && !CURRENT_NAME) showName();
}
function submitName(){
  const v=document.getElementById("nameInput").value.trim();
  if(!v) return;
  CURRENT_NAME=v.slice(0,40); localStorage.setItem("ttb_name",CURRENT_NAME);
  nameEl.classList.remove("show"); drawMap(); drawList();
}
document.getElementById("nameBtn").onclick=submitName;
document.getElementById("nameInput").addEventListener("keydown",e=>{ if(e.key==="Enter") submitName(); });

// a light, dismissible share prompt over the revealed map — sharing is the reaction to the wow, not a gate before it
function showShareNudge(){
  const url=`${TRIP_BASE}/#k=${KEY}`;
  const sh=document.getElementById("snShare"); sh.hidden=!navigator.share;
  document.getElementById("snCopy").onclick=e=>{ navigator.clipboard.writeText(url).catch(()=>{}); e.target.textContent="Copied ✓"; };
  document.getElementById("snEmail").onclick=()=>emailInvite(url,"");
  sh.onclick=()=>shareLink(url);
  document.getElementById("snClose").onclick=hideShareNudge;
  document.getElementById("shareNudge").classList.add("show");
}
function hideShareNudge(){ document.getElementById("shareNudge").classList.remove("show"); }
// the nudge now rides the FIRST STOP: an empty trip has nothing worth sending, one pin does.
// Once per trip per browser, editors only, and only from a hand-placed stop — never a restore.
function maybeShareNudge(){
  if(ACCESS!=="edit") return;
  const k="ttb_share_"+slug;
  if(localStorage.getItem(k)) return;
  localStorage.setItem(k,"1");
  setTimeout(showShareNudge, 1200);   // a beat to watch the pin land and get its name
}
const shortPlace=dn=>{ const p=(dn||"").split(","); return (p.length>2?p.slice(0,2).join(","):dn).trim()||dn; };
/* §2bm: A STOP THAT COULD NOT BE NAMED SAYS SO, AND NAMES ITSELF LATER.
   `revName()` returns null on any failure and both call sites do `if(nm) update(...)` — so with
   no signal a new stop simply kept its placeholder, silently, and never tried again. Offline must
   never produce something that looks finished and is not; that is the same rule as the sealed
   drop and the same rule as the outbox. So: remember which stops are waiting for a name, tell the
   person once, and drain the list the moment the network is back. */
const NAMELESS = new Map();                     // id → {lat,lng}
function nameLater(id, lat, lng){
  if(!id) return;
  NAMELESS.set(id, {lat, lng});
  say(NAMELESS.size === 1
    ? "Stop added. No signal to look up its name — you can type one, or it will fill itself in."
    : ("Stop added. " + NAMELESS.size + " stops still waiting for their names."));
}
async function flushNames(){
  if(!navigator.onLine || !NAMELESS.size || READONLY) return 0;
  let named = 0;
  for(const [id, at] of [...NAMELESS]){
    const nm = await revName(at.lat, at.lng);
    if(!nm) continue;                            // still unreachable; keep it for the next go
    try{ await store.update(id, {place: nm}); NAMELESS.delete(id); named++; }catch(e){}
  }
  return named;
}
addEventListener("online", () => { flushNames().then(n => { if(n) sync().catch(()=>{}); }); });

async function revName(lat,lng){   // reverse-geocode a tapped point → short place name (timeout-safe)
  const c=new AbortController(), t=setTimeout(()=>c.abort(),4000);
  try{ const r=await fetch(API_BASE+"/api/geocode?lat="+lat+"&lon="+lng,{headers:{accept:"application/json"},signal:c.signal});
    const d=await r.json(); clearTimeout(t); return (d&&d.name)?d.name:null; }
  catch(e){ clearTimeout(t); return null; }
}
/* forward geocode: a typed place name → candidate coordinates. NOT dead code — the chat-agent
   client resolves place names through here before dispatching a tool call, because
   `lib/tools.php` still refuses a place that arrives without coordinates (D-039) rather than
   guessing one. What changed in D-045 is only WHO calls Nominatim: our server now does, so a
   response cached without a CORS header can no longer cost someone the name of their stop.
   The shape below is ours, not Nominatim's — `results[]` with `lat`/`lon`/`importance`. */
async function geocode(q){
  try{
    const r=await fetch(API_BASE+"/api/geocode?q="+encodeURIComponent(q),
      {headers:{accept:"application/json"}});
    return r.ok ? ((await r.json()).results || []) : [];
  }catch(e){ return []; }
}

/* ── map ───────────────────────────────────────────────── */
const map = L.map("map",{zoomControl:false}).setView([40.5,-105],4);
/* TOP LEFT, and the bottom-right corner belongs to #fab now (Peter, 2026-08-05: "zoom controls
   to upper left, FAB lower rt always").
   This corner was vacated on 2026-08-02 on the grounds that it is where the eye lands and where
   the mark sits. What changed is that the mark no longer needs the whole corner and the FAB
   needs the other one on BOTH pages — one control that opens everything, in the same place
   whether you are building a trip or reading one. Zoom is a fallback for pinch on touch; it
   goes where it is out of the way of the thing you actually reach for.
   The masthead is the other occupant here: verified below the bar rather than under it. */
L.control.zoom({position:"topleft"}).addTo(map);   // F21 put these in — pinch-only was the
   // sole way to zoom.
/* THESE ARE THE `?raster=1` FALLBACK NOW. The vector basemap is the default again (D-165) and
   nothing fetches cartocdn unless that flag is on.
   The one-day rollback that put CARTO back is worth keeping in view: D-162 promoted the vector
   basemap on desktop evidence, it drew BLANK on Peter's iPhone — route lines and markers fine, no
   basemap — and D-163 reverted rather than debugging in front of customers. D-164 then found it
   was Cloudflare's 512 MB per-file cache limit, not the renderer. The lesson that outlives all
   three: this is a mobile-first product, so "verified on desktop" is not verified. */
const TILE_LIGHT="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_DARK ="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
let tileLayer=null;
/* PM_URL starts at the WORLD archive and is REPLACED by this trip's own the moment trip/state
   hands one over — see `tiles` there for why the token cannot be derived from the slug.
   IT USED TO START AT THE DEMO ARCHIVE, which drew empty land anywhere outside the demo trip.
   That was the honest state of a prototype and it is why the vector basemap could not be a
   default until the world archive existed: most trips are not the demo. `world-z7.pmtiles.bin` is
   178 MB, cut from the Protomaps daily build (ODbL, attribution only, free to self-host
   commercially — §6f's "pay or violate" was about their HOSTED API, which this has never used),
   and it covers the planet. It is z7 rather than z8 because 525 MB is over Cloudflare's cache
   limit (D-164), and the `.bin` extension is what gets it cached at all.

   MAX_DATA_ZOOM IS NOT DECORATION — WITHOUT IT THE MAP GOES BLANK ABOVE THE ARCHIVE'S CEILING.
   protomaps-leaflet defaults `maxDataZoom` to 15, so against a z8 archive it requests z9+ tiles
   that do not exist and paints NOTHING. Measured before the fix, distinct colours at Tahoe:
   z8 72, then z10/z12/z14/z16 all **1** — a flat sheet. Told the true ceiling it overzooms the
   z8 data instead: 41/11/12/10/9/5 at z10 through z20. Simplified at street level, but present,
   which is the difference between a coarse map and no map.
   So the ceiling travels WITH the url, and every archive must declare its own. */
/* THE SWITCH-OVER (2026-08-08, undone 08-09, redone 08-10). The vector basemap is the DEFAULT:
   their LICENSE.md restricts basemaps.cartocdn.com to enterprise customers and non-profit
   grantees — verified verbatim — and this is a commercial product, so every map view was an
   unlicensed one. Self-hosting the Protomaps daily build costs nothing (ODbL, attribution only;
   §6f's "pay or violate" was about their HOSTED API, which this has never used).
   `?raster=1` is the way back and is KEPT. It was deleted on 08-08 with the argument that a
   fallback nobody exercises drifts out of test — true, and still the wrong call, because the next
   day it was needed and rollback cost a deploy. The PNG-only tile cache did NOT come back; the
   offline archive save replaced it and is the better feature. */
/* PROMOTED AGAIN 2026-08-10, and this time on handset evidence (D-165). D-162 promoted it on a
   desktop renderer, D-163 rolled it back when it drew nothing on Peter's iPhone, and D-164 found
   the cause: the world archive was 525 MB, over Cloudflare's 512 MB cache limit, so the edge
   BYPASSed it and the library fell into a whole-file retry loop. At z0-7 (178 MB) it caches and it
   draws — 47 distinct colours on the phone that had shown 0 all evening.
   `?raster=1` IS THE WAY BACK AND IT STAYS THIS TIME. The 08-08 promotion deleted its own fallback
   in the same week it needed one; a rollback that costs a deploy is not a rollback when the failure
   is only visible on somebody's phone. CARTO stays in the CSP as a permission, not a request —
   nothing loads it unless that flag is on. */
const PM_FLAG = FLAGS.has("pmdiag") || !FLAGS.has("raster");
/* ?pmdiag=1 — A READOUT FOR A HANDSET NOBODY CAN ATTACH A DEBUGGER TO (D-163).
   The vector basemap renders blank on Peter's iPhone and every theory has died on contact:
   gzip/DecompressionStream (iOS 26.5.2 has had it for years) and Content-Encoding on range
   requests (measured clean, correct PMTiles magic, even with a Safari UA). Guessing a third time
   is not a plan — this prints what the phone actually sees.
   Same pattern as ?rdiag=1, which exists for the same reason. It turns the vector path ON, so
   one link is the whole test. */
const PM_DIAG = FLAGS.has("pmdiag");
if(PM_DIAG){
  const box = document.createElement("div");
  box.id = "pmdiag";
  box.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:9999;background:#141414;"
    + "color:#fff;font:12px/1.45 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:10px;"
    + "max-height:52vh;overflow:auto;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  const lines = [];
  const say = t => { lines.push(t); box.textContent = lines.join("\n"); };
  window.pmdiagSay = say;
  addEventListener("DOMContentLoaded", () => document.body.appendChild(box));
  if(document.body) document.body.appendChild(box);
  say("pmdiag — tap and hold to select, then send Claude the text");
  /* EVERY REQUEST, AT ISSUE AND AT SETTLE. The known-good tile read never printed either branch,
     so `src.get()` does not throw — it HANGS. That is why there is no error, no paint and no
     completed request, while a plain range fetch of the same file returns 206. So the question is
     no longer "what fails" but "does the library even issue a request, and does it come back".
     This wraps fetch ON TOP of the offline patch and logs both edges. */
  (function(){
    const inner = window.fetch;
    let n = 0;
    window.fetch = function(input, init){
      const u = (typeof input === "string" ? input : (input && input.url) || "").split("/").pop().slice(0,26);
      let rng = "";
      try{ const h = (init && init.headers) || (input && input.headers);
           rng = h ? (h.get ? (h.get("Range")||"") : (h.Range||h.range||"")) : ""; }catch(e){}
      const id = ++n;
      if(/pmtiles/.test(u)) say("  -> #" + id + " " + u + " " + rng);
      const t0 = Date.now();
      return inner(input, init).then(r => {
        if(/pmtiles/.test(u)) say("  <- #" + id + " " + r.status + " in " + (Date.now()-t0) + "ms");
        return r;
      }, e => {
        if(/pmtiles/.test(u)) say("  <- #" + id + " THREW " + e.name + " " + e.message);
        throw e;
      });
    };
  })();
  say("ua: " + navigator.userAgent.slice(0, 78));
  /* The two failures a blank map splits into: the renderer never arrives, or it arrives and
     draws nothing. Everything below distinguishes those. */
  addEventListener("error", e => say("ERROR: " + (e.message || e.type) + " @ " + (e.filename||"(no file — cross-origin sanitised)").split("/").pop() + ":" + (e.lineno||"?") + ":" + (e.colno||"?")));
  addEventListener("unhandledrejection", e => say("REJECT: " + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).slice(0,220)));
  setTimeout(() => {
    say("protomapsL: " + typeof window.protomapsL);
    say("ttbMapStyle: " + typeof window.ttbMapStyle);
    try{ const o = window.ttbMapStyle && ttbMapStyle.options(false);
         say("style rules: " + (o ? o.paintRules.length + " paint / " + o.labelRules.length + " label" : "NULL")); }
    catch(e){ say("style THREW: " + e.name + " " + e.message); }
    say("world: " + PM_URL);
    say("trip:  " + (PM_TRIP || "none yet"));
    say("layers: base=" + (!!tileLayer) + " detail=" + (!!pmDetail));
    const reqs = performance.getEntriesByType("resource").filter(r=>/pmtiles/.test(r.name));
    say("archive requests: " + reqs.length);
    reqs.slice(0,6).forEach(r => say("  " + r.name.split("/").pop().slice(0,28) + "  " + Math.round(r.duration) + "ms  " + (r.transferSize||0) + "b"));
    /* Does anything reach the canvas? One number separates "no data" from "data, no paint". */
    let colours = new Set(), canvases = 0;
    document.querySelectorAll("#map canvas").forEach(c => { canvases++;
      try{ const g = c.getContext("2d", {willReadFrequently:true}); if(!g) return;
        const d = g.getImageData(0,0,Math.min(c.width,200),Math.min(c.height,200)).data;
        for(let i=0;i<d.length;i+=4*29){ if(d[i+3]<8) continue; colours.add((d[i]>>4)+","+(d[i+1]>>4)+","+(d[i+2]>>4)); }
      }catch(e){ say("canvas read blocked: " + e.name); } });
    say("canvases: " + canvases + "   distinct colours: " + colours.size);
    say(colours.size > 6 ? "=> THE MAP IS DRAWING" : "=> BLANK: data or paint is missing");
  }, 6000);
  /* THE 6s READ SAID `ttbMapStyle: undefined` WHILE protomapsL WAS AN OBJECT, so the style module
     is the thing to chase — but 6s may simply be too early on a phone connection, since it is
     injected only AFTER the renderer's onload. This fetches it directly (which needs no script
     tag and no chain) and reports again at 15s, which separates "never arrived" from "arrived
     late" from "arrived and failed to execute". */
  fetch("/mapstyle.js?v=12", {cache:"no-store"})
    .then(r => r.text().then(t => say("mapstyle fetch: HTTP " + r.status + ", " + t.length + " bytes, "
        + (t.indexOf("ttbMapStyle") > -1 ? "contains ttbMapStyle" : "MISSING ttbMapStyle"))))
    .catch(e => say("mapstyle fetch FAILED: " + e.name + " " + e.message));
  /* THE 15s READ SAID: style loaded, 19 rules, BOTH LAYERS BUILT, 24 canvases — and ZERO archive
     requests. A layer that is constructed and then never fetches is not a style problem, a URL
     problem or a timing problem, so this asks the library to read ONE TILE directly and prints
     whatever comes back. That separates "this phone cannot read the archive" from "it can, and
     the layer is not asking". Also checks the two things that could silently stop a fetch: a map
     with no size, and our own fetch patch. */
  setTimeout(() => {
    say("--- direct tile read ---");
    try{
      say("map size: " + JSON.stringify(map.getSize()));
      say("fetch is " + (window.fetch.name === "fetch" ? "native-ish" : "PATCHED (" + window.fetch.name + ")"));
      say("OFFLINE_ARCHIVE: " + (typeof OFFLINE_ARCHIVE !== "undefined" && OFFLINE_ARCHIVE ? "SET" : "null"));
      const S = protomapsL.PmtilesSource;
      say("PmtilesSource: " + typeof S);
      say("DecompressionStream: " + typeof DecompressionStream);
      const src = new S(PM_URL, true);
      /* 8/42/97 is Tahoe and I decoded it SERVER-SIDE: it carries water (lake, river, water) and
         landuse (wetland, forest, scrub…). If this phone reads it as empty, the decode is failing
         silently — the previous probe used a Pacific tile where empty is the correct answer, so
         it proved nothing. */
      Promise.resolve(src.get({z:8,x:42,y:97}, 256))
        .then(t => { const k = Object.keys(t || {});
          say("KNOWN-GOOD tile 8/42/97 — layers: " + (k.join(",") || "(NONE — decode is failing)"));
          k.slice(0,6).forEach(n => say("   " + n + ": " + ((t[n]||[]).length) + " features")); })
        .catch(e => say("known-good tile FAILED: " + (e && (e.name + " " + e.message))));
      let settled = false;
      Promise.resolve(src.get({z:8,x:42,y:97}, 256)).then(()=>settled=true, ()=>settled=true);
      setTimeout(() => { if(!settled) say("known-good tile: STILL PENDING after 6s — the read hangs"); }, 6000);
      /* And a plain range request, which needs no library at all. */
      fetch(PM_URL, {headers:{Range:"bytes=0-15"}})
        .then(r => r.arrayBuffer().then(b => say("range fetch: HTTP " + r.status + ", " + b.byteLength + "b, magic=" +
              new TextDecoder().decode(new Uint8Array(b).slice(0,7)))))
        .catch(e => say("range fetch FAILED: " + e.name + " " + e.message));
    }catch(e){ say("probe threw: " + e.name + " " + e.message); }
  }, 9000);
  /* The layer creates canvases and never fetches, and the only error is a cross-origin-sanitised
     "Script error." with no file. Wrapping the layer's own createTile is the way to see the
     exception it is swallowing — Leaflet calls this per tile, so one failure prints once. */
  setTimeout(() => {
    try{
      if(tileLayer && tileLayer.createTile && !tileLayer.__wrapped){
        const orig = tileLayer.createTile.bind(tileLayer);
        let told = false;
        tileLayer.createTile = function(coords, done){
          try{ return orig(coords, done); }
          catch(e){ if(!told){ told = true; say("createTile THREW: " + e.name + " " + e.message); } throw e; }
        };
        tileLayer.__wrapped = true;
        map.setView(map.getCenter(), map.getZoom(), {animate:false});
        map.invalidateSize();
        say("createTile wrapped, forced a redraw");
      }
    }catch(e){ say("wrap failed: " + e.name + " " + e.message); }
  }, 11000);
  /* THE DECODE TEST (2026-08-09). The library reads tile 8/42/97 and resolves with ZERO layers
     while the bytes arrive intact. This does the two steps by hand to find which one loses them.
     The byte range is not guessed — it came off Peter's own device log
     (`bytes=262781879-262857582`) and matches the 75,704-byte tile decoded server-side, so it is
     provably the right tile.
     Answers one question: does gunzip fail, or does gunzip work and the MVT parse find nothing?
     Gunzip fails  -> a decompression-path bug, and 5.x may fix it: the upgrade is worth a day.
     Gunzip works  -> the bug is in the MVT decoder, 5.x is a coin-flip, and a paid raster
                      provider is the honest answer. */
  setTimeout(() => {
    say("--- decode test: 8/42/97 by hand ---");
    fetch(PM_URL, {headers:{Range:"bytes=262781879-262857582"}})
      .then(r => r.arrayBuffer())
      .then(async buf => {
        const u8 = new Uint8Array(buf);
        say("fetched: " + buf.byteLength + " bytes (server says 75704)");
        say("first 3: " + [...u8.slice(0,3)].map(b=>("0"+b.toString(16)).slice(-2)).join(" ")
            + (u8[0]===0x1f && u8[1]===0x8b ? "  = gzip magic" : "  = NOT gzip"));
        let plain;
        try{
          const ds = new DecompressionStream("gzip");
          plain = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer());
          say("GUNZIP OK: " + plain.length + " bytes out");
        }catch(e){ say("GUNZIP FAILED: " + e.name + " " + e.message + "  => decompression path"); return; }
        /* Minimal MVT scan: Tile.layers is field 3 (wire type 2); inside a layer, name is field 1.
           Enough to answer "is there anything in here", which is the whole question. */
        try{
          const vi = (b,i) => { let r=0,sh=0; for(;;){ const x=b[i++]; r|=(x&0x7f)<<sh; if(!(x&0x80)) return [r,i]; sh+=7; } };
          const names = []; let i = 0;
          while(i < plain.length){
            let k; [k,i] = vi(plain,i); const f = k>>3, wt = k&7;
            if(wt === 2){ let ln; [ln,i] = vi(plain,i);
              if(f === 3){ const L = plain.subarray(i, i+ln); let j = 0;
                while(j < L.length){ let k2; [k2,j] = vi(L,j); const f2 = k2>>3, w2 = k2&7;
                  if(w2 === 2){ let l2; [l2,j] = vi(L,j);
                    if(f2 === 1) names.push(new TextDecoder().decode(L.subarray(j,j+l2)));
                    j += l2; }
                  else if(w2 === 0){ [,j] = vi(L,j); } else break; } }
              i += ln; }
            else if(wt === 0){ [,i] = vi(plain,i); }
            else break;
          }
          say("MVT layers found by hand: " + (names.join(",") || "(NONE)"));
          say(names.length
            ? "=> BYTES AND PARSE ARE FINE. The library loses it => library bug, 5.x is a coin-flip."
            : "=> the tile really does parse empty here => decode path, 5.x worth trying.");
        }catch(e){ say("hand-parse threw: " + e.name + " " + e.message); }
      })
      .catch(e => say("decode test fetch FAILED: " + e.name + " " + e.message));
  }, 12000);
  setTimeout(() => {
    say("--- at 15s ---");
    say("ttbMapStyle: " + typeof window.ttbMapStyle);
    say("layers: base=" + (!!tileLayer) + " detail=" + (!!pmDetail));
    say("archive requests: " + performance.getEntriesByType("resource").filter(r=>/pmtiles/.test(r.name)).length);
    const st = [...document.querySelectorAll("script[src]")].map(x=>x.src.split("/").pop());
    say("scripts on page: " + st.join(" "));
  }, 15000);
}
let PM_URL = "/maps/world-z7.pmtiles.bin";
let PM_MAXZ = 7;   /* z7 (178 MB), not z8 (525 MB), and the reason is Cloudflare rather than
   detail: it will not cache a file over 512 MB, so world-z8 answered cf-cache-status BYPASS
   forever and EVERY byte came off the VPS. Measured after the rebuild: z7 goes MISS then HIT, z8
   stays BYPASS. That also makes it the prime suspect for D-163's blank map on iOS — every failing
   request in Peter's logs targeted world-z8, none ever reached the edge-cached trip archive, and
   the library was re-fetching the whole archive with no Range header in a retry loop, which is
   what it does when it decides ranges are unsupported. One zoom level of WORLD detail is the
   price; per-trip archives still carry z13 along the route. */                       // the world build's ceiling; a per-trip archive is cut at 13
let PM_TRIP = null, pmDetail = null;   // this trip's own archive, painted OVER the world one
/* Injected rather than written with document.write — the
   closing-tag string that approach needs would END THIS SCRIPT ELEMENT. That is an HTML
   parsing rule, not a checker quirk: the sequence terminates a script even inside a comment or
   a string literal, so writing it here would have killed the page. check-inline-js.sh caught it,
   which is the third time that guard has earned its place.
   Under the flag only: 128KB of vector renderer has no business reaching visits that use the
   raster basemap. */
if(PM_FLAG){
  const s = document.createElement("script");
  s.src = "/vendor/protomaps-leaflet-4.1.1/protomaps-leaflet.js?v=1";
  /* The style module loads AFTER the renderer, because ttbMapStyle.options() calls
     protomapsL.paintRules() — chained rather than parallel, since a race here would silently
     fall back to the library's default grey theme and look like a styling bug. */
  s.onload = () => {
    const st = document.createElement("script");
    st.src = "/mapstyle.js?v=12";
    st.onload = () => { try{ applyTheme(); }catch(e){} };
    st.onerror = () => { try{ applyTheme(); }catch(e){} };   // unstyled beats blank
    document.head.appendChild(st);
  };
  document.head.appendChild(s);
}

/* THE RASTER TILE CACHE IS GONE WITH THE RASTER TILES (D-162). cachedTileLayer, the CORS probe
   and tiles.js all existed to copy CARTO's PNGs into IndexedDB so a trip survived losing signal.
   There are no PNGs now: the basemap is one PMTiles archive read by HTTP range, which the
   browser caches itself (immutable, one year — see .htaccess).
   THAT IS A WEAKER OFFLINE STORY THAN THE ONE IT REPLACES, and D-162 says so rather than leaving
   it to be discovered. The follow-up beats both: one file, the whole route, downloadable on
   wifi. Whoever builds it should read tiles.js in git history first — its eviction, quota and
   CORS-taint notes were each bought with real time. */
/* ── THE MAP, OFFLINE (D-162's follow-up) ──────────────────────────────────────────────────
 *
 * The raster tile cache died with the raster tiles, and this is the better thing it was always
 * going to be replaced by: not thousands of PNGs accumulated by looking at them, but ONE FILE —
 * this trip's own archive, the whole route, saved on purpose while you still have wifi.
 *
 * HOW IT WORKS, and it is deliberately not clever: PMTiles is nothing but HTTP Range, so a cached
 * archive is served by answering those ranges from a Blob instead of the network. `fetch` is
 * patched for exactly ONE url — the trip's archive — and every other request in the page is
 * passed through untouched. Verified before it was written: 9 range requests served from memory,
 * 0 escaped to the network, and the map drew.
 * The alternative was handing protomaps-leaflet a custom source, which its build does not allow:
 * `PmtilesSource` is exported but the PMTiles reader itself is not, so there is nothing to give
 * a source to.
 *
 * THE WORLD ARCHIVE IS NEVER CACHED. It is 525 MB. Only the per-trip archive (~25 MB) is, which
 * is also the only part that matters on the road — it is cut to the route. Off-route falls back
 * to the world layer, which needs the network, and that is the honest trade: the map you are
 * standing in works, the rest of the planet does not.
 *
 * Keyed by the archive URL, which is `HMAC(slug, TILES_SALT)` (D-157) — so a re-cut archive is a
 * NEW key and `archiveKeepOnly()` evicts the stale one rather than letting old routes pile up on
 * somebody's phone. */
const MAPDB = "ttb_maps", MAPSTORE = "archives";
let OFFLINE_ARCHIVE = null;              // {url, blob} once a saved copy is found or made
function mapDb(){
  return new Promise((res, rej) => {
    let r; try{ r = indexedDB.open(MAPDB, 1); }catch(e){ return rej(e); }
    r.onupgradeneeded = () => { try{ r.result.createObjectStore(MAPSTORE); }catch(e){} };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
/* RESOLVES WITH THE REQUEST'S RESULT, and the distinction bit immediately. The first version
   read `out.result !== undefined ? out.result : out`, so a MISSING key — result undefined —
   resolved with the IDBRequest itself, which is truthy. The offline row therefore reported
   "saved on this phone, NaN MB" before anything had been saved, and the next tap took the REMOVE
   branch. A cache that claims a hit it does not have is worse than no cache. */
function mapTx(mode, fn){
  return mapDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(MAPSTORE, mode), st = tx.objectStore(MAPSTORE);
    let req; try{ req = fn(st); }catch(e){ return rej(e); }
    if(req && typeof req === "object" && "onsuccess" in req){
      req.onsuccess = () => res(req.result);        // undefined when the key is not there
      req.onerror   = () => rej(req.error);
    }else{
      tx.oncomplete = () => res(undefined);         // a batch of deletes returns no single result
    }
    tx.onerror = () => rej(tx.error);
    tx.onabort  = () => rej(tx.error);
  }));
}
/* Only a real Blob counts as a hit. Anything else — undefined, a half-written record, a value
   from an older shape of this store — is treated as absent, which fails toward the network. */
async function archiveGet(url){
  try{
    const v = await mapTx("readonly", st => st.get(url));
    return (v && typeof v.size === "number" && v.size > 0 && typeof v.slice === "function") ? v : null;
  }catch(e){ return null; }
}
async function archivePut(url, blob){ return mapTx("readwrite", st => st.put(blob, url)); }
/* Anything that is not the current archive is a route this phone no longer needs. */
async function archiveKeepOnly(url){
  try{
    const keys = await mapTx("readonly", st => st.getAllKeys());
    const stale = (keys || []).filter(k => k !== url);
    if(stale.length) await mapTx("readwrite", st => { stale.forEach(k => st.delete(k)); });
    return stale.length;
  }catch(e){ return 0; }
}
/* ONE URL, EVERYTHING ELSE UNTOUCHED. Installed once, at parse time, so it is already in place
   before the renderer asks for anything — patching later would mean the header fetch had already
   gone to the network. A request with no Range header is passed through: the reader only ever
   asks for ranges, so anything else is somebody else's call and not ours to answer. */
(function installArchiveFetch(){
  if(!window.fetch || !window.Response) return;
  const real = window.fetch.bind(window);
  window.fetch = function(input, init){
    try{
      const u = typeof input === "string" ? input : (input && input.url) || "";
      if(OFFLINE_ARCHIVE && u && u.indexOf(OFFLINE_ARCHIVE.url) !== -1){
        const hdrs = (init && init.headers) || (typeof input === "object" && input && input.headers);
        let range = null;
        if(hdrs) range = hdrs.get ? hdrs.get("Range") : (hdrs.Range || hdrs.range || null);
        const m = range && /bytes=(\d+)-(\d*)/.exec(range);
        if(m){
          const blob = OFFLINE_ARCHIVE.blob, total = blob.size;
          const start = +m[1], end = m[2] ? Math.min(+m[2], total - 1) : total - 1;
          return blob.slice(start, end + 1).arrayBuffer().then(buf =>
            new Response(buf, { status: 206, headers: {
              "Content-Range": "bytes " + start + "-" + end + "/" + total,
              "Content-Length": String(end - start + 1) } }));
        }
      }
    }catch(e){ /* fall through to the network — a cache must never be able to break the map */ }
    return real(input, init);
  };
})();
/* Save it. Streamed rather than `.blob()` so the row can show progress on a 25 MB file over a
   motel connection, which is exactly when somebody is doing this. */
async function archiveSave(url, onProgress){
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok || !res.body) throw new Error("fetch failed");
  const total = +(res.headers.get("content-length") || 0);
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for(;;){
    const { done, value } = await reader.read();
    if(done) break;
    parts.push(value); got += value.length;
    if(onProgress) onProgress(got, total);
  }
  const blob = new Blob(parts, { type: "application/octet-stream" });
  await archivePut(url, blob);
  await archiveKeepOnly(url);
  OFFLINE_ARCHIVE = { url, blob };
  return blob.size;
}
async function archiveSize(url){
  try{ const r = await fetch(url, { method: "HEAD" }); return +(r.headers.get("content-length") || 0); }
  catch(e){ return 0; }
}

const savedTheme=localStorage.getItem("ttb_theme");
/* "auto" is written by theme.js on the content pages and the key is shared, so a saved
   "auto" must follow the system rather than fall through to light — which is what
   `savedTheme ? savedTheme==="dark" : …` did. */
let darkMode = savedTheme==="dark" ||
  (savedTheme!=="light" && matchMedia("(prefers-color-scheme: dark)").matches);
function applyTheme(){
  document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  /* Tell the browser what colour its OWN chrome should be. Safari's bars cannot be hidden from a
     web page — that needs standalone mode, which is Add to Home Screen and a D-017 call — but they
     do not have to be a white band bolted onto a night map. Set from JS, not a media-query <meta>,
     because this toggle is manual: someone on night drive at noon has a dark app while
     prefers-color-scheme still says light. */
  { let tc = document.querySelector('meta[name="theme-color"]');
    if(!tc){ tc = document.createElement("meta"); tc.name = "theme-color"; document.head.appendChild(tc); }
    tc.content = darkMode ? "#2A2F3A" : "#F5F6F4"; }
  document.getElementById("themeBtn").innerHTML = icon(darkMode ? "sun" : "moon", 18);
  if(tileLayer) map.removeLayer(tileLayer);
  if(pmDetail){ map.removeLayer(pmDetail); pmDetail = null; }   // D-087 applies to the second layer too
  /* THE BASEMAP: a SELF-HOSTED vector one instead of CARTO's raster tiles. `?raster=1` opts out.
     Why it exists: CARTO's own LICENSE.md limits basemaps.cartocdn.com to enterprise customers
     and non-profit grantees and says it is not for free public use, and this is a commercial
     product. Protomaps' daily build is an ODbL Produced Work — commercial use fine, OSM
     attribution required — and their docs ask you to copy it to your own storage rather than
     hotlink, which is what maps/ is.
     Three things fall out of it at once: the licence question goes away, the LAST third-party
     request in the product goes away (CLAUDE.md names map tiles as the only exception to
     "nothing we ship loads from anybody else"), and the ?tiles=1 corridor prefetch becomes
     unambiguously ours to run at any zoom.
     Prototype scope, honestly: the extract in maps/ covers Tahoe/Reno only, so a trip outside
     that box draws empty. Rebuilding it for anywhere else is one command — maps/README.md. */
  /* UNDER THE FLAG, WAIT — do not fall back to raster while the renderer downloads.
     The library is injected async, so applyTheme() runs once before it lands and once after. The
     first pass used to build the CARTO layer, which fetched real tiles from a real third party:
     measured on production, three cartocdn hosts in the resource list on a page whose entire
     purpose is proving none are contacted. An empty map for the half second the renderer takes is
     the honest behaviour; the onload below re-runs this and fills it. */
  if(PM_FLAG && !window.protomapsL) return;   // wait for the renderer rather than flashing raster
  if(PM_FLAG){
    /* WHY THE URL IS NOT PASSED AS A STRING — READ BEFORE "SIMPLIFYING" THIS (D-166).
       protomaps-leaflet picks its source class by FILE EXTENSION, in one line of the vendored build:
    
         new URL(n.url,"http://example.com").pathname.endsWith(".pmtiles") ? new PmtilesSource(...)
                                                                          : new ZxySource(...)
    
       Our archives are served as `.bin` because that is the only way Cloudflare caches them
       (§5.2 — caching is keyed on the extension, `.pmtiles` is not on the list). So the string form
       silently selected ZxySource: no `Range` header, no `{z}/{x}/{y}` substitution, just the SAME
       whole 178 MB URL fetched over and over. Measured on production: ten identical GETs in 5 ms,
       `Range: NONE`, `content-range: null`, and a map that painted its background colour and nothing
       else. It looked exactly like D-164 all over again and it is a different bug wearing the same
       clothes — that one was the edge refusing to cache, this one is the client refusing to range.
       Passing the PMTiles INSTANCE makes the extension irrelevant: sourceToViews takes the non-string
       branch and uses the object as-is. Measured after: 11 requests carrying a Range, and 109 distinct
       opaque colours on a canvas that had exactly one, fully transparent.
       Falls back to the string if the library's internals ever move — an ugly map beats no map. */
    function pmSrc(u){
      try{
        const s = new protomapsL.PmtilesSource(u, true);
        return (s && s.p && typeof s.p.getZxy === "function") ? s.p : u;
      }catch(e){ return u; }
    }
    /* Our own colours, not the library's default light/dark. See mapstyle.js for why every one
       of them is desaturated: the basemap is the paper and the route is the drawing. Falls back
       to the built-in theme if the style module failed to load — an ugly map beats no map. */
    const styled = window.ttbMapStyle ? ttbMapStyle.options(!!darkMode) : null;
    /* §2bv ?capwater=1: the WORLD layer only. Its water polygons stop painting above z9, where
       the overzoom artifact lives; the per-trip layer below keeps the uncapped rules, so the
       lake beside your stops still draws. Falls back to `styled` when the style module predates
       optionsWorld. */
    const worldStyled = (window.ttbMapStyle && ttbMapStyle.optionsWorld)
      ? ttbMapStyle.optionsWorld(!!darkMode) : styled;
    tileLayer = protomapsL.leafletLayer(Object.assign({
      url: pmSrc(PM_URL), maxDataZoom: PM_MAXZ,
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &middot; <a href="https://protomaps.com">Protomaps</a>'
    }, worldStyled || { theme: darkMode ? "dark" : "light" })).addTo(map);
    /* TWO LAYERS, WORLD UNDER TRIP. Added after the world layer, so it paints over it — Leaflet
       orders same-pane layers by insertion.
       WHAT MAKES THE TOP ONE TRANSPARENT WHERE IT HAS NOTHING: `backgroundColor` is dropped. The
       library fills the whole canvas with it before drawing, so leaving it in would paint an
       opaque sheet over the world layer at every zoom and in every place — the naive stack, which
       looks exactly like the single-layer bug it is meant to fix. Without it, a tile the archive
       does not contain draws nothing at all and the world layer below simply shows through.
       Inside the route's clusters the archive DOES carry `earth`, which is opaque, so the detail
       covers the world layer there — which is the point.
       ATTRIBUTION IS EXPLICITLY EMPTY, NOT OMITTED. Omitting it does not mean "no credit" —
       protomaps-leaflet supplies its OWN default, so the control read
       "© OpenStreetMap · Protomaps, Protomaps © OpenStreetMap": the same two credits twice, in
       two different word orders. The layer below already carries the real one, and §5.4 is
       clear that the credit must stay visible — this removes the DUPLICATE, not the attribution.
       Caught by counting the string rather than glancing at the corner. */
    if(PM_TRIP){
      /* 🔴 §2bv — ?tripwater=1. PROVED 2026-09-10: removing the PER-TRIP layer removes the false
         water entirely (Tahoe correct, every small lake correct, not one diagonal band), while the
         world layer alone renders clean. That overturns this investigation's earlier conclusion
         that the bands were the world layer — which came from a coverage map, not an experiment.
         The layer removal was verified by a layer INVENTORY at screenshot time, because the same
         run showed `map.removeLayer(tileLayer)` silently failing and two other attempts measuring
         nothing at all against cached tiles.
         WHY THE TRIP LAYER WOULD DIFFER: it is cut from build.protomaps.com (a current planet
         build) while the base is `world-z7.pmtiles.bin` — two archives from two sources, painted
         with ONE set of rules written for the second. The archive already has a documented THIRD
         encoding of water (`kind:'river'` with no `kind_detail`), so a rule that is right for the
         world archive can be wrong here.
         THIS FLAG IS THE NEXT EXPERIMENT, NOT A FIX: it drops the water rules from the per-trip
         layer only, at CREATION — runtime rule-swapping was tried and the layer served cached
         tiles straight through it, so the experiment has to be in the page. Streaks gone on a
         fresh load means the water rules are the family and the fix is schema-aware rules for
         this archive; streaks still there means it is a different family and more is eliminated.
         Either answer is worth one deploy. */
      let dRules = styled ? styled.paintRules : null;
      try{ if(dRules && window.TTB_TRIPWATER)
             dRules = dRules.filter(r => r.dataLayer !== "water"); }catch(e){}
      const detail = styled ? {paintRules: dRules, labelRules: styled.labelRules}
                            : { theme: darkMode ? "dark" : "light" };
      pmDetail = protomapsL.leafletLayer(Object.assign({
        url: pmSrc(PM_TRIP), maxDataZoom: 13, attribution: ""
      }, detail)).addTo(map);
    }
  }else{
    /* The raster basemap, restored. maxZoom 20 because CARTO renders through z20 — measured, and
       the reason that number survived the vector era as PM_MAXZ. */
    tileLayer = L.tileLayer(darkMode?TILE_DARK:TILE_LIGHT,
      {attribution:'&copy; OpenStreetMap &copy; CARTO', maxZoom:20}).addTo(map);
  }
  if(typeof drawMap==="function" && allStops.length) drawMap();
}
document.getElementById("themeBtn").onclick=()=>{ darkMode=!darkMode; localStorage.setItem("ttb_theme",darkMode?"dark":"light"); applyTheme(); };
(()=>{ const b=document.getElementById("menuBtn"), m=document.getElementById("menu");
  const set=on=>{ m.classList.toggle("show",on); b.setAttribute("aria-expanded",on?"true":"false"); };
  b.onclick=e=>{ e.stopPropagation(); set(!m.classList.contains("show")); };
  document.addEventListener("click",()=>set(false));
  document.addEventListener("keydown",e=>{ if(e.key==="Escape") set(false); }); })();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",e=>{
  if(!localStorage.getItem("ttb_theme")){ darkMode=e.matches; applyTheme(); }
});
let layerGroup = L.layerGroup().addTo(map);

/* ── state + rendering ─────────────────────────────────── */
/* One definition of "can be drawn". Leaflet throws "Invalid LatLng object" on anything else,
   and it threw from three different places before this existed — the marker loop, the route
   polyline, and the edge chips — each of which had to be found by poisoning a stop and reading
   the next stack trace. */
const placeableStop = s => !!s && isFinite(+s.lat) && isFinite(+s.lng)
                        && Math.abs(+s.lat)<=90 && Math.abs(+s.lng)<=180;
let allStops=[], allNotes=[], allPosts=[], tab="route", hidden={truck:false,rental:false}, fitted=false;
let replayT=null, replayTimer=null, replayBy="vehicle";
let REPLAY_FRESH=new Set();   // D-115: ids that arrive at the current frame   // replay grouping: "vehicle" | "person"
/* True when the CURRENT frame hands off to a different crew (?rcard=1). Read in three places
   that must agree — the sign, the camera and the dwell — so it is computed once in setReplay. */
let REPLAY_CUT=false, replayCardT=null;
let replayFollow=true, replayPanning=false, replayPanT=null;   // the map follows the reveal until you move it yourself
// stable-ish per-person colors: roster order first, else a name hash. Reads on light + dark tiles.
/* person1 was the RETIRED D-022 accent while person2 was already exactly vehicle 2's route
   blue — so switching the replay from by-vehicle to by-person moved entity 1's colour and
   not entity 2's. Matched to route/amber, which is what vehicle 1 draws with. */
const PERSON_PALETTE=["#F26A1B","#0A4DA2","#7B4FA3","#2E9E6B","#D2544B","#4B8B9E","#C9721C","#A24E86"];   /* D-197: first two follow the vehicles */
// everyone who has a stop (+ roster), in a stable order → guarantees distinct colors, no hash collisions
function personRoster(){
  const seen=[]; const push=n=>{ n=n||"—"; if(n!=="—" && !seen.includes(n)) seen.push(n); };
  MEMBERS.forEach(push);                                   // roster first (stable across scrubbing)
  [...new Set(allStops.map(s=>s.author||""))].filter(Boolean).sort().forEach(push);  // then any other authors, alpha
  return seen;
}
function personColor(name){
  if(!name || name==="—") return "#9A968C";                // "not assigned" → neutral gray
  const i=personRoster().indexOf(name);
  return PERSON_PALETTE[(i<0?0:i)%PERSON_PALETTE.length];
}
const listEl=document.getElementById("list");
const fmtDate = iso => {
  if(!iso) return "No date";
  const d=new Date(iso+"T12:00:00");
  return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
};
// sort by date (undated last), then manual seq — so undated stops keep the order you arrange them
/* Travel order — one definition, used by the rail, the map and replay so they can't disagree.
   Dates rule where they're set. An undated stop holds its seq position by inheriting the last
   dated stop before it *in its own track*, instead of sorting to the very end: an undated
   origin belongs in front of its dated destination, not behind it. Invisible in a flat list,
   but it inverts a leg chain and draws the map polyline backwards. */
function effDate(){
  const m=new Map(), byTrack={};
  allStops.forEach(s=>{ (byTrack[s.track]=byTrack[s.track]||[]).push(s); });
  for(const k in byTrack){
    const arr=byTrack[k].slice().sort((a,b)=>(a.seq||0)-(b.seq||0));
    let last="0000-00-00";
    arr.forEach(s=>{ if(s.date) last=s.date; m.set(s.id, s.date||last); });
  }
  return m;
}
const sorted = () => { const e=effDate(); return [...allStops].sort((a,b)=>{
  const d=(e.get(a.id)||"0000-00-00").localeCompare(e.get(b.id)||"0000-00-00");
  return d!==0 ? d : ((a.seq||0)-(b.seq||0));
}); };

/* ── the document header (#15) ────────────────────────────────────────────────────────
   Name, then where, then when, then how long it is kept. Everything but the name is DERIVED
   from pins we already have — nothing new is stored, and nothing new is fetched.

   The date maths is the part that has bitten this codebase three times (R2, D-089, D-092), so:
   a stop's `date` is a plain "YYYY-MM-DD" string with no time and no zone. `new Date("2026-09-04")`
   parses as UTC midnight, and formatting THAT in any negative-offset zone prints the 3rd. So the
   string is split by hand into Date.UTC and every format call names timeZone:"UTC". EXPIRES is
   different and is deliberately NOT treated this way: it is a real epoch instant, so local
   formatting is the correct answer for it, the same as the settings panel does. */
function docDate(ymd){ const [y,m,d]=String(ymd).split("-").map(Number);
  return (y&&m&&d) ? new Date(Date.UTC(y,m-1,d)) : null; }
/* Intl.formatRange, not hand-rolled branching. The first version of this built the string
   itself — "same month? then day, dash, full date" — and produced "4–Sep 7, 2026" in en-US,
   because the day-only part and the full part order differently. The test passed anyway: it
   asserted the month appeared once, which was true of a broken string. formatRange is built
   for exactly this and gets the elision right in every locale ("Sep 4 – 7, 2026",
   "4.–7. Sept. 2026"), including collapsing an identical pair to one date. */
function docSpan(dates){
  const ds=dates.filter(Boolean).slice().sort();
  if(!ds.length) return "";
  const a=docDate(ds[0]), b=docDate(ds[ds.length-1]);
  if(!a||!b) return "";
  const o={timeZone:"UTC",day:"numeric",month:"short",year:"numeric"};
  try{ const f=new Intl.DateTimeFormat(undefined,o);
       if(f.formatRange) return f.formatRange(a,b); }catch(e){}
  const F=dt=>dt.toLocaleDateString(undefined,o);          // pre-2021 browsers
  return ds[0]===ds[ds.length-1] ? F(a) : F(a)+" – "+F(b);
}
/* Returns HTML, not text, because each END of the route has to be atomic: left to wrap freely
   it broke as "Salt Lake City," / "UT", which reads as two places. The break belongs at the
   arrow. Escaping happens here since the caller can no longer do it. */
/* A stop's `place` is whatever the author typed, and the convention across this product is
   "PLACE — note": the live demo's first stop is "San Francisco — load up, coffee, go" and its
   last is "Reno airport — Jordan's later flight, 6p". Printed whole, the header ran to three
   lines of somebody's shorthand and pushed the tabs off a phone. Take the part before the
   dash, then clamp — the header names WHERE, the card says the rest. */
function docPlace(t){
  t=String(t||"").split(/\s+[—–-]\s+/)[0].trim();
  if(t.length<=26) return t;
  const cut=t.slice(0,26);
  const sp=cut.lastIndexOf(" ");
  return (sp>12 ? cut.slice(0,sp) : cut).replace(/[,\s]+$/,"") + "…";
}
/* Returns HTML, not text, because each END of the route has to be atomic: left to wrap freely
   it broke as "Salt Lake City," / "UT", which reads as two places. The break belongs at the
   arrow. Escaping happens here since the caller can no longer do it. */
/* The BUSIEST track's ends, not the sorted array's. `sorted()` interleaves vehicles, so its
   endpoints can splice two people's journeys into one claim that is true of neither — the
   exported zip read "Chicago O'Hare → Reno–Tahoe" for a trip that goes San Francisco → Reno.
   Found by downloading the file and reading it. */
function docRoute(ord){
  const byTrack=new Map();
  for(const s of ord){ if(!byTrack.has(s.track)) byTrack.set(s.track,[]); byTrack.get(s.track).push(s); }
  const lists=[...byTrack.values()].sort((a,b)=>b.length-a.length);
  /* Only when one track is STRICTLY bigger. Two equal vehicles are two journeys, and a tie
     broken by iteration order is not a decision — it picks one and states it as fact. */
  const main = lists.length===1 ? lists[0]
             : (lists.length>1 && lists[0].length>lists[1].length) ? lists[0] : null;
  if(!main) return "";
  const named=main.map(s=>docPlace(s.place)).filter(Boolean);
  if(!named.length) return "";
  const first=named[0], last=named[named.length-1];
  const nw=t=>'<span class="term">'+esc(t)+'</span>';
  return first===last ? nw(first) : nw(first) + " → " + nw(last);
}
function drawDocHead(){
  const nm=document.getElementById("docName"), mt=document.getElementById("docMeta");
  if(!nm||!mt) return;
  nm.textContent = (CONFIG.name||"").trim() || "This trip";
  const ord=sorted();
  const bits=[];
  const route=docRoute(ord);           if(route) bits.push(route);   // already escaped, see docRoute
  /* The dates are one atom. Left to wrap freely the line broke as "Sep 4 – 7," / "2026",
     which reads as two facts instead of one. The route is deliberately NOT nowrap — it is the
     long part, and forcing it would push the whole line off a narrow screen. */
  const span=docSpan(ord.map(s=>s.date)); if(span)  bits.push('<span class="term">'+esc(span)+'</span>');
  /* The term is status, not decoration: every tier ends (D-059) and the trip should say so
     without anyone opening a panel to find out. */
  if(EXPIRES) bits.push('<span class="term">kept until ' +
    esc(new Date(EXPIRES).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"})) + '</span>');
  mt.innerHTML = bits.join('<span class="sep">·</span>');
  mt.hidden = !bits.length;
}

/* `stops` DEFAULTS TO WHAT IS ALREADY LOADED, and that default is a bug fix (2026-09-27).
   The preview-as-viewer toggle calls `render()` bare to repaint the chrome — and the first
   thing this function did was `allStops = stops`, so a bare call wiped the entire stop list
   to `undefined`. Nothing failed at that moment; the next write to touch the list threw
   "undefined is not an object (evaluating 'allStops.forEach')" and the toast said
   "Not saved" — which is how Peter hit it trying to edit a date on the demo trip after
   toggling preview. The comment by that toggle already warned about this exact message
   arriving from `emitAll()`; the toggle then reintroduced it through the front door.
   `|| []` is the belt: allStops is a list or it is empty, never undefined. */
function render(stops = allStops){
  allStops = stops || [];
  if(document.activeElement && listEl.contains(document.activeElement)) return; // don't clobber mid-edit
  if(replayT!=null && !replayFrames().keys.includes(replayT)) closeReplay();  // timeline changed under us
  drawDocHead(); syncOpenPill(); drawMap(); drawList(); syncReplayBtn();
  if(!fitted && stops.length){ fitAll(); fitted=true; }
}
/* Fit to the trip, not to its widest outlier (audit F06).
   One crew member flying in from across the country used to stretch the bounds
   coast-to-coast and collapse the actual trip into a single overlapping cluster.
   We trim far-flung points with an interquartile fence before fitting: on an
   evenly spread trip the fence is wide and nothing is dropped, so a real
   cross-country drive still frames correctly. Zoom controls (pass 1) let anyone
   pull back out to the outliers. */
function clusterFit(pts){
  if(pts.length<4) return pts;
  const q=(arr,f)=>{ const a=arr.slice().sort((x,y)=>x-y); const i=(a.length-1)*f, lo=Math.floor(i), hi=Math.ceil(i);
    return a[lo]+(a[hi]-a[lo])*(i-lo); };
  // 3x IQR = the "extreme outlier" fence. 1.5x is the textbook mild fence and it
  // clipped legitimate stops at the end of a route; we only want to drop the
  // genuinely far-flung point (a crew member's flight origin), nothing else.
  const fence=vals=>{ const q1=q(vals,.25), q3=q(vals,.75), iqr=q3-q1;
    return iqr===0 ? null : [q1-3*iqr, q3+3*iqr]; };
  const fLat=fence(pts.map(p=>p[0])), fLng=fence(pts.map(p=>p[1]));
  if(!fLat||!fLng) return pts;
  const kept=pts.filter(p=>p[0]>=fLat[0]&&p[0]<=fLat[1]&&p[1]>=fLng[0]&&p[1]<=fLng[1]);
  // never trim the map down to almost nothing — if most points are "outliers", they're the trip
  return (kept.length>=2 && kept.length>=Math.ceil(pts.length*0.6)) ? kept : pts;
}
/* fitBounds does not fire dragstart, so a drag is unambiguously the person. zoomstart does
   fire for our own animation, hence the flag. */
map.on("dragstart", ()=>{ if(!replayPanning) replayFollow=false; });
map.on("zoomstart", ()=>{ if(!replayPanning) replayFollow=false; });
/* F-3: a stop outside the view left its leg running off the screen to nowhere. Measured at
   375x812 on the demo: five of twenty markers off-viewport with no indication where they went.

   Fitting everything would undo clusterFit above, which exists on purpose — its comment records
   that the textbook 1.5x IQR fence clipped legitimate stops, so it uses 3x to drop only the
   genuinely far-flung point, like a crew member's flight origin. Zooming out to include that
   point is exactly what it was written to prevent.

   So the leg gets an edge label instead: pinned at the boundary, in the direction it went,
   naming where it goes. Capped at three and deduped by place — the point is orientation, not a
   second index of the trip. */
let edgeGroup = L.layerGroup().addTo(map);
function drawEdgeChips(){
  edgeGroup.clearLayers();
  if(!allStops.length) return;
  /* SIZE COMES FROM THE DOM, NOT FROM LEAFLET. `map.getSize()` returns a memoised `_size` that
     is only refreshed by invalidateSize() or a resize Leaflet happens to notice — and measured
     2026-08-03 it said 1280x720 while the container was really 800 wide. Every chip was then
     clamped to `1280 - 30 = 1250`: pinned to the edge of a viewport that no longer existed, 450px
     off the real one. That is the whole "chips land on markers" bug — they were never being
     placed against the frame the person is looking at.
     A phone hits this on rotation, and whenever Safari's toolbar collapses or expands.
     The rect cannot go stale; invalidateSize() would also fix it but fires moveend, and moveend
     calls this function. */
  const _cr = map.getContainer().getBoundingClientRect();
  const _ls = map.getSize();
  /* Prefer the live rect, fall back to Leaflet's cache when the rect is DEGENERATE. A hidden or
     backgrounded container measures 0x0 — found immediately after the first version of this fix,
     which then clamped every chip to x=-30. Leaflet's cache is stale but never zero, so between
     them one is always usable: rect when it is real, cache when the container is not being
     rendered. Neither alone is enough, which is the whole lesson. */
  const size = (_cr.width > 1 && _cr.height > 1)
    ? {x: Math.round(_cr.width), y: Math.round(_cr.height)}
    : _ls;
  if (size.x < 2 || size.y < 2) return;   // nothing is on screen; there is nothing to pin to
  const b = map.getBounds(), m = 30, seen = new Set(), out = [];
  const CHIP_ANCHOR = 8, CHIP_H = 21, CHIP_W = 120;   // W is a guess: a chip is measured after
                                                     // it exists, and this runs before
  /* Marker boxes in CONTAINER coordinates, same space as the clamp. drawMap adds its markers
     synchronously and this runs from a setTimeout after it, so they are on the page by now —
     verified 2026-08-03 by instrumenting the call: ten markers visible. */
  const _mo = map.getContainer().getBoundingClientRect();
  const placed = [...map.getContainer().querySelectorAll(".leaflet-marker-icon")]
    .filter(el => !el.className.toString().includes("edgewrap"))
    .map(el => { const r = el.getBoundingClientRect();
                 return {x: r.x - _mo.x, y: r.y - _mo.y, w: r.width, h: r.height}; });    // must match iconAnchor below and .edgechip height
                                        // — both dropped when the chip shrank, or the top and
                                        // bottom insets clamp against a box that no longer exists's height
  /* MEASURE the chrome, do not guess at it. A flat 30px inset put the top chips UNDER the
     topbar, and on a 320px phone the pieces of one showing through the gaps between the
     "View only" pill, the theme button and the menu button read as garbled text — found from
     a photo of a real handset, 2026-08-02. Same mistake F-1/F-2 fixed on the builder's fit:
     a number that was a guess at chrome height, right up until the chrome changed.
     Bottom too: the sheet can be dragged up over a chip pinned to the bottom edge. */
  const mapTop = map.getContainer().getBoundingClientRect().top;
  const tb = document.getElementById("topbar");
  const sh = document.getElementById("sheet");
  /* The clamp positions the ANCHOR, and the chip's box does not sit on it: iconAnchor is
     [0, CHIP_ANCHOR], so the box runs from anchorY-CHIP_ANCHOR to anchorY+(CHIP_H-CHIP_ANCHOR).
     Clamping the anchor alone left a chip 2px under the topbar and another 8px under the sheet —
     measured after the first fix, which is why it is worth measuring the fix and not just the
     bug. Both constants have to match the divIcon below and .edgechip's height in CSS. */
  const topIn = Math.max(m, tb ? Math.round(tb.getBoundingClientRect().bottom - mapTop) + 8 + CHIP_ANCHOR : m);
  /* Whatever is actually sitting at the bottom — the sheet when it is open, the pill when it is
     not. Measured after the sheet went on-demand: with the sheet off-screen the inset collapsed
     to 30px and two chips landed on the pill. Take the higher edge of the two. */
  const pill = document.getElementById("openSheet");
  const bottomEdge = Math.min(
    sh   ? sh.getBoundingClientRect().top   : Infinity,
    /* NOT offsetParent — it is ALWAYS null on a position:fixed element, so this test could never
       be true and the pill was never once taken into account. That is why a chip still sat
       behind it on a real phone after the "fix". Ask about display instead. */
    (pill && getComputedStyle(pill).display !== "none") ? pill.getBoundingClientRect().top : Infinity);
  const botIn = Math.max(m, isFinite(bottomEdge)
    ? Math.round(size.y - (bottomEdge - mapTop)) + 8 + (CHIP_H - CHIP_ANCHOR) : m);
  for(const s of allStops){
    if(!placeableStop(s)) continue;      // an edge chip for a stop with no place is not a thing
    if(hidden[s.track]) continue;
    if(b.contains([s.lat, s.lng])) continue;
    const name = (s.place || "").trim();
    const key = name.toLowerCase();
    if(!name || seen.has(key)) continue;
    seen.add(key); out.push(s);
  }
  /* Three chips clamped to the same corner rendered at 0px apart — measured, two of them
     perfectly stacked and unreadable. They are pinned to an EDGE, so there is nothing to
     preserve by keeping them coincident: step each one along the edge it is on. */
  const used = [];
  for(const s of out.slice(0, 3)){
    /* `label`, NOT `name`. The first loop's `const name` is block-scoped to that loop, so the
       identifier here resolved to `window.name` — a built-in that is "" — and every chip
       rendered with an empty span and no error. Measured, not noticed. */
    /* docPlace(), the same clamp the document header uses: these carried whole titles —
       "SACRAMENTO — IN-N-OUT + GAS", "SAN FRANCISCO — LOAD UP, CO…" — three at a time, in
       pills wider than half the screen. A chip's job is to name where a line goes. */
    const label = docPlace(s.place);
    const p = map.latLngToContainerPoint([s.lat, s.lng]);
    const cx = Math.min(Math.max(p.x, m), size.x - m);
    const maxY = Math.max(topIn, size.y - botIn);
    let cy = Math.min(Math.max(p.y, topIn), maxY);
    /* Step past anything already placed within a chip's height on the same side — and step
       AWAY from whichever limit we are sitting on. The first version always stepped down and
       then re-clamped to maxY, which put it straight back where it started: three chips
       clamped to the bottom edge still measured 0px apart. Down, unless down is full. */
    const side = cx > size.x / 2, step = CHIP_H + 4;
    const clash = y => used.some(u => u.side === side && Math.abs(u.cy - y) < step);
    /* Pick ONE direction and keep going. Deciding per step oscillated: a third chip pinned to
       the bottom stepped up into the second, then back down into the first, then out of guard
       — measured, three chips and two of them still at 0px. Away from the limit we are on. */
    const dir = cy >= maxY - 1 ? -1 : 1;
    for (let k = 0; k < 4 && clash(cy); k++)
      cy = Math.min(maxY, Math.max(topIn, cy + dir * step));
    used.push({ side, cy });
    const at = map.containerPointToLatLng([cx, cy]);
    /* Anchor away from the edge it is pinned to, or a chip on the right runs off the frame it
       is meant to be labelling — measured at x=345 on a 375px screen. */
    /* Now that `size` is the frame the person is actually looking at, keep off the markers too.
       This was tried once and appeared to do nothing — because it was stepping chips around a
       1280-wide space while the map was 800, so every computed collision was against geometry
       that did not exist. Fix the coordinate system first; the avoidance is ten lines.
       A right-half chip is drawn with translateX(-100%), so its box runs LEFT of the anchor. */
    const onRight = cx > size.x / 2;
    const hits = (px, py) => {
      const x0 = onRight ? px - CHIP_W : px;
      return placed.some(o => x0 + CHIP_W > o.x && x0 < o.x + o.w &&
                              py + (CHIP_H - CHIP_ANCHOR) > o.y && py - CHIP_ANCHOR < o.y + o.h);
    };
    const away = cy < size.y / 2 ? 1 : -1;        // step away from the edge it is pinned to
    for (let k = 0; k < 4 && hits(cx, cy); k++) cy += away * (CHIP_H + 8);
    cy = Math.min(Math.max(cy, topIn), Math.max(topIn, size.y - botIn));

    const rightHalf = onRight;
    L.marker(at, {interactive:false, zIndexOffset:600, icon: L.divIcon({
      className: rightHalf ? "edgewrap right" : "edgewrap",
      html:`<div class="edgechip">${icon(s.mode === "fly" ? "fly" : (s.mode || "drive"), 12)}<span>${esc(label)}</span></div>`,
      iconSize:[null,null], iconAnchor:[0,CHIP_ANCHOR]})}).addTo(edgeGroup);
  }
}
map.on("moveend zoomend", drawEdgeChips);
/* THE FAN IS A PIXEL OFFSET STORED AS A LATLNG, so it is only correct at the zoom it was
   computed at. drawMap ran on sync and on edits but never on zoom, so two pins sharing a
   coordinate drifted back together as you zoomed — measured 13px apart on 30px pins, which is
   more than half-covered, and worse further out. Redrawing here costs no more than the ten
   second poll already does, and it is the only way the offset stays what it claims to be. */
map.on("zoomend", () => { if (allStops.length || allPosts.length) drawMap(); });

function fitAll(animate){
  const pts=clusterFit(allStops.filter(s=>!hidden[s.track]).map(s=>[s.lat,s.lng]));
  if(!pts.length) return;
  // defer a frame so layout is settled — the map inits behind the gate, and an early
  // fitBounds measures a stale container size and maxes out the zoom
  requestAnimationFrame(()=>{
    map.invalidateSize();
    map.fitBounds(pts,{padding:[40,40],paddingBottomRight:[40,160],animate:!!animate,duration:0.9});
  });
}

/* ── road routing: driving legs follow real roads (OSRM), flights stay arcs ──
   Coords go to the public OSM routing server to compute the path; results are
   cached per run (memory + localStorage). Straight-line fallback on any failure. */
const ROAD_ROUTING = true;
const routeCache = new Map();          // sig -> [[lat,lng],...] | null (failed)
const routePending = new Set();
const runSig = pts => pts.map(p=>p[0].toFixed(4)+","+p[1].toFixed(4)).join(";");

function cachedRoute(sig){
  if(routeCache.has(sig)) return routeCache.get(sig);
  try{ const s=localStorage.getItem("ttb_route_"+sig);
    if(s){ const v=JSON.parse(s);
      /* An ARRAY here is a v1 entry: the old 22-points-per-470-miles geometry. It is stale by
         definition, so drop it and refetch rather than drawing the thing we just fixed. */
      if(Array.isArray(v)){ localStorage.removeItem("ttb_route_"+sig); return undefined; }
      const geo = v===null ? null : decodePoly(v);
      routeCache.set(sig,geo); return geo; } }catch(e){}
  return undefined;
}
let redrawTimer=null;
function scheduleRedraw(){ clearTimeout(redrawTimer);
  redrawTimer=setTimeout(()=>{ if(!(document.activeElement && listEl.contains(document.activeElement))) drawMap(); }, 150); }
async function fetchRoute(pts, sig){
  if(routePending.has(sig)) return; routePending.add(sig);
  try{
    /* lat,lng — NOT flipped. The comment below was right and the line above it was wrong for
       weeks: `pts` are Leaflet pairs, [lat,lng], and this built "lng,lat" because that is what
       OSRM wants and OSRM is what the browser used to call directly. Item 14 put our own
       endpoint in front, and ours takes lat,lng; new.html was updated, this file was not.
       rt_route() range-checks latitude, so every request arrived with lat=-122, failed the
       check and returned null — and null is indistinguishable from "no road exists", so the
       map drew its dashed straight-line fallback and looked merely unfinished rather than
       broken. Road routing has never once worked in the trip view. */
    const coords=pts.map(p=>p[0]+","+p[1]).join(";");
    const r=await fetch("/api/route?c="+encodeURIComponent(coords));
    const d=await r.json();
    const enc=(d && typeof d.poly==="string" && d.poly) ? d.poly : null;
    const geo=enc ? decodePoly(enc) : null;
    routeCache.set(sig,geo);
    /* The ENCODED string is what gets stored — 16 KB against 120 KB, which is the difference
       between ~300 cached legs and ~40 before the quota bites. Decoding is cheap and happens
       once per run into routeCache. */
    try{ localStorage.setItem("ttb_route_"+sig, JSON.stringify(enc)); }catch(e){}
  }catch(e){
    /* A NETWORK FAILURE IS NOT AN ANSWER AND MUST NOT BE CACHED AS ONE (§2bm).
       This used to `routeCache.set(sig, null)` on any throw, and null is what the caller reads as
       "asked, and there is no road" — `geo === undefined` is the only condition that retries. So
       one leg drawn with no signal stayed a dashed straight line for the REST OF THE SESSION,
       including after the bars came back, and it looked merely unfinished rather than stuck.
       That is the same failure shape as the comment above: a fallback that is indistinguishable
       from a finished answer. Leave the key absent and the next redraw asks again. */
    if(navigator.onLine) routeCache.set(sig,null);
  }
  routePending.delete(sig); scheduleRedraw();
}
function drawRoadRun(pts, color){        // color: resolved line color (vehicle track OR person)
  /* IN REPLAY, ROUTE LEG BY LEG. The cache is keyed on the whole run's signature, and replay
     reveals one stop at a time — so every frame produced a run that had never been requested,
     refetched from scratch, and showed the dashed straight-line fallback until it landed.
     Peter, watching it: "showed an unrouted polyline first, then routed."
     Split into consecutive pairs and each leg caches independently. openReplay() opens on the
     fully-revealed frame, so raising the scrubber warms every pair up front — by the time Play
     is pressed each step is a cache hit and the road is simply there. */
  if(replayT!=null && pts.length>2){
    for(let i=1;i<pts.length;i++) drawRoadRun([pts[i-1],pts[i]], color);
    return;
  }
  const sig=runSig(pts);
  const geo = ROAD_ROUTING ? cachedRoute(sig) : null;
  if(geo && geo.length){
    L.polyline(geo,{color,weight:4,opacity:.85,lineCap:"round",lineJoin:"round"}).addTo(layerGroup);
    wayArrows(geo, color);
  }else{
    L.polyline(pts,{color,weight:4,opacity:.65,dashArray:"1 9",lineCap:"round"}).addTo(layerGroup); // straight while loading / fallback
    if(ROAD_ROUTING && geo===undefined) fetchRoute(pts, sig);
  }
}
/* WARM EVERY DRIVE LEG BEFORE PLAYBACK STARTS — and this is repairing my own regression.
   drawRoadRun's note says openReplay "warms every pair up front" because it drew the fully
   revealed map on the way in. Round four's openReplay(quiet) deliberately stopped drawing that
   frame — correct for the camera, and it silently took the warm-up with it. So a one-tap cold
   start met an empty cache on every leg: dashed straight line first, real road a beat later.
   Peter, watching exactly that: "flashed the straight polyline before it routed."

   Asking for the routes explicitly is better than relying on a draw's side effect, which is what
   made this breakable in the first place. Idempotent — `cachedRoute()` undefined means only
   "never asked", and `fetchRoute` de-dupes in flight through `routePending`. */
function warmReplayRoutes(){
  if(!ROAD_ROUTING) return;
  const byTrack={};
  sorted().filter(placeableStop).forEach(s=>{ (byTrack[s.track]=byTrack[s.track]||[]).push(s); });
  for(const k in byTrack){
    const arr=byTrack[k];
    for(let i=1;i<arr.length;i++){
      /* Every mode that DRAWS a road must be warmed here, or it flashes the dashed chord on its
         first replay frame and then snaps — the §2c round-seven bug, which cost a round to find.
         A flight, ferry, boat or rail leg still has no road to fetch. */
      if(!followsRoads(arr[i].mode)) continue;
      const pair=[[+arr[i-1].lat,+arr[i-1].lng],[+arr[i].lat,+arr[i].lng]];
      const sig=runSig(pair);
      if(cachedRoute(sig)===undefined) fetchRoute(pair, sig);
    }
  }
}
/* The road for one leg, if it is already known. Returns undefined when it has never been asked
   for and null when there is no road — the caller wants "can I frame the real thing yet". */
function legRoad(prev, cur){
  // followsRoads, not =="drive": the replay camera frames the real geometry for a bike leg too,
  // and framing the chord while drawing the road is what §2c round seven fixed for drives.
  if(!ROAD_ROUTING || !followsRoads(cur.mode)) return null;
  try{ return cachedRoute(runSig([[+prev.lat,+prev.lng],[+cur.lat,+cur.lng]])) || null; }
  catch(e){ return null; }
}
function drawFlightArc(A, B, color){
  const pts=arcPoints(A,B);
  L.polyline(pts,{color,weight:2.5,opacity:.85,dashArray:"2 6"}).addTo(layerGroup);
  const mid=pts[Math.floor(pts.length/2)];
  const rot=Math.atan2(B[1]-A[1],B[0]-A[0])*180/Math.PI;
  L.marker(mid,{interactive:false,icon:L.divIcon({className:"",
    html:`<div class="pin-fly" style="color:${color};transform:rotate(${Math.round(45-rot)}deg)">${icon("fly",20)}</div>`,
    iconSize:[26,26],iconAnchor:[13,13]})}).addTo(layerGroup);
}
/* Flat inline-SVG icons — emoji rendered differently on every device, couldn't take
   the brand colour and read visually louder than everything around them (audit F20).
   Inline keeps the no-build-step rule and costs no extra request; currentColor means
   they inherit whatever they sit on. */
const ICON_PATHS={
  back:'<path d="M20 12H5M10.5 6.5 4 12l6.5 5.5"/>',
  collapse:'<path d="M9.2 4v5.2H4M14.8 20v-5.2H20M14.8 4v5.2H20M9.2 20v-5.2H4"/>',
  /* Added 2026-08-05 to retire the character-glyphs the UI leaned on. Emoji and dingbats
     render differently on every platform and are the strongest dated signal in an interface.
     Same spec as the originals: 24x24, no fill, stroke currentColor 1.85, round caps. */
  play:'<path d="M8 4.8 19 12 8 19.2z"/>',
  pause:'<path d="M9.2 5v14M14.8 5v14"/>',
  alert:'<path d="M12 3.2 21.6 20H2.4z"/><path d="M12 9.6v4.2M12 17.1v.01"/>',
  spark:'<path d="M12 3.2 13.9 9 19.7 10.9 13.9 12.8 12 18.6 10.1 12.8 4.3 10.9 10.1 9z"/><path d="M18.6 3.4v2.8M17.2 4.8H20"/>',
  up:'<path d="M5.5 15 12 8.5 18.5 15"/>',
  down:'<path d="M5.5 9 12 15.5 18.5 9"/>',
  upload:'<path d="M12 15.6V3.8M7.9 7.9 12 3.8l4.1 4.1"/><path d="M4 15.4v3.1a1.7 1.7 0 0 0 1.7 1.7h12.6a1.7 1.7 0 0 0 1.7-1.7v-3.1"/>',
  download:'<path d="M12 3.8v11.8M7.9 11.5 12 15.6l4.1-4.1"/><path d="M4 15.4v3.1a1.7 1.7 0 0 0 1.7 1.7h12.6a1.7 1.7 0 0 0 1.7-1.7v-3.1"/>',
  expand:'<path d="M4 9.2V4h5.2M20 14.8V20h-5.2M20 9.2V4h-5.2M4 14.8V20h5.2"/>',
  locate:'<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.6v2.8M12 19.6v2.8M1.6 12h2.8M19.6 12h2.8"/>',
  undo:'<path d="M4.4 9.2h11a5.2 5.2 0 0 1 0 10.4H9.6"/><path d="M8.4 5.2 4.4 9.2l4 4"/>',
  print:'<path d="M7 9.4V3.4h10v6"/><path d="M7 18.6H5.4a2 2 0 0 1-2-2v-4.8a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v4.8a2 2 0 0 1-2 2H17"/><path d="M7 14.6h10v6H7z"/>',
  search:'<circle cx="10.4" cy="10.4" r="6.4"/><path d="M15.2 15.2 20.6 20.6"/>',
  settings:'<path d="M3.6 6.4h8.2M16.4 6.4h4M3.6 12h3.2M11.4 12h9M3.6 17.6h9.8M18 17.6h2.4"/><circle cx="14.2" cy="6.4" r="2.2"/><circle cx="9.2" cy="12" r="2.2"/><circle cx="15.6" cy="17.6" r="2.2"/>',
  camera:'<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.4" r="3.6"/><path d="M8.6 7l1.5-2.6h3.8L15.4 7"/>',
  auto:'<circle cx="12" cy="12" r="8.6"/><path d="M12 3.4a8.6 8.6 0 0 1 0 17.2z" fill="currentColor" stroke="none"/>',
 arrow:'<path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5"/>',
  bike:'<circle cx="6" cy="17" r="3.3"/><circle cx="18" cy="17" r="3.3"/><path d="M6 17l4-8h5M9.5 9h4l3.5 8M14.5 6h2.5"/>',
  walk:'<circle cx="13" cy="4.2" r="1.8"/><path d="M11 21l2-6-2.5-2.5.8-4.3 3.2 2 2.5 1M9 12.5L7.5 16M12.5 15l2.5 6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  sheet:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
  bed:'<path d="M3 18.4v-7.8M3 14.2h18v4.2M21 18.4v-4.2a3 3 0 0 0-3-3h-7.4v3"/><circle cx="7" cy="10.4" r="2.1"/>',
  drive:'<path d="M3 16.5v-3l1.8-4.6A2 2 0 0 1 6.7 7.6h10.6a2 2 0 0 1 1.9 1.3L21 13.5v3z"/><circle cx="7.2" cy="16.6" r="1.5"/><circle cx="16.8" cy="16.6" r="1.5"/>',
  fly:'<path d="M21 3 3 10.6l7.1 2.6 2.6 7.1z"/><path d="M21 3 10.6 13.4"/>',
  train:'<rect x="6" y="3.2" width="12" height="12.6" rx="2.4"/><path d="M6 10.2h12"/><circle cx="9.2" cy="13" r=".9"/><circle cx="14.8" cy="13" r=".9"/><path d="M9 18.4 7 21M15 18.4 17 21"/>',
  ferry:'<path d="M5.2 14.6V9.4h13.6l-2.2 5.2"/><path d="M9 9.4V6.2h6v3.2"/><path d="M2.8 18.2c1.6 1.1 3.2 1.1 4.8 0s3.2-1.1 4.8 0 3.2 1.1 4.8 0 3.2-1.1 4.8 0"/>',
  water:'<path d="M12 3.2v11.4M12 14.6H5.6L12 3.2z"/><path d="M2.8 18.2c1.6 1.1 3.2 1.1 4.8 0s3.2-1.1 4.8 0 3.2 1.1 4.8 0 3.2-1.1 4.8 0"/>',
  pin:'<path d="M12 21s-6.6-5.3-6.6-10.4A6.6 6.6 0 0 1 18.6 10.6C18.6 15.7 12 21 12 21z"/><circle cx="12" cy="10.4" r="2.3"/>',
  pencil:'<path d="M15.3 4.6 19.4 8.7M4 20h4.1L19.4 8.7a1.7 1.7 0 0 0 0-2.4l-1.7-1.7a1.7 1.7 0 0 0-2.4 0L4 15.9z"/>',
  mail:'<rect x="3" y="5.4" width="18" height="13.2" rx="2.2"/><path d="m3.6 6.6 8.4 6 8.4-6"/>',
  flag:'<path d="M6 21V4.2M6 4.2h11.4l-2.2 3.9 2.2 3.9H6"/>',
  music:'<path d="M9 18V6.4l10-2v11.2"/><circle cx="6.6" cy="18" r="2.4"/><circle cx="16.6" cy="15.6" r="2.4"/>',
  star:'<path d="M12 3.4v17.2M3.4 12h17.2M6 6l12 12M18 6 6 18"/>',
  moon:'<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2z"/>',
  sun:'<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
  menu:'<path d="M3.6 7h16.8M3.6 12h16.8M3.6 17h16.8"/>',
  close:'<path d="M6 6l12 12M18 6 6 18"/>',
  person:'<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0"/>'
};
function icon(name,size){
  return '<svg class="ic" viewBox="0 0 24 24" width="'+(size||16)+'" height="'+(size||16)+'" fill="none" '+
    'stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
    (ICON_PATHS[name]||'')+'</svg>';
}
const MODE_LABEL={drive:"Drive",fly:"Fly",train:"Rail",ferry:"Ferry",water:"Boat",bike:"Bike",walk:"Walk"};
/* The print footer reads this attribute — set once so the printed page carries the address
   it came from. That footer IS the advertisement; a watermark would just make it unusable. */
try { document.body.setAttribute("data-print-url", TRIP_BASE.replace(/^https?:\/\//, "")); } catch(e){}
(function paintChrome(){
  { const pm = document.getElementById("photoMap"); if(pm) pm.innerHTML = icon("camera", 20); }
  const set=(id,n,sz)=>{ const el=document.getElementById(id); if(el) el.innerHTML=icon(n,sz||18); };
  set("menuBtn","menu"); set("editVeh","pencil",16); set("replayClose","close",16);
  const v=document.querySelector('#replayMode button[data-by="vehicle"]');
  const pr=document.querySelector('#replayMode button[data-by="person"]');
  if(v) v.innerHTML=icon("drive",16); if(pr) pr.innerHTML=icon("person",16);
  const se=document.getElementById("snEmail"); if(se) se.innerHTML=icon("mail",14)+" Email";
})();   // safe here: ICON_PATHS is initialised above

/* ── DIRECTION ON THE LINE ITSELF (§2bk) ───────────────────────────────────────────────────
   Taken from `go.remap.earth`, which draws chevrons along a route so you can see which way it
   runs without reading anything. We had colour and dash for the MODE (D-161) and nothing at all
   for direction: a leg chain relied on the numbered pins to say A-then-B, which means the map
   answers "which way" only if you stop and read it.

   THE ARITHMETIC IS THE WHOLE JOB, AND `cos(latitude)` IS THE PART THAT WOULD HAVE BEEN MISSED.
   Leaflet points are [lat, lng]; the SCREEN is x=lng, y=-lat. A degree of longitude is narrower
   than a degree of latitude everywhere but the equator, so a bearing taken from raw degrees tilts
   further wrong the further north you are — the same term `milesBetween()` already carries, and
   the same family as every real defect this repo has found. (`drawFlightArc` computes its plane's
   rotation without it. Left alone: it is approximately right where the demo trips are and I have
   not verified that icon's base orientation, so correcting it blind would be a guess dressed as a
   fix.)

   GOLD ON INK, NOT THE LEG'S OWN COLOUR, AND BOTH HALVES OF THAT WERE MEASURED. The first
   version filled the arrow with the line colour and outlined it in `var(--paper)`: on the night
   theme `--paper` IS dark, so the outline vanished, and a fill matching the line it sits on has
   nothing to stand against either. It was invisible in a screenshot at two zooms.
   Fixed literals for the same reason `#fab` uses them (D-125): these must not flip with the
   theme, because the basemap underneath is dark in one and light in the other and the arrow has
   to survive both. Gold on black is also the mark's own lane arrow — DESIGN.md §2b, a new
   surface joins the system by being a kind of sign.
   AND IT COSTS NOTHING TO DROP THE MODE COLOUR HERE: colour and dash already answer "what kind of
   leg" (D-159). The arrow answers "which way". One channel per question is that decision's own
   principle, and doubling up would have made the arrow worse at its only job.

   RESTRAINT IS THE POINT. Peter's standing note is that the app is "busy and visually
   overwhelming", so this is at most three marks per leg, 11px, and NEVER on a line that is
   already saying it is unfinished — the dashed straight-line fallback means "no road yet", and
   §2bm's rule is that offline and unresolved states must not be dressed up to look finished.
   `?noarrows=1` is the way back, the same shape as `?raster=1` and `?cards=1`. */
const WAY_ARROWS = !new URLSearchParams(location.search).has("noarrows");
function wayArrows(pts, color){
  if(!WAY_ARROWS || !Array.isArray(pts) || pts.length < 2) return;
  const n = pts.length;
  const want = Math.max(1, Math.min(3, Math.floor(n / 12) || 1));
  for(let k = 1; k <= want; k++){
    const i = Math.max(1, Math.min(n - 1, Math.round(n * k / (want + 1))));
    const a = pts[i - 1], b = pts[i];
    if(!a || !b) continue;
    const latR = ((+a[0] + +b[0]) / 2) * Math.PI / 180;
    const dx = (+b[1] - +a[1]) * Math.cos(latR);
    const dy = -(+b[0] - +a[0]);
    if(!dx && !dy) continue;                     // a duplicated point has no bearing to show
    const deg = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
    L.marker(b, {interactive:false, zIndexOffset:-50, icon: L.divIcon({className:"wayarrow",
      html:`<svg viewBox="0 0 12 12" width="12" height="12" style="transform:rotate(${deg}deg)">
        <path d="M1.5 1.5 L10.5 6 L1.5 10.5 Z" fill="#F7B304" stroke="#141414"
              stroke-width="1.5" stroke-linejoin="round"/></svg>`,
      iconSize:[12,12], iconAnchor:[6,6]})}).addTo(layerGroup);
  }
}

function drawLeg(mode, A, B, color){     // non-drive legs: fly=arc, others=straight line + glyph
  if(mode==="fly") return drawFlightArc(A,B,color);
  /* The UNRESOLVED chord. Under ?modecol=1 it still carries the mode's own signature, but the
     opacity drop is what says "this line is a guess" — the dash cannot say both things at once
     once the dash means the mode. The amber nudge under the mode chips is the real warning; this
     is only the map agreeing with it. */
  L.polyline([A,B],{color,weight:3.5,opacity:.62,
    dashArray:legDash(mode)||"5 7",lineCap:"round"}).addTo(layerGroup);
  wayArrows([A,B], color);
  const mid=[(A[0]+B[0])/2,(A[1]+B[1])/2];
  L.marker(mid,{interactive:false,icon:L.divIcon({className:"",
    html:`<div class="pin-fly">${icon(mode,20)}</div>`,iconSize:[24,24],iconAnchor:[12,12]})}).addTo(layerGroup);
}
function drawTracedLeg(A, path, B, mode, color){   // user-drawn boat/rail geometry (D-027): solid, through waypoints
  const line=[A, ...path.map(p=>[p[0],p[1]]), B];
  L.polyline(line,{color,weight:3.5,opacity:.9,dashArray:legDash(mode),
    lineCap:"round",lineJoin:"round"}).addTo(layerGroup);
  wayArrows(line, color);
  const mid=line[Math.floor(line.length/2)];
  L.marker(mid,{interactive:false,icon:L.divIcon({className:"",
    html:`<div class="pin-fly">${icon(mode,20)}</div>`,iconSize:[24,24],iconAnchor:[12,12]})}).addTo(layerGroup);
}

/* A BIKE OR WALKING LEG, DRAWN ON THE ROAD IT WOULD ACTUALLY TAKE. Same cache, same endpoint and
   same signature as drawRoadRun — a bike leg between two stops is the identical question to a
   drive leg between them, so it must not fetch its own copy of the answer. Two points only, so
   none of drawRoadRun's per-frame replay splitting applies.
   Drawn like a TRACED leg rather than like a drive: solid, 3.5px, with the mode glyph at the
   midpoint, so the map still says bike at a glance and only the SHAPE changed. The glyph rides
   the road's own midpoint, not the chord's, or it would float off the line on any real route.
   The fallback is the old behaviour exactly — a dashed chord while the fetch is in flight, and
   permanently if there is no road, which is the honest answer for a leg across water. */
function drawRoutedLeg(A, B, mode, color){
  const pts = [A, B], sig = runSig(pts);
  const geo = ROAD_ROUTING ? cachedRoute(sig) : null;
  if(geo && geo.length){
    L.polyline(geo,{color,weight:3.5,opacity:.9,dashArray:legDash(mode),
      lineCap:"round",lineJoin:"round"}).addTo(layerGroup);
    wayArrows(geo, color);
    const mid = geo[Math.floor(geo.length/2)];
    L.marker(mid,{interactive:false,icon:L.divIcon({className:"",
      html:`<div class="pin-fly">${icon(mode,20)}</div>`,iconSize:[24,24],iconAnchor:[12,12]})}).addTo(layerGroup);
    return;
  }
  drawLeg(mode, A, B, color);
  if(ROAD_ROUTING && geo===undefined) fetchRoute(pts, sig);
}

/* ── draw-a-path (D-027): trace boat/rail legs on the map ── */
let appDrawing=null, appDraft=[]; const drawGroup=L.layerGroup().addTo(map);
function prevInTrack(s){ const arr=sorted().filter(x=>x.track===s.track); const i=arr.findIndex(x=>x.id===s.id); return i>0?arr[i-1]:null; }
function startAppDraw(s){
  if(READONLY) return;
  if(s.lat==null){ alert("Give this stop a place on the map first."); return; }
  const prev=prevInTrack(s);
  if(!prev){ alert("The path is the leg between two stops — this needs a stop before it on the same vehicle."); return; }
  appDrawing=s; appDraft=Array.isArray(s.path)?s.path.slice():[];
  document.getElementById("drawbar").classList.add("on");
  try{ map.fitBounds(L.latLngBounds([[prev.lat,prev.lng],[s.lat,s.lng]]).pad(0.6)); }catch(e){}
  renderAppDraft();
}
/* The full chain the line follows: the previous stop, the draft waypoints, this stop.
   Only the middle is editable — the two ends are the leg's own stops. */
function draftChain(){
  const prev=prevInTrack(appDrawing); if(!prev) return null;
  return [[prev.lat,prev.lng], ...appDraft, [appDrawing.lat,appDrawing.lng]];
}
function renderAppDraft(){ drawGroup.clearLayers(); if(!appDrawing) return;
  const pts=draftChain(); if(!pts) return;
  L.polyline(pts,{color:"#035A83",weight:3,opacity:.9,dashArray:"6 6"}).addTo(drawGroup);
  // Waypoints are handles, not decoration: drag to move one, tap to delete it.
  appDraft.forEach((p,i)=>{
    const m=L.marker(p,{draggable:true,keyboard:false,zIndexOffset:800,
      icon:L.divIcon({className:"",html:'<div class="wpt"></div>',iconSize:[28,28],iconAnchor:[14,14]})}).addTo(drawGroup);
    m.on("drag",e=>{ const ll=e.target.getLatLng(); appDraft[i]=[ll.lat,ll.lng];
      const line=drawGroup.getLayers().find(l=>l instanceof L.Polyline);
      if(line) line.setLatLngs(draftChain()); });        // move the line with the finger, cheaply
    m.on("dragend",()=>renderAppDraft());
    m.on("click",e=>{ L.DomEvent.stop(e); appDraft.splice(i,1); renderAppDraft(); });
  });
}
function clearAppDraw(){ if(!appDrawing) return; appDraft=[]; renderAppDraft(); }
function cancelAppDraw(){ appDrawing=null; appDraft=[]; drawGroup.clearLayers(); document.getElementById("drawbar").classList.remove("on"); }
function finishAppDraw(){ if(!appDrawing) return; const s=appDrawing, path=appDraft.length>=1?appDraft.slice():null;
  appDrawing=null; appDraft=[]; drawGroup.clearLayers(); document.getElementById("drawbar").classList.remove("on");
  store.update(s.id,{path}); }
map.on("click",e=>{
  if(!appDrawing) return;
  const chain=draftChain(); if(!chain) return;
  const pt=[e.latlng.lat,e.latlng.lng];
  const P=map.latLngToLayerPoint(e.latlng);
  let at=appDraft.length, best=Infinity;
  for(let i=0;i<chain.length-1;i++){
    const A=map.latLngToLayerPoint(L.latLng(chain[i])), B=map.latLngToLayerPoint(L.latLng(chain[i+1]));
    const d=L.LineUtil.pointToSegmentDistance(P,A,B);
    if(d<best){ best=d; at=i; }          // chain[i] → appDraft[i-1]; inserting after it is splice(i,...)
  }
  appDraft.splice(at,0,pt);
  renderAppDraft();
});
/* An open fan belongs to one view. Pan or zoom and the pile it explained is not there any more,
   so it closes itself rather than leaving offsets pointing at nothing. `movestart`/`zoomstart`,
   not the -end pair: clearing after the redraw would draw the fan once more on the way out. */
map.on("movestart zoomstart",()=>{ if(SPIDER){ SPIDER=null; } });
map.on("zoomend",()=>{ if(!appDrawing) drawMap(); });   // fan offsets are pixel-based

function drawMap(){
  layerGroup.clearLayers();
  setTimeout(drawEdgeChips, 0);   // after this frame's markers exist and the view has settled
  // replay reveals only dated stops up to the scrubber date; the latest per group is "current".
  // grouping is by vehicle (default, everywhere) or by PERSON (replay + "People" view, D-023).
  const inReplay = replayT!=null;
  const byPerson = inReplay && replayBy==="person";
  const vis = replayVisible();
  /* PLACEABLE ONLY, and filtered HERE rather than at each consumer. Every path below hands
     coordinates to Leaflet — markers, the route polyline, the fan hairline, cluster bounds —
     and every one of them throws "Invalid LatLng object" on a non-finite value. Guarding them
     one at a time was whack-a-mole: fixing the marker loop simply moved the same crash into
     drawRoadRun's polyline.
     It matters far past a cosmetic gap, because drawMap runs inside the replay tick: ONE
     unusable row did not degrade the map, it stopped playback dead with the button still
     showing pause (Peter, 2026-08-06). A stop nobody can place gets no pin and no line, and
     everything else on the trip still draws. */
  const base = (vis ? sorted().filter(vis) : sorted()).filter(placeableStop);
  const gkey    = s => byPerson ? (s.author||"—") : s.track;       // group key
  const gcolor  = k => byPerson ? personColor(k) : trackColor(k);  // group line/pin color
  const validKey= k => byPerson ? true : (k==="truck"||k==="rental");
  const isHidden= k => byPerson ? false : !!hidden[k];             // vehicle hide-toggles don't apply to people
  /* Co-located stops used to stack exactly, hiding every pin but the top one
     (audit F08 — the Tahoe demo was "fixed" by editing coordinates, which means
     every real trip still had it). Fan them around their shared point, in screen
     space so the spread survives zooming. Route lines still use true coords. */
  /* Posts belong in this too, and did not used to be. D-009 has posts dropping at your
     geolocation, and you post where you ARE — so a post landing exactly on a stop is the
     normal case, not an edge one. On a six-stop trip with four posts it hid four stops
     completely: same pixel, post drawn second, stop gone. */
  const postsNow = inReplay ? allPosts.filter(replayPostVisible() || (()=>false)) : allPosts;
  /* THE FAN GROUPS BY RENDERED PIXELS, not by rounded coordinates. It used to key on
     toFixed(4) — about 11m — which caught a post pinned exactly on its stop and nothing else.
     Measured on the demo trip: four separate things at one cabin, tens of metres apart, sat
     within 3px of each other from zoom 11 down and the fan never fired, because 11m is not
     the question. The question is whether they overlap ON SCREEN, and that depends on zoom.
     Safe now that drawMap re-runs on zoomend: at a zoom where the offset would misrepresent
     the geography, the points are already further apart than NEAR and no offset is applied.
     Each fanned marker keeps a hairline back to its true point, and a drag subtracts the
     offset before saving. */
  /* THE MARKER THAT SAYS WHERE YOU ARE IS NEVER SWALLOWED — still true OUTSIDE replay, where
     `here` is a live position someone is actually looking for in a pile of unrelated stops.
     INSIDE replay it is not true any more, and that is Peter's call (2026-08-06): "badge with
     the count — legible wins."
     The rule protected one marker per group key, which is right while the tracks are apart and
     actively harmful once they converge: every protected marker landed on the same pixel and
     none of them could cluster, so six arrivals drew 1px apart and read as one dot. Protecting
     a marker from being swallowed is worthless if the thing that swallows it is another
     protected marker.
     Letting them into the normal pass gets the tuning that already exists — TWO OR THREE FAN
     around their true points and stay individually visible, FOUR OR MORE become a badge
     carrying the count — so the common case is not a badge at all. */
  const neverCluster=new Set();
  if(!inReplay) base.forEach(s=>{ if(s.here) neverCluster.add(s.id); });

  /* SPIDERFY (§2bc). A cluster badge used to answer a tap with `fitBounds` — the map flew
     somewhere else and you tapped again, so reaching one stop cost tap → wait → tap, and you lost
     the view you were looking at. On the road that view is where you ARE.
     Tapping a badge now fans its members in place at a radius big enough to separate them, and the
     map does not move. Any pan or zoom clears it. */
  const fan=new Map(), inCluster=CLUSTERED, clusters=[];
  inCluster.clear();
  (function(){
    const items=[...base.map(s=>({id:s.id,lat:+s.lat,lng:+s.lng})),
                 ...postsNow.map(p=>({id:p.id,lat:+p.lat,lng:+p.lng}))]
      .filter(a=>isFinite(a.lat)&&isFinite(a.lng) && !neverCluster.has(a.id));
    if(!items.length) return;
    const NEAR=26;                                   // px — a 30px pin, so closer than this covers
    const CLUSTER_AT=4;                              // fan two or three; past that, count them

    /* AGGLOMERATIVE, not one greedy pass. The single pass clustered a pile and then put the
       badge at its centroid, which promptly landed on the next pile — measured at z6: badges
       "9" and "4" drawn, and still four marker pairs under 20px. Merging until nothing is
       within NEAR of anything else is the only version that settles. Bounded by construction:
       every merge removes a node, so it cannot run more than items.length times. */
    let nodes=items.map(a=>{ const q=map.latLngToContainerPoint([a.lat,a.lng]);
      return {ids:[a.id], pts:[[a.lat,a.lng]], x:q.x, y:q.y}; });
    for(let guard=nodes.length; guard>0; guard--){
      let hit=null;
      for(let i=0;i<nodes.length && !hit;i++)
        for(let j=i+1;j<nodes.length;j++)
          if(Math.hypot(nodes[i].x-nodes[j].x, nodes[i].y-nodes[j].y) < NEAR){ hit=[i,j]; break; }
      if(!hit) break;
      const [i,j]=hit, a=nodes[i], b=nodes[j], wa=a.ids.length, wb=b.ids.length;
      nodes[i]={ids:a.ids.concat(b.ids), pts:a.pts.concat(b.pts),
                x:(a.x*wa+b.x*wb)/(wa+wb), y:(a.y*wa+b.y*wb)/(wa+wb)};
      nodes.splice(j,1);
    }

    for(const nd of nodes){
      if(nd.ids.length<2) continue;
      if(nd.ids.length>=CLUSTER_AT){
        /* The one this person has already opened fans instead of counting. Matched on the id SET,
           not the centroid: the centroid moves with every pan, and an id set is what the tap
           actually chose. */
        if(SPIDER && SPIDER === nd.ids.slice().sort().join(",")){
          /* A bigger radius than the 2-3 fan, and it has to be: the existing `13+3*n` puts four
             30px pins on a 25px circle, which is the pile the badge exists to prevent. This scales
             with the count so nine members still separate. */
          const R = 26 + 7*nd.ids.length;
          nd.ids.forEach((id,k)=>{ const ang=(2*Math.PI*k)/nd.ids.length - Math.PI/2;
            fan.set(id,[Math.cos(ang)*R, Math.sin(ang)*R]); });
          continue;
        }
        nd.ids.forEach(id=>inCluster.add(id));
        clusters.push({n:nd.ids.length, pts:nd.pts, ids:nd.ids,
          lat:nd.pts.reduce((t,q)=>t+q[0],0)/nd.pts.length,
          lng:nd.pts.reduce((t,q)=>t+q[1],0)/nd.pts.length});
        continue;
      }
      /* Two or three: fan them around their own true points, which keeps the hairline honest. */
      const r=13+3*nd.ids.length;
      nd.ids.forEach((id,k)=>{ const ang=(2*Math.PI*k)/nd.ids.length - Math.PI/2;
        fan.set(id,[Math.cos(ang)*r, Math.sin(ang)*r]); });
    }
  })();
  const fanned=s=>{ const o=fan.get(s.id); if(!o) return [s.lat,s.lng];
    const pt=map.latLngToLayerPoint([s.lat,s.lng]);
    const ll=map.layerPointToLatLng(L.point(pt.x+o[0], pt.y+o[1]));
    return [ll.lat,ll.lng]; };

  /* 🔴 ?tracks=1 — TWO PINS BOTH READING "4". `seq[k]` counts within each track (there is a
     test-tools assertion pinning that: "legs are numbered within their own track, not across the
     trip"), so a two-vehicle trip draws a 4 for Sam's Subaru AND a 4 for Alex's rental. Colour
     already separates them — the pin carries `s.track` — but colour alone is not a label: it
     fails a colour-blind reader outright, and to everyone else two 4s simply read as a duplicate.
     Peter's own handset screenshot of the demo shows exactly that, one blue and one gold.
     A LETTER, NOT CONTINUOUS NUMBERING. Renumbering across the trip would contradict the assertion
     above and D-011's whole point, so the track gets a prefix instead: A4 · B4. It appears ONLY
     when more than one track is on screen, so an ordinary single-vehicle trip is untouched.
     The legend already exists — the track chips in the sheet — so they take the same letter. */
  /* Order by FIRST APPEARANCE rather than off the chip row, so this is correct in `byPerson`
     mode too — where `k` is a person and no track chip exists to look up. */
  const keyOrder = (()=>{ const out=[];
    base.forEach(s=>{ const k=gkey(s);
      if(validKey(k) && !isHidden(k) && out.indexOf(k)===-1) out.push(k); });
    return out; })();
  const multiTrack = document.body.classList.contains("tracks") && keyOrder.length > 1;
  const trackLetter = k => { const i=keyOrder.indexOf(k);
    return i < 0 ? "" : String.fromCharCode(65 + (i % 26)); };
  const trackLabelOf = k => (typeof TRACK_LABELS !== "undefined" && TRACK_LABELS && TRACK_LABELS[k]) || k;
  const groups={}, seq={}, frontier={};
  if(inReplay) for(const s of base){ const k=gkey(s); if(validKey(k)) frontier[k]=s.id; } // date-sorted → last wins
  base.forEach(s=>{
    const k=gkey(s);
    if(!validKey(k)) return;
    (groups[k]=groups[k]||[]).push(s);
    seq[k]=(seq[k]||0)+1;
    if(isHidden(k)) return;
    if(inCluster.has(s.id)) return;   // the badge stands for it until you zoom in
    const isHere = inReplay ? (frontier[k]===s.id) : s.here;
    const pinStyle = byPerson ? `background:${gcolor(k)};color:#fff` : "";
    /* Same rule replayFocusPts() uses to decide where to point the camera, so the pin that
       pulses and the pin the map flies to are always the same pin. */
    const isNew = inReplay && REPLAY_FRESH.has(s.id);
    const icon=L.divIcon({className:"",
      html:`<div class="pin ${byPerson?"":s.track} ${isHere?"is-here":""} ${isNew?"arrive":""}" style="position:relative;${pinStyle}">${multiTrack?'<i class="pl">'+trackLetter(k)+'</i>':''}${seq[k]}</div>`,
      iconSize:[30,30], iconAnchor:[15,15]});
    const pos=fanned(s);
    const m=L.marker(pos,{icon,draggable:!READONLY}).addTo(layerGroup);
    { const me=m.getElement();
      if(me){ me.setAttribute("role","button");
        /* The track was missing from here too, so a screen-reader user got the same "Stop 4"
           twice with nothing to tell them apart. */
        me.setAttribute("aria-label",`${multiTrack?trackLabelOf(k)+", ":""}Stop ${seq[k]}: ${s.place||"unnamed"}${s.date?", "+fmtDate(s.date):""}`); } }
    if(fan.has(s.id)) L.polyline([[s.lat,s.lng],pos],{color:"#8A9CAA",weight:1.5,opacity:.7,
      interactive:false}).addTo(layerGroup);   // hairline back to the true point
    /* esc(s.place) is not decoration: Leaflet sets innerHTML for a string tooltip, and a stop
       title is written by anyone holding the EDIT phrase while this renders for everyone
       holding the VIEW phrase. Unescaped, an editor could run script in a viewer's page and
       read the trip keys this origin keeps in localStorage. The author was already escaped
       here; the place was not. */
    m.bindTooltip(`${byPerson&&s.author?esc(s.author)+" · ":""}${s.fly?"✈ ":""}${esc(s.place)}${s.date?" · "+fmtDate(s.date):""}`,{direction:"top",offset:[0,-14]});
    m.on("click",()=>{ if(sheetState==="shut") setSheet("half"); focusCard(s.id); });
    m.on("dragend",e=>{ const p=e.target.getLatLng(); const o=fan.get(s.id);
      if(!o) return store.update(s.id,{lat:p.lat,lng:p.lng});
      const q=map.latLngToLayerPoint(p);       // subtract the fan offset we added
      const t=map.layerPointToLatLng(L.point(q.x-o[0], q.y-o[1]));
      store.update(s.id,{lat:t.lat,lng:t.lng}); });
  });
  for(const k in groups){
    if(isHidden(k)) continue;
    const arr=groups[k], col=gcolor(k);
    let run=[];                          // consecutive drive-connected stops (road-routed)
    for(let i=0;i<arr.length;i++){
      const P=[arr[i].lat,arr[i].lng];
      const mode = i>0 ? (arr[i].mode||"drive") : "drive";
      if(i>0 && mode!=="drive"){          // a non-drive leg breaks the road run
        if(run.length>=2) drawRoadRun(run,col);
        const A=[arr[i-1].lat,arr[i-1].lng], pth=arr[i].path;
        const lc = legColor(mode, col);
        // Any traceable leg honours its trace — see canTrace. This used to read water||train,
        // which threw away every bike and walking route anyone had drawn.
        /* Three tiers, in this order and for this reason: a HAND-DRAWN path always wins (D-117
           — it exists once and nothing can rebuild it), then a road for the modes that use one,
           then the chord for rail/boat/ferry, which have no road network to ask about. */
        if(canTrace(mode) && Array.isArray(pth) && pth.length>=1) drawTracedLeg(A,pth,P,mode,lc);
        else if(followsRoads(mode)) drawRoutedLeg(A,P,mode,lc);
        else drawLeg(mode,A,P,lc);
        run=[P];                          // road run resumes from the arrival
      }else{
        run.push(P);
      }
    }
    if(run.length>=2) drawRoadRun(run,col);
  }
  postsNow.forEach(p=>{
    let html;
    if(p.type==="sealed")      html=`<div class="pin-post pq">${icon("mail",18)}</div>`;
    else if(p.type==="quest")  html=`<div class="pin-post pq">${icon("flag",18)}</div>`;
    else html = p.photo
      ? `<div class="pin-post" style="background-image:url('${esc(p.photo)}')"></div>`
      : `<div class="pin-post">${spotifyEmbed(p.spotify)?icon("music",18):icon("star",18)}</div>`;
    /* NOT named `icon`: this block calls the global icon() helper above, and a `const icon`
       here shadows it for the whole block — the calls then hit the temporal dead zone and
       throw, killing the render for any trip that has a post. (CLAUDE.md sharp edge.) */
    if(inCluster.has(p.id)) return;   // ditto — counted in a badge, not drawn
    const pinIcon=L.divIcon({className:"",html,iconSize:[36,36],iconAnchor:[18,18]});
    // Same fan as the stops, so a post sitting on one steps aside instead of covering it.
    const ppos = fanned({id:p.id, lat:+p.lat, lng:+p.lng});
    if(fan.has(p.id)) L.polyline([[p.lat,p.lng],ppos],{color:"#8A9CAA",weight:1.5,opacity:.7,
      interactive:false}).addTo(layerGroup);
    const m=L.marker(ppos,{icon:pinIcon, draggable: !READONLY && p.author===CURRENT_NAME}).addTo(layerGroup);
    { const pe=m.getElement();
      if(pe){ pe.setAttribute("role","button");
        pe.setAttribute("aria-label",`${p.type==="sealed"?"Easter egg":p.type==="quest"?"Quest":"Post"}${p.author?" by "+p.author:""}${p.caption?": "+p.caption:""}`); } }
    m.on("click",()=>{ if(sheetState==="shut") setSheet("half"); focusPost(p.id); });
    m.on("dragend",e=>{ const ll=e.target.getLatLng(); const o=fan.get(p.id);
      // Subtract the fan offset before saving, or every drag walks the post further from
      // where it actually happened — the stop markers have guarded this since they fanned.
      if(!o) return store.updatePost(p.id,{lat:ll.lat,lng:ll.lng});
      const q=map.latLngToLayerPoint(ll);
      const t=map.layerPointToLatLng(L.point(q.x-o[0], q.y-o[1]));
      store.updatePost(p.id,{lat:t.lat,lng:t.lng}); });
  });

  /* The badges go on LAST so they sit above whatever is still drawn around them.
     A tap fits the map to what is inside it, which separates the pile by definition rather
     than by a guessed zoom step — and if everything in the cluster is at one point, fitBounds
     would zoom to the maximum, so maxZoom stops it somewhere a person can still read. */
  for(const c of clusters){
    /* If a badge has swallowed a stop that is arriving on THIS frame, the badge has to say so.
       Letting replay markers cluster (Peter, 2026-08-06: "badge with the count — legible wins")
       fixed the pile-up, and would otherwise have cost the thing replay exists for: on one
       measured frame every arriving pin went inside a badge and NOTHING on the map moved.
       D-115 built the arrival cue because "the narration said what arrived; the map did not" —
       a silent badge is that bug again, one layer up. */
    const cFresh = inReplay && c.ids && c.ids.some(id=>REPLAY_FRESH.has(id));
    const m=L.marker([c.lat,c.lng],{zIndexOffset:cFresh?960:900, icon:L.divIcon({className:"",
      html:`<div class="clustertap${cFresh?" arrive":""}"><div class="cluster">${c.n}</div></div>`,
      iconSize:[44,44], iconAnchor:[22,22]})}).addTo(layerGroup);
    const el=m.getElement();
    if(el){ el.setAttribute("role","button"); el.setAttribute("tabindex","0");
      el.setAttribute("aria-label",`${c.n} stops and posts here — open to see them`); }
    /* FAN IN PLACE, DO NOT FLY. `fitBounds` was one tap to a moved map and a second tap to the
       pin; this is one tap to pins you can already see, with the map exactly where you left it. */
    const open=()=>{ SPIDER = c.ids.slice().sort().join(","); drawMap(); };
    m.on("click",open);
    if(el) el.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); open(); } });
    m.bindTooltip(`${c.n} here`,{direction:"top",offset:[0,-16]});
  }
}

/* ── replay: scrub the trip along its dated stops ──────────────────
   Timeline = the unique dates that have stops. Dragging reveals the map
   up to that date; each track's latest revealed stop is the "current"
   position. Undated stops (plan-only) sit out of the timeline. */
/* Frames the scrubber steps through. Dates when the trip has them — watching the
   days pass is the better story. Otherwise TRAVEL ORDER, because dates are optional
   and most trips never get any: of eleven real trips on the server, nine had zero
   dated stops, so a date-only timeline left replay hidden on nearly all of them.
   Travel order is `sorted()` and nothing else (same rule as the rail and the map),
   so replay reveals the trip in exactly the order it is drawn. */
/* Comparable ground distance between two points, in degrees-of-latitude equivalent.
   NOT great-circle — this only ever decides "which of these is nearest", so the cheap
   equirectangular approximation is right and a haversine would be false precision.

   What it fixes (2026-07-30 audit, R2): both call sites used Math.hypot on raw lat/lng, which
   treats a degree of longitude as equal to a degree of latitude. It is not — it shrinks by
   cos(latitude) — so a genuinely nearer stop displaced east-west lost to a further one displaced
   north-south. Measured with a post at the origin, one stop 0.50 deg east and one 0.40 deg north:
   at 45N the east stop is 39.4 km against 44.5 and the old code still picked north. That is
   Montana and the Alps, not an edge case.

   It matters twice. In replay it narrates a post at the wrong stop, which reads as a misfiled
   memory rather than a bug. In geocode disambiguation it picks the wrong candidate for an
   ambiguous name — the exact failure the code elsewhere warns about, where a geocoder ranks
   Reno, Germany above Reno, Nevada.

   A `function` declaration on purpose: it hoists, and a `const` arrow used above its definition
   throws and kills the whole inline script (see CLAUDE.md's sharp edges). */
function nearDist(aLat, aLng, bLat, bLng){
  const k = Math.cos((+aLat) * Math.PI / 180);
  return Math.hypot((+aLat) - (+bLat), ((+aLng) - (+bLng)) * k);
}

/* THE FRAME UNIT IS THE WHOLE OF "the replay runs too fast", and it is arithmetic, not timing.
   Dates win here whenever a trip has two of them, so the live demo — 15 stops across 4 days —
   replays in FOUR frames. Measured end to end in Chrome: 6.8 seconds, ticks at 1826 / 3821 /
   5821 / 6822ms. The interval is healthy and there is only one of it; there is simply almost
   nothing to watch. Every symptom Peter reported falls out of that one fact:
     · "no camera movement" — three moves in the entire run, and the first frames 10 points from
       Chicago to San Francisco, which is the same continental view the overview just showed
     · "not start at the start of each flight" — O'Hare and Reno are both 08-01, so the only
       flight on the trip departs and lands in the same instant
     · "no end of animation msg" — the run is over in under seven seconds
     · "you don't even see step 1, just 2 light up" — frame one reveals SIX stops at once
   Note what this means for §2c: every round of replay tuning — 1400ms a stop, leg-by-leg road
   geometry, the arriving-stop halo, D-153's fit/pan/hold camera — was built and checked on the
   STOP-BY-STOP path, which the flagship demo has never once taken.

   ?rstep=1 makes the stop the frame on a dated trip too, and keeps the date as a label. Flagged
   rather than switched, because it is a real change to the feature's pacing and Peter's eye
   decides that: 15 stops at 1400ms is 21 seconds, and the note at `step` below once called 18
   too long — written when the complaint was the opposite one. Nothing links to the flag. */
/* ?rtrack=1 — ONE CREW AT A TIME. Peter, having watched ?rstep=1 on a handset: "still feels a
   bit confusing — which I guess is the nature of the two person trip paths."

   He is describing an unsignalled cut, and the frame list proves it. In travel order this trip
   goes SF → Sacramento → Tahoe City → **Chicago O'Hare** → Reno → Tahoe City → Emerald Bay →
   Cabin → **Reno** → Cabin → Mt Tallac → **San Francisco** → Lake day → Reno → Reno. Three times
   the camera teleports two thousand miles to a different crew with nothing to say it has, and
   twice it comes back. Chronologically it is correct and there is no bug in it — it is simply
   cross-cutting between two storylines with no establishing shot, which is confusing on a big
   screen and worse on a phone.

   So this plays each crew's journey through, in full, before starting the next — the truck from
   San Francisco to Tahoe and home, then the rental from Chicago. The other crew's stops stay on
   the map once revealed, so the second run draws over the first and you watch them converge.
   Tracks start in the order they first set off. **It TRADES chronology for continuity**, which is
   the real question and precisely why it is a flag and not a switch: this trip's story is two
   groups meeting at a lake, and playing them separately tells it as two stories that happen to
   share an ending.

   THAT QUESTION IS ANSWERED. Peter watched it and said "much much better", which proved the
   interleave was the problem — and then chose the middle answer over this one: chronological
   order kept, the cut ANNOUNCED. So `?rtrack=1` is no longer the proposal, but it stays
   reachable as the one view that never cuts at all, which is a real thing to want on a trip
   with more than two crews. */
function replayFrames(){
  const ds=[...new Set(allStops.filter(s=>s.date).map(s=>s.date))].sort();
  const byTrack = FLAGS.has("rtrack");
  /* PROMOTED TO THE DEFAULT, 2026-08-06, on Peter's call after watching every variant on a
     handset: "make rcard the default." The stop is the frame, chronological order is kept, and
     every stop carries a sign — with the handoff announced when the crew changes.

     `?rday=1` keeps the OLD day-by-day replay reachable rather than deleting it, for two
     reasons. It is the only way back if a long trip turns out to be tedious stop-by-stop (the
     demo's 15 stops run ~48s; a 60-stop trip would run several minutes, and nobody has watched
     one yet). And it is the only remaining home for **D-089**, the UTC day-boundary rule for
     when a post arrives — with per-stop frames a post arrives at the stop it happened NEAREST
     to, which is finer-grained and equally timezone-proof, but it means D-089's mechanism is
     unreachable by default and that deserves to be a decision rather than a side effect.

     `?rstep=1` and `?rcard=1` now describe the default. They are still ACCEPTED so that links
     already sent keep working; they simply change nothing. */
  if(ds.length>=2 && FLAGS.has("rday"))
    return {by:"date", keys:ds, label:(k)=>fmtDate(k)};
  let ord=sorted();
  /* Tracks in the order they first set off; stops inside a track keep travel order. `sorted()`
     IS the travel order, and Array#sort is stable, so sorting on first-appearance alone does the
     whole regrouping — there is no second ordering rule that could disagree with the rail or the
     map about what comes after what. */
  const firstAt=new Map();
  ord.forEach((s,i)=>{ if(!firstAt.has(s.track)) firstAt.set(s.track, i); });
  if(byTrack) ord=ord.slice().sort((a,b)=>firstAt.get(a.track)-firstAt.get(b.track));
  if(ord.length<2) return {by:"none", keys:[], label:()=>""};
  /* One crew, no crew prefix: naming the only track on every frame is noise, not orientation.
     The LABEL carries the crew on every frame and the SIGN marks the moment it changes — which
     is also what makes the sign safe to hide from screen readers, because the slider's
     aria-valuetext already says whose journey this is. */
  const namesCrew = firstAt.size > 1;
  return {by:"order", keys:ord.map(s=>s.id),
          label:(k,i)=>{
            const s=ord[i]; if(!s) return `Stop ${i+1} of ${ord.length}`;
            /* Under rtrack the crew IS the organising idea, so it leads — otherwise you are
               watching the camera jump and guessing whose trip you are on. */
            const crew = namesCrew ? (TRACK_LABELS[s.track]||s.track)+" · " : "";
            return crew + (s.date ? fmtDate(s.date)+" · " : "") + `Stop ${i+1} of ${ord.length}`;
          }};
}
/* The reveal test for the current frame, or null when not replaying. One place, so
   the map, the key, and the rail can never disagree about what has been reached. */
/* D-049: replay narrates. Posts used to be hidden outright while replaying, so the showpiece
   was a map redrawing itself — you watched a pin appear but never what happened there, which
   is the part anyone actually wants to see again.

   "Has this moment arrived?" depends on which timeline is running:
     · dates  → a post belongs to the day it was posted, so reveal it once the scrubber has
                reached the end of that day
     · order  → an undated trip has no clock to compare against, so a post belongs to the stop
                it happened NEAREST to, and arrives when that stop does. That is the honest
                reading of "where were we when this happened".
   Sealed drops need no special case: the server already withholds their content from anyone
   who has not opened them (D-047), so a sealed pin replays as a sealed pin. */
function replayPostVisible(){
  if(replayT==null) return null;
  const f=replayFrames();

  /* Where-based arrival: the post belongs to the stop it happened nearest to, and shows up
     when that stop does. This is the only rule available on an undated trip, and it is also
     the right fallback for a post with no timestamp — plenty have none, and `(p.ts||0)` would
     otherwise read a missing time as 1970 and dump every one of them into the first frame. */
  const vis=replayVisible();
  const seen=new Set(sorted().filter(vis).map(s=>s.id));
  const byPlace = p => {
    let best=null, bd=Infinity;
    for(const s of allStops){ const d=nearDist(p.lat,p.lng,s.lat,s.lng); if(d<bd){bd=d;best=s;} }
    return !!best && seen.has(best.id);
  };
  if(f.by!=="date") return byPlace;

  /* Dated trip: a post belongs to the day it was posted. No timestamp, no day — fall back.

     R1: the "Z" is the fix and it is load-bearing. `replayT` is a bare date (stops carry `date`,
     which has no timezone) and `p.ts` is a UTC epoch, so comparing them requires CHOOSING a
     timezone. Without the Z this parsed in the VIEWER's zone, so the same shared replay put the
     same post on different days depending on where it was watched — in Auckland it slipped a
     frame, in Denver it did not. A trip is shared; that is the product.

     UTC is the choice, matching X2's ICS fix rather than inventing a second convention. The
     honest day is the day in the POSTER's timezone, which is not stored — fixing that properly
     means an offset column on `pins` and is a schema change nobody has decided on. Consistent
     for everyone beats correct for whoever happens to be watching. */
  const end = new Date(replayT+"T23:59:59.999Z").getTime();
  return p => p.ts ? p.ts <= end : byPlace(p);
}

function replayVisible(){
  if(replayT==null) return null;
  const f=replayFrames();
  if(f.by==="date") return s=>s.date && s.date<=replayT;
  const upto=new Set(f.keys.slice(0, f.keys.indexOf(replayT)+1));
  return s=>upto.has(s.id);
}
/* Peter, 2026-08-05: "replay should just be hitting play again because it's right there — not
   a redundant button to show the play bar." So this is ONE tap: it opens the scrubber AND
   starts playing. playReplay() already restarts from the top when it is pressed at the end, so
   replaying really is just pressing play again — that part was always true, it was buried
   behind a reveal step nobody reached. */
function tapPlay(){
  if(replayT == null) openReplay(true);   // first press also opens the scrubber — quietly
  playReplay();
}
/* The header button mirrors the transport's state, so the two can never disagree about
   whether the trip is running. */
function syncPlayBtn(){
  const can = replayFrames().keys.length >= 2;
  const running = !!replayTimer;
  /* TWO buttons, one state. #playBtn is in the sheet's header; #playMap is on the map and is
     the one a visitor actually meets, because the sheet opens shut. */
  [["playBtn",18],["playMap",20]].forEach(([id,size])=>{
    const b=document.getElementById(id);
    if(!b) return;
    b.hidden = !can;
    b.innerHTML = icon(running ? "pause" : "play", size);
    b.setAttribute("aria-label", running ? "Pause the trip" : "Play the trip from the start");
    b.title = running ? "Pause" : "Play the trip";
  });
}
function syncReplayBtn(){
  syncPlayBtn();
  const btn=document.getElementById("replayBtn");
  if(btn) btn.hidden = replayFrames().keys.length<2 || replayT!=null;
  /* §2v prototype: the action bar's Replay tracks the same rule from the same place, so the
     two can never disagree about whether this trip can replay. No-op without the flag. */
}
/* Move the map to the part of the trip happening NOW.

   The first version fit the bounds of everything revealed so far, which is wrong in a way
   that is only obvious once you watch it: a cumulative reveal has bounds that can only grow,
   so the Tahoe demo zooms out to the whole of North America on day one and stays there for
   the rest of the trip. You end up watching a continent instead of a journey.

   So it fits the stops that arrive at THIS frame, plus the one each of them just left, which
   is the leg actually being travelled. Wide when the crew is scattered, tight once they have
   converged — the zoom tells the story on its own.

   It stops following the moment you drag or zoom yourself, because a map that yanks itself
   back while you are looking at something is worse than one that sits still. Pressing play
   takes the wheel again — that is an explicit "show me". */
/* The insets fitBounds frames into. Named once so "already framed" below can mean exactly the
   same thing as "would be framed" — the bottom 210 is the sheet, which covers the map without
   the map knowing. */
const REPLAY_PAD = {l:46, t:46, r:46, b:210};
/* TWO sets, because they want different things and the difference is the whole problem.
   `arrivals` is what is landing on this frame. `withLegs` adds each one's predecessor, so the
   camera shows the JOURNEY and not just the destination — which is right until a leg is a
   flight across the country and the arrivals are a dozen stops around one lake. Then a single
   frame holding both means the arrivals collapse into a blob, which is what Peter saw: six
   pins arriving 0px apart. */
function replayFocusSets(){
  const vis=replayVisible(); if(!vis) return null;
  const shown=sorted().filter(vis).filter(s=>!hidden[s.track]);
  if(!shown.length) return null;
  const f=replayFrames();
  /* `shown.slice(-1)` USED to stand in for "the stop that just arrived", and it only worked
     because the frame order and `sorted()` were the same list. The moment a replay orders frames
     any other way — ?rtrack=1 plays one crew through, then the other — the chronologically last
     visible stop stops being the one that arrived. Ask for the frame's own stop by id. */
  let fresh = f.by==="date" ? shown.filter(s=>s.date===replayT) : shown.filter(s=>s.id===replayT);
  if(!fresh.length) fresh = shown.slice(-1);
  /* Filtered at the source. Everything downstream — bounds, getBoundsZoom, latLngToContainerPoint
     — throws on a non-finite coordinate, and a trip only needs one to take the whole replay down. */
  const ok=(a,b)=>isFinite(a)&&isFinite(b)&&Math.abs(a)<=90&&Math.abs(b)<=180;
  const arrivals=[], withLegs=[];
  /* How far this frame TRAVELLED, in miles, longest leg if several arrive at once. Taken here
     because this is the one place that already pairs a stop with the stop it just left —
     recomputing it anywhere else would be a second copy of the selection rule, and the two
     would drift. `nearDist` returns cos-corrected degrees; 69 miles to the degree. */
  let maxLegMi=0;
  fresh.forEach(s=>{
    if(!ok(+s.lat,+s.lng)) return;
    arrivals.push([+s.lat,+s.lng]); withLegs.push([+s.lat,+s.lng]);
    const chain=shown.filter(x=>x.track===s.track), i=chain.indexOf(s);
    if(i>0 && ok(+chain[i-1].lat,+chain[i-1].lng)){
      withLegs.push([+chain[i-1].lat,+chain[i-1].lng]);
      maxLegMi=Math.max(maxLegMi, nearDist(+s.lat,+s.lng,+chain[i-1].lat,+chain[i-1].lng)*69);
      /* FRAME THE ROAD, NOT THE STRAIGHT LINE BETWEEN ITS ENDS. Peter, on the SF drive: "the
         camera moved along the straight line and missed most of the drive." Two endpoints
         describe a chord; the road is the arc, and a road that bows away from its chord — the
         Bay round to I-80, anything following a coast or a valley — leaves the frame the moment
         the real geometry lands. Sampled to ~24 points because this feeds replayFramed(), which
         projects every point it is given on every frame; the bounds of 24 evenly spaced samples
         and of 500 are the same to the pixel, and one of them is free. */
      const road=legRoad(chain[i-1], s);
      if(road && road.length>2){
        const stride=Math.max(1, Math.floor(road.length/24));
        for(let j=0;j<road.length;j+=stride) if(ok(road[j][0],road[j][1])) withLegs.push(road[j]);
      }
    }
  });
  return {arrivals, withLegs, maxLegMi};
}
/* What the camera should actually frame. Show the leg when it is affordable; drop it when it
   would cost more than two zoom levels, because two levels is the difference between reading
   a cluster and seeing one dot. The arrivals are the event — the leg is context, and context
   that hides the event is not worth having. */
/* The ceiling fitBounds is actually given. Named once, because the "is the leg affordable"
   test below has to measure the same thing the camera will do, and for a while it did not. */
const REPLAY_MAX_Z = 11;
function replayFocusPts(){
  const sets=replayFocusSets(); if(!sets) return null;
  if(!sets.arrivals.length) return sets.withLegs;
  try{
    const pad=L.point(REPLAY_PAD.l + REPLAY_PAD.r, REPLAY_PAD.t + REPLAY_PAD.b);
    /* CAPPED, and this is the whole of "you never see the leg". A frame with ONE arrival is a
       zero-area bounds, and getBoundsZoom answers that with the MAP's max zoom — measured 18 on
       every single frame of a 15-stop stop-by-stop run. fitBounds is capped at 11 and would
       never go near 18, so the subtraction compared a zoom the camera cannot reach against a
       real one: 18 - zLeg cleared the two-level bar for every leg shorter than a continent, and
       the leg was dropped 13 times out of 15. The two that "kept" it were the two stops with no
       predecessor — it showed the leg only when there wasn't one.
       Capping makes both sides mean the same thing. The threshold is untouched: short legs now
       show (Tahoe City → Emerald Bay, 11 - 11 = 0), and the ones the rule was written for still
       go (Chicago → Reno, 11 - 5 = 6). Peter's "not start at the start of each flight" is this. */
    const zArr=Math.min(REPLAY_MAX_Z, map.getBoundsZoom(L.latLngBounds(sets.arrivals), false, pad));
    const zLeg=map.getBoundsZoom(L.latLngBounds(sets.withLegs), false, pad);
    if((zArr - zLeg) >= 2) return sets.arrivals;      // the leg costs the cluster — drop it
  }catch(e){}
  return sets.withLegs;
}
/* Is every point that matters already comfortably on screen? Container pixels rather than
   map.getBounds(), because getBounds() counts the strip under the sheet as visible and a stop
   hidden behind the list is not one the eye can follow. */
function replayFramed(pts){
  /* Guarded, and its caller calls it OUTSIDE that caller's own try — so anything thrown here
     used to travel all the way up through fitReplay and setReplay into the playback interval.
     `L.latLng` throws on a bad coordinate, and one bad stop in a trip is enough: the tick dies,
     the timer keeps firing, and the pause glyph never changes. Returning false is the safe
     answer — it means "not framed", so the camera fits rather than holds. */
  try{
    const size = map.getSize();
    if(size.x < REPLAY_PAD.l + REPLAY_PAD.r || size.y < REPLAY_PAD.t + REPLAY_PAD.b) return false;
    return pts.every(p=>{
      const c = map.latLngToContainerPoint(L.latLng(p[0], p[1]));
      return c.x >= REPLAY_PAD.l && c.x <= size.x - REPLAY_PAD.r
          && c.y >= REPLAY_PAD.t && c.y <= size.y - REPLAY_PAD.b;
    });
  }catch(e){ return false; }
}
/* §2c, Peter's next lever: "it reframes on every single stop, which may be more movement than
   the eye wants — consider holding the frame unless the new stop is off-screen."
   So the camera now HOLDS by default and only moves when it has to. A trip whose stops all fit
   at one zoom plays out with a still map and pins arriving on it, which is what watching a
   route ought to feel like; a trip that crosses the country still follows, because there the
   movement is the information. `force` is for the moments the frame is not established yet —
   opening replay, pressing play — where holding would just leave you looking at wherever the
   map happened to be. */
/* Holding is not enough on its own, and Peter's phone showed why: a trip with one long leg —
   Chicago to Tahoe — frames the whole continent at open, and then the hold keeps that frame
   while twelve destination stops arrive inside a single cluster. "In frame" was true and
   worthless. So the second question: is this frame FAR wider than what is being revealed?
   getBoundsZoom answers it in the map's own units — the zoom fitBounds would choose. Two levels
   is the threshold: one level of slack is what stops a fidget on every stop, and two is where a
   cluster stops being readable. */
/* Three answers, not two — "fit", "pan", or "hold" — because two was wrong in a way Peter
   watched happen: after a big zoom onto stop 4 the remaining arrivals were still technically
   inside the padded frame, so D-145 held, and a camera that goes dead for the last stops of a
   replay reads exactly like a replay that has broken. Nothing was failing; the rule was.
   A HOLD should mean "you are already looking at it", not "it is on screen somewhere". So the
   camera holds only when the arrivals are near the MIDDLE of the view; framed-but-off-centre
   earns a pan, which is cheap, keeps the scale, and is what tells the eye where to look. */
function replayNeedsFit(pts){
  if(!replayFramed(pts)) return "fit";                    // something has left the frame
  try{
    const pad = L.point(REPLAY_PAD.l + REPLAY_PAD.r, REPLAY_PAD.t + REPLAY_PAD.b);
    const want = Math.min(REPLAY_MAX_Z, map.getBoundsZoom(L.latLngBounds(pts), false, pad));
    if((want - map.getZoom()) >= 2) return "fit";         // the view is much wider than it needs
    /* Off-centre by more than a quarter of the shorter side? Pan. The map's own centre is
       measured against the visible middle, not the container middle — the sheet covers the
       bottom, so the centre of the SCREEN is not the centre of what anyone can see. */
    const size = map.getSize();
    const c = map.latLngToContainerPoint(L.latLngBounds(pts).getCenter());
    const midX = (REPLAY_PAD.l + (size.x - REPLAY_PAD.r)) / 2;
    const midY = (REPLAY_PAD.t + (size.y - REPLAY_PAD.b)) / 2;
    const slack = Math.min(size.x - REPLAY_PAD.l - REPLAY_PAD.r,
                           size.y - REPLAY_PAD.t - REPLAY_PAD.b) * 0.25;
    if(Math.hypot(c.x - midX, c.y - midY) > slack) return "pan";
    return "hold";
  }catch(e){ return "hold"; }
}
function fitReplay(force){
  if(!replayFollow) return;
  const pts=replayFocusPts(); if(!pts || !pts.length) return;
  const move = force ? "fit" : replayNeedsFit(pts);
  if(move === "hold") return;                     // already looking straight at it
  replayPanning=true;
  try{
    // maxZoom matters on the frames that resolve to a single point: fitBounds would
    // otherwise slam to street level, which reads as a glitch rather than an arrival.
    if(move === "pan"){
      /* Keep the scale, move the eye. Offset the target so the arrivals land in the middle of
         the VISIBLE map rather than behind the sheet. */
      const size=map.getSize();
      const c=map.latLngToContainerPoint(L.latLngBounds(pts).getCenter());
      const midX=(REPLAY_PAD.l + (size.x - REPLAY_PAD.r))/2;
      const midY=(REPLAY_PAD.t + (size.y - REPLAY_PAD.b))/2;
      map.panBy([Math.round(c.x-midX), Math.round(c.y-midY)],{animate:true,duration:.45});
    } else {
      map.fitBounds(pts,{padding:[REPLAY_PAD.t,REPLAY_PAD.l],
                         paddingBottomRight:[REPLAY_PAD.r,REPLAY_PAD.b],
                         animate:true,duration:.45,maxZoom:REPLAY_MAX_Z});
    }
    /* REDRAW ONCE THE CAMERA LANDS, and this is the fix for what Peter actually saw.
       Clustering is decided in CONTAINER PIXELS — "closer than 26px covers the pin" — and
       setReplay() draws BEFORE this function moves the map. So every frame clustered against
       the PREVIOUS zoom and was never reconsidered: six pins arriving 1px apart, CLUSTERED
       empty, not one badge on the map. The camera was never the problem; the order was.
       drawMap() does not move the camera, so this cannot feed back into another fit. */
    /* NO REDRAW SCHEDULED HERE — and the reason is worth keeping, because I added one twice.
       This page ALREADY redraws on zoomend, in two separate handlers (see `map.on("zoomend")`
       further up). Clustering is decided in container pixels, so it only needs recomputing when
       the zoom changes, and when the zoom changes those handlers fire. D-146's moveend redraw
       was therefore redundant, and it made a single frame draw the map THREE times: once from
       setReplay, twice from the existing zoomend pair. Thirteen draws for four frames, on a
       phone, inside a 1600ms tick.
       The 800ms fallback I added on top was worse than redundant: on a slow handset it could
       fire in the MIDDLE of the zoom animation it was waiting for, redrawing every layer while
       Leaflet was mid-transform. Both are gone. */
  }catch(e){}
  /* THE LOCKOUT ENDS WHEN THE MAP SETTLES, NOT ON A STOPWATCH.
     This was a flat 520ms against a 450ms animation — a 70ms margin that holds on a desktop and
     does not on a handset. Miss it and `map.on("zoomstart", … if(!replayPanning)
     replayFollow=false)` reads the REPLAY'S OWN camera move as the person grabbing the map:
     following switches off, every later stop arrives outside the frame, and the map sits
     exactly where it was. Peter, on a phone, described it precisely — "it stops where the
     camera stops" — with no error and nothing thrown, because nothing was wrong except a
     guess about how long an animation takes.
     `moveend` is the honest end of the move whatever the device costs. The timeout stays only
     as a floor in case it never arrives, and is generous rather than tight. */
  const unlock=()=>{ clearTimeout(replayPanT); replayPanT=null; replayPanning=false; };
  map.once("moveend", unlock);
  clearTimeout(replayPanT);
  replayPanT=setTimeout(()=>{ map.off("moveend", unlock); unlock(); }, 2500);
}
function setReplay(i){
  const f=replayFrames(); if(!f.keys.length) return;
  i=Math.max(0,Math.min(f.keys.length-1, +i));
  replayT=f.keys[i];
  /* What is NEW at this frame, by the same rule replayFocusPts() uses. Recomputed here rather
     than inside drawMap, because drawMap also runs on every 10s sync — and a pin that pulses
     again every ten seconds while you are reading is worse than one that never pulses. */
  { const shown=sorted().filter(replayVisible()||(()=>true));
    // By id, not slice(-1) — see replayFocusSets: the two only agree when the frame order
    // happens to be chronological, and ?rtrack=1 is the case where it is not.
    const fr = f.by==="date" ? shown.filter(x=>x.date===replayT) : shown.filter(x=>x.id===replayT);
    REPLAY_FRESH = new Set((fr.length?fr:shown.slice(-1)).map(x=>x.id)); }
  /* IS THIS FRAME A HANDOFF? Computed once, here, because three things downstream have to agree
     about it: the sign, the camera (a cut is a new scene and earns a forced fit — "hold" on a
     crew change is exactly the unsignalled cut we are fixing) and the dwell. Frame 0 counts as a
     cut on purpose: an establishing shot telling you whose trip you are starting on. */
  REPLAY_CUT=false;
  // The sign is the default now; it rides on the frame unit, not on a flag.
  if(f.by==="order"){
    const cur=allStops.find(x=>x.id===f.keys[i]);
    const prv=i>0 ? allStops.find(x=>x.id===f.keys[i-1]) : null;
    if(cur){
      REPLAY_CUT = !prv || prv.track!==cur.track;
      showReplayCard(cur, REPLAY_CUT);   // every stop now, not only the handoffs
    }
  }
  const sl=document.getElementById("replaySlider"), txt=f.label(replayT,i);
  sl.value=i; sl.setAttribute("aria-valuetext", txt);
  document.getElementById("replayLabel").textContent=txt;
  /* Forced ONLY on a handoff. Everywhere else this runs on every frame and on every scrub, and
     forcing there is exactly the reframe-on-every-stop D-145 removed. */
  drawMap(); renderReplayKey(); renderReplayStory(); fitReplay(REPLAY_CUT);
}
// the colored who's-who key, shown only when replaying by person
/* The caption strip: what arrived at THIS frame, not everything so far — otherwise it grows
   into a wall and stops being narration. */
function renderReplayStory(){
  const box=document.getElementById("replayStory"); if(!box) return;
  if(replayT==null){ box.hidden=true; box.innerHTML=""; return; }
  const f=replayFrames(), i=f.keys.indexOf(replayT);
  const now=replayPostVisible();
  // Diff against the previous frame so we show what is NEW at this step.
  let prevSeen=()=>false;
  if(i>0){ const keep=replayT; replayT=f.keys[i-1]; prevSeen=replayPostVisible()||(()=>false); replayT=keep; }
  const fresh=allPosts.filter(p=>now(p) && !prevSeen(p)).sort((a,b)=>(a.ts||0)-(b.ts||0));
  if(!fresh.length){ box.hidden=true; box.innerHTML=""; return; }
  box.hidden=false;
  box.innerHTML=fresh.slice(0,6).map(p=>{
    const sealed = p.type==="sealed" && !p.caption;   // server withheld it (D-047)
    const thumb = p.photo ? `<div class="rs-thumb" style="background-image:url('${esc(p.photo)}')"></div>`
                          : `<div class="rs-thumb">${icon(p.type==="quest"?"flag":sealed?"mail":"star",16)}</div>`;
    const body = sealed
      ? `<span class="rs-sealed">an easter egg, not opened yet</span>`
      : `<span class="rs-cap">${esc(p.caption||"(no caption)")}</span>`;
    return `<div class="rs-item">${thumb}<div>${p.author?`<div class="rs-who">${esc(p.author)}</div>`:""}${body}</div></div>`;
  }).join("");
}

function renderReplayKey(){
  const key=document.getElementById("replayKey"); if(!key) return;
  if(replayT==null || replayBy!=="person"){ key.hidden=true; key.innerHTML=""; return; }
  const names=[...new Set(sorted().filter(replayVisible()).map(s=>s.author||"—"))];
  key.hidden=false;
  key.innerHTML=names.map(n=>`<span class="rk-chip"><i style="background:${personColor(n)}"></i>${n==="—"?"Not assigned":esc(n)}</span>`).join("");
}
function setReplayBy(by){
  replayBy=by;
  document.querySelectorAll("#replayMode button").forEach(x=>x.classList.toggle("on",x.dataset.by===by));
  drawMap(); renderReplayKey(); renderReplayStory();
}
/* HOW LONG TO HOLD THE FRAME YOU ARE LOOKING AT — Peter, 2026-08-06: "slower. I want to be able
   to keep up with the animation. When it's a long flight it can move faster than when it's a
   short drive, then I won't feel so rushed."

   A flat step was always wrong for the same reason a flat pan lockout was: the frames are not
   the same size. A 1,500-mile flight is ONE simple idea — you left, you arrived, nothing
   happened in between — and the eye takes it in immediately. Four stops eight miles apart around
   one lake is where the reading actually happens: the labels, the cluster, who is where. Those
   are the frames that felt rushed, and they are the ones that were getting exactly as long as
   the flight.

   So the dwell runs INVERSELY to the leg: short hop, long look. It is interpolated on a LOG
   scale because trip legs span three orders of magnitude — 3 miles to 2,000 — and a linear ramp
   would put every drive that is not transcontinental at the fast end.

   These two numbers are the whole tuning surface. If Peter says "still too slow" or "slower
   again", move MAX first — it is the one that dominates a clustered trip, and it is what he is
   watching when he says he cannot keep up. */
/* The sign, and the beat it needs. A handoff frame buys extra dwell because two things have to
   land in it — WHO you are now following, and WHERE they are — and on the frames that carry a
   cut the camera has also just jumped the width of a continent. Made on demand, like #sayer, and
   `aria-hidden` because the scrubber's valuetext already names the crew on every frame. */
/* EVERY STOP, NOT JUST THE HANDOFFS. Peter, having watched it: "the now following Sam's Subaru
   pop ups are awesome and I think we need them at every stop on every trip — the context helps
   the animation so much, then the stop time will be fine."

   So the sign STAYS UP for the whole replay and changes what it says, rather than appearing and
   vanishing per frame. That matters: at one card per stop a 1700ms card inside a 2500ms frame
   would flash, go, and flash again — a strobe, not context. A standing sign that updates reads
   as a caption, and it is what makes the dwell feel earned rather than empty.

   What it says depends on whether the crew just changed, because the news is different:
     · a handoff → "NOW FOLLOWING / Sam's Subaru". The crew IS the event, and this is the card
       he called awesome; it is kept exactly.
     · any other stop → the crew (or the date, on a one-crew trip) over the PLACE. Where you are
       is the news once you already know whose journey this is.
   docPlace() trims "San Francisco — load up, coffee, gas" to "San Francisco", so the sign says
   the place and not the errand. */
const REPLAY_CUT_BONUS= 900;    // extra dwell on the frame that carries a handoff
function showReplayCard(stop, isCut){
  let el=document.getElementById("replayCard");
  if(!el){ el=document.createElement("div"); el.id="replayCard";
           el.setAttribute("aria-hidden","true"); document.body.appendChild(el); }
  const crew = TRACK_LABELS[stop.track] || stop.track;
  const multi = new Set(allStops.map(s=>s.track)).size > 1;
  const place = docPlace(stop.place) || "Unnamed stop";
  const kick = isCut ? "now following" : (multi ? crew : (stop.date ? fmtDate(stop.date) : "stop"));
  const name = isCut ? crew : place;
  /* A handoff card names the CREW, which is the news — but that used to cost the stop its place,
     and 6 of this demo's 15 frames are handoffs, so nearly half the trip never said where it
     was. The crew keeps the big line it earned and the place goes underneath. */
  const sub  = isCut ? `<span class="rc-p">${esc(place)}</span>` : "";
  el.innerHTML = `<i style="background:${trackColor(stop.track)||"var(--ink)"}"></i>`
    + `<div><span class="rc-k">${esc(kick)}</span><span class="rc-n">${esc(name)}</span>${sub}</div>`;
  el.classList.toggle("cut", !!isCut);
  /* Re-trigger the entry motion so a CHANGE is visible on a sign that never left. Reading
     offsetWidth is the reflow that makes removing and re-adding the class two separate frames
     rather than one no-op. */
  el.classList.remove("on"); void el.offsetWidth; el.classList.add("on");
  clearTimeout(replayCardT);
}
function hideReplayCard(){
  clearTimeout(replayCardT);
  const el=document.getElementById("replayCard"); if(el) el.classList.remove("on");
}
const REPLAY_STEP_MIN = 1500;   // a long haul: it can move faster, and 1500 still clears the .45s camera
const REPLAY_STEP_MAX = 3200;   // a short hop: the frames where there is something to read
const REPLAY_LEG_SHORT = 15;    // miles — at or under this, take the whole MAX
/* 900, not 400. Peter on the San Francisco drive: "went too fast." At 400 a 75-mile drive sat
   40% of the way to the fast end and got 2215ms, but a 75-mile drive is not a haul — it is an
   hour and a half of somebody's actual trip. "Long" should mean a flight or a day at the wheel,
   so ordinary drives now sit nearer MAX and only the real hauls take MIN. */
const REPLAY_LEG_LONG  = 900;   // miles — at or over this, it is a haul, take MIN
function replayStepMs(){
  let mi = 0;
  /* Guarded and outside anything that matters: a bad coordinate must never be able to stop
     playback from scheduling its next frame. No leg (the first stop of a track, a standing
     start) reads as a short one — there is no journey to watch, only a place to look at. */
  try{ const sets=replayFocusSets(); if(sets) mi = sets.maxLegMi || 0; }catch(e){}
  // A handoff frame gets the sign's beat on top of whatever the leg earned.
  const cut = REPLAY_CUT ? REPLAY_CUT_BONUS : 0;
  if(!(mi > REPLAY_LEG_SHORT)) return REPLAY_STEP_MAX + cut;
  if(mi >= REPLAY_LEG_LONG)    return REPLAY_STEP_MIN + cut;
  const t = Math.log(mi / REPLAY_LEG_SHORT) / Math.log(REPLAY_LEG_LONG / REPLAY_LEG_SHORT);
  return Math.round(REPLAY_STEP_MAX + (REPLAY_STEP_MIN - REPLAY_STEP_MAX) * t) + cut;
}
/* `quiet` — open the scrubber but do NOT set a frame or move the camera, because playReplay()
   is about to do both. Traced in Chrome, the unquiet path issued FOUR camera commands inside
   96ms: setReplay(last) fit at t=20, openReplay's forced fit at t=72, then setReplay(0) fit at
   t=78 and playReplay's forced fit at t=96. The last one wins and the other three are thrown
   away — but frame one's arrival animation plays UNDER a camera that is still flying in from a
   whole-trip overview nobody asked for, which is Peter's "you don't even see step 1, just 2
   light up". Opening replay on its own still gets its establishing shot; only the one-tap
   play-from-cold skips it, where it was never on screen long enough to be an establishing
   anything. */
function openReplay(quiet){
  const f=replayFrames(); if(f.keys.length<2) return;
  const sl=document.getElementById("replaySlider");
  sl.min=0; sl.max=f.keys.length-1;
  document.getElementById("replayBar").hidden=false;
  replayFollow=true;
  // The scrubber sits just under the tab row, which in the peek-height sheet is one
  // pixel below the fold — so tapping Replay looked like it did nothing at all. Raise
  // the sheet far enough to see the control you just asked for. Closing replay leaves
  // the sheet where it is; yanking it back down is the more surprising move.
  if(sheetState==="peek") setSheet("half");
  /* Before anything moves: ask for every road now, so playback meets a warm cache instead of
     drawing a straight line and correcting itself one leg at a time. Cheap and idempotent. */
  warmReplayRoutes();
  if(!quiet){
    setReplay(f.keys.length-1);     // start fully revealed
    fitReplay(true);                // the whole trip, as an overview to open on
  }
  syncReplayBtn();
}
function stopPlay(){
  /* clearTimeout, because playback is a CHAIN of timeouts now rather than one interval — each
     frame decides how long the next wait is (replayStepMs). Same id space either way, but the
     call should say what it is cancelling. */
  if(replayTimer){ clearTimeout(replayTimer); replayTimer=null; }
  document.getElementById("replayPlay").innerHTML=icon("play",15);
  syncPlayBtn();
}
function playReplay(){
  if(replayTimer){ stopPlay(); return; }
  const f=replayFrames(); if(f.keys.length<2) return;
  replayFollow=true;                // pressing play is an explicit "show me"
  /* `replayT==null` means nothing has set a frame yet — the one-tap cold start, where
     openReplay(quiet) deliberately left the camera and the frame alone. The slider still holds
     whatever the markup gave it, so READING it here started the demo on frame 1 and stop 1 was
     never revealed at all. Caught by tracing the run, not by looking at it: the log opened
     `setReplay 1`. Before the quiet path existed this could not happen, because openReplay
     always set the slider to the last frame on its way past. */
  let i = replayT==null ? 0 : +document.getElementById("replaySlider").value;
  if(i>=f.keys.length-1) i=0;       // replay from the top
  setReplay(i);
  /* Force here, not just at open: the overview frame is the whole trip, and starting playback
     from it would replay the first stops inside a cluster. Pressing play means "show me this
     one", so the camera drops to the first frame's own scale and holds from there. */
  fitReplay(true);
  document.getElementById("replayPlay").innerHTML=icon("pause",15);
  /* The pan was .7s with an 850ms lockout while stop-by-stop stepped every 650ms — so every
     single camera move was cut off by the next frame and the map never settled anywhere. The
     motion read as drift rather than arrival, which is most of what "too subtle" was.
     Pan is now .45s and the step gives it room to land before the next stop appears. */
  /* A CHAIN OF TIMEOUTS, NOT ONE INTERVAL, because the frames are no longer the same length.
     replayStepMs() reads the leg just travelled and gives a short hop more time than a flight —
     Peter: "when it's a long flight it can move faster than when it's a short drive." An
     interval cannot vary, and re-arming one per frame is the two-live-timers bug waiting to
     happen; a chain schedules exactly one successor, and only once the frame is drawn.
     The floor (REPLAY_STEP_MIN, 1500) is what keeps D-152's lesson: never let the next frame
     land on a camera move that has not finished. */
  /* AFTER the timer is assigned: syncPlayBtn() reads replayTimer to decide play vs pause,
     so calling it earlier renders a play glyph on a trip that is already running. */
  /* WRAPPED, because of exactly what Peter reported: "the page still responds, replay just
     stops and button stays pause." That is the signature of this callback THROWING — an
     interval kept firing, every tick died before it could advance or call stopPlay(), so the
     timer stayed alive and the glyph stayed on pause forever. A chain is safer by construction
     (a throw schedules no successor), but the guard stays: it is what turns a dead run into a
     run that SAYS it stopped. The error is kept on window for a desktop look — this page has no
     error reporting and is not getting any (CLAUDE.md). */
  const tick = () => {
    try{
      /* ?rdiag=1 — a live readout for a device I cannot reach. Every browser on iOS is WebKit,
         so "another mobile browser" is the same engine; the only way to see what a handset is
         doing is to have the handset say so. Flag-gated, so no customer ever meets it. */
      if(FLAGS.has("rdiag")) rdiag("tick "+(i+1)+"/"+f.keys.length);
      i++;
      if(i>=f.keys.length){
        stopPlay();
        /* "If it stops there, how would the user know?" — it ends silently otherwise, and a map
           that has simply stopped moving looks identical to one that has broken.
           SIX SECONDS, not the 1.8 every other message gets: this one is read by someone whose
           eyes are on the map, and Peter watched it come and go before he could look down. */
        // The sign stands for the whole run, so the end of the run is what takes it down.
        try{ hideReplayCard(); }catch(_){}
        try{ say("That\u2019s the trip \u2014 press play to watch again", 6000); }catch(_){}
        if(FLAGS.has("rdiag")) rdiag("done");
        return;
      }
      setReplay(i);
      // AFTER the frame is drawn, so the dwell is measured against the leg you are looking at.
      replayTimer = setTimeout(tick, replayStepMs());
    }catch(e){
      stopPlay();
      try{ window.__replayErr = String((e && e.stack) || e); }catch(_){}
      try{ say("Replay stopped early"); }catch(_){}
      try{ if(FLAGS.has("rdiag")) rdiag("THREW: "+String((e&&e.message)||e)); }catch(_){}
    }
  };
  // The first wait is measured against frame one, which fitReplay(true) has just framed.
  replayTimer = setTimeout(tick, replayStepMs());
  syncPlayBtn();
}
function closeReplay(){
  stopPlay(); replayT=null; REPLAY_CUT=false; hideReplayCard();
  document.getElementById("replayBar").hidden=true;
  renderReplayKey(); renderReplayStory(); syncReplayBtn(); drawMap();
  if(replayFollow) fitAll(true);    // and we are back to the whole trip
  replayFollow=true;
}

function renderPosts(posts){
  allPosts=posts;
  if(document.activeElement && listEl.contains(document.activeElement)) return;
  drawMap();
  if(tab==="posts") drawList();
}
function renderNotes(notes){
  allNotes=notes;
  if(document.activeElement && listEl.contains(document.activeElement)) return;
  if(tab==="info") drawList();
}

function drawList(){
  listEl.innerHTML="";
  listEl.classList.remove("rail");
  if(tab==="ask"){ drawChat(); return; }
  if(tab==="posts"){
    const q=allPosts.filter(p=>p.type==="quest");
    if(q.length){
      const t=q.filter(p=>p.claimedTeam==="truck").length;
      const r=q.filter(p=>p.claimedTeam==="rental").length;
      const sb=document.createElement("div"); sb.id="scorebar";
      sb.innerHTML=`<span>${esc(TRACK_LABELS.truck)}</span><b>${t}</b><span>–</span><b>${r}</b><span>${esc(TRACK_LABELS.rental)}</span>`;
      listEl.appendChild(sb);
    }
    [...allPosts].sort((a,b)=>(b.ts??0)-(a.ts??0)).forEach(p=>listEl.appendChild(postCard(p)));
    if(!allPosts.length)
      listEl.innerHTML='<div class="daybreak" style="margin-top:24px">'+(READONLY?"Nothing pinned yet":"Nothing pinned yet — hit + Post")+'</div>';
    applyReadonly(); return;
  }
  if(tab==="info"){
    /* §2v(d): settingsCard() is NOT here any more — it opens from the FAB's Settings wedge.
       Info was three unrelated jobs under one word, and settings was both the largest and the
       one nobody browses for: share links, the crew, rotate, and Delete this trip sat above the
       notes somebody actually came to read. The export card stays, because it is one line and a
       door, and Info is where a person wonders how to get their trip out. */
    if(allStops.length) listEl.appendChild(exportCard());   // view links too — the trip is already paid for
    [...allNotes].sort((a,b)=>(a.order??0)-(b.order??0)).forEach(n=>listEl.appendChild(noteCard(n)));
    /* NO LONGER `&& ACCESS!=="edit"`, and that guard was load-bearing until this commit: an
       editor with no notes never saw an empty state because the settings card filled the tab.
       Moving settings out would have left them an Info tab with a one-line export card, an
       origin footer, and no sign that notes are a thing — the regression a move like this
       creates and nothing fails on. The wording follows the Posts tab, which already names the
       button that fixes it. */
    if(!allNotes.length){
      // appendChild, not innerHTML= — that assignment replaced the whole list, so a view-only
      // visitor with no notes lost the export card that had just been added to it.
      const e=document.createElement("div");
      e.className="daybreak"; e.style.marginTop="24px";
      e.textContent = ACCESS==="edit" ? "No notes yet — hit + Note" : "No notes yet";
      listEl.appendChild(e);
    }
    listEl.appendChild(originCard());
    applyReadonly(); return;
  }
  listEl.classList.add("rail");
  ["truck","rental"].forEach(tr=>{
    if(hidden[tr]) return;
    const arr=sorted().filter(s=>s.track===tr);
    arr.forEach((s,i)=>listEl.appendChild(card(s, i>0?arr[i-1]:null)));
  });
  if(!listEl.children.length){
    if(ACCESS==="edit"){
      const e=document.createElement("div"); e.className="empty";
      e.innerHTML='<p>Start the map — add your first stop</p><button class="set-btn" id="firstStop">+ Add a stop</button>';
      listEl.appendChild(e);
      e.querySelector("#firstStop").onclick=()=>document.getElementById("addBtn").click();
    }else{
      listEl.innerHTML='<div class="daybreak" style="margin-top:24px">No stops yet</div>';
    }
  }
  applyReadonly();
}

/* disable every editable control when on a view link (PLAN §2.6) */
function applyReadonly(){
  if(!READONLY) return;
  // readOnly (not disabled) keeps text focusable, selectable and full-contrast for the
  // view-link majority; disabled is reserved for real action buttons below (audit F18)
  listEl.querySelectorAll("input,textarea").forEach(i=>{ i.readOnly=true; });
  listEl.querySelectorAll("select").forEach(i=>{ i.disabled=true; });
  listEl.querySelectorAll(".here-btn,.openbtn,.claim-row button").forEach(b=>{ b.disabled=true; b.title="view-only link"; });
}

const openStays=new Set();
function card(s,from){
  const seq = sorted().filter(x=>x.track===s.track).findIndex(x=>x.id===s.id)+1;
  const el=document.createElement("article");
  el.className=`card ${s.track}`+(from?"":" origin"); el.dataset.id=s.id;
  el.innerHTML=`
    <div class="ctype">${from?("Leg "+seq+(()=>{const d=legMiles(from,s);
      if(!d || !d.miles) return "";
      return " · "+nMiles(d.miles)+" mi"+(s.mode==="fly" ? "" : (d.road ? "" : " direct"));})()):"Starts at"}</div>
    <div class="card-when">${from?`<span class="wmode">${icon(s.mode,13)}${esc(MODE_LABEL[s.mode]||"")}</span>`:""}<button type="button" class="whendate${s.date?"":" nodate"}" aria-label="Change the date">${s.date?esc(fmtDate(s.date)):"no date yet"}</button></div>
    ${from?`<div class="card-top"><span class="legarrow">${icon("arrow",17)}</span>
      <input class="place" value="${esc(s.place)}" placeholder="Place" aria-label="Where this leg goes"></div>
    <div class="legfrom"><span class="fromlbl">from</span><input class="place from" value="${esc(from.place)}" readonly aria-label="Starts where the last leg ended"></div>`
    :`<div class="card-top"><span class="stopnum">${seq}</span>
      <input class="place" value="${esc(s.place)}" placeholder="Place" aria-label="Where the trip starts"></div>`}
    ${s.craft ? (isCraftLeg(s)
      ? `<div class="craft own">${icon(s.mode,13)}<b>${esc(s.craft)}</b> &mdash; its own leg</div>`
      /* Carried: show the CRAFT's own glyph, not the leg's. The leg is a drive; the thing on
         the roof is a bike, and drawing a car next to the word "Bike" reads as a mistake. */
      : `<div class="craft aboard">${icon(/bike|e-bike/i.test(s.craft)?"bike":"water",13)}<b>${esc(s.craft)}</b> aboard ${esc(TRACK_LABELS[s.track]||"the vehicle")}</div>`) : ""}
    <button class="moretog edit-only" type="button" aria-expanded="false">Add detail</button>
    <div class="card-grid">
      <div class="field"><label for="d-${s.id}">Date</label><input id="d-${s.id}" type="date" class="f-date" value="${s.date||""}"></div>
      ${from?`<div class="field wide"><label>Getting there</label>
        <div class="chips how" role="radiogroup" aria-label="Getting there">
          ${["drive","fly","train","ferry","water","bike","walk"].map(m=>
            `<button type="button" class="chip mode${s.mode===m?" sel":""}" data-mode="${m}" role="radio" aria-checked="${s.mode===m}"${READONLY?" disabled":""}>${icon(m,15)}${MODE_LABEL[m]}</button>`).join("")}
        </div>
        ${from && canTrace(s.mode) ? (()=>{
          /* THE NUDGE (§2aa). Peter found it on the demo: an untraced boat leg drew a chord from
             Tahoe City to Emerald Bay that ran ~1.4km inland. Nothing said so — the map simply
             lied quietly, and the tracer that fixes it was a button further down the card that
             gave no reason to press it.
             It belongs HERE, under the mode you just picked, because that is the moment the leg
             becomes a straight line. And it is ONE control, not a warning plus a button: the
             line states the problem and is itself the way to fix it. */
          const traced = Array.isArray(s.path) && s.path.length;
          const noun = TRACE_NOUN[s.mode] || "";
          /* THREE STATES NOW, because two would make one of them a lie. Since bike and walk
             follow roads (see followsRoads), "Straight line for now — it can cross land" is
             false for them: the line is real, it is simply a road rather than the trail somebody
             rode. Saying it anyway would be the §2ad OFF_CACHE mistake — copy describing
             behaviour the code stopped having.
             The amber is reserved for the case that IS wrong: rail, boat and ferry drawing a
             chord through whatever lies between. A routed leg reads as settled, and its button
             still says "Draw", because the trail is the thing only the rider knows. */
          const roaded = !traced && followsRoads(s.mode);
          return `<div class="pathnote${traced||roaded?" done":""}">
            <span class="pn-txt">${traced
              ? `${s.path.length} point${s.path.length===1?"":"s"} traced — the map follows them.`
              : roaded
                ? `On roads for now — trace it if you took a trail.`
                : `Straight line for now — it can cross land.`}</span>
            <button type="button" class="drawpath edit-only${traced?" done":""}">${icon("pencil",14)}${(traced?" Edit the ":" Draw the ")+noun+" route"}</button>
          </div>`;
        })() : ""}</div>`:""}
      ${s.mode==="fly"?`<div class="field"><label for="g-${s.id}">Flight #</label><input id="g-${s.id}" class="f-flight" value="${esc(s.lodging)}" placeholder="e.g. UA 1234"></div>`:""}
      ${from?`<div class="field ${s.mode==="water"?"wide":""}">
        <label for="cr-${s.id}">${SELF_POWERED.includes(s.mode)?"What are you on?":"Carrying a boat or bike?"}</label>
        <input id="cr-${s.id}" class="f-craft" value="${esc(s.craft||"")}" maxlength="24"
          placeholder="${s.mode==="water"?"e.g. the canoe":s.mode==="bike"?"e.g. my bike":s.mode==="walk"?"on foot":"name it and it rides along"}"></div>`:""}
      <div class="field wide"><label for="n-${s.id}">Notes</label><textarea id="n-${s.id}" class="f-notes" rows="1" placeholder="Anything the others should know">${esc(s.notes)}</textarea></div>
    </div>
    <!-- the draw-route button moved UP into .pathnote, under the mode chips: one control, at the
         moment the mode makes the leg a straight line, carrying its own reason to be pressed -->
    <div class="card-foot"><button class="here-btn ${s.here?"on":""}" aria-pressed="${!!s.here}">${s.here?"Here":"Set here"}</button>${s.date?"":`<span class="reorder edit-only"><button class="mv-up" title="Move earlier" aria-label="Move earlier">${icon("back",14)}</button><button class="mv-dn" title="Move later" aria-label="Move later">${icon("arrow",14)}</button></span>`}<button class="del edit-only">Remove stop</button></div>`;
  if(s.notes) el.classList.add("open");
  { const mt=el.querySelector(".moretog");
    if(mt){ const sync=()=>{ const o=el.classList.contains("open");
        mt.setAttribute("aria-expanded",o?"true":"false"); mt.textContent=o?"Hide detail":"Add detail"; };
      sync(); mt.onclick=()=>{ el.classList.toggle("open"); sync(); }; } }
  /* Tapping the printed date opens the OS date picker on the real `.f-date` — ONE input, not two,
     so there is no second source of truth for a value that decides travel order (D-037).
     The detail fold is opened first because `showPicker()` refuses an element that is
     `display:none`, and the layout is flushed before the call for the same reason. The person
     never has to look at the field; it is opened so the picker has something to attach to. */
  { const wd=el.querySelector(".whendate");
    if(wd) wd.onclick=()=>{
      if(READONLY) return;
      const d=el.querySelector(".f-date"); if(!d) return;
      if(!el.classList.contains("open")){
        el.classList.add("open");
        const mt=el.querySelector(".moretog");
        if(mt){ mt.setAttribute("aria-expanded","true"); mt.textContent="Hide detail"; }
      }
      void d.offsetHeight;
      try{ if(typeof d.showPicker === "function"){ d.showPicker(); return; } }catch(e){}
      try{ d.focus(); d.click(); }catch(e){}
    }; }
  const save=(patch)=>store.update(s.id,patch);
  if(!s.date){
    el.querySelector(".mv-up").onclick=()=>moveStop(s.id,-1);
    el.querySelector(".mv-dn").onclick=()=>moveStop(s.id,1);
  }
  { const pl=el.querySelector(".place");
    pl.addEventListener("change",e=>save({place:e.target.value}));
    /* Typing a place name here used to only RENAME the stop — the pin stayed wherever it was
       dropped, so a stop called "Denver" could sit in Kansas. Picking a suggestion now moves
       the pin as well, which is what typing a place name plainly means. Renaming without
       picking still just renames, so nothing moves by surprise. */
    if(!READONLY && typeof attachSuggest === "function") attachSuggest(pl, {
      near: () => { try{ const c=map.getCenter(); return {lat:c.lat, lng:c.lng}; }catch(e){ return null; } },
      onPick: p => save({place:p.name, lat:p.lat, lng:p.lng})
    });
  }
  el.querySelector(".f-date").addEventListener("change",e=>save({date:e.target.value}));
  el.querySelectorAll(".how .chip").forEach(b=>b.onclick=()=>{ if(!READONLY) save({mode:b.dataset.mode}); });
  { const f=el.querySelector(".place.from"); if(f) f.addEventListener("focus",()=>{ const p=listEl.querySelector('[data-id="'+from.id+'"]'); if(p) p.scrollIntoView({behavior:"smooth",inline:"center",block:"nearest"}); }); }
  { const ff=el.querySelector(".f-flight"); if(ff) ff.addEventListener("change",e=>save({lodging:e.target.value})); }
  { const cf=el.querySelector(".f-craft"); if(cf) cf.addEventListener("change",e=>save({craft:e.target.value.slice(0,24)})); }
  el.querySelector(".f-notes").addEventListener("change",e=>save({notes:e.target.value}));
  { const db=el.querySelector(".drawpath"); if(db) db.onclick=()=>startAppDraw(s); }
  el.querySelectorAll("input,textarea").forEach(i=>i.addEventListener("blur",()=>setTimeout(()=>render(allStops),80)));
  el.querySelector(".here-btn").onclick=()=>{ if(!READONLY) store.setHere(s.id,s.track); };
  /* D-117: a hand-drawn route is the ONE kind of content in this product that NOTHING can
     rebuild. A geocoder can find a stop again; routing can redraw a drive; a photo can be
     re-uploaded. A line somebody traced down a river by hand exists once. Until now it was
     deleted behind the same four-word confirm as an empty stop.
     Found the hard way 2026-08-03: rebuilding the Kishwaukee trip deleted a `water` pin
     carrying a 50-point traced river. Only the soft delete saved it — the tombstone still had
     the geometry — and nothing about the UI suggested there was anything to be careful of. */
  el.querySelector(".del").onclick=()=>{
    const n = Array.isArray(s.path) ? s.path.length : 0;
    const msg = n
      ? `Remove ${s.place}?\n\nThis leg carries a route you drew by hand — ${n} points. `
        + `Deleting the stop deletes that route with it, and nothing can draw it back for you.`
      : `Remove ${s.place}?`;
    if(confirm(msg)) store.remove(s.id);
  };
  el.querySelector(".card-top").addEventListener("click",e=>{
    if(e.target.classList.contains("here-btn"))return;
    map.setView([s.lat,s.lng],8,{animate:true});
    /* If it is still inside a badge at that zoom, go closer — you asked for this stop, not for
       a count. Four levels is a 16x scale change, which separates anything a trip can hold, and
       it is one extra step rather than a loop fighting the zoom animation. */
    map.once("moveend",()=>{ if(CLUSTERED.has(s.id))
      map.setView([s.lat,s.lng], Math.min(map.getMaxZoom()||18, map.getZoom()+4), {animate:true}); });
  });

  /* The stay is where you land, not how you got there — its own card (D-037). Shown once it
     has something to say, or when asked for, so an untouched trip isn't twice as long to scroll. */
  const wantStay = (s.mode!=="fly" && !!s.lodging) || openStays.has(s.id);
  if(!wantStay){
    if(ACCESS==="edit"){
      const add=document.createElement("button");
      add.type="button"; add.className="lnk addstay edit-only";
      add.innerHTML=icon("bed",14)+" Add a stay";
      add.onclick=()=>{ add.blur(); openStays.add(s.id); render(allStops); };
      el.querySelector(".card-foot").insertBefore(add, el.querySelector(".del"));
    }
    return el;
  }
  const stay=document.createElement("article");
  stay.className=`card stay open ${s.track}`; stay.dataset.stayFor=s.id;
  stay.innerHTML=`
    <div class="ctype">Staying in</div>
    <div class="card-top"><span class="stayic">${icon("bed",17)}</span>
      <input class="place" value="${esc(s.place)}" readonly aria-label="Where you're staying"></div>
    <div class="card-grid">
      <div class="field wide"><label for="g-${s.id}">Lodging</label><input id="g-${s.id}" class="f-lodging" value="${esc(s.mode==="fly"?"":s.lodging)}" placeholder="Hotel / conf #"></div>
    </div>`;
  stay.querySelector(".f-lodging").addEventListener("change",e=>save({lodging:e.target.value}));
  stay.querySelectorAll("input,textarea").forEach(i=>i.addEventListener("blur",()=>setTimeout(()=>render(allStops),80)));
  const frag=document.createDocumentFragment(); frag.appendChild(el); frag.appendChild(stay);
  return frag;
}
async function moveStop(id, dir){    // dir -1 = up, +1 = down; swaps seq with the track neighbor
  const s=allStops.find(x=>x.id===id); if(!s) return;
  const list=sorted().filter(x=>x.track===s.track);
  const i=list.findIndex(x=>x.id===id), j=i+dir;
  if(j<0 || j>=list.length) return;
  const other=list[j];
  let sa=s.seq||0, ob=other.seq||0;
  if(sa===ob) ob = sa + dir;         // ensure distinct so the swap actually moves it
  await store.reorder(s.id, ob, other.id, sa);
}
function noteCard(n){
  const el=document.createElement("article");
  el.className="card note"; el.dataset.id=n.id;
  el.innerHTML=`
    <input class="note-title" value="${esc(n.title)}" placeholder="Title">
    <textarea class="note-body" placeholder="Details everyone should have">${esc(n.body)}</textarea>
    <div class="card-foot"><button class="del edit-only">Remove note</button></div>`;
  const body=el.querySelector(".note-body");
  const grow=()=>{ body.style.height="auto"; body.style.height=body.scrollHeight+"px"; };
  requestAnimationFrame(grow);
  body.addEventListener("input",grow);
  el.querySelector(".note-title").addEventListener("change",e=>store.updateNote(n.id,{title:e.target.value}));
  body.addEventListener("change",e=>store.updateNote(n.id,{body:e.target.value}));
  el.querySelector(".del").onclick=()=>{ if(confirm(`Remove "${n.title}"?`)) store.removeNote(n.id); };
  return el;
}

/* ── export (D-058) ────────────────────────────────────────────────────────────────────
   Built in the browser: it already holds the whole trip, so a server round-trip would add a
   copy of your itinerary on our side to produce a file you could have made locally.

   Available on any access, view links included. The trip is already paid for; who can read it
   and who can take a copy of what they read are not different questions, and a view-only
   person keeping the dates is exactly the point.

   The two formats are the two jobs: a calendar you subscribe to, and a spreadsheet you expense. */

/* RFC 5545 wants these escaped and lines folded at 75 octets, and calendar apps really do
   reject files that ignore it — a comma in a place name is enough to break the import. */
const icsEsc = t => String(t ?? "").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n");
function icsFold(line){
  const out=[]; let s=line;
  while(s.length>73){ out.push(s.slice(0,73)); s=" "+s.slice(73); }
  out.push(s); return out.join("\r\n");
}
const icsDate = iso => String(iso||"").replace(/-/g,"");
function icsStamp(){ return new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d+/,""); }

function tripToIcs(){
  const rows=sorted(), L=[];
  L.push("BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//this trip btw//trip//EN","CALSCALE:GREGORIAN",
         "METHOD:PUBLISH", icsFold("X-WR-CALNAME:" + icsEsc(CONFIG.name || "our trip")));
  rows.forEach((st,i)=>{
    if(!st.date) return;                       // an undated stop is not a calendar entry
    const from = i>0 ? rows[i-1] : null;
    const what = from ? `${MODE_LABEL[st.mode]||"Travel"} to ${st.place||"next stop"}` : `Start: ${st.place||"trip"}`;
    /* All of this arithmetic is in UTC on purpose. It used to parse "T00:00:00" (local) and
       serialise with toISOString() (UTC), which cancels the +1 out for everyone east of UTC:
       local midnight is the previous day in UTC, so Berlin, Tokyo and Auckland all produced
       DTEND == DTSTART. RFC 5545's DTEND for an all-day event is EXCLUSIVE and must be after
       DTSTART, so that is a zero-length event and calendar apps drop it or render it wrong —
       i.e. the calendar export was broken everywhere except UTC and westward. A trip date is a
       calendar date, not an instant, so no timezone should touch it. */
    const end  = new Date(st.date+"T00:00:00Z"); end.setUTCDate(end.getUTCDate()+1);
    const desc = [st.lodging?("Staying: "+st.lodging):"", st.notes||"", st.craft?("Craft: "+st.craft):""]
                   .filter(Boolean).join("\n");
    L.push("BEGIN:VEVENT",
      "UID:" + st.id + "@" + location.hostname,
      "DTSTAMP:" + icsStamp(),
      "DTSTART;VALUE=DATE:" + icsDate(st.date),
      "DTEND;VALUE=DATE:" + icsDate(end.toISOString().slice(0,10)),
      icsFold("SUMMARY:" + icsEsc(what)),
      icsFold("LOCATION:" + icsEsc(st.place||"")),
      "GEO:" + (+st.lat).toFixed(6) + ";" + (+st.lng).toFixed(6));
    if(desc) L.push(icsFold("DESCRIPTION:" + icsEsc(desc)));
    L.push("END:VEVENT");
  });
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}

/* Quote every field rather than only the ones that need it: a place name with a comma is the
   normal case here, not the exception, and half-quoted CSV is how spreadsheets mangle a row. */
/* X3: quoting alone is correct CSV and still unsafe. Excel, LibreOffice and Sheets treat a cell
   starting = + - @ (or a tab/CR before one) as a FORMULA, so a stop note reading
   =HYPERLINK("http://...","click") executes for whoever opens the file. This export exists so a
   trip can be expensed, which means the likely reader is an employer or an accountant, someone
   outside the trip entirely. A leading apostrophe forces text and is invisible in the cell. */
const csvCell = v => {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
};
function tripToCsv(){
  const rows=sorted();
  const head=["#","Date","Place","How","Vehicle","Staying","Craft","Notes","Latitude","Longitude"];
  const body=rows.map((st,i)=>[
    i+1, st.date||"", st.place||"", MODE_LABEL[st.mode]||st.mode||"",
    TRACK_LABELS[st.track]||st.track||"", st.lodging||"", st.craft||"",
    (st.notes||"").replace(/\r?\n/g," "), (+st.lat).toFixed(6), (+st.lng).toFixed(6)
  ].map(csvCell).join(","));
  // The BOM is what makes Excel read UTF-8 instead of mojibake, and expense reports live in Excel.
  return "\ufeff" + [head.map(csvCell).join(","), ...body].join("\r\n") + "\r\n";
}

function download(text, mime, ext){
  const base=(CONFIG.name||"trip").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"trip";
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([text],{type:mime}));
  a.download=base+"."+ext;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}

/* Where this came from (marketing plan, move 05).
   A trip page is often the first time someone sees this product at all — handed a link by a
   friend, or by an assistant that built the trip for them. Some of them wonder what it is, and
   the person who follows the second line is usually the developer who wrote the agent rather
   than another traveller.

   Static, and deliberately so: no referral parameter, no per-view record, nothing logged. The
   deck's own rule is that a referral parameter is a tracker and we do not get one — so this
   costs us the ability to tell a footer-sourced visit from any other, which is the accepted
   price of the promise. Quiet by design: it sits at the end of Info, under the trip's own
   content, rather than competing with it. */
function originCard(){
  const el=document.createElement("div");
  el.className="origin-note";
  el.innerHTML=`Made with <a href="/" target="_blank" rel="noopener"><b>this trip, btw</b></a>
    &mdash; one private link for the whole trip.<br>
    Built by an AI assistant? <a href="/for-agents" target="_blank" rel="noopener">thistripbtw.us/for-agents</a>`;
  return el;
}

function exportCard(){
  const el=document.createElement("article");
  el.className="card settings"; el.dataset.id="__export";
  el.style.padding="12px 16px 14px";
  const dated=sorted().filter(s=>s.date).length, total=allStops.length;
  /* ONE DOOR, NOT A SECOND ONE. This card used to offer .ics and .csv itself, which made it the
     third of four surfaces that each knew about some of the ways out and none of which said so
     (§2v measured it: the Info tab's two, the settings card's zip and print, the Read panel's
     own download, and trip.kml/trip.gpx named nowhere a customer could see). It opens the take-it
     sheet now, so every format is listed in one place and the map files are findable at all.
     The counts stay HERE as well as in the sheet, because the useful moment for "3 of 15 stops
     have dates" is while you are looking at the stops. */
  el.innerHTML=`
    <b class="set-h">Take it with you</b>
    <p class="set-hint" style="margin:4px 0 12px">Your trip in a form something else can read &mdash; a
      calendar, a spreadsheet, a map file for Google Earth or Garmin, or the whole thing as a document.
      Made on your device; nothing is sent anywhere.</p>
    <div class="set-row">
      <button class="set-btn x-take">${icon("sheet",14)} Every way out &rarr;</button>
    </div>
    <p class="set-hint" style="margin-top:10px">${
      dated ? `${dated} of ${total} stop${total===1?"":"s"} have dates and will appear in the calendar. The spreadsheet has all ${total}.`
            : `No stops have dates yet, so the calendar file would be empty. The spreadsheet has all ${total}.`}</p>`;
  el.querySelector(".x-take").onclick=()=>openTake();
  return el;
}

function settingsCard(){
  const el=document.createElement("article");
  el.className="card settings"; el.dataset.id="__settings";
  const expiry = EXPIRES ? `<div class="set-expiry">This trip self-deletes on ${new Date(EXPIRES).toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"})} ($2.50 tier).</div>` : "";
  const editUrl=`${TRIP_BASE}/#k=${KEY}`;
  /* M2 (2026-07-30 audit): this block called the link in your hand "your edit link — anyone with
     it can add to the trip" and put copy, email-invite and Share next to it, unconditionally.
     For a member arriving on a personal link, KEY is their OWN phrase — the thing that *is* their
     identity here. Handing it on makes the recipient them: same handle, same attribution, and
     able to open the sealed drops left for them, which is the one thing D-047 went to real
     trouble to protect. The card was instructing people to give away the credential the rest of
     the system treats as private. `ME` was already in scope and simply never consulted. */
  const isMember = !!ME;
  const shareBlock = isMember ? `
      <div class="linkbox"><b>Your personal link — it is how the trip knows you are ${esc(ME)}</b>${esc(editUrl)}
        <button class="copybtn scopy">copy</button></div>
      <p class="set-hint"><b>Keep this one.</b> Anyone who opens it is you here — your posts, and
        the easter eggs left for you. To bring someone in, add them to the crew below and they
        get their own.</p>` : `
      <div class="linkbox"><b>Your edit link — anyone with it can add to the trip</b>${esc(editUrl)}
        <button class="copybtn scopy">copy</button></div>
      <input class="set-emails" placeholder="emails to invite (comma-separated)" aria-label="Emails to invite">
      <div class="set-row">
        <button class="set-btn s-email">${icon("mail",14)} Email the link</button>
        ${navigator.share?`<button class="set-btn s-share">Share…</button>`:""}
      </div>
      <p class="set-hint">For a view-only link, rotate the view password below.</p>`;
  el.innerHTML=`
    <div class="set-share">${shareBlock}
    </div>
    <div class="set-take">
      <b>Take it with you</b>
      <p class="set-hint" style="margin:4px 0 8px"><b>Going somewhere without signal? Download a
      copy first.</b> This page needs the internet; that file does not. It holds the whole trip —
      the data, a page you can read on any device with nothing installed, and your photos at the
      size you uploaded them. Yours at every tier: we are not going to charge you to hold your own
      trip.</p>
      <div class="set-row">
        <button class="set-btn s-export">${icon("sheet",14)} Download a copy</button>
        <button class="set-btn s-print">Print / PDF</button>
      </div>
    </div>
    <div class="set-crew">
      <b>The crew — give each person their own link</b>
      <div class="crew-list">${MEMBER_ROSTER.length?MEMBER_ROSTER.map(m=>`<span class="crew-chip">${esc(m.handle)}<button class="crew-x" data-id="${esc(m.id)}" data-handle="${esc(m.handle)}" title="Remove ${esc(m.handle)}" aria-label="Remove ${esc(m.handle)}">${icon("close",12)}</button></span>`).join(""):`<span class="set-hint" style="margin:0">Just the shared link so far. Add people to see who does what — and to replay each person's path.</span>`}</div>
      <div class="set-row">
        <input class="crew-name" placeholder="Add a person's name" maxlength="40" aria-label="Person's name">
        <button class="set-btn crew-add">+ Add &amp; send</button>
      </div>
      <div class="crew-out"></div>
    </div>
    <input class="note-title set-name" value="${esc(CONFIG.name||"")}" placeholder="Name this trip">
    <div class="set-row">
      <button class="set-btn rot-view">Rotate view password</button>
      <button class="set-btn rot-edit">Rotate edit password</button>
    </div>
    <div class="set-out"></div>
    <div class="set-row">
      <button class="set-btn export"><svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.8v11.8M7.9 11.5 12 15.6l4.1-4.1"/><path d="M4 15.4v3.1a1.7 1.7 0 0 0 1.7 1.7h12.6a1.7 1.7 0 0 0 1.7-1.7v-3.1"/></svg> Download (.json)</button>
      <button class="set-btn do-import"><svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.6V3.8M7.9 7.9 12 3.8l4.1 4.1"/><path d="M4 15.4v3.1a1.7 1.7 0 0 0 1.7 1.7h12.6a1.7 1.7 0 0 0 1.7-1.7v-3.1"/></svg> Import (.json)</button>
    </div>
    <input type="file" accept=".json,application/json" class="set-import" hidden aria-label="Import a trip file">
    ${expiry}
    <div class="set-row"><button class="set-btn danger del-trip">Delete this trip</button></div>`;
  el.querySelector(".set-name").addEventListener("change",e=>store.setName(e.target.value.trim()));
  el.querySelector(".rot-view").onclick=()=>rotate("view",el);
  el.querySelector(".rot-edit").onclick=()=>rotate("edit",el);
  el.querySelector(".export").onclick=exportTrip;
  el.querySelector(".do-import").onclick=()=>el.querySelector(".set-import").click();
  el.querySelector(".set-import").addEventListener("change",e=>{ if(e.target.files[0]){ importTrip(e.target.files[0]); e.target.value=""; } });
  el.querySelector(".del-trip").onclick=deleteTrip;
  el.querySelector(".scopy").onclick=e=>{ navigator.clipboard.writeText(editUrl).catch(()=>{}); e.target.textContent="copied"; };
  /* Guarded like `.s-share` below: the invite controls are absent for a member (M2), and an
     unguarded querySelector(...).onclick here would throw and take the whole settings card with
     it — the card builds in one innerHTML, so one null deref loses delete, rotate and export too. */
  const sEmail=el.querySelector(".s-email");
  if(sEmail) sEmail.onclick=()=>emailInvite(editUrl, (el.querySelector(".set-emails")||{value:""}).value.trim());
  const sh=el.querySelector(".s-share"); if(sh) sh.onclick=()=>shareLink(editUrl);
  /* The archive is built server-side and streamed. It is fetched with the phrase in the header
     like every other call rather than linked, because a plain <a href> cannot carry one — and
     putting the phrase in a URL is how phrases end up in history, referrers and shoulder shots. */
  const sx=el.querySelector(".s-export");
  if(sx) sx.onclick=()=>downloadTrip(sx);
  const sp=el.querySelector(".s-print"); if(sp) sp.onclick=()=>window.print();
  el.querySelector(".crew-add").onclick=()=>addPerson(el);
  el.querySelector(".crew-name").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); addPerson(el); } });
  el.querySelectorAll(".crew-x").forEach(b=>b.onclick=()=>removePerson(b.dataset.id,b.dataset.handle,b.closest(".crew-chip")));
  return el;
}
function exportTrip(){   // your data is yours — download the whole trip as JSON
  const data={ format:"thistripbtw.v1", exported:new Date().toISOString(),
    trip:{slug, name:CONFIG.name, tier:TIER, expires:EXPIRES, labels:CONFIG.labels},
    stops:livePins().filter(p=>p.kind==="stop").map(fromStopPin),
    posts:livePins().filter(p=>p.kind!=="stop").map(fromPostPin),
    notes:liveNotes().map(fromNote) };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=((CONFIG.name||"trip").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase()||"trip")+".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function importTrip(file){   // restore/merge a .json export into the current trip
  const reader=new FileReader();
  reader.onload=async ()=>{
    let data; try{ data=JSON.parse(reader.result); }catch(e){ alert("That file isn't valid JSON."); return; }
    const stops=Array.isArray(data.stops)?data.stops:[], posts=Array.isArray(data.posts)?data.posts:[], notes=Array.isArray(data.notes)?data.notes:[];
    if(!stops.length && !posts.length && !notes.length){ alert("No stops, posts, or notes found in that file."); return; }
    if(!confirm("Add "+stops.length+" stops, "+posts.length+" posts and "+notes.length+" notes to this trip?")) return;
    try{
      if(data.trip){
        if(data.trip.name) await store.setName(String(data.trip.name).slice(0,60));
        if(data.trip.labels) for(const t of ["truck","rental"]) if(data.trip.labels[t]) await store.setLabel(t, String(data.trip.labels[t]).slice(0,14));
      }
      for(const s of stops){ if(!isFinite(+s.lat)||!isFinite(+s.lng)) continue;
        await store.add({track:s.track==="rental"?"rental":"truck",date:s.date||"",place:String(s.place||""),lat:+s.lat,lng:+s.lng,lodging:s.lodging||"",notes:s.notes||"",here:false,mode:s.mode||"drive"}); }
      for(const p of posts){ if(!isFinite(+p.lat)||!isFinite(+p.lng)) continue;
        await store.addPost({ts:p.ts||Date.now(),type:["post","sealed","quest"].includes(p.type)?p.type:"post",author:p.author||CURRENT_NAME,lat:+p.lat,lng:+p.lng,caption:p.caption||"",photo:p.photo||"",spotify:p.spotify||"",openedBy:p.openedBy||[],claimedTeam:p.claimedTeam||"",claimedBy:p.claimedBy||""}); }
      for(const n of notes) await store.addNote({title:n.title||"",body:n.body||"",order:n.order||Date.now()});
      alert("Imported!");
    }catch(e){ alert("Import stopped: "+e.message); }
  };
  reader.readAsText(file);
}
// share helpers — mailto opens the user's OWN email client, so no recipient reaches us here
function emailInvite(url, emails){
  const s=encodeURIComponent("Join our trip — this trip, btw");
  const b=encodeURIComponent("You're invited to our trip on this trip, btw.\n\nOpen it here — the words in the link are the password, so keep it handy:\n"+url+"\n");
  window.location.href="mailto:"+(emails||"")+"?subject="+s+"&body="+b;
}
async function shareLink(url){
  if(navigator.share){ try{ await navigator.share({title:"this trip, btw", text:"Join our trip:", url}); return; }
    catch(e){ if(e && e.name==="AbortError") return; } }
  try{ await navigator.clipboard.writeText(url); alert("Link copied — paste it wherever you like."); }catch(e){}
}
async function rotate(which,el){
  const warn = which==="edit"
    ? "Rotate the EDIT password? The old one stops working immediately — everyone who edits needs the new words."
    : "Rotate the VIEW password? The old one stops working immediately.";
  if(!confirm(warn)) return;
  try{
    const r=await api("trip/rotate",{method:"POST",body:JSON.stringify({which})});
    const token=r[which+"_token"];
    const url=`${TRIP_BASE}/#k=${token}`;   // D-021 path-based
    const out=el.querySelector(".set-out");
    out.innerHTML=`<div class="linkbox"><b>New ${which} password — old one stops working now</b>
      <b style="font-size:16px;color:var(--ink)">${esc(token)}</b>${esc(url)}
      <button class="copybtn">copy link</button></div>`;
    out.querySelector(".copybtn").onclick=()=>{ navigator.clipboard.writeText(url); out.querySelector(".copybtn").textContent="copied"; };
    if(which==="edit"){ KEY=token; localStorage.setItem("ttb_key_"+slug,KEY); }
  }catch(e){ alert("Couldn't rotate: "+e.message); }
}
// D-023: add a person → mint their personal link (shown ONCE; server stores only the hash).
// The invite leaves from the user's own mail client, so no address is sent to us or kept for it.
async function addPerson(el){
  const inp=el.querySelector(".crew-name"); const handle=inp.value.trim();
  const out=el.querySelector(".crew-out");
  if(!handle){ inp.focus(); return; }
  out.textContent="Adding…";
  try{
    const r=await api("trip/members",{method:"POST",body:JSON.stringify({handle})});
    inp.value="";
    out.innerHTML=`<div class="linkbox"><b>${esc(r.handle)}’s personal link${navigator.share?" — the share sheet is open; this is the same link if you dismissed it":" — send it just to them"}</b>${esc(r.url)}
      <div class="set-row"><button class="set-btn crew-mail">${icon("mail",14)} Email ${esc(r.handle)}</button>${navigator.share?`<button class="set-btn crew-share">Share…</button>`:""}<button class="copybtn crew-copy">copy link</button></div>
      <p class="set-hint" style="margin-top:6px">Shown once. ${esc(r.handle)} taps it and they’re in as themselves — nothing to type. Their stops and posts show up under their name.</p></div>`;
    out.querySelector(".crew-copy").onclick=e=>{ navigator.clipboard.writeText(r.url).catch(()=>{}); e.target.textContent="copied"; };
    out.querySelector(".crew-mail").onclick=()=>emailInvite(r.url,"");
    /* THE OS SHARE SHEET ON THE PERSONAL LINK. `shareLink()` has existed in this file the whole
       time and the general edit URL already used it; the minted crew link — the one you actually
       hand to a person standing next to you — offered only Email and Copy. It also happens to be
       the offline answer: navigator.share reaches AirDrop, which needs no internet at all. */
    const cs=out.querySelector(".crew-share"); if(cs) cs.onclick=()=>shareLink(r.url);
    /* AND HAND IT OVER IN THE SAME GESTURE (§2bl). Permission measured 7 interactions — the
       longest of the four flows, and the LOWEST navigation share at 29%, so it was never hidden,
       it was simply long. The one step that was pure ceremony was minting and handing over being
       two separate taps: nothing happens between them, and the second one is the whole point of
       the first. So the share sheet opens on its own.
       IT CAN ONLY HELP, NEVER HURT, AND THAT IS WHY IT IS SAFE TO TRY. `navigator.share()` needs
       transient activation and this call sits after an `await`, so a browser is entitled to refuse
       it — Chrome enforces that strictly. When it refuses, or when the person dismisses the sheet,
       the link box above is exactly what it was before and Email/Share/copy are all still there.
       Failure costs one tap; success saves one. DELIBERATELY NOT `shareLink()`, whose fallback
       writes to the clipboard and alerts: doing that unasked, because a browser silently declined,
       would be a surprise rather than a convenience. */
    if(navigator.share){
      try{ await navigator.share({title:"this trip, btw", text:"Join our trip:", url:r.url}); }
      catch(e){}
    }
  }catch(e){ out.textContent="Couldn’t add "+handle+": "+e.message; }
}
// revoke a person: their personal link stops working; stops they already added stay (attribution kept)
async function removePerson(id, handle, chipEl){
  if(!confirm("Remove "+handle+"? Their personal link stops working right away. Anything they already added stays on the trip.")) return;
  try{
    await api("trip/members/"+id,{method:"DELETE"});
    if(chipEl) chipEl.remove();
    MEMBER_ROSTER=MEMBER_ROSTER.filter(m=>m.id!==id);
    MEMBERS=MEMBERS.filter(h=>h!==handle);
  }catch(e){ alert("Couldn’t remove "+handle+": "+e.message); }
}
async function deleteTrip(){
  const w=prompt('This erases the whole trip and every photo — permanently.\nType  delete  to confirm.');
  if((w||"").trim().toLowerCase()!=="delete") return;
  try{
    await api("trip",{method:"DELETE"});
    localStorage.removeItem("ttb_key_"+slug);
    /* "Gone. All of it." is a promise, and the offline copy is part of "all of it". */
    clearTripCache();
    document.body.innerHTML='<div style="position:fixed;inset:0;background:#1E3F66;color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:30px;letter-spacing:.08em;text-transform:uppercase">Gone. All of it.</div>';
  }catch(e){ alert("Couldn't delete: "+e.message); }
}

function postCard(p){
  const el=document.createElement("article");
  const isQuest =p.type==="quest";
  const isSealed=p.type==="sealed";
  /* ME is the handle the SERVER says this token belongs to — a personal link (D-023). It is
     the only identity that counts for a sealed drop now; CURRENT_NAME is a display name
     anyone can type and the server ignores it. */
  /* D-050: a near-only post is locked by the same machinery as a sealed drop — you have to
     have been there — but it is not private. Everyone on the trip gets it, once they have
     stood where it happened. */
  const isNear = !isSealed && !!p.nearOnly;
  const locked = isSealed || isNear;
  const mine=locked && !!ME && p.author===ME;
  const opened=!locked || mine || (!!ME && (p.openedBy||[]).includes(ME));
  el.className="card post"+(isQuest?" quest":""); el.dataset.id="p_"+p.id;
  const when=p.ts?new Date(p.ts).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"";
  const kind=isQuest?"Quest":isSealed?"Easter egg":isNear?"Was there?":"";

  if(!opened){
    el.innerHTML=`
      <div class="post-meta">${esc(p.author||"")} · ${kind}${when?" · "+when:""}</div>
      <div class="sealed-box">
        <div class="env">${icon("mail",30)}</div>
        ${ME
          ? `<p>${p.radiusMi != null
               ? `Stays shut until you're within ${fmtRadius(p.radiusMi)} of the pin.`
               : isNear
               ? `Left for whoever comes here. Opens when you're standing at the pin.`
               : `Stays shut until you're within ${SEAL_RADIUS_MI} miles of the pin.`}</p>
             <button class="openbtn">Am I close enough?</button>`
          : `<p>This one opens for a person, and this link doesn't say who you are.
               Ask whoever set up the trip for your own link.</p>`}
      </div>
      <div class="card-foot"></div>`;
    const ob=el.querySelector(".openbtn");
    if(ob) ob.onclick=()=>{
      /* The server does the distance check and the append. The browser only says where it is;
         it no longer decides whether that is close enough, and it cannot name who opened it. */
      ob.disabled=true; ob.textContent="Checking…";
      navigator.geolocation.getCurrentPosition(async pos=>{
        try{
          await api("trip/pins/"+p.id+"/open",{method:"POST",
            body:JSON.stringify({lat:pos.coords.latitude, lng:pos.coords.longitude})});
          await sync();
        }catch(e){
          alert(e.message||"Couldn't open it yet.");
          ob.disabled=false; ob.textContent="Am I close enough?";
        }
      },()=>{ alert("Couldn't get your location — allow location access and try again.");
              ob.disabled=false; ob.textContent="Am I close enough?"; });
    };
    return el;
  }

  const emb=spotifyEmbed(p.spotify);
  const claimHTML = isQuest ? (p.claimedTeam
    ? `<div class="claimed-tag" style="color:${p.claimedTeam==="truck"?"var(--truck-deep)":"var(--rental-deep)"}">${esc(TRACK_LABELS[p.claimedTeam]||p.claimedTeam)} · claimed by ${esc(p.claimedBy||"")}</div>`
    : `<div class="claim-row"><button class="ct">${esc(TRACK_LABELS.truck)} claims it</button><button class="cr">${esc(TRACK_LABELS.rental)} claims it</button></div>`)
    : "";
  const capPH = isQuest ? "Set the challenge" : isSealed ? "Write the secret — only openers see it" : "Say something about this spot";
  /* Offer only what the tier actually takes. Accepting a video on a photo-only tier would let
     someone pick a 200 MB file, wait for the upload, and then be told no (D-088). */
  /* F-5: a viewer was shown an empty mm/dd/yyyy input and a "Paste a Spotify link" placeholder
     on every post. `body.readonly` only set pointer-events:none, so the form scaffolding still
     rendered — it read as a broken editor rather than as somebody's trip. A set date now renders
     as text; an empty one renders as nothing; and the tier note ("photos are on the $5 tier")
     is for the buyer, not for the person they shared it with. */
  const ro = ACCESS !== "edit";
  const dateISO = p.ts ? new Date(p.ts).toLocaleDateString("en-CA") : "";
  const dateCtl = ro
    ? (p.ts ? `<span class="post-when">${esc(new Date(p.ts).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}))}</span>` : "")
    : `<input type="date" class="post-date" value="${dateISO}">`;
  const photoAccept = CAN_VIDEO ? "image/*,video/mp4,video/quicktime,video/webm" : "image/*";
  const photoCtl = CAN_PHOTO
    ? `<button class="chipbtn addphoto edit-only">${p.photo ? "Change photo" : (CAN_VIDEO ? "Add photo / video" : "Add photo")}</button>`
    : `<div class="tier-note">Photos are on the $5 tier and up — <a href="https://thistripbtw.us/#pricing">keep it</a></div>`;
  el.innerHTML=`
    ${p.photo?renderMedia(p.photo,p):""}
    <div class="post-meta">${esc(p.author||"")}${kind?" · "+kind:""}${when?" · "+when:""}</div>
    <textarea class="post-caption" placeholder="${capPH}">${esc(p.caption)}</textarea>
    ${claimHTML}
    ${emb?`<button type="button" class="spot-chip" data-embed="${emb}"><svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4.8 19 12 8 19.2z"/></svg> song attached — tap to play</button>`:""}
    <div class="post-actions">
      ${ro ? "" : photoCtl}
      ${dateCtl}
      ${ro ? "" : `<input class="spot-in" placeholder="Paste a Spotify link" value="${esc(p.spotify)}">`}
      ${ro ? "" : `<input type="file" accept="${photoAccept}" hidden>`}
    </div>
    ${(!ro && (isSealed || p.nearOnly)) ? `
    <div class="fence-row edit-only">
      <label for="fence-${p.id}">Opens within</label>
      <select class="fence" id="fence-${p.id}">
        ${FENCES.map(f=>`<option value="${f[0]}"${fenceSel(p,f[0])?" selected":""}>${f[1]}</option>`).join("")}
      </select>
      <span class="fence-why">${p.radiusMi!=null
        ? "Set for this one."
        : (isSealed ? `Default — ${SEAL_RADIUS_MI} miles.` : "Default — you have to be at the pin.")}</span>
    </div>` : ""}
    <div class="card-foot">${(!isQuest && !isSealed && (!ME || p.author===ME || !p.author))
      ? `<button class="nearbtn edit-only ${p.nearOnly?"on":""}" aria-pressed="${!!p.nearOnly}"
           title="Only people who come here can read it">${icon("mail",13)}${p.nearOnly?"Was there? on":"Was there?"}</button>`
      : ""}<button class="del edit-only">Remove</button></div>`;
  const cap=el.querySelector(".post-caption");
  const grow=()=>{ cap.style.height="auto"; cap.style.height=cap.scrollHeight+"px"; };
  requestAnimationFrame(grow); cap.addEventListener("input",grow);
  cap.addEventListener("change",e=>store.updatePost(p.id,{caption:e.target.value}));
  /* GUARDED, and it was crashing the READ-ONLY path. `.spot-in` renders only when `!ro` (see the
     post-actions block above), so on a view link this querySelector returned null and the
     addEventListener threw — killing postCard, and with it every post on the page, for exactly
     the visitor a shared link is FOR. Found on Peter's phone via ?pmdiag=1 on the public demo,
     which is a VIEW phrase and has two posts.
     Same class the settings card already carries a note about: an unguarded querySelector on a
     control that is conditionally rendered. The others here (`.fence`, photo input) were already
     guarded; this one was missed. */
  const spot = el.querySelector(".spot-in");
  if(spot) spot.addEventListener("change",e=>store.updatePost(p.id,{spotify:e.target.value.trim()}));
  const fence=el.querySelector(".fence");
  if(fence) fence.addEventListener("change",e=>{
    const v=e.target.value;
    store.updatePost(p.id,{radiusMi: v==="" ? null : parseFloat(v)});
  });
  /* GUARDED for the same reason as `.spot-in` above, and this one would have made that fix look
     like it worked while the page still crashed three lines later: `dateCtl` renders a plain
     <span> on a read-only view and the date INPUT only when editing. Two instances of one bug in
     one function, on the path a shared link takes. */
  const pdate = el.querySelector(".post-date");
  if(pdate) pdate.addEventListener("change",e=>{
    if(!e.target.value) return;
    const [y,mo,d]=e.target.value.split("-").map(Number);
    const t=new Date(p.ts||Date.now()); t.setFullYear(y,mo-1,d);
    store.updatePost(p.id,{ts:t.getTime()});
  });
  const chip=el.querySelector(".spot-chip");
  if(chip) chip.onclick=()=>{ const w=document.createElement("div"); w.className="spot-wrap";
    w.innerHTML=`<iframe src="${chip.dataset.embed}" loading="lazy" allow="encrypted-media"></iframe>`; chip.replaceWith(w); };
  const addBtnEl=el.querySelector(".addphoto"), fileIn=el.querySelector('input[type=file]');
  if(addBtnEl && fileIn){
    addBtnEl.onclick=()=>fileIn.click();
    fileIn.addEventListener("change",async e=>{
      const f=e.target.files[0]; if(!f) return;
      addBtnEl.textContent="Uploading…";
      try{ const url=await store.uploadPhoto(f); await store.updatePost(p.id,{photo:url}); }
      catch(err){
        /* TWO BUGS LIVED IN THIS LINE and both bite hardest on the road this product is for.
           (1) It was `alert("Upload failed — " + err.message)`. On a dead connection `fetch`
           rejects with a TypeError, so the customer standing in a canyon got a BLOCKING modal
           reading "Upload failed — Failed to fetch". §2ad's wrapper already tells them the human
           version, so this now stays quiet for the network case and says the useful thing for
           everything else, through `say()` like the rest of the page rather than a modal.
           A photo is the one write that CANNOT be queued — a File will not go in localStorage
           (D-155) — so "try again when you have bars" is the whole truth here.
           (2) The button was relabelled "Add photo / video" on failure REGARDLESS of tier, so a
           failed upload on a $5 keep trip started offering video it cannot do. It goes back to
           whatever it actually said, which is the same expression that rendered it. */
        const msg = String((err && err.message) || err || "");
        const offline = !navigator.onLine
          || /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
        if(!offline && msg !== "auth" && !(err && err.queued))
          try{ say("Photo not added — " + (msg || "something went wrong"), 5000); }catch(_){}
        addBtnEl.textContent = p.photo ? "Change photo" : (CAN_VIDEO ? "Add photo / video" : "Add photo");
      }
    });
  }
  { const nb=el.querySelector(".nearbtn");
    if(nb) nb.onclick=()=>{ if(!READONLY) store.updatePost(p.id,{nearOnly:!p.nearOnly}); }; }
  el.querySelector(".del").onclick=()=>{ if(confirm("Remove this post?")) store.removePost(p.id); };
  if(isQuest && !p.claimedTeam){
    el.querySelector(".ct").onclick=()=>{ if(!READONLY) store.updatePost(p.id,{claimedTeam:"truck", claimedBy:CURRENT_NAME}); };
    el.querySelector(".cr").onclick=()=>{ if(!READONLY) store.updatePost(p.id,{claimedTeam:"rental", claimedBy:CURRENT_NAME}); };
  }
  return el;
}
function renderMedia(url, p){
  const alt = esc((p && p.caption) || (p && p.author ? ("Photo from "+p.author) : "Trip photo"));
  return /\.(mp4|mov|webm)$/i.test(url)
    ? `<video class="post-photo" src="${esc(url)}" controls playsinline preload="metadata" aria-label="${alt}"></video>`
    : `<img class="post-photo" src="${esc(url)}" alt="${alt}">`;
}

function focusPost(id){
  if(tab!=="posts") document.querySelector('#tabs .tab[data-tab="posts"]').click();
  setSheet("half");
  requestAnimationFrame(()=>{
    const el=listEl.querySelector(`[data-id="p_${id}"]`);
    if(!el) return;
    el.scrollIntoView(listEl.classList.contains("rail")
      ? {behavior:"smooth",inline:"center",block:"nearest"}
      : {behavior:"smooth",block:"center"});
    el.classList.add("focus"); setTimeout(()=>el.classList.remove("focus"),1600);
  });
}
function focusCard(id){
  if(tab!=="route") document.querySelector('#tabs .tab[data-tab="route"]').click();
  setSheet("half");
  requestAnimationFrame(()=>{
    const el=listEl.querySelector(`[data-id="${id}"]`);
    if(!el) return;
    /* F-10: rail mode scrolls HORIZONTALLY, so `block:"center"` centres the wrong axis and the
       inline axis falls back to "nearest" — which parks the card you just tapped flush against
       the viewport edge, clipped. The post handler above already gets this right; this one is
       the same list in the same two modes and did not. */
    el.scrollIntoView(listEl.classList.contains("rail")
      ? {behavior:"smooth",inline:"center",block:"nearest"}
      : {behavior:"smooth",block:"center"});
    el.classList.add("focus"); setTimeout(()=>el.classList.remove("focus"),1600);
  });
}

/* ── Ask: describe the trip in words, get legs ──────────────────────────────
   The transcript lives in this array and nowhere else — not localStorage, not the
   server (lib/chat.php holds it for one request and hands it back). Closing the tab
   or the tab bar keeps it; closing the page forgets it, which is the promise.

   Geocoding happens HERE, in the browser (D-039). The server never resolves a place
   name; when it needs coordinates it says so and we answer. */
let chatMsgs = [], chatBusy = false, chatNote = "";

function drawChat(){
  listEl.innerHTML="";                 // sendChat() redraws mid-flight; without this each
  listEl.classList.remove("rail");     // redraw stacked another panel on top of the last
  const wrap=document.createElement("div"); wrap.className="chatwrap";
  wrap.innerHTML =
    `<div class="chat-log" id="chatLog"></div>
     <form class="chat-in" id="chatForm">
       <label class="vh" for="chatText">Describe part of your trip</label>
       <textarea id="chatText" rows="2" placeholder="drive to portland thursday, mel flies in saturday"
         ${chatBusy?"disabled":""}></textarea>
       <button class="signbtn chat-send" type="submit" ${chatBusy?"disabled":""}>${chatBusy?"…":"Send"}</button>
     </form>
     <p class="chat-foot">Your conversation isn't stored — it lives in this tab only.</p>`;
  listEl.appendChild(wrap);

  const log=wrap.querySelector("#chatLog");
  if(!chatMsgs.length && !chatNote){
    log.innerHTML='<div class="chat-hint">Tell me the trip the way you\'d tell a friend. '
      + 'I\'ll add the legs — you can fix anything I get wrong.</div>';
  }
  chatMsgs.forEach(m=>{
    const t = typeof m.content==="string" ? m.content
            : (m.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(" ");
    if(!t.trim()) return;                       // tool traffic isn't for the reader
    const b=document.createElement("div");
    b.className="chat-b "+(m.role==="user"?"me":"them");
    b.textContent=t; log.appendChild(b);
  });
  if(chatNote){ const n=document.createElement("div"); n.className="chat-note"; n.textContent=chatNote; log.appendChild(n); }
  log.scrollTop=log.scrollHeight;

  wrap.querySelector("#chatForm").onsubmit=e=>{ e.preventDefault(); sendChat(); };
  const ta=wrap.querySelector("#chatText");
  if(!chatBusy) ta.focus();
  ta.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendChat(); } });
}

async function askChat(body){
  const r=await fetch(`/${slug}/api/trip/chat`,{
    method:"POST", headers:{"content-type":"application/json","authorization":"Bearer "+KEY},
    body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({error:"the assistant didn't answer"}));
  if(!r.ok) throw new Error(d.error||"that didn't work");
  return d;
}

async function sendChat(){
  const ta=document.getElementById("chatText"); if(!ta) return;
  const text=ta.value.trim(); if(!text||chatBusy) return;
  chatMsgs.push({role:"user",content:text});
  chatBusy=true; chatNote="thinking…"; drawChat();
  try{
    let d=await askChat({messages:chatMsgs});
    // The server pauses rather than geocoding. Resolve what it asked for and resume.
    for(let round=0; round<3 && d.needs_places && d.needs_places.length; round++){
      chatNote="finding "+d.needs_places.join(", ")+"…"; drawChat();
      const places={};
      for(const name of d.needs_places){
        const hits=await geocode(name);
        // hits[0] is not reliably the right continent ("Reno" hits Germany first) — prefer
        // the candidate nearest the trip we already have.
        if(hits && hits.length){
          let c=allStops.length
            ? {lat:allStops.reduce((a,s)=>a+ +s.lat,0)/allStops.length,
               lng:allStops.reduce((a,s)=>a+ +s.lng,0)/allStops.length} : null;
          if(!c){ try{ const m=map.getCenter(); c={lat:m.lat,lng:m.lng}; }catch(e){} }
          let b=hits[0];
          if(c){ let bd=Infinity; for(const h of hits){ const d=nearDist(c.lat,c.lng,+h.lat,+h.lon); if(d<bd){bd=d;b=h;} } }
          else  { for(const h of hits) if((+h.importance||0)>(+b.importance||0)) b=h; }
          places[name]={lat:+b.lat, lng:+b.lon};
        }
        await new Promise(r=>setTimeout(r,1100));   // Nominatim asks for ~1 req/sec
      }
      if(!Object.keys(places).length){
        chatNote="I couldn't place "+d.needs_places.join(", ")+" — try a nearby town?"; break;
      }
      d=await askChat({messages:d.messages, places});
    }
    chatMsgs=d.messages||chatMsgs;
    chatNote=(d.added&&d.added.length) ? "added "+d.added.join(", ") : "";
    if(d.added&&d.added.length) await sync();       // pull the new legs onto the map
  }catch(err){
    chatNote=err.message||"that didn't work";
  }finally{
    chatBusy=false; drawChat();
  }
}

document.querySelectorAll("#tabs .tab").forEach(t=>{
  t.onclick=()=>{
    tab=t.dataset.tab;
    document.querySelectorAll("#tabs .tab").forEach(x=>{ x.classList.toggle("on",x===t);
      x.setAttribute("aria-selected", x===t ? "true" : "false"); });
    document.getElementById("legendRow").style.display = tab==="route" ? "" : "none";
    document.getElementById("addBtn").hidden = (tab==="ask");   // nothing to drop on a map here
    document.getElementById("addBtn").textContent = tab==="route" ? "+ Stop" : tab==="info" ? "+ Note" : "+ Post";
    if(tab==="ask" && sheetState==="peek") setSheet("half");
    drawList();
    if(tab==="info" && sheetState==="peek") setSheet("half");
  };
});

/* ── legend: toggles + editable labels ─────────────────── */
function applyLabels(){
  document.querySelectorAll("[data-tracklabel]").forEach(el=>{
    const label = TRACK_LABELS[el.dataset.tracklabel];
    if(!label) return;
    /* 🔴 `textContent =` REPLACES EVERY CHILD, and `buildLegend()` puts the track letter in here
       as a `<span class="tl">`. This runs after it, so it was silently deleting the legend — the
       map drew A4 and B4 with nothing on screen to read them against, which is worse than the
       duplicate 4s it replaced. Two functions writing the same element and the later one winning.
       Hold the letter, rewrite the text, put it back. */
    const tl = el.querySelector(".tl");
    el.textContent = label;
    if(tl){
      el.insertBefore(document.createTextNode(" "), el.firstChild);
      el.insertBefore(tl, el.firstChild);
    }
  });
}
function buildLegend(){
  const row=document.querySelector(".legend");
  /* Only show the vehicle filter once there is something to filter. A trip where everyone
     travelled together — most trips, and every trip on its first leg — has no second vehicle,
     and offering one is a question nobody asked. The second track still gets created from the
     "+ Stop" flow when a trip actually needs it; this only stops advertising it beforehand. */
  const used = ["truck","rental"].filter(t => allStops.some(s => (s.track||"truck") === t));
  const ev = document.getElementById("editVeh");
  if (used.length < 2) {
    row.innerHTML = ""; row.hidden = true;
    if (ev) ev.hidden = true;      // nothing to rename yet — a lone pencil is a puzzle
    return;
  }
  row.hidden = false;
  if (ev) ev.hidden = false;
  /* THE CHIPS ARE THE LEGEND for the map's A4 / B4 pins, so they carry the same letter and it
     comes from the same place — `used`, in order. A letter on the map with nothing to read it
     against would be worse than the duplicate it replaces. */
  const lettered = document.body.classList.contains("tracks") && used.length > 1;
  row.innerHTML = used.map((t,i)=>
    `<button class="track-chip ${t} ${hidden[t]?"dim":""}" data-track="${t}" data-tracklabel="${t}">${lettered?'<span class="tl">'+String.fromCharCode(65+(i%26))+'</span> ':''}${esc(TRACK_LABELS[t])}</button>`
  ).join("");
  row.querySelectorAll(".track-chip").forEach(ch=>{
    ch.onclick=()=>{ const t=ch.dataset.track;
      hidden[t]=!hidden[t]; ch.classList.toggle("dim",hidden[t]);
      drawMap(); drawList();
    };
  });
  applyLabels();
}
buildLegend();
let editingVeh=false;
document.getElementById("editVeh").onclick=()=>{
  const row=document.querySelector(".legend");
  editingVeh=!editingVeh;
  if(editingVeh){
    document.getElementById("editVeh").textContent="✓";
    row.innerHTML = ["truck","rental"].map(t=>
      `<input class="veh-in ${t}" data-t="${t}" maxlength="14" value="${esc(TRACK_LABELS[t])}">`
    ).join("");
    row.querySelectorAll("input").forEach(i=>{
      i.addEventListener("change",e=>{
        const v=e.target.value.trim()||TRACK_LABELS[i.dataset.t];
        TRACK_LABELS[i.dataset.t]=v;
        store.setLabel(i.dataset.t,v);
      });
    });
    row.querySelector("input").focus();
  }else{
    document.getElementById("editVeh").innerHTML=icon("pencil",16);
    buildLegend(); drawList();
  }
};

/* ── replay controls ───────────────────────────────────── */
document.getElementById("playBtn").onclick=tapPlay;
/* #replayBtn was the reveal step — it opened the scrubber and then asked for a second tap
   to actually play. The header play does both, so the old trigger is retired rather than
   left as a second way to do the same thing. Its markup stays hidden for one release in
   case the treatment is reverted; syncReplayBtn still keeps it correct if it comes back. */
const _rb=document.getElementById("replayBtn"); if(_rb) _rb.remove();
document.getElementById("replayClose").onclick=closeReplay;
document.getElementById("replayPlay").onclick=playReplay;
document.getElementById("replaySlider").addEventListener("input",e=>{ stopPlay(); setReplay(e.target.value); });
document.querySelectorAll("#replayMode button").forEach(b=>b.onclick=()=>setReplayBy(b.dataset.by));

/* ── add stop / post: pick mode, tap map ───────────────── */
const banner=document.getElementById("dropBanner");
/* ── "HERE": ONE TAP ADDS A STOP WHERE YOU ARE (§2bc) ─────────────────────────────────────
   The field finding, from the road: too much friction to change the plan. Adding a stop meant
   choosing add-mode, choosing a track, then finding your own position on the map and tapping it —
   and the map already knew none of those things while the phone knew all of them.

   USER-INITIATED GEOLOCATION, WHICH IS WHY THIS DOES NOT TOUCH §2z-b. That decision is about
   geolocating WITHOUT asking, silently, to place somebody before they act. This asks, because the
   person pressed a button labelled Here — and the permission prompt is the browser's, once, on
   their terms. Nothing is stored about anyone who declines, and `getCurrentPosition` is already
   how the sealed-drop check and the post placer work.

   IT REUSES THE TAP PATH'S RULES ON PURPOSE. Same track choice (the one already in use, else the
   truck), same inherited date, same "drop the pin now, name it a beat later" order. A second way
   to add a stop that ordered them differently would put the rail and the map into an argument
   about what comes after what, which is D-037's whole job to prevent. */
async function addStopHere(){
  if(READONLY) return;
  if(!navigator.geolocation){ alert("This browser will not share a location."); return; }
  const fab=document.getElementById("fab");
  const said=m=>{ if(fab) fab.title=m; };
  said("Finding you…");
  navigator.geolocation.getCurrentPosition(async pos=>{
    try{
      const lat=pos.coords.latitude, lng=pos.coords.longitude;
      /* The same two lines the map tap runs, so the two paths cannot drift. */
      const inUse=["truck","rental"].filter(t=>allStops.some(s=>(s.track||"truck")===t));
      const track = addTrack || (inUse.length===1 ? inUse[0] : "truck");
      const last = sorted().filter(s=>s.track===track).pop();
      const wasEmpty = !allStops.length;
      setSheet("half");
      const res = await store.add({track, date:last?.date||"", place:"Here", lat, lng,
                                   lodging:"", notes:"", here:false});
      revName(lat,lng).then(nm=>{ if(!res || !res.id) return;
        if(nm) store.update(res.id,{place:nm}); else nameLater(res.id, lat, lng); });
      try{ map.setView([lat,lng], Math.max(map.getZoom(), 13)); }catch(e){}
      if(res && res.id) focusCard(res.id);
      if(wasEmpty && typeof maybeShareNudge==="function") maybeShareNudge();
      said("Stop added where you are");
    }catch(e){
      /* §2ad: a write that fails now says so — this one runs on a road with one bar. */
      said("Could not add it — " + ((e&&e.message)||"try again"));
      alert("That stop did not save: " + ((e&&e.message)||"unknown error"));
    }
  }, err=>{
    /* A refused permission is a choice, not a failure, and the fallback is the thing that already
       works. Naming it means the button never dead-ends. */
    said("No location — tap the map to place it instead");
    alert(err && err.code===1
      ? "Location is off for this site. You can still tap the map to place a stop."
      : "Could not get a location just now. Tap the map to place a stop.");
  }, {enableHighAccuracy:true, timeout:12000, maximumAge:30000});
}

let addMode=null, addTrack=null;
function showBanner(mode){
  addMode=mode;
  document.getElementById("dropStop").hidden = mode!=="stop";
  document.getElementById("dropPost").hidden = mode!=="post";
  banner.classList.add("show"); setSheet("peek");
}
function hideBanner(){ addMode=null; addTrack=null; banner.classList.remove("show"); }

document.getElementById("addBtn").onclick=()=>{
  if(READONLY) return;
  if(tab==="info"){
    store.addNote({title:"New note", body:"", order:Date.now()});
    setSheet("full");
    return;
  }
  if(tab==="posts"){ showBanner("post"); return; }
  /* Default to the track already in use, and only ask which vehicle once a trip actually
     has two — otherwise the first question a new trip asks is one it can answer itself. */
  const inUse = ["truck","rental"].filter(t => allStops.some(s => (s.track||"truck") === t));
  addTrack = inUse.length === 1 ? inUse[0] : "truck";
  document.querySelectorAll("#dropStop .row").forEach(r=>{
    if (r.querySelector('[data-track="truck"]')) r.hidden = (allStops.length === 0);
  });
  syncBanner(); showBanner("stop");
};
banner.querySelectorAll('[data-track="cancel"]').forEach(b=>b.onclick=hideBanner);
banner.querySelectorAll('#dropStop [data-track]').forEach(b=>{
  if(b.dataset.track==="cancel") return;
  b.onclick=()=>{ addTrack=b.dataset.track; syncBanner(); };
});
function syncBanner(){
  banner.querySelectorAll("#dropStop .row button").forEach(b=>
    b.classList.toggle("sel",b.dataset.track===addTrack));
}
let postKind="post";
document.querySelectorAll("#postKindRow button").forEach(b=>{
  b.onclick=()=>{ postKind=b.dataset.kind;
    document.querySelectorAll("#postKindRow button").forEach(x=>x.classList.toggle("sel",x===b));
    navigator.geolocation.getCurrentPosition(
      pos=>{ map.setView([pos.coords.latitude,pos.coords.longitude],9);
             createPost(pos.coords.latitude,pos.coords.longitude); },
      ()=>{ document.getElementById("postHint").textContent="No location — tap the map to place it."; }
    );
  };
});
function createPost(lat,lng){
  const base={ts:Date.now(), type:postKind, author:CURRENT_NAME, lat, lng, caption:"", photo:"", spotify:""};
  if(postKind==="sealed"){ base.openedBy=[]; }
  if(postKind==="quest"){ base.claimedTeam=""; base.claimedBy=""; }
  store.addPost(base);
  hideBanner();
  if(tab!=="posts") document.querySelector('#tabs .tab[data-tab="posts"]').click();
  setSheet("full");
}
map.on("click",async e=>{
  if(READONLY) return;
  const lat=e.latlng.lat, lng=e.latlng.lng;
  if(addMode==="post"){ createPost(lat,lng); return; }
  if(addMode!=="stop"||!addTrack) return;
  const track=addTrack, last=sorted().filter(s=>s.track===track).pop();
  const wasEmpty=!allStops.length;                   // the trip had nothing to share until now
  hideBanner(); setSheet("half");                    // drop the pin now; auto-name it a beat later
  const res=await store.add({track,date:last?.date||"",place:"New stop",lat,lng,lodging:"",notes:"",here:false});
  revName(lat,lng).then(nm=>{ if(!res || !res.id) return;
        if(nm) store.update(res.id,{place:nm}); else nameLater(res.id, lat, lng); });
  if(wasEmpty) maybeShareNudge();
});

/* ── bottom sheet drag ─────────────────────────────────── */
const sheet=document.getElementById("sheet");
/* SHUT at rest. A shared link opens on the map, which is the thing worth looking at; the pill
   says whose trip it is and that there is a list behind it. */
let sheetState="shut";
function setSheet(st){ sheetState=st;
  sheet.classList.remove("half","full","shut");
  if(st!=="peek") sheet.classList.add(st);
  document.body.classList.toggle("sheet-shut", st==="shut");
  const ob=document.getElementById("openSheet");
  if(ob){ ob.setAttribute("aria-expanded", st==="shut" ? "false" : "true");
          sheet.setAttribute("aria-hidden", st==="shut" ? "true" : "false"); }
  if(st!=="shut") sheet.removeAttribute("aria-hidden");
  /* The chips clear whatever is at the bottom, and what is at the bottom just changed. They
     are drawn before the pill is displayed on first paint, so without this the two bottom
     chips spend the first frame — and then forever — tucked behind it. */
  if(typeof drawEdgeChips === "function") setTimeout(drawEdgeChips, 0);
}
/* What the pill says when the sheet is away: the trip's name and how much is in it. Without
   this the map is anonymous and there is nothing to suggest a list exists. */
function syncOpenPill(){
  const ob=document.getElementById("openSheet"); if(!ob) return;
  ob.querySelector(".nm").textContent=(CONFIG.name||"").trim()||"This trip";
  const n=allStops.length, p=allPosts.length;
  ob.querySelector(".ct").textContent=n ? `${n} stop${n===1?"":"s"}${p?` · ${p} post${p===1?"":"s"}`:""}` : "";
  ob.setAttribute("aria-label",`Open the trip: ${ob.querySelector(".nm").textContent}, ${ob.querySelector(".ct").textContent||"empty"}`);
}
document.getElementById("openSheet").addEventListener("click",()=>{ setSheet("peek"); syncGrab(); });
/* Apply the resting state for real. `let sheetState="shut"` only names it — the class that
   moves the sheet and the body class the pill keys off both come from setSheet, and this is
   the first point past the TDZ where it can be called. */
setSheet(sheetState);
/* The gesture moved to /sheet.js on 2026-08-05 so the builder's sheet could be the SAME thing
   rather than a second implementation of it. The arithmetic below is unchanged — it had been
   shipping for months and this extraction was not the moment to redesign it — including the two
   quirks that are easy to mistake for bugs and are carried on purpose:
     · `peek` RESTS at .88H-112 but SNAPS at .88H-132. Twenty pixels, longstanding.
     · A release can land on peek/half/full but never on `shut`. The pill (#openSheet) is the
       way back, so the finger cannot close the sheet — see the note under syncGrab. */
(()=>{
  const H=()=>window.innerHeight;
  const posFor=st=>st==="full"?0:st==="half"?H()*.44:st==="peek"?H()*.88-112:H();
  const g=document.getElementById("grab");
  window.syncGrab=()=>g.setAttribute("aria-label",
    sheetState==="full"?"Collapse the trip panel"
    /* This label promised "drag down to close it" for a long time while the snap list had no
       `shut` in it. Peter's call, 2026-08-05: make it true. See snapFor/max below. */
    : sheetState==="peek"?"Expand the trip panel, or drag down to close it"
    : "Expand the trip panel");
  syncGrab();
  createSheetDrag({
    handles: [g, document.getElementById("sheetHead")],
    states:     ["shut","peek","half","full"],
    /* `shut` is snappable now (Peter, 2026-08-05: "make drag down close the sheet"), which the
       peek label had been claiming all along. It could not simply be added: `shut` RESTS at H,
       which is far below the old drag clamp of .88H-100, so it was never the nearest snap to
       anywhere the finger could actually reach — adding it to this list alone would have
       changed nothing at all. It needs a threshold of its own AND room to be dragged into. */
    snapStates: ["shut","peek","half","full"],
    posFor,
    snapFor: st => st==="peek" ? H()*.88-132
                 : st==="shut" ? H()*.88-40      /* reachable, and 92px below peek's threshold */
                 : posFor(st),
    current: () => sheetState,
    /* Raised from .88H-100 so there is travel BELOW peek to close into. The midpoint between
       peek (.88H-132) and shut (.88H-40) is .88H-86, so from peek's resting .88H-112 a ~27px
       downward flick closes it, while from half it takes a decisive ~270px. Cheap when you mean
       it, hard to do by accident. */
    max:     () => H()*.88-40,
    onStart: () => sheet.classList.add("dragging"),
    onEnd:   () => { sheet.classList.remove("dragging"); sheet.style.transform=""; },
    onDrag:  px => { sheet.style.transform=`translateY(${px}px)`; },
    /* syncGrab after a DRAG too. The old code called it after a keyboard change and not after a
       release, so the handle's label described the state you had just left. */
    onSnap:  st => { setSheet(st); syncGrab(); }
  });
})();

/* ── boot ──────────────────────────────────────────────── */
applyTheme();
function renderConfig(cfg){
  if(cfg && cfg.labels) TRACK_LABELS={...TRACK_LABELS,...cfg.labels};
  drawDocHead();   // #15: the document header carries the name too, and is repainted here
                   // rather than waiting for the next render — renaming should feel instant
  if(!editingVeh) buildLegend();
  applyLabels();
  if(!(document.activeElement && listEl.contains(document.activeElement))) drawList();
}
store.subscribe(render);
store.subscribeNotes(renderNotes);
store.subscribePosts(renderPosts);
store.subscribeConfig(renderConfig);

let syncFails=0;
/* ── the signed-in indicator on the trip page (D-132, extended here on Peter's say-so) ──
   Same rule as the sixteen marketing pages: shown ONLY when signed in, and with the flag
   absent it asks nothing at all. /account writes and reconciles the flag; the session cookie
   is httpOnly, so no page can read it directly.

   Two things are specific to THIS page and neither is cosmetic:

   1. The path is the ROOT /api/account/me, NOT API_BASE + "/api/...". Every other call on this
      page is slug-scoped (D-021 routing), and account state is not a property of a trip.
      Checked 200 against the live root before wiring it.

   2. It says nothing about WHO opened this trip. Most people arrive holding a phrase and are
      not signed in at all — they correctly see nothing. Even for someone who is, this is an
      ACCOUNT mark and not an identity: D-047 is why access_level()'s account branch returns no
      `member` key, and hanging a face on the chrome must not quietly undo that. Generic
      avatar, no name, no email. */
(function(){
  var flag=null; try{ flag=localStorage.getItem("ttb_acct"); }catch(e){}
  if(!flag) return;
  var host=document.getElementById("topright");
  if(!host || document.getElementById("acctBtn")) return;
  fetch("/api/account/me",{credentials:"same-origin"})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(me){
      if(!me || !me.signed_in){ try{ localStorage.removeItem("ttb_acct"); }catch(e){} return; }
      var a=document.createElement("a");
      a.id="acctBtn"; a.href="/account";
      var n=(me.trips||[]).length;
      a.title="Signed in" + (n ? " \u2014 " + n + (n===1?" trip":" trips") : "");
      a.setAttribute("aria-label", a.title + ". Go to your account.");
      a.innerHTML=icon("person",19);
      host.insertBefore(a, document.getElementById("themeBtn"));
    })
    .catch(function(){});
})();

const offEl=document.getElementById("offline");
/* ALWAYS try the server first, even with no phrase in hand. This used to be
   `if(KEY){ sync() } else showGate()`, which meant a visitor without a stored phrase was shown
   the gate and the API was never called — so D-071 (signing in opens the trips on your account)
   was correct on the server and unreachable from the one page it exists for. The buyer of a
   trip could sign in, see it listed, click it, and be asked for words they never kept.
   No guard is needed: access_level() falls through to the account session precisely when no
   phrase is presented, and api() already opens the gate on a 401. */
/* Offline copy, second half. A 401 is NOT a network failure — the gate is already up and
   showing a cached trip over it would be both wrong and a small leak, so `auth` is excluded.
   Anything else (no bars, DNS, a timeout in a canyon) falls back to the last saved copy. */
const OFF_LIVE  = icon("alert",14)+" Offline — your changes may not be saving. Reconnecting…";
/* This sentence was a lie for one afternoon and is true again. It used to promise that changes
   wait, with no outbox behind it; §2ad replaced it with a flat "will NOT be saved", which was
   honest but bleak; §2ad(c) built the queue, so it can promise once more — and this time the
   promise is kept by `flushOutbox()`. */
const OFF_CACHE = icon("alert",14)+" No signal — showing the copy saved on this phone. Changes are kept here and sent when you're back.";
/* A queue can outlive the page — someone closes the app in a canyon and opens it at the motel.
   Drain it before the first sync, for the same reason the poll does. */
flushOutbox().catch(()=>{});
sync().then(onAuthed).catch(e=>{
  if(e && e.message === "auth") return;
  if(restoreTrip()){ offEl.innerHTML = OFF_CACHE; offEl.classList.add("show"); }
});
/* FLUSH FIRST, THEN SYNC, and the order is the whole point. `sync()` overwrites local state with
   the server's, so a sync that landed before the queue drained would wipe the very edit being
   held — which is the original bug wearing a different hat. */
setInterval(async ()=>{
  if(!(KEY && !gateEl.classList.contains("show"))) return;
  try{ await flushOutbox(); }catch(e){}
  sync().then(()=>{ syncFails=0;
            if(!outboxCount()){ offEl.classList.remove("show"); offEl.innerHTML = OFF_LIVE; }
            else paintOutbox(); })
        .catch(e=>{ if((e&&e.message)!=="auth" && ++syncFails>=2){ offEl.classList.add("show"); paintOutbox(); } });
}, 10000);



/* ── data-act wiring (2026-11-09) ──────────────────────────────────────────────────────────
   An on*= attribute IS inline script: script-src 'unsafe-inline' is what allowed it, so the
   attributes had to go before that could be dropped. Every one is now data-act, wired here by
   name against this file's own functions.

   Bound DIRECTLY to each element, not delegated from document. Every one of these elements is
   static in the markup, and a direct listener is the faithful equivalent of the attribute it
   replaces — it fires at the element, so nothing calling stopPropagation further up can
   silently kill it, which is the way a delegated version would have failed. An unknown name
   binds nothing rather than throwing. */
(function () {
  var ACTS = {clearAppDraw: clearAppDraw, cancelAppDraw: cancelAppDraw, finishAppDraw: finishAppDraw, tapPhoto: tapPhoto, tapPlay: tapPlay, openTripFab: openTripFab};
  Array.prototype.forEach.call(document.querySelectorAll("[data-act]"), function (el) {
    var fn = ACTS[el.getAttribute("data-act")];
    if (typeof fn === "function") el.addEventListener("click", function () { fn(); });
  });
})();
