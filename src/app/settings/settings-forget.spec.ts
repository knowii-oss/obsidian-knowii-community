import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Mock } from 'bun:test'
import * as obsidian from 'obsidian'
import type { App, ButtonComponent, Setting, SettingDefinitionItem, SettingGroup } from 'obsidian'
import type KnowiiCommunityPlugin from '../../main'
import { KnowiiCommunitySettingTab } from './settings-tab'
import { createDefaultSettings } from '../types/plugin-settings.intf'

/** Just enough of an HTMLElement for the confirmation dialog: buttons and clicks. */
class FakeEl {
    readonly children: FakeEl[] = []
    readonly clicks: (() => void)[] = []
    text = ''

    createEl(_tag: string, options: { text?: string } = {}): FakeEl {
        const child = new FakeEl()
        child.text = options.text ?? ''
        this.children.push(child)
        return child
    }

    createDiv(): FakeEl {
        const child = new FakeEl()
        this.children.push(child)
        return child
    }

    addClass(_cls: string): void {}

    setText(text: string): void {
        this.text = text
    }

    addEventListener(_type: 'click', listener: () => void): void {
        this.clicks.push(listener)
    }

    click(): void {
        this.clicks.forEach((listener) => listener())
    }

    button(text: string): FakeEl {
        const found = this.children
            .flatMap((child) => [child, ...child.children])
            .find((el) => el.text === text && el.clicks.length > 0)
        if (!found) {
            throw new Error(`no "${text}" button`)
        }
        return found
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

/**
 * Renders the Stored session row with a session, clicks Forget and returns
 * the confirmation dialog it opened. The shared mock's Modal has `{}`
 * elements, so Modal is spied with one drawing into FakeEls (restored after
 * each test).
 */
const clickForget = (): {
    dialog: FakeEl
    close: () => void
    forgetStoredSession: ReturnType<typeof mock>
    done: Promise<void>
} => {
    const dialog = new FakeEl()
    const modal = Object.assign(Object.create(null) as obsidian.Modal, {
        modalEl: new FakeEl(),
        titleEl: new FakeEl(),
        contentEl: dialog,
        open: (): void => {}
    })
    // Obsidian's close() runs onClose, whether a button or Escape closed it.
    modal.close = (): void => {
        modal.onClose()
    }
    // Typed by hand: spyOn types a class export's implementation as never.
    const modalSpy: Mock<(app: App) => obsidian.Modal> = spyOn(obsidian, 'Modal')
    modalSpy.mockImplementation(() => modal)

    const forgetStoredSession = mock(async (): Promise<void> => {})
    const plugin = {
        settings: {
            ...createDefaultSettings(),
            session: { cookies: [], savedAt: '2026-09-28T10:00:00.000Z' }
        },
        activityState: null,
        knownSpaces: () => [],
        forgetStoredSession
    }
    const tab = new KnowiiCommunitySettingTab(
        {} as App,
        Object.assign(Object.create(null) as KnowiiCommunityPlugin, plugin)
    )
    // The mocked PluginSettingTab has no update(); Forget calls it afterwards.
    tab.update = (): void => {}
    const item = findItem(tab.getSettingDefinitions(), 'Stored session')
    if (!item || !('render' in item) || !item.render) {
        throw new Error('no Stored session row with a render hook')
    }

    let onClick: (() => Promise<void>) | null = null
    const button = Object.assign(Object.create(null) as ButtonComponent, {
        setButtonText: () => button,
        setDestructive: () => button,
        onClick: (handler: () => Promise<void>) => {
            onClick = handler
            return button
        }
    })
    const setting = Object.assign(Object.create(null) as Setting, {
        setDesc: () => setting,
        addButton: (build: (button: ButtonComponent) => unknown) => {
            build(button)
            return setting
        }
    })
    item.render(setting, Object.create(null) as SettingGroup)
    if (!onClick) {
        throw new Error('no Forget button')
    }
    const done = (onClick as () => Promise<void>)()
    return { dialog, close: () => modal.close(), forgetStoredSession, done }
}

describe('Forget stored session', () => {
    afterEach(() => {
        mock.restore()
    })

    test('Cancel keeps the session', async () => {
        const { dialog, forgetStoredSession, done } = clickForget()
        dialog.button('Cancel').click()
        await done
        expect(forgetStoredSession).not.toHaveBeenCalled()
    })

    test('closing the dialog keeps the session', async () => {
        const { close, forgetStoredSession, done } = clickForget()
        close()
        await done
        expect(forgetStoredSession).not.toHaveBeenCalled()
    })

    test('confirming forgets it', async () => {
        const { dialog, forgetStoredSession, done } = clickForget()
        dialog.button('Forget').click()
        await done
        expect(forgetStoredSession).toHaveBeenCalledTimes(1)
    })
})
