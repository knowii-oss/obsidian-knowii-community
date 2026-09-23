import { requestUrl } from 'obsidian'
import type { StoredCookie } from '../domain/session-cookies'
import { cookieHeader, splitSetCookieHeader } from '../domain/session-cookies'

/** The pane's cookie partition. Everything signed-in goes through it. */
export const COMMUNITY_PARTITION = 'persist:knowii-community'

/** What a transport hands back: the status and the parsed body. */
export interface TransportResponse {
    readonly status: number
    /** Parsed JSON; null for an empty or non-JSON body. */
    readonly json: unknown
    /** `Set-Cookie` headers, when the transport can see them. */
    readonly setCookies: readonly string[]
}

export type TransportId = 'electron-session' | 'hidden-webview' | 'stored-cookies'

/** Verbs the community's web app uses to change state (mark as read, archive). */
export type WriteMethod = 'POST' | 'PATCH'

/** Cookie holding the token the community expects in `X-CSRF-Token` on writes. */
export const CSRF_COOKIE = 'csrf_token'

/** Cookie values may be URL-encoded; the header wants the raw token. */
export function decodeCookieValue(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

/**
 * One way of making a signed-in GET to the community. The watcher tries the
 * available transports in order and falls through to the next when one
 * throws, so a missing Electron API or a crashed webview never stops the
 * notifications.
 */
export interface CommunityTransport {
    readonly id: TransportId
    /** GET `path` (community-relative) as the signed-in member. */
    get(baseUrl: string, path: string): Promise<TransportResponse>
    /** A state-changing request (post, message, mark as read…), with the CSRF token. */
    send(
        baseUrl: string,
        path: string,
        method: WriteMethod,
        body?: unknown
    ): Promise<TransportResponse>
    dispose(): void
}

function parseBody(text: string): unknown {
    if ('' === text.trim()) {
        return null
    }
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

const JSON_HEADERS = { accept: 'application/json' }

// ---------------------------------------------------------------------------
// Electron session: the pane's own cookie jar, no page needed
// ---------------------------------------------------------------------------

/** The part of Electron's cookie record the plugin reads and writes. */
interface ElectronCookie {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    expirationDate?: number
}

interface ElectronCookieSetDetails extends ElectronCookie {
    url: string
}

/** The part of Electron's `Session` the plugin uses. */
interface ElectronSession {
    fetch(
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string }
    ): Promise<Response>
    cookies: {
        get(filter: { url?: string; name?: string }): Promise<ElectronCookie[]>
        set(details: ElectronCookieSetDetails): Promise<void>
    }
}

/**
 * The pane's session through Electron's `remote` module. Null when the
 * runtime does not expose it (mobile, or a future Obsidian without `remote`).
 */
export function findElectronSession(partition = COMMUNITY_PARTITION): ElectronSession | null {
    try {
        const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require
        const electron = nodeRequire?.('electron') as
            | { remote?: { session?: { fromPartition?: (name: string) => unknown } } }
            | undefined
        const session = electron?.remote?.session?.fromPartition?.(partition) as
            | Partial<ElectronSession>
            | undefined
        if (
            session &&
            'function' === typeof session.fetch &&
            session.cookies &&
            'function' === typeof session.cookies.get &&
            'function' === typeof session.cookies.set
        ) {
            return session as ElectronSession
        }
    } catch {
        // no Electron here
    }
    return null
}

export class ElectronSessionTransport implements CommunityTransport {
    readonly id = 'electron-session' as const

    constructor(private readonly session: ElectronSession) {}

    async get(baseUrl: string, path: string): Promise<TransportResponse> {
        const response = await this.session.fetch(joinUrl(baseUrl, path), { headers: JSON_HEADERS })
        const text = await response.text()
        return { status: response.status, json: parseBody(text), setCookies: [] }
    }

    async send(
        baseUrl: string,
        path: string,
        method: WriteMethod,
        body?: unknown
    ): Promise<TransportResponse> {
        const [csrf] = await this.session.cookies.get({
            url: joinUrl(baseUrl, '/'),
            name: CSRF_COOKIE
        })
        const response = await this.session.fetch(joinUrl(baseUrl, path), {
            method,
            headers: {
                ...JSON_HEADERS,
                'content-type': 'application/json',
                ...(csrf ? { 'x-csrf-token': decodeCookieValue(csrf.value) } : {})
            },
            ...(undefined === body ? {} : { body: JSON.stringify(body) })
        })
        const text = await response.text()
        return { status: response.status, json: parseBody(text), setCookies: [] }
    }

    /** Every cookie the jar would send to the community. */
    async readCookies(baseUrl: string): Promise<StoredCookie[]> {
        const cookies = await this.session.cookies.get({ url: joinUrl(baseUrl, '/') })
        const host = new URL(baseUrl).host
        return cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain ?? host,
            path: cookie.path ?? '/',
            secure: true === cookie.secure,
            httpOnly: true === cookie.httpOnly,
            ...(undefined === cookie.expirationDate
                ? {}
                : { expirationDate: cookie.expirationDate })
        }))
    }

    /** Puts stored cookies back in the jar (sign-in restored on this device). */
    async writeCookies(baseUrl: string, cookies: readonly StoredCookie[]): Promise<void> {
        const protocol = new URL(baseUrl).protocol
        for (const cookie of cookies) {
            const host = cookie.domain.replace(/^\./, '')
            await this.session.cookies.set({
                url: `${protocol}//${host}${cookie.path}`,
                name: cookie.name,
                value: cookie.value,
                // Host-only cookies are set without a domain, as the jar had them.
                ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                ...(undefined === cookie.expirationDate
                    ? {}
                    : { expirationDate: cookie.expirationDate })
            })
        }
    }

    dispose(): void {}
}

// ---------------------------------------------------------------------------
// Hidden webview: same partition, requests made from a same-origin page
// ---------------------------------------------------------------------------

interface HiddenWebview extends HTMLElement {
    executeJavaScript(code: string): Promise<unknown>
}

/** Small same-origin page to run requests from. An empty 404 is fine: the origin is what counts. */
const ANCHOR_PATH = '/robots.txt'
const LOAD_TIMEOUT_MS = 30_000

/**
 * Desktop fallback when Electron's `remote` is gone: an invisible `<webview>`
 * on the pane's partition, parked on a tiny community page, runs `fetch()`
 * from there with the member's cookies.
 */
export class HiddenWebviewTransport implements CommunityTransport {
    readonly id = 'hidden-webview' as const

    private container: HTMLElement | null = null
    private ready: Promise<HiddenWebview> | null = null
    private loadedBase: string | null = null

    async get(baseUrl: string, path: string): Promise<TransportResponse> {
        const webview = await this.ensure(baseUrl)
        const script = `fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } })
            .then((response) => response.text().then((text) => ({ status: response.status, text })))`
        const result = (await webview.executeJavaScript(script)) as {
            status?: unknown
            text?: unknown
        }
        if ('number' !== typeof result?.status) {
            throw new Error('The hidden community page returned nothing')
        }
        return {
            status: result.status,
            json: parseBody('string' === typeof result.text ? result.text : ''),
            setCookies: []
        }
    }

    async send(
        baseUrl: string,
        path: string,
        method: WriteMethod,
        body?: unknown
    ): Promise<TransportResponse> {
        const webview = await this.ensure(baseUrl)
        // Same token lookup as the community's web app: the csrf_token cookie.
        const script = `(() => {
            const pair = document.cookie.split('; ').find((entry) => entry.startsWith(${JSON.stringify(`${CSRF_COOKIE}=`)}))
            const token = pair ? decodeURIComponent(pair.slice(${CSRF_COOKIE.length + 1})) : ''
            const headers = { accept: 'application/json', 'content-type': 'application/json' }
            if (token) headers['x-csrf-token'] = token
            return fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, credentials: 'include', headers${undefined === body ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`} })
                .then((response) => response.text().then((text) => ({ status: response.status, text })))
        })()`
        const result = (await webview.executeJavaScript(script)) as {
            status?: unknown
            text?: unknown
        }
        if ('number' !== typeof result?.status) {
            throw new Error('The hidden community page returned nothing')
        }
        return {
            status: result.status,
            json: parseBody('string' === typeof result.text ? result.text : ''),
            setCookies: []
        }
    }

    private ensure(baseUrl: string): Promise<HiddenWebview> {
        if (this.ready && this.loadedBase === baseUrl) {
            return this.ready
        }
        this.dispose()
        this.loadedBase = baseUrl
        const ready = new Promise<HiddenWebview>((resolve, reject) => {
            const container = document.body.createDiv({ cls: 'knowii-community-hidden-host' })
            container.setAttribute('aria-hidden', 'true')
            const element = container.createEl('webview' as keyof HTMLElementTagNameMap)
            element.setAttribute('partition', COMMUNITY_PARTITION)
            element.setAttribute('src', joinUrl(baseUrl, ANCHOR_PATH))
            const webview = element as unknown as HiddenWebview
            this.container = container

            const timeout = window.setTimeout(() => {
                reject(new Error('The hidden community page did not load in time'))
            }, LOAD_TIMEOUT_MS)
            webview.addEventListener('dom-ready', () => {
                window.clearTimeout(timeout)
                resolve(webview)
            })
            webview.addEventListener('did-fail-load', (event: Event) => {
                const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
                if (false === failure.isMainFrame || -3 === failure.errorCode) {
                    return
                }
                window.clearTimeout(timeout)
                reject(new Error('The hidden community page failed to load'))
            })
            // A crashed renderer is replaced on the next request.
            webview.addEventListener('render-process-gone', () => {
                this.dispose()
            })
        })
        // A failed load is retried from scratch next time.
        ready.catch(() => {
            if (this.ready === ready) {
                this.dispose()
            }
        })
        this.ready = ready
        return ready
    }

    dispose(): void {
        this.container?.remove()
        this.container = null
        this.ready = null
        this.loadedBase = null
    }
}

// ---------------------------------------------------------------------------
// Stored cookies: plain HTTP with the session kept in the plugin settings
// ---------------------------------------------------------------------------

/**
 * Works anywhere Obsidian runs, mobile included, as long as a session was
 * stored from a desktop sign-in. Cookie updates from the community are
 * handed back so the stored session stays current.
 */
export class StoredCookiesTransport implements CommunityTransport {
    readonly id = 'stored-cookies' as const

    constructor(private readonly getCookies: () => readonly StoredCookie[] | null) {}

    async get(baseUrl: string, path: string): Promise<TransportResponse> {
        const cookies = this.getCookies()
        const host = new URL(baseUrl).host
        const header = cookies ? cookieHeader(cookies, host) : ''
        if ('' === header) {
            // Nothing stored: the same answer the community gives a visitor.
            return { status: 401, json: null, setCookies: [] }
        }
        const response = await requestUrl({
            url: joinUrl(baseUrl, path),
            headers: { ...JSON_HEADERS, cookie: header },
            throw: false
        })
        return toTransportResponse(response)
    }

    async send(
        baseUrl: string,
        path: string,
        method: WriteMethod,
        body?: unknown
    ): Promise<TransportResponse> {
        const cookies = this.getCookies()
        const host = new URL(baseUrl).host
        const header = cookies ? cookieHeader(cookies, host) : ''
        if ('' === header) {
            return { status: 401, json: null, setCookies: [] }
        }
        const csrf = cookies?.find((cookie) => CSRF_COOKIE === cookie.name)
        const response = await requestUrl({
            url: joinUrl(baseUrl, path),
            method,
            contentType: 'application/json',
            headers: {
                ...JSON_HEADERS,
                cookie: header,
                ...(csrf ? { 'x-csrf-token': decodeCookieValue(csrf.value) } : {})
            },
            ...(undefined === body ? {} : { body: JSON.stringify(body) }),
            throw: false
        })
        return toTransportResponse(response)
    }

    dispose(): void {}
}

function toTransportResponse(response: {
    status: number
    text: string
    headers: Record<string, string>
}): TransportResponse {
    const setCookieKey = Object.keys(response.headers).find(
        (key) => 'set-cookie' === key.toLowerCase()
    )
    return {
        status: response.status,
        json: parseBody(response.text),
        setCookies: splitSetCookieHeader(setCookieKey ? response.headers[setCookieKey] : undefined)
    }
}
