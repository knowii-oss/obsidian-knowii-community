import { describe, expect, test } from 'bun:test'
import { produce } from 'immer'
import type { App, PluginManifest } from 'obsidian'
import { KnowiiCommunityPlugin } from './plugin'
import {
    DEFAULT_NOTIFY_CATEGORIES,
    DEFAULT_SETTINGS,
    createDefaultSettings
} from './types/plugin-settings.intf'

/** A plugin built without its constructor, holding only what loadSettings needs. */
function pluginLoading(data: unknown): KnowiiCommunityPlugin {
    return Object.assign(Object.create(KnowiiCommunityPlugin.prototype) as KnowiiCommunityPlugin, {
        settings: produce(createDefaultSettings(), () => {}),
        loadData: (): Promise<unknown> => Promise.resolve(data),
        saveData: (): Promise<void> => Promise.resolve()
    })
}

function expectDefaultsNotFrozen(): void {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(false)
    expect(Object.isFrozen(DEFAULT_SETTINGS.mutedSpaceIds)).toBe(false)
    expect(Object.isFrozen(DEFAULT_SETTINGS.notifyCategories)).toBe(false)
    expect(Object.isFrozen(DEFAULT_NOTIFY_CATEGORIES)).toBe(false)
}

describe('default settings', () => {
    test('constructing the plugin never freezes the shared defaults', () => {
        const plugin = new KnowiiCommunityPlugin({} as App, {} as PluginManifest)
        expect(Object.isFrozen(plugin.settings)).toBe(true)
        expectDefaultsNotFrozen()
    })

    test('loadSettings with no stored data never freezes the shared defaults', async () => {
        // Skip the constructor: its field initializer is the other test's case.
        const plugin = pluginLoading(null)

        await plugin.loadSettings()

        // Immer deep-freezes what produce returns, including subtrees shared
        // with its base: producing from DEFAULT_SETTINGS froze the constant
        // for the rest of the process. No data resets to the defaults (a
        // deleted data.json reaches here through onExternalSettingsChange),
        // so this pins a fresh copy rather than the object set up above.
        expect(plugin.settings).toEqual(DEFAULT_SETTINGS)
        expect(plugin.settings).not.toBe(DEFAULT_SETTINGS)
        expect(Object.isFrozen(plugin.settings)).toBe(true)
        expectDefaultsNotFrozen()
    })

    test('loadSettings with stored data never freezes the shared defaults', async () => {
        // No stored muted spaces: the produced settings then keep the base's
        // mutedSpaceIds array, which producing from the constant froze.
        const plugin = pluginLoading({ zoomPercent: 150 })

        await plugin.loadSettings()

        expect(plugin.settings.zoomPercent).toBe(150)
        expect(plugin.settings.mutedSpaceIds).toEqual([])
        expect(Object.isFrozen(plugin.settings)).toBe(true)
        expectDefaultsNotFrozen()
    })

    test('each default settings object is an independent copy', () => {
        const one = createDefaultSettings()
        one.mutedSpaceIds.push(42)
        one.notifyCategories.events = false
        const two = createDefaultSettings()
        expect(two.mutedSpaceIds).toEqual([])
        expect(two.notifyCategories.events).toBe(true)
        expect(DEFAULT_SETTINGS.mutedSpaceIds).toEqual([])
        expect(DEFAULT_NOTIFY_CATEGORIES.events).toBe(true)
        expect(DEFAULT_SETTINGS.notifyCategories).not.toBe(DEFAULT_NOTIFY_CATEGORIES)
    })
})
