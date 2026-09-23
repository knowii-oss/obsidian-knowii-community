/**
 * Watching the whole community, not only what the community notifies the
 * member about: new posts and comments anywhere, new messages in every chat
 * space. Pure parsers and item builders over the community's web endpoints.
 */
import type { ActivityItem, CommunityMember } from './community-activity'
import { excerptOf } from './community-activity'

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

function time(value: unknown): number {
    const text = str(value)
    if (!text) {
        return 0
    }
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : 0
}

function records(value: unknown): Json[] {
    const list = isObject(value) ? value['records'] : value
    return Array.isArray(list) ? list.filter(isObject) : []
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/** A space as the watcher needs it. */
export interface WatchableSpace {
    readonly id: number
    readonly name: string
    readonly slug: string
    /** `basic` (posts), `chat`, `event`, `course`, … */
    readonly kind: string
    readonly isMember: boolean
    /** The member may start posts here. */
    readonly canPost: boolean
}

/** `GET /internal_api/spaces?per_page=100`. */
export function parseSpaces(json: unknown): WatchableSpace[] {
    const spaces: WatchableSpace[] = []
    for (const record of records(json)) {
        const id = num(record['id'])
        const slug = str(record['slug'])
        if (null === id || !slug) {
            continue
        }
        spaces.push({
            id,
            name: str(record['name']) ?? slug,
            slug,
            kind: str(record['post_type']) ?? 'basic',
            isMember: true === record['is_space_member'],
            canPost: isObject(record['policies']) && true === record['policies']['can_create_post']
        })
    }
    return spaces
}

/** `GET /internal_api/spaces/:id`: the uuid of the space's chat room. */
export function parseSpaceChatRoomUuid(json: unknown): string | null {
    return isObject(json) ? str(json['chat_room_uuid']) : null
}

// ---------------------------------------------------------------------------
// Posts and comments
// ---------------------------------------------------------------------------

export interface FeedPost {
    readonly id: number
    readonly title: string
    readonly slug: string
    readonly spaceId: number | null
    readonly spaceSlug: string | null
    readonly spaceName: string | null
    readonly authorMemberId: number | null
    readonly authorName: string | null
    readonly createdAt: number
}

/** `GET /internal_api/home_page_posts?sort=new_activity`. */
export function parseFeedPosts(json: unknown): FeedPost[] {
    const posts: FeedPost[] = []
    for (const record of records(json)) {
        const id = num(record['id'])
        const slug = str(record['slug'])
        if (null === id || !slug) {
            continue
        }
        const author = isObject(record['community_member']) ? record['community_member'] : {}
        const first = str(author['first_name'])
        const last = str(author['last_name'])
        posts.push({
            id,
            title: str(record['display_title']) ?? str(record['name']) ?? 'A post',
            slug,
            spaceId: num(record['space_id']),
            spaceSlug: str(record['space_slug']),
            spaceName: str(record['space_name']),
            authorMemberId: num(author['id']),
            authorName: [first, last].filter(Boolean).join(' ') || str(author['name']),
            createdAt: time(record['published_at'] ?? record['created_at'])
        })
    }
    return posts
}

/** The latest reply on a post, from `GET /internal_api/post_details?post_ids=…`. */
export interface PostActivity {
    readonly postId: number
    readonly userName: string | null
    readonly at: number
    readonly replied: boolean
    readonly commentsCount: number
}

export function parsePostDetails(json: unknown): Map<number, PostActivity> {
    const details = new Map<number, PostActivity>()
    const list = Array.isArray(json) ? json.filter(isObject) : records(json)
    for (const record of list) {
        const postId = num(record['id'])
        if (null === postId) {
            continue
        }
        const last = isObject(record['last_replied_or_posted'])
            ? record['last_replied_or_posted']
            : {}
        details.set(postId, {
            postId,
            userName: str(last['user_name']),
            at: time(last['created_at']),
            replied: 'replied' === str(last['type']),
            commentsCount: num(record['comments_count']) ?? 0
        })
    }
    return details
}

export function postPath(post: FeedPost): string {
    return post.spaceSlug ? `/c/${post.spaceSlug}/${post.slug}` : '/feed'
}

/** Whether a first name is the member's own (comments only carry a first name). */
function isMyFirstName(name: string | null, member: CommunityMember): boolean {
    if (!name) {
        return false
    }
    const mine = member.name.trim().split(/\s+/)[0] ?? ''
    return '' !== mine && name.trim().toLowerCase() === mine.toLowerCase()
}

/**
 * New posts and new comments since `since`, skipping the member's own and
 * muted spaces. They start unread; the plugin keeps their read state.
 */
export function feedItems(
    posts: readonly FeedPost[],
    details: ReadonlyMap<number, PostActivity>,
    member: CommunityMember,
    options: { since: number; mutedSpaceIds: ReadonlySet<number> }
): ActivityItem[] {
    const items: ActivityItem[] = []
    for (const post of posts) {
        if (null !== post.spaceId && options.mutedSpaceIds.has(post.spaceId)) {
            continue
        }
        const path = postPath(post)
        const where = post.spaceName ? ` in ${post.spaceName}` : ''
        if (post.createdAt > options.since && post.authorMemberId !== member.id) {
            items.push({
                key: `post:${post.id}`,
                category: 'posts',
                title: post.authorName ?? 'A member',
                summary: `posted${where}`,
                excerpt: excerptOf(post.title),
                path,
                occurredAt: post.createdAt,
                unread: true,
                notify: true,
                ref: { kind: 'local' }
            })
        }
        const activity = details.get(post.id)
        if (
            activity?.replied &&
            activity.at > options.since &&
            !isMyFirstName(activity.userName, member)
        ) {
            items.push({
                key: `comment:${post.id}:${activity.at}`,
                category: 'comments',
                title: activity.userName ?? 'A member',
                summary: `commented${where}`,
                excerpt: excerptOf(post.title),
                path,
                occurredAt: activity.at,
                unread: true,
                notify: true,
                ref: { kind: 'local' }
            })
        }
    }
    return items
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

export interface ChatMessage {
    readonly id: number
    readonly participantId: number | null
    readonly body: string | null
    readonly at: number
    /** Set when the message is a reply inside a thread. */
    readonly parentId: number | null
}

/** `GET /internal_api/chat_rooms/:uuid/messages?previous_per_page=N&next_per_page=0`. */
export function parseChatMessages(json: unknown): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (const record of records(json)) {
        const id = num(record['id'])
        if (null === id || (null !== record['deleted_at'] && undefined !== record['deleted_at'])) {
            continue
        }
        messages.push({
            id,
            participantId: num(record['chat_room_participant_id']),
            body: str(record['body']),
            at: time(record['sent_at'] ?? record['created_at']),
            parentId: num(record['parent_message_id'])
        })
    }
    return messages
}

export interface ChatParticipant {
    readonly id: number
    readonly name: string
    readonly memberId: number | null
}

/** `GET /internal_api/chat_rooms/:uuid/participants?ids[]=…`. */
export function parseParticipants(json: unknown): ChatParticipant[] {
    const participants: ChatParticipant[] = []
    for (const record of records(json)) {
        const id = num(record['id'])
        if (null === id) {
            continue
        }
        participants.push({
            id,
            name: str(record['name']) ?? 'A member',
            memberId: num(record['community_member_id'])
        })
    }
    return participants
}

/** New messages in a space chat since `since`, the member's own left out. */
export function messageItems(
    messages: readonly ChatMessage[],
    space: Pick<WatchableSpace, 'name' | 'slug'>,
    participants: ReadonlyMap<number, ChatParticipant>,
    member: CommunityMember,
    options: { since: number; roomUnread: boolean }
): ActivityItem[] {
    const items: ActivityItem[] = []
    for (const message of messages) {
        if (message.at <= options.since) {
            continue
        }
        const participant =
            null === message.participantId ? undefined : participants.get(message.participantId)
        if (participant && participant.memberId === member.id) {
            continue
        }
        const focus =
            null === message.parentId ? `message_${message.id}` : `message_${message.parentId}`
        items.push({
            key: `message:${message.id}`,
            category: null === message.parentId ? 'groupMessages' : 'threadReplies',
            title: participant?.name ?? 'A member',
            summary:
                null === message.parentId
                    ? `in ${space.name}`
                    : `replied in a thread in ${space.name}`,
            excerpt: excerptOf(message.body),
            path: `/c/${space.slug}?message_id=${message.id}#${focus}`,
            occurredAt: message.at,
            unread: options.roomUnread,
            notify: true,
            ref: { kind: 'local' }
        })
    }
    return items
}

/**
 * Rooms to read this check: every unread one, then a rotating batch of the
 * others so each room is looked at every few checks whatever its unread state.
 */
export function roomsToPoll<T extends { uuid: string }>(
    rooms: readonly T[],
    unread: ReadonlySet<string>,
    cursor: number,
    batch: number
): { selected: T[]; nextCursor: number } {
    const urgent = rooms.filter((room) => unread.has(room.uuid))
    const others = rooms.filter((room) => !unread.has(room.uuid))
    if (0 === others.length) {
        return { selected: urgent, nextCursor: 0 }
    }
    const start = cursor % others.length
    const rotated = [...others.slice(start), ...others.slice(0, start)].slice(0, batch)
    return {
        selected: [...urgent, ...rotated],
        nextCursor: (start + rotated.length) % others.length
    }
}

/**
 * Drops watch items that repeat an unread notification about the same post
 * (the community already notified the member about it).
 */
export function withoutDuplicates(
    watchItems: readonly ActivityItem[],
    notificationPaths: readonly string[]
): ActivityItem[] {
    return watchItems.filter(
        (item) =>
            !notificationPaths.some(
                (path) =>
                    path === item.path ||
                    path.startsWith(`${item.path}#`) ||
                    path.startsWith(`${item.path}?`)
            )
    )
}
