import { ItemView, Menu, Platform, setIcon, setTooltip } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import { KNOWII_ICON_ID } from '../assets/knowii-icon'
import {
    ADMIN_DESTINATIONS,
    COMMUNITY_DESTINATIONS,
    KNOWII_JOIN_URL,
    buildCommunityUrl,
    isCommunityUrl
} from '../domain/community-links'
import type { PluginSettings } from '../types/plugin-settings.intf'
import { log } from '../../utils/log'

export const COMMUNITY_VIEW_TYPE = 'knowii-community'

/** CSS prefix shared with `styles.src.css`. */
const CLS = 'knowii-community'

/**
 * Electron's `<webview>` tag, as much of it as the pane uses. The Obsidian
 * typings do not ship Electron's, and depending on them would drag a whole
 * runtime into a plugin that only needs one element.
 */
interface WebviewElement extends HTMLElement {
    src: string
    loadURL(url: string): Promise<void>
    getURL(): string
    goBack(): void
    goForward(): void
    canGoBack(): boolean
    canGoForward(): boolean
    reload(): void
    setZoomFactor(factor: number): void
}

/** `did-fail-load` payload; only the parts the pane reads. */
interface DidFailLoadEvent extends Event {
    errorCode?: number
    errorDescription?: string
    validatedURL?: string
    isMainFrame?: boolean
}

/** Electron's "navigation aborted" code: a new load superseded the previous one. */
const ERR_ABORTED = -3

/**
 * What the pane needs from the plugin. Kept behind an interface so the view
 * never reaches into the plugin instance: settings are read on every render,
 * per-device memory goes through the plugin's local storage helpers.
 */
export interface CommunityViewHost {
    getSettings(): PluginSettings
    loadLastUrl(): string | null
    saveLastUrl(url: string): void
    hasSeenWelcome(): boolean
    markWelcomeSeen(): void
    openExternal(url: string): void
    /** The member moved around the community (reading may clear unread items). */
    onNavigated(): void
    /** Whether the signed-in member is a community admin (as last checked). */
    isAdmin(): boolean
    /** Unread total (as last checked). */
    unreadCount(): number
    /** Show the list of what is unread. */
    showActivity(): void
}

/**
 * The community pane: a toolbar (brand, back/forward/reload, shortcuts, open
 * in browser) over the community itself, hosted in a `<webview>` with its own
 * persistent cookie partition so the member stays signed in across restarts.
 *
 * First open shows a welcome card (sign in, or discover Knowii) instead of a
 * blank page; afterwards the pane restores the last page when asked to.
 *
 * Desktop only at runtime: the mobile app has no `<webview>`, so the pane
 * offers to open the community in the browser instead.
 */
export class KnowiiCommunityView extends ItemView {
    override navigation = false

    private readonly host: CommunityViewHost
    private webview: WebviewElement | null = null
    private bodyEl: HTMLElement | null = null
    private backButton: HTMLElement | null = null
    private forwardButton: HTMLElement | null = null
    private adminButton: HTMLElement | null = null
    private activityBadge: HTMLElement | null = null

    constructor(leaf: WorkspaceLeaf, host: CommunityViewHost) {
        super(leaf)
        this.host = host
        this.icon = KNOWII_ICON_ID
    }

    override getViewType(): string {
        return COMMUNITY_VIEW_TYPE
    }

    override getDisplayText(): string {
        return 'Knowii'
    }

    protected override async onOpen(): Promise<void> {
        this.render()
        return Promise.resolve()
    }

    protected override async onClose(): Promise<void> {
        this.teardown()
        return Promise.resolve()
    }

    /** Re-render after a settings change (toolbar, zoom, location). */
    refresh(): void {
        const current = this.currentUrl()
        this.render(current)
    }

    /** Refresh the toolbar's activity bits: unread badge, admin menu. */
    updateActivity(unread: number, isAdmin: boolean): void {
        this.adminButton?.toggle(isAdmin)
        if (this.activityBadge) {
            this.activityBadge.toggle(unread > 0)
            this.activityBadge.setText(unread > 99 ? '99+' : String(unread))
        }
    }

    /** Navigate the hosted community to a path such as `/feed`. */
    navigateTo(path: string): void {
        const url = buildCommunityUrl(this.host.getSettings().communityUrl, path)
        this.showPage(url)
    }

    /** Reload the hosted community. */
    reload(): void {
        if (this.webview) {
            this.webview.reload()
        } else {
            this.render()
        }
    }

    /** The page currently shown, when it belongs to the community. */
    currentUrl(): string | null {
        if (!this.webview) {
            return null
        }
        try {
            const url = this.webview.getURL()
            return isCommunityUrl(this.host.getSettings().communityUrl, url) ? url : null
        } catch {
            return null
        }
    }

    /** Open the current page (or the community home) in the system browser. */
    openInBrowser(): void {
        const url =
            this.currentUrl() ?? buildCommunityUrl(this.host.getSettings().communityUrl, '/')
        this.host.openExternal(url)
    }

    private render(startUrl: string | null = null): void {
        this.teardown()
        const settings = this.host.getSettings()
        const root = this.contentEl
        root.empty()
        root.addClass(`${CLS}-content`)

        if (!Platform.isDesktopApp) {
            this.renderUnsupported(root, settings)
            return
        }

        if (settings.showToolbar) {
            this.renderToolbar(root)
        }
        this.bodyEl = root.createDiv({ cls: `${CLS}-body` })

        if (!this.host.hasSeenWelcome()) {
            this.renderWelcome(this.bodyEl, settings)
            return
        }

        const remembered = settings.rememberLastPage ? this.host.loadLastUrl() : null
        const url =
            startUrl ??
            (isCommunityUrl(settings.communityUrl, remembered)
                ? (remembered as string)
                : buildCommunityUrl(settings.communityUrl, '/'))
        this.mountWebview(this.bodyEl, url, settings)
    }

    private teardown(): void {
        this.webview = null
        this.bodyEl = null
        this.backButton = null
        this.forwardButton = null
        this.adminButton = null
        this.activityBadge = null
        this.contentEl.empty()
    }

    private renderToolbar(root: HTMLElement): void {
        const toolbar = root.createDiv({ cls: `${CLS}-toolbar` })

        const brand = toolbar.createDiv({ cls: `${CLS}-brand` })
        const mark = brand.createSpan({ cls: `${CLS}-brand-mark` })
        setIcon(mark, KNOWII_ICON_ID)
        brand.createSpan({ cls: `${CLS}-brand-name`, text: 'Knowii' })

        const nav = toolbar.createDiv({ cls: `${CLS}-nav` })
        this.backButton = this.toolbarButton(nav, 'arrow-left', 'Back', () => {
            this.webview?.goBack()
        })
        this.forwardButton = this.toolbarButton(nav, 'arrow-right', 'Forward', () => {
            this.webview?.goForward()
        })
        this.toolbarButton(nav, 'rotate-cw', 'Reload', () => {
            this.reload()
        })

        const shortcuts = toolbar.createDiv({ cls: `${CLS}-shortcuts` })
        for (const destination of COMMUNITY_DESTINATIONS) {
            const button = this.toolbarButton(
                shortcuts,
                destination.icon,
                destination.label,
                () => {
                    this.navigateTo(destination.path)
                }
            )
            button.addClass(`${CLS}-shortcut`)
            button.createSpan({ cls: `${CLS}-shortcut-label`, text: destination.label })
        }

        const actions = toolbar.createDiv({ cls: `${CLS}-actions` })
        const activityButton = this.toolbarButton(actions, 'inbox', "What's new", () => {
            this.host.showActivity()
        })
        activityButton.addClass(`${CLS}-activity-button`)
        this.activityBadge = activityButton.createSpan({ cls: `${CLS}-button-badge` })
        const adminButton = this.toolbarButton(actions, 'shield', 'Admin', () => {})
        // The menu needs the click position, which toolbarButton does not pass on.
        adminButton.addEventListener('click', (event) => {
            const menu = new Menu()
            for (const destination of ADMIN_DESTINATIONS) {
                menu.addItem((item) =>
                    item
                        .setTitle(destination.label)
                        .setIcon(destination.icon)
                        .onClick(() => {
                            this.navigateTo(destination.path)
                        })
                )
            }
            menu.showAtMouseEvent(event)
        })
        this.adminButton = adminButton
        this.updateActivity(this.host.unreadCount(), this.host.isAdmin())
        this.toolbarButton(actions, 'external-link', 'Open in browser', () => {
            this.openInBrowser()
        })
        this.updateNavButtons()
    }

    private toolbarButton(
        parent: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void
    ): HTMLElement {
        const button = parent.createEl('button', {
            cls: `${CLS}-button clickable-icon`,
            attr: { 'aria-label': label, 'type': 'button' }
        })
        const iconEl = button.createSpan({ cls: `${CLS}-button-icon` })
        setIcon(iconEl, icon)
        setTooltip(button, label)
        button.addEventListener('click', (event) => {
            event.preventDefault()
            onClick()
        })
        return button
    }

    private updateNavButtons(): void {
        const canGoBack = this.safely(() => this.webview?.canGoBack() ?? false)
        const canGoForward = this.safely(() => this.webview?.canGoForward() ?? false)
        this.backButton?.toggleClass('is-disabled', !canGoBack)
        this.forwardButton?.toggleClass('is-disabled', !canGoForward)
    }

    private safely(read: () => boolean): boolean {
        try {
            return read()
        } catch {
            return false
        }
    }

    private renderWelcome(parent: HTMLElement, settings: PluginSettings): void {
        const card = parent.createDiv({ cls: `${CLS}-card` })
        const mark = card.createDiv({ cls: `${CLS}-card-mark` })
        setIcon(mark, KNOWII_ICON_ID)
        card.createEl('h2', { cls: `${CLS}-card-title`, text: 'Welcome to Knowii' })
        card.createEl('p', {
            cls: `${CLS}-card-text`,
            text: 'A community of knowledge workers who organize their notes and put their knowledge to work, together. Discussions, questions, events and direct messages, right here in your vault.'
        })

        const buttons = card.createDiv({ cls: `${CLS}-card-buttons` })
        const signIn = buttons.createEl('button', {
            cls: `mod-cta ${CLS}-card-button`,
            text: 'Sign in',
            attr: { type: 'button' }
        })
        signIn.addEventListener('click', () => {
            this.host.markWelcomeSeen()
            this.render(buildCommunityUrl(settings.communityUrl, '/'))
        })
        const discover = buttons.createEl('button', {
            cls: `${CLS}-card-button`,
            text: 'Discover Knowii',
            attr: { type: 'button' }
        })
        discover.addEventListener('click', () => {
            this.host.openExternal(KNOWII_JOIN_URL)
        })

        card.createEl('p', {
            cls: `${CLS}-card-hint`,
            text: 'Not a member yet? Discover what Knowii offers, then come back and sign in.'
        })
    }

    private renderUnsupported(root: HTMLElement, settings: PluginSettings): void {
        const card = root.createDiv({ cls: `${CLS}-card` })
        const mark = card.createDiv({ cls: `${CLS}-card-mark` })
        setIcon(mark, KNOWII_ICON_ID)
        card.createEl('h2', { cls: `${CLS}-card-title`, text: 'Knowii' })
        card.createEl('p', {
            cls: `${CLS}-card-text`,
            text: 'The community pane is available on desktop. On this device, open Knowii in your browser.'
        })
        const buttons = card.createDiv({ cls: `${CLS}-card-buttons` })
        const open = buttons.createEl('button', {
            cls: `mod-cta ${CLS}-card-button`,
            text: 'Open Knowii',
            attr: { type: 'button' }
        })
        open.addEventListener('click', () => {
            this.host.openExternal(buildCommunityUrl(settings.communityUrl, '/'))
        })
    }

    private renderLoadError(parent: HTMLElement, description: string, url: string): void {
        parent.empty()
        const card = parent.createDiv({ cls: `${CLS}-card` })
        const mark = card.createDiv({ cls: `${CLS}-card-mark` })
        setIcon(mark, 'wifi-off')
        card.createEl('h2', { cls: `${CLS}-card-title`, text: 'Knowii is unreachable' })
        card.createEl('p', {
            cls: `${CLS}-card-text`,
            text: `The community could not be loaded (${description}). Check your connection and try again.`
        })
        const buttons = card.createDiv({ cls: `${CLS}-card-buttons` })
        const retry = buttons.createEl('button', {
            cls: `mod-cta ${CLS}-card-button`,
            text: 'Try again',
            attr: { type: 'button' }
        })
        retry.addEventListener('click', () => {
            this.render(url)
        })
        const browser = buttons.createEl('button', {
            cls: `${CLS}-card-button`,
            text: 'Open in browser',
            attr: { type: 'button' }
        })
        browser.addEventListener('click', () => {
            this.host.openExternal(url)
        })
    }

    private mountWebview(parent: HTMLElement, url: string, settings: PluginSettings): void {
        parent.empty()
        // `webview` is not in HTMLElementTagNameMap; the element itself is real
        // in Obsidian's Electron renderer, where the tag is enabled.
        const element = parent.createEl('webview' as keyof HTMLElementTagNameMap, {
            cls: `${CLS}-webview`
        })
        const webview = element as unknown as WebviewElement
        // One partition for the whole plugin: the member's session survives
        // reopening the pane and restarting the app.
        element.setAttribute('partition', 'persist:knowii-community')
        // Links that ask for a new window (file previews, external sites) get
        // one instead of being silently dropped.
        element.setAttribute('allowpopups', '')
        element.setAttribute('src', url)
        this.webview = webview

        const zoom = settings.zoomPercent / 100
        webview.addEventListener('dom-ready', () => {
            try {
                webview.setZoomFactor(zoom)
            } catch (error: unknown) {
                log('Could not apply zoom', 'warn', error)
            }
            this.updateNavButtons()
        })
        const onNavigate = (): void => {
            this.updateNavButtons()
            const current = this.currentUrl()
            if (current) {
                this.host.saveLastUrl(current)
            }
            this.host.onNavigated()
        }
        webview.addEventListener('did-navigate', onNavigate)
        webview.addEventListener('did-navigate-in-page', onNavigate)
        webview.addEventListener('did-fail-load', (event: Event) => {
            const failure = event as DidFailLoadEvent
            if (ERR_ABORTED === failure.errorCode || false === failure.isMainFrame) {
                return
            }
            log('Community failed to load', 'warn', failure.errorDescription, failure.validatedURL)
            const target = failure.validatedURL ?? url
            this.webview = null
            this.renderLoadError(parent, failure.errorDescription ?? 'unknown error', target)
        })
    }

    private showPage(url: string): void {
        if (!this.bodyEl) {
            this.render(url)
            return
        }
        if (!this.webview) {
            // Welcome card or error card is showing: replace it with the page.
            this.host.markWelcomeSeen()
            this.mountWebview(this.bodyEl, url, this.host.getSettings())
            return
        }
        void this.webview.loadURL(url).catch((error: unknown) => {
            log('Navigation failed', 'warn', error)
        })
    }
}
