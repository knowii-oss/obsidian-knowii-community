/**
 * The community stores posts, comments and messages as TipTap (ProseMirror)
 * JSON. These helpers turn that into Markdown for notes, and turn plain text
 * typed in Obsidian into the smallest TipTap document the community accepts.
 */

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
    return 'object' === typeof value && null !== value && !Array.isArray(value)
}

function children(node: Json): Json[] {
    return Array.isArray(node['content']) ? node['content'].filter(isObject) : []
}

function attr(node: Json, name: string): string | null {
    const attrs = isObject(node['attrs']) ? node['attrs'] : {}
    const value = attrs[name]
    return 'string' === typeof value && '' !== value ? value : null
}

/** Inline text with its marks (bold, italic, code, strike, link). */
function renderText(node: Json): string {
    let text = 'string' === typeof node['text'] ? node['text'] : ''
    if ('' === text) {
        return ''
    }
    const marks = Array.isArray(node['marks']) ? node['marks'].filter(isObject) : []
    let href: string | null = null
    for (const mark of marks) {
        switch (mark['type']) {
            case 'bold':
            case 'strong':
                text = `**${text}**`
                break
            case 'italic':
            case 'em':
                text = `*${text}*`
                break
            case 'code':
                text = `\`${text}\``
                break
            case 'strike':
                text = `~~${text}~~`
                break
            case 'link':
                href = attr(mark, 'href')
                break
        }
    }
    return href && href !== text ? `[${text}](${href})` : text
}

function renderInline(nodes: Json[]): string {
    return nodes
        .map((node) => {
            switch (node['type']) {
                case 'text':
                    return renderText(node)
                case 'hardBreak':
                    return '\n'
                case 'mention': {
                    const label = attr(node, 'label') ?? attr(node, 'name') ?? attr(node, 'id')
                    return label ? `@${label}` : ''
                }
                case 'image': {
                    const src = attr(node, 'src') ?? attr(node, 'url')
                    return src ? `![${attr(node, 'alt') ?? ''}](${src})` : ''
                }
                default:
                    return renderInline(children(node))
            }
        })
        .join('')
}

function renderBlock(node: Json, depth: number): string {
    switch (node['type']) {
        case 'doc':
            return renderBlocks(children(node), depth)
        case 'paragraph':
            return renderInline(children(node))
        case 'heading': {
            const levelAttr = isObject(node['attrs']) ? node['attrs']['level'] : null
            const level = 'number' === typeof levelAttr ? Math.min(Math.max(levelAttr, 1), 6) : 2
            return `${'#'.repeat(level)} ${renderInline(children(node))}`
        }
        case 'bulletList':
            return renderList(node, depth, () => '-')
        case 'orderedList':
            return renderList(node, depth, (index) => `${index + 1}.`)
        case 'blockquote':
            return renderBlocks(children(node), depth)
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n')
        case 'codeBlock':
            return `\`\`\`${attr(node, 'language') ?? ''}\n${renderInline(children(node))}\n\`\`\``
        case 'horizontalRule':
            return '---'
        case 'embed':
        case 'image': {
            const src = attr(node, 'url') ?? attr(node, 'src')
            return src ? ('image' === node['type'] ? `![](${src})` : src) : ''
        }
        default:
            return children(node).length > 0
                ? renderBlocks(children(node), depth)
                : renderInline([node])
    }
}

function renderList(node: Json, depth: number, bullet: (index: number) => string): string {
    const indent = '    '.repeat(depth)
    return children(node)
        .map((item, index) => {
            const [first = '', ...rest] = renderBlocks(children(item), depth + 1).split('\n')
            const continuation = rest.map((line) =>
                line.startsWith(' ') ? line : `${indent}    ${line}`
            )
            return [`${indent}${bullet(index)} ${first}`, ...continuation].join('\n')
        })
        .join('\n')
}

function renderBlocks(nodes: Json[], depth: number): string {
    // Empty paragraphs are the community's way of spacing; one blank line is enough.
    return nodes
        .map((node) => renderBlock(node, depth))
        .filter((block) => '' !== block.trim())
        .join(depth > 0 ? '\n' : '\n\n')
}

/**
 * A TipTap body as Markdown. Accepts the document itself or the wrappers the
 * community puts around it (`{ body: doc }`, `{ tiptap_body: { body } }`).
 */
export function tiptapToMarkdown(value: unknown): string {
    let node: unknown = value
    while (isObject(node) && 'doc' !== node['type']) {
        const inner: unknown = node['body'] ?? node['tiptap_body']
        if (inner === undefined) {
            break
        }
        node = inner
    }
    return isObject(node) ? renderBlock(node, 0).trim() : ''
}

/**
 * Text typed in Obsidian as a TipTap document: blank lines split paragraphs,
 * single line breaks stay line breaks, `- ` lines become a bullet list.
 * Nothing fancier: the community renders links and mentions itself.
 */
export function textToTiptap(text: string): Json {
    const content: Json[] = []
    const blocks = text
        .replace(/\r\n/g, '\n')
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter((block) => '' !== block)
    for (const block of blocks) {
        const lines = block.split('\n')
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
            content.push({
                type: 'bulletList',
                content: lines.map((line) => ({
                    type: 'listItem',
                    content: [paragraph(line.replace(/^\s*[-*]\s+/, ''))]
                }))
            })
        } else {
            content.push(paragraph(block))
        }
    }
    return { type: 'doc', content }
}

function paragraph(text: string): Json {
    const lines = text.split('\n')
    const inline: Json[] = []
    lines.forEach((line, index) => {
        if (index > 0) {
            inline.push({ type: 'hardBreak' })
        }
        if ('' !== line) {
            inline.push({ type: 'text', text: line })
        }
    })
    return inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' }
}

/** Whether a TipTap document has any text at all (never send an empty one). */
export function hasText(doc: Json): boolean {
    return /"text":"[^"]*\S/.test(JSON.stringify(doc))
}
