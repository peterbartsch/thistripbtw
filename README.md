# this trip, btw

**Persistent, shareable travel workspaces for AI agents.**

A private, paid, no-profiling trip planner and recorder. One trip lives at its own unguessable
address and opens with a word phrase. No trackers, no analytics, no profiling, nothing sold.

**→ [thistripbtw.us](https://thistripbtw.us)** — the human side of this, and the thing that pays
for it. Building trips is free and always asks for nothing; the paid tiers fund the free tooling
in this repo rather than an ad business.

![No Profiling](https://img.shields.io/badge/Profiling-None-006B70.svg)
![No Trackers](https://img.shields.io/badge/Trackers-Zero-006B70.svg)
![No Freemium](https://img.shields.io/badge/Freemium-Never-ED9F17.svg)
![Stack](https://img.shields.io/badge/Stack-PHP_8_+_MySQL-ED9F17.svg)

![A trip on the map: a flight arc from Chicago to the Bay Area, numbered stops, two vehicles
travelling as separate tracks — Sam's Subaru and Alex's rental — and a replay
control](public/demo.jpg)

*One trip, two vehicles, one link. The tracks separate and rejoin because real trips do.*

---

## If you are an agent

You can build someone a complete trip and hand them a link that opens it already drawn on a
real map. **No API key, nothing to sign up for to build, no card, and no call to us to create
it.** That matters because most assistants cannot create accounts or enter card details, which
puts nearly every travel tool out of reach of one acting on a person's behalf.

Encode the itinerary into the URL fragment and hand it over:

```
https://thistripbtw.us/new#d=<base64url(JSON)>
```

The fragment never leaves the browser — it is not sent to the server — so an agent can compose
a trip without anything about it reaching us at all. The person opens it, edits anything, and
it is theirs. Nothing is charged until they choose to keep it.

**Two surfaces are kept current and are the contract** — prefer them over this file, which is
written for a human reading the repo:

| | |
|---|---|
| [`/llms.txt`](https://thistripbtw.us/llms.txt) | the machine-readable summary, the `#d=` schema, and what each tier does |
| [`/for-agents`](https://thistripbtw.us/for-agents) | the same thing as prose, with worked examples |

### Or use the MCP server

Six tools, no key, and the first one builds the link. **If your client takes a URL, that is the
whole setup:**

```
https://thistripbtw.us/mcp
```

| tool | what it does |
|---|---|
| `build_trip_link` | an origin and legs in, a URL out — start here, as soon as there is one destination |
| `amend_trip_link` | change a trip somebody already holds, so one link grows through a conversation |
| `read_trip_link` | a link in, the itinerary back out as structured data, in any later conversation |
| `find_place` | a name to coordinates, because the builder will not guess them |
| `read_kept_trip` | read a trip that was bought, using the word phrase in its link |
| `add_to_kept_trip` | add a stop to one |

Streamable HTTP. Prefer to read the code first? It is one file with zero dependencies. Building
and reading a link is pure local work — the trip rides in the fragment, so nothing is sent. The
three tools that reach past that (`find_place` and the two kept-trip tools) call this site and
say so in their descriptions:

```bash
claude mcp add thistripbtw -- npx -y thistripbtw-mcp
```

Or fetch the file and run it yourself:

```bash
curl -O https://thistripbtw.us/mcp/thistripbtw-mcp.mjs
claude mcp add thistripbtw -- node ./thistripbtw-mcp.mjs
```

Both paths carry the same six tools and produce byte-identical links — a parity test runs them
against each other on every build, so they cannot drift. The server has its own repository so it
can be read on its own and embedded freely:
[**thistripbtw-mcp**](https://github.com/peterbartsch/thistripbtw-mcp) (MIT).

There is also a discovery manifest at
[`/.well-known/mcp.json`](https://thistripbtw.us/.well-known/mcp.json).

**One thing to be honest about with the person you are helping:** we record trips, we do not
verify them. A stop on the map is not a booking, and a time on the map is not a confirmation.
Do not let the map lend credibility to a detail nobody checked.

## If you are a person

Trips that matter end up scattered across four phones and a group chat nobody can find again.
This gives a trip one private address instead: a map the whole crew plans on, posts to, and
keeps.

> *"this trip, btw —"* is how trips actually get shared: an aside, a link dropped
> mid-conversation, no ceremony. The name is the product's manner — casual on the surface,
> private underneath.

**Building a trip is free and asks for nothing** — no account, no card, no email. You pay only
when you want to keep one.

1. **Build it.** Stops go on the map; the whole thing lives in your browser until you keep it.
2. **Keep it, once.** $2.50 *plan it* · $5 *keep it* · $10 *the works* (adds photo + video).
   Every tier has an end date on purpose — one year, five years, ten. Nothing is sold as
   permanent, because a promise past the life of the business is not one.
3. **Share it.** The trip gets its own address and two word-phrase passwords: **edit** writes,
   **view** reads. Tap them as links or say them out loud — `cedar-canyon-motel-dawn`.
4. **Live on it.** Posts drop where you are standing. Sealed drops open within range. Quests
   keep score between vehicles. Flights draw as arcs. Night-drive mode after dark.

Buying requires an account, and it is made *for* you from your checkout email after payment
succeeds — there is never a signup step before or during checkout. It holds your email and what
you bought, and nothing else, until you delete it.

## Running it yourself

PHP 8 and MySQL. **No frameworks, no build step, no npm in the client** — the trip app is one
HTML page and a plain classic script, with Leaflet. No bundler runs, ever: the file the browser
fetches is the file in this repo, which is the point. That is the whole stack, and it is
deliberate.

```bash
cp .env.example .env     # fill in DB_* and STRIPE_SECRET
mysql < schema.mysql.sql
make serve               # http://127.0.0.1:8080
make check               # syntax, secret scan, retired-claim scan, unit tests
make test                # API smoke tests against local PHP + MySQL
```

`make` on its own lists every target.

## Layout

```
├── index.php            # the router: / → landing, /{slug} → app, /{slug}/api/* → api.php
├── api.php              # the JSON API
├── lib/                 # accounts, chat, geocode, routing, mail, words
├── schema.mysql.sql     # trips, unified pins, notes, gate
├── public/              # every page; app.html is the trip client
│   ├── app-page.js      # the trip page's script — a classic script, not a module
│   ├── new-page.js      # the builder's, likewise (+ new-tail.js, sky-boot.js)
│   ├── llms.txt         # the agent-facing contract
│   └── for-agents.html
├── scripts/             # migrations, expiry, index builders
└── test/                # smoke tests + unit tests
```

`pins` is deliberately one table for stops, posts, sealed drops and quests — "posts and stops
feel very similar", enforced at the schema level rather than in prose.

## Privacy, plainly

We store the pins, notes and media your crew adds — nothing else. There is no analytics of any
kind, no error-reporting service, and no third-party script that profiles anyone. Payments are
Stripe's, so they know the buyer and we do not. Geocoding and road routing are **proxied through
our own server**, so the places you search and the roads you route never leave with your IP
attached. Map tiles come from a third party and still see IPs, which is disclosed rather than
glossed. Every trip has a delete-everything button that deletes everything.

## Licence

**AGPL-3.0** for the site. The MCP server is **MIT**, in
[its own repository](https://github.com/peterbartsch/thistripbtw-mcp), so it can be embedded
anywhere without licence friction.

---

*You pay once, so you are the customer — not the product.*
