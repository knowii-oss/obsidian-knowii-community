import { Menu, Notice, setIcon, setTooltip } from 'obsidian'
import { KNOWII_ICON_ID } from '../assets/knowii-icon'
import { ADMIN_DESTINATIONS } from '../domain/community-links'
import { formatAge, totalUnread } from '../domain/community-activity'
import type { ActivityItem } from '../domain/community-activity'
import type { WatchState } from '../services/activity-watcher'
import { UNREAD_TOKEN, matchesQuery } from './activity-modal'
import type { ActivityListController } from './activity-modal'
import { renderActivityActions, renderActivityContent } from './activity-row'
import { badgeText } from './activity-indicators'

const CLS = 'knowii-community'

/** Which items the inbox lists. */
export type InboxFilter = 'all' | 'unread'

/** What the inbox needs from the plugin. */
export interface InboxHost {
    state(): WatchState
    list(): ActivityListController
    /** Check the community now; the new state comes back through `update()`. */
    refresh(): Promise<void>
    showEvents(): void
    ask(): void
    /** Open a community path (or the home page) outside Obsidian. */
    openInBrowser(path: string): void
}

/** The items a filter and a query keep, newest first as the watcher sorts them. */
export function inboxItems(
    items: readonly ActivityItem[],
    filter: InboxFilter,
    query: string
): ActivityItem[] {
    const full = 'unread' === filter ? `${query} ${UNREAD_TOKEN}` : query
    return items.filter((item) => matchesQuery(item, full))
}

/**
 * The community pane where the community itself cannot be hosted (the mobile
 * apps have no `<webview>`, and the community refuses to be framed): what's
 * new, as an inbox. Rows open in the browser; reply, save, read and archive
 * stay here. Built for touch first: every action is a visible button.
 */
export class CommunityInbox {
    private filter: InboxFilter = 'all'
    private query = ''
    private refreshing = false
    private countEl: HTMLElement | null = null
    private statusEl: HTMLElement | null = null
    private listEl: HTMLElement | null = null
    private refreshButton: HTMLElement | null = null

    constructor(
        private readonly root: HTMLElement,
        private readonly host: InboxHost
    ) {}

    render(): void {
        const root = this.root
        root.empty()
        const inbox = root.createDiv({ cls: `${CLS}-inbox` })
        this.renderHeader(inbox)
        this.renderControls(inbox)
        this.listEl = inbox.createDiv({ cls: `${CLS}-inbox-list` })
        this.update()
    }

    /** Redraw what depends on the state; the search field keeps its focus. */
    update(): void {
        const state = this.host.state()
        const unread = 'signed-in' === state.status ? totalUnread(state.counts) : 0
        if (this.countEl) {
            this.countEl.toggle(unread > 0)
            this.countEl.setText(badgeText(unread))
        }
        this.refreshButton?.toggleClass('is-busy', this.refreshing)
        if (this.statusEl) {
            this.statusEl.setText(this.statusText(state))
        }
        const list = this.listEl
        if (!list) {
            return
        }
        list.empty()
        switch (state.status) {
            case 'starting':
                this.renderMessage(list, 'loader', 'Checking Knowii…', null)
                return
            case 'signed-out':
                this.renderSignedOut(list)
                return
            case 'error':
                this.renderError(list, state.error ?? 'unknown error')
                return
            case 'signed-in':
                this.renderItems(list, state)
                return
        }
    }

    private statusText(state: WatchState): string {
        if (this.refreshing) {
            return 'Checking…'
        }
        if (null === state.checkedAt) {
            return ''
        }
        return `Checked ${formatAge(state.checkedAt, Date.now())}`
    }

    private renderHeader(parent: HTMLElement): void {
        const header = parent.createDiv({ cls: `${CLS}-inbox-header` })
        const brand = header.createDiv({ cls: `${CLS}-brand` })
        const mark = brand.createSpan({ cls: `${CLS}-brand-mark` })
        setIcon(mark, KNOWII_ICON_ID)
        brand.createSpan({ cls: `${CLS}-brand-name`, text: 'Knowii' })
        this.countEl = brand.createSpan({ cls: `${CLS}-inbox-count` })

        const actions = header.createDiv({ cls: `${CLS}-actions` })
        this.refreshButton = this.button(actions, 'refresh-cw', 'Check now', () => {
            void this.refresh()
        })
        this.button(actions, 'calendar', 'Upcoming events', () => {
            this.host.showEvents()
        })
        this.button(actions, 'help-circle', 'Ask the community', () => {
            this.host.ask()
        })
        const more = this.button(actions, 'more-vertical', 'More', () => {})
        more.addEventListener('click', (event) => {
            this.showMoreMenu(event)
        })
    }

    private renderControls(parent: HTMLElement): void {
        const controls = parent.createDiv({ cls: `${CLS}-inbox-controls` })
        const filters = controls.createDiv({
            cls: `${CLS}-inbox-filters`,
            attr: { role: 'tablist' }
        })
        const buttons = new Map<InboxFilter, HTMLElement>()
        const select = (filter: InboxFilter): void => {
            this.filter = filter
            for (const [id, button] of buttons) {
                button.toggleClass('is-active', id === filter)
                button.setAttribute('aria-selected', String(id === filter))
            }
            this.update()
        }
        for (const [id, label] of [
            ['all', 'All'],
            ['unread', 'Unread']
        ] as const) {
            const button = filters.createEl('button', {
                cls: `${CLS}-inbox-filter`,
                text: label,
                attr: { type: 'button', role: 'tab' }
            })
            button.addEventListener('click', () => {
                select(id)
            })
            buttons.set(id, button)
        }
        select(this.filter)

        const search = controls.createEl('input', {
            cls: `${CLS}-inbox-search`,
            attr: { type: 'search', placeholder: 'Filter', enterkeyhint: 'search' }
        })
        search.value = this.query
        search.addEventListener('input', () => {
            this.query = search.value
            this.update()
        })
        this.statusEl = controls.createDiv({ cls: `${CLS}-inbox-status` })
    }

    private renderItems(list: HTMLElement, state: WatchState): void {
        const items = inboxItems(state.items, this.filter, this.query)
        if (0 === items.length) {
            const caughtUp = '' === this.query.trim()
            this.renderMessage(
                list,
                caughtUp ? 'check-circle' : 'search-x',
                caughtUp ? "You're all caught up." : 'Nothing matches.',
                null
            )
            return
        }
        const controller = this.host.list()
        const now = Date.now()
        for (const item of items) {
            const row = list.createDiv({
                cls: `${CLS}-inbox-row`,
                attr: { role: 'button', tabindex: '0' }
            })
            renderActivityContent(row, item, now)
            renderActivityActions(row, item, controller, (action) => {
                void this.run(action)
            })
            const open = (): void => {
                controller.open(item)
            }
            row.addEventListener('click', open)
            row.addEventListener('keydown', (event) => {
                if ('Enter' === event.key || ' ' === event.key) {
                    event.preventDefault()
                    open()
                }
            })
        }
        const footer = list.createDiv({ cls: `${CLS}-inbox-footer` })
        const markAll = footer.createEl('button', {
            text: 'Mark all as read',
            attr: { type: 'button' }
        })
        markAll.addEventListener('click', () => {
            void this.run(() => controller.markAllRead())
        })
        const archiveRead = footer.createEl('button', {
            text: 'Archive read',
            attr: { type: 'button' }
        })
        archiveRead.addEventListener('click', () => {
            void this.run(() => controller.archiveRead())
        })
    }

    private renderSignedOut(list: HTMLElement): void {
        const card = this.renderMessage(
            list,
            KNOWII_ICON_ID,
            'Sign in once on desktop',
            'Open Knowii in the Obsidian desktop app and sign in. Your session then reaches this device with your vault, and what is new shows up here.'
        )
        const buttons = card.createDiv({ cls: `${CLS}-card-buttons` })
        this.cardButton(buttons, 'Open Knowii in the browser', true, () => {
            this.host.openInBrowser('/')
        })
        this.cardButton(buttons, 'Check again', false, () => {
            void this.refresh()
        })
    }

    private renderError(list: HTMLElement, error: string): void {
        const card = this.renderMessage(
            list,
            'wifi-off',
            'Knowii is unreachable',
            `The community could not be checked (${error}). Check your connection and try again.`
        )
        const buttons = card.createDiv({ cls: `${CLS}-card-buttons` })
        this.cardButton(buttons, 'Try again', true, () => {
            void this.refresh()
        })
        this.cardButton(buttons, 'Open in browser', false, () => {
            this.host.openInBrowser('/')
        })
    }

    private renderMessage(
        parent: HTMLElement,
        icon: string,
        title: string,
        text: string | null
    ): HTMLElement {
        const card = parent.createDiv({ cls: `${CLS}-card` })
        const mark = card.createDiv({ cls: `${CLS}-card-mark` })
        setIcon(mark, icon)
        card.createEl('h3', { cls: `${CLS}-card-title`, text: title })
        if (text) {
            card.createEl('p', { cls: `${CLS}-card-text`, text })
        }
        return card
    }

    private cardButton(
        parent: HTMLElement,
        text: string,
        primary: boolean,
        onClick: () => void
    ): void {
        const button = parent.createEl('button', {
            cls: primary ? `mod-cta ${CLS}-card-button` : `${CLS}-card-button`,
            text,
            attr: { type: 'button' }
        })
        button.addEventListener('click', onClick)
    }

    private showMoreMenu(event: MouseEvent): void {
        const controller = this.host.list()
        const menu = new Menu()
        menu.addItem((item) =>
            item
                .setTitle('Mark all as read')
                .setIcon('check-check')
                .onClick(() => {
                    void this.run(() => controller.markAllRead())
                })
        )
        menu.addItem((item) =>
            item
                .setTitle('Archive read')
                .setIcon('archive')
                .onClick(() => {
                    void this.run(() => controller.archiveRead())
                })
        )
        menu.addSeparator()
        menu.addItem((item) =>
            item
                .setTitle('Open Knowii in the browser')
                .setIcon('external-link')
                .onClick(() => {
                    this.host.openInBrowser('/')
                })
        )
        if (true === this.host.state().member?.isAdmin) {
            menu.addSeparator()
            for (const destination of ADMIN_DESTINATIONS) {
                menu.addItem((item) =>
                    item
                        .setTitle(`Admin: ${destination.label}`)
                        .setIcon(destination.icon)
                        .onClick(() => {
                            this.host.openInBrowser(destination.path)
                        })
                )
            }
        }
        menu.showAtMouseEvent(event)
    }

    private button(
        parent: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void
    ): HTMLElement {
        const button = parent.createEl('button', {
            cls: `${CLS}-button clickable-icon`,
            attr: { 'aria-label': label, 'type': 'button' }
        })
        const iconEl = button.createSpan({ cls: `${CLS}-button-icon` })
        setIcon(iconEl, icon)
        setTooltip(button, label)
        button.addEventListener('click', (event) => {
            event.preventDefault()
            onClick()
        })
        return button
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) {
            return
        }
        this.refreshing = true
        this.update()
        try {
            await this.host.refresh()
        } finally {
            this.refreshing = false
            this.update()
        }
    }

    /** Runs a row or list action; failures are reported, never thrown. */
    private async run(action: () => Promise<void>): Promise<void> {
        try {
            await action()
        } catch (error: unknown) {
            new Notice(`Knowii: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.update()
    }
}
