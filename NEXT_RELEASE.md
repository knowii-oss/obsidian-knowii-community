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
