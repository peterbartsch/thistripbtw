# auth.md — this trip, btw

**There is nothing to register for, and no credential to get.** That is the whole of it, and this
file exists to say so in the place an agent looks rather than leaving it to be discovered by
trying.

## The agent audience

Assistants building, amending or reading trip links on someone's behalf — over the MCP server at
`https://thistripbtw.us/mcp` (streamable HTTP) or `npx thistripbtw-mcp` over stdio.

## Registration

**None.** There is no agent registration endpoint, no API key to request, no client to register,
no plan to be on. Connect and call. If you find a page offering agent credentials for this
service, it is not ours.

## Supported methods

| | |
|---|---|
| **Authentication** | none |
| **Authorization server** | none — we run no OAuth issuer, so there is no `/.well-known/oauth-authorization-server` or `/.well-known/oauth-protected-resource` here, deliberately |
| **Rate limiting** | per-trip guess limiting on the phrase paths only; no per-agent quota |
| **Cost** | building and reading a trip link is free. Keeping one is a one-time payment made by the person, in a browser, not by an agent |

## The one credential that exists, and it is not ours to issue

A trip that someone has **kept** lives at its own address, and the `#k=four-word-phrase` fragment
on its link is the password to it. `read_kept_trip` and `add_to_kept_trip` take that whole link as
an argument.

- It is issued to the **person** when they keep a trip, not to an agent, and not by any endpoint an
  agent can call.
- An agent holds it only because the person handed it over, the way they would hand over any link.
- **Treat it as a credential**: do not repeat it into anything a third party will see, and do not
  guess at one — a wrong phrase counts against that trip's hourly guess limit.
- View phrases read; edit phrases read and write. Neither can delete a trip: there is no delete
  tool at all, because only the person who bought a trip should be able to destroy it.

## What we hold about an agent

Nothing. No account to build or read a trip link, no key, no identity, no per-caller record. The hosted server counts how many
times each tool was called per day — one number per tool, with nothing attached to it — and that is
the entire extent of it.

## Contact

`support@thistripbtw.us` · documentation at https://thistripbtw.us/for-agents · worked examples at
https://thistripbtw.us/recipes
