/** Where the community pane opens. */
export type PaneLocation = 'tab' | 'right' | 'left'

export const PANE_LOCATIONS: readonly PaneLocation[] = ['tab', 'right', 'left']

export interface PluginSettings {
    /** Base URL of the community. Only changes when the community moves. */
    communityUrl: string
    /** Where "Open Knowii" puts the pane. */
    paneLocation: PaneLocation
    /** Show the Knowii icon in the ribbon. */
    showRibbonIcon: boolean
    /** Show the toolbar (navigation and shortcuts) above the community. */
    showToolbar: boolean
    /** Reopen the page you were on the last time the pane was open. */
    rememberLastPage: boolean
    /** Zoom of the embedded community, in percent (50 to 200). */
    zoomPercent: number
}

export const MIN_ZOOM_PERCENT = 50
export const MAX_ZOOM_PERCENT = 200
export const ZOOM_STEP_PERCENT = 10

export const DEFAULT_SETTINGS: PluginSettings = {
    communityUrl: 'https://www.knowii.net',
    paneLocation: 'tab',
    showRibbonIcon: true,
    showToolbar: true,
    rememberLastPage: true,
    zoomPercent: 100
}

export function isPaneLocation(value: unknown): value is PaneLocation {
    return 'string' === typeof value && (PANE_LOCATIONS as readonly string[]).includes(value)
}

export function isValidZoomPercent(value: unknown): value is number {
    return (
        'number' === typeof value &&
        Number.isFinite(value) &&
        value >= MIN_ZOOM_PERCENT &&
        value <= MAX_ZOOM_PERCENT
    )
}
