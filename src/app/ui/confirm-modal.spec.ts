import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Mock } from 'bun:test'
import * as obsidian from 'obsidian'
import type { App } from 'obsidian'
import { confirmAction } from './confirm-modal'

/** Just enough of an HTMLElement for confirmAction: children, classes, clicks. */
class FakeEl {
    readonly children: FakeEl[] = []
    readonly classes: string[] = []
    readonly clicks: (() => void)[] = []
    text = ''

    createEl(_tag: string, options: { cls?: string | string[]; text?: string } = {}): FakeEl {
        const child = new FakeEl()
        child.classes.push(...[options.cls ?? []].flat())
        child.text = options.text ?? ''
        this.children.push(child)
        return child
    }

    createDiv(options: { cls?: string } = {}): FakeEl {
        const child = new FakeEl()
        child.classes.push(...[options.cls ?? []].flat())
        this.children.push(child)
        return child
    }

    addClass(cls: string): void {
        this.classes.push(cls)
    }

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

/**
 * Opens the dialog through a spied Modal (restored after each test): the
 * shared mock's Modal has `{}` elements, this one draws into FakeEls.
 */
const openDialog = (
    destructive?: boolean
): { contentEl: FakeEl; close: () => void; answer: Promise<boolean> } => {
    const contentEl = new FakeEl()
    const modal = Object.assign(Object.create(null) as obsidian.Modal, {
        modalEl: new FakeEl(),
        titleEl: new FakeEl(),
        contentEl,
        open: (): void => {}
    })
    // Obsidian's close() runs onClose, whether a button or Escape closed it.
    modal.close = (): void => {
        modal.onClose()
    }
    // Typed by hand: spyOn types a class export's implementation as never.
    const modalSpy: Mock<(app: App) => obsidian.Modal> = spyOn(obsidian, 'Modal')
    modalSpy.mockImplementation(() => modal)
    const answer = confirmAction({} as App, {
        title: 'Delete it?',
        text: 'It cannot be undone.',
        confirm: 'Delete',
        ...(destructive === undefined ? {} : { destructive })
    })
    return { contentEl, close: () => modal.close(), answer }
}

describe('confirmAction', () => {
    afterEach(() => {
        mock.restore()
    })

    test('a destructive confirm button is the filled red CTA', () => {
        const { contentEl } = openDialog(true)
        expect(contentEl.button('Delete').classes).toEqual(['mod-cta', 'mod-destructive'])
    })

    test('otherwise the confirm button is a plain CTA', () => {
        expect(openDialog(false).contentEl.button('Delete').classes).toEqual(['mod-cta'])
        mock.restore()
        expect(openDialog().contentEl.button('Delete').classes).toEqual(['mod-cta'])
    })

    test('confirm resolves true, Cancel and closing resolve false', async () => {
        const confirmed = openDialog(true)
        confirmed.contentEl.button('Delete').click()
        expect(await confirmed.answer).toBe(true)
        mock.restore()

        const cancelled = openDialog(true)
        cancelled.contentEl.button('Cancel').click()
        expect(await cancelled.answer).toBe(false)
        mock.restore()

        const closed = openDialog(true)
        closed.close()
        expect(await closed.answer).toBe(false)
    })
})
