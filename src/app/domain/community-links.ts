/**
 * Everything the plugin knows about where the community lives. The pane hosts
 * the community as-is; this module only decides which URL to show.
 */

/** Where people who are not members yet learn about Knowii and join. */
export const KNOWII_JOIN_URL = 'https://www.store.dsebastien.net/product/knowii-community/'

/** A place in the community reachable from the toolbar and the command palette. */
export interface CommunityDestination {
    readonly id: string
    /** Toolbar label and command suffix. */
    readonly label: string
    /** Path appended to the community URL. */
    readonly path: string
    /** Lucide icon shown in the toolbar. */
    readonly icon: string
}

export const COMMUNITY_DESTINATIONS: readonly CommunityDestination[] = [
    { id: 'home', label: 'Home', path: '/', icon: 'home' },
    { id: 'feed', label: 'Feed', path: '/feed', icon: 'newspaper' },
    { id: 'messages', label: 'Messages', path: '/messages', icon: 'message-circle' },
    { id: 'notifications', label: 'Notifications', path: '/notifications', icon: 'bell' },
    { id: 'events', label: 'Events', path: '/events', icon: 'calendar' },
    { id: 'members', label: 'Members', path: '/members', icon: 'users' }
]

/**
 * Turns what the user typed into a usable base URL: adds https when the
 * scheme is missing, drops trailing slashes, refuses anything that is not a
 * web address. Returns null when the input cannot be used.
 */
export function normalizeCommunityUrl(raw: string): string | null {
    const trimmed = raw.trim()
    if ('' === trimmed) {
        return null
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    let parsed: URL
    try {
        parsed = new URL(withScheme)
    } catch {
        return null
    }
    if ('https:' !== parsed.protocol && 'http:' !== parsed.protocol) {
        return null
    }
    if ('' === parsed.hostname || !parsed.hostname.includes('.')) {
        return null
    }
    parsed.hash = ''
    parsed.search = ''
    const base = parsed.toString().replace(/\/+$/, '')
    return base
}

/** Joins the community base URL and a destination path. */
export function buildCommunityUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '')
    if ('' === path || '/' === path) {
        return `${base}/`
    }
    return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Whether a URL belongs to the community (same host). Used to decide if a
 * remembered page is worth restoring, and if a page can be reopened later.
 */
export function isCommunityUrl(baseUrl: string, candidate: string | null | undefined): boolean {
    if (!candidate) {
        return false
    }
    try {
        const base = new URL(baseUrl)
        const url = new URL(candidate)
        return url.host === base.host && ('https:' === url.protocol || 'http:' === url.protocol)
    } catch {
        return false
    }
}
