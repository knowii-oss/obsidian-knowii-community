# Business Rules

This document defines the core business rules. These rules MUST be respected in all implementations unless explicitly approved otherwise.

---

## One session, stored in the plugin settings

The pane uses a persistent partition dedicated to the plugin (`persist:knowii-community`) so the member signs in once. The session cookies of that partition are also persisted in the plugin settings (`data.json`, field `session`): other devices where the vault syncs use them to check for activity, and a desktop without a session gets it restored into the partition. The user documentation says so plainly.

## Never sign the member back in behind their back

A stored session is put back into the pane only when the pane has none at the start of a run. If the member was signed in during this run and is now signed out, they signed out (or the session ended): the stored session is dropped, never restored.

## Notifications never block or flood

Checks only read (GET); nothing is marked as read by the plugin. The first check on a device announces the backlog as one summary; afterwards at most three items get their own alert per check, the rest fold into one. Failures back off (doubling, capped at 15 minutes) and never stop the checks; transports fall through in order (Electron session, hidden webview, stored cookies).

## The pane never blocks the user

Anything that fails (no network, unsupported platform) ends in a card that offers the browser as a way out.

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
