import { describe, expect, test } from 'bun:test'
import { communityPartition, vaultId } from './community-transport'

describe('communityPartition', () => {
    test('is persistent and named after the vault', () => {
        expect(communityPartition('0a1b2c3d4e5f6a7b')).toBe(
            'persist:knowii-community-0a1b2c3d4e5f6a7b'
        )
    })

    test('two vaults never share a partition', () => {
        expect(communityPartition('vault-one')).not.toBe(communityPartition('vault-two'))
    })

    test('odd characters are folded, an empty id still gives a name', () => {
        expect(communityPartition('My Vault/../x')).toBe('persist:knowii-community-my-vault-x')
        expect(communityPartition('')).toBe('persist:knowii-community-vault')
    })
})

describe('vaultId', () => {
    const vault = { getName: () => 'notes' }

    test("prefers Obsidian's own vault id", () => {
        expect(vaultId({ vault, appId: 'abc123' } as { vault: typeof vault })).toBe('abc123')
    })

    test('falls back to the vault name', () => {
        expect(vaultId({ vault })).toBe('notes')
        expect(vaultId({ vault, appId: '' } as { vault: typeof vault })).toBe('notes')
    })
})
