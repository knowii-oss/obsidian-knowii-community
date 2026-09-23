import { TFile, normalizePath } from 'obsidian'
import type { App } from 'obsidian'
import { safeFileName } from '../domain/community-content'

/** Where saved community content goes when the setting is empty. */
export const DEFAULT_NOTES_FOLDER = 'Knowii'

/**
 * Writes community content into the vault as a note. An existing note with
 * the same name is kept as it is (it may carry the member's own additions)
 * and returned instead.
 */
export async function saveNote(
    app: App,
    folder: string,
    title: string,
    content: string
): Promise<{ file: TFile; created: boolean }> {
    const dir = normalizePath(folder.trim() || DEFAULT_NOTES_FOLDER)
    const path = normalizePath(`${dir}/${safeFileName(title)}.md`)
    const existing = app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
        return { file: existing, created: false }
    }
    if (!app.vault.getAbstractFileByPath(dir)) {
        await app.vault.createFolder(dir)
    }
    const file = await app.vault.create(path, content)
    return { file, created: true }
}
