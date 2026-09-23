import { Modal, Notice, Setting, SuggestModal } from 'obsidian'
import type { App } from 'obsidian'
import type { WatchableSpace } from '../domain/community-watch'
import type { CommunityEvent } from '../domain/community-content'
import { formatAge } from '../domain/community-activity'

const CLS = 'knowii-community'

/** The space "Ask the community" picks first, when the member can post there. */
export const ASK_SPACE_SLUG = 'ask-the-community'

/** The spaces offered to post in, the "ask" space first, then by name. */
export function postableSpaces(spaces: readonly WatchableSpace[]): WatchableSpace[] {
    return spaces
        .filter(
            (space) =>
                space.isMember &&
                space.canPost &&
                ('basic' === space.kind || 'event' === space.kind)
        )
        .sort((a, b) => {
            if (a.slug === ASK_SPACE_SLUG) {
                return -1
            }
            if (b.slug === ASK_SPACE_SLUG) {
                return 1
            }
            return a.name.localeCompare(b.name)
        })
}

/** Runs `action` with the button disabled; reports failures without closing. */
async function busy(
    button: HTMLButtonElement,
    label: string,
    action: () => Promise<void>
): Promise<void> {
    const original = button.getText()
    button.disabled = true
    button.setText(label)
    try {
        await action()
    } catch (error: unknown) {
        new Notice(`Knowii: ${error instanceof Error ? error.message : String(error)}`)
        button.disabled = false
        button.setText(original)
    }
}

/** Mod+Enter submits from a text area. */
function submitOnModEnter(area: HTMLTextAreaElement, submit: () => void): void {
    area.addEventListener('keydown', (event) => {
        if ('Enter' === event.key && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
        }
    })
}

/**
 * Ask the community: a post prefilled from the selection or the note,
 * published in the chosen space.
 */
export class AskModal extends Modal {
    constructor(
        app: App,
        private readonly spaces: readonly WatchableSpace[],
        private readonly initial: { title: string; body: string },
        private readonly publish: (spaceId: number, title: string, body: string) => Promise<void>
    ) {
        super(app)
    }

    override onOpen(): void {
        this.modalEl.addClass(`${CLS}-compose`)
        this.titleEl.setText('Ask the Knowii community')
        const spaces = postableSpaces(this.spaces)
        if (0 === spaces.length) {
            this.contentEl.createEl('p', {
                text: 'There is no space you can post in yet. Join one in Knowii, then try again.'
            })
            return
        }
        let spaceId = spaces[0]?.id ?? 0
        let title = this.initial.title
        new Setting(this.contentEl).setName('Space').addDropdown((dropdown) => {
            for (const space of spaces) {
                dropdown.addOption(String(space.id), space.name)
            }
            dropdown.setValue(String(spaceId)).onChange((value) => {
                spaceId = Number(value)
            })
        })
        new Setting(this.contentEl).setName('Title').addText((text) => {
            text.setValue(title).onChange((value) => {
                title = value
            })
            text.inputEl.addClass(`${CLS}-compose-title`)
        })
        const area = this.contentEl.createEl('textarea', { cls: `${CLS}-compose-body` })
        area.value = this.initial.body
        area.rows = 12

        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const post = buttons.createEl('button', { cls: 'mod-cta', text: 'Post' })
        const submit = (): void => {
            void busy(post, 'Posting…', async () => {
                await this.publish(spaceId, title, area.value)
                this.close()
            })
        }
        post.addEventListener('click', submit)
        submitOnModEnter(area, submit)
        buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
            this.close()
        })
        this.contentEl.createDiv({
            cls: `${CLS}-compose-hint`,
            text: 'Published right away, as you. Ctrl/Cmd+Enter posts.'
        })
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}

/** Quick reply to a conversation, without opening the pane. */
export class ReplyModal extends Modal {
    constructor(
        app: App,
        private readonly to: string,
        private readonly quote: string | null,
        private readonly send: (text: string) => Promise<void>
    ) {
        super(app)
    }

    override onOpen(): void {
        this.modalEl.addClass(`${CLS}-compose`)
        this.titleEl.setText(`Reply to ${this.to}`)
        if (this.quote) {
            this.contentEl.createEl('blockquote', { cls: `${CLS}-compose-quote`, text: this.quote })
        }
        const area = this.contentEl.createEl('textarea', { cls: `${CLS}-compose-body` })
        area.rows = 6
        area.placeholder = 'Your message'
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' })
        const sendButton = buttons.createEl('button', { cls: 'mod-cta', text: 'Send' })
        const submit = (): void => {
            void busy(sendButton, 'Sending…', async () => {
                await this.send(area.value)
                this.close()
            })
        }
        sendButton.addEventListener('click', submit)
        submitOnModEnter(area, submit)
        buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
            this.close()
        })
        this.contentEl.createDiv({ cls: `${CLS}-compose-hint`, text: 'Ctrl/Cmd+Enter sends.' })
        window.setTimeout(() => {
            area.focus()
        }, 0)
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}

/** When an event happens, in the member's own words. */
export function eventWhen(event: CommunityEvent, nowMs: number): string {
    const start = new Date(event.startsAt)
    if (event.startsAt <= nowMs && event.endsAt > nowMs) {
        return 'happening now'
    }
    const minutes = Math.round((event.startsAt - nowMs) / 60000)
    if (minutes > 0 && minutes < 60) {
        return `in ${minutes} min`
    }
    return `${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

/** Upcoming events; Enter opens one in the pane. */
export class EventsModal extends SuggestModal<{ event: CommunityEvent; path: string }> {
    constructor(
        app: App,
        private readonly events: readonly { event: CommunityEvent; path: string }[],
        private readonly openEvent: (path: string) => void
    ) {
        super(app)
        this.emptyStateText = 'No upcoming events.'
        this.setPlaceholder(`Upcoming Knowii events (${events.length}). Type to filter.`)
        this.modalEl.addClass(`${CLS}-activity-modal`)
    }

    override getSuggestions(query: string): { event: CommunityEvent; path: string }[] {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean)
        return this.events.filter((entry) =>
            words.every((word) => entry.event.name.toLowerCase().includes(word))
        )
    }

    override renderSuggestion(
        entry: { event: CommunityEvent; path: string },
        el: HTMLElement
    ): void {
        el.addClass(`${CLS}-activity`)
        el.toggleClass('is-unread', entry.event.attending)
        const body = el.createDiv({ cls: `${CLS}-activity-body` })
        const head = body.createDiv({ cls: `${CLS}-activity-head` })
        head.createSpan({ cls: `${CLS}-activity-title`, text: entry.event.name })
        if (entry.event.attending) {
            head.createSpan({ cls: `${CLS}-activity-category`, text: "You're going" })
        }
        head.createSpan({ cls: `${CLS}-activity-time`, text: eventWhen(entry.event, Date.now()) })
        const ago = formatAge(entry.event.startsAt, Date.now())
        body.createDiv({
            cls: `${CLS}-activity-summary`,
            text: entry.event.startsAt > Date.now() ? 'Upcoming' : `Started ${ago}`
        })
    }

    override onChooseSuggestion(entry: { event: CommunityEvent; path: string }): void {
        this.openEvent(entry.path)
    }
}
