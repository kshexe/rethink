import { Environment, Thinq2DeviceState } from './thinqApi'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type Credentials = {
    refreshToken: string
    env: Environment
}

export type BridgeState = {
    getCredentials(): Credentials | undefined
    setCredentials(credentials: Credentials | undefined): void
    getDeviceState(id: string): Thinq2DeviceState | undefined
    setDeviceState(id: string, state: Thinq2DeviceState | undefined): void
    // The owner's per-appliance names (ThinQ aliases), cached so the first HA discovery after a
    // restart already carries the real name instead of the model-name fallback.
    getDeviceNames(): Record<string, string>
    setDeviceNames(names: Record<string, string>): void
}

export class JSONStorage implements BridgeState {
    constructor(readonly basePath: string) {}

    oauth2Path() {
        return `${this.basePath}/oauth2.json`
    }

    devicePath(id: string) {
        return `${this.basePath}/device_${id}.json`
    }

    namesPath() {
        return `${this.basePath}/names.json`
    }

    getCredentials() {
        try {
            return JSON.parse(readFileSync(this.oauth2Path()).toString('utf-8')) as Credentials
        } catch (err) {
            return undefined
        }
    }

    setCredentials(credentials: Credentials | undefined) {
        if (credentials) writeFileSync(this.oauth2Path(), JSON.stringify(credentials))
        else unlinkSync(this.oauth2Path())
    }

    getDeviceState(id: string) {
        try {
            return JSON.parse(readFileSync(this.devicePath(id)).toString('utf-8')) as Thinq2DeviceState
        } catch (err) {
            return undefined
        }
    }

    setDeviceState(id: string, state: Thinq2DeviceState | undefined) {
        if (state) writeFileSync(this.devicePath(id), JSON.stringify(state))
        else unlinkSync(this.devicePath(id))
    }

    getDeviceNames(): Record<string, string> {
        try {
            return JSON.parse(readFileSync(this.namesPath()).toString('utf-8')) as Record<string, string>
        } catch (err) {
            return {}
        }
    }

    setDeviceNames(names: Record<string, string>) {
        writeFileSync(this.namesPath(), JSON.stringify(names))
    }
}
