import { setIcon, setTooltip } from 'obsidian'
import type { ActivityItem } from '../domain/community-activity'
import { categoryInfo, formatAge } from '../domain/community-activity'

const CLS = 'knowii-community'

/** What a row can do with its item; the plugin does the work. */
export interface ActivityRowActions {
    canReply(item: ActivityItem): boolean
    reply(item: ActivityItem): void
    canSave(item: ActivityItem): boolean
    save(item: ActivityItem): Promise<void>
    markRead(item: ActivityItem): Promise<void>
    archive(item: ActivityItem): Promise<void>
}

/**
 * One activity row: icon, title, category, age, summary, excerpt. Shared by
 * the "what's new" list and the inbox pane so both read the same way.
 */
export function renderActivityContent(el: HTMLElement, item: ActivityItem, nowMs: number): void {
    const info = categoryInfo(item.category)
    el.addClass(`${CLS}-activity`)
    el.toggleClass('is-unread', item.unread)
    const icon = el.createSpan({ cls: `${CLS}-activity-icon` })
    setIcon(icon, info.icon)
    const body = el.createDiv({ cls: `${CLS}-activity-body` })
    const head = body.createDiv({ cls: `${CLS}-activity-head` })
    if (item.unread) {
        head.createSpan({ cls: `${CLS}-activity-dot`, attr: { 'aria-label': 'Unread' } })
    }
    head.createSpan({ cls: `${CLS}-activity-title`, text: item.title })
    head.createSpan({ cls: `${CLS}-activity-category`, text: info.label })
    if (item.occurredAt > 0) {
        head.createSpan({ cls: `${CLS}-activity-time`, text: formatAge(item.occurredAt, nowMs) })
    }
    body.createDiv({ cls: `${CLS}-activity-summary`, text: item.summary })
    if (item.excerpt) {
        body.createDiv({ cls: `${CLS}-activity-excerpt`, text: item.excerpt })
    }
}

/**
 * The row's buttons: reply, save, mark as read, archive, as far as the item
 * allows. `run` wraps each action (redraw, error reporting).
 */
export function renderActivityActions(
    el: HTMLElement,
    item: ActivityItem,
    actions: ActivityRowActions,
    run: (action: () => Promise<void>) => void
): void {
    const bar = el.createDiv({ cls: `${CLS}-activity-actions` })
    if (actions.canReply(item)) {
        rowButton(
            bar,
            'reply',
            'Reply',
            () => {
                actions.reply(item)
                return Promise.resolve()
            },
            run
        )
    }
    if (actions.canSave(item)) {
        rowButton(bar, 'file-down', 'Save as note', () => actions.save(item), run)
    }
    if (item.unread) {
        rowButton(bar, 'check', 'Mark as read', () => actions.markRead(item), run)
    }
    rowButton(bar, 'archive', 'Archive', () => actions.archive(item), run)
}

function rowButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    action: () => Promise<void>,
    run: (action: () => Promise<void>) => void
): void {
    const button = parent.createEl('button', {
        cls: `${CLS}-activity-action clickable-icon`,
        attr: { 'aria-label': label, 'type': 'button' }
    })
    setIcon(button, icon)
    setTooltip(button, label)
    // Keep the row from being chosen (opened) and an input from losing focus.
    button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        run(action)
    })
}
