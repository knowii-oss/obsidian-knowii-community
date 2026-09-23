import type { CommunityEvent } from '../domain/community-content'
import { reminderTime } from '../domain/community-content'

/** Reminders are only armed this far ahead; later ones wait for a later refresh. */
const HORIZON_MS = 24 * 60 * 60 * 1000
const REMINDED_KEY = 'knowii-community:reminded-events'

export interface EventRemindersHost {
    upcomingEvents(): Promise<{ event: CommunityEvent; path: string }[]>
    remind(event: CommunityEvent, path: string): void
    load(key: string): unknown
    save(key: string, value: unknown): void
}

/**
 * Reminds the member of the events they attend, 15 minutes before they
 * start. Refreshed periodically (events and RSVPs change); each event is
 * reminded once per device.
 */
export class EventReminders {
    private timers = new Map<string, number>()
    private cache: { event: CommunityEvent; path: string }[] = []

    constructor(private readonly host: EventRemindersHost) {}

    /** The events found on the last refresh. */
    get upcoming(): readonly { event: CommunityEvent; path: string }[] {
        return this.cache
    }

    async refresh(nowMs = Date.now()): Promise<void> {
        this.cache = await this.host.upcomingEvents()
        this.clearTimers()
        const reminded = this.reminded()
        for (const entry of this.cache) {
            const key = `${entry.event.id}:${entry.event.startsAt}`
            const at = reminderTime(entry.event, nowMs)
            if (null === at || at - nowMs > HORIZON_MS || reminded.includes(key)) {
                continue
            }
            this.timers.set(
                key,
                window.setTimeout(() => {
                    this.timers.delete(key)
                    this.markReminded(key)
                    this.host.remind(entry.event, entry.path)
                }, at - nowMs)
            )
        }
    }

    stop(): void {
        this.clearTimers()
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) {
            window.clearTimeout(timer)
        }
        this.timers.clear()
    }

    private reminded(): string[] {
        const value = this.host.load(REMINDED_KEY)
        return Array.isArray(value)
            ? value.filter((key): key is string => 'string' === typeof key)
            : []
    }

    private markReminded(key: string): void {
        this.host.save(REMINDED_KEY, [...this.reminded(), key].slice(-200))
    }
}
