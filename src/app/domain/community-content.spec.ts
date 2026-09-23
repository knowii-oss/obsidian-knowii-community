import { describe, expect, test } from 'bun:test'
import {
    EVENT_REMINDER_MINUTES,
    parseComments,
    parseCommunityTarget,
    parseEvents,
    parseFullPost,
    parseSavedMessage,
    reminderTime,
    renderPostNote,
    renderThreadNote,
    safeFileName,
    threadTitle,
    upcomingEvents
} from './community-content'

describe('parseCommunityTarget', () => {
    test('posts, chat messages, and the rest', () => {
        expect(parseCommunityTarget('/c/announcements/new-video')).toEqual({
            kind: 'post',
            spaceSlug: 'announcements',
            postSlug: 'new-video'
        })
        expect(
            parseCommunityTarget('https://www.knowii.net/c/general/a-post#comment_wrapper_1')
        ).toEqual({
            kind: 'post',
            spaceSlug: 'general',
            postSlug: 'a-post'
        })
        expect(
            parseCommunityTarget('/c/obsidian?message_id=2154803661#message_2154762514')
        ).toEqual({
            kind: 'message',
            spaceSlug: 'obsidian',
            messageId: 2154803661
        })
        for (const other of [
            '/c/obsidian',
            '/messages/abc',
            '/notifications',
            '/u/5eb9a0e0',
            '/c/events-space/events'
        ]) {
            expect(parseCommunityTarget(other).kind).toBe('other')
        }
    })
})

// Shapes captured from the live community on 2026-09-23 (trimmed).
const POST = {
    id: 36543529,
    name: 'New video: Design your ideal week',
    slug: 'new-video',
    space_name: 'Announcements',
    space_slug: 'announcements',
    published_at: '2026-09-17T04:44:09.494Z',
    community_member: { first_name: 'Sébastien', last_name: 'Dubois', name: 'Sébastien Dubois' },
    tiptap_body: {
        body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hey everyone' }] }]
        }
    }
}

describe('posts', () => {
    test('a full post, with markdown body', () => {
        expect(parseFullPost(POST)).toEqual({
            id: 36543529,
            title: 'New video: Design your ideal week',
            slug: 'new-video',
            spaceName: 'Announcements',
            spaceSlug: 'announcements',
            author: 'Sébastien Dubois',
            publishedAt: Date.parse('2026-09-17T04:44:09.494Z'),
            markdown: 'Hey everyone'
        })
        expect(parseFullPost({ post: POST })?.id).toBe(36543529)
        expect(parseFullPost({ slug: 'x' })).toBeNull()
    })

    test('comments', () => {
        expect(
            parseComments({
                records: [
                    {
                        created_at: '2026-09-17T07:59:01.906Z',
                        show_url:
                            'https://www.knowii.net/c/announcements/new-video#comment_wrapper_1',
                        community_member: { name: 'Kevin' },
                        tiptap_body: {
                            body: {
                                type: 'doc',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'Nice!' }]
                                    }
                                ]
                            }
                        }
                    }
                ]
            })
        ).toEqual([
            {
                author: 'Kevin',
                at: Date.parse('2026-09-17T07:59:01.906Z'),
                markdown: 'Nice!',
                url: 'https://www.knowii.net/c/announcements/new-video#comment_wrapper_1'
            }
        ])
    })

    test('a saved post note: frontmatter, body, comments', () => {
        const post = parseFullPost(POST)
        if (!post) {
            throw new Error('post')
        }
        const note = renderPostNote(
            { ...post, comments: [{ author: 'Kevin', at: 0, markdown: 'Nice!', url: null }] },
            'https://www.knowii.net/c/announcements/new-video',
            Date.parse('2026-09-23T06:00:00Z')
        )
        expect(note).toContain('source: "https://www.knowii.net/c/announcements/new-video"')
        expect(note).toContain('author: "Sébastien Dubois"')
        expect(note).toContain('saved: 2026-09-23T06:00:00.000Z')
        expect(note).toContain('# New video: Design your ideal week')
        expect(note).toContain('Hey everyone')
        expect(note).toContain('## Comments\n\n### Kevin\n\nNice!')
        expect(note).not.toMatch(/\n{3,}/)
    })
})

describe('chat messages and threads', () => {
    const names = new Map([[5, 'Ann']])

    test('a message names its author from the participants', () => {
        expect(
            parseSavedMessage(
                { id: 1, chat_room_participant_id: 5, body: 'hi', sent_at: '2026-09-22T10:00:00Z' },
                names
            )
        ).toEqual({
            id: 1,
            author: 'Ann',
            at: Date.parse('2026-09-22T10:00:00Z'),
            markdown: 'hi'
        })
        expect(
            parseSavedMessage({ id: 2, chat_room_participant_id: 9, body: 'yo' }, names)?.author
        ).toBe('A member')
        expect(parseSavedMessage(null, names)).toBeNull()
    })

    test('a saved thread note, titled from its first words', () => {
        const thread = {
            spaceName: 'Obsidian',
            spaceSlug: 'obsidian',
            root: {
                id: 1,
                author: 'Ann',
                at: 0,
                markdown: 'How do you organize your **daily notes**?'
            },
            replies: [{ id: 2, author: 'Bob', at: 0, markdown: 'By week.' }]
        }
        expect(threadTitle(thread)).toBe('Ann in Obsidian: How do you organize your daily notes ?')
        const note = renderThreadNote(thread, 'https://www.knowii.net/c/obsidian?message_id=1', 0)
        expect(note).toContain('## Replies\n\n### Bob\n\nBy week.')
    })
})

describe('events', () => {
    const now = Date.parse('2026-09-23T08:00:00Z')
    const record = (id: number, starts: string, rsvp: string | null, status = 'published') => ({
        id,
        slug: `event-${id}`,
        name: `Event ${id}`,
        status,
        space_id: 2014032,
        rsvp_status: rsvp,
        event_setting_attributes: {
            starts_at: starts,
            ends_at: starts.replace('T10', 'T11'),
            time_zone: 'Europe/Brussels',
            location_type: 'live_room'
        }
    })

    test('parses, skips drafts, keeps upcoming ones, soonest first', () => {
        const events = parseEvents({
            records: [
                record(2, '2026-09-25T10:00:00Z', 'yes'),
                record(1, '2026-09-24T10:00:00Z', null),
                record(3, '2026-09-20T10:00:00Z', 'yes'),
                record(4, '2026-09-26T10:00:00Z', 'yes', 'draft')
            ]
        })
        expect(events.map((e) => e.id)).toEqual([3, 1, 2])
        expect(upcomingEvents(events, now).map((e) => e.id)).toEqual([1, 2])
        expect(events.find((e) => 2 === e.id)?.attending).toBe(true)
    })

    test('reminders only for events the member attends, before they start', () => {
        const [attending, notAttending] = parseEvents({
            records: [
                record(1, '2026-09-23T10:00:00Z', 'yes'),
                record(2, '2026-09-23T10:00:00Z', 'no')
            ]
        })
        if (!attending || !notAttending) {
            throw new Error('events')
        }
        expect(reminderTime(attending, now)).toBe(
            attending.startsAt - EVENT_REMINDER_MINUTES * 60000
        )
        expect(reminderTime(notAttending, now)).toBeNull()
        expect(reminderTime(attending, attending.startsAt - 60000)).toBeNull()
    })
})

describe('safeFileName', () => {
    test('strips characters no file system or link accepts', () => {
        expect(safeFileName('New video: Design / plan? <now> #1 [x]')).toBe(
            'New video Design plan now 1 x'
        )
        expect(safeFileName('...')).toBe('Knowii')
        expect(safeFileName('x'.repeat(300)).length).toBe(120)
    })
})
