import type { RealtimeEndpoint } from '../domain/community-provider'
import { COMMUNITY_PARTITION } from './community-transport'
import { log } from '../../utils/log'

/** Prefix of the console lines the in-page script uses to talk to the plugin. */
const SIGNAL = '__knowii_rt__:'
/** A tiny same-origin page to open the websocket from (cookies and Origin match). */
const ANCHOR_PATH = '/robots.txt'

export type RealtimeStatus = 'off' | 'connecting' | 'live'

export interface RealtimeHost {
    baseUrl(): string
    /** Something happened in the community: check now. */
    onActivity(): void
    onStatus(status: RealtimeStatus): void
}

interface Webview extends HTMLElement {
    executeJavaScript(code: string): Promise<unknown>
}

/**
 * The script run inside the hidden community page: opens the community's own
 * live-update websocket (the one its web app uses), subscribes to the
 * member's notification and chat channels, and reports through console lines.
 * Reconnects by itself with backoff; the plugin never parses the payloads,
 * any event just triggers a check.
 */
export function realtimeScript(endpoint: RealtimeEndpoint): string {
    return `(() => {
    if (window.__knowiiRealtime) { return 'running' }
    window.__knowiiRealtime = true
    const subscriptions = ${JSON.stringify(endpoint.subscriptions)}
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(endpoint.path)}
    let delay = 2000
    const connect = () => {
        const socket = new WebSocket(url, [${JSON.stringify(endpoint.protocol)}])
        socket.onopen = () => { delay = 2000 }
        socket.onmessage = (event) => {
            let message
            try { message = JSON.parse(event.data) } catch { return }
            if ('welcome' === message.type) { subscriptions.forEach((command) => socket.send(command)); return }
            if ('confirm_subscription' === message.type) { console.log(${JSON.stringify(SIGNAL)} + 'live'); return }
            if ('reject_subscription' === message.type) { console.log(${JSON.stringify(SIGNAL)} + 'rejected'); return }
            if ('ping' === message.type || 'disconnect' === message.type) { return }
            if (undefined !== message.message) { console.log(${JSON.stringify(SIGNAL)} + 'activity') }
        }
        socket.onclose = () => {
            console.log(${JSON.stringify(SIGNAL)} + 'closed')
            setTimeout(connect, delay)
            delay = Math.min(delay * 2, 60000)
        }
    }
    connect()
    return 'started'
})()`
}

/**
 * Instant notifications on desktop: a hidden webview on the pane's session
 * holds the community's live-update connection. Background checks keep
 * running regardless; this only makes them come right away.
 */
export class RealtimeLink {
    private container: HTMLElement | null = null
    private key: string | null = null
    private status: RealtimeStatus = 'off'

    constructor(private readonly host: RealtimeHost) {}

    get current(): RealtimeStatus {
        return this.status
    }

    /** Connect for this endpoint (no-op when already connected to it). */
    connect(endpoint: RealtimeEndpoint): void {
        const key = `${this.host.baseUrl()}|${endpoint.subscriptions.join('|')}`
        if (this.container && this.key === key) {
            return
        }
        this.dispose()
        this.key = key
        this.setStatus('connecting')

        const container = document.body.createDiv({ cls: 'knowii-community-hidden-host' })
        container.setAttribute('aria-hidden', 'true')
        const element = container.createEl('webview' as keyof HTMLElementTagNameMap)
        element.setAttribute('partition', COMMUNITY_PARTITION)
        element.setAttribute('src', `${this.host.baseUrl().replace(/\/+$/, '')}${ANCHOR_PATH}`)
        const webview = element as unknown as Webview
        this.container = container

        webview.addEventListener('dom-ready', () => {
            void webview.executeJavaScript(realtimeScript(endpoint)).catch((error: unknown) => {
                log('Live updates could not start', 'warn', error)
            })
        })
        webview.addEventListener('console-message', (event: Event) => {
            const message = (event as Event & { message?: unknown }).message
            if ('string' !== typeof message || !message.startsWith(SIGNAL)) {
                return
            }
            switch (message.slice(SIGNAL.length)) {
                case 'activity':
                    this.host.onActivity()
                    return
                case 'live':
                    this.setStatus('live')
                    return
                case 'closed':
                case 'rejected':
                    this.setStatus('connecting')
                    return
            }
        })
        // A crashed renderer is rebuilt on the next connect().
        webview.addEventListener('render-process-gone', () => {
            this.dispose()
        })
    }

    dispose(): void {
        this.container?.remove()
        this.container = null
        this.key = null
        this.setStatus('off')
    }

    private setStatus(status: RealtimeStatus): void {
        if (status !== this.status) {
            this.status = status
            this.host.onStatus(status)
        }
    }
}
