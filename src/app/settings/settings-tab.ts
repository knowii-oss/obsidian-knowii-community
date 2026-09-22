import { Notice, PluginSettingTab } from 'obsidian'
import type { App, SettingDefinitionItem } from 'obsidian'
import type KnowiiCommunityPlugin from '../../main'
import { BUY_ME_A_COFFEE_BADGE_DATA_URL } from '../assets/buy-me-a-coffee'
import { BUY_ME_A_COFFEE_URL, renderSupportSection } from '../ui/support-links'
import { normalizeCommunityUrl } from '../domain/community-links'
import {
    MAX_ZOOM_PERCENT,
    MIN_ZOOM_PERCENT,
    ZOOM_STEP_PERCENT,
    isPaneLocation,
    isValidZoomPercent
} from '../types/plugin-settings.intf'

/**
 * Settings tab, declared rather than rendered (Obsidian 1.13+).
 *
 * `getSettingDefinitions()` REPLACES `display()`: the whole settings UI is
 * declarative. A `render:` hook writes into its own row only; `defaultValue`
 * is never declared on numeric controls; `setControlValue` rejects on failure
 * so the framework rolls the control back to the stored truth.
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
                        control: { type: 'toggle', key: 'showToolbar' }
                    },
                    {
                        name: 'Reopen the last page',
                        desc: 'Come back to the page you were on, instead of the community home, when the pane opens.',
                        control: { type: 'toggle', key: 'rememberLastPage' }
                    },
                    {
                        name: 'Zoom',
                        desc: 'Size of the community inside the pane. Handy in a narrow sidebar.',
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
                        render: (setting): void => {
                            // Render INSIDE the row (settingEl), never outside it.
                            setting.infoEl.remove() // the section draws its own headings
                            // `.setting-item` is a flex ROW; the support block
                            // is a stack of full-width rows.
                            setting.settingEl.addClass('settings-stack')
                            renderSupportSection(setting.settingEl, (el) => {
                                this.renderBuyMeACoffeeBadge(el)
                            })
                        }
                    }
                ]
            }
        ]
    }

    /**
     * Reads the value behind a control `key`. Returning undefined/null makes
     * the framework fall back to the control's declared `defaultValue`.
     */
    override getControlValue(key: string): unknown {
        switch (key) {
            case 'paneLocation':
                return this.plugin.settings.paneLocation
            case 'showToolbar':
                return this.plugin.settings.showToolbar
            case 'rememberLastPage':
                return this.plugin.settings.rememberLastPage
            case 'zoomPercent':
                return this.plugin.settings.zoomPercent
            case 'showRibbonIcon':
                return this.plugin.settings.showRibbonIcon
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
        switch (key) {
            case 'paneLocation':
                if (!isPaneLocation(value)) {
                    throw new Error(`Setting "${key}" expects a pane location.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft.paneLocation = value
                })
                return
            case 'showToolbar':
            case 'rememberLastPage':
            case 'showRibbonIcon':
                if ('boolean' !== typeof value) {
                    throw new Error(`Setting "${key}" expects a boolean.`)
                }
                await this.plugin.updateSettings((draft) => {
                    draft[key] = value
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
