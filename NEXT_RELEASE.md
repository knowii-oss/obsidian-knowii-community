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
