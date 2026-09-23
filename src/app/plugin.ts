import { MarkdownView, Menu, Notice, Platform, Plugin, TFile, addIcon } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import {
    DEFAULT_SETTINGS,
    isCheckInterval,
    isPaneLocation,
    isValidZoomPercent,
    parseNotifyCategories,
    parseSpaceIds,
    readDesktopNotificationMode
} from './types/plugin-settings.intf'
import type { PluginSettings } from './types/plugin-settings.intf'
import { KnowiiCommunitySettingTab } from './settings/settings-tab'
import { log } from '../utils/log'
import { registerWhatsNewView } from './whats-new'
import { castDraft, produce } from 'immer'
import type { Draft } from 'immer'
import { KNOWII_ICON_ID, KNOWII_ICON_SVG } from './assets/knowii-icon'
import { COMMUNITY_VIEW_TYPE, KnowiiCommunityView } from './ui/community-view'
import type { CommunityViewHost } from './ui/community-view'
import {
    ADMIN_DESTINATIONS,
    COMMUNITY_DESTINATIONS,
    buildCommunityUrl,
    normalizeCommunityUrl
} from './domain/community-links'
import type { ActivityItem } from './domain/community-activity'
import { totalUnread } from './domain/community-activity'
import type { StoredSession } from './domain/session-cookies'
import {
    applySetCookies,
    authFingerprint,
    hasAuthCookie,
    parseStoredSession
} from './domain/session-cookies'
import {
    ElectronSessionTransport,
    HiddenWebviewTransport,
    StoredCookiesTransport,
    communityPartition,
    findElectronSession,
    vaultId
} from './services/community-transport'
import type { CommunityTransport } from './services/community-transport'
import { CommunityClient } from './services/community-client'
import type { ActivityResult } from './services/community-client'
import { ActivityWatcher, INITIAL_WATCH_STATE } from './services/activity-watcher'
import type { WatchState } from './services/activity-watcher'
import { announceBacklog, announceItems, showPlainNotice } from './ui/activity-alerts'
import type { AlertOptions } from './ui/activity-alerts'
import { StatusBarBadge, renderRibbonBadge } from './ui/activity-indicators'
import { ActivityModal } from './ui/activity-modal'
import { fillActivityMenu } from './ui/activity-menu'
import { confirmAction } from './ui/confirm-modal'
import { AskModal, EventsModal, ReplyModal } from './ui/compose-modals'
import type { CommunityProvider } from './domain/community-provider'
import type { CommunityEvent } from './domain/community-content'
import {
    parseCommunityTarget,
    renderPostNote,
    renderThreadNote,
    threadTitle
} from './domain/community-content'
import { RealtimeLink } from './services/realtime-link'
import { EventReminders } from './services/event-reminders'
import { saveNote } from './services/note-saver'
import { ActivityInbox } from './services/activity-inbox'
import type { ActivityListController } from './ui/activity-modal'
import type { WatchableSpace } from './domain/community-watch'

const LAST_URL_KEY = 'knowii-community:last-url'
const WELCOME_SEEN_KEY = 'knowii-community:welcome-seen'
/** Per device: which items the member has already been told about. */
const SEEN_KEYS_KEY = 'knowii-community:seen-activity'
/** Per device: when watching the whole community started (nothing older is announced). */
const WATCH_SINCE_KEY = 'knowii-community:watch-since'
/** A list older than this is refreshed before it is shown. */
const LIST_MAX_AGE_MS = 30_000
/** After moving around in the pane, give the community time to mark things read. */
const AFTER_NAVIGATION_DELAY_MS = 5_000

/** Settings that change what the pane shows; anything else leaves it alone. */
const PANE_SETTING_KEYS = [
    'communityUrl',
    'showToolbar',
    'rememberLastPage',
    'zoomPercent'
] as const satisfies readonly (keyof PluginSettings)[]

export class KnowiiCommunityPlugin extends Plugin {
    /**
     * The plugin settings are immutable
     */
    override settings: PluginSettings = produce(DEFAULT_SETTINGS, () => DEFAULT_SETTINGS)

    private ribbonIconEl: HTMLElement | null = null

    private statusBar: StatusBarBadge | null = null
    private electronTransport: ElectronSessionTransport | null = null
    private webviewTransport: HiddenWebviewTransport | null = null
    private storedTransport: StoredCookiesTransport | null = null
    private watcher: ActivityWatcher | null = null
    private client: CommunityProvider | null = null
    private realtime: RealtimeLink | null = null
    private reminders: EventReminders | null = null
    private eventsRefreshedAt = 0
    private settingTab: KnowiiCommunitySettingTab | null = null
    /** Spaces listed in the settings; the tab is rebuilt when this changes. */
    private listedSpaceIds = ''
    private inbox: ActivityInbox | null = null
    /** The stored session is put back in the pane's jar at most once per run. */
    private sessionRestoreAttempted = false
    /** This vault's cookie partition; never shared with another vault. */
    private partition = communityPartition('')

    /**
     * Executed as soon as the plugin loads
     */
    override async onload() {
        log('Initializing', 'debug')
        // Must run before anything can call saveData (fresh-install detection)
        registerWhatsNewView(this)
        await this.loadSettings()

        addIcon(KNOWII_ICON_ID, KNOWII_ICON_SVG)
        this.partition = communityPartition(vaultId(this.app))
        this.setupActivity()
        // The stored session signs the pane in before it can show anything.
        await this.restoreSessionAtStartup()
        this.registerView(
            COMMUNITY_VIEW_TYPE,
            (leaf) => new KnowiiCommunityView(leaf, this.viewHost)
        )

        this.registerCommands()
        this.registerMenus()
        this.applyRibbonSetting()

        this.settingTab = new KnowiiCommunitySettingTab(this.app, this)
        this.addSettingTab(this.settingTab)
    }

    override onunload() {}

    /** `data.json` changed on disk (vault sync): pick up a session from another device. */
    override async onExternalSettingsChange(): Promise<void> {
        const previous = this.settings
        await this.loadSettings()
        this.applySettings(previous)
    }

    // -----------------------------------------------------------------------
    // Activity: background checks, alerts, badges
    // -----------------------------------------------------------------------

    private setupActivity(): void {
        const electronSession = findElectronSession(this.partition)
        this.electronTransport = electronSession
            ? new ElectronSessionTransport(electronSession)
            : null
        this.storedTransport = new StoredCookiesTransport(
            () => this.settings.session?.cookies ?? null
        )

        const inbox = new ActivityInbox({
            load: (key) => this.app.loadLocalStorage(key) as unknown,
            save: (key, value) => {
                this.app.saveLocalStorage(key, value)
            }
        })
        this.inbox = inbox

        const client = new CommunityClient({
            baseUrl: () => this.settings.communityUrl,
            watchOptions: () =>
                this.settings.watchWholeCommunity
                    ? {
                          since: this.watchSince(),
                          mutedSpaceIds: new Set(this.settings.mutedSpaceIds)
                      }
                    : null,
            transports: () => this.transports(),
            onSetCookies: (headers) => {
                this.onSetCookies(headers)
            }
        })

        this.client = client
        if (Platform.isDesktopApp) {
            this.realtime = new RealtimeLink({
                baseUrl: () => this.settings.communityUrl,
                partition: this.partition,
                onActivity: () => {
                    this.watcher?.checkSoon(1500)
                },
                onStatus: (status) => {
                    log(`Live updates: ${status}`, 'debug')
                }
            })
        }
        this.reminders = new EventReminders({
            upcomingEvents: () => client.upcomingEvents(),
            remind: (event, path) => {
                this.remindEvent(event, path)
            },
            load: (key) => this.app.loadLocalStorage(key) as unknown,
            save: (key, value) => {
                this.app.saveLocalStorage(key, value)
            }
        })
        this.watcher = new ActivityWatcher(client, {
            decorate: (snapshot) => inbox.merge(snapshot.items, snapshot.unreadRoomUuids),
            intervalMs: () => this.settings.checkIntervalSeconds * 1000,
            loadSeen: () => {
                const value: unknown = this.app.loadLocalStorage(SEEN_KEYS_KEY)
                return Array.isArray(value)
                    ? {
                          keys: value.filter((key): key is string => 'string' === typeof key),
                          initialized: true
                      }
                    : { keys: [], initialized: false }
            },
            saveSeen: (keys) => {
                this.app.saveLocalStorage(SEEN_KEYS_KEY, [...keys])
            },
            onState: (state) => {
                this.renderActivity(state)
                this.refreshSpaceSettings()
                this.followState(state)
            },
            onNewItems: (items, initial) => {
                this.announce(items, initial)
            },
            onSignedOut: () => {
                if (this.settings.notificationsEnabled && this.settings.showNotices) {
                    showPlainNotice(
                        'You were signed out of Knowii. Click to sign in again.',
                        () => {
                            void this.activateView()
                        }
                    )
                }
            },
            afterCheck: (result) => this.keepSession(result)
        })

        if (Platform.isDesktopApp) {
            this.statusBar = new StatusBarBadge(this.addStatusBarItem(), () => {
                void this.showActivityList()
            })
        }

        this.register(() => {
            this.watcher?.stop()
            this.webviewTransport?.dispose()
            this.realtime?.dispose()
            this.reminders?.stop()
        })
        // Catch up as soon as the member comes back or the network returns.
        this.registerDomEvent(window, 'focus', () => {
            if (this.watcher?.isRunning) {
                this.watcher.checkIfStale((this.settings.checkIntervalSeconds * 1000) / 2)
            }
        })
        this.registerDomEvent(window, 'online', () => {
            if (this.watcher?.isRunning) {
                this.watcher.checkSoon()
            }
        })

        this.app.workspace.onLayoutReady(() => {
            this.applyActivitySettings()
        })
    }

    /** Live updates and event reminders follow the sign-in. */
    private followState(state: WatchState): void {
        if ('signed-in' === state.status && state.member && this.client) {
            const endpoint = this.client.realtime(state.member)
            if (this.realtime && endpoint && this.settings.notificationsEnabled) {
                this.realtime.connect(endpoint)
            }
            // Events and RSVPs change slowly: every 30 minutes is plenty.
            if (Date.now() - this.eventsRefreshedAt > 30 * 60 * 1000) {
                this.eventsRefreshedAt = Date.now()
                void this.reminders?.refresh().catch((error: unknown) => {
                    log('Events could not be read', 'warn', error)
                })
            }
        } else if ('signed-out' === state.status) {
            this.realtime?.dispose()
            this.reminders?.stop()
            this.eventsRefreshedAt = 0
        }
    }

    /**
     * Put the stored session in the pane's cookie jar before anything opens,
     * when this device has none: the pane then opens signed in.
     */
    private async restoreSessionAtStartup(): Promise<void> {
        const electron = this.electronTransport
        const stored = this.settings.session
        if (!electron || !stored) {
            return
        }
        try {
            const jar = await electron.readCookies(this.settings.communityUrl)
            if (!hasAuthCookie(jar)) {
                await electron.writeCookies(this.settings.communityUrl, stored.cookies)
                log('Signed the pane in with the stored session', 'debug')
            }
        } catch (error: unknown) {
            log('Could not restore the stored session', 'warn', error)
        }
        this.sessionRestoreAttempted = true
    }

    /** An event the member attends starts in 15 minutes. */
    private remindEvent(event: CommunityEvent, path: string): void {
        if (!this.settings.notificationsEnabled || !this.settings.notifyCategories.events) {
            return
        }
        announceItems(
            [
                {
                    key: `event:${event.id}:${event.startsAt}`,
                    category: 'events',
                    title: event.name,
                    summary: `starts in 15 minutes, at ${new Date(event.startsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
                    excerpt: null,
                    path,
                    occurredAt: event.startsAt,
                    unread: true,
                    notify: true,
                    ref: { kind: 'local' }
                }
            ],
            this.alertOptions()
        )
    }

    // -----------------------------------------------------------------------
    // Save, ask, reply, events
    // -----------------------------------------------------------------------

    /** Whether a community path can be saved as a note (a post or a chat message). */
    canSave(path: string | null): boolean {
        return null !== path && 'other' !== parseCommunityTarget(path).kind
    }

    /** Save a post (with its comments) or a chat message (with its thread) as a note, then open it. */
    async saveAsNote(path: string): Promise<void> {
        const client = this.client
        if (!client) {
            return
        }
        const target = parseCommunityTarget(path)
        if ('other' === target.kind) {
            new Notice('Knowii: only posts and chat messages can be saved as notes.')
            return
        }
        const saving = new Notice('Knowii: saving…', 0)
        try {
            const base = this.settings.communityUrl
            let title: string
            let content: string
            if ('post' === target.kind) {
                const post = await client.fetchPost(target)
                const url = buildCommunityUrl(base, `/c/${target.spaceSlug}/${target.postSlug}`)
                title = post.title
                content = renderPostNote(post, url, Date.now())
            } else {
                const thread = await client.fetchThread(target)
                const url = buildCommunityUrl(base, path)
                title = threadTitle(thread)
                content = renderThreadNote(thread, url, Date.now())
            }
            const { file, created } = await saveNote(
                this.app,
                this.settings.notesFolder,
                title,
                content
            )
            await this.app.workspace.getLeaf('tab').openFile(file)
            new Notice(
                created
                    ? `Knowii: saved as ${file.basename}.`
                    : `Knowii: already saved as ${file.basename}.`
            )
        } catch (error: unknown) {
            new Notice(
                `Knowii: could not save (${error instanceof Error ? error.message : String(error)}).`
            )
        } finally {
            saving.hide()
        }
    }

    /** Ask the community, from a selection or a whole note. */
    async askCommunity(initial: { title: string; body: string }): Promise<void> {
        const client = this.client
        if (!client) {
            return
        }
        if (0 === client.knownSpaces().length) {
            await this.watcher?.check()
        }
        new AskModal(this.app, client.knownSpaces(), initial, async (spaceId, title, body) => {
            const path = await client.createPost(spaceId, title, body)
            new Notice('Knowii: posted.')
            if (Platform.isDesktopApp) {
                void this.activateView(path)
            }
        }).open()
    }

    /** Title and body for "Ask the community" from the active editor. */
    private askFromEditor(view: MarkdownView | null): { title: string; body: string } {
        const selection = view?.editor.getSelection().trim() ?? ''
        const noteTitle = view?.file?.basename ?? ''
        if ('' !== selection) {
            return { title: noteTitle, body: selection }
        }
        const text = view?.editor.getValue() ?? ''
        return { title: noteTitle, body: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() }
    }

    /** Quick reply to a conversation from the list or a notice. */
    openReply(item: ActivityItem): void {
        const client = this.client
        if (!client || 'room' !== item.ref.kind) {
            return
        }
        const uuid = item.ref.uuid
        new ReplyModal(this.app, item.title, item.excerpt, async (text) => {
            await client.sendMessage(uuid, text)
            await this.markItemsRead([item], { quiet: true })
            new Notice(`Knowii: sent to ${item.title}.`)
        }).open()
    }

    /** Upcoming events; Enter opens one. */
    async showEvents(): Promise<void> {
        const reminders = this.reminders
        if (!reminders) {
            return
        }
        const loading = new Notice('Knowii: loading events…', 0)
        try {
            this.eventsRefreshedAt = Date.now()
            await reminders.refresh()
        } catch (error: unknown) {
            new Notice(
                `Knowii: events could not be read (${error instanceof Error ? error.message : String(error)}).`
            )
            return
        } finally {
            loading.hide()
        }
        new EventsModal(this.app, reminders.upcoming, (path) => {
            if (Platform.isDesktopApp) {
                void this.activateView(path)
            } else {
                window.open(buildCommunityUrl(this.settings.communityUrl, path))
            }
        }).open()
    }

    /** Editor and file menus: ask the community. */
    private registerMenus(): void {
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                if ('' === editor.getSelection().trim()) {
                    return
                }
                menu.addItem((item) =>
                    item
                        .setTitle('Ask the Knowii community')
                        .setIcon(KNOWII_ICON_ID)
                        .onClick(() => {
                            void this.askCommunity(
                                this.askFromEditor(view instanceof MarkdownView ? view : null)
                            )
                        })
                )
            })
        )
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile) || 'md' !== file.extension) {
                    return
                }
                menu.addItem((item) =>
                    item
                        .setTitle('Ask the Knowii community about this note')
                        .setIcon(KNOWII_ICON_ID)
                        .onClick(() => {
                            void this.app.vault.cachedRead(file).then((text) =>
                                this.askCommunity({
                                    title: file.basename,
                                    body: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
                                })
                            )
                        })
                )
            })
        )
    }

    /**
     * Ways to reach the community on this device, best first. The pane's own
     * cookie jar through Electron when available; a hidden webview on the same
     * partition otherwise; the session stored in the settings everywhere
     * (the only way on mobile).
     */
    private transports(): CommunityTransport[] {
        const list: CommunityTransport[] = []
        if (this.electronTransport) {
            list.push(this.electronTransport)
        } else if (Platform.isDesktopApp) {
            this.webviewTransport ??= new HiddenWebviewTransport(this.partition)
            list.push(this.webviewTransport)
        }
        if (this.storedTransport) {
            list.push(this.storedTransport)
        }
        return list
    }

    /** Start or stop the background checks and redraw the badges. */
    private applyActivitySettings(): void {
        const watcher = this.watcher
        if (!watcher) {
            return
        }
        if (this.settings.notificationsEnabled) {
            // A fresh start keeps its short first delay; only a running
            // watcher needs re-arming (the interval may have changed).
            if (!watcher.start()) {
                watcher.reschedule()
            }
        } else {
            watcher.stop()
        }
        this.renderActivity(watcher.current)
    }

    private renderActivity(state: WatchState): void {
        const enabled = this.settings.notificationsEnabled
        this.statusBar?.render(state, enabled && this.settings.showStatusBarBadge)
        renderRibbonBadge(this.ribbonIconEl, state, enabled && this.settings.showRibbonBadge)
        const unread = 'signed-in' === state.status ? totalUnread(state.counts) : 0
        const isAdmin = true === state.member?.isAdmin
        for (const leaf of this.app.workspace.getLeavesOfType(COMMUNITY_VIEW_TYPE)) {
            if (leaf.view instanceof KnowiiCommunityView) {
                leaf.view.updateActivity(unread, isAdmin)
            }
        }
    }

    /** Check right away and say what was found. */
    private async checkNow(): Promise<void> {
        const state = await this.watcher?.check()
        if (!state) {
            return
        }
        if ('signed-in' === state.status) {
            const { notifications, messages, threads } = state.counts
            new Notice(
                `Knowii: ${notifications} unread notifications, ${messages} unread conversations, ${threads} unread threads.`
            )
        } else if ('signed-out' === state.status) {
            new Notice('Knowii: you are not signed in.')
        } else {
            new Notice(`Knowii cannot be reached right now (${state.error ?? 'unknown error'}).`)
        }
    }

    /** Right-click on the ribbon icon: unread items, show all, check now, admin pages. */
    private showRibbonMenu(event: MouseEvent): void {
        event.preventDefault()
        const menu = new Menu()
        fillActivityMenu(menu, this.watcher?.current ?? INITIAL_WATCH_STATE, ADMIN_DESTINATIONS, {
            openItem: (item) => {
                this.openItem(item)
            },
            showAll: () => {
                void this.showActivityList()
            },
            checkNow: () => {
                void this.checkNow()
            },
            openPath: (path) => {
                void this.activateView(path)
            },
            markAllRead: () => {
                void this.markAllRead()
            },
            archiveRead: () => {
                void this.archiveRead()
            },
            showEvents: () => {
                void this.showEvents()
            }
        })
        menu.showAtMouseEvent(event)
    }

    private alertOptions(): AlertOptions {
        return {
            notices: this.settings.showNotices,
            desktop: this.settings.desktopNotifications,
            open: (item) => {
                this.openItem(item)
            },
            openList: () => {
                void this.showActivityList()
            },
            reply: (item) => {
                this.openReply(item)
            },
            canReply: (item) => 'room' === item.ref.kind && 'directMessages' === item.category
        }
    }

    private announce(items: readonly ActivityItem[], initial: boolean): void {
        if (!this.settings.notificationsEnabled) {
            return
        }
        const wanted = items.filter((item) => this.settings.notifyCategories[item.category])
        if (initial) {
            announceBacklog(wanted.length, this.alertOptions())
        } else {
            announceItems(wanted, this.alertOptions())
        }
    }

    /** Open an item: in the pane on desktop, in the browser on mobile. */
    private openItem(item: ActivityItem): void {
        // Opening is reading, as in a mail client.
        if (item.unread) {
            void this.markItemsRead([item], { quiet: true })
        }
        if (Platform.isDesktopApp) {
            void this.activateView(item.path)
            return
        }
        window.open(buildCommunityUrl(this.settings.communityUrl, item.path))
    }

    /** The "what's new" list: refreshed when stale, then shown. */
    async showActivityList(): Promise<void> {
        const watcher = this.watcher
        if (!watcher) {
            return
        }
        let state = watcher.current
        const fresh =
            'signed-in' === state.status &&
            null !== state.checkedAt &&
            Date.now() - state.checkedAt < LIST_MAX_AGE_MS
        if (!fresh) {
            const checking = new Notice('Checking Knowii…', 0)
            try {
                state = await watcher.check()
            } finally {
                checking.hide()
            }
        }
        switch (state.status) {
            case 'signed-in':
                if (0 === state.items.length) {
                    new Notice("You're all caught up in Knowii.")
                    return
                }
                new ActivityModal(this.app, this.listController()).open()
                return
            case 'signed-out':
                if (Platform.isDesktopApp) {
                    new Notice('Sign in to Knowii to see what is new.')
                    void this.activateView()
                } else {
                    new Notice(
                        'Sign in to Knowii in the Obsidian desktop app once: the session then reaches this device with your vault.'
                    )
                }
                return
            case 'error':
            case 'starting':
                new Notice(
                    `Knowii cannot be reached right now (${state.error ?? 'unknown error'}).`
                )
                return
        }
    }

    /**
     * Keeps the stored session in step with the pane's cookie jar (desktop),
     * and puts it back in the jar when this device has none.
     */
    private async keepSession(result: ActivityResult): Promise<void> {
        const electron = this.electronTransport
        const transport =
            'signed-in' === result.status ? result.snapshot.transport : result.transport
        if (!electron || 'electron-session' !== transport) {
            return
        }
        const base = this.settings.communityUrl
        if ('signed-in' === result.status) {
            const cookies = await electron.readCookies(base)
            if (!hasAuthCookie(cookies)) {
                return
            }
            const stored = this.settings.session
            if (!stored || authFingerprint(stored.cookies) !== authFingerprint(cookies)) {
                await this.saveSession({ cookies, savedAt: new Date().toISOString() })
            }
            return
        }
        // Signed out in the pane.
        const stored = this.settings.session
        if (!stored) {
            return
        }
        // Signed in earlier in this run, signed out now: the member signed
        // out (or the session ended). Never sign them back in behind their back.
        if ('signed-in' === this.watcher?.current.status) {
            this.sessionRestoreAttempted = true
            await this.saveSession(null)
            return
        }
        if (!this.sessionRestoreAttempted) {
            this.sessionRestoreAttempted = true
            await electron.writeCookies(base, stored.cookies)
            this.watcher?.checkSoon()
            return
        }
        // The stored session did not work either: it is dead, forget it.
        await this.saveSession(null)
    }

    /** Cookie updates from the community on the stored-session transport. */
    private onSetCookies(headers: readonly string[]): void {
        const stored = this.settings.session
        if (!stored) {
            return
        }
        const host = new URL(this.settings.communityUrl).host
        const cookies = applySetCookies(stored.cookies, headers, host)
        if (authFingerprint(cookies) === authFingerprint(stored.cookies)) {
            return
        }
        void this.saveSession(
            hasAuthCookie(cookies) ? { cookies, savedAt: new Date().toISOString() } : null
        )
    }

    /** Stores (or forgets) the session without touching anything on screen. */
    saveSession(session: StoredSession | null): Promise<void> {
        return this.updateSettings(
            (draft) => {
                draft.session = castDraft(session)
            },
            { apply: false }
        )
    }

    /** Forget the stored session (settings button). The pane's own sign-in is untouched. */
    async forgetStoredSession(): Promise<void> {
        await this.saveSession(null)
        new Notice('The stored Knowii session was removed from the plugin settings.')
    }

    // -----------------------------------------------------------------------
    // Read and archive
    // -----------------------------------------------------------------------

    /** When watching the whole community started on this device. */
    private watchSince(): number {
        const stored: unknown = this.app.loadLocalStorage(WATCH_SINCE_KEY)
        if ('number' === typeof stored && Number.isFinite(stored)) {
            return stored
        }
        return this.restartWatch()
    }

    /** Start watching from now (turning the watch on again never replays the past). */
    restartWatch(): number {
        const now = Date.now()
        this.app.saveLocalStorage(WATCH_SINCE_KEY, now)
        return now
    }

    /** The per-space switches follow the spaces the last check found. */
    private refreshSpaceSettings(): void {
        const ids = this.knownSpaces()
            .map((space) => space.id)
            .join(',')
        if (ids !== this.listedSpaceIds) {
            this.listedSpaceIds = ids
            this.settingTab?.update()
        }
    }

    /** Spaces known from the last check, for the per-space switches. */
    knownSpaces(): readonly WatchableSpace[] {
        return this.client?.knownSpaces() ?? []
    }

    private listController(): ActivityListController {
        return {
            items: () => this.watcher?.current.items ?? [],
            open: (item) => {
                this.openItem(item)
            },
            markRead: (item) => this.markItemsRead([item]),
            archive: (item) => this.archiveItems([item]),
            markAllRead: () => this.markAllRead(),
            archiveRead: () => this.archiveRead(),
            canSave: (item) => this.canSave(item.path),
            save: (item) => this.saveAsNote(item.path),
            canReply: (item) => 'room' === item.ref.kind && 'directMessages' === item.category,
            reply: (item) => {
                this.openReply(item)
            }
        }
    }

    /** Items sharing an item's conversation: reading one reads the room. */
    private withSameRoom(items: readonly ActivityItem[]): ActivityItem[] {
        const rooms = new Set(
            items.flatMap((item) => ('room' === item.ref.kind ? [item.ref.uuid] : []))
        )
        const all = this.watcher?.current.items ?? []
        const related = all.filter((item) => 'room' === item.ref.kind && rooms.has(item.ref.uuid))
        return [...new Map([...items, ...related].map((item) => [item.key, item])).values()]
    }

    /** Distinct community-side targets of some items (a room once, not per message). */
    private refsOf(items: readonly ActivityItem[]): ActivityItem['ref'][] {
        const refs = new Map<string, ActivityItem['ref']>()
        for (const item of items) {
            const ref = item.ref
            const id =
                'room' === ref.kind
                    ? `room:${ref.uuid}`
                    : 'local' === ref.kind
                      ? null
                      : `${ref.kind}:${ref.id}`
            if (id) {
                refs.set(id, ref)
            }
        }
        return [...refs.values()]
    }

    async markItemsRead(
        items: readonly ActivityItem[],
        options: { quiet?: boolean } = {}
    ): Promise<void> {
        const client = this.client
        const inbox = this.inbox
        if (!client || !inbox) {
            return
        }
        const targets = this.withSameRoom(items)
        const drop = this.unreadCountsOf(targets)
        const failures = await this.forEachRef(this.refsOf(targets), (ref) => client.markRead(ref))
        inbox.markRead(targets.map((item) => item.key))
        this.watcher?.adjustCounts(drop)
        this.afterInboxChange()
        if (failures > 0 && !options.quiet) {
            new Notice(
                'Knowii: marked as read here, but the community could not be updated. It will catch up on the next check.'
            )
        }
    }

    async archiveItems(items: readonly ActivityItem[]): Promise<void> {
        const client = this.client
        const inbox = this.inbox
        if (!client || !inbox) {
            return
        }
        const targets = this.withSameRoom(items)
        const drop = this.unreadCountsOf(targets)
        const failures = await this.forEachRef(this.refsOf(targets), (ref) => client.archive(ref))
        inbox.archive(targets.map((item) => item.key))
        this.watcher?.adjustCounts(drop)
        this.afterInboxChange()
        if (failures > 0) {
            new Notice('Knowii: archived here, but the community could not be updated.')
        }
    }

    /** Everything read, here and on the community (asks first). */
    async markAllRead(): Promise<void> {
        const client = this.client
        const inbox = this.inbox
        if (!client || !inbox) {
            return
        }
        const confirmed = await confirmAction(this.app, {
            title: 'Mark everything as read?',
            text: 'All your Knowii notifications, conversations and threads will be marked as read, on Knowii too.',
            confirm: 'Mark all as read'
        })
        if (!confirmed) {
            return
        }
        try {
            await client.markAllRead()
        } catch (error: unknown) {
            new Notice(
                `Knowii: the community could not be updated (${error instanceof Error ? error.message : String(error)}).`
            )
        }
        inbox.markRead((this.watcher?.current.items ?? []).map((item) => item.key))
        this.watcher?.adjustCounts(this.watcher.current.counts)
        this.afterInboxChange()
    }

    /** Hides everything already read from the list; read notifications are archived on the community. */
    async archiveRead(): Promise<void> {
        const read = (this.watcher?.current.items ?? []).filter((item) => !item.unread)
        if (0 === read.length) {
            new Notice('Knowii: nothing read to archive.')
            return
        }
        await this.archiveItems(read)
    }

    /**
     * How much the unread counts drop when these items are read: one per
     * unread notification, conversation (once per room) and thread. Local
     * items are not counted by the community, so they change nothing.
     */
    private unreadCountsOf(items: readonly ActivityItem[]): {
        notifications: number
        messages: number
        threads: number
    } {
        const unread = items.filter((item) => item.unread)
        const rooms = new Set(
            unread.flatMap((item) => ('room' === item.ref.kind ? [item.ref.uuid] : []))
        )
        return {
            notifications: unread.filter((item) => 'notification' === item.ref.kind).length,
            messages: rooms.size,
            threads: unread.filter((item) => 'thread' === item.ref.kind).length
        }
    }

    /** Runs a community write per target, one at a time; returns how many failed. */
    private async forEachRef(
        refs: readonly ActivityItem['ref'][],
        write: (ref: ActivityItem['ref']) => Promise<void>
    ): Promise<number> {
        let failures = 0
        for (const ref of refs) {
            try {
                await write(ref)
            } catch {
                failures += 1
            }
        }
        return failures
    }

    /** Local state changed: redraw now, confirm with the community shortly. */
    private afterInboxChange(): void {
        this.watcher?.refreshView()
        this.watcher?.checkSoon()
    }

    /** Latest known state, for the settings tab. */
    get activityState(): WatchState | null {
        return this.watcher?.current ?? null
    }

    /** What the pane may ask of the plugin (see `CommunityViewHost`). */
    private readonly viewHost: CommunityViewHost = {
        getSettings: () => this.settings,
        partition: () => this.partition,
        loadLastUrl: () => {
            const value: unknown = this.app.loadLocalStorage(LAST_URL_KEY)
            return 'string' === typeof value ? value : null
        },
        saveLastUrl: (url) => {
            this.app.saveLocalStorage(LAST_URL_KEY, url)
        },
        hasSeenWelcome: () => true === this.app.loadLocalStorage(WELCOME_SEEN_KEY),
        markWelcomeSeen: () => {
            this.app.saveLocalStorage(WELCOME_SEEN_KEY, true)
        },
        openExternal: (url) => {
            window.open(url)
        },
        onNavigated: () => {
            // With background checks off, still learn the role and counts once.
            if (this.watcher?.isRunning || 'starting' === this.watcher?.current.status) {
                this.watcher.checkSoon(AFTER_NAVIGATION_DELAY_MS)
            }
        },
        isAdmin: () => true === this.watcher?.current.member?.isAdmin,
        unreadCount: () => {
            const state = this.watcher?.current
            return state && 'signed-in' === state.status ? totalUnread(state.counts) : 0
        },
        showActivity: () => {
            void this.showActivityList()
        },
        canSave: (url) => this.canSave(url),
        saveAsNote: (url) => {
            void this.saveAsNote(url)
        }
    }

    private registerCommands(): void {
        this.addCommand({
            id: 'open',
            name: 'Open Knowii',
            callback: () => {
                void this.activateView()
            }
        })

        for (const destination of COMMUNITY_DESTINATIONS) {
            this.addCommand({
                id: `open-${destination.id}`,
                name: `Open Knowii: ${destination.label.toLowerCase()}`,
                callback: () => {
                    void this.activateView(destination.path)
                }
            })
        }

        this.addCommand({
            id: 'show-activity',
            name: "Show what's new in Knowii",
            callback: () => {
                void this.showActivityList()
            }
        })

        this.addCommand({
            id: 'save-current-page',
            name: 'Save the current Knowii page as a note',
            checkCallback: (checking) => {
                const url = this.openView()?.currentUrl() ?? null
                if (!this.canSave(url)) {
                    return false
                }
                if (!checking && url) {
                    void this.saveAsNote(url)
                }
                return true
            }
        })

        this.addCommand({
            id: 'ask-community',
            name: 'Ask the community',
            callback: () => {
                void this.askCommunity(
                    this.askFromEditor(this.app.workspace.getActiveViewOfType(MarkdownView))
                )
            }
        })

        this.addCommand({
            id: 'show-events',
            name: 'Show upcoming Knowii events',
            callback: () => {
                void this.showEvents()
            }
        })

        this.addCommand({
            id: 'check-activity',
            name: 'Check Knowii for new activity now',
            callback: () => {
                void this.checkNow()
            }
        })

        this.addCommand({
            id: 'mark-all-read',
            name: 'Mark everything in Knowii as read',
            callback: () => {
                void this.markAllRead()
            }
        })

        this.addCommand({
            id: 'archive-read',
            name: 'Archive what is read in Knowii',
            callback: () => {
                void this.archiveRead()
            }
        })

        // Admin pages: available once a check has confirmed the admin role.
        for (const destination of ADMIN_DESTINATIONS) {
            this.addCommand({
                id: `open-${destination.id}`,
                name: `Open Knowii admin: ${destination.label.toLowerCase()}`,
                checkCallback: (checking) => {
                    if (true !== this.watcher?.current.member?.isAdmin) {
                        return false
                    }
                    if (!checking) {
                        void this.activateView(destination.path)
                    }
                    return true
                }
            })
        }

        this.addCommand({
            id: 'reload',
            name: 'Reload the Knowii pane',
            checkCallback: (checking) => {
                const view = this.openView()
                if (!view) {
                    return false
                }
                if (!checking) {
                    view.reload()
                }
                return true
            }
        })

        this.addCommand({
            id: 'open-in-browser',
            name: 'Open Knowii in your browser',
            callback: () => {
                const view = this.openView()
                if (view) {
                    view.openInBrowser()
                    return
                }
                window.open(buildCommunityUrl(this.settings.communityUrl, '/'))
            }
        })
    }

    /** The community pane, when one is open. */
    private openView(): KnowiiCommunityView | null {
        for (const leaf of this.app.workspace.getLeavesOfType(COMMUNITY_VIEW_TYPE)) {
            if (leaf.view instanceof KnowiiCommunityView) {
                return leaf.view
            }
        }
        return null
    }

    /** Reveal the pane (opening it where the settings say), then navigate. */
    async activateView(path?: string): Promise<void> {
        const { workspace } = this.app
        let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COMMUNITY_VIEW_TYPE)[0] ?? null
        if (!leaf) {
            leaf = this.newLeaf()
            if (!leaf) {
                return
            }
            await leaf.setViewState({ type: COMMUNITY_VIEW_TYPE, active: true })
        }
        await workspace.revealLeaf(leaf)
        if (undefined !== path && leaf.view instanceof KnowiiCommunityView) {
            leaf.view.navigateTo(path)
        }
    }

    private newLeaf(): WorkspaceLeaf | null {
        const { workspace } = this.app
        switch (this.settings.paneLocation) {
            case 'right':
                return workspace.getRightLeaf(false)
            case 'left':
                return workspace.getLeftLeaf(false)
            case 'tab':
            default:
                return workspace.getLeaf('tab')
        }
    }

    private applyRibbonSetting(): void {
        if (this.settings.showRibbonIcon && !this.ribbonIconEl) {
            this.ribbonIconEl = this.addRibbonIcon(KNOWII_ICON_ID, 'Open Knowii', () => {
                void this.activateView()
            })
            // The element goes away with the icon, and its listener with it.
            this.ribbonIconEl.addEventListener('contextmenu', (event) => {
                this.showRibbonMenu(event)
            })
            if (this.watcher) {
                this.renderActivity(this.watcher.current)
            }
        } else if (!this.settings.showRibbonIcon && this.ribbonIconEl) {
            this.ribbonIconEl.remove()
            this.ribbonIconEl = null
        }
    }

    /**
     * Push a settings change to everything already on screen. The pane is
     * only re-rendered when a pane setting changed: re-rendering reloads the
     * community.
     */
    private applySettings(previous: PluginSettings): void {
        this.applyRibbonSetting()
        this.applyActivitySettings()
        if (previous.communityUrl !== this.settings.communityUrl) {
            this.watcher?.checkSoon()
        }
        const paneChanged = PANE_SETTING_KEYS.some((key) => previous[key] !== this.settings[key])
        if (!paneChanged) {
            return
        }
        for (const leaf of this.app.workspace.getLeavesOfType(COMMUNITY_VIEW_TYPE)) {
            if (leaf.view instanceof KnowiiCommunityView) {
                leaf.view.refresh()
            }
        }
    }

    /**
     * Load the plugin settings
     */
    async loadSettings() {
        log('Loading settings', 'debug')
        const loaded: unknown = await this.loadData()

        if (!loaded || 'object' !== typeof loaded) {
            log('Using default settings', 'debug')
            this.settings = produce(DEFAULT_SETTINGS, () => DEFAULT_SETTINGS)
            return
        }
        const data = loaded as Partial<Record<keyof PluginSettings, unknown>>

        let needToSaveSettings = false

        this.settings = produce(DEFAULT_SETTINGS, (draft: Draft<PluginSettings>) => {
            // Strict checks: loadData can return anything (older versions,
            // hand-edited data.json). Anything off-type falls back to the
            // default and is written back.
            const url =
                'string' === typeof data.communityUrl
                    ? normalizeCommunityUrl(data.communityUrl)
                    : null
            if (url) {
                draft.communityUrl = url
            } else {
                needToSaveSettings = true
            }
            if (isPaneLocation(data.paneLocation)) {
                draft.paneLocation = data.paneLocation
            } else {
                needToSaveSettings = true
            }
            if ('boolean' === typeof data.showRibbonIcon) {
                draft.showRibbonIcon = data.showRibbonIcon
            } else {
                needToSaveSettings = true
            }
            if ('boolean' === typeof data.showToolbar) {
                draft.showToolbar = data.showToolbar
            } else {
                needToSaveSettings = true
            }
            if ('boolean' === typeof data.rememberLastPage) {
                draft.rememberLastPage = data.rememberLastPage
            } else {
                needToSaveSettings = true
            }
            if (isValidZoomPercent(data.zoomPercent)) {
                draft.zoomPercent = data.zoomPercent
            } else {
                needToSaveSettings = true
            }
            for (const key of [
                'notificationsEnabled',
                'showNotices',
                'showStatusBarBadge',
                'showRibbonBadge'
            ] as const) {
                const value = data[key]
                if ('boolean' === typeof value) {
                    draft[key] = value
                } else {
                    needToSaveSettings = true
                }
            }
            const desktop = readDesktopNotificationMode(
                data as { desktopNotifications?: unknown; showDesktopNotifications?: unknown }
            )
            draft.desktopNotifications = desktop.mode
            if (desktop.migrated) {
                needToSaveSettings = true
            }
            if (isCheckInterval(data.checkIntervalSeconds)) {
                draft.checkIntervalSeconds = data.checkIntervalSeconds
            } else {
                needToSaveSettings = true
            }
            const categories = parseNotifyCategories(data.notifyCategories)
            draft.notifyCategories = categories.categories
            if (!categories.complete) {
                needToSaveSettings = true
            }
            if ('boolean' === typeof data.watchWholeCommunity) {
                draft.watchWholeCommunity = data.watchWholeCommunity
            } else {
                needToSaveSettings = true
            }
            if ('string' === typeof data.notesFolder && '' !== data.notesFolder.trim()) {
                draft.notesFolder = data.notesFolder.trim()
            } else {
                needToSaveSettings = true
            }
            const muted = parseSpaceIds(data.mutedSpaceIds)
            if (muted) {
                draft.mutedSpaceIds = muted
            } else {
                needToSaveSettings = true
            }
            // No session on disk is normal (signed out); only a broken one is rewritten.
            const session = parseStoredSession(data.session)
            draft.session = castDraft(session)
            if (null === session && null !== data.session && undefined !== data.session) {
                needToSaveSettings = true
            }
        })

        log(`Settings loaded`, 'debug', this.settings)

        if (needToSaveSettings) {
            void this.saveSettings()
        }
    }

    /** Serializes settings writes; see updateSettings. */
    private settingsWriteChain: Promise<void> = Promise.resolve()

    /**
     * Apply a mutation to the settings (via immer) and persist the result.
     * The single write path — the declarative settings tab routes every
     * control edit through here so persistence happens in exactly one place.
     */
    updateSettings(
        mutator: (draft: Draft<PluginSettings>) => void,
        options: { apply?: boolean } = {}
    ): Promise<void> {
        // Persist-then-commit: swap memory only after saveData() succeeds, so
        // a rejected write rolls the control back to the on-disk truth.
        // Chained so overlapping edits derive from the previous committed state.
        const write = this.settingsWriteChain.then(async () => {
            const previous = this.settings
            const next = produce(this.settings, mutator)
            await this.saveData(next)
            this.settings = next
            if (false !== options.apply) {
                this.applySettings(previous)
            }
        })
        this.settingsWriteChain = write.catch(() => undefined)
        return write
    }

    /**
     * Save the plugin settings
     */
    async saveSettings() {
        log('Saving settings', 'debug')
        await this.saveData(this.settings)
        log('Settings saved', 'debug', this.settings)
    }
}
