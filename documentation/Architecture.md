# Architecture

The plugin hosts the community as-is. It owns the frame, never the content.

- `src/app/plugin.ts`: lifecycle, settings (validated on load, persisted through one serialized write path), the view registration, ribbon and commands. It hands the pane a `CommunityViewHost` so the view never touches the plugin instance.
- `src/app/ui/community-view.ts`: the `ItemView`. Toolbar (brand, navigation, shortcuts, open in browser) over a `<webview>` with a persistent partition (`persist:knowii-community`). Welcome card on first open, error card when the community cannot be loaded, browser hand-off on mobile.
- `src/app/domain/community-links.ts`: the only place that knows URLs: base URL normalization, destinations, host check.
- `src/app/settings/settings-tab.ts`: declarative settings (Obsidian 1.13+).
- `src/app/whats-new.ts` and `src/app/ui/`: the shared "What's new" tab and support links from the plugin template.

Per-device memory (last page, welcome seen) goes through `App.loadLocalStorage` / `saveLocalStorage`, never through `data.json`, so it does not sync with the vault.
