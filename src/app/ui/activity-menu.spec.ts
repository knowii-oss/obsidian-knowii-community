import { describe, expect, test } from 'bun:test'
import { MENU_ITEM_LIMIT, fillActivityMenu, menuTitle } from './activity-menu'
import type { ActivityItem } from '../domain/community-activity'
import { INITIAL_WATCH_STATE } from '../services/activity-watcher'
import type { WatchState } from '../services/activity-watcher'
import { ADMIN_DESTINATIONS } from '../domain/community-links'
import type { Menu } from 'obsidian'

/** Records what the menu builder adds. */
class FakeMenu {
    entries: { title: string; disabled: boolean; click: (() => void) | null }[] = []
    separators = 0
    addItem(build: (item: unknown) => unknown): this {
        const entry = { title: '', disabled: false, click: null as (() => void) | null }
        const item = {
            setTitle(title: string) {
                entry.title = title
                return item
            },
            setIcon() {
                return item
            },
            setDisabled(disabled: boolean) {
                entry.disabled = disabled
                return item
            },
            onClick(click: () => void) {
                entry.click = click
                return item
            }
        }
        build(item)
        this.entries.push(entry)
        return this
    }
    addSeparator(): this {
        this.separators += 1
        return this
    }
}

const item = (n: number): ActivityItem => ({
    key: `k${n}`,
    category: 'directMessages',
    title: `Member ${n}`,
    summary: 'sent you a message',
    excerpt: null,
    path: `/messages/${n}`,
    occurredAt: n,
    unread: true,
    notify: true,
    ref: { kind: 'local' }
})

const signedIn = (items: ActivityItem[], isAdmin: boolean): WatchState => ({
    ...INITIAL_WATCH_STATE,
    status: 'signed-in',
    member: { id: 1, name: 'Me', isAdmin },
    counts: { notifications: items.length, messages: 0, threads: 0 },
    items
})

function build(state: WatchState) {
    const menu = new FakeMenu()
    const opened: string[] = []
    fillActivityMenu(menu as unknown as Menu, state, ADMIN_DESTINATIONS, {
        openItem: (i) => opened.push(i.path),
        showAll: () => opened.push('all'),
        checkNow: () => opened.push('check'),
        openPath: (path) => opened.push(path),
        markAllRead: () => opened.push('mark-all'),
        archiveRead: () => opened.push('archive-read'),
        showEvents: () => opened.push('events')
    })
    return { menu, opened }
}

describe('ribbon activity menu', () => {
    test('lists the latest unread items, then show all and check now', () => {
        const { menu, opened } = build(signedIn([item(1), item(2)], false))
        expect(menu.entries.map((e) => e.title)).toEqual([
            'Member 1: sent you a message',
            'Member 2: sent you a message',
            "Show what's new (2 unread)",
            'Mark all as read',
            'Archive read',
            'Upcoming events',
            'Check now'
        ])
        menu.entries[0]?.click?.()
        menu.entries[2]?.click?.()
        expect(opened).toEqual(['/messages/1', 'all'])
    })

    test('caps the items listed directly', () => {
        const items = Array.from({ length: MENU_ITEM_LIMIT + 5 }, (_, n) => item(n))
        const { menu } = build(signedIn(items, false))
        expect(menu.entries.filter((e) => e.title.startsWith('Member'))).toHaveLength(
            MENU_ITEM_LIMIT
        )
    })

    test('admins get the admin pages', () => {
        const { menu, opened } = build(signedIn([], true))
        expect(menu.entries.map((e) => e.title)).toEqual([
            "You're all caught up",
            "Show what's new",
            'Mark all as read',
            'Archive read',
            'Upcoming events',
            'Check now',
            'Admin: Dashboard',
            'Admin: Audience'
        ])
        menu.entries[7]?.click?.()
        expect(opened).toEqual(['/settings/audience/manage'])
    })

    test('signed out says so and offers no items', () => {
        const { menu } = build({ ...INITIAL_WATCH_STATE, status: 'signed-out' })
        expect(menu.entries[0]).toMatchObject({ title: 'Not signed in to Knowii', disabled: true })
    })

    test('long titles are bounded', () => {
        expect(menuTitle({ ...item(1), summary: 'x'.repeat(200) }).length).toBe(70)
    })
})

describe('read items stay out of the ribbon menu', () => {
    test('only unread items are listed', () => {
        const { menu } = build(signedIn([item(1), { ...item(2), unread: false }], false))
        expect(
            menu.entries.filter((e) => e.title.startsWith('Member')).map((e) => e.title)
        ).toEqual(['Member 1: sent you a message'])
    })
})
