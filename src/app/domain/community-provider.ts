/**
 * Everything the plugin needs from a community platform, in one contract.
 *
 * The plugin talks to this interface only. Today Circle (knowii.net) is
 * behind it (`CommunityClient`); moving the community elsewhere means a new
 * provider implementing the same methods, not a rewrite of the plugin.
 */
import type { ActivityRef, CommunityMember } from './community-activity'
import type { CommunityEvent, CommunityTarget, FullPost, FullThread } from './community-content'
import type { WatchableSpace } from './community-watch'
import type { ActivityResult } from '../services/community-client'

/** A live-update connection the platform offers (websocket), if any. */
export interface RealtimeEndpoint {
    /** Community-relative path of the websocket (`/cable`). */
    readonly path: string
    /** Sub-protocol to ask for. */
    readonly protocol: string
    /** Subscribe commands to send once connected (already serialized). */
    readonly subscriptions: readonly string[]
}

export interface CommunityProvider {
    // Reading
    fetchActivity(): Promise<ActivityResult>
    /** Spaces the member belongs to (as of the last check). */
    knownSpaces(): readonly WatchableSpace[]
    fetchPost(target: Extract<CommunityTarget, { kind: 'post' }>): Promise<FullPost>
    fetchThread(target: Extract<CommunityTarget, { kind: 'message' }>): Promise<FullThread>
    /** Events from now on, soonest first, with the path that opens each. */
    upcomingEvents(): Promise<{ event: CommunityEvent; path: string }[]>
    realtime(member: CommunityMember): RealtimeEndpoint | null

    // Writing
    markRead(ref: ActivityRef): Promise<void>
    archive(ref: ActivityRef): Promise<void>
    markAllRead(): Promise<void>
    /** Publishes a post; returns the community path that opens it. */
    createPost(spaceId: number, title: string, text: string): Promise<string>
    /** Sends a message in a conversation. */
    sendMessage(roomUuid: string, text: string): Promise<void>

    /** Forget cached lookups (the community address changed). */
    reset(): void
}
