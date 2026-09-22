# Business Rules

This document defines the core business rules. These rules MUST be respected in all implementations unless explicitly approved otherwise.

---

## Hosted, not reimplemented

The plugin shows the community as the community serves it. It never scrapes, proxies or calls the community's internal endpoints, and it never reads the member's session. When the community moves, only the base URL changes.

## One session, on this device

The webview uses a persistent partition dedicated to the plugin so the member signs in once per device. Session data never enters `data.json` or the vault.

## The pane never blocks the user

Anything that fails (no network, unsupported platform) ends in a card that offers the browser as a way out.

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity
