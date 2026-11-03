export type ClipMessage<Cmd = string, Payload = unknown> = {
    mid: number
    did: string
    kind: string
    cmd: Cmd
    rssi?: number
    fs?: string
    data: Payload
    type: number
}

export type DeployAppInfo = {
    modelName: string
    modelLanguage: string
    softVer: string
    ruleVer: string
    countryCode: string
    subCountryCode: string
    appVersion: string
    modemType: string
    regionalCode: string
    timezone: string
    svcCode: string
    HomeApSsid: string
    DeviceType: string
    protocolVer?: string
    // Some devices send this; it influences which modelJSON LG's own backend serves them
    // (anszom/rethink#bfbd227). Shown in the management panel for now.
    packageId?: string
    // and some other fields yadda yadda
    [key: string]: unknown
}

export type DeployPayload = {
    appInfo: DeployAppInfo
    // present in real device deploys alongside appInfo; carries provisioningKey/version
    platformInfo?: { provisioningKey?: string; version?: string; [key: string]: unknown }
    // boot/wifi diagnostics the device tacks on; we don't forward these upstream
    [key: string]: unknown
}

export type ClipDeployMessage = ClipMessage<'preDeploy' | 'deploy', DeployPayload>
