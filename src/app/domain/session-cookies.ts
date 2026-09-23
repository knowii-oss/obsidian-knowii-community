/**
 * The member's community session, as cookies the plugin keeps in its
 * settings. The desktop pane's cookie jar is the source; the stored copy
 * lets other devices (mobile included) check for activity with the same
 * sign-in, and restores the pane's session on a device that has none.
 */

export interface StoredCookie {
    readonly name: string
    readonly value: string
    /** Cookie domain as the jar reports it (`www.knowii.net`, `.knowii.net`). */
    readonly domain: string
    readonly path: string
    readonly secure: boolean
    readonly httpOnly: boolean
    /** Seconds since the epoch; absent for session cookies. */
    readonly expirationDate?: number
}

export interface StoredSession {
    readonly cookies: readonly StoredCookie[]
    /** ISO timestamp of the last change. */
    readonly savedAt: string
}

/**
 * Cookies that carry the sign-in. The session is only worth storing when one
 * of them is present, and only needs rewriting when one of them changes
 * (analytics cookies churn on every request).
 */
export const AUTH_COOKIE_NAMES: readonly string[] = [
    'remember_user_token',
    '_circle_session',
    'user_session_identifier'
]

function isObject(value: unknown): value is Record<string, unknown> {
    return 'object' === typeof value && null !== value && !Array.isArray(value)
}

export function isStoredCookie(value: unknown): value is StoredCookie {
    return (
        isObject(value) &&
        'string' === typeof value['name'] &&
        '' !== value['name'] &&
        'string' === typeof value['value'] &&
        'string' === typeof value['domain'] &&
        'string' === typeof value['path'] &&
        'boolean' === typeof value['secure'] &&
        'boolean' === typeof value['httpOnly'] &&
        (undefined === value['expirationDate'] ||
            ('number' === typeof value['expirationDate'] &&
                Number.isFinite(value['expirationDate'])))
    )
}

/** Validates a session read from `data.json`; null when unusable. */
export function parseStoredSession(value: unknown): StoredSession | null {
    if (!isObject(value) || !Array.isArray(value['cookies'])) {
        return null
    }
    const cookies = value['cookies'].filter(isStoredCookie)
    if (!hasAuthCookie(cookies)) {
        return null
    }
    return {
        cookies,
        savedAt: 'string' === typeof value['savedAt'] ? value['savedAt'] : new Date(0).toISOString()
    }
}

export function isExpired(cookie: StoredCookie, nowMs: number): boolean {
    return undefined !== cookie.expirationDate && cookie.expirationDate * 1000 <= nowMs
}

export function hasAuthCookie(cookies: readonly StoredCookie[], nowMs = Date.now()): boolean {
    return cookies.some(
        (cookie) =>
            AUTH_COOKIE_NAMES.includes(cookie.name) &&
            '' !== cookie.value &&
            !isExpired(cookie, nowMs)
    )
}

/** Whether a cookie applies to a host (exact, or a parent domain with a leading dot). */
export function cookieMatchesHost(cookie: StoredCookie, host: string): boolean {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const target = host.toLowerCase()
    return target === domain || target.endsWith(`.${domain}`)
}

/** The `Cookie` header for a request to `host`, expired cookies left out. */
export function cookieHeader(
    cookies: readonly StoredCookie[],
    host: string,
    nowMs = Date.now()
): string {
    return cookies
        .filter((cookie) => cookieMatchesHost(cookie, host) && !isExpired(cookie, nowMs))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ')
}

/** Fingerprint of the sign-in cookies; equal fingerprints need no rewrite. */
export function authFingerprint(cookies: readonly StoredCookie[]): string {
    return AUTH_COOKIE_NAMES.map(
        (name) => `${name}=${cookies.find((cookie) => cookie.name === name)?.value ?? ''}`
    ).join('\n')
}

/**
 * Applies `Set-Cookie` response headers to a cookie list: new values replace
 * old ones, deletions (empty value or a past expiry) remove them.
 */
export function applySetCookies(
    cookies: readonly StoredCookie[],
    setCookieHeaders: readonly string[],
    host: string,
    nowMs = Date.now()
): StoredCookie[] {
    let next = [...cookies]
    for (const header of setCookieHeaders) {
        const parsed = parseSetCookie(header, host, nowMs)
        if (!parsed) {
            continue
        }
        next = next.filter(
            (cookie) => !(cookie.name === parsed.cookie.name && cookie.path === parsed.cookie.path)
        )
        if (!parsed.deleted) {
            next.push(parsed.cookie)
        }
    }
    return next
}

function parseSetCookie(
    header: string,
    host: string,
    nowMs: number
): { cookie: StoredCookie; deleted: boolean } | null {
    const [pair, ...attributes] = header.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (!pair || separator <= 0) {
        return null
    }
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    let domain = host
    let path = '/'
    let secure = false
    let httpOnly = false
    let expirationDate: number | undefined
    for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split('=')
        const key = rawKey?.trim().toLowerCase() ?? ''
        const attrValue = rest.join('=').trim()
        if ('domain' === key && '' !== attrValue) {
            domain = attrValue
        } else if ('path' === key && '' !== attrValue) {
            path = attrValue
        } else if ('secure' === key) {
            secure = true
        } else if ('httponly' === key) {
            httpOnly = true
        } else if ('max-age' === key && /^-?\d+$/.test(attrValue)) {
            expirationDate = nowMs / 1000 + Number(attrValue)
        } else if ('expires' === key && undefined === expirationDate) {
            const parsed = Date.parse(attrValue)
            if (Number.isFinite(parsed)) {
                expirationDate = parsed / 1000
            }
        }
    }
    const cookie: StoredCookie = {
        name,
        value,
        domain,
        path,
        secure,
        httpOnly,
        ...(undefined === expirationDate ? {} : { expirationDate })
    }
    return { cookie, deleted: '' === value || isExpired(cookie, nowMs) }
}

/**
 * Some HTTP stacks join repeated `Set-Cookie` headers with commas. Splits
 * them back, without splitting the comma inside an `Expires` date.
 */
export function splitSetCookieHeader(value: string | readonly string[] | undefined): string[] {
    if (undefined === value) {
        return []
    }
    if ('string' !== typeof value) {
        return value.flatMap((entry) => splitSetCookieHeader(entry))
    }
    return value
        .split(/,(?=\s*[^;,\s]+=)/)
        .map((part) => part.trim())
        .filter((part) => '' !== part)
}
