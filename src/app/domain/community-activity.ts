/**
 * What is new in the community for the signed-in member: unread
 * notifications, direct messages, chat rooms and threads.
 *
 * Pure functions only. Everything the community returns is `unknown` until a
 * parser here has checked it, so a change on the community side degrades to
 * "nothing to show" instead of a crash.
 */

/** A kind of activity the member can be told about, and can mute. */
export type ActivityCategory =
    | 'directMessages'
    | 'groupMessages'
    | 'threadReplies'
    | 'mentions'
    | 'comments'
    | 'posts'
    | 'reactions'
    | 'events'
    | 'newMembers'
    | 'other'

export interface ActivityCategoryInfo {
    readonly id: ActivityCategory
    /** Setting label, and the category name shown in the list. */
    readonly label: string
    /** Setting description. */
    readonly description: string
    /** Lucide icon. */
    readonly icon: string
}

/** Display order everywhere: conversations first, then the notification feed. */
export const ACTIVITY_CATEGORIES: readonly ActivityCategoryInfo[] = [
    {
        id: 'directMessages',
        label: 'Direct messages',
        description: 'A member sends you a direct message.',
        icon: 'message-circle'
    },
    {
        id: 'groupMessages',
        label: 'Chat messages',
        description: 'New messages in a space chat or a group conversation you are part of.',
        icon: 'messages-square'
    },
    {
        id: 'threadReplies',
        label: 'Thread replies',
        description: 'New replies in a chat thread you follow.',
        icon: 'message-square-reply'
    },
    {
        id: 'mentions',
        label: 'Mentions',
        description: 'Someone mentions you in a post, a comment or a message.',
        icon: 'at-sign'
    },
    {
        id: 'comments',
        label: 'Comments and replies',
        description: 'Comments on your posts and replies in discussions you follow.',
        icon: 'message-square-text'
    },
    {
        id: 'posts',
        label: 'New posts',
        description:
            'New posts in the spaces you follow. Which spaces notify you is set in your Knowii notification preferences.',
        icon: 'newspaper'
    },
    {
        id: 'reactions',
        label: 'Likes and reactions',
        description: 'Someone likes or reacts to your post or comment.',
        icon: 'heart'
    },
    {
        id: 'events',
        label: 'Events',
        description: 'Event invitations, reminders and updates.',
        icon: 'calendar'
    },
    {
        id: 'newMembers',
        label: 'New members',
        description: 'Someone joins the community (hosts and moderators).',
        icon: 'user-plus'
    },
    {
        id: 'other',
        label: 'Everything else',
        description: 'Any other community notification.',
        icon: 'bell'
    }
]

export function categoryInfo(category: ActivityCategory): ActivityCategoryInfo {
    return (
        ACTIVITY_CATEGORIES.find((info) => info.id === category) ??
        (ACTIVITY_CATEGORIES[ACTIVITY_CATEGORIES.length - 1] as ActivityCategoryInfo)
    )
}

/**
 * Where an item comes from, which decides how it is marked as read or
 * archived: on the community itself, or only in the plugin (`local`).
 */
export type ActivityRef =
    | { readonly kind: 'notification'; readonly id: number }
    | { readonly kind: 'room'; readonly uuid: string }
    | { readonly kind: 'thread'; readonly id: number }
    | { readonly kind: 'local' }

/** One thing that happened in the community, ready to show. */
export interface ActivityItem {
    /**
     * Identity of this item *in this state*. A conversation that receives a
     * newer message gets a new key, so the member hears about it again.
     */
    readonly key: string
    readonly category: ActivityCategory
    /** Who or where: a member name, a space name. */
    readonly title: string
    /** What happened. */
    readonly summary: string
    /** A short quote of the content, when there is one. */
    readonly excerpt: string | null
    /** Community-relative path the item opens (`/messages/…`, `/c/…`). */
    readonly path: string
    /** Epoch milliseconds; 0 when unknown. */
    readonly occurredAt: number
    /** Not read yet: bold in the list, listed in the ribbon menu. */
    readonly unread: boolean
    /** Announce it (once) when it first shows up. */
    readonly notify: boolean
    readonly ref: ActivityRef
}

/** Unread totals, as the community's own badges count them. */
export interface ActivityCounts {
    readonly notifications: number
    readonly messages: number
    readonly threads: number
}

export const EMPTY_COUNTS: ActivityCounts = { notifications: 0, messages: 0, threads: 0 }

export function totalUnread(counts: ActivityCounts): number {
    return counts.notifications + counts.messages + counts.threads
}

/** The signed-in member. */
export interface CommunityMember {
    readonly id: number
    readonly name: string
    /** Community admin (hosts get the admin menu). */
    readonly isAdmin: boolean
}

// ---------------------------------------------------------------------------
// Small readers over unknown JSON
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
    return 'object' === typeof value && null !== value && !Array.isArray(value)
}

function str(value: unknown): string | null {
    return 'string' === typeof value && '' !== value.trim() ? value : null
}

function num(value: unknown): number | null {
    if ('number' === typeof value && Number.isFinite(value)) {
        return value
    }
    if ('string' === typeof value && /^\d+$/.test(value)) {
        return Number(value)
    }
    return null
}

function records(value: unknown): unknown[] {
    return isObject(value) && Array.isArray(value['records']) ? value['records'] : []
}

function time(value: unknown): number {
    const text = str(value)
    if (!text) {
        return 0
    }
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : 0
}

const EXCERPT_LENGTH = 140

/** Collapses whitespace and trims a body to a one-line quote. */
export function excerptOf(value: unknown): string | null {
    const text = str(value)
    if (!text) {
        return null
    }
    const flat = text.replace(/\s+/g, ' ').trim()
    if ('' === flat) {
        return null
    }
    return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat
}

/** Keeps only same-site paths; a full URL on the community host is reduced to its path. */
export function toCommunityPath(value: unknown, fallback: string): string {
    const text = str(value)
    if (!text) {
        return fallback
    }
    if (text.startsWith('/') && !text.startsWith('//')) {
        return text
    }
    try {
        const url = new URL(text)
        if ('https:' === url.protocol || 'http:' === url.protocol) {
            return `${url.pathname}${url.search}${url.hash}`
        }
    } catch {
        // not a URL
    }
    return fallback
}

// ---------------------------------------------------------------------------
// Parsers, one per community endpoint
// ---------------------------------------------------------------------------

/** `GET /internal_api/current_contact`. Null when nobody is signed in. */
export function parseCurrentMember(json: unknown): CommunityMember | null {
    if (!isObject(json)) {
        return null
    }
    const id = num(json['id'])
    if (null === id) {
        return null
    }
    return { id, name: str(json['name']) ?? 'Member', isAdmin: false }
}

/**
 * `GET /internal_api/pundit_users`: whether the signed-in member is a
 * community admin. Anything unexpected reads as "not an admin".
 */
export function parseIsAdmin(json: unknown): boolean {
    if (!isObject(json) || !isObject(json['current_community_member'])) {
        return false
    }
    const member = json['current_community_member']
    const roles = isObject(member['roles']) ? member['roles'] : {}
    return true === member['is_admin'] || true === roles['admin']
}

/**
 * `GET /internal_api/notifications/new_notifications_count`. Signed-out
 * visitors get a different object, with none of these numbers: null then.
 */
export function parseNotificationCount(json: unknown): number | null {
    if (!isObject(json) || null === num(json['new_notifications_count'])) {
        return null
    }
    const groups = [
        'new_inbox_count',
        'new_mentions_count',
        'new_content_count',
        'new_moderation_count'
    ]
    return groups.reduce((sum, key) => sum + (num(json[key]) ?? 0), 0)
}

/** `GET /internal_api/chat_rooms/unread_chat_rooms`. */
export function parseUnreadRoomUuids(json: unknown): string[] {
    if (!isObject(json) || !Array.isArray(json['chat_room_uuids'])) {
        return []
    }
    return json['chat_room_uuids'].filter((uuid): uuid is string => null !== str(uuid))
}

/** `GET /internal_api/chat_threads/unread_chat_threads`. */
export function parseUnreadThreadIds(json: unknown): number[] {
    if (!isObject(json) || !Array.isArray(json['chat_thread_ids'])) {
        return []
    }
    return json['chat_thread_ids'].map(num).filter((id): id is number => null !== id)
}

/** Which bucket a community notification belongs to. */
export function categorizeNotification(record: {
    action: string
    notifiableType: string
    group: string
}): ActivityCategory {
    const action = record.action.toLowerCase()
    const type = record.notifiableType.toLowerCase()
    const group = record.group.toLowerCase()
    if ('mention' === action || action.includes('mention') || 'mentions' === group) {
        return 'mentions'
    }
    if (action.includes('like') || action.includes('reaction') || action.includes('react')) {
        return 'reactions'
    }
    if (type.includes('event') || action.includes('event') || action.includes('rsvp')) {
        return 'events'
    }
    if ('comment' === type || action.includes('comment') || action.includes('reply')) {
        return 'comments'
    }
    if ('post' === type || 'following' === group) {
        return 'posts'
    }
    if ('contact' === type || 'communitymember' === type || action.includes('profile_confirmed')) {
        return 'newMembers'
    }
    return 'other'
}

/** `GET /internal_api/notifications`: read and unread, as items. */
export function parseNotifications(json: unknown): ActivityItem[] {
    const items: ActivityItem[] = []
    for (const record of records(json)) {
        if (!isObject(record)) {
            continue
        }
        const id = num(record['id'])
        if (null === id) {
            continue
        }
        const unread = null === record['read_at'] || undefined === record['read_at']
        const updatedAt = str(record['updated_at']) ?? str(record['created_at']) ?? ''
        const actor = str(record['actor_name'])
        const second = str(record['second_actor_name'])
        const action = str(record['display_action']) ?? 'has new activity'
        const target = str(record['notifiable_title']) ?? str(record['space_title'])
        items.push({
            key: `notification:${id}:${updatedAt}`,
            category: categorizeNotification({
                action: str(record['action']) ?? '',
                notifiableType: str(record['notifiable_type']) ?? '',
                group: str(record['notification_group']) ?? ''
            }),
            title: actor ? (second ? `${actor} and ${second}` : actor) : 'Knowii',
            summary: target
                ? `${action.replace(/:\s*$/, '')} ${target}`
                : action.replace(/:\s*$/, ''),
            excerpt: null,
            path: toCommunityPath(
                record['action_web_path'] ?? record['action_web_url'],
                '/notifications'
            ),
            occurredAt: time(updatedAt),
            unread,
            notify: unread,
            ref: { kind: 'notification', id }
        })
    }
    return items
}

/** The latest message of a conversation, as the room list reports it. */
export interface RoomMessage {
    readonly id: number
    readonly body: string | null
    readonly senderName: string | null
    readonly senderMemberId: number | null
    readonly sentAt: number
}

/** A conversation from `GET /internal_api/chat_rooms` or `/chat_rooms/:uuid`. */
export interface ChatRoom {
    readonly uuid: string
    readonly kind: string
    readonly name: string | null
    readonly identifier: string | null
    readonly embedded: boolean
    readonly hasUnread: boolean
    readonly firstUnreadMessageId: number | null
    readonly lastMessage: RoomMessage | null
    readonly otherParticipants: readonly string[]
}

function parseRoomMessage(value: unknown): RoomMessage | null {
    if (!isObject(value)) {
        return null
    }
    const id = num(value['id'])
    if (null === id) {
        return null
    }
    const sender = isObject(value['sender']) ? value['sender'] : {}
    return {
        id,
        body: str(value['body']),
        senderName: str(sender['name']),
        senderMemberId: num(sender['community_member_id']),
        sentAt: time(value['sent_at'] ?? value['created_at'])
    }
}

export function parseChatRoom(value: unknown): ChatRoom | null {
    const room = isObject(value) && isObject(value['chat_room']) ? value['chat_room'] : value
    if (!isObject(room)) {
        return null
    }
    const uuid = str(room['uuid'])
    if (!uuid) {
        return null
    }
    const others = Array.isArray(room['other_participants_preview'])
        ? room['other_participants_preview']
              .map((participant) => (isObject(participant) ? str(participant['name']) : null))
              .filter((name): name is string => null !== name)
        : []
    return {
        uuid,
        kind: str(room['chat_room_kind']) ?? 'unknown',
        name: str(room['chat_room_name']),
        identifier: str(room['identifier']),
        embedded: true === room['is_embedded'],
        hasUnread: true === room['has_unread_messages'],
        firstUnreadMessageId: num(room['first_unread_message_id']),
        lastMessage: parseRoomMessage(room['last_message']),
        otherParticipants: others
    }
}

export function parseChatRooms(json: unknown): ChatRoom[] {
    return records(json)
        .map(parseChatRoom)
        .filter((room): room is ChatRoom => null !== room)
}

/** Space chats are identified as `space-group-chat-<space id>`. */
export function spaceIdOfRoom(room: Pick<ChatRoom, 'identifier'>): number | null {
    const match = /^space-group-chat-(\d+)$/.exec(room.identifier ?? '')
    return match ? Number(match[1]) : null
}

/** A space, as far as links and labels need it. */
export interface Space {
    readonly id: number
    readonly name: string
    readonly slug: string
}

/** `GET /internal_api/spaces/:id`. */
export function parseSpace(json: unknown): Space | null {
    if (!isObject(json)) {
        return null
    }
    const id = num(json['id'])
    const slug = str(json['slug'])
    if (null === id || !slug) {
        return null
    }
    return { id, name: str(json['name']) ?? slug, slug }
}

/** A chat thread from `GET /internal_api/chat_threads/:id`. */
export interface ChatThread {
    readonly id: number
    readonly parentMessageId: number | null
    readonly parentBody: string | null
    readonly roomUuid: string | null
    readonly spaceId: number | null
    readonly lastReplyId: number | null
    readonly lastReplyBody: string | null
    readonly lastReplyAt: number
    /** True when the latest reply is the member's own. */
    readonly lastReplyIsMine: boolean
}

export function parseChatThread(json: unknown): ChatThread | null {
    if (!isObject(json)) {
        return null
    }
    const id = num(json['id'])
    if (null === id) {
        return null
    }
    const parent = isObject(json['parent_message']) ? json['parent_message'] : {}
    const replies = Array.isArray(json['replies']) ? json['replies'].filter(isObject) : []
    const last = replies[replies.length - 1] ?? null
    const me = isObject(json['current_participant']) ? num(json['current_participant']['id']) : null
    const room = isObject(json['chat_room']) ? json['chat_room'] : {}
    return {
        id,
        parentMessageId: num(parent['id']),
        parentBody: str(parent['body']),
        roomUuid: str(parent['chat_room_uuid']),
        spaceId: num(room['embedded_space_id']),
        lastReplyId: last ? num(last['id']) : null,
        lastReplyBody: last ? str(last['body']) : null,
        lastReplyAt: last
            ? time(last['sent_at'] ?? last['created_at'])
            : time(parent['last_reply_at']),
        lastReplyIsMine:
            null !== me && null !== last && num(last['chat_room_participant_id']) === me
    }
}

// ---------------------------------------------------------------------------
// Items from conversations
// ---------------------------------------------------------------------------

/**
 * A conversation as an item. It is unread when the community says so and
 * its latest message is not the member's own.
 */
export function roomToItem(
    room: ChatRoom,
    member: CommunityMember,
    space: Space | null,
    communityUnread: boolean
): ActivityItem {
    const last = room.lastMessage
    const mine = null !== (last?.senderMemberId ?? null) && last?.senderMemberId === member.id
    const unread = communityUnread && !mine
    const marker = last?.id ?? room.firstUnreadMessageId ?? 'unread'
    const key = `room:${room.uuid}:${marker}`
    const occurredAt = last?.sentAt ?? 0
    const excerpt = excerptOf(last?.body)

    if ('direct' === room.kind) {
        const sender = last?.senderName ?? room.otherParticipants[0] ?? room.name ?? 'A member'
        return {
            key,
            category: 'directMessages',
            title: mine ? (room.otherParticipants[0] ?? room.name ?? 'A member') : sender,
            summary: mine ? 'you replied' : 'sent you a message',
            excerpt,
            path: `/messages/${room.uuid}`,
            occurredAt,
            unread,
            notify: unread,
            ref: { kind: 'room', uuid: room.uuid }
        }
    }
    if (space) {
        return {
            key,
            category: 'groupMessages',
            title: space.name,
            summary: last?.senderName
                ? `${last.senderName} posted in the chat`
                : 'New messages in the chat',
            excerpt,
            path: `/c/${space.slug}`,
            occurredAt,
            unread,
            notify: unread,
            ref: { kind: 'room', uuid: room.uuid }
        }
    }
    const name =
        room.name ??
        (room.otherParticipants.length > 0 ? room.otherParticipants.join(', ') : 'Group chat')
    return {
        key,
        category: 'groupMessages',
        title: name,
        summary: last?.senderName ? `${last.senderName} sent a message` : 'New messages',
        excerpt,
        path: `/messages/${room.uuid}`,
        occurredAt,
        unread,
        notify: unread,
        ref: { kind: 'room', uuid: room.uuid }
    }
}

/** An unread thread as an item; null when the latest reply is the member's own. */
export function threadToItem(thread: ChatThread, space: Space | null): ActivityItem | null {
    if (thread.lastReplyIsMine) {
        return null
    }
    const where = space ? ` in ${space.name}` : ''
    let path = thread.roomUuid ? `/messages/${thread.roomUuid}` : '/messages'
    if (space) {
        const focus = thread.lastReplyId ?? thread.parentMessageId
        path =
            null !== focus && null !== thread.parentMessageId
                ? `/c/${space.slug}?message_id=${focus}#message_${thread.parentMessageId}`
                : `/c/${space.slug}`
    }
    return {
        key: `thread:${thread.id}:${thread.lastReplyId ?? 'unread'}`,
        category: 'threadReplies',
        title: excerptOf(thread.parentBody) ?? 'A thread you follow',
        summary: `New replies${where}`,
        excerpt: excerptOf(thread.lastReplyBody),
        path,
        occurredAt: thread.lastReplyAt,
        unread: true,
        notify: true,
        ref: { kind: 'thread', id: thread.id }
    }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
export function formatAge(atMs: number, nowMs: number): string {
    const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000))
    if (seconds < 60) {
        return 'just now'
    }
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
        return `${minutes} min ago`
    }
    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
        return `${hours} h ago`
    }
    const days = Math.floor(hours / 24)
    if (days < 7) {
        return `${days} d ago`
    }
    return new Date(atMs).toLocaleDateString()
}

/** Newest first; conversations before notifications when times tie. */
export function sortItems(items: readonly ActivityItem[]): ActivityItem[] {
    const order = new Map(ACTIVITY_CATEGORIES.map((info, index) => [info.id, index]))
    return [...items].sort(
        (a, b) =>
            b.occurredAt - a.occurredAt ||
            (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99)
    )
}

// ---------------------------------------------------------------------------
// What has the member already been told about?
// ---------------------------------------------------------------------------

/** Keys kept in memory of "already announced"; oldest are forgotten first. */
export const SEEN_LIMIT = 2000

/** Items the member has not been told about yet. */
export function unseenItems(
    items: readonly ActivityItem[],
    seen: ReadonlySet<string>
): ActivityItem[] {
    return items.filter((item) => !seen.has(item.key))
}

/** Adds keys at the end and forgets the oldest past the limit. */
export function rememberKeys(
    seen: readonly string[],
    keys: readonly string[],
    limit = SEEN_LIMIT
): string[] {
    const known = new Set(seen)
    const next = [...seen]
    for (const key of keys) {
        if (!known.has(key)) {
            known.add(key)
            next.push(key)
        }
    }
    return next.length > limit ? next.slice(next.length - limit) : next
}
