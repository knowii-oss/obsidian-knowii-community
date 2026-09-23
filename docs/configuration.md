---
title: Configuration
nav_order: 3
---

# Configuration

## Settings

| Setting                         | Type     | Default                  | Description                                                                                                                                                                |
| ------------------------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the pane in                | dropdown | A main tab               | Where "Open Knowii" shows the community: a main tab, or a sidebar.                                                                                                         |
| Show the toolbar                | toggle   | on                       | Navigation buttons, shortcuts and "Open in browser" above the community.                                                                                                   |
| Reopen the last page            | toggle   | on                       | Come back to the page you were on instead of the community home.                                                                                                           |
| Zoom                            | slider   | 100%                     | Size of the community inside the pane, from 50% to 200%.                                                                                                                   |
| Ribbon icon                     | toggle   | on                       | Show the Knowii icon in the ribbon.                                                                                                                                        |
| Watch the community             | toggle   | on                       | Check Knowii in the background for new activity.                                                                                                                           |
| Check every                     | dropdown | Every minute             | 30 seconds to 30 minutes.                                                                                                                                                  |
| Show notices                    | toggle   | on                       | A notice in Obsidian per new item.                                                                                                                                         |
| System notifications            | dropdown | Always                   | Your computer's notifications for new activity: always, only when Obsidian is in the background, or never.                                                                 |
| Unread counts in the status bar | toggle   | on                       | Unread notifications and messages at the bottom of the window.                                                                                                             |
| Unread badge on the ribbon icon | toggle   | on                       | Total unread count on the Knowii ribbon icon.                                                                                                                              |
| Notify me about …               | toggles  | all on                   | One switch per kind: direct messages, chat messages, thread replies, mentions, comments and replies, new posts, likes and reactions, events, new members, everything else. |
| Everything that happens         | toggle   | on                       | Watch the whole community: new posts, comments and chat messages in every space.                                                                                           |
| One switch per space            | toggles  | all on                   | Leave a space out of the whole-community watch. Only the spaces you belong to are listed and watched.                                                                      |
| Community address               | text     | `https://www.knowii.net` | Only change this if the community moves.                                                                                                                                   |
| Stored session                  | button   |                          | Shows whether your Knowii session is stored; **Forget** removes it.                                                                                                        |

## Where things are stored

Settings live in the plugin's `data.json`, **including your Knowii session** (the sign-in cookies), so it travels with your vault to your other devices. Keep that file private: anyone with a copy can use your Knowii account.

The page you were on, whether you have seen the welcome card, which items you have already been notified about, what you marked as read or archived, and the recent activity found by watching the whole community are stored per device, in Obsidian's local storage, so they never travel with your vault.
