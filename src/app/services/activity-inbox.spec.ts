import { describe, expect, test } from 'bun:test'
import { ActivityInbox, LOG_MAX_AGE_MS } from './activity-inbox'
import type { InboxStore } from './activity-inbox'
import type { ActivityItem } from '../domain/community-activity'

function memoryStore(): InboxStore & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>()
    return {
        data,
        load: (key) => data.get(key),
        save: (key, value) => {
            data.set(key, JSON.parse(JSON.stringify(value)) as unknown)
        }
    }
}

const NOW = Date.parse('2026-09-22T12:00:00Z')

const item = (key: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({
    key,
    category: 'other',
    title: key,
    summary: '',
    excerpt: null,
    path: '/',
    occurredAt: NOW - 1000,
    unread: true,
    notify: true,
    ref: { kind: 'notification', id: 1 },
    ...extra
})

describe('ActivityInbox', () => {
    test('marked read stays read, even before the community confirms', () => {
        const inbox = new ActivityInbox(memoryStore())
        inbox.markRead(['a'])
        const merged = inbox.merge([item('a'), item('b')], new Set(), NOW)
        expect(merged.map((i) => [i.key, i.unread])).toEqual([
            ['a', false],
            ['b', true]
        ])
    })

    test('archived items are hidden, until new activity gives them a new key', () => {
        const inbox = new ActivityInbox(memoryStore())
        inbox.archive(['room:x:1'])
        expect(inbox.merge([item('room:x:1')], new Set(), NOW)).toEqual([])
        expect(inbox.merge([item('room:x:2')], new Set(), NOW).map((i) => i.key)).toEqual([
            'room:x:2'
        ])
    })

    test('watch items stay listed after the check that found them, and survive a restart', () => {
        const store = memoryStore()
        const post = item('post:1', { ref: { kind: 'local' } })
        new ActivityInbox(store).merge([post], new Set(), NOW)

        const later = new ActivityInbox(store)
        expect(later.merge([], new Set(), NOW).map((i) => i.key)).toEqual(['post:1'])
    })

    test('old watch items fall out of the log', () => {
        const store = memoryStore()
        const inbox = new ActivityInbox(store)
        inbox.merge(
            [item('post:old', { ref: { kind: 'local' }, occurredAt: NOW - LOG_MAX_AGE_MS - 1 })],
            new Set(),
            NOW
        )
        expect(inbox.merge([], new Set(), NOW)).toEqual([])
    })

    test('logged chat messages turn read once their room is read on the community', () => {
        const inbox = new ActivityInbox(memoryStore())
        const message = item('message:5', { ref: { kind: 'room', uuid: 'r1' } })
        expect(inbox.merge([message], new Set(['r1']), NOW)[0]?.unread).toBe(true)
        expect(inbox.merge([], new Set(), NOW)[0]?.unread).toBe(false)
    })

    test('state is read back from storage', () => {
        const store = memoryStore()
        new ActivityInbox(store).archive(['gone'])
        expect(new ActivityInbox(store).isArchived('gone')).toBe(true)
    })

    test('junk in storage is ignored', () => {
        const store = memoryStore()
        store.data.set('knowii-community:read-items', 'nope')
        store.data.set('knowii-community:watch-log', [{ key: 1 }, null])
        expect(new ActivityInbox(store).merge([], new Set(), NOW)).toEqual([])
    })
})
