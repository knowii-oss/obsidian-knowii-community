import { describe, expect, test } from 'bun:test'
import {
    COMMUNITY_DESTINATIONS,
    buildCommunityUrl,
    isCommunityUrl,
    normalizeCommunityUrl
} from './community-links'

describe('normalizeCommunityUrl', () => {
    test('accepts a plain host and adds https', () => {
        expect(normalizeCommunityUrl('www.knowii.net')).toBe('https://www.knowii.net')
    })

    test('keeps an explicit https URL and drops the trailing slash', () => {
        expect(normalizeCommunityUrl('https://www.knowii.net/')).toBe('https://www.knowii.net')
    })

    test('drops query and hash', () => {
        expect(normalizeCommunityUrl('https://www.knowii.net/feed?x=1#top')).toBe(
            'https://www.knowii.net/feed'
        )
    })

    test('refuses empty input', () => {
        expect(normalizeCommunityUrl('   ')).toBeNull()
    })

    test('refuses non-web schemes', () => {
        expect(normalizeCommunityUrl('file:///etc/passwd')).toBeNull()
        expect(normalizeCommunityUrl('javascript:alert(1)')).toBeNull()
    })

    test('refuses a bare word without a domain', () => {
        expect(normalizeCommunityUrl('knowii')).toBeNull()
    })
})

describe('buildCommunityUrl', () => {
    test('joins base and path exactly once', () => {
        expect(buildCommunityUrl('https://www.knowii.net', '/feed')).toBe(
            'https://www.knowii.net/feed'
        )
        expect(buildCommunityUrl('https://www.knowii.net/', 'feed')).toBe(
            'https://www.knowii.net/feed'
        )
    })

    test('home is the root with a trailing slash', () => {
        expect(buildCommunityUrl('https://www.knowii.net', '/')).toBe('https://www.knowii.net/')
    })

    test('every destination builds a URL under the base', () => {
        for (const destination of COMMUNITY_DESTINATIONS) {
            const url = buildCommunityUrl('https://www.knowii.net', destination.path)
            expect(url.startsWith('https://www.knowii.net/')).toBe(true)
        }
    })
})

describe('isCommunityUrl', () => {
    test('same host is the community', () => {
        expect(isCommunityUrl('https://www.knowii.net', 'https://www.knowii.net/c/general')).toBe(
            true
        )
    })

    test('another host is not', () => {
        expect(isCommunityUrl('https://www.knowii.net', 'https://example.com/')).toBe(false)
    })

    test('garbage and empty values are not', () => {
        expect(isCommunityUrl('https://www.knowii.net', null)).toBe(false)
        expect(isCommunityUrl('https://www.knowii.net', 'not a url')).toBe(false)
    })
})
