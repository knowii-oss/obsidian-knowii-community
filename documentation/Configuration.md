# Configuration

See `docs/configuration.md` for the user-facing table. Invariants:

- `communityUrl` is always a normalized `https://` or `http://` base URL without trailing slash, query or hash (`normalizeCommunityUrl`). Anything else on disk falls back to the default and is rewritten.
- `paneLocation` is one of `tab`, `right`, `left`.
- `zoomPercent` is a finite number between 50 and 200.
- Booleans are strict booleans; a string `"false"` never reaches a boolean field.
