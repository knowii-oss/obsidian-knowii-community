import type { StoredSession } from './session-cookies'
import { parseStoredSession } from './session-cookies'

/**
 * The member's session lives in Obsidian's secret storage (per vault and per
 * device), not in `data.json`: a plain-text copy there travels with the vault
 * (git, Syncthing, cloud). The settings keep only the secret's name.
 *
 * Until 1.5 the session was stored in `data.json` (field `session`). That
 * legacy copy stays readable for a grace period so every device where the
 * vault syncs moves its session into its own secret storage on its next
 * start, without signing in again.
 *
 * Opt-in sharing (`shareSessionAcrossDevices`): phones and tablets cannot
 * sign in themselves, so a member can choose to keep the session in
 * `data.json` too. Then that copy is the shared source: kept up to date,
 * preferred over the device's secret, and never purged.
 */

/** The part of Obsidian's `SecretStorage` the plugin uses. */
export interface SecretStore {
    getSecret(id: string): string | null
    setSecret(id: string, secret: string): void
}

export const DEFAULT_SESSION_SECRET_NAME = 'knowii-community-session'

/** Days the legacy plain-text session stays in `data.json` after the first migration. */
export const LEGACY_SESSION_GRACE_DAYS = 60

const LEGACY_SESSION_GRACE_MS = LEGACY_SESSION_GRACE_DAYS * 24 * 60 * 60 * 1000

/** Secret ids Obsidian accepts: lowercase alphanumeric with dashes. */
export function isValidSecretName(value: unknown): value is string {
    return 'string' === typeof value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** The session in this device's secret storage; null when absent, empty or unusable. */
export function readSessionSecret(store: SecretStore, name: string): StoredSession | null {
    const raw = store.getSecret(name)
    if (null === raw || '' === raw) {
        return null
    }
    try {
        return parseStoredSession(JSON.parse(raw) as unknown)
    } catch {
        return null
    }
}

/** Stores the session on this device; null clears it (there is no delete: '' means absent). */
export function writeSessionSecret(
    store: SecretStore,
    name: string,
    session: StoredSession | null
): void {
    store.setSecret(name, session ? JSON.stringify(session) : '')
}

/**
 * The session to use on this device: the secret storage first, the legacy
 * copy from `data.json` otherwise (copied into the secret storage on the way).
 */
export function resolveSession(
    store: SecretStore,
    name: string,
    legacy: StoredSession | null,
    share = false
): StoredSession | null {
    const secret = readSessionSecret(store, name)
    if (!legacy) {
        return secret
    }
    if (share) {
        // The shared copy is the source; this device's secret follows it.
        if (!sameSession(secret, legacy)) {
            writeSessionSecret(store, name, legacy)
        }
        return legacy
    }
    if (secret) {
        return secret
    }
    writeSessionSecret(store, name, legacy)
    return legacy
}

function sameSession(a: StoredSession | null, b: StoredSession | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether the session is shared through `data.json`. An explicit choice on
 * disk wins. Otherwise it is decided once (and then persisted): on for
 * members who had a session in `data.json` when they moved to the secret
 * storage (they relied on it reaching their other devices), off otherwise.
 */
export function decideShareSession(input: {
    stored: unknown
    legacy: StoredSession | null
    migratedAt: string | null
}): { share: boolean; decided: boolean } {
    if ('boolean' === typeof input.stored) {
        return { share: input.stored, decided: false }
    }
    return { share: null !== input.legacy || null !== input.migratedAt, decided: true }
}

export interface LegacyMigration {
    /** The session was copied into this device's secret storage. */
    readonly migrated: boolean
    /** When the first device migrated (ISO); recorded the first time a legacy copy is seen. */
    readonly migratedAt: string | null
    /** The grace period is over: drop the legacy copy from `data.json`. */
    readonly dropLegacy: boolean
}

/**
 * Runs on every load, on every device. Idempotent: copies the legacy session
 * into this device's secret storage when it has none, records when the
 * migration started, and says when the grace period is over.
 */
export function migrateLegacySession(input: {
    store: SecretStore
    name: string
    legacy: StoredSession | null
    migratedAt: string | null
    now: Date
    /** Sharing through `data.json`: the copy there wins and is never purged. */
    share?: boolean
}): LegacyMigration {
    const { store, name, legacy, now } = input
    const share = true === input.share
    if (!legacy) {
        return { migrated: false, migratedAt: input.migratedAt, dropLegacy: false }
    }
    let migrated = false
    const secret = readSessionSecret(store, name)
    if (null === secret || (share && !sameSession(secret, legacy))) {
        writeSessionSecret(store, name, legacy)
        migrated = true
    }
    const migratedAt = input.migratedAt ?? now.toISOString()
    const dropLegacy = !share && now.getTime() - Date.parse(migratedAt) >= LEGACY_SESSION_GRACE_MS
    return { migrated, migratedAt, dropLegacy }
}

/** An ISO date read from disk; null when missing or unparsable. */
export function parseIsoDate(value: unknown): string | null {
    return 'string' === typeof value && Number.isFinite(Date.parse(value)) ? value : null
}
