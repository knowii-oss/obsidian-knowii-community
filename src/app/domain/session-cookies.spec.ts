import { describe, expect, test } from 'bun:test'
import {
    applySetCookies,
    authFingerprint,
    cookieHeader,
    hasAuthCookie,
    parseStoredSession,
    splitSetCookieHeader
} from './session-cookies'
import type { StoredCookie } from './session-cookies'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const LATER = NOW / 1000 + 365 * 86_400

const cookie = (name: string, value: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
    name,
    value,
    domain: 'www.knowii.net',
    path: '/',
    secure: true,
    httpOnly: true,
    ...extra
})

const JAR: StoredCookie[] = [
    cookie('remember_user_token', 'r1', { expirationDate: LATER }),
    cookie('_circle_session', 's1'),
    cookie('ahoy_visit', 'v1', { httpOnly: false }),
    cookie('__stripe_mid', 'm1', { domain: '.www.knowii.net' }),
    cookie('other', 'x', { domain: 'example.com' })
]

describe('cookieHeader', () => {
    test('sends the cookies that apply to the host, parent domains included', () => {
        expect(cookieHeader(JAR, 'www.knowii.net', NOW)).toBe(
            'remember_user_token=r1; _circle_session=s1; ahoy_visit=v1; __stripe_mid=m1'
        )
    })

    test('leaves expired cookies out', () => {
        const jar = [cookie('a', '1', { expirationDate: NOW / 1000 - 1 }), cookie('b', '2')]
        expect(cookieHeader(jar, 'www.knowii.net', NOW)).toBe('b=2')
    })
})

describe('sign-in detection', () => {
    test('needs a live sign-in cookie', () => {
        expect(hasAuthCookie(JAR, NOW)).toBe(true)
        expect(hasAuthCookie([cookie('ahoy_visit', 'v')], NOW)).toBe(false)
        expect(
            hasAuthCookie([cookie('remember_user_token', 'r', { expirationDate: 1 })], NOW)
        ).toBe(false)
    })

    test('the fingerprint ignores analytics churn', () => {
        const churned = JAR.map((c) => ('ahoy_visit' === c.name ? { ...c, value: 'v2' } : c))
        expect(authFingerprint(churned)).toBe(authFingerprint(JAR))
        const rotated = JAR.map((c) => ('_circle_session' === c.name ? { ...c, value: 's2' } : c))
        expect(authFingerprint(rotated)).not.toBe(authFingerprint(JAR))
    })
})

describe('parseStoredSession', () => {
    test('keeps a valid session', () => {
        const session = parseStoredSession({ cookies: JAR, savedAt: '2026-09-22T12:00:00.000Z' })
        expect(session?.cookies).toHaveLength(JAR.length)
    })

    test('drops malformed cookies and sessions without a sign-in', () => {
        expect(parseStoredSession({ cookies: [{ name: 'x' }], savedAt: '' })).toBeNull()
        expect(parseStoredSession({ cookies: [cookie('ahoy_visit', 'v')] })).toBeNull()
        expect(parseStoredSession('cookies')).toBeNull()
        expect(parseStoredSession(null)).toBeNull()
    })
})

describe('Set-Cookie handling', () => {
    test('splits joined headers without breaking Expires dates', () => {
        expect(
            splitSetCookieHeader(
                '_circle_session=s2; path=/; HttpOnly, ahoy_visit=v9; expires=Wed, 23 Sep 2026 07:28:00 GMT; path=/'
            )
        ).toEqual([
            '_circle_session=s2; path=/; HttpOnly',
            'ahoy_visit=v9; expires=Wed, 23 Sep 2026 07:28:00 GMT; path=/'
        ])
        expect(splitSetCookieHeader(undefined)).toEqual([])
        expect(splitSetCookieHeader(['a=1', 'b=2'])).toEqual(['a=1', 'b=2'])
    })

    test('replaces values and removes deleted cookies', () => {
        const next = applySetCookies(
            JAR,
            [
                '_circle_session=s2; path=/; secure; HttpOnly',
                'remember_user_token=; path=/; max-age=0'
            ],
            'www.knowii.net',
            NOW
        )
        expect(next.find((c) => '_circle_session' === c.name)?.value).toBe('s2')
        expect(next.find((c) => 'remember_user_token' === c.name)).toBeUndefined()
        expect(next.find((c) => 'ahoy_visit' === c.name)?.value).toBe('v1')
    })

    test('adds new cookies with their attributes', () => {
        const next = applySetCookies(
            [],
            ['fresh=1; Domain=.knowii.net; Path=/x; Max-Age=60; Secure'],
            'www.knowii.net',
            NOW
        )
        expect(next).toEqual([
            {
                name: 'fresh',
                value: '1',
                domain: '.knowii.net',
                path: '/x',
                secure: true,
                httpOnly: false,
                expirationDate: NOW / 1000 + 60
            }
        ])
    })
})
