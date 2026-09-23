import { describe, expect, test } from 'bun:test'
import { ActivityWatcher, MAX_BACKOFF_MS, nextDelayMs } from './activity-watcher'
import type { ActivityWatcherHost, WatchState } from './activity-watcher'
import { CommunityClient } from './community-client'
import type { CommunityTransport, TransportResponse } from './community-transport'
import type { ActivityItem } from '../domain/community-activity'

/** A transport answering from a fixed route table. */
function fakeTransport(
    id: CommunityTransport['id'],
    routes: Record<string, TransportResponse | Error>
): CommunityTransport & { calls: string[] } {
    const calls: string[] = []
    return {
        id,
        calls,
        get(_baseUrl: string, path: string): Promise<TransportResponse> {
            calls.push(path)
            const answer = routes[path]
            if (answer instanceof Error) {
                return Promise.reject(answer)
            }
            return Promise.resolve(answer ?? { status: 404, json: null, setCookies: [] })
        },
        send(_baseUrl: string, path: string, method: string): Promise<TransportResponse> {
            calls.push(`${method} ${path}`)
            const answer = routes[`${method} ${path}`]
            if (answer instanceof Error) {
                return Promise.reject(answer)
            }
            return Promise.resolve(answer ?? { status: 200, json: null, setCookies: [] })
        },
        dispose() {}
    }
}

const ok = (json: unknown): TransportResponse => ({ status: 200, json, setCookies: [] })

const SIGNED_IN_ROUTES: Record<string, TransportResponse> = {
    '/internal_api/current_contact': ok({ id: 1, name: 'Me' }),
    '/internal_api/pundit_users': ok({ current_community_member: { is_admin: true } }),
    '/internal_api/notifications/new_notifications_count': ok({
        new_notifications_count: 1,
        new_inbox_count: 2,
        new_mentions_count: 0,
        new_content_count: 0,
        new_moderation_count: 0
    }),
    '/internal_api/notifications?per_page=50': ok({
        records: [
            {
                id: 10,
                action: 'comment',
                notifiable_type: 'Comment',
                notification_group: 'inbox',
                display_action: 'posted a comment in',
                notifiable_title: 'A post',
                actor_name: 'Ann',
                updated_at: '2026-09-22T10:00:00Z',
                read_at: null,
                action_web_path: '/c/general/a-post'
            }
        ]
    }),
    '/internal_api/chat_rooms?per_page=30': ok({
        records: [
            {
                uuid: 'dm1',
                chat_room_kind: 'direct',
                has_unread_messages: true,
                last_message: {
                    id: 5,
                    body: 'hi',
                    sent_at: '2026-09-22T11:00:00Z',
                    sender: { name: 'Bob', community_member_id: 2 }
                }
            }
        ]
    }),
    '/internal_api/chat_rooms/unread_chat_rooms': ok({ chat_room_uuids: ['dm1'] }),
    '/internal_api/chat_threads/unread_chat_threads': ok({ chat_thread_ids: [] })
}

interface RecordingHost extends ActivityWatcherHost {
    announced: { items: readonly ActivityItem[]; initial: boolean }[]
    seen: string[]
    initialized: boolean
    states: WatchState[]
    signedOut: number
}

function host(): RecordingHost {
    const h: RecordingHost = {
        announced: [],
        seen: [],
        initialized: false,
        states: [],
        signedOut: 0,
        intervalMs: () => 60_000,
        loadSeen: () => ({ keys: h.seen, initialized: h.initialized }),
        saveSeen: (keys) => {
            h.seen = [...keys]
            h.initialized = true
        },
        onState: (state) => {
            h.states.push(state)
        },
        onNewItems: (items, initial) => {
            h.announced.push({ items, initial })
        },
        onSignedOut: () => {
            h.signedOut += 1
        },
        afterCheck: () => Promise.resolve(),
        decorate: (snapshot) => [...snapshot.items]
    }
    return h
}

const clientFor = (...transports: CommunityTransport[]): CommunityClient =>
    new CommunityClient({
        baseUrl: () => 'https://www.knowii.net',
        watchOptions: () => null,
        transports: () => transports,
        onSetCookies: () => {}
    })

describe('nextDelayMs', () => {
    test('uses the interval when healthy, backs off on failures, capped', () => {
        expect(nextDelayMs(60_000, 0)).toBe(60_000)
        expect(nextDelayMs(60_000, 1)).toBe(120_000)
        expect(nextDelayMs(60_000, 3)).toBe(480_000)
        expect(nextDelayMs(60_000, 30)).toBe(MAX_BACKOFF_MS)
    })
})

describe('ActivityWatcher', () => {
    test('first check: everything unread is backlog, then only new items are announced', async () => {
        const h = host()
        const watcher = new ActivityWatcher(
            clientFor(fakeTransport('electron-session', SIGNED_IN_ROUTES)),
            h
        )

        const first = await watcher.check()
        expect(first.status).toBe('signed-in')
        expect(first.counts).toEqual({ notifications: 2, messages: 1, threads: 0 })
        expect(first.member).toEqual({ id: 1, name: 'Me', isAdmin: true })
        expect(first.items.map((item) => item.category)).toEqual(['directMessages', 'comments'])
        expect(h.announced).toHaveLength(1)
        expect(h.announced[0]?.initial).toBe(true)

        // Same state again: nothing new to say.
        await watcher.check()
        expect(h.announced).toHaveLength(1)
    })

    test('a newer message in a known conversation is announced again', async () => {
        const h = host()
        const routes = { ...SIGNED_IN_ROUTES }
        const watcher = new ActivityWatcher(clientFor(fakeTransport('electron-session', routes)), h)
        await watcher.check()

        routes['/internal_api/chat_rooms?per_page=30'] = ok({
            records: [
                {
                    uuid: 'dm1',
                    chat_room_kind: 'direct',
                    has_unread_messages: true,
                    last_message: {
                        id: 6,
                        body: 'still there?',
                        sender: { name: 'Bob', community_member_id: 2 }
                    }
                }
            ]
        })
        await watcher.check()
        expect(h.announced).toHaveLength(2)
        expect(h.announced[1]?.initial).toBe(false)
        expect(h.announced[1]?.items.map((item) => item.excerpt)).toEqual(['still there?'])
    })

    test('falls through to the next transport when one throws', async () => {
        const broken = fakeTransport('electron-session', {
            '/internal_api/current_contact': new Error('remote is gone')
        })
        const working = fakeTransport('stored-cookies', SIGNED_IN_ROUTES)
        const state = await new ActivityWatcher(clientFor(broken, working), host()).check()
        expect(state.status).toBe('signed-in')
        expect(state.transport).toBe('stored-cookies')
    })

    test('signed out: a visitor answer is not an error, and a sign-out is reported once', async () => {
        const h = host()
        const routes: Record<string, TransportResponse> = { ...SIGNED_IN_ROUTES }
        const watcher = new ActivityWatcher(clientFor(fakeTransport('electron-session', routes)), h)
        await watcher.check()

        routes['/internal_api/current_contact'] = { status: 204, json: null, setCookies: [] }
        const state = await watcher.check()
        expect(state.status).toBe('signed-out')
        expect(state.counts).toEqual({ notifications: 0, messages: 0, threads: 0 })
        expect(h.signedOut).toBe(1)

        await watcher.check()
        expect(h.signedOut).toBe(1)
    })

    test('network failures keep the last counts and report the error', async () => {
        const h = host()
        const routes: Record<string, TransportResponse | Error> = { ...SIGNED_IN_ROUTES }
        const watcher = new ActivityWatcher(clientFor(fakeTransport('electron-session', routes)), h)
        await watcher.check()

        routes['/internal_api/current_contact'] = new Error('offline')
        const state = await watcher.check()
        expect(state.status).toBe('error')
        expect(state.error).toBe('offline')
        expect(state.counts.messages).toBe(1)
    })

    test('a refused detail (private space) does not fail the check', async () => {
        const routes: Record<string, TransportResponse> = {
            ...SIGNED_IN_ROUTES,
            '/internal_api/chat_rooms/unread_chat_rooms': ok({
                chat_room_uuids: ['dm1', 'hidden']
            }),
            '/internal_api/chat_rooms/hidden': { status: 403, json: null, setCookies: [] }
        }
        const state = await new ActivityWatcher(
            clientFor(fakeTransport('electron-session', routes)),
            host()
        ).check()
        expect(state.status).toBe('signed-in')
        expect(state.counts.messages).toBe(2)
        expect(state.items.filter((item) => 'directMessages' === item.category)).toHaveLength(1)
    })

    test('concurrent callers share one check', async () => {
        const transport = fakeTransport('electron-session', SIGNED_IN_ROUTES)
        const watcher = new ActivityWatcher(clientFor(transport), host())
        await Promise.all([watcher.check(), watcher.check(), watcher.check()])
        expect(
            transport.calls.filter((path) => '/internal_api/current_contact' === path)
        ).toHaveLength(1)
    })
})

describe('admin role', () => {
    test('is looked up once per member, and a failed lookup means not admin yet', async () => {
        const routes: Record<string, TransportResponse | Error> = {
            ...SIGNED_IN_ROUTES,
            '/internal_api/pundit_users': new Error('flaky')
        }
        const transport = fakeTransport('electron-session', routes)
        const watcher = new ActivityWatcher(clientFor(transport), host())
        expect((await watcher.check()).member?.isAdmin).toBe(false)

        routes['/internal_api/pundit_users'] = ok({ current_community_member: { is_admin: true } })
        expect((await watcher.check()).member?.isAdmin).toBe(true)
        await watcher.check()
        expect(
            transport.calls.filter((path) => '/internal_api/pundit_users' === path)
        ).toHaveLength(2)
    })
})

describe('community writes', () => {
    test('mark as read and archive use the community endpoints', async () => {
        const transport = fakeTransport('electron-session', {})
        const client = clientFor(transport)
        await client.markRead({ kind: 'notification', id: 1 })
        await client.markRead({ kind: 'room', uuid: 'r 1' })
        await client.markRead({ kind: 'thread', id: 2 })
        await client.markRead({ kind: 'local' })
        await client.archive({ kind: 'notification', id: 3 })
        await client.archive({ kind: 'room', uuid: 'r2' })
        await client.markAllRead()
        expect(transport.calls).toEqual([
            'PATCH /internal_api/notifications/1/mark_as_read',
            'PATCH /internal_api/chat_rooms/r%201/mark_as_read',
            'POST /internal_api/chat_threads/2/mark_as_read',
            'PATCH /internal_api/notifications/3/archive',
            'PATCH /internal_api/chat_rooms/r2/mark_as_read',
            'POST /internal_api/notifications/mark_all_as_read',
            'PATCH /internal_api/chat_rooms/mark_all_as_read?only_unread=true',
            'PATCH /internal_api/chat_threads/mark_all_as_read'
        ])
    })

    test('a write falls through to the next transport, and a refusal is an error', async () => {
        const broken = fakeTransport('electron-session', {
            'PATCH /internal_api/notifications/1/mark_as_read': new Error('gone')
        })
        const working = fakeTransport('stored-cookies', {})
        await clientFor(broken, working).markRead({ kind: 'notification', id: 1 })
        expect(working.calls).toEqual(['PATCH /internal_api/notifications/1/mark_as_read'])

        const refusing = fakeTransport('electron-session', {
            'PATCH /internal_api/notifications/1/mark_as_read': {
                status: 422,
                json: null,
                setCookies: []
            }
        })
        expect(clientFor(refusing).markRead({ kind: 'notification', id: 1 })).rejects.toThrow(
            'refused'
        )
    })
})

describe('whole-community watch in a check', () => {
    test('new posts, comments and chat messages join the items; the space room item gives way', async () => {
        const since = Date.parse('2026-09-22T00:00:00Z')
        const routes: Record<string, TransportResponse> = {
            ...SIGNED_IN_ROUTES,
            '/internal_api/chat_rooms/unread_chat_rooms': ok({
                chat_room_uuids: ['dm1', 'room-obs']
            }),
            '/internal_api/chat_rooms/room-obs': ok({
                chat_room: {
                    uuid: 'room-obs',
                    identifier: 'space-group-chat-5',
                    chat_room_kind: 'group_chat'
                }
            }),
            '/internal_api/spaces?per_page=100': ok({
                records: [
                    { id: 5, name: 'Obsidian', slug: 'obsidian', post_type: 'chat' },
                    { id: 6, name: 'Say Hello', slug: 'say-hello', post_type: 'basic' }
                ]
            }),
            '/internal_api/spaces/5': ok({
                id: 5,
                name: 'Obsidian',
                slug: 'obsidian',
                chat_room_uuid: 'room-obs'
            }),
            '/internal_api/home_page_posts?sort=new_activity&page=1&per_page=15': ok({
                records: [
                    {
                        id: 100,
                        slug: 'hello',
                        name: 'Hello',
                        space_id: 6,
                        space_slug: 'say-hello',
                        space_name: 'Say Hello',
                        published_at: '2026-09-22T10:00:00Z',
                        community_member: { id: 7, first_name: 'David', last_name: 'H' }
                    }
                ]
            }),
            '/internal_api/post_details?post_ids=100': ok([{ id: 100 }]),
            '/internal_api/chat_rooms/room-obs/messages?previous_per_page=20&next_per_page=0': ok({
                records: [
                    {
                        id: 9,
                        chat_room_participant_id: 5,
                        body: 'hey all',
                        sent_at: '2026-09-22T11:00:00Z'
                    }
                ]
            }),
            '/internal_api/chat_rooms/room-obs/participants?ids[]=5&per_page=1': ok({
                records: [{ id: 5, name: 'Ann', community_member_id: 9 }]
            })
        }
        const client = new CommunityClient({
            baseUrl: () => 'https://www.knowii.net',
            watchOptions: () => ({ since, mutedSpaceIds: new Set() }),
            transports: () => [fakeTransport('electron-session', routes)],
            onSetCookies: () => {}
        })
        const state = await new ActivityWatcher(client, host()).check()
        const keys = state.items.map((item) => item.key)
        expect(keys).toContain('post:100')
        expect(keys).toContain('message:9')
        expect(state.items.find((item) => 'message:9' === item.key)?.ref).toEqual({
            kind: 'room',
            uuid: 'room-obs'
        })
        // The room-level "new messages in Obsidian" item is replaced by the message itself.
        expect(keys.filter((key) => key.startsWith('room:room-obs'))).toEqual([])
        expect(client.knownSpaces().map((space) => space.slug)).toEqual(['obsidian', 'say-hello'])
    })
})

describe('adjustCounts', () => {
    test('drops the counts at once, never below zero, and redraws', async () => {
        const h = host()
        const watcher = new ActivityWatcher(
            clientFor(fakeTransport('electron-session', SIGNED_IN_ROUTES)),
            h
        )
        await watcher.check()
        const drawn = h.states.length
        watcher.adjustCounts({ notifications: 1, messages: 5 })
        expect(watcher.current.counts).toEqual({ notifications: 1, messages: 0, threads: 0 })
        expect(h.states.length).toBe(drawn + 1)
    })

    test('does nothing when not signed in', () => {
        const watcher = new ActivityWatcher(clientFor(), host())
        watcher.adjustCounts({ notifications: 1 })
        expect(watcher.current.status).toBe('starting')
    })
})

describe('markAllRead failures', () => {
    test('every step is tried, and the error names the ones that failed', async () => {
        const transport = fakeTransport('electron-session', {
            'PATCH /internal_api/chat_rooms/mark_all_as_read?only_unread=true': {
                status: 404,
                json: null,
                setCookies: []
            }
        })
        expect(clientFor(transport).markAllRead()).rejects.toThrow(
            'conversations: Knowii refused (404)'
        )
        await Promise.resolve()
        expect(transport.calls).toContain('PATCH /internal_api/chat_threads/mark_all_as_read')
    })
})

describe('start', () => {
    test('starts once; a second start reports it is already running', () => {
        const watcher = new ActivityWatcher(clientFor(), host())
        const timers: unknown[] = []
        const g = globalThis as unknown as { window?: unknown }
        const hadWindow = 'window' in g
        const previous = g.window
        g.window = {
            setTimeout: (fn: unknown) => timers.push(fn),
            clearTimeout: () => {}
        }
        try {
            expect(watcher.start()).toBe(true)
            expect(watcher.start()).toBe(false)
            expect(timers).toHaveLength(1)
        } finally {
            watcher.stop()
            if (hadWindow) {
                g.window = previous
            } else {
                delete g.window
            }
        }
    })
})
