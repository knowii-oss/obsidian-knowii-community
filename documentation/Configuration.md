# Configuration

See `docs/configuration.md` for the user-facing table. Invariants:

- `communityUrl` is always a normalized `https://` or `http://` base URL without trailing slash, query or hash (`normalizeCommunityUrl`). Anything else on disk falls back to the default and is rewritten.
- `paneLocation` is one of `tab`, `right`, `left`.
- `zoomPercent` is a finite number between 50 and 200.
- Booleans are strict booleans; a string `"false"` never reaches a boolean field.
- `checkIntervalSeconds` is one of 30, 60, 120, 300, 900, 1800.
- `notifyCategories` has a strict boolean for every category; missing ones are filled with `true` and written back.
- `sessionSecretName` is a valid secret id (lowercase alphanumeric with dashes); anything else falls back to `knowii-community-session`.
- `session` (on disk; `legacySession` in memory) is absent or a `StoredSession` with at least one live auth cookie (`remember_user_token`, `_circle_session`, `user_session_identifier`); anything else is dropped. Legacy, read-only: see Business Rules.
- `legacySecretMigratedAt` is null or a parsable ISO date.
- `shareSessionAcrossDevices` is a strict boolean; missing → decided (on if a legacy session or migration date exists) and written back.
