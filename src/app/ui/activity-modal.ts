import { Platform, SuggestModal, setTooltip } from 'obsidian'
import type { App } from 'obsidian'
import type { ActivityItem } from '../domain/community-activity'
import { categoryInfo } from '../domain/community-activity'
import { renderActivityActions, renderActivityContent } from './activity-row'

const CLS = 'knowii-community'

/** Filter token keeping unread items only, as in Gmail. */
export const UNREAD_TOKEN = 'is:unread'

/**
 * Whether an item matches every word of the query (title, text, category).
 * `is:unread` keeps unread items only.
 */
export function matchesQuery(item: ActivityItem, query: string): boolean {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.includes(UNREAD_TOKEN) && !item.unread) {
        return false
    }
    const words = tokens.filter((token) => UNREAD_TOKEN !== token)
    if (0 === words.length) {
        return true
    }
    const haystack = [
        item.title,
        item.summary,
        item.excerpt ?? '',
        categoryInfo(item.category).label
    ]
        .join(' ')
        .toLowerCase()
    return words.every((word) => haystack.includes(word))
}

/** What the list can do; the plugin does the work and keeps the items current. */
export interface ActivityListController {
    items(): readonly ActivityItem[]
    open(item: ActivityItem): void
    markRead(item: ActivityItem): Promise<void>
    archive(item: ActivityItem): Promise<void>
    markAllRead(): Promise<void>
    archiveRead(): Promise<void>
    /** Whether the item can be saved as a note (posts, chat messages). */
    canSave(item: ActivityItem): boolean
    save(item: ActivityItem): Promise<void>
    /** Whether the item is a conversation that can be answered from here. */
    canReply(item: ActivityItem): boolean
    reply(item: ActivityItem): void
}

/** Keyboard shortcuts of the list, shown under it on desktop. */
const KEYBOARD_INSTRUCTIONS = [
    { command: '↑↓ ctrl J/K', purpose: 'move' },
    { command: '↵', purpose: 'open' },
    { command: 'mod ↵', purpose: 'read' },
    { command: 'ctrl E', purpose: 'archive' },
    { command: 'mod S', purpose: 'save as note' },
    { command: 'mod R', purpose: 'reply' }
]

/** SuggestModal keeps its list behind `chooser`; typed as far as the list uses it. */
interface Chooser {
    selectedItem: number
    values: ActivityItem[] | null
    setSelectedItem(index: number, event?: unknown): void
}

/**
 * Recent community activity, newest first, unread in bold (Gmail style),
 * searchable. Enter opens (and marks read), Mod+Enter marks read, Alt+Enter
 * archives; each row also has read and archive buttons.
 */
export class ActivityModal extends SuggestModal<ActivityItem> {
    constructor(
        app: App,
        private readonly controller: ActivityListController
    ) {
        super(app)
        this.limit = 300
        this.emptyStateText = 'Nothing matches.'
        this.updatePlaceholder()
        // Keyboard hints mean nothing on a touch screen; they only eat its height.
        if (!Platform.isMobile) {
            this.setInstructions(KEYBOARD_INSTRUCTIONS)
        }
        this.modalEl.addClass(`${CLS}-activity-modal`)
        this.renderToolbar()

        this.scope.register(['Mod'], 'Enter', (event) => {
            event.preventDefault()
            const item = this.selected()
            if (item) {
                void this.run(() => this.controller.markRead(item))
            }
            return false
        })
        const archive = (event: KeyboardEvent): false => {
            event.preventDefault()
            const item = this.selected()
            if (item) {
                void this.run(() => this.controller.archive(item))
            }
            return false
        }
        this.scope.register(['Alt'], 'Enter', archive)
        this.scope.register(['Ctrl'], 'e', archive)
        this.scope.register(['Ctrl'], 'j', (event) => this.move(event, 1))
        this.scope.register(['Ctrl'], 'k', (event) => this.move(event, -1))
        this.scope.register(['Mod'], 's', (event) => {
            event.preventDefault()
            const item = this.selected()
            if (item && this.controller.canSave(item)) {
                void this.run(() => this.controller.save(item))
            }
            return false
        })
        this.scope.register(['Mod'], 'r', (event) => {
            event.preventDefault()
            const item = this.selected()
            if (item && this.controller.canReply(item)) {
                this.close()
                this.controller.reply(item)
            }
            return false
        })
    }

    /** Keyboard triage: Ctrl+J / Ctrl+K move like the arrows. */
    private move(event: KeyboardEvent, step: number): false {
        event.preventDefault()
        const chooser = this.suggestChooser()
        const count = chooser?.values?.length ?? 0
        if (chooser && count > 0) {
            chooser.setSelectedItem((chooser.selectedItem + step + count) % count, event)
        }
        return false
    }

    override getSuggestions(query: string): ActivityItem[] {
        return this.controller.items().filter((item) => matchesQuery(item, query))
    }

    override renderSuggestion(item: ActivityItem, el: HTMLElement): void {
        renderActivityContent(el, item, Date.now())
        renderActivityActions(
            el,
            item,
            {
                ...this.controller,
                reply: (target) => {
                    this.close()
                    this.controller.reply(target)
                }
            },
            (action) => {
                void this.run(action)
            }
        )
    }

    override onChooseSuggestion(item: ActivityItem): void {
        this.controller.open(item)
    }

    private renderToolbar(): void {
        const bar = createDiv({ cls: `${CLS}-activity-toolbar` })
        const markAll = bar.createEl('button', { text: 'Mark all as read' })
        markAll.addEventListener('click', () => {
            void this.run(() => this.controller.markAllRead())
        })
        const archiveRead = bar.createEl('button', { text: 'Archive read' })
        setTooltip(archiveRead, 'Hide everything already read from this list')
        archiveRead.addEventListener('click', () => {
            void this.run(() => this.controller.archiveRead())
        })
        this.modalEl.insertBefore(bar, this.resultContainerEl)
    }

    /** Runs an action, then redraws the list where the member was. */
    private async run(action: () => Promise<void>): Promise<void> {
        const index = this.suggestChooser()?.selectedItem ?? 0
        await action()
        this.updatePlaceholder()
        this.inputEl.dispatchEvent(new Event('input'))
        const after = this.suggestChooser()
        const count = after?.values?.length ?? 0
        if (after && count > 0) {
            after.setSelectedItem(Math.min(index, count - 1))
        }
    }

    private selected(): ActivityItem | null {
        const chooser = this.suggestChooser()
        return chooser?.values?.[chooser.selectedItem] ?? null
    }

    /**
     * Obsidian's own list controller. Named apart from it on purpose: a method
     * called `chooser` would be shadowed by the modal's `chooser` field.
     */
    private suggestChooser(): Chooser | null {
        const chooser = (this as unknown as { chooser?: Chooser }).chooser
        return chooser && 'number' === typeof chooser.selectedItem ? chooser : null
    }

    private updatePlaceholder(): void {
        const unread = this.controller.items().filter((item) => item.unread).length
        this.setPlaceholder(
            0 === unread
                ? "What's new in Knowii: you're all caught up. Type to filter."
                : `What's new in Knowii: ${unread} unread. Type to filter, ${UNREAD_TOKEN} for unread only.`
        )
    }
}
