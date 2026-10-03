import { describe, expect, test } from 'bun:test'
import { produce } from 'immer'
import { KnowiiCommunityPlugin } from './plugin'
import { createDefaultSettings } from './types/plugin-settings.intf'
import type { StoredSession } from './domain/session-cookies'
import {
    DEFAULT_SESSION_SECRET_NAME,
    LEGACY_SESSION_GRACE_DAYS,
    readSessionSecret,
    writeSessionSecret
} from './domain/session-secret'
import type { SecretStore } from './domain/session-secret'

/** This device's SecretStorage: per device, so each simulated device gets its own. */
class FakeSecretStore implements SecretStore {
    readonly secrets = new Map<string, string>()

    getSecret(id: string): string | null {
        return this.secrets.get(id) ?? null
    }

    setSecret(id: string, secret: string): void {
        this.secrets.set(id, secret)
    }
}

const NAME = DEFAULT_SESSION_SECRET_NAME
const DAY_MS = 24 * 60 * 60 * 1000

const session = (value: string): StoredSession => ({
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
    savedAt: '2026-09-01T00:00:00.000Z'
})

/** A device: its own secret storage, and the data.json the vault syncs. */
function device(
    data: Record<string, unknown>,
    store = new FakeSecretStore()
): {
    plugin: KnowiiCommunityPlugin
    store: FakeSecretStore
    disk: () => Record<string, unknown>
} {
    let disk: Record<string, unknown> = data
    const plugin = Object.assign(
        Object.create(KnowiiCommunityPlugin.prototype) as KnowiiCommunityPlugin,
        {
            app: { secretStorage: store },
            // Field initializers do not run without the constructor.
            settingsWriteChain: Promise.resolve(),
            settings: produce(createDefaultSettings(), () => {}),
            loadData: (): Promise<unknown> => Promise.resolve(disk),
            saveData: (next: Record<string, unknown>): Promise<void> => {
                disk = JSON.parse(JSON.stringify(next)) as Record<string, unknown>
                return Promise.resolve()
            }
        }
    )
    return { plugin, store, disk: () => disk }
}

/** Lets the fire-and-forget save in loadSettings land. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve()
    }
}

describe('session in the secret storage', () => {
    test('device B: data.json with the legacy session and an empty secret storage → migrated, still signed in', async () => {
        const { plugin, store, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()

        expect(readSessionSecret(store, NAME)).toEqual(session('legacy'))
        expect(plugin.storedSession()).toEqual(session('legacy'))
        // The legacy copy stays for the other devices; the name and date are recorded.
        expect(disk()['session']).toEqual(session('legacy'))
        expect(disk()['sessionSecretName']).toBe(NAME)
        expect('string' === typeof disk()['legacySecretMigratedAt']).toBe(true)
    })

    test('loading twice is idempotent and keeps the first migration date', async () => {
        const { plugin, disk } = device({
            session: session('legacy'),
            legacySecretMigratedAt: '2026-10-01T00:00:00.000Z'
        })
        await plugin.loadSettings()
        await settle()
        await plugin.loadSettings()
        await settle()
        expect(disk()['legacySecretMigratedAt']).toBe('2026-10-01T00:00:00.000Z')
        expect(plugin.storedSession()).toEqual(session('legacy'))
    })

    test('a device with its own refreshed secret keeps it over the stale legacy copy', async () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('own'))
        const { plugin } = device({ session: session('legacy') }, store)
        await plugin.loadSettings()
        expect(plugin.storedSession()).toEqual(session('own'))
    })

    test('a refresh (same sign-in, new cookies) writes the secret only and keeps the legacy copy', async () => {
        const { plugin, store, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()
        plugin.refreshSession(session('refreshed'))
        expect(readSessionSecret(store, NAME)).toEqual(session('refreshed'))
        expect(disk()['session']).toEqual(session('legacy'))
    })

    test('signing in again (rotate) writes the secret only and removes the legacy copy', async () => {
        const { plugin, store, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await plugin.replaceSession(session('new'))
        expect(readSessionSecret(store, NAME)).toEqual(session('new'))
        expect('session' in disk()).toBe(false)
        expect(JSON.stringify(disk())).not.toContain('"new"')
        expect(plugin.hasLegacySession).toBe(false)
    })

    test('signing out clears this device and the legacy copy', async () => {
        const { plugin, store, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await plugin.clearSession()
        expect(store.getSecret(NAME)).toBe('')
        expect('session' in disk()).toBe(false)
        expect(plugin.storedSession()).toBeNull()
    })

    test(`the legacy copy is removed ${LEGACY_SESSION_GRACE_DAYS} days after the first migration`, async () => {
        const migratedAt = new Date(
            Date.now() - (LEGACY_SESSION_GRACE_DAYS + 1) * DAY_MS
        ).toISOString()
        const { plugin, store, disk } = device({
            session: session('legacy'),
            legacySecretMigratedAt: migratedAt
        })
        await plugin.loadSettings()
        await settle()
        expect('session' in disk()).toBe(false)
        expect(disk()['legacySecretMigratedAt']).toBe(migratedAt)
        // A device that starts that late still keeps the session.
        expect(readSessionSecret(store, NAME)).toEqual(session('legacy'))
        expect(plugin.storedSession()).toEqual(session('legacy'))
    })

    test('within the grace period the legacy copy stays', async () => {
        const migratedAt = new Date(Date.now() - 10 * DAY_MS).toISOString()
        const { plugin, disk } = device({
            session: session('legacy'),
            legacySecretMigratedAt: migratedAt
        })
        await plugin.loadSettings()
        await settle()
        expect(disk()['session']).toEqual(session('legacy'))
    })

    test('"Remove plain-text copy now" drops the legacy copy and keeps this device signed in', async () => {
        const { plugin, store, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()
        // Even if this device had not migrated yet, it does before the copy goes.
        store.secrets.clear()
        await plugin.removeLegacySessionCopy()
        expect('session' in disk()).toBe(false)
        expect(plugin.storedSession()).toEqual(session('legacy'))
    })

    test('nothing stored anywhere: signed out, no secret written', async () => {
        const { plugin, store } = device({ zoomPercent: 120 })
        await plugin.loadSettings()
        expect(plugin.storedSession()).toBeNull()
        expect(store.secrets.size).toBe(0)
    })

    test('an invalid secret name on disk falls back to the default', async () => {
        const { plugin } = device({ sessionSecretName: 'Not Valid' })
        await plugin.loadSettings()
        expect(plugin.settings.sessionSecretName).toBe(NAME)
    })
})
