import type { ActivityItem } from '../domain/community-activity'
import { EMPTY_COUNTS, rememberKeys, unseenItems } from '../domain/community-activity'
import type { ActivityCounts, CommunityMember } from '../domain/community-activity'
import type { ActivityResult, ActivitySnapshot, CommunityClient } from './community-client'
import type { TransportId } from './community-transport'

export type WatchStatus =
    /** Nothing checked yet. */
    | 'starting'
    | 'signed-in'
    | 'signed-out'
    /** The last check failed (network, community down); retrying with backoff. */
    | 'error'

export interface WatchState {
    readonly status: WatchStatus
    readonly member: CommunityMember | null
    readonly counts: ActivityCounts
    readonly items: readonly ActivityItem[]
    /** Epoch ms of the last completed check (success or signed-out). */
    readonly checkedAt: number | null
    readonly error: string | null
    readonly transport: TransportId | null
}

export const INITIAL_WATCH_STATE: WatchState = {
    status: 'starting',
    member: null,
    counts: EMPTY_COUNTS,
    items: [],
    checkedAt: null,
    error: null,
    transport: null
}

/** Longest wait between retries after failures. */
export const MAX_BACKOFF_MS = 15 * 60 * 1000
/** Delay before the first check, so the plugin never slows Obsidian's startup. */
const STARTUP_DELAY_MS = 3_000
/** Coalesces bursts of "check soon" requests (focus, pane navigation). */
const SOON_DELAY_MS = 2_000

/** Wait before the next check: the interval, doubled per consecutive failure. */
export function nextDelayMs(intervalMs: number, failures: number): number {
    if (failures <= 0) {
        return intervalMs
    }
    return Math.min(intervalMs * 2 ** Math.min(failures, 10), MAX_BACKOFF_MS)
}

export interface ActivityWatcherHost {
    intervalMs(): number
    loadSeen(): { keys: string[]; initialized: boolean }
    saveSeen(keys: readonly string[]): void
    /** Every state change (badges, open lists). */
    onState(state: WatchState): void
    /**
     * Items the member has not been told about. `initial` is the very first
     * signed-in check on this device: everything unread counts as backlog.
     */
    onNewItems(items: readonly ActivityItem[], initial: boolean): void
    /** Signed in before, signed out now. */
    onSignedOut(): void
    /** Called after each check with the raw result (session upkeep). */
    afterCheck(result: ActivityResult): Promise<void>
    /** The member's view of a snapshot: local read and archived state applied. */
    decorate(snapshot: ActivitySnapshot): ActivityItem[]
}

/**
 * Keeps checking the community in the background. One check at a time,
 * re-armed after each one, backing off on failures and catching up right
 * away when the window regains focus or the network comes back.
 */
export class ActivityWatcher {
    private state: WatchState = INITIAL_WATCH_STATE
    private timer: number | null = null
    private soonTimer: number | null = null
    private inFlight: Promise<WatchState> | null = null
    private lastSnapshot: ActivitySnapshot | null = null
    private failures = 0
    private running = false

    constructor(
        private readonly client: CommunityClient,
        private readonly host: ActivityWatcherHost
    ) {}

    get current(): WatchState {
        return this.state
    }

    get isRunning(): boolean {
        return this.running
    }

    start(): void {
        if (this.running) {
            return
        }
        this.running = true
        this.schedule(STARTUP_DELAY_MS)
    }

    stop(): void {
        this.running = false
        this.clearTimers()
    }

    /** Check shortly (coalesced: a pending "soon" check is not pushed back). */
    checkSoon(delayMs = SOON_DELAY_MS): void {
        if (this.soonTimer !== null) {
            return
        }
        this.soonTimer = window.setTimeout(() => {
            this.soonTimer = null
            void this.check()
        }, delayMs)
    }

    /** Check when the last result is older than `maxAgeMs`. */
    checkIfStale(maxAgeMs: number): void {
        const checkedAt = this.state.checkedAt
        if (
            null === checkedAt ||
            Date.now() - checkedAt >= maxAgeMs ||
            'error' === this.state.status
        ) {
            this.checkSoon()
        }
    }

    /**
     * Lower the unread counts right away after the member read or archived
     * something (the next check confirms them with the community).
     */
    adjustCounts(delta: Partial<ActivityCounts>): void {
        if ('signed-in' !== this.state.status) {
            return
        }
        const counts = this.state.counts
        this.setState({
            ...this.state,
            counts: {
                notifications: Math.max(0, counts.notifications - (delta.notifications ?? 0)),
                messages: Math.max(0, counts.messages - (delta.messages ?? 0)),
                threads: Math.max(0, counts.threads - (delta.threads ?? 0))
            }
        })
    }

    /** Re-apply local read and archived state to the last check, without a new one. */
    refreshView(): void {
        if (this.lastSnapshot && 'signed-in' === this.state.status) {
            this.setState({ ...this.state, items: this.host.decorate(this.lastSnapshot) })
        }
    }

    /** Re-arm the timer with the current interval (after a settings change). */
    reschedule(): void {
        if (this.running && null === this.inFlight) {
            this.schedule(nextDelayMs(this.host.intervalMs(), this.failures))
        }
    }

    /** Check now; concurrent callers share the same check. */
    check(): Promise<WatchState> {
        if (this.inFlight) {
            return this.inFlight
        }
        this.clearTimers()
        const run = this.runCheck().finally(() => {
            this.inFlight = null
            if (this.running) {
                this.schedule(nextDelayMs(this.host.intervalMs(), this.failures))
            }
        })
        this.inFlight = run
        return run
    }

    private async runCheck(): Promise<WatchState> {
        let result: ActivityResult
        try {
            result = await this.client.fetchActivity()
        } catch (error: unknown) {
            this.failures += 1
            this.setState({
                ...this.state,
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            })
            return this.state
        }
        this.failures = 0
        try {
            await this.host.afterCheck(result)
        } catch {
            // Session upkeep must never break the check itself.
        }

        if ('signed-out' === result.status) {
            const wasSignedIn = 'signed-in' === this.state.status
            this.lastSnapshot = null
            this.setState({
                ...INITIAL_WATCH_STATE,
                status: 'signed-out',
                checkedAt: Date.now(),
                transport: result.transport
            })
            if (wasSignedIn) {
                this.host.onSignedOut()
            }
            return this.state
        }

        const { snapshot } = result
        this.lastSnapshot = snapshot
        const items = this.host.decorate(snapshot)
        const seen = this.host.loadSeen()
        // Only unread items worth announcing are news; the rest is just listed.
        const news = items.filter((item) => item.unread && item.notify)
        const fresh = unseenItems(news, new Set(seen.keys))
        this.host.saveSeen(
            rememberKeys(
                seen.keys,
                news.map((item) => item.key)
            )
        )
        this.setState({
            status: 'signed-in',
            member: snapshot.member,
            counts: snapshot.counts,
            items,
            checkedAt: snapshot.fetchedAt,
            error: null,
            transport: snapshot.transport
        })
        if (fresh.length > 0 || !seen.initialized) {
            this.host.onNewItems(fresh, !seen.initialized)
        }
        return this.state
    }

    private setState(next: WatchState): void {
        this.state = next
        this.host.onState(next)
    }

    private schedule(delayMs: number): void {
        if (null !== this.timer) {
            window.clearTimeout(this.timer)
        }
        this.timer = window.setTimeout(() => {
            this.timer = null
            void this.check()
        }, delayMs)
    }

    private clearTimers(): void {
        if (null !== this.timer) {
            window.clearTimeout(this.timer)
            this.timer = null
        }
        if (null !== this.soonTimer) {
            window.clearTimeout(this.soonTimer)
            this.soonTimer = null
        }
    }
}
