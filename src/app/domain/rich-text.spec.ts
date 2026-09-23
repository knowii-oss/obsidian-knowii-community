import { describe, expect, test } from 'bun:test'
import { hasText, textToTiptap, tiptapToMarkdown } from './rich-text'

// Shape captured from a live post on 2026-09-22 (trimmed).
const POST_BODY = {
    body: {
        type: 'doc',
        content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hey everyone 👋' }] },
            { type: 'paragraph' },
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Watch ' },
                    {
                        type: 'text',
                        text: 'the video',
                        marks: [{ type: 'link', attrs: { href: 'https://youtu.be/x' } }]
                    },
                    { type: 'text', text: ', it is ' },
                    { type: 'text', text: 'short', marks: [{ type: 'bold' }] },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'and ' },
                    { type: 'text', text: 'free', marks: [{ type: 'italic' }] }
                ]
            },
            { type: 'embed', attrs: { url: 'https://youtu.be/x' } },
            {
                type: 'bulletList',
                content: [
                    {
                        type: 'listItem',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }]
                    },
                    {
                        type: 'listItem',
                        content: [
                            { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
                            {
                                type: 'bulletList',
                                content: [
                                    {
                                        type: 'listItem',
                                        content: [
                                            {
                                                type: 'paragraph',
                                                content: [{ type: 'text', text: 'nested' }]
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Later' }] },
            {
                type: 'paragraph',
                content: [
                    { type: 'mention', attrs: { label: 'Phillip George' } },
                    { type: 'text', text: ' thanks' }
                ]
            }
        ]
    }
}

describe('tiptapToMarkdown', () => {
    test('paragraphs, marks, links, breaks, embeds, lists, headings, mentions', () => {
        expect(tiptapToMarkdown(POST_BODY)).toBe(
            [
                'Hey everyone 👋',
                '',
                'Watch [the video](https://youtu.be/x), it is **short**\nand *free*',
                '',
                'https://youtu.be/x',
                '',
                '- one\n- two\n    - nested',
                '',
                '### Later',
                '',
                '@Phillip George thanks'
            ].join('\n')
        )
    })

    test('accepts the bare document and the tiptap_body wrapper; junk gives nothing', () => {
        expect(tiptapToMarkdown(POST_BODY.body)).toContain('Hey everyone')
        expect(tiptapToMarkdown({ tiptap_body: POST_BODY })).toContain('Hey everyone')
        expect(tiptapToMarkdown(null)).toBe('')
        expect(tiptapToMarkdown('text')).toBe('')
    })
})

describe('textToTiptap', () => {
    test('blank lines split paragraphs, single breaks stay, dash lines become a list', () => {
        expect(textToTiptap('Hello\nthere\n\n- a\n- b\n\n\nBye')).toEqual({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Hello' },
                        { type: 'hardBreak' },
                        { type: 'text', text: 'there' }
                    ]
                },
                {
                    type: 'bulletList',
                    content: [
                        {
                            type: 'listItem',
                            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }]
                        },
                        {
                            type: 'listItem',
                            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }]
                        }
                    ]
                },
                { type: 'paragraph', content: [{ type: 'text', text: 'Bye' }] }
            ]
        })
    })

    test('round-trips through markdown', () => {
        expect(tiptapToMarkdown(textToTiptap('One\n\n- a\n- b'))).toBe('One\n\n- a\n- b')
    })
})

describe('hasText', () => {
    test('an empty or blank message has no text', () => {
        expect(hasText(textToTiptap(''))).toBe(false)
        expect(hasText(textToTiptap('   \n\n  '))).toBe(false)
        expect(hasText(textToTiptap('hi'))).toBe(true)
    })
})
