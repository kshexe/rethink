#!/usr/bin/with-contenv bashio
# ==============================================================================
# Generates rethink-cloud's config.json from the add-on options, every start
# (not just once) so option changes are always picked up on restart. State that
# must survive a reconfigure - the CA, the bridge's per-device store - lives
# under /data, outside this generated file.
# ==============================================================================
HOSTNAME=$(bashio::config 'hostname')
MQTT_HOST=$(bashio::config 'mqtt_host')
MQTT_PORT=$(bashio::config 'mqtt_port')
MQTT_USER=$(bashio::config 'mqtt_user')
MQTT_PASS=$(bashio::config 'mqtt_pass')
LANGUAGE=$(bashio::config 'language')
ADVERTISE_REQUESTED_HOST=$(bashio::config 'advertise_requested_host')

mkdir -p /data/state

jq -n \
  --arg hostname "$HOSTNAME" \
  --arg mqtt_url "mqtt://${MQTT_HOST}:${MQTT_PORT}" \
  --arg mqtt_user "$MQTT_USER" \
  --arg mqtt_pass "$MQTT_PASS" \
  --arg language "$LANGUAGE" \
  --argjson advertise_requested_host "$ADVERTISE_REQUESTED_HOST" \
  '{
    hostname: $hostname,
    advertise_requested_host: $advertise_requested_host,
    homeassistant: ({
      mqtt_url: $mqtt_url,
      discovery_prefix: "homeassistant",
      rethink_prefix: "rethink",
      mqtt_user: $mqtt_user,
      mqtt_pass: $mqtt_pass
    } + (if $language != "" then {language: $language} else {} end)),
    ca_key_file: "/data/ca.key",
    ca_cert_file: "/data/ca.cert",
    https_port: 4433,
    mqtts_port: 8886,
    mqtt_port: 1884,
    thinq1_https_port: 46030,
    thinq1_port: 47878,
    management_port: 44401,
    bridge: { storage_path: "/data/state" },
    log: ["status", "incoming", "HTTPS", "publish", "MGMT"]
  }' > /data/config.json

bashio::log.info "Generated /data/config.json (mqtt=${MQTT_HOST}:${MQTT_PORT}, hostname=${HOSTNAME})"

if [ "$HOSTNAME" = "rethink.lan" ]; then
  bashio::log.warning "hostname is still the default 'rethink.lan' - this needs to resolve via regular DNS on your LAN (not mDNS/.local). Point it at this add-on's host, e.g. a static DNS entry in your router/UniFi."
fi
