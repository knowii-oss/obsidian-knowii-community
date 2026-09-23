import { describe, expect, test } from 'bun:test'
import {
    ACTIVITY_CATEGORIES,
    categorizeNotification,
    excerptOf,
    formatAge,
    parseChatRoom,
    parseChatRooms,
    parseChatThread,
    parseCurrentMember,
    parseIsAdmin,
    parseNotificationCount,
    parseSpace,
    parseNotifications,
    parseUnreadRoomUuids,
    parseUnreadThreadIds,
    rememberKeys,
    roomToItem,
    sortItems,
    spaceIdOfRoom,
    threadToItem,
    toCommunityPath,
    unseenItems
} from './community-activity'
import type { ActivityItem } from './community-activity'

const ME = { id: 32232143, name: 'Sébastien Dubois', isAdmin: false }

// Shapes captured from the live community on 2026-09-22 (trimmed).
const NOTIFICATIONS = {
    page: 1,
    records: [
        {
            id: 44770454531,
            notifiable_type: 'Contact',
            action: 'profile_confirmed',
            updated_at: '2026-09-22T15:59:15.076Z',
            read_at: null,
            notification_group: 'inbox',
            notifiable_title: null,
            space_title: '',
            display_action: 'joined the community',
            actor_name: 'Donny',
            action_web_url: 'https://www.knowii.net/u/5eb9a0e0',
            action_web_path: '/u/5eb9a0e0'
        },
        {
            id: 44755389635,
            notifiable_type: 'ChatRoomMessage',
            action: 'mention',
            updated_at: '2026-09-22T14:21:41.303Z',
            read_at: '2026-09-22T14:21:41.000Z',
            notification_group: 'mentions',
            notifiable_title: 'Obsidian Starter Kit Discussions',
            display_action: 'mentioned you in a message on:',
            actor_name: 'Phillip George',
            action_web_path:
                '/c/obsidian-starter-kit-lounge?message_id=2154803661#message_2154762514'
        },
        {
            id: 44700000000,
            notifiable_type: 'Comment',
            action: 'comment_to_author',
            updated_at: '2026-09-21T10:00:00.000Z',
            read_at: null,
            notification_group: 'inbox',
            notifiable_title: 'My first post',
            display_action: 'commented on your post:',
            actor_name: 'Kevin',
            second_actor_name: 'Ann',
            action_web_url: 'https://www.knowii.net/c/general/my-first-post#comment_1'
        }
    ]
}

describe('parseCurrentMember', () => {
    test('reads the signed-in member', () => {
        expect(parseCurrentMember({ id: 32232143, name: 'Sébastien Dubois' })).toEqual(ME)
    })

    test('is null for a visitor (empty body) or junk', () => {
        expect(parseCurrentMember(null)).toBeNull()
        expect(parseCurrentMember({ password: null })).toBeNull()
        expect(parseCurrentMember([])).toBeNull()
    })
})

describe('parseNotificationCount', () => {
    test('sums the notification groups', () => {
        expect(
            parseNotificationCount({
                new_notifications_count: 1,
                new_mentions_count: 2,
                new_inbox_count: 50,
                new_content_count: 3,
                new_moderation_count: 0
            })
        ).toBe(55)
    })

    test('is null for what a signed-out visitor gets', () => {
        expect(parseNotificationCount({ password: null })).toBeNull()
    })
})

describe('parseNotifications', () => {
    const all = parseNotifications(NOTIFICATIONS)
    const items = all.filter((item) => item.unread)

    test('keeps read and unread, flagged', () => {
        expect(all.map((item) => [item.key, item.unread])).toEqual([
            ['notification:44770454531:2026-09-22T15:59:15.076Z', true],
            ['notification:44755389635:2026-09-22T14:21:41.303Z', false],
            ['notification:44700000000:2026-09-21T10:00:00.000Z', true]
        ])
    })

    test('builds a readable item with a community path', () => {
        expect(items[0]).toEqual({
            key: 'notification:44770454531:2026-09-22T15:59:15.076Z',
            category: 'newMembers',
            title: 'Donny',
            summary: 'joined the community',
            excerpt: null,
            path: '/u/5eb9a0e0',
            occurredAt: Date.parse('2026-09-22T15:59:15.076Z'),
            unread: true,
            notify: true,
            ref: { kind: 'notification', id: 44770454531 }
        })
        expect(items[1]?.title).toBe('Kevin and Ann')
        expect(items[1]?.summary).toBe('commented on your post My first post')
        expect(items[1]?.path).toBe('/c/general/my-first-post#comment_1')
        expect(items[1]?.category).toBe('comments')
    })

    test('the same notification updated later gets a new key', () => {
        const again = parseNotifications({
            records: [{ ...NOTIFICATIONS.records[0], updated_at: '2026-09-23T08:00:00.000Z' }]
        })
        expect(again[0]?.key).not.toBe(items[0]?.key)
    })

    test('ignores junk', () => {
        expect(parseNotifications(null)).toEqual([])
        expect(parseNotifications({ records: [null, 3, { read_at: null }] })).toEqual([])
    })
})

describe('categorizeNotification', () => {
    const cases: [string, string, string, string][] = [
        ['mention', 'ChatRoomMessage', 'mentions', 'mentions'],
        ['mention', 'Comment', 'mentions', 'mentions'],
        ['like', 'Post', 'inbox', 'reactions'],
        ['like', 'Comment', 'inbox', 'reactions'],
        ['comment', 'Comment', 'inbox', 'comments'],
        ['comment_to_author', 'Comment', 'inbox', 'comments'],
        ['add', 'Post', 'following', 'posts'],
        ['profile_confirmed', 'Contact', 'inbox', 'newMembers'],
        ['rsvp', 'Event', 'inbox', 'events'],
        ['something_new', 'Thing', 'inbox', 'other']
    ]
    for (const [action, notifiableType, group, expected] of cases) {
        test(`${action} on ${notifiableType} is ${expected}`, () => {
            expect(categorizeNotification({ action, notifiableType, group })).toBe(
                expected as ActivityItem['category']
            )
        })
    }
})

describe('chat rooms', () => {
    const direct = {
        uuid: 'ff173709',
        identifier: 'direct-32232143-89599298',
        chat_room_name: 'Xi CHEN',
        chat_room_kind: 'direct',
        is_embedded: false,
        has_unread_messages: true,
        last_message: {
            id: 2147019661,
            body: 'Hello\n\nthere',
            sent_at: '2026-09-01T19:43:00.535Z',
            sender: { name: 'Xi CHEN', community_member_id: 89599298 }
        },
        other_participants_preview: [{ name: 'Xi CHEN' }]
    }

    test('parses the room list and single-room answers', () => {
        expect(parseChatRooms({ records: [direct, null] })).toHaveLength(1)
        const single = parseChatRoom({
            chat_room: {
                uuid: 'fa077454',
                identifier: 'space-group-chat-2013812',
                chat_room_kind: 'group_chat',
                is_embedded: true,
                first_unread_message_id: 42
            }
        })
        expect(single?.firstUnreadMessageId).toBe(42)
        expect(single && spaceIdOfRoom(single)).toBe(2013812)
    })

    test('a direct message from someone else becomes an item', () => {
        const room = parseChatRoom(direct)
        expect(room).not.toBeNull()
        const item = room ? roomToItem(room, ME, null, true) : null
        expect(item).toEqual({
            key: 'room:ff173709:2147019661',
            category: 'directMessages',
            title: 'Xi CHEN',
            summary: 'sent you a message',
            excerpt: 'Hello there',
            path: '/messages/ff173709',
            occurredAt: Date.parse('2026-09-01T19:43:00.535Z'),
            unread: true,
            notify: true,
            ref: { kind: 'room', uuid: 'ff173709' }
        })
        expect(room ? roomToItem(room, ME, null, false).unread : null).toBe(false)
    })

    test('my own last message is never unread news', () => {
        const room = parseChatRoom({
            ...direct,
            last_message: {
                ...direct.last_message,
                sender: { name: 'Me', community_member_id: ME.id }
            }
        })
        const item = room ? roomToItem(room, ME, null, true) : null
        expect(item?.unread).toBe(false)
        expect(item?.title).toBe('Xi CHEN')
        expect(item?.summary).toBe('you replied')
    })

    test('a space chat links to the space', () => {
        const room = parseChatRoom({
            chat_room: {
                uuid: 'bb59',
                identifier: 'space-group-chat-2014197',
                chat_room_kind: 'group_chat',
                is_embedded: true,
                first_unread_message_id: 7
            }
        })
        const space = { id: 2014197, name: 'OSK Discussions', slug: 'obsidian-starter-kit-lounge' }
        const item = room ? roomToItem(room, ME, space, true) : null
        expect(item?.category).toBe('groupMessages')
        expect(item?.title).toBe('OSK Discussions')
        expect(item?.path).toBe('/c/obsidian-starter-kit-lounge')
        expect(item?.key).toBe('room:bb59:7')
    })
})

describe('threads', () => {
    const json = {
        id: 2001913610,
        parent_message: {
            id: 2154762514,
            chat_room_uuid: 'bb59',
            body: 'I will include a plugin for the Knowii Community in OSK v5.'
        },
        replies: [
            {
                id: 1,
                chat_room_participant_id: 99,
                body: 'first',
                sent_at: '2026-09-22T11:00:00.000Z'
            },
            {
                id: 2,
                chat_room_participant_id: 99,
                body: 'Unfortunately…',
                sent_at: '2026-09-22T11:12:17.600Z'
            }
        ],
        current_participant: { id: 1621324467 },
        chat_room: { kind: 'group_chat', embedded_space_id: 2014197 }
    }
    const space = { id: 2014197, name: 'OSK Discussions', slug: 'obsidian-starter-kit-lounge' }

    test('an unread thread in a space links to the latest reply', () => {
        const thread = parseChatThread(json)
        const item = thread ? threadToItem(thread, space) : null
        expect(item?.category).toBe('threadReplies')
        expect(item?.key).toBe('thread:2001913610:2')
        expect(item?.summary).toBe('New replies in OSK Discussions')
        expect(item?.excerpt).toBe('Unfortunately…')
        expect(item?.path).toBe('/c/obsidian-starter-kit-lounge?message_id=2#message_2154762514')
    })

    test('my own latest reply is not news', () => {
        const thread = parseChatThread({
            ...json,
            replies: [{ id: 3, chat_room_participant_id: 1621324467, body: 'mine' }]
        })
        expect(thread ? threadToItem(thread, space) : 'no thread').toBeNull()
    })
})

describe('small parsers', () => {
    test('unread ids and uuids', () => {
        expect(parseUnreadRoomUuids({ chat_room_uuids: ['a', '', 3, 'b'] })).toEqual(['a', 'b'])
        expect(parseUnreadThreadIds({ chat_thread_ids: [1, '2', 'x'] })).toEqual([1, 2])
        expect(parseUnreadRoomUuids({ password: null })).toEqual([])
    })

    test('spaces', () => {
        expect(parseSpace({ id: 1, name: 'General', slug: 'lounge' })).toEqual({
            id: 1,
            name: 'General',
            slug: 'lounge'
        })
        expect(parseSpace({ id: 1 })).toBeNull()
    })

    test('paths stay on the community', () => {
        expect(toCommunityPath('/c/x', '/n')).toBe('/c/x')
        expect(toCommunityPath('https://www.knowii.net/c/x?a=1#b', '/n')).toBe('/c/x?a=1#b')
        expect(toCommunityPath('//evil.example/x', '/n')).toBe('/n')
        expect(toCommunityPath('javascript:alert(1)', '/n')).toBe('/n')
        expect(toCommunityPath(null, '/n')).toBe('/n')
    })

    test('excerpts are one line and bounded', () => {
        expect(excerptOf('  a\n b  ')).toBe('a b')
        expect(excerptOf('x'.repeat(500))?.length).toBe(140)
        expect(excerptOf('   ')).toBeNull()
    })

    test('ages', () => {
        const now = Date.parse('2026-09-22T12:00:00Z')
        expect(formatAge(now - 10_000, now)).toBe('just now')
        expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago')
        expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
        expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 d ago')
    })
})

describe('what is new', () => {
    const item = (
        key: string,
        occurredAt: number,
        category: ActivityItem['category'] = 'other'
    ): ActivityItem => ({
        key,
        category,
        title: key,
        summary: '',
        excerpt: null,
        path: '/',
        occurredAt,
        unread: true,
        notify: true,
        ref: { kind: 'local' }
    })

    test('unseen items are the ones never announced', () => {
        expect(unseenItems([item('a', 1), item('b', 2)], new Set(['a'])).map((i) => i.key)).toEqual(
            ['b']
        )
    })

    test('remembered keys are deduplicated and bounded, oldest out first', () => {
        expect(rememberKeys(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
        expect(rememberKeys(['a', 'b', 'c'], ['d'], 3)).toEqual(['b', 'c', 'd'])
    })

    test('newest first, conversations before notifications on ties', () => {
        const sorted = sortItems([
            item('n', 5, 'other'),
            item('dm', 5, 'directMessages'),
            item('new', 9)
        ])
        expect(sorted.map((i) => i.key)).toEqual(['new', 'dm', 'n'])
    })

    test('every category has a label, a description and an icon', () => {
        for (const info of ACTIVITY_CATEGORIES) {
            expect(info.label).not.toBe('')
            expect(info.description).not.toBe('')
            expect(info.icon).not.toBe('')
        }
    })
})

describe('parseIsAdmin', () => {
    test('reads the admin flag or role', () => {
        expect(parseIsAdmin({ current_community_member: { is_admin: true } })).toBe(true)
        expect(
            parseIsAdmin({ current_community_member: { is_admin: false, roles: { admin: true } } })
        ).toBe(true)
        expect(parseIsAdmin({ current_community_member: { is_admin: false, roles: {} } })).toBe(
            false
        )
    })

    test('anything unexpected is not an admin', () => {
        expect(parseIsAdmin(null)).toBe(false)
        expect(parseIsAdmin({ current_community_member: { is_admin: 'yes' } })).toBe(false)
    })
})
