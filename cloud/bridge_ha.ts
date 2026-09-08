/*
 * Publishes the LG-cloud "bridge" login flow as ordinary HA entities under one virtual
 * "Rethink Bridge" device, instead of the (now removed) management web panel's login modal.
 *
 * LG's OAuth has no way to register a redirect_uri that points back at this add-on (it always
 * lands on LG's own fixed page, kr.m.lgaccount.com/login/iabClose - see bridge/thinqApi.ts), so
 * there is no way around the user opening the real login page and pasting the resulting URL back
 * in. What used to be a dedicated web page for exactly that becomes:
 *
 * - a `text` entity for the country code (2-letter, defaults to KR)
 * - a `sensor` entity holding the actual sign-in URL for that country code, to open manually
 * - a `text` entity to paste the final (blank) page's URL into once logged in
 * - a `binary_sensor` for whether the bridge is currently logged in
 * - a `button` to log out
 */

import { Bridge } from '@/bridge'
import { Connection, DeviceDiscovery, ComponentInfo } from './homeassistant'
import log from '@/util/logging'

const ID = 'bridge'

export class BridgeHA {
    countryCode = 'KR'

    constructor(
        readonly bridge: Bridge,
        readonly HA: Connection,
    ) {
        HA.on('discovery', () => this.publish())
        HA.on('setProperty', (id, prop, value) => {
            if (id !== ID) return
            void this.handleSet(prop, value)
        })
        bridge.on('loggedIn', () => this.publishLoginState())
        bridge.on('loggedOut', () => this.publishLoginState())

        this.publish()
    }

    private config(): DeviceDiscovery {
        const countryCodeComp = {
            platform: 'text',
            unique_id: '$deviceid-country_code',
            state_topic: '$this/country_code',
            command_topic: '$this/country_code/set',
            name: '국가코드',
            icon: 'mdi:earth',
            pattern: '^[A-Za-z]{2}$',
            min: 2,
            max: 2,
            entity_category: 'config',
        } as const

        const loginUrlComp = {
            platform: 'sensor',
            unique_id: '$deviceid-login_url',
            state_topic: '$this/login_url',
            name: 'LG 로그인 URL',
            icon: 'mdi:link-variant',
            entity_category: 'diagnostic',
        } as const

        const loginPasteComp = {
            platform: 'text',
            unique_id: '$deviceid-login_paste',
            state_topic: '$this/login_paste',
            command_topic: '$this/login_paste/set',
            name: '로그인 완료 URL 붙여넣기',
            icon: 'mdi:content-paste',
            max: 2000,
            entity_category: 'config',
        } as const

        const loggedInComp = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-logged_in',
            state_topic: '$this/logged_in',
            name: '로그인됨',
            icon: 'mdi:account-check',
            entity_category: 'diagnostic',
        } as const

        const logoutComp = {
            platform: 'button',
            unique_id: '$deviceid-logout',
            command_topic: '$this/logout/set',
            payload_press: '',
            name: '로그아웃',
            icon: 'mdi:logout',
            entity_category: 'config',
        } as const

        const components: Record<string, ComponentInfo> = {
            country_code: countryCodeComp,
            login_url: loginUrlComp,
            login_paste: loginPasteComp,
            logged_in: loggedInComp,
            logout: logoutComp,
        }

        return {
            device: {
                identifiers: '$deviceid',
                manufacturer: 'rethink',
                name: 'Rethink Bridge',
            },
            origin: { name: 'rethink', support_url: 'https://github.com/anszom/rethink' },
            availability: [
                { topic: '$rethink/availability', payload_available: 'online', payload_not_available: 'offline' },
            ],
            components,
        }
    }

    publish() {
        this.HA.publishConfig(ID, this.config())
        this.HA.publishProperty(ID, 'country_code', this.countryCode)
        this.HA.publishProperty(ID, 'login_paste', '')
        this.publishLoginState()
        void this.publishLoginUrl()
    }

    publishLoginState() {
        this.HA.publishProperty(ID, 'logged_in', this.bridge.isLoggedIn() ? 'ON' : 'OFF')
    }

    async publishLoginUrl() {
        try {
            const url = await this.bridge.beginLogin({ countryCode: this.countryCode })
            this.HA.publishProperty(ID, 'login_url', url.toString())
        } catch (err) {
            log('status', `Could not build the LG login URL: ${err}`)
            this.HA.publishProperty(ID, 'login_url', undefined)
        }
    }

    async handleSet(prop: string, value: string) {
        if (prop === 'country_code') {
            this.countryCode = value.trim().toUpperCase()
            this.HA.publishProperty(ID, 'country_code', this.countryCode)
            await this.publishLoginUrl()
        } else if (prop === 'login_paste') {
            let ok = false
            try {
                ok = await this.bridge.completeLogin({ countryCode: this.countryCode }, new URL(value))
            } catch (err) {
                log('status', `LG login failed: ${err}`)
            }
            this.HA.publishProperty(ID, 'login_paste', '')
            log('status', ok ? 'LG login succeeded' : 'LG login failed - check the pasted URL and country code')
        } else if (prop === 'logout') {
            this.bridge.logout()
        }
    }
}
