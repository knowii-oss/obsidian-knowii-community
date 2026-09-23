import { describe, expect, test } from 'bun:test'
import { matchesQuery } from './activity-modal'
import type { ActivityItem } from '../domain/community-activity'

const base: ActivityItem = {
    key: 'k',
    category: 'directMessages',
    title: 'Phillip George',
    summary: 'sent you a message',
    excerpt: 'About the Knowii platform',
    path: '/messages/x',
    occurredAt: 1,
    unread: true,
    notify: true,
    ref: { kind: 'local' }
}

describe('matchesQuery', () => {
    test('empty query shows everything', () => {
        expect(matchesQuery(base, '')).toBe(true)
        expect(matchesQuery({ ...base, unread: false }, '  ')).toBe(true)
    })

    test('every word must match title, text or category', () => {
        expect(matchesQuery(base, 'phillip platform')).toBe(true)
        expect(matchesQuery(base, 'direct')).toBe(true)
        expect(matchesQuery(base, 'phillip events')).toBe(false)
    })

    test('is:unread keeps unread items only, combined with words', () => {
        expect(matchesQuery(base, 'is:unread')).toBe(true)
        expect(matchesQuery({ ...base, unread: false }, 'is:unread')).toBe(false)
        expect(matchesQuery(base, 'is:unread phillip')).toBe(true)
        expect(matchesQuery(base, 'IS:UNREAD nobody')).toBe(false)
    })
})

describe('ActivityModal', () => {
    test('defines nothing that shadows the suggest modal internals it relies on', async () => {
        // A `chooser` method once replaced Obsidian's own `chooser` field and
        // broke every row action; keep the names apart.
        const { ActivityModal } = await import('./activity-modal')
        for (const name of ['chooser', 'inputEl', 'resultContainerEl', 'scope', 'modalEl']) {
            expect(Object.getOwnPropertyNames(ActivityModal.prototype)).not.toContain(name)
        }
    })
})
