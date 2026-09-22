# Domain model

- **Community**: the hosted site, identified by its base URL (`communityUrl`).
- **Destination**: a well-known place in the community (home, feed, messages, notifications, events, members): label, path, icon. Drives the toolbar shortcuts and the commands.
- **Pane**: the workspace view hosting the community; one at a time, opened in a main tab or a sidebar.
- **Session**: the member's sign-in, held by the webview partition. The plugin never reads it.
