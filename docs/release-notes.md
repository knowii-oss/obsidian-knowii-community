# Release Notes

## 1.6.0 (2026-10-03)

### Share your session with your phone and tablet

Phones and tablets can't sign in to Knowii themselves: they used to get your session with your
vault, from the plugin settings (`data.json`). Since 1.5.1 the session stays in each device's
secret storage, so a phone without it had no way to get one.

The new **Share session with my other devices** setting (Settings → Advanced) brings that back:
when on, your session is also kept in `data.json` and reaches your other devices with your vault.
The trade-off: `data.json` then holds your session in plain text, and anyone with a copy of it
can use your Knowii account.

It is already on if your session was in `data.json` before, so nothing changes for you: your
phone keeps getting notifications. It is off for new installs. Turning it off removes the copy
from `data.json`.

While it is on, the copy in `data.json` is kept up to date and never removed automatically, so
**Remove plain-text copy now** is hidden.

## 1.5.1 (2026-10-03)

### Your Knowii sign-in no longer travels with your vault

Your Knowii session is now kept in Obsidian's secret storage, on each device, instead of the
plugin settings file (`data.json`). That file travels with your vault (sync, git, cloud
backups), so a copy of it could be used to sign in as you.

Nothing to do: every device moves its session to its own secret storage on its next start, so
you stay signed in everywhere.

### The plain-text copy is removed after 60 days

The copy older versions left in `data.json` stays for 60 days, so devices you have not opened
yet can still pick it up. Then it is removed. Once all your devices run this version, you can
remove it right away: **Settings → Advanced → Remove plain-text copy now**.

### Good to know

Your session no longer reaches new devices with your vault. A phone or tablet that never had
it shows a card that opens Knowii in your browser.

## 1.5.0 (2026-09-28)

### Forgetting the stored session now asks first

**Settings → Advanced → Stored session → Forget** now asks for confirmation before removing
your Knowii sign-in from this vault. Forgetting it stops notifications on every device that
relies on it, such as your phone, so a stray click no longer does that.

The dialog also says what Forget cannot do: any desktop signed in to the Knowii pane,
including the one you click Forget on, stores the session again at its next check. To remove it
for good, sign out in the pane.

### Under the hood

More tests around system notifications and the settings screen, and a fix that keeps the
plugin's default settings from being locked in memory. Nothing changes in how the plugin
behaves.

## 1.4.1 (2026-09-28)

### Bug Fixes

- **build:** harden the release path from the template
- **build:** rebuild versions.json from the published releases
- **plugin:** keep the support block from stacking on every settings refresh
- **plugin:** popout-aware focus check, main-window hidden hosts, destructive Forget

## 1.4.0 (2026-09-23)

### Features

- **plugin:** use Knowii on phones and tablets, with a layout that fits every screen

### Bug Fixes

- **plugin:** keep each vault's Knowii sign-in to itself; a new vault starts signed out

## 1.3.0 (2026-09-23)

### Features

- save to vault, ask the community, reply, events and instant notifications

## 1.2.0 (2026-09-23)

### Features

- choose when system notifications show, and only watch spaces you belong to

## 1.1.1 (2026-09-23)

### Bug Fixes

- first check right after startup, and open the pane on the requested page

## 1.1.0 (2026-09-23)

### Features

- notifications, what's new inbox and whole-community watch

## 1.0.0 (2026-09-22)

### Features

- open the Knowii community in a pane inside Obsidian
- use the Knowii logo as the plugin icon
