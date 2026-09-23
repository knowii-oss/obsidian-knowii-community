import type { Menu } from 'obsidian'
import type { ActivityItem } from '../domain/community-activity'
import { categoryInfo, totalUnread } from '../domain/community-activity'
import type { CommunityDestination } from '../domain/community-links'
import type { WatchState } from '../services/activity-watcher'

/** Unread items listed directly in the menu; the rest is one "Show all" away. */
export const MENU_ITEM_LIMIT = 12
const MENU_TITLE_LENGTH = 70

export interface ActivityMenuHandlers {
    openItem(item: ActivityItem): void
    showAll(): void
    checkNow(): void
    openPath(path: string): void
    markAllRead(): void
    archiveRead(): void
}

/** One menu line for an item: who, then what, bounded. */
export function menuTitle(item: ActivityItem): string {
    const text = `${item.title}: ${item.summary}`
    return text.length > MENU_TITLE_LENGTH
        ? `${text.slice(0, MENU_TITLE_LENGTH - 1).trimEnd()}…`
        : text
}

/**
 * The ribbon icon's context menu: the latest unread items, "Show all",
 * "Check now", and the admin pages for admins.
 */
export function fillActivityMenu(
    menu: Menu,
    state: WatchState,
    adminDestinations: readonly CommunityDestination[],
    handlers: ActivityMenuHandlers
): void {
    if ('signed-in' !== state.status) {
        menu.addItem((entry) =>
            entry
                .setTitle(
                    'signed-out' === state.status ? 'Not signed in to Knowii' : 'Not checked yet'
                )
                .setIcon('info')
                .setDisabled(true)
        )
    } else if (!state.items.some((item) => item.unread)) {
        menu.addItem((entry) =>
            entry.setTitle("You're all caught up").setIcon('check').setDisabled(true)
        )
    } else {
        const unread = state.items.filter((item) => item.unread)
        for (const item of unread.slice(0, MENU_ITEM_LIMIT)) {
            menu.addItem((entry) =>
                entry
                    .setTitle(menuTitle(item))
                    .setIcon(categoryInfo(item.category).icon)
                    .onClick(() => {
                        handlers.openItem(item)
                    })
            )
        }
    }

    menu.addSeparator()
    const total = 'signed-in' === state.status ? totalUnread(state.counts) : 0
    menu.addItem((entry) =>
        entry
            .setTitle(total > 0 ? `Show what's new (${total} unread)` : "Show what's new")
            .setIcon('inbox')
            .onClick(() => {
                handlers.showAll()
            })
    )
    menu.addItem((entry) =>
        entry
            .setTitle('Mark all as read')
            .setIcon('check-check')
            .setDisabled(0 === total && !state.items.some((item) => item.unread))
            .onClick(() => {
                handlers.markAllRead()
            })
    )
    menu.addItem((entry) =>
        entry
            .setTitle('Archive read')
            .setIcon('archive')
            .onClick(() => {
                handlers.archiveRead()
            })
    )
    menu.addItem((entry) =>
        entry
            .setTitle('Check now')
            .setIcon('refresh-cw')
            .onClick(() => {
                handlers.checkNow()
            })
    )

    if (state.member?.isAdmin) {
        menu.addSeparator()
        for (const destination of adminDestinations) {
            menu.addItem((entry) =>
                entry
                    .setTitle(`Admin: ${destination.label}`)
                    .setIcon(destination.icon)
                    .onClick(() => {
                        handlers.openPath(destination.path)
                    })
            )
        }
    }
}
