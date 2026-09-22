import { Plugin, addIcon } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import { DEFAULT_SETTINGS, isPaneLocation, isValidZoomPercent } from './types/plugin-settings.intf'
import type { PluginSettings } from './types/plugin-settings.intf'
import { KnowiiCommunitySettingTab } from './settings/settings-tab'
import { log } from '../utils/log'
import { registerWhatsNewView } from './whats-new'
import { produce } from 'immer'
import type { Draft } from 'immer'
import { KNOWII_ICON_ID, KNOWII_ICON_SVG } from './assets/knowii-icon'
import { COMMUNITY_VIEW_TYPE, KnowiiCommunityView } from './ui/community-view'
import type { CommunityViewHost } from './ui/community-view'
import {
    COMMUNITY_DESTINATIONS,
    buildCommunityUrl,
    normalizeCommunityUrl
} from './domain/community-links'

const LAST_URL_KEY = 'knowii-community:last-url'
const WELCOME_SEEN_KEY = 'knowii-community:welcome-seen'

export class KnowiiCommunityPlugin extends Plugin {
    /**
     * The plugin settings are immutable
     */
    override settings: PluginSettings = produce(DEFAULT_SETTINGS, () => DEFAULT_SETTINGS)

    private ribbonIconEl: HTMLElement | null = null

    /**
     * Executed as soon as the plugin loads
     */
    override async onload() {
        log('Initializing', 'debug')
        // Must run before anything can call saveData (fresh-install detection)
        registerWhatsNewView(this)
        await this.loadSettings()

        addIcon(KNOWII_ICON_ID, KNOWII_ICON_SVG)
        this.registerView(
            COMMUNITY_VIEW_TYPE,
            (leaf) => new KnowiiCommunityView(leaf, this.viewHost)
        )

        this.registerCommands()
        this.applyRibbonSetting()

        this.addSettingTab(new KnowiiCommunitySettingTab(this.app, this))
    }

    override onunload() {}

    /** What the pane may ask of the plugin (see `CommunityViewHost`). */
    private readonly viewHost: CommunityViewHost = {
        getSettings: () => this.settings,
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
        } else if (!this.settings.showRibbonIcon && this.ribbonIconEl) {
            this.ribbonIconEl.remove()
            this.ribbonIconEl = null
        }
    }

    /** Push a settings change to everything already on screen. */
    private applySettings(): void {
        this.applyRibbonSetting()
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
    updateSettings(mutator: (draft: Draft<PluginSettings>) => void): Promise<void> {
        // Persist-then-commit: swap memory only after saveData() succeeds, so
        // a rejected write rolls the control back to the on-disk truth.
        // Chained so overlapping edits derive from the previous committed state.
        const write = this.settingsWriteChain.then(async () => {
            const next = produce(this.settings, mutator)
            await this.saveData(next)
            this.settings = next
            this.applySettings()
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
