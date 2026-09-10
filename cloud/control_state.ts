import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Persists which devices the management panel has put into read-only mode (see ha_bridge.ts's
 * `controlDisabled`), so the setting survives an add-on restart instead of silently defaulting
 * every device back to control-enabled - the whole point of putting a food-safety-critical
 * appliance (fridge, kimchi fridge) into this mode is that it stays off until someone deliberately
 * turns it back on.
 */
export interface ControlState {
    getDisabledDevices(): string[]
    setDisabledDevices(ids: string[]): void
}

export class JSONControlState implements ControlState {
    constructor(readonly path: string) {}

    getDisabledDevices(): string[] {
        try {
            const parsed = JSON.parse(readFileSync(this.path).toString('utf-8'))
            return Array.isArray(parsed) ? (parsed as string[]) : []
        } catch (err) {
            return []
        }
    }

    setDisabledDevices(ids: string[]): void {
        writeFileSync(this.path, JSON.stringify(ids))
    }
}
