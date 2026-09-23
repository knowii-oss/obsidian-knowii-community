import type {
    ActivityCounts,
    ActivityItem,
    ChatRoom,
    CommunityMember,
    Space
} from '../domain/community-activity'
import {
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
    roomToItem,
    sortItems,
    spaceIdOfRoom,
    threadToItem
} from '../domain/community-activity'
import type {
    CommunityTransport,
    TransportId,
    TransportResponse,
    WriteMethod
} from './community-transport'
import type { ActivityRef } from '../domain/community-activity'
import type { ChatParticipant, WatchableSpace } from '../domain/community-watch'
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
} from '../domain/community-watch'

/** Everything unread, at one point in time. */
export interface ActivitySnapshot {
    readonly member: CommunityMember
    readonly counts: ActivityCounts
    readonly items: readonly ActivityItem[]
    readonly fetchedAt: number
    readonly transport: TransportId
    /** Conversations the community reports unread (for the inbox's read state). */
    readonly unreadRoomUuids: ReadonlySet<string>
}

export type ActivityResult =
    | { readonly status: 'signed-in'; readonly snapshot: ActivitySnapshot }
    | { readonly status: 'signed-out'; readonly transport: TransportId }

/** Details fetched per poll are capped; the counts stay exact regardless. */
const MAX_ROOM_DETAILS = 15
const MAX_THREAD_DETAILS = 15
const NOTIFICATIONS_PAGE = 50
const ROOMS_PAGE = 30
/** Whole-community watch: posts looked at per check (by latest activity). */
const FEED_PAGE = 15
/** Chat rooms read per check besides the unread ones (rotating). */
const ROOM_BATCH = 6
/** Space chat rooms resolved per check (their uuid needs one lookup each, once). */
const ROOM_LOOKUPS_PER_CHECK = 8
const SPACES_TTL_MS = 15 * 60 * 1000

/** The member is not signed in (on this transport). */
class SignedOutError extends Error {
    constructor() {
        super('Not signed in')
    }
}

/** What to watch across the whole community; null when that is off. */
export interface WatchOptions {
    /** Only activity after this moment is reported (no backlog flood). */
    readonly since: number
    readonly mutedSpaceIds: ReadonlySet<number>
}

export interface CommunityClientHost {
    baseUrl(): string
    watchOptions(): WatchOptions | null
    /** Transports to try, in order. */
    transports(): readonly CommunityTransport[]
    /** Cookie updates seen on a response (stored-cookie transport only). */
    onSetCookies(headers: readonly string[]): void
}

/**
 * Reads the member's unread activity from the community's own web endpoints
 * (the ones its web app uses), as the signed-in member. Read-only: it never
 * marks anything as read.
 */
export class CommunityClient {
    /** Space names and slugs barely change; one lookup per space per session. */
    private readonly spaces = new Map<number, Space | null>()
    /** Admin role per member id; looked up once per member per session. */
    private readonly adminRoles = new Map<number, boolean>()
    private spacesCache: { at: number; spaces: WatchableSpace[] } | null = null
    /** Space id → its chat room uuid (null: the space has none we can read). */
    private readonly spaceRooms = new Map<number, string | null>()
    /** Room uuid → participant id → participant. */
    private readonly participants = new Map<string, Map<number, ChatParticipant>>()
    private roomCursor = 0

    constructor(private readonly host: CommunityClientHost) {}

    /**
     * One full check. Tries each transport in turn; a transport that throws
     * hands over to the next. Throws only when every transport failed.
     */
    async fetchActivity(): Promise<ActivityResult> {
        const transports = this.host.transports()
        let lastError: unknown = new Error('No way to reach the community on this device')
        for (const transport of transports) {
            try {
                const snapshot = await this.fetchWith(transport)
                return { status: 'signed-in', snapshot }
            } catch (error: unknown) {
                if (error instanceof SignedOutError) {
                    return { status: 'signed-out', transport: transport.id }
                }
                lastError = error
            }
        }
        throw lastError
    }

    /** Forget cached space details and roles (the community address changed). */
    reset(): void {
        this.spaces.clear()
        this.adminRoles.clear()
        this.spacesCache = null
        this.spaceRooms.clear()
        this.participants.clear()
    }

    /**
     * Spaces the member belongs to, as of the last check (for the settings'
     * per-space switches). Spaces they can see but have not joined are left
     * out: there is nothing of theirs to watch there.
     */
    knownSpaces(): readonly WatchableSpace[] {
        return (this.spacesCache?.spaces ?? []).filter((space) => space.isMember)
    }

    // -----------------------------------------------------------------------
    // Writes: mark as read, archive (the community's own endpoints)
    // -----------------------------------------------------------------------

    /** Marks one item read on the community. Local-only items need nothing here. */
    async markRead(ref: ActivityRef): Promise<void> {
        switch (ref.kind) {
            case 'notification':
                await this.write(`/internal_api/notifications/${ref.id}/mark_as_read`, 'PATCH')
                return
            case 'room':
                await this.write(
                    `/internal_api/chat_rooms/${encodeURIComponent(ref.uuid)}/mark_as_read`,
                    'PATCH'
                )
                return
            case 'thread':
                await this.write(`/internal_api/chat_threads/${ref.id}/mark_as_read`, 'POST')
                return
            case 'local':
                return
        }
    }

    /** Archives a notification on the community; other items are only marked read there. */
    async archive(ref: ActivityRef): Promise<void> {
        if ('notification' === ref.kind) {
            await this.write(`/internal_api/notifications/${ref.id}/archive`, 'PATCH')
            return
        }
        await this.markRead(ref)
    }

    /**
     * Everything read on the community: notifications, conversations,
     * threads. Verbs and parameters as the web app sends them (POST for
     * notifications, PATCH with `only_unread` for chats, PATCH for threads).
     * All three are tried; the error names the ones that failed.
     */
    async markAllRead(): Promise<void> {
        const steps: [string, string, WriteMethod][] = [
            ['notifications', '/internal_api/notifications/mark_all_as_read', 'POST'],
            [
                'conversations',
                '/internal_api/chat_rooms/mark_all_as_read?only_unread=true',
                'PATCH'
            ],
            ['threads', '/internal_api/chat_threads/mark_all_as_read', 'PATCH']
        ]
        const failed: string[] = []
        for (const [label, path, method] of steps) {
            try {
                await this.write(path, method)
            } catch (error: unknown) {
                failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (failed.length > 0) {
            throw new Error(failed.join('; '))
        }
    }

    /** One write, through the first transport that manages to send it. */
    private async write(path: string, method: WriteMethod): Promise<void> {
        let lastError: unknown = new Error('No way to reach the community on this device')
        for (const transport of this.host.transports()) {
            try {
                const response = await transport.send(this.host.baseUrl(), path, method)
                if (response.setCookies.length > 0) {
                    this.host.onSetCookies(response.setCookies)
                }
                if (401 === response.status) {
                    throw new Error('Not signed in to Knowii')
                }
                if (response.status >= 400) {
                    throw new Error(`Knowii refused (${response.status})`)
                }
                return
            } catch (error: unknown) {
                lastError = error
            }
        }
        throw lastError
    }

    // -----------------------------------------------------------------------
    // Whole-community watch
    // -----------------------------------------------------------------------

    private async readCommunity(
        get: (path: string) => Promise<TransportResponse>,
        member: CommunityMember,
        unreadUuids: ReadonlySet<string>,
        watch: WatchOptions,
        watchedChatRooms: Set<string>
    ): Promise<ActivityItem[]> {
        const spaces = await this.watchableSpaces(get)
        const items: ActivityItem[] = []

        // New posts and comments anywhere, by latest activity.
        const posts = parseFeedPosts(
            (
                await get(
                    `/internal_api/home_page_posts?sort=new_activity&page=1&per_page=${FEED_PAGE}`
                )
            ).json
        )
        if (posts.length > 0) {
            const ids = posts.map((post) => post.id).join(',')
            const details =
                (await this.optional(async () =>
                    parsePostDetails(
                        (
                            await get(
                                `/internal_api/post_details?post_ids=${encodeURIComponent(ids)}`
                            )
                        ).json
                    )
                )) ?? new Map()
            items.push(...feedItems(posts, details, member, watch))
        }

        // New messages in every chat space the member belongs to and did not
        // mute. Spaces they are not in would only be refused.
        const chatSpaces = spaces.filter(
            (space) => 'chat' === space.kind && space.isMember && !watch.mutedSpaceIds.has(space.id)
        )
        let lookups = 0
        for (const space of chatSpaces) {
            if (!this.spaceRooms.has(space.id) && lookups < ROOM_LOOKUPS_PER_CHECK) {
                lookups += 1
                const uuid = await this.optional(async () =>
                    parseSpaceChatRoomUuid((await get(`/internal_api/spaces/${space.id}`)).json)
                )
                this.spaceRooms.set(space.id, uuid)
            }
        }
        const rooms = chatSpaces
            .map((space) => ({ uuid: this.spaceRooms.get(space.id) ?? null, space }))
            .filter((room): room is { uuid: string; space: WatchableSpace } => null !== room.uuid)
        for (const room of rooms) {
            watchedChatRooms.add(room.uuid)
        }
        const { selected, nextCursor } = roomsToPoll(
            rooms,
            unreadUuids,
            this.roomCursor,
            ROOM_BATCH
        )
        this.roomCursor = nextCursor
        for (const room of selected) {
            const messages = await this.optional(async () =>
                parseChatMessages(
                    (
                        await get(
                            `/internal_api/chat_rooms/${encodeURIComponent(room.uuid)}/messages?previous_per_page=20&next_per_page=0`
                        )
                    ).json
                )
            )
            const recent = (messages ?? []).filter((message) => message.at > watch.since)
            if (0 === recent.length) {
                continue
            }
            const people = await this.roomParticipants(
                get,
                room.uuid,
                recent.map((m) => m.participantId)
            )
            items.push(
                ...messageItems(recent, room.space, people, member, {
                    since: watch.since,
                    roomUnread: unreadUuids.has(room.uuid)
                }).map((item) => ({ ...item, ref: { kind: 'room' as const, uuid: room.uuid } }))
            )
        }
        return items
    }

    private async watchableSpaces(
        get: (path: string) => Promise<TransportResponse>
    ): Promise<WatchableSpace[]> {
        if (this.spacesCache && Date.now() - this.spacesCache.at < SPACES_TTL_MS) {
            return this.spacesCache.spaces
        }
        const spaces = parseSpaces((await get('/internal_api/spaces?per_page=100')).json)
        this.spacesCache = { at: Date.now(), spaces }
        return spaces
    }

    /** Names of the given participants, looked up once per room. */
    private async roomParticipants(
        get: (path: string) => Promise<TransportResponse>,
        uuid: string,
        ids: readonly (number | null)[]
    ): Promise<Map<number, ChatParticipant>> {
        const known = this.participants.get(uuid) ?? new Map<number, ChatParticipant>()
        this.participants.set(uuid, known)
        const missing = [
            ...new Set(ids.filter((id): id is number => null !== id && !known.has(id)))
        ]
        if (missing.length > 0) {
            const query = missing.map((id) => `ids[]=${id}`).join('&')
            const found = await this.optional(async () =>
                parseParticipants(
                    (
                        await get(
                            `/internal_api/chat_rooms/${encodeURIComponent(uuid)}/participants?${query}&per_page=${missing.length}`
                        )
                    ).json
                )
            )
            for (const participant of found ?? []) {
                known.set(participant.id, participant)
            }
        }
        return known
    }

    private async isAdmin(
        get: (path: string) => Promise<TransportResponse>,
        memberId: number
    ): Promise<boolean> {
        const known = this.adminRoles.get(memberId)
        if (undefined !== known) {
            return known
        }
        const isAdmin = await this.optional(async () =>
            parseIsAdmin((await get('/internal_api/pundit_users')).json)
        )
        // A failed lookup is retried on the next check instead of being cached as "no".
        if (null !== isAdmin) {
            this.adminRoles.set(memberId, isAdmin)
        }
        return true === isAdmin
    }

    private async fetchWith(transport: CommunityTransport): Promise<ActivitySnapshot> {
        const get = (path: string): Promise<TransportResponse> => this.get(transport, path)

        const memberResponse = await get('/internal_api/current_contact')
        const signedIn = parseCurrentMember(memberResponse.json)
        if (!signedIn) {
            throw new SignedOutError()
        }
        const member = { ...signedIn, isAdmin: await this.isAdmin(get, signedIn.id) }

        const [
            countResponse,
            notificationsResponse,
            roomsResponse,
            unreadRoomsResponse,
            unreadThreadsResponse
        ] = await Promise.all([
            get('/internal_api/notifications/new_notifications_count'),
            get(`/internal_api/notifications?per_page=${NOTIFICATIONS_PAGE}`),
            get(`/internal_api/chat_rooms?per_page=${ROOMS_PAGE}`),
            get('/internal_api/chat_rooms/unread_chat_rooms'),
            get('/internal_api/chat_threads/unread_chat_threads')
        ])

        const notificationItems = parseNotifications(notificationsResponse.json)
        const listedRooms = parseChatRooms(roomsResponse.json)
        const unreadUuids = new Set(parseUnreadRoomUuids(unreadRoomsResponse.json))
        for (const room of listedRooms) {
            if (room.hasUnread) {
                unreadUuids.add(room.uuid)
            }
        }
        const unreadThreadIds = parseUnreadThreadIds(unreadThreadsResponse.json)

        const watch = this.host.watchOptions()
        const watchedChatRooms = new Set<string>()
        let watchItems: ActivityItem[] = []
        if (watch) {
            watchItems =
                (await this.optional(() =>
                    this.readCommunity(get, member, unreadUuids, watch, watchedChatRooms)
                )) ?? []
            watchItems = withoutDuplicates(
                watchItems,
                notificationItems.filter((item) => item.unread).map((item) => item.path)
            )
        }

        // Space chats read message by message make the room-level item redundant.
        const roomItems = (await this.roomItems(get, member, listedRooms, [...unreadUuids])).filter(
            (item) => !('room' === item.ref.kind && watchedChatRooms.has(item.ref.uuid))
        )
        const threadItems = await this.threadItems(get, unreadThreadIds)

        const notificationCount = parseNotificationCount(countResponse.json)
        return {
            member,
            counts: {
                notifications:
                    notificationCount ?? notificationItems.filter((item) => item.unread).length,
                messages: unreadUuids.size,
                threads: unreadThreadIds.length
            },
            items: sortItems([...roomItems, ...threadItems, ...notificationItems, ...watchItems]),
            fetchedAt: Date.now(),
            transport: transport.id,
            unreadRoomUuids: unreadUuids
        }
    }

    private async roomItems(
        get: (path: string) => Promise<TransportResponse>,
        member: CommunityMember,
        listed: readonly ChatRoom[],
        unreadUuids: readonly string[]
    ): Promise<ActivityItem[]> {
        const unread = new Set(unreadUuids)
        const items: ActivityItem[] = []
        // Recent conversations, read or not, as the room list gives them.
        for (const room of listed) {
            const spaceId = spaceIdOfRoom(room)
            const space = null === spaceId ? null : await this.space(get, spaceId)
            items.push(roomToItem(room, member, space, unread.has(room.uuid)))
        }
        // Unread conversations the list does not include (space chats, older rooms).
        const listedUuids = new Set(listed.map((room) => room.uuid))
        const missing = unreadUuids.filter((uuid) => !listedUuids.has(uuid))
        for (const uuid of missing.slice(0, MAX_ROOM_DETAILS)) {
            const room = await this.optional(async () =>
                parseChatRoom(
                    (await get(`/internal_api/chat_rooms/${encodeURIComponent(uuid)}`)).json
                )
            )
            if (!room) {
                continue
            }
            const spaceId = spaceIdOfRoom(room)
            const space = null === spaceId ? null : await this.space(get, spaceId)
            items.push(roomToItem(room, member, space, true))
        }
        return items
    }

    private async threadItems(
        get: (path: string) => Promise<TransportResponse>,
        ids: readonly number[]
    ): Promise<ActivityItem[]> {
        const items: ActivityItem[] = []
        for (const id of ids.slice(0, MAX_THREAD_DETAILS)) {
            const thread = await this.optional(async () =>
                parseChatThread((await get(`/internal_api/chat_threads/${id}`)).json)
            )
            if (!thread) {
                continue
            }
            const space = null === thread.spaceId ? null : await this.space(get, thread.spaceId)
            const item = threadToItem(thread, space)
            if (item) {
                items.push(item)
            }
        }
        return items
    }

    private async space(
        get: (path: string) => Promise<TransportResponse>,
        id: number
    ): Promise<Space | null> {
        if (this.spaces.has(id)) {
            return this.spaces.get(id) ?? null
        }
        const space = await this.optional(async () =>
            parseSpace((await get(`/internal_api/spaces/${id}`)).json)
        )
        // Only hits are cached: a failed lookup is retried on the next check.
        if (space) {
            this.spaces.set(id, space)
        }
        return space
    }

    /** A detail request that may fail without failing the whole check. */
    private async optional<T>(read: () => Promise<T | null>): Promise<T | null> {
        // The member was just confirmed signed in: a refusal here is about
        // this one room, thread or space (a private space, a deleted room).
        try {
            return await read()
        } catch {
            return null
        }
    }

    private async get(transport: CommunityTransport, path: string): Promise<TransportResponse> {
        const response = await transport.get(this.host.baseUrl(), path)
        if (response.setCookies.length > 0) {
            this.host.onSetCookies(response.setCookies)
        }
        if (401 === response.status || 204 === response.status) {
            throw new SignedOutError()
        }
        if (response.status >= 400) {
            throw new Error(`The community answered ${response.status} for ${path}`)
        }
        return response
    }
}
