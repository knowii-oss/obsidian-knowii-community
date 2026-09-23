/**
 * Community content the plugin brings into the vault or acts on: full posts
 * with their comments, chat messages with their thread, upcoming events.
 * Pure parsers and renderers.
 */
import { tiptapToMarkdown } from './rich-text'

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
    const parsed = text ? Date.parse(text) : NaN
    return Number.isFinite(parsed) ? parsed : 0
}

function records(value: unknown): Json[] {
    const list = isObject(value) ? value['records'] : value
    return Array.isArray(list) ? list.filter(isObject) : []
}

function memberName(value: unknown): string {
    if (!isObject(value)) {
        return 'A member'
    }
    const full = [str(value['first_name']), str(value['last_name'])].filter(Boolean).join(' ')
    return str(value['name']) ?? (full || 'A member')
}

// ---------------------------------------------------------------------------
// Where a community path points
// ---------------------------------------------------------------------------

export type CommunityTarget =
    | { readonly kind: 'post'; readonly spaceSlug: string; readonly postSlug: string }
    | { readonly kind: 'message'; readonly spaceSlug: string; readonly messageId: number }
    | { readonly kind: 'other' }

/**
 * What a community path (or full URL) points at: a post
 * (`/c/<space>/<post>`), a chat message (`/c/<space>?message_id=<id>`), or
 * something the plugin cannot save.
 */
export function parseCommunityTarget(pathOrUrl: string): CommunityTarget {
    let url: URL
    try {
        url = new URL(pathOrUrl, 'https://community.invalid')
    } catch {
        return { kind: 'other' }
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if ('c' !== parts[0] || !parts[1]) {
        return { kind: 'other' }
    }
    const spaceSlug = decodeURIComponent(parts[1])
    const messageId = num(url.searchParams.get('message_id'))
    if (null !== messageId) {
        return { kind: 'message', spaceSlug, messageId }
    }
    if (parts[2] && !['members', 'about', 'events', 'new'].includes(parts[2])) {
        return { kind: 'post', spaceSlug, postSlug: decodeURIComponent(parts[2]) }
    }
    return { kind: 'other' }
}

// ---------------------------------------------------------------------------
// Posts and comments
// ---------------------------------------------------------------------------

export interface CommunityComment {
    readonly author: string
    readonly at: number
    readonly markdown: string
    readonly url: string | null
}

export interface FullPost {
    readonly id: number
    readonly title: string
    readonly slug: string
    readonly spaceName: string | null
    readonly spaceSlug: string | null
    readonly author: string
    readonly publishedAt: number
    readonly markdown: string
    readonly comments: readonly CommunityComment[]
}

/** `GET /internal_api/spaces/:id/posts/:slug`. */
export function parseFullPost(json: unknown): Omit<FullPost, 'comments'> | null {
    const post = isObject(json) && isObject(json['post']) ? json['post'] : json
    if (!isObject(post)) {
        return null
    }
    const id = num(post['id'])
    const slug = str(post['slug'])
    if (null === id || !slug) {
        return null
    }
    return {
        id,
        title: str(post['display_title']) ?? str(post['name']) ?? slug,
        slug,
        spaceName: str(post['space_name']),
        spaceSlug: str(post['space_slug']),
        author: memberName(post['community_member']),
        publishedAt: time(post['published_at'] ?? post['created_at']),
        markdown:
            tiptapToMarkdown(post['tiptap_body']) ||
            (str(post['body_plain_text']) ?? str(post['truncated_content']) ?? '')
    }
}

/** `GET /internal_api/posts/:id/comments`. */
export function parseComments(json: unknown): CommunityComment[] {
    return records(json).map((record) => ({
        author: memberName(record['community_member']),
        at: time(record['created_at']),
        markdown: tiptapToMarkdown(record['tiptap_body']) || (str(record['body']) ?? ''),
        url: str(record['show_url'])
    }))
}

// ---------------------------------------------------------------------------
// Chat messages and threads
// ---------------------------------------------------------------------------

export interface SavedMessage {
    readonly id: number
    readonly author: string
    readonly at: number
    readonly markdown: string
}

export interface FullThread {
    readonly spaceName: string
    readonly spaceSlug: string
    readonly root: SavedMessage
    readonly replies: readonly SavedMessage[]
}

/** A chat message record; `names` maps participant ids to names. */
export function parseSavedMessage(
    record: unknown,
    names: ReadonlyMap<number, string>
): SavedMessage | null {
    const message =
        isObject(record) && isObject(record['chat_room_message'])
            ? record['chat_room_message']
            : record
    if (!isObject(message)) {
        return null
    }
    const id = num(message['id'])
    if (null === id) {
        return null
    }
    const sender = isObject(message['sender']) ? message['sender'] : null
    const participant = num(message['chat_room_participant_id'])
    return {
        id,
        author: sender
            ? memberName(sender)
            : ((null === participant ? null : names.get(participant)) ?? 'A member'),
        at: time(message['sent_at'] ?? message['created_at']),
        markdown: tiptapToMarkdown(message['rich_text_body']) || (str(message['body']) ?? '')
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CommunityEvent {
    readonly id: number
    readonly name: string
    readonly slug: string
    readonly spaceId: number | null
    readonly startsAt: number
    readonly endsAt: number
    readonly timeZone: string | null
    /** The member said they will attend. */
    readonly attending: boolean
    readonly location: string | null
}

/** `GET /internal_api/events/community_events`. */
export function parseEvents(json: unknown): CommunityEvent[] {
    const events: CommunityEvent[] = []
    for (const record of records(json)) {
        const id = num(record['id'])
        const slug = str(record['slug'])
        const settings = isObject(record['event_setting_attributes'])
            ? record['event_setting_attributes']
            : {}
        const startsAt = time(settings['starts_at'] ?? record['starts_at'])
        if (null === id || !slug || 0 === startsAt || 'draft' === record['status']) {
            continue
        }
        events.push({
            id,
            name: str(record['name']) ?? slug,
            slug,
            spaceId: num(record['space_id']),
            startsAt,
            endsAt: time(settings['ends_at'] ?? record['ends_at']) || startsAt,
            timeZone: str(settings['time_zone']),
            attending: 'yes' === record['rsvp_status'],
            location: str(settings['location_type'])
        })
    }
    return events.sort((a, b) => a.startsAt - b.startsAt)
}

/** Upcoming (not yet ended) events, soonest first. */
export function upcomingEvents(events: readonly CommunityEvent[], nowMs: number): CommunityEvent[] {
    return events.filter((event) => event.endsAt > nowMs).sort((a, b) => a.startsAt - b.startsAt)
}

/** Minutes before an event starts when the member is reminded. */
export const EVENT_REMINDER_MINUTES = 15

/**
 * When to remind the member about an event they attend: 15 minutes before
 * it starts. Null for events they do not attend, or already past that point.
 */
export function reminderTime(event: CommunityEvent, nowMs: number): number | null {
    if (!event.attending) {
        return null
    }
    const at = event.startsAt - EVENT_REMINDER_MINUTES * 60 * 1000
    return at > nowMs ? at : null
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** A file name safe on Windows, macOS, Linux, and in Obsidian links. */
export function safeFileName(title: string): string {
    const cleaned = title
        .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
    return (cleaned || 'Knowii').slice(0, 120).trim()
}

function isoDate(ms: number): string {
    return ms > 0 ? new Date(ms).toISOString() : ''
}

function quoteYaml(value: string): string {
    return JSON.stringify(value)
}

/** A saved post as a Markdown note: frontmatter, the post, then its comments. */
export function renderPostNote(post: FullPost, url: string, savedAt: number): string {
    const lines = [
        '---',
        `source: ${quoteYaml(url)}`,
        `author: ${quoteYaml(post.author)}`,
        ...(post.spaceName ? [`space: ${quoteYaml(post.spaceName)}`] : []),
        `published: ${isoDate(post.publishedAt)}`,
        `saved: ${isoDate(savedAt)}`,
        'tags:',
        '  - knowii',
        '---',
        '',
        `# ${post.title}`,
        '',
        `By ${post.author}${post.spaceName ? ` in ${post.spaceName}` : ''}, [on Knowii](${url})`,
        '',
        post.markdown,
        ''
    ]
    if (post.comments.length > 0) {
        lines.push('## Comments', '')
        for (const comment of post.comments) {
            lines.push(
                `### ${comment.author}${comment.at > 0 ? `, ${new Date(comment.at).toLocaleString()}` : ''}`,
                '',
                comment.markdown,
                ''
            )
        }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** A saved chat message (and its thread) as a Markdown note. */
export function renderThreadNote(thread: FullThread, url: string, savedAt: number): string {
    const lines = [
        '---',
        `source: ${quoteYaml(url)}`,
        `author: ${quoteYaml(thread.root.author)}`,
        `space: ${quoteYaml(thread.spaceName)}`,
        `published: ${isoDate(thread.root.at)}`,
        `saved: ${isoDate(savedAt)}`,
        'tags:',
        '  - knowii',
        '---',
        '',
        `# ${threadTitle(thread)}`,
        '',
        `${thread.root.author} in ${thread.spaceName}, [on Knowii](${url})`,
        '',
        thread.root.markdown,
        ''
    ]
    if (thread.replies.length > 0) {
        lines.push('## Replies', '')
        for (const reply of thread.replies) {
            lines.push(
                `### ${reply.author}${reply.at > 0 ? `, ${new Date(reply.at).toLocaleString()}` : ''}`,
                '',
                reply.markdown,
                ''
            )
        }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** A title for a saved chat message: its first words. */
export function threadTitle(thread: FullThread): string {
    const words = thread.root.markdown
        .replace(/[#*`>[\]()!_~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    const short = words.length > 60 ? `${words.slice(0, 57).trimEnd()}…` : words
    return short
        ? `${thread.root.author} in ${thread.spaceName}: ${short}`
        : `${thread.root.author} in ${thread.spaceName}`
}
