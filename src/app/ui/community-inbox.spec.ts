import { describe, expect, test } from 'bun:test'
import { inboxItems } from './community-inbox'
import type { ActivityItem } from '../domain/community-activity'

const item = (key: string, unread: boolean, title: string): ActivityItem => ({
    key,
    category: 'directMessages',
    title,
    summary: 'sent you a message',
    excerpt: null,
    path: `/messages/${key}`,
    occurredAt: 1,
    unread,
    notify: true,
    ref: { kind: 'local' }
})

const items = [item('a', true, 'Ada'), item('b', false, 'Bob'), item('c', true, 'Carl')]

describe('inboxItems', () => {
    test('all keeps every item, in order', () => {
        expect(inboxItems(items, 'all', '').map((i) => i.key)).toEqual(['a', 'b', 'c'])
    })

    test('unread keeps unread items only', () => {
        expect(inboxItems(items, 'unread', '').map((i) => i.key)).toEqual(['a', 'c'])
    })

    test('the query narrows either filter', () => {
        expect(inboxItems(items, 'all', 'bob').map((i) => i.key)).toEqual(['b'])
        expect(inboxItems(items, 'unread', 'bob')).toEqual([])
        expect(inboxItems(items, 'unread', 'carl').map((i) => i.key)).toEqual(['c'])
    })
})
