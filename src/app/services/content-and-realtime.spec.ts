import { describe, expect, test } from 'bun:test'
import { CommunityClient } from './community-client'
import type { CommunityTransport, TransportResponse, WriteMethod } from './community-transport'
import { realtimeScript } from './realtime-link'
import { EventReminders } from './event-reminders'
import { eventWhen, postableSpaces } from '../ui/compose-modals'
import type { WatchableSpace } from '../domain/community-watch'
import type { CommunityEvent } from '../domain/community-content'

const ok = (json: unknown): TransportResponse => ({ status: 200, json, setCookies: [] })

/** The message a promise rejects with (empty when it resolves). */
const failure = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

function transport(
    id: CommunityTransport['id'],
    routes: Record<string, TransportResponse | Error>
): CommunityTransport & { calls: { method: string; path: string; body?: unknown }[] } {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const answer = (key: string, fallback: TransportResponse): Promise<TransportResponse> => {
        const found = routes[key]
        return found instanceof Error ? Promise.reject(found) : Promise.resolve(found ?? fallback)
    }
    return {
        id,
        calls,
        get(_base: string, path: string) {
            calls.push({ method: 'GET', path })
            return answer(path, { status: 404, json: null, setCookies: [] })
        },
        send(_base: string, path: string, method: WriteMethod, body?: unknown) {
            calls.push({ method, path, body })
            return answer(`${method} ${path}`, ok(null))
        },
        dispose() {}
    }
}

const SPACES = ok({
    records: [
        {
            id: 6,
            name: 'Say Hello',
            slug: 'say-hello',
            post_type: 'basic',
            is_space_member: true,
            policies: { can_create_post: true }
        },
        {
            id: 5,
            name: 'Obsidian',
            slug: 'obsidian',
            post_type: 'chat',
            is_space_member: true,
            policies: {}
        }
    ]
})

function client(...transports: CommunityTransport[]): CommunityClient {
    return new CommunityClient({
        baseUrl: () => 'https://www.knowii.net',
        watchOptions: () => null,
        transports: () => transports,
        onSetCookies: () => {}
    })
}

describe('content through the provider', () => {
    test('fetchPost reads the post by slug in its space, then its comments, oldest first', async () => {
        const t = transport('electron-session', {
            '/internal_api/spaces?per_page=100': SPACES,
            '/internal_api/spaces/6/posts/hello': ok({
                id: 100,
                slug: 'hello',
                name: 'Hello',
                community_member: { name: 'David' }
            }),
            '/internal_api/posts/100/comments?per_page=100&page=1': ok({
                records: [
                    {
                        created_at: '2026-09-23T10:00:00Z',
                        community_member: { name: 'B' },
                        body: 'second'
                    },
                    {
                        created_at: '2026-09-23T09:00:00Z',
                        community_member: { name: 'A' },
                        body: 'first'
                    }
                ]
            })
        })
        const post = await client(t).fetchPost({
            kind: 'post',
            spaceSlug: 'say-hello',
            postSlug: 'hello'
        })
        expect(post.title).toBe('Hello')
        expect(post.spaceName).toBe('Say Hello')
        expect(post.comments.map((c) => c.markdown)).toEqual(['first', 'second'])
    })

    test('createPost publishes with space_id inside the post, and is never retried elsewhere', async () => {
        const first = transport('electron-session', {
            '/internal_api/spaces?per_page=100': SPACES,
            'POST /internal_api/spaces/6/posts': new Error('network dropped after sending')
        })
        const second = transport('stored-cookies', {})
        const c = client(first, second)
        await c
            .fetchPost({ kind: 'post', spaceSlug: 'say-hello', postSlug: 'x' })
            .catch(() => undefined)
        expect(await failure(c.createPost(6, 'Question', 'How?'))).toContain('network dropped')
        // Reads may fall back to another transport; a post never does.
        expect(second.calls.filter((call) => 'GET' !== call.method)).toEqual([])
        const sent = first.calls.find((call) => 'POST' === call.method)
        expect(sent?.body).toEqual({
            post: {
                space_id: 6,
                name: 'Question',
                status: 'published',
                tiptap_body: {
                    body: {
                        type: 'doc',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'How?' }] }]
                    }
                }
            }
        })
    })

    test('createPost answers the path of the new post', async () => {
        const t = transport('electron-session', {
            '/internal_api/spaces?per_page=100': SPACES,
            'POST /internal_api/spaces/6/posts': ok({ id: 1, slug: 'question' })
        })
        const c = client(t)
        await c
            .fetchPost({ kind: 'post', spaceSlug: 'say-hello', postSlug: 'x' })
            .catch(() => undefined)
        expect(await c.createPost(6, 'Question', 'How?')).toBe('/c/say-hello/question')
        expect(await failure(c.createPost(6, ' ', 'How?'))).toContain('title')
    })

    test('sendMessage never sends an empty message, and sends as the current participant', async () => {
        const t = transport('electron-session', {
            '/internal_api/chat_rooms/dm1': ok({
                chat_room: { uuid: 'dm1', current_participant: { id: 77 } }
            })
        })
        const c = client(t)
        expect(await failure(c.sendMessage('dm1', '  \n '))).toContain('empty')
        expect(t.calls).toEqual([])
        await c.sendMessage('dm1', 'Thanks!')
        expect(t.calls.at(-1)).toEqual({
            method: 'POST',
            path: '/internal_api/chat_rooms/dm1/messages',
            body: {
                chat_room_message: {
                    chat_room_participant_id: 77,
                    rich_text_body: {
                        body: {
                            type: 'doc',
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'Thanks!' }] }
                            ]
                        }
                    }
                }
            }
        })
    })

    test('realtime endpoint: the web app channels for this member', () => {
        const endpoint = client().realtime({ id: 9, name: 'Me', isAdmin: false })
        expect(endpoint.path).toBe('/cable')
        expect(endpoint.subscriptions.map((command) => JSON.parse(command) as unknown)).toEqual([
            {
                command: 'subscribe',
                identifier: '{"channel":"NotificationChannel","community_member_id":9}'
            },
            { command: 'subscribe', identifier: '{"channel":"ChatRoomChannel","contact_id":9}' }
        ])
    })
})

describe('realtimeScript', () => {
    test('subscribes on welcome and reports activity, never payloads', () => {
        const script = realtimeScript({
            path: '/cable',
            protocol: 'actioncable-v1-json',
            subscriptions: ['{"command":"subscribe"}']
        })
        expect(script).toContain("'welcome' === message.type")
        expect(script).toContain('__knowii_rt__:')
        expect(script).toContain('"actioncable-v1-json"')
        // Only fixed signal words are logged, never the payload itself.
        expect(script).not.toMatch(/console\.log\([^)]*message\.message/)
        // It must be valid JavaScript: it runs as-is in the community page.
        expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(script)).not.toThrow()
    })
})

describe('EventReminders', () => {
    test('arms reminders for attended events within a day, once per event', async () => {
        const now = Date.parse('2026-09-23T08:00:00Z')
        const store = new Map<string, unknown>()
        const reminded: string[] = []
        const timers: { fn: () => void; ms: number }[] = []
        const g = globalThis as unknown as { window?: unknown }
        const previous = g.window
        g.window = {
            setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
            clearTimeout: () => {}
        }
        const event = (id: number, startsIn: number, attending: boolean): CommunityEvent => ({
            id,
            name: `E${id}`,
            slug: `e${id}`,
            spaceId: 1,
            startsAt: now + startsIn,
            endsAt: now + startsIn + 3600000,
            timeZone: null,
            attending,
            location: null
        })
        try {
            const reminders = new EventReminders({
                upcomingEvents: () =>
                    Promise.resolve([
                        { event: event(1, 60 * 60000, true), path: '/c/events/e1' },
                        { event: event(2, 60 * 60000, false), path: '/c/events/e2' },
                        { event: event(3, 3 * 86400000, true), path: '/c/events/e3' }
                    ]),
                remind: (e) => reminded.push(e.name),
                load: (key) => store.get(key),
                save: (key, value) => store.set(key, value)
            })
            await reminders.refresh(now)
            expect(timers.map((t) => t.ms)).toEqual([45 * 60000])
            timers[0]?.fn()
            expect(reminded).toEqual(['E1'])
            timers.length = 0
            await reminders.refresh(now)
            expect(timers).toEqual([])
        } finally {
            g.window = previous
        }
    })
})

describe('compose helpers', () => {
    const space = (slug: string, extra: Partial<WatchableSpace> = {}): WatchableSpace => ({
        id: slug.length,
        name: slug,
        slug,
        kind: 'basic',
        isMember: true,
        canPost: true,
        ...extra
    })

    test('postable spaces: member, allowed, posts or events; ask-the-community first', () => {
        expect(
            postableSpaces([
                space('zeta'),
                space('ask-the-community'),
                space('alpha'),
                space('lounge', { kind: 'chat' }),
                space('locked', { canPost: false }),
                space('elsewhere', { isMember: false })
            ]).map((s) => s.slug)
        ).toEqual(['ask-the-community', 'alpha', 'zeta'])
    })

    test('event timing in plain words', () => {
        const now = Date.parse('2026-09-23T08:00:00Z')
        const event = (startsIn: number): CommunityEvent => ({
            id: 1,
            name: 'E',
            slug: 'e',
            spaceId: 1,
            startsAt: now + startsIn,
            endsAt: now + startsIn + 3600000,
            timeZone: null,
            attending: true,
            location: null
        })
        expect(eventWhen(event(-60000), now)).toBe('happening now')
        expect(eventWhen(event(20 * 60000), now)).toBe('in 20 min')
        expect(eventWhen(event(86400000), now)).not.toBe('')
    })
})
