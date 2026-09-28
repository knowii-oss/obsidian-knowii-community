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
