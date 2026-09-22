---
title: Configuration
nav_order: 3
---

# Configuration

## Settings

| Setting              | Type     | Default                  | Description                                                              |
| -------------------- | -------- | ------------------------ | ------------------------------------------------------------------------ |
| Open the pane in     | dropdown | A main tab               | Where "Open Knowii" shows the community: a main tab, or a sidebar.       |
| Show the toolbar     | toggle   | on                       | Navigation buttons, shortcuts and "Open in browser" above the community. |
| Reopen the last page | toggle   | on                       | Come back to the page you were on instead of the community home.         |
| Zoom                 | slider   | 100%                     | Size of the community inside the pane, from 50% to 200%.                 |
| Ribbon icon          | toggle   | on                       | Show the Knowii icon in the ribbon.                                      |
| Community address    | text     | `https://www.knowii.net` | Only change this if the community moves.                                 |

## Where things are stored

Settings live in the plugin's `data.json`. The page you were on and whether you have seen the welcome card are stored per device, in Obsidian's local storage, so they never travel with your vault.
