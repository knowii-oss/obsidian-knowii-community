import { describe, expect, test } from 'bun:test'
import { wantsDesktopNotification } from './activity-alerts'
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
