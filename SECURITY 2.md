# Security Policy

this trip, btw is a privacy product; security reports are treated as
first-class contributions.

## Reporting a Vulnerability

Email **hello@thistripbtw.us** with details and reproduction steps.
You'll get a human reply within 72 hours. Please don't open public
issues for vulnerabilities, and please don't test against trips you
don't own — creating a $2.50 trip gives you a legitimate target.

## Scope notes

- Trip passwords are capability secrets: proof you can read someone's
  pins **without** a valid phrase is always in scope.
- Sealed-drop content leaking to unopened viewers (including over the
  wire) is in scope — surprise is a security property here.
- Rate-limit bypass on the gate (schema `gate` table) is in scope.
