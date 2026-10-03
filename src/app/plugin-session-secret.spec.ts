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

/** A device on a vault where the member turned sharing off (1.5.1 behaviour). */
function offDevice(
    data: Record<string, unknown>,
    store?: FakeSecretStore
): ReturnType<typeof device> {
    return device({ shareSessionAcrossDevices: false, ...data }, store)
}

/** Lets the fire-and-forget save in loadSettings land. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve()
    }
}

describe('session in the secret storage, sharing off', () => {
    test('device B: data.json with the legacy session and an empty secret storage → migrated, still signed in', async () => {
        const { plugin, store, disk } = offDevice({ session: session('legacy') })
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
        const { plugin, disk } = offDevice({
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
        const { plugin } = offDevice({ session: session('legacy') }, store)
        await plugin.loadSettings()
        expect(plugin.storedSession()).toEqual(session('own'))
    })

    test('a refresh (same sign-in, new cookies) writes the secret only and keeps the legacy copy', async () => {
        const { plugin, store, disk } = offDevice({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()
        await plugin.refreshSession(session('refreshed'))
        expect(readSessionSecret(store, NAME)).toEqual(session('refreshed'))
        expect(disk()['session']).toEqual(session('legacy'))
    })

    test('signing in again (rotate) writes the secret only and removes the legacy copy', async () => {
        const { plugin, store, disk } = offDevice({ session: session('legacy') })
        await plugin.loadSettings()
        await plugin.replaceSession(session('new'))
        expect(readSessionSecret(store, NAME)).toEqual(session('new'))
        expect('session' in disk()).toBe(false)
        expect(JSON.stringify(disk())).not.toContain('"new"')
        expect(plugin.hasLegacySession).toBe(false)
    })

    test('signing out clears this device and the legacy copy', async () => {
        const { plugin, store, disk } = offDevice({ session: session('legacy') })
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
        const { plugin, store, disk } = offDevice({
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
        const { plugin, disk } = offDevice({
            session: session('legacy'),
            legacySecretMigratedAt: migratedAt
        })
        await plugin.loadSettings()
        await settle()
        expect(disk()['session']).toEqual(session('legacy'))
    })

    test('"Remove plain-text copy now" drops the legacy copy and keeps this device signed in', async () => {
        const { plugin, store, disk } = offDevice({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()
        // Even if this device had not migrated yet, it does before the copy goes.
        store.secrets.clear()
        await plugin.removeLegacySessionCopy()
        expect('session' in disk()).toBe(false)
        expect(plugin.storedSession()).toEqual(session('legacy'))
    })

    test('nothing stored anywhere: signed out, no secret written', async () => {
        const { plugin, store } = offDevice({ zoomPercent: 120 })
        await plugin.loadSettings()
        expect(plugin.storedSession()).toBeNull()
        expect(store.secrets.size).toBe(0)
    })

    test('an invalid secret name on disk falls back to the default', async () => {
        const { plugin } = offDevice({ sessionSecretName: 'Not Valid' })
        await plugin.loadSettings()
        expect(plugin.settings.sessionSecretName).toBe(NAME)
    })
})

describe('"Share session with my other devices": the default', () => {
    test('on for a member upgrading with a session in data.json, and persisted', async () => {
        const { plugin, disk } = device({ session: session('legacy') })
        await plugin.loadSettings()
        await settle()
        expect(plugin.settings.shareSessionAcrossDevices).toBe(true)
        expect(disk()['shareSessionAcrossDevices']).toBe(true)
    })

    test('on for a 1.5.1 member whose copy is already gone (migration date recorded)', async () => {
        const { plugin, disk } = device({ legacySecretMigratedAt: '2026-10-03T00:00:00.000Z' })
        await plugin.loadSettings()
        await settle()
        expect(disk()['shareSessionAcrossDevices']).toBe(true)
    })

    test('off for a vault without a session, and persisted', async () => {
        const { plugin, disk } = device({ zoomPercent: 120 })
        await plugin.loadSettings()
        await settle()
        expect(plugin.settings.shareSessionAcrossDevices).toBe(false)
        expect(disk()['shareSessionAcrossDevices']).toBe(false)
    })

    test('off for a fresh install', async () => {
        const { plugin } = device(null as unknown as Record<string, unknown>)
        await plugin.loadSettings()
        expect(plugin.settings.shareSessionAcrossDevices).toBe(false)
    })

    test('an explicit choice is kept, whatever data.json holds', async () => {
        const { plugin } = device({ session: session('legacy'), shareSessionAcrossDevices: false })
        await plugin.loadSettings()
        expect(plugin.settings.shareSessionAcrossDevices).toBe(false)
    })
})

describe('session in the secret storage, sharing on', () => {
    const onDevice = (
        data: Record<string, unknown>,
        store?: FakeSecretStore
    ): ReturnType<typeof device> => device({ shareSessionAcrossDevices: true, ...data }, store)

    test('a refresh also writes data.json, for the other devices', async () => {
        const { plugin, store, disk } = onDevice({ session: session('legacy') })
        await plugin.loadSettings()
        await plugin.refreshSession(session('refreshed'))
        expect(readSessionSecret(store, NAME)).toEqual(session('refreshed'))
        expect(disk()['session']).toEqual(session('refreshed'))
    })

    test('a new sign-in also writes data.json', async () => {
        const { plugin, disk } = onDevice({})
        await plugin.loadSettings()
        await plugin.replaceSession(session('new'))
        expect(disk()['session']).toEqual(session('new'))
    })

    test('mobile picks up the session a desktop wrote over its own older copy', async () => {
        const phone = new FakeSecretStore()
        writeSessionSecret(phone, NAME, session('old'))
        const { plugin } = onDevice({ session: session('from-desktop') }, phone)
        await plugin.loadSettings()
        expect(plugin.storedSession()).toEqual(session('from-desktop'))
        expect(readSessionSecret(phone, NAME)).toEqual(session('from-desktop'))
    })

    test('the data.json copy is never purged, and the removal row is hidden', async () => {
        const migratedAt = new Date(
            Date.now() - (LEGACY_SESSION_GRACE_DAYS + 30) * DAY_MS
        ).toISOString()
        const { plugin, disk } = onDevice({
            session: session('legacy'),
            legacySecretMigratedAt: migratedAt
        })
        await plugin.loadSettings()
        await settle()
        expect(disk()['session']).toEqual(session('legacy'))
        expect(plugin.hasLegacySession).toBe(false)
    })

    test('signing out still clears both', async () => {
        const { plugin, store, disk } = onDevice({ session: session('legacy') })
        await plugin.loadSettings()
        await plugin.clearSession()
        expect(store.getSecret(NAME)).toBe('')
        expect('session' in disk()).toBe(false)
    })

    test('turning it off deletes the data.json copy and keeps this device signed in', async () => {
        const { plugin, store, disk } = onDevice({ session: session('legacy') })
        await plugin.loadSettings()
        store.secrets.clear()
        await plugin.setShareSession(false)
        expect('session' in disk()).toBe(false)
        expect(disk()['shareSessionAcrossDevices']).toBe(false)
        expect(plugin.storedSession()).toEqual(session('legacy'))
    })

    test("turning it on writes this device's session to data.json", async () => {
        const store = new FakeSecretStore()
        writeSessionSecret(store, NAME, session('own'))
        const { plugin, disk } = offDevice({}, store)
        await plugin.loadSettings()
        await plugin.setShareSession(true)
        expect(disk()['session']).toEqual(session('own'))
        expect(disk()['shareSessionAcrossDevices']).toBe(true)
    })
})
