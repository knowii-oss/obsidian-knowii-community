# Business Rules

This document defines the core business rules. These rules MUST be respected in all implementations unless explicitly approved otherwise.

---

## One session per vault, stored in the plugin settings

The pane uses a persistent partition dedicated to the plugin and to the vault (`persist:knowii-community-<vault id>`, `communityPartition`) so the member signs in once. Electron partitions are shared by every vault the app opens: a partition without the vault id copied the main vault's session into the next vault opened (the OSK kit, 2026-09-23). A vault never gets a session from another vault; a new vault starts signed out. The session cookies of that partition are also persisted in the plugin settings (`data.json`, field `session`): other devices where the vault syncs use them to check for activity, and a desktop without a session gets it restored into the partition. The user documentation says so plainly.

## Never sign the member back in behind their back

A stored session is put back into the pane only when the pane has none at the start of a run. If the member was signed in during this run and is now signed out, they signed out (or the session ended): the stored session is dropped, never restored.

## Notifications never block or flood

Checks only read (GET); nothing is marked as read by the plugin. The first check on a device announces the backlog as one summary; afterwards at most three items get their own alert per check, the rest fold into one. Failures back off (doubling, capped at 15 minutes) and never stop the checks; transports fall through in order (Electron session, hidden webview, stored cookies).

## The pane works on every device

Where the community cannot be hosted (mobile apps: no `<webview>`; the community sends `X-Frame-Options: SAMEORIGIN`, so no iframe), the pane is a native inbox; pages open in the browser. Every control has a touch-sized target and nothing is hover-only on touch screens. The UI adapts to the pane's width (container queries), not the window's.

## The pane never blocks the user

Anything that fails (no network, unsupported platform) ends in a card that offers the browser as a way out.

## Content is never published twice, never empty

Creating a post or sending a message goes through one transport only: a failure after the request left may mean it got through, and a retry would publish it twice. Empty messages are refused before sending (the community accepts and shows them).

## Saving never overwrites

Saving a post or thread whose note already exists opens the existing note: it may carry the member's own additions.

## Tests never reach other members

Probing or testing writes (posts, messages) uses drafts or rooms nobody else is in. On 2026-09-23 an empty test message was accepted by the community in a real conversation and had to be deleted.

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
