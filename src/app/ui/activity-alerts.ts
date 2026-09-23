import { Notice, setIcon } from 'obsidian'
import type { ActivityItem } from '../domain/community-activity'
import { categoryInfo } from '../domain/community-activity'
import { KNOWII_ICON_ID } from '../assets/knowii-icon'
import { log } from '../../utils/log'
import type { DesktopNotificationMode } from '../types/plugin-settings.intf'

/** Whether a system notification should show now. */
export function wantsDesktopNotification(mode: DesktopNotificationMode, focused: boolean): boolean {
    return 'always' === mode || ('background' === mode && !focused)
}

const CLS = 'knowii-community'

/** Individual alerts per check; the rest is folded into one summary. */
export const MAX_INDIVIDUAL_ALERTS = 3
const NOTICE_DURATION_MS = 10_000

export interface AlertOptions {
    readonly notices: boolean
    /** System notifications: always, only while Obsidian is in the background, or never. */
    readonly desktop: DesktopNotificationMode
    /** Open one item in the pane. */
    readonly open: (item: ActivityItem) => void
    /** Show the full list of what's new. */
    readonly openList: () => void
}

/** Tells the member about new activity: a few items, then a summary. */
export function announceItems(items: readonly ActivityItem[], options: AlertOptions): void {
    if (0 === items.length) {
        return
    }
    const individual =
        items.length > MAX_INDIVIDUAL_ALERTS ? items.slice(0, MAX_INDIVIDUAL_ALERTS - 1) : items
    const folded = items.length - individual.length

    if (options.notices) {
        for (const item of individual) {
            showItemNotice(item, options)
        }
        if (folded > 0) {
            showSummaryNotice(
                `${folded} more new ${folded > 1 ? 'items' : 'item'} in Knowii`,
                options.openList
            )
        }
    }
    if (wantsDesktopNotification(options.desktop, document.hasFocus())) {
        for (const item of individual) {
            showDesktopNotification(item.title, describe(item), () => options.open(item))
        }
        if (folded > 0) {
            showDesktopNotification(
                'Knowii',
                `${folded} more new in the community`,
                options.openList
            )
        }
    }
}

/** First check on a device: one summary of the backlog instead of a flood. */
export function announceBacklog(count: number, options: AlertOptions): void {
    if (count <= 0) {
        return
    }
    const text = `You have ${count} unread ${count > 1 ? 'items' : 'item'} in Knowii`
    if (options.notices) {
        showSummaryNotice(text, options.openList)
    }
    if (wantsDesktopNotification(options.desktop, document.hasFocus())) {
        showDesktopNotification('Knowii', text, options.openList)
    }
}

/** Plain notice (signed out, errors). Clicking runs `onClick` when given. */
export function showPlainNotice(text: string, onClick?: () => void): void {
    showSummaryNotice(text, onClick)
}

function describe(item: ActivityItem): string {
    return item.excerpt ? `${item.summary}: ${item.excerpt}` : item.summary
}

function showItemNotice(item: ActivityItem, options: AlertOptions): void {
    const fragment = createFragment((root) => {
        const wrapper = root.createDiv({ cls: `${CLS}-notice` })
        const icon = wrapper.createSpan({ cls: `${CLS}-notice-icon` })
        setIcon(icon, categoryInfo(item.category).icon)
        const body = wrapper.createDiv({ cls: `${CLS}-notice-body` })
        body.createDiv({ cls: `${CLS}-notice-title`, text: item.title })
        body.createDiv({ cls: `${CLS}-notice-summary`, text: item.summary })
        if (item.excerpt) {
            body.createDiv({ cls: `${CLS}-notice-excerpt`, text: item.excerpt })
        }
    })
    clickable(new Notice(fragment, NOTICE_DURATION_MS), () => options.open(item))
}

function showSummaryNotice(text: string, onClick?: () => void): void {
    const fragment = createFragment((root) => {
        const wrapper = root.createDiv({ cls: `${CLS}-notice` })
        const icon = wrapper.createSpan({ cls: `${CLS}-notice-icon` })
        setIcon(icon, KNOWII_ICON_ID)
        wrapper.createDiv({ cls: `${CLS}-notice-body`, text })
    })
    const notice = new Notice(fragment, NOTICE_DURATION_MS)
    if (onClick) {
        clickable(notice, onClick)
    }
}

function clickable(notice: Notice, onClick: () => void): void {
    const el = notice.messageEl
    el.addClass(`${CLS}-notice-clickable`)
    el.addEventListener('click', () => {
        notice.hide()
        onClick()
    })
}

function showDesktopNotification(title: string, body: string, onClick: () => void): void {
    if ('undefined' === typeof Notification) {
        return
    }
    try {
        const notification = new Notification(title, { body, silent: false })
        notification.onclick = () => {
            focusWindow()
            onClick()
        }
    } catch (error: unknown) {
        log('Could not show a system notification', 'warn', error)
    }
}

/** Brings Obsidian to the front when a system notification is clicked. */
function focusWindow(): void {
    try {
        const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require
        const electron = nodeRequire?.('electron') as
            | { remote?: { getCurrentWindow?: () => { show(): void; focus(): void } } }
            | undefined
        const win = electron?.remote?.getCurrentWindow?.()
        if (win) {
            win.show()
            win.focus()
            return
        }
    } catch {
        // fall back to the DOM
    }
    window.focus()
}
