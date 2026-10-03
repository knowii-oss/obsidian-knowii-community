import { describe, expect, test } from 'bun:test'
import type { StoredSession } from './session-cookies'
import {
    DEFAULT_SESSION_SECRET_NAME,
    LEGACY_SESSION_GRACE_DAYS,
    isValidSecretName,
    migrateLegacySession,
    parseIsoDate,
    readSessionSecret,
    resolveSession,
    writeSessionSecret
} from './session-secret'
import type { SecretStore } from './session-secret'

/** An in-memory stand-in for Obsidian's SecretStorage (rejects invalid ids like it does). */
class FakeSecretStore implements SecretStore {
    readonly secrets = new Map<string, string>()
    writes = 0

    getSecret(id: string): string | null {
        return this.secrets.get(id) ?? null
    }

    setSecret(id: string, secret: string): void {
        if (!isValidSecretName(id)) {
            throw new Error('invalid secret id')
        }
        this.writes += 1
        this.secrets.set(id, secret)
    }
}

const session = (value: string, savedAt = '2026-09-01T00:00:00.000Z'): StoredSession => ({
    cookies: [
        {
            name: 'remember_user_token',
            value,
            domain: 'www.knowii.net',
            path: '/',
            secure: true,
            httpOnly: true
        }
    ],
    savedAt
})

const NAME = DEFAULT_SESSION_SECRET_NAME
const DAY_MS = 24 * 60 * 60 * 1000

describe('secret names', () => {
    test('the default name is a valid secret id', () => {
        expect(isValidSecretName(DEFAULT_SESSION_SECRET_NAME)).toBe(true)
    })

    test('uppercase, spaces, leading or trailing dashes are refused', () => {
        for (const name of ['Knowii', 'a b', '-a', 'a-', '', 'a--b', 42]) {
            expect(isValidSecretName(name)).toBe(false)
        }
    })
})

describe('reading and writing the secret', () => {
    test('round-trips a session', () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('a'))
        expect(readSessionSecret(store, NAME)).toEqual(session('a'))
    })

    test('clearing writes an empty string, read back as absent', () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('a'))
        writeSessionSecret(store, NAME, null)
        expect(store.getSecret(NAME)).toBe('')
        expect(readSessionSecret(store, NAME)).toBeNull()
    })

    test('garbage in the secret reads as absent', () => {
        const store = new FakeSecretStore()
        store.secrets.set(NAME, '{not json')
        expect(readSessionSecret(store, NAME)).toBeNull()
        store.secrets.set(NAME, '{"cookies":[]}')
        expect(readSessionSecret(store, NAME)).toBeNull()
    })
})

describe('resolveSession', () => {
    test('prefers the secret storage over the legacy copy', () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('fresh'))
        expect(resolveSession(store, NAME, session('stale'))).toEqual(session('fresh'))
    })

    test('falls back to the legacy copy and moves it into the secret storage', () => {
        const store = new FakeSecretStore()
        expect(resolveSession(store, NAME, session('legacy'))).toEqual(session('legacy'))
        expect(readSessionSecret(store, NAME)).toEqual(session('legacy'))
    })

    test('null when neither has one', () => {
        expect(resolveSession(new FakeSecretStore(), NAME, null)).toBeNull()
    })
})

describe('migrateLegacySession', () => {
    const now = new Date('2026-10-03T12:00:00.000Z')

    test('device B: legacy copy and empty secret storage → migrated, date recorded', () => {
        const store = new FakeSecretStore()
        const result = migrateLegacySession({
            store,
            name: NAME,
            legacy: session('legacy'),
            migratedAt: null,
            now
        })
        expect(result).toEqual({
            migrated: true,
            migratedAt: now.toISOString(),
            dropLegacy: false
        })
        expect(readSessionSecret(store, NAME)).toEqual(session('legacy'))
    })

    test('keeps the first migration date (synced from another device)', () => {
        const store = new FakeSecretStore()
        const result = migrateLegacySession({
            store,
            name: NAME,
            legacy: session('legacy'),
            migratedAt: '2026-10-01T00:00:00.000Z',
            now
        })
        expect(result.migratedAt).toBe('2026-10-01T00:00:00.000Z')
        expect(result.migrated).toBe(true)
    })

    test('idempotent: a device that already has its secret keeps it', () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('own'))
        const before = store.writes
        const input = {
            store,
            name: NAME,
            legacy: session('legacy'),
            migratedAt: now.toISOString(),
            now
        }
        expect(migrateLegacySession(input).migrated).toBe(false)
        expect(migrateLegacySession(input).migrated).toBe(false)
        expect(store.writes).toBe(before)
        expect(readSessionSecret(store, NAME)).toEqual(session('own'))
    })

    test('no legacy copy: nothing to do', () => {
        const store = new FakeSecretStore()
        expect(
            migrateLegacySession({ store, name: NAME, legacy: null, migratedAt: null, now })
        ).toEqual({ migrated: false, migratedAt: null, dropLegacy: false })
        expect(store.writes).toBe(0)
    })

    test(`the legacy copy is dropped ${LEGACY_SESSION_GRACE_DAYS} days after the first migration`, () => {
        const store = new FakeSecretStore()
        const first = new Date(now.getTime() - LEGACY_SESSION_GRACE_DAYS * DAY_MS)
        const justBefore = migrateLegacySession({
            store,
            name: NAME,
            legacy: session('legacy'),
            migratedAt: new Date(first.getTime() + 1000).toISOString(),
            now
        })
        expect(justBefore.dropLegacy).toBe(false)
        const after = migrateLegacySession({
            store,
            name: NAME,
            legacy: session('legacy'),
            migratedAt: first.toISOString(),
            now
        })
        expect(after.dropLegacy).toBe(true)
        // A late device still gets the session before the copy goes.
        expect(readSessionSecret(store, NAME)).toEqual(session('legacy'))
    })
})

describe('parseIsoDate', () => {
    test('keeps parsable dates only', () => {
        expect(parseIsoDate('2026-10-03T12:00:00.000Z')).toBe('2026-10-03T12:00:00.000Z')
        expect(parseIsoDate('yesterday')).toBeNull()
        expect(parseIsoDate(42)).toBeNull()
        expect(parseIsoDate(undefined)).toBeNull()
    })
})
