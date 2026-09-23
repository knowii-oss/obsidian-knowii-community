import type { ActivityCategory } from '../domain/community-activity'
import { ACTIVITY_CATEGORIES } from '../domain/community-activity'
import type { StoredSession } from '../domain/session-cookies'

/** When system notifications are shown: always, only while Obsidian is in the background, or never. */
export type DesktopNotificationMode = 'always' | 'background' | 'off'

export const DESKTOP_NOTIFICATION_MODES: readonly DesktopNotificationMode[] = [
    'always',
    'background',
    'off'
]

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
    return (
        'string' === typeof value &&
        (DESKTOP_NOTIFICATION_MODES as readonly string[]).includes(value)
    )
}

/**
 * The system-notification mode stored on disk. Before 1.2.0 it was the
 * boolean `showDesktopNotifications` (on meant "while in the background");
 * members who had it on now get notifications always, as the default.
 */
export function readDesktopNotificationMode(data: {
    desktopNotifications?: unknown
    showDesktopNotifications?: unknown
}): { mode: DesktopNotificationMode; migrated: boolean } {
    if (isDesktopNotificationMode(data.desktopNotifications)) {
        return { mode: data.desktopNotifications, migrated: false }
    }
    if (false === data.showDesktopNotifications) {
        return { mode: 'off', migrated: true }
    }
    return { mode: 'always', migrated: true }
}

/** Where the community pane opens. */
export type PaneLocation = 'tab' | 'right' | 'left'

export const PANE_LOCATIONS: readonly PaneLocation[] = ['tab', 'right', 'left']

export interface PluginSettings {
    /** Base URL of the community. Only changes when the community moves. */
    communityUrl: string
    /** Where "Open Knowii" puts the pane. */
    paneLocation: PaneLocation
    /** Show the Knowii icon in the ribbon. */
    showRibbonIcon: boolean
    /** Show the toolbar (navigation and shortcuts) above the community. */
    showToolbar: boolean
    /** Reopen the page you were on the last time the pane was open. */
    rememberLastPage: boolean
    /** Zoom of the embedded community, in percent (50 to 200). */
    zoomPercent: number

    /** Check the community in the background for new activity. */
    notificationsEnabled: boolean
    /** Seconds between background checks (one of `CHECK_INTERVALS_SECONDS`). */
    checkIntervalSeconds: number
    /** Announce new activity with an Obsidian notice. */
    showNotices: boolean
    /** When new activity also gets a system notification. */
    desktopNotifications: DesktopNotificationMode
    /** Unread counts in the status bar. */
    showStatusBarBadge: boolean
    /** Unread total on the ribbon icon. */
    showRibbonBadge: boolean
    /** Which kinds of activity are announced. */
    notifyCategories: Record<ActivityCategory, boolean>
    /**
     * Watch the whole community (new posts, comments and chat messages in
     * every space), not only what the community notifies the member about.
     */
    watchWholeCommunity: boolean
    /** Spaces left out of the whole-community watch. */
    mutedSpaceIds: number[]

    /**
     * The member's community session (cookies), copied from the desktop
     * pane. Lets every device where the vault syncs check for activity, and
     * restores the pane's sign-in. Null when signed out.
     */
    session: StoredSession | null
}

export const MIN_ZOOM_PERCENT = 50
export const MAX_ZOOM_PERCENT = 200
export const ZOOM_STEP_PERCENT = 10

/** Background check intervals offered in the settings, in seconds. */
export const CHECK_INTERVALS_SECONDS: readonly number[] = [30, 60, 120, 300, 900, 1800]

export const DEFAULT_CHECK_INTERVAL_SECONDS = 60

/** Every category announced: members opt out, not in. */
export const DEFAULT_NOTIFY_CATEGORIES: Record<ActivityCategory, boolean> = Object.fromEntries(
    ACTIVITY_CATEGORIES.map((info) => [info.id, true])
) as Record<ActivityCategory, boolean>

export const DEFAULT_SETTINGS: PluginSettings = {
    communityUrl: 'https://www.knowii.net',
    paneLocation: 'tab',
    showRibbonIcon: true,
    showToolbar: true,
    rememberLastPage: true,
    zoomPercent: 100,
    notificationsEnabled: true,
    checkIntervalSeconds: DEFAULT_CHECK_INTERVAL_SECONDS,
    showNotices: true,
    desktopNotifications: 'always',
    showStatusBarBadge: true,
    showRibbonBadge: true,
    notifyCategories: DEFAULT_NOTIFY_CATEGORIES,
    watchWholeCommunity: true,
    mutedSpaceIds: [],
    session: null
}

export function isPaneLocation(value: unknown): value is PaneLocation {
    return 'string' === typeof value && (PANE_LOCATIONS as readonly string[]).includes(value)
}

export function isValidZoomPercent(value: unknown): value is number {
    return (
        'number' === typeof value &&
        Number.isFinite(value) &&
        value >= MIN_ZOOM_PERCENT &&
        value <= MAX_ZOOM_PERCENT
    )
}

export function isCheckInterval(value: unknown): value is number {
    return 'number' === typeof value && CHECK_INTERVALS_SECONDS.includes(value)
}

export function isActivityCategory(value: unknown): value is ActivityCategory {
    return 'string' === typeof value && ACTIVITY_CATEGORIES.some((info) => info.id === value)
}

/**
 * Per-category switches read from disk: known categories with a strict
 * boolean are kept, anything missing falls back to on. `complete` is false
 * when something had to be filled in (so the result is written back).
 */
export function parseNotifyCategories(value: unknown): {
    categories: Record<ActivityCategory, boolean>
    complete: boolean
} {
    const categories = { ...DEFAULT_NOTIFY_CATEGORIES }
    let complete = 'object' === typeof value && null !== value && !Array.isArray(value)
    for (const info of ACTIVITY_CATEGORIES) {
        const stored: unknown = complete ? (value as Record<string, unknown>)[info.id] : undefined
        if ('boolean' === typeof stored) {
            categories[info.id] = stored
        } else {
            complete = false
        }
    }
    return { categories, complete }
}

/** Space ids read from disk: finite integers only, no duplicates. */
export function parseSpaceIds(value: unknown): number[] | null {
    if (!Array.isArray(value)) {
        return null
    }
    const ids = value.filter((id): id is number => 'number' === typeof id && Number.isInteger(id))
    return [...new Set(ids)]
}
