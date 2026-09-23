import { describe, expect, test } from 'bun:test'
import {
    feedItems,
    messageItems,
    parseChatMessages,
    parseFeedPosts,
    parseParticipants,
    parsePostDetails,
    parseSpaceChatRoomUuid,
    parseSpaces,
    roomsToPoll,
    withoutDuplicates
} from './community-watch'
import type { ChatParticipant } from './community-watch'

const ME = { id: 32232143, name: 'Sébastien Dubois', isAdmin: true }
const SINCE = Date.parse('2026-09-22T00:00:00Z')

// Shapes captured from the live community on 2026-09-22 (trimmed).
const POSTS = {
    records: [
        {
            id: 100,
            slug: 'hello-from-texas',
            name: 'Hello from Texas',
            display_title: 'Hello from Texas',
            space_id: 2013814,
            space_slug: 'say-hello',
            space_name: 'Say Hello',
            published_at: '2026-09-22T10:00:00.000Z',
            community_member: { id: 7, first_name: 'David', last_name: 'Harding' }
        },
        {
            id: 36543529,
            slug: 'new-video',
            name: 'New video',
            space_id: 2013797,
            space_slug: 'announcements',
            space_name: 'Announcements',
            published_at: '2026-09-17T04:44:09.494Z',
            community_member: { id: ME.id, first_name: 'Sébastien', last_name: 'Dubois' }
        }
    ]
}

describe('parsers', () => {
    test('spaces', () => {
        expect(
            parseSpaces({
                records: [
                    {
                        id: 1,
                        name: 'Lounge',
                        slug: 'lounge',
                        post_type: 'chat',
                        is_space_member: true
                    },
                    { id: 2, slug: 'x' },
                    { name: 'broken' }
                ]
            })
        ).toEqual([
            { id: 1, name: 'Lounge', slug: 'lounge', kind: 'chat', isMember: true },
            { id: 2, name: 'x', slug: 'x', kind: 'basic', isMember: false }
        ])
        expect(parseSpaceChatRoomUuid({ chat_room_uuid: 'abc' })).toBe('abc')
        expect(parseSpaceChatRoomUuid({})).toBeNull()
    })

    test('feed posts', () => {
        const posts = parseFeedPosts(POSTS)
        expect(posts[0]).toEqual({
            id: 100,
            title: 'Hello from Texas',
            slug: 'hello-from-texas',
            spaceId: 2013814,
            spaceSlug: 'say-hello',
            spaceName: 'Say Hello',
            authorMemberId: 7,
            authorName: 'David Harding',
            createdAt: Date.parse('2026-09-22T10:00:00.000Z')
        })
    })

    test('post details, as an array or records', () => {
        const details = parsePostDetails([
            {
                id: 36543529,
                comments_count: 1,
                last_replied_or_posted: {
                    user_name: 'Kevin',
                    created_at: '2026-09-22T11:00:00Z',
                    type: 'replied'
                }
            }
        ])
        expect(details.get(36543529)).toEqual({
            postId: 36543529,
            userName: 'Kevin',
            at: Date.parse('2026-09-22T11:00:00Z'),
            replied: true,
            commentsCount: 1
        })
        expect(parsePostDetails({ records: [{ id: 1 }] }).get(1)?.replied).toBe(false)
    })

    test('messages skip deleted ones; participants', () => {
        expect(
            parseChatMessages({
                records: [
                    {
                        id: 1,
                        chat_room_participant_id: 5,
                        body: 'hi',
                        sent_at: '2026-09-22T10:00:00Z'
                    },
                    { id: 2, deleted_at: '2026-09-22T10:01:00Z' },
                    { id: 3, chat_room_participant_id: 6, parent_message_id: 1, body: 'yo' }
                ]
            }).map((m) => [m.id, m.parentId])
        ).toEqual([
            [1, null],
            [3, 1]
        ])
        expect(
            parseParticipants({ records: [{ id: 5, name: 'Ann', community_member_id: 9 }] })
        ).toEqual([{ id: 5, name: 'Ann', memberId: 9 }])
    })
})

describe('feedItems', () => {
    const posts = parseFeedPosts(POSTS)
    const details = parsePostDetails([
        {
            id: 36543529,
            last_replied_or_posted: {
                user_name: 'Kevin',
                created_at: '2026-09-22T11:00:00Z',
                type: 'replied'
            }
        },
        {
            id: 100,
            last_replied_or_posted: {
                user_name: 'Sébastien',
                created_at: '2026-09-22T12:00:00Z',
                type: 'replied'
            }
        }
    ])

    test('new posts by others and new comments by others, since the watch started', () => {
        const items = feedItems(posts, details, ME, { since: SINCE, mutedSpaceIds: new Set() })
        expect(items.map((i) => [i.key, i.category, i.title, i.summary, i.path])).toEqual([
            [
                'post:100',
                'posts',
                'David Harding',
                'posted in Say Hello',
                '/c/say-hello/hello-from-texas'
            ],
            [
                `comment:36543529:${Date.parse('2026-09-22T11:00:00Z')}`,
                'comments',
                'Kevin',
                'commented in Announcements',
                '/c/announcements/new-video'
            ]
        ])
        expect(items.every((i) => i.unread && i.notify && 'local' === i.ref.kind)).toBe(true)
    })

    test('nothing from before the watch started, nothing from muted spaces', () => {
        expect(
            feedItems(posts, details, ME, { since: Date.now(), mutedSpaceIds: new Set() })
        ).toEqual([])
        const muted = feedItems(posts, details, ME, {
            since: SINCE,
            mutedSpaceIds: new Set([2013814, 2013797])
        })
        expect(muted).toEqual([])
    })
})

describe('messageItems', () => {
    const people = new Map<number, ChatParticipant>([
        [5, { id: 5, name: 'Ann', memberId: 9 }],
        [6, { id: 6, name: 'Me', memberId: ME.id }]
    ])
    const messages = parseChatMessages({
        records: [
            { id: 1, chat_room_participant_id: 5, body: 'old', sent_at: '2026-09-21T10:00:00Z' },
            {
                id: 2,
                chat_room_participant_id: 5,
                body: 'new one',
                sent_at: '2026-09-22T10:00:00Z'
            },
            { id: 3, chat_room_participant_id: 6, body: 'mine', sent_at: '2026-09-22T10:05:00Z' },
            {
                id: 4,
                chat_room_participant_id: 5,
                parent_message_id: 2,
                body: 'reply',
                sent_at: '2026-09-22T10:06:00Z'
            }
        ]
    })

    test('new messages from others, threads as thread replies, linked to the message', () => {
        const items = messageItems(messages, { name: 'Obsidian', slug: 'obsidian' }, people, ME, {
            since: SINCE,
            roomUnread: true
        })
        expect(items.map((i) => [i.key, i.category, i.title, i.summary, i.path])).toEqual([
            [
                'message:2',
                'groupMessages',
                'Ann',
                'in Obsidian',
                '/c/obsidian?message_id=2#message_2'
            ],
            [
                'message:4',
                'threadReplies',
                'Ann',
                'replied in a thread in Obsidian',
                '/c/obsidian?message_id=4#message_2'
            ]
        ])
        expect(items[0]?.unread).toBe(true)
    })

    test('a room already read gives read items', () => {
        const items = messageItems(messages, { name: 'Obsidian', slug: 'obsidian' }, people, ME, {
            since: SINCE,
            roomUnread: false
        })
        expect(items.every((i) => !i.unread)).toBe(true)
    })
})

describe('roomsToPoll', () => {
    const rooms = ['a', 'b', 'c', 'd', 'e'].map((uuid) => ({ uuid }))

    test('always the unread rooms, then a rotating batch of the others', () => {
        const first = roomsToPoll(rooms, new Set(['c']), 0, 2)
        expect(first.selected.map((r) => r.uuid)).toEqual(['c', 'a', 'b'])
        const second = roomsToPoll(rooms, new Set(['c']), first.nextCursor, 2)
        expect(second.selected.map((r) => r.uuid)).toEqual(['c', 'd', 'e'])
        const third = roomsToPoll(rooms, new Set(['c']), second.nextCursor, 2)
        expect(third.selected.map((r) => r.uuid)).toEqual(['c', 'a', 'b'])
    })

    test('all unread: no rotation needed', () => {
        expect(roomsToPoll([{ uuid: 'a' }], new Set(['a']), 3, 2)).toEqual({
            selected: [{ uuid: 'a' }],
            nextCursor: 0
        })
    })
})

describe('withoutDuplicates', () => {
    test('drops watch items about a post the community already notified', () => {
        const item = (path: string) => ({
            key: path,
            category: 'posts' as const,
            title: '',
            summary: '',
            excerpt: null,
            path,
            occurredAt: 0,
            unread: true,
            notify: true,
            ref: { kind: 'local' as const }
        })
        const kept = withoutDuplicates(
            [item('/c/general/a-post'), item('/c/general/other')],
            ['/c/general/a-post#comment_wrapper_1']
        )
        expect(kept.map((i) => i.path)).toEqual(['/c/general/other'])
    })
})
