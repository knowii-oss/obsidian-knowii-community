import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { App, Setting, SettingDefinitionItem, SettingGroup } from 'obsidian'
import type KnowiiCommunityPlugin from '../../main'
import { KnowiiCommunitySettingTab } from './settings-tab'
import * as supportLinks from '../ui/support-links'
import { createDefaultSettings } from '../types/plugin-settings.intf'

/** Just enough of an HTMLElement for a render hook: children, classes, remove. */
class FakeEl {
    readonly children: FakeEl[] = []
    readonly classes: string[] = []
    parent: FakeEl | null = null

    createDiv(): FakeEl {
        const child = new FakeEl()
        child.parent = this
        this.children.push(child)
        return child
    }

    addClass(cls: string): void {
        this.classes.push(cls)
    }

    remove(): void {
        this.parent?.children.splice(this.parent.children.indexOf(this), 1)
        this.parent = null
    }
}

const findItem = (items: SettingDefinitionItem[], name: string): SettingDefinitionItem | null => {
    for (const item of items) {
        if ('name' in item && name === item.name) {
            return item
        }
        if ('items' in item && Array.isArray(item.items)) {
            const found = findItem(item.items, name)
            if (found) {
                return found
            }
        }
    }
    return null
}

describe('support row', () => {
    afterEach(() => {
        mock.restore()
    })

    test('update() re-running the hook on the same row leaves one support block', () => {
        // The section itself needs Obsidian's Setting; this spec is about the
        // hook's wrapper and cleanup, so it only marks the block it was given.
        spyOn(supportLinks, 'renderSupportSection').mockImplementation((containerEl) => {
            containerEl.addClass('support-section')
        })
        const plugin = {
            settings: createDefaultSettings(),
            knownSpaces: () => []
        }
        const tab = new KnowiiCommunitySettingTab(
            {} as App,
            Object.assign(Object.create(null) as KnowiiCommunityPlugin, plugin)
        )
        const item = findItem(tab.getSettingDefinitions(), 'Support')
        if (!item || !('render' in item) || !item.render) {
            throw new Error('no Support row with a render hook')
        }

        const settingEl = new FakeEl()
        const setting = Object.assign(Object.create(null) as Setting, {
            settingEl,
            infoEl: settingEl.createDiv()
        })

        const group = Object.create(null) as SettingGroup

        // What Obsidian does on update(): the previous cleanup, then the hook
        // again on the same row.
        const cleanup = item.render(setting, group)
        if ('function' === typeof cleanup) {
            cleanup()
        }
        item.render(setting, group)

        const blocks = settingEl.children.filter((el) => el.classes.includes('support-section'))
        expect(blocks).toHaveLength(1)
        expect(supportLinks.renderSupportSection).toHaveBeenCalledTimes(2)
    })
})
