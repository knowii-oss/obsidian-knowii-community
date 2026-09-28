import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
    MAX_INDIVIDUAL_ALERTS,
    announceBacklog,
    announceItems,
    wantsDesktopNotification
} from './activity-alerts'
import type { AlertOptions } from './activity-alerts'
import type { ActivityItem } from '../domain/community-activity'
import { readDesktopNotificationMode } from '../types/plugin-settings.intf'

describe('wantsDesktopNotification', () => {
    test('always shows, focused or not', () => {
        expect(wantsDesktopNotification('always', true)).toBe(true)
        expect(wantsDesktopNotification('always', false)).toBe(true)
    })

    test('background only when Obsidian is not focused', () => {
        expect(wantsDesktopNotification('background', true)).toBe(false)
        expect(wantsDesktopNotification('background', false)).toBe(true)
    })

    test('off never shows', () => {
        expect(wantsDesktopNotification('off', false)).toBe(false)
    })
})

describe('readDesktopNotificationMode', () => {
    test('keeps a valid stored mode', () => {
        expect(readDesktopNotificationMode({ desktopNotifications: 'background' })).toEqual({
            mode: 'background',
            migrated: false
        })
    })

    test('migrates the 1.1 boolean: on becomes always, off stays off', () => {
        expect(readDesktopNotificationMode({ showDesktopNotifications: true })).toEqual({
            mode: 'always',
            migrated: true
        })
        expect(readDesktopNotificationMode({ showDesktopNotifications: false })).toEqual({
            mode: 'off',
            migrated: true
        })
    })

    test('defaults to always', () => {
        expect(readDesktopNotificationMode({})).toEqual({ mode: 'always', migrated: true })
        expect(readDesktopNotificationMode({ desktopNotifications: 'loud' }).mode).toBe('always')
    })
})

/** System notifications shown, by title. */
let shown: string[] = []

class FakeNotification {
    onclick: (() => void) | null = null
    constructor(title: string) {
        shown.push(title)
    }
}

const item = (n: number): ActivityItem => ({
    key: `k${n}`,
    category: 'directMessages',
    title: `Member ${n}`,
    summary: 'sent you a message',
    excerpt: null,
    path: `/messages/${n}`,
    occurredAt: 0,
    unread: true,
    notify: true,
    ref: { kind: 'local' }
})

// Notices off: these cases are about the system notifications and the focus
// check in front of them.
const desktopOnly = (desktop: AlertOptions['desktop']): AlertOptions => ({
    notices: false,
    desktop,
    open: () => {},
    openList: () => {}
})

describe('system notifications follow the window focus', () => {
    beforeEach(() => {
        shown = []
        Object.assign(self, { Notification: FakeNotification })
    })

    afterEach(() => {
        mock.restore()
        Reflect.deleteProperty(self, 'Notification')
    })

    test('background mode stays quiet while Obsidian is focused', () => {
        spyOn(activeDocument, 'hasFocus').mockReturnValue(true)
        announceItems([item(1)], desktopOnly('background'))
        announceBacklog(4, desktopOnly('background'))
        expect(shown).toEqual([])
    })

    test('background mode notifies once Obsidian is in the background', () => {
        spyOn(activeDocument, 'hasFocus').mockReturnValue(false)
        announceItems([item(1)], desktopOnly('background'))
        announceBacklog(4, desktopOnly('background'))
        expect(shown).toEqual(['Member 1', 'Knowii'])
    })

    test('always notifies even while focused; off never does', () => {
        spyOn(activeDocument, 'hasFocus').mockReturnValue(true)
        announceItems([item(1)], desktopOnly('always'))
        announceItems([item(2)], desktopOnly('off'))
        expect(shown).toEqual(['Member 1'])
    })

    test('folds everything past the first few into one summary', () => {
        spyOn(activeDocument, 'hasFocus').mockReturnValue(false)
        const items = Array.from({ length: MAX_INDIVIDUAL_ALERTS + 2 }, (_, n) => item(n))
        announceItems(items, desktopOnly('background'))
        expect(shown).toEqual([
            ...items.slice(0, MAX_INDIVIDUAL_ALERTS - 1).map((it) => it.title),
            'Knowii'
        ])
    })

    test('nothing to announce shows nothing', () => {
        spyOn(activeDocument, 'hasFocus').mockReturnValue(false)
        announceItems([], desktopOnly('always'))
        announceBacklog(0, desktopOnly('always'))
        expect(shown).toEqual([])
    })
})
