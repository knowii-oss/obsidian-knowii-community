# Configuration

See `docs/configuration.md` for the user-facing table. Invariants:

- `communityUrl` is always a normalized `https://` or `http://` base URL without trailing slash, query or hash (`normalizeCommunityUrl`). Anything else on disk falls back to the default and is rewritten.
- `paneLocation` is one of `tab`, `right`, `left`.
- `zoomPercent` is a finite number between 50 and 200.
- Booleans are strict booleans; a string `"false"` never reaches a boolean field.
- `checkIntervalSeconds` is one of 30, 60, 120, 300, 900, 1800.
- `notifyCategories` has a strict boolean for every category; missing ones are filled with `true` and written back.
- `session` is null or a `StoredSession` with at least one live auth cookie (`remember_user_token`, `_circle_session`, `user_session_identifier`); anything else becomes null.
