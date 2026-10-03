import { Notice, Platform, PluginSettingTab } from 'obsidian'
import type { App, SettingDefinitionItem, SettingGroupItem } from 'obsidian'
import type KnowiiCommunityPlugin from '../../main'
import { BUY_ME_A_COFFEE_BADGE_DATA_URL } from '../assets/buy-me-a-coffee'
import { BUY_ME_A_COFFEE_URL, renderSupportSection } from '../ui/support-links'
import { confirmAction } from '../ui/confirm-modal'
import { normalizeCommunityUrl } from '../domain/community-links'
import {
    CHECK_INTERVALS_SECONDS,
    MAX_ZOOM_PERCENT,
    MIN_ZOOM_PERCENT,
    ZOOM_STEP_PERCENT,
    isActivityCategory,
    isCheckInterval,
    isDesktopNotificationMode,
    isPaneLocation,
    isValidZoomPercent
} from '../types/plugin-settings.intf'
import { ACTIVITY_CATEGORIES } from '../domain/community-activity'
import { LEGACY_SESSION_GRACE_DAYS } from '../domain/session-secret'

/** Prefix of the per-category control keys (`notify:directMessages`, …). */
const NOTIFY_KEY_PREFIX = 'notify:'
/** Prefix of the per-space watch control keys (`space:2013797`). */
const SPACE_KEY_PREFIX = 'space:'

/** Human label for a space kind. */
function spaceKindLabel(kind: string): string {
    switch (kind) {
        case 'chat':
            return 'Chat space: new messages'
        case 'basic':
            return 'Posts space: new posts and comments'
        case 'event':
            return 'Events space: new events and comments'
        case 'course':
            return 'Course space'
        default:
            return 'Space'
    }
}

/** Human label for a check interval. */
export function intervalLabel(seconds: number): string {
    if (seconds < 60) {
        return `Every ${seconds} seconds`
    }
    const minutes = seconds / 60
    return 1 === minutes ? 'Every minute' : `Every ${minutes} minutes`
}

/** Boolean settings that are plain toggles. */
const TOGGLE_KEYS = [
    'showToolbar',
    'rememberLastPage',
    'showRibbonIcon',
    'notificationsEnabled',
    'showNotices',
    'showStatusBarBadge',
    'showRibbonBadge',
    'watchWholeCommunity'
] as const

type ToggleKey = (typeof TOGGLE_KEYS)[number]

function isToggleKey(key: string): key is ToggleKey {
    return (TOGGLE_KEYS as readonly string[]).includes(key)
}

/**
 * Settings tab, declared rather than rendered (Obsidian 1.13+).
 *
 * `getSettingDefinitions()` REPLACES `display()`: when it returns a non-empty
 * array, `display()` is never called. There is no partial adoption — the whole
 * settings UI is declarative, or none of it. In exchange, Obsidian owns
 * navigation, focus and ARIA, and every declared `name`/`desc` is indexed by
 * the settings search.
 *
 * Rules that each cost a shipped bug the first time they were broken
 * (see AGENTS.md "Declarative settings" for the full list):
 *
 * - A `render:` hook renders the ROW. Write into `setting.settingEl` only;
 *   anything written outside it (e.g. `group.listEl`) is the framework's to
 *   discard, and the control simply does not appear.
 * - `update()` re-runs a render hook on the SAME row and resets only its
 *   name, description and control area. A hook that appends anywhere else in
 *   the row must return a cleanup that removes what it added, or every
 *   refresh stacks a copy.
 * - Obsidian builds the definitions only in `update()` and reuses them on
 *   every opening. Anything read from outside the settings (another plugin's
 *   state) belongs in a render hook, which each opening re-runs.
 * - `defaultValue` is the fallback for a RESOLVER returning undefined/null,
 *   NOT for a cleared input. Do not declare it on numeric controls; let a
 *   `validate` bounds-check refuse the cleared value inline.
 * - A row `action:` fires on the whole row, not on a button. Destructive
 *   actions need their own confirmation modal.
 * - `setControlValue` MUST reject on failure. Resolving tells the framework
 *   the write landed, so the pane keeps showing a value that was never stored.
 */
export class KnowiiCommunitySettingTab extends PluginSettingTab {
    plugin: KnowiiCommunityPlugin

    constructor(app: App, plugin: KnowiiCommunityPlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    override getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                type: 'group',
                heading: 'Pane',
                items: [
                    {
                        name: 'Open the pane in',
                        desc: 'Where "Open Knowii" shows the community. A main tab gives the community the most room.',
                        control: {
                            type: 'dropdown',
                            key: 'paneLocation',
                            options: {
                                tab: 'A main tab',
                                right: 'The right sidebar',
                                left: 'The left sidebar'
                            }
                        }
                    },
                    {
                        name: 'Show the toolbar',
                        desc: 'Back, forward, reload, shortcuts to the feed, messages, notifications and events, and "Open in browser".',
                        // The mobile pane is an inbox: no toolbar, page or zoom there.
                        visible: () => Platform.isDesktopApp,
                        control: { type: 'toggle', key: 'showToolbar' }
                    },
                    {
                        name: 'Reopen the last page',
                        desc: 'Come back to the page you were on, instead of the community home, when the pane opens.',
                        visible: () => Platform.isDesktopApp,
                        control: { type: 'toggle', key: 'rememberLastPage' }
                    },
                    {
                        name: 'Zoom',
                        desc: 'Size of the community inside the pane. Handy in a narrow sidebar.',
                        visible: () => Platform.isDesktopApp,
                        control: {
                            type: 'slider',
                            key: 'zoomPercent',
                            min: MIN_ZOOM_PERCENT,
                            max: MAX_ZOOM_PERCENT,
                            step: ZOOM_STEP_PERCENT,
                            displayFormat: (value) => `${value}%`
                        }
                    },
                    {
                        name: 'Ribbon icon',
                        desc: 'Show the Knowii icon in the ribbon.',
                        control: { type: 'toggle', key: 'showRibbonIcon' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Notifications',
                items: [
                    {
                        name: 'Watch the community',
                        desc: 'Check Knowii in the background and tell you about new messages, replies, mentions, posts and more. Needs you to be signed in once in the pane.',
                        control: { type: 'toggle', key: 'notificationsEnabled' }
                    },
                    {
                        name: 'Check every',
                        desc: 'How often to look for new activity. Obsidian also checks when you come back to it and after you browse the pane.',
                        visible: () => this.plugin.settings.notificationsEnabled,
                        control: {
                            type: 'dropdown',
                            key: 'checkIntervalSeconds',
                            options: Object.fromEntries(
                                CHECK_INTERVALS_SECONDS.map((seconds) => [
                                    String(seconds),
                                    intervalLabel(seconds)
                                ])
                            )
                        }
                    },
                    {
                        name: 'Show notices',
                        desc: 'Pop up a notice in Obsidian for new activity. Click it to open the item.',
                        visible: () => this.plugin.settings.notificationsEnabled,
                        control: { type: 'toggle', key: 'showNotices' }
                    },
                    {
                        name: 'System notifications',
                        desc: "Also use your computer's notifications for new activity. Click one to open the item in Obsidian.",
                        visible: () =>
                            Platform.isDesktopApp && this.plugin.settings.notificationsEnabled,
                        control: {
                            type: 'dropdown',
                            key: 'desktopNotifications',
                            options: {
                                always: 'Always',
                                background: 'Only when Obsidian is in the background',
                                off: 'Never'
                            }
                        }
                    },
                    {
                        name: 'Unread counts in the status bar',
                        desc: 'Unread notifications and messages at the bottom of the window. Click to see what is new.',
                        // The mobile apps have no status bar.
                        visible: () =>
                            Platform.isDesktopApp && this.plugin.settings.notificationsEnabled,
                        control: { type: 'toggle', key: 'showStatusBarBadge' }
                    },
                    {
                        name: 'Unread badge on the ribbon icon',
                        desc: 'Total unread count on the Knowii ribbon icon.',
                        visible: () => this.plugin.settings.notificationsEnabled,
                        control: { type: 'toggle', key: 'showRibbonBadge' }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Notify me about',
                visible: () => this.plugin.settings.notificationsEnabled,
                items: ACTIVITY_CATEGORIES.map((info) => ({
                    name: info.label,
                    desc: info.description,
                    control: { type: 'toggle' as const, key: `${NOTIFY_KEY_PREFIX}${info.id}` }
                }))
            },
            {
                type: 'group',
                heading: 'Watch the whole community',
                visible: () => this.plugin.settings.notificationsEnabled,
                items: [
                    {
                        name: 'Everything that happens',
                        desc: 'Also tell you about new posts, comments and chat messages in every space, not only what Knowii notifies you about. Your own posts and messages are left out.',
                        control: { type: 'toggle', key: 'watchWholeCommunity' }
                    },
                    ...this.spaceItems()
                ]
            },
            {
                type: 'group',
                heading: 'Saving to your vault',
                items: [
                    {
                        name: 'Folder for saved posts',
                        desc: 'Posts and chat threads you save as notes go to this folder.',
                        control: {
                            type: 'text',
                            key: 'notesFolder',
                            placeholder: 'Knowii',
                            validate: (value) =>
                                '' !== value.trim() && !value.includes('..')
                                    ? undefined
                                    : 'Enter a folder of your vault, such as Knowii.'
                        }
                    }
                ]
            },
            {
                type: 'group',
                heading: 'Advanced',
                items: [
                    {
                        name: 'Community address',
                        desc: 'Only change this if the community moves. Leave it alone otherwise.',
                        control: {
                            type: 'text',
                            key: 'communityUrl',
                            placeholder: 'https://www.knowii.net',
                            validate: (value) =>
                                normalizeCommunityUrl(value)
                                    ? undefined
                                    : 'Enter a web address such as https://www.knowii.net.'
                        }
                    },
                    {
                        name: 'Stored session',
                        searchable: true,
                        render: (setting): void => {
                            const session = this.plugin.storedSession()
                            const member = this.plugin.activityState?.member?.name
                            setting.setDesc(
                                session
                                    ? `Your Knowii sign-in${member ? ` (${member})` : ''} is stored in Obsidian's secret storage on this device, for this vault, since ${new Date(session.savedAt).toLocaleString()}. It is not in the plugin settings (data.json), so it does not travel with your vault. Other vaults never get it. Signing out of Knowii removes it.`
                                    : Platform.isDesktopApp
                                      ? "No sign-in stored on this device for this vault. Sign in once in the Knowii pane: the session is then kept in Obsidian's secret storage on this device."
                                      : "No sign-in stored on this device for this vault. The session is kept in Obsidian's secret storage on each device and does not travel with the vault. You can still open Knowii in your browser."
                            )
                            if (session) {
                                setting.addButton((button) =>
                                    button
                                        .setButtonText('Forget')
                                        .setDestructive()
                                        .onClick(async () => {
                                            // Forgetting stops notifications on
                                            // this device.
                                            const confirmed = await confirmAction(this.app, {
                                                title: 'Forget the stored session?',
                                                text: 'This device stops getting notifications, and the plain-text copy left by older versions is removed from data.json. If this desktop is signed in to the Knowii pane, it stores the session again at its next check: to remove it for good, sign out in the pane.',
                                                confirm: 'Forget',
                                                destructive: true
                                            })
                                            if (!confirmed) {
                                                return
                                            }
                                            await this.plugin.forgetStoredSession()
                                            this.update()
                                        })
                                )
                            }
                        }
                    },
                    {
                        name: 'Plain-text copy of the session',
                        searchable: true,
                        visible: () => this.plugin.hasLegacySession,
                        render: (setting): void => {
                            setting.setDesc(
                                `Older versions kept your sign-in in data.json, which travels with your vault. Each device moves it to its own secret storage at its next start, and the copy is removed ${LEGACY_SESSION_GRACE_DAYS} days after the first device did. Remove it now once all your devices run this version.`
                            )
                            setting.addButton((button) =>
                                button
                                    .setButtonText('Remove plain-text copy now')
                                    .onClick(async () => {
                                        await this.plugin.removeLegacySessionCopy()
                                        this.update()
                                    })
                            )
                        }
                    }
                ]
            },
            {
                type: 'group',
                // No heading: renderSupportSection draws its own.
                items: [
                    {
                        name: 'Support',
                        // Not a setting — keep it out of the settings search.
                        searchable: false,
                        render: (setting): (() => void) => {
                            // Render INSIDE the row (settingEl), never into
                            // group.listEl — see the class docs above.
                            setting.infoEl.remove() // the section draws its own headings
                            // `.setting-item` is a flex ROW; the support block
                            // is a stack of full-width rows.
                            setting.settingEl.addClass('settings-stack')
                            // In a wrapper removed by the returned cleanup:
                            // update() re-runs this hook on the SAME row and
                            // only resets name, description and control area, so content appended
                            // straight to settingEl would pile up.
                            const blockEl = setting.settingEl.createDiv()
                            renderSupportSection(blockEl, (el) => {
                                this.renderBuyMeACoffeeBadge(el)
                            })
                            return () => blockEl.remove()
                        }
                    }
                ]
            }
        ]
    }

    /** One switch per known space; a hint until the first check has listed them. */
    private spaceItems(): SettingGroupItem[] {
        const spaces = this.plugin.knownSpaces()
        const visible = (): boolean =>
            this.plugin.settings.notificationsEnabled && this.plugin.settings.watchWholeCommunity
        if (0 === spaces.length) {
            return [
                {
                    name: 'Spaces',
                    desc: 'Every space is watched. They are listed here, each with its own switch, once the plugin has checked Knowii (reopen these settings after signing in).',
                    visible
                }
            ]
        }
        return [...spaces]
            .filter((space) => 'course' !== space.kind)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((space) => ({
                name: space.name,
                desc: spaceKindLabel(space.kind),
                visible,
                control: { type: 'toggle' as const, key: `${SPACE_KEY_PREFIX}${space.id}` }
            }))
    }

    /**
     * Reads the value behind a control `key`. Returning undefined/null makes
     * the framework fall back to the control's declared `defaultValue`.
     */
    override getControlValue(key: string): unknown {
        if (key.startsWith(SPACE_KEY_PREFIX)) {
            const id = Number(key.slice(SPACE_KEY_PREFIX.length))
            return !this.plugin.settings.mutedSpaceIds.includes(id)
        }
        if (key.startsWith(NOTIFY_KEY_PREFIX)) {
            const category = key.slice(NOTIFY_KEY_PREFIX.length)
            return isActivityCategory(category)
                ? this.plugin.settings.notifyCategories[category]
                : undefined
        }
        if (isToggleKey(key)) {
            return this.plugin.settings[key]
        }
        switch (key) {
            case 'checkIntervalSeconds':
                return String(this.plugin.settings.checkIntervalSeconds)
            case 'desktopNotifications':
                return this.plugin.settings.desktopNotifications
            case 'notesFolder':
                return this.plugin.settings.notesFolder
            case 'paneLocation':
                return this.plugin.settings.paneLocation
            case 'zoomPercent':
                return this.plugin.settings.zoomPercent
            case 'communityUrl':
                return this.plugin.settings.communityUrl
            default:
                return undefined
        }
    }

    /**
     * Persists a control edit. Rejecting (not resolving) on failure is what
     * lets the framework roll the control back to the stored truth.
     */
    override async setControlValue(key: string, value: unknown): Promise<void> {
        if (key.startsWith(SPACE_KEY_PREFIX)) {
            const id = Number(key.slice(SPACE_KEY_PREFIX.length))
            if (!Number.isInteger(id) || 'boolean' !== typeof value) {
                throw new Error(`Setting "${key}" expects a boolean for a space.`)
            }
            await this.plugin.updateSettings((draft) => {
                const muted = draft.mutedSpaceIds.filter((mutedId) => mutedId !== id)
                draft.mutedSpaceIds = value ? muted : [...muted, id]
            })
            return
        }
        if (key.startsWith(NOTIFY_KEY_PREFIX)) {
            const category = key.slice(NOTIFY_KEY_PREFIX.length)
            if (!isActivityCategory(category) || 'boolean' !== typeof value) {
                throw new Error(`Setting "${key}" expects a boolean for a known category.`)
            }
            await this.plugin.updateSettings((draft) => {
                draft.notifyCategories[category] = value
            })
            return
        }
        if (isToggleKey(key)) {
            if ('boolean' !== typeof value) {
                throw new Error(`Setting "${key}" expects a boolean.`)
            }
            await this.plugin.updateSettings((draft) => {
                draft[key] = value
            })
            if ('notificationsEnabled' === key || 'watchWholeCommunity' === key) {
                // Dependent settings show only while this is on.
                this.refreshDomState()
            }
            if ('watchWholeCommunity' === key && value) {
                // Watching again starts from now: nothing from the pause is replayed.
                this.plugin.restartWatch()
            }
            return
        }
        switch (key) {
            case 'notesFolder': {
                const folder =
                    'string' === typeof value ? value.trim().replace(/^\/+|\/+$/g, '') : ''
                if ('' === folder || folder.includes('..')) {
                    throw new Error(`Setting "${key}" expects a vault folder.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.notesFolder = folder
                })
                return
            }
            case 'desktopNotifications':
                if (!isDesktopNotificationMode(value)) {
                    throw new Error(`Setting "${key}" expects always, background or off.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.desktopNotifications = value
                })
                return
            case 'checkIntervalSeconds': {
                const seconds = Number(value)
                if (!isCheckInterval(seconds)) {
                    throw new Error(`Setting "${key}" expects one of the offered intervals.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.checkIntervalSeconds = seconds
                })
                return
            }
            case 'paneLocation':
                if (!isPaneLocation(value)) {
                    throw new Error(`Setting "${key}" expects a pane location.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.paneLocation = value
                })
                return
            case 'zoomPercent':
                if (!isValidZoomPercent(value)) {
                    throw new Error(
                        `Setting "${key}" expects a number between ${MIN_ZOOM_PERCENT} and ${MAX_ZOOM_PERCENT}.`
                    )
                }
                await this.plugin.updateSettings((draft) => {
                    draft.zoomPercent = value
                })
                return
            case 'communityUrl': {
                const url = 'string' === typeof value ? normalizeCommunityUrl(value) : null
                if (!url) {
                    throw new Error(`Setting "${key}" expects a web address.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.communityUrl = url
                })
                return
            }
            default:
                new Notice('Failed to save settings.')
                throw new Error(`Setting "${key}" does not address a known field.`)
        }
    }

    renderBuyMeACoffeeBadge(contentEl: HTMLElement | DocumentFragment, width = 175) {
        const linkEl = contentEl.createEl('a', {
            href: BUY_ME_A_COFFEE_URL
        })
        const imgEl = linkEl.createEl('img')
        imgEl.src = BUY_ME_A_COFFEE_BADGE_DATA_URL
        imgEl.alt = 'Buy me a coffee'
        imgEl.width = width
    }
}
