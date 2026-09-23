import { Modal } from 'obsidian'
import type { App } from 'obsidian'

/**
 * Asks before something that cannot be undone from Obsidian. Resolves true
 * on confirm, false on cancel or close. (`window.confirm` is off limits in
 * plugins.)
 */
export function confirmAction(
    app: App,
    options: { title: string; text: string; confirm: string }
): Promise<boolean> {
    return new Promise((resolve) => {
        let answered = false
        const modal = new Modal(app)
        modal.modalEl.addClass('knowii-community-confirm')
        modal.titleEl.setText(options.title)
        modal.contentEl.createEl('p', { text: options.text })
        const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' })
        const confirm = buttons.createEl('button', { cls: 'mod-cta', text: options.confirm })
        confirm.addEventListener('click', () => {
            answered = true
            modal.close()
            resolve(true)
        })
        const cancel = buttons.createEl('button', { text: 'Cancel' })
        cancel.addEventListener('click', () => {
            modal.close()
        })
        modal.onClose = () => {
            if (!answered) {
                resolve(false)
            }
        }
        modal.open()
    })
}
