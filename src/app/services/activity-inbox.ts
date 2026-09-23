import type { ActivityItem } from '../domain/community-activity'
import { rememberKeys, sortItems } from '../domain/community-activity'

/** Per-device storage (Obsidian's local storage in the plugin). */
export interface InboxStore {
    load(key: string): unknown
    save(key: string, value: unknown): void
}

const READ_KEY = 'knowii-community:read-items'
const ARCHIVED_KEY = 'knowii-community:archived-items'
const LOG_KEY = 'knowii-community:watch-log'

/** Keys remembered as read or archived; the oldest are forgotten first. */
export const STATE_LIMIT = 3000
/** Community-watch items kept between checks. */
export const LOG_LIMIT = 300
/** And for how long. */
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => 'string' === typeof entry)
        : []
}

function isLoggedItem(value: unknown): value is ActivityItem {
    if ('object' !== typeof value || null === value) {
        return false
    }
    const item = value as Partial<ActivityItem>
    return (
        'string' === typeof item.key &&
        'string' === typeof item.category &&
        'string' === typeof item.title &&
        'string' === typeof item.summary &&
        'string' === typeof item.path &&
        'number' === typeof item.occurredAt &&
        'boolean' === typeof item.unread &&
        'object' === typeof item.ref &&
        null !== item.ref
    )
}

/**
 * The member's inbox on this device, on top of what the community reports:
 *
 * - items marked as read here stay read (at once, before the next check
 *   confirms it, and for good for items the community has no read state for);
 * - archived items are hidden until something new happens on them (a new
 *   message or update gives an item a new key);
 * - items found by watching the whole community are kept in a rolling log,
 *   so they stay listed after the check that found them.
 */
export class ActivityInbox {
    private read: string[]
    private archived: string[]
    private log: ActivityItem[]

    constructor(private readonly store: InboxStore) {
        this.read = stringList(store.load(READ_KEY))
        this.archived = stringList(store.load(ARCHIVED_KEY))
        const log: unknown = store.load(LOG_KEY)
        this.log = Array.isArray(log) ? log.filter(isLoggedItem) : []
    }

    /**
     * What the member sees: the community's items plus the watch log,
     * archived ones out, read ones not bold, newest first.
     */
    merge(
        items: readonly ActivityItem[],
        unreadRoomUuids: ReadonlySet<string>,
        nowMs = Date.now()
    ): ActivityItem[] {
        const watched = items.filter((item) => 'local' === item.ref.kind || this.isWatchItem(item))
        this.remember(watched, nowMs)

        const byKey = new Map<string, ActivityItem>()
        for (const item of [...this.log, ...items]) {
            byKey.set(item.key, item)
        }
        const archived = new Set(this.archived)
        const read = new Set(this.read)
        return sortItems(
            [...byKey.values()]
                .filter((item) => !archived.has(item.key))
                .map((item) =>
                    item.unread && (read.has(item.key) || this.roomWasRead(item, unreadRoomUuids))
                        ? { ...item, unread: false }
                        : item
                )
        )
    }

    markRead(keys: readonly string[]): void {
        this.read = rememberKeys(this.read, keys, STATE_LIMIT)
        this.store.save(READ_KEY, this.read)
    }

    archive(keys: readonly string[]): void {
        this.markRead(keys)
        this.archived = rememberKeys(this.archived, keys, STATE_LIMIT)
        this.store.save(ARCHIVED_KEY, this.archived)
    }

    isArchived(key: string): boolean {
        return this.archived.includes(key)
    }

    /** A logged chat message whose room the community no longer reports unread. */
    private roomWasRead(item: ActivityItem, unreadRoomUuids: ReadonlySet<string>): boolean {
        return (
            this.isWatchItem(item) &&
            'room' === item.ref.kind &&
            !unreadRoomUuids.has(item.ref.uuid)
        )
    }

    /** Messages found in space chats carry the room's ref but belong in the log too. */
    private isWatchItem(item: ActivityItem): boolean {
        return item.key.startsWith('message:')
    }

    private remember(items: readonly ActivityItem[], nowMs: number): void {
        const byKey = new Map(this.log.map((item) => [item.key, item]))
        let changed = false
        for (const item of items) {
            const known = byKey.get(item.key)
            // A newer read state from the community wins over the logged one.
            if (!known || known.unread !== item.unread) {
                byKey.set(item.key, item)
                changed = true
            }
        }
        const fresh = [...byKey.values()]
            .filter((item) => nowMs - item.occurredAt <= LOG_MAX_AGE_MS)
            .sort((a, b) => b.occurredAt - a.occurredAt)
            .slice(0, LOG_LIMIT)
        if (changed || fresh.length !== this.log.length) {
            this.log = fresh
            this.store.save(LOG_KEY, this.log)
        }
    }
}
