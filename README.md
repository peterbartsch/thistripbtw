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

One tool, no key, and it just builds the link. **If your client takes a URL, that is the whole
setup:**

```
https://thistripbtw.us/mcp
```

Streamable HTTP. Prefer to read the code first? It is one file with zero dependencies, under
three hundred lines, and it runs locally without touching the network:

```bash
claude mcp add thistripbtw -- npx -y thistripbtw-mcp
```

Or fetch the file and run it yourself:

```bash
curl -O https://thistripbtw.us/mcp/thistripbtw-mcp.mjs
claude mcp add thistripbtw -- node ./thistripbtw-mcp.mjs
```

Both paths are the same tool and produce byte-identical links — a parity test runs them against
each other on every build, so they cannot drift. The server has its own repository so it can be
read in one sitting and embedded freely:
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

PHP 8 and MySQL. **No frameworks, no build step, no npm in the client** — the trip app is a
single HTML file with Leaflet. That is the whole stack, and it is deliberate.

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
