import { setIcon, setTooltip } from 'obsidian'
import { totalUnread } from '../domain/community-activity'
import type { WatchState } from '../services/activity-watcher'
import { KNOWII_ICON_ID } from '../assets/knowii-icon'

const CLS = 'knowii-community'

/** Badge text: exact up to 99, then "99+". */
export function badgeText(count: number): string {
    return count > 99 ? '99+' : String(count)
}

/**
 * The status bar item: Knowii mark, then unread notifications and messages
 * (threads count with messages). Signed out, it invites to sign in.
 */
export class StatusBarBadge {
    constructor(
        private readonly el: HTMLElement,
        onClick: () => void
    ) {
        el.addClass(`${CLS}-status`, 'mod-clickable')
        el.addEventListener('click', onClick)
    }

    render(state: WatchState, visible: boolean): void {
        this.el.toggle(visible)
        if (!visible) {
            return
        }
        this.el.empty()
        const mark = this.el.createSpan({ cls: `${CLS}-status-mark` })
        setIcon(mark, KNOWII_ICON_ID)

        switch (state.status) {
            case 'starting':
                setTooltip(this.el, 'Knowii: checking…', { placement: 'top' })
                return
            case 'signed-out':
                this.el.createSpan({ cls: `${CLS}-status-muted`, text: 'Sign in' })
                setTooltip(this.el, 'Knowii: sign in to get notified about new activity', {
                    placement: 'top'
                })
                return
            case 'error':
                this.addCount('cloud-off', null)
                setTooltip(
                    this.el,
                    `Knowii: cannot reach the community (${state.error ?? 'unknown error'}). Retrying.`,
                    {
                        placement: 'top'
                    }
                )
                return
            case 'signed-in': {
                const messages = state.counts.messages + state.counts.threads
                this.addCount('bell', state.counts.notifications)
                this.addCount('message-circle', messages)
                const checked = state.checkedAt
                    ? new Date(state.checkedAt).toLocaleTimeString()
                    : 'never'
                setTooltip(
                    this.el,
                    `Knowii: ${state.counts.notifications} unread notifications, ${state.counts.messages} unread conversations, ${state.counts.threads} unread threads. Checked at ${checked}. Click to see what's new.`,
                    { placement: 'top' }
                )
                return
            }
        }
    }

    private addCount(icon: string, count: number | null): void {
        const item = this.el.createSpan({ cls: `${CLS}-status-count` })
        if (null !== count && count > 0) {
            item.addClass('is-unread')
        }
        const iconEl = item.createSpan({ cls: `${CLS}-status-icon` })
        setIcon(iconEl, icon)
        if (null !== count) {
            item.createSpan({ text: badgeText(count) })
        }
    }
}

/** Unread total over the ribbon icon. */
export function renderRibbonBadge(
    ribbonEl: HTMLElement | null,
    state: WatchState,
    visible: boolean
): void {
    if (!ribbonEl) {
        return
    }
    ribbonEl.addClass(`${CLS}-ribbon`)
    let badge = ribbonEl.querySelector<HTMLElement>(`.${CLS}-ribbon-badge`)
    const total = 'signed-in' === state.status ? totalUnread(state.counts) : 0
    if (!visible || 0 === total) {
        badge?.remove()
        return
    }
    if (!badge) {
        badge = ribbonEl.createSpan({ cls: `${CLS}-ribbon-badge` })
    }
    badge.setText(badgeText(total))
}
