# Domain model

- **Community**: the hosted site, identified by its base URL (`communityUrl`).
- **Destination**: a well-known place in the community (home, feed, messages, notifications, events, members): label, path, icon. Drives the toolbar shortcuts and the commands.
- **Pane**: the workspace view hosting the community; one at a time, opened in a main tab or a sidebar.
- **Session**: the member's sign-in: cookies held by the webview partition, copied to the settings (`StoredSession`) so other devices can use it.
- **Activity item**: one thing that happened, read or unread (only unread ones are announced, counted and listed in the ribbon menu) (a conversation, a thread, a notification) with a category, a title, a summary, an optional excerpt, a community path and a key. The key changes when the item gets newer content, so the member hears about it again.
- **Item ref**: where an item lives, which decides how it is read or archived: a notification, a conversation (room), a thread, or local (whole-community posts and comments, known only to the plugin).
- **Inbox**: the member's per-device read and archived state on top of the community's; archived items return only with a new key (new activity).
- **Watch start**: per-device moment the whole-community watch began; nothing older is announced. Turning the watch back on resets it.
- **Category**: direct messages, chat messages, thread replies, mentions, comments, posts, reactions, events, new members, other. One notification switch each.
- **Counts**: unread notifications (the community's own badge count), unread conversations, unread threads.
- **Watch state**: starting, signed in, signed out, error; with the member, counts, items, last check time and the transport that answered.
