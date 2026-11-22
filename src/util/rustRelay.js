/*
    Copyright (C) 2026 rustplusplus contributors

    Rust+ relay connection.

    Since the 2026-11-05 Rust update ("RustRelay - use Fleck instead of websocket-sharp") game
    servers drop direct ws://<ip>:<app.port> connections. Clients connect through the
    Facepunch relay instead:

        wss://companion-rust.facepunch.com/socket/<relayServerId>?v=<ms>
        subprotocols: ["rustplus.auth.v1", base64url(<Rust+ auth token>)]
        origin:       https://app.playrust.com

    - relayServerId is the "id" field of the in-game pairing notification. It is stored on the
      server entry when pairing and stays the same across wipes.
    - The auth token is the Rust+ (Steam login) token from the credentials app. It is stored per
      steamId in the credentials file and is valid for ~14 days.

    connect() mirrors @liamcottle/rustplus.js connect() (same events and seq callback handling),
    only the address and handshake differ.
*/

const Path = require('path');

const InstanceUtils = require('./instanceUtils.js');

/* Resolve ws/protobufjs from the library's own location so versions always match it. */
const LIB_DIR = Path.dirname(require.resolve('@liamcottle/rustplus.js'));
const WebSocket = require(require.resolve('ws', { paths: [LIB_DIR] }));
const protobuf = require(require.resolve('protobufjs', { paths: [LIB_DIR] }));
const PROTO_PATH = Path.join(LIB_DIR, 'rustplus.proto');

const RELAY_HOST = 'companion-rust.facepunch.com';
const RELAY_ORIGIN = 'https://app.playrust.com';
const RELAY_SUBPROTOCOL = 'rustplus.auth.v1';

function b64url(str) {
    return Buffer.from(str, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Accept the token as pasted from the credentials callback URL (it may still be URL-encoded). */
function normaliseAuthToken(token) {
    if (typeof token !== 'string') return null;
    let normalised = token.trim();
    if (normalised.includes('%')) {
        try { normalised = decodeURIComponent(normalised); } catch (e) { /* keep as is */ }
    }
    return normalised.length > 0 ? normalised : null;
}

/* Token format: base64(json payload).signature, payload = { steamId, version, iss, exp } */
function parseAuthToken(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString('utf8'));
        return {
            steamId: payload.steamId ? `${payload.steamId}` : null,
            issuedAt: Number(payload.iss) || null,
            expiresAt: Number(payload.exp) || null
        };
    }
    catch (e) {
        return null;
    }
}

/* Connection health limits (see connect) */
const WATCHDOG = { handshakeMs: 30 * 1000, checkMs: 30 * 1000, silentMs: 3 * 60 * 1000 };

/* Seconds to wait between connection attempts when the relay refuses the token (or it expired). */
const SLOW_RETRY_MS = 5 * 60 * 1000;

/*
    Relay details for a server/player with the reason when they cannot be used:
    { relay: {relayServerId, authToken, expiresAt} | null, reason, relayServerId, expiresAt }
    reason: 'ok' | 'expired' (relay set, token expired) | 'noInstance' | 'noRelayId' | 'noToken'
*/
function resolveDetailed(guildId, serverIp, appPort, steamId) {
    const Client = require('../../index.ts');
    const instance = Client.client.getInstance(guildId);
    if (!instance) return { relay: null, reason: 'noInstance', relayServerId: null, expiresAt: null };

    const serverKey = `${serverIp}-${appPort}`;
    let relayServerId = null;

    const server = instance.serverList ? instance.serverList[serverKey] : null;
    if (server && server.relayServerId) relayServerId = server.relayServerId;

    if (!relayServerId && instance.serverListLite && instance.serverListLite[serverKey]) {
        for (const lite of Object.values(instance.serverListLite[serverKey])) {
            if (lite && lite.relayServerId) {
                relayServerId = lite.relayServerId;
                break;
            }
        }
    }
    /* Keyed by the relay id itself ('relay-<id>') */
    if (!relayServerId && `${serverIp}` === 'relay' && appPort) relayServerId = `${appPort}`;
    if (!relayServerId) return { relay: null, reason: 'noRelayId', relayServerId: null, expiresAt: null };

    let credentials = null;
    try {
        credentials = InstanceUtils.readCredentialsFile(guildId);
    }
    catch (e) {
        credentials = null;
    }
    const credential = credentials ? credentials[`${steamId}`] : null;
    const authToken = credential ? normaliseAuthToken(credential.rustplus_auth_token) : null;
    if (!authToken) return { relay: null, reason: 'noToken', relayServerId: relayServerId, expiresAt: null };

    const parsed = parseAuthToken(authToken);
    const expiresAt = parsed ? parsed.expiresAt : null;
    const relay = { relayServerId: relayServerId, authToken: authToken, expiresAt: expiresAt };
    const expired = expiresAt !== null && expiresAt * 1000 < Date.now();
    return { relay: relay, reason: expired ? 'expired' : 'ok', relayServerId: relayServerId, expiresAt: expiresAt };
}

/* Relay details for a server/player, or null when the server has no relay id or the player has
   no auth token (caller then falls back to a direct connection, never for 'relay' servers). */
function resolve(guildId, serverIp, appPort, steamId) {
    return resolveDetailed(guildId, serverIp, appPort, steamId).relay;
}

/* HTTP status when the error is the relay refusing the websocket handshake (401/403), else null. */
function refusalStatus(err) {
    if (!err) return null;
    const match = `${err.message || err}`.match(/Unexpected server response: (\d{3})/);
    if (!match) return null;
    const status = parseInt(match[1]);
    return (status === 401 || status === 403) ? status : null;
}

/*
    One Discord warning (activity channel) per guild/account/token when the relay refuses the token,
    the token expired or there is none: "run /credentials add again with a new rustplus_auth_token".
    reason: 'refused' | 'expired' | 'noToken'. Returns true if a message was sent.
*/
async function warnTokenProblem(client, guildId, steamId, reason, extra = {}) {
    try {
        if (!client.rustRelayTokenWarnings) client.rustRelayTokenWarnings = new Object();
        if (!client.rustRelayTokenWarnings[guildId]) client.rustRelayTokenWarnings[guildId] = new Object();
        const warned = client.rustRelayTokenWarnings[guildId];
        const key = `${steamId}|${extra.expiresAt || 'none'}`;
        if (warned[key]) return false;
        warned[key] = true;

        const reasonText = reason === 'refused' ?
            client.intlGet(guildId, 'relayTokenReasonRefused', { status: extra.status || '401' }) :
            reason === 'expired' ?
                client.intlGet(guildId, 'relayTokenReasonExpired', {
                    date: extra.expiresAt ? `<t:${extra.expiresAt}:F>` : '-'
                }) :
                client.intlGet(guildId, 'relayTokenReasonMissing');
        const text = client.intlGet(guildId, 'relayTokenProblemDesc', {
            steamId: `${steamId}`,
            reason: reasonText,
            minutes: `${Math.round(SLOW_RETRY_MS / 60000)}`
        });
        client.log(client.intlGet(null, 'warningCap'),
            `Rust+ relay token problem (${reason}) for ${steamId} in guild ${guildId}.`, 'warn');

        const instance = client.getInstance(guildId);
        const channelId = instance && instance.channelId ? instance.channelId.activity : null;
        if (!channelId) return false;

        const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
        const DiscordMessages = require('../discordTools/discordMessages.js');
        const Constants = require('./constants.js');
        await DiscordMessages.sendMessage(guildId, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_INACTIVE,
                title: client.intlGet(guildId, 'relayTokenProblemTitle'),
                description: text,
                timestamp: true
            })]
        }, null, channelId);
        return true;
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Rust+ relay token warning: ${e}`, 'error');
        return false;
    }
}

/* A connection of steamId worked: its next problem warns again. */
function clearTokenWarning(client, guildId, steamId) {
    const warned = client.rustRelayTokenWarnings ? client.rustRelayTokenWarnings[guildId] : null;
    if (!warned) return;
    for (const key of Object.keys(warned)) {
        if (key.startsWith(`${steamId}|`)) delete warned[key];
    }
}

function connect(rustplus, relay) {
    protobuf.load(PROTO_PATH).then((root) => {
        /* make sure existing connection is disconnected before connecting again */
        if (rustplus.websocket) rustplus.disconnect();

        rustplus.AppRequest = root.lookupType('rustplus.AppRequest');
        rustplus.AppMessage = root.lookupType('rustplus.AppMessage');

        rustplus.emit('connecting');

        const address = `wss://${RELAY_HOST}/socket/${relay.relayServerId}?v=${Date.now()}`;
        /* Without a handshake limit a relay that accepts the TCP connection and never answers the
           upgrade leaves the bot "connecting" forever ('close' never fires, no reconnection). */
        const ws = new WebSocket(address, [RELAY_SUBPROTOCOL, b64url(relay.authToken)], {
            origin: RELAY_ORIGIN,
            handshakeTimeout: WATCHDOG.handshakeMs
        });
        rustplus.websocket = ws;

        /* Watchdog: requests sent and no answer at all for WATCHDOG.silentMs (half-open socket, relay
           that lost the game server): the socket is closed, 'disconnected' reconnects. Pings keep
           idle connections (leader connection) alive through NATs. */
        let waitingSince = null;
        const onRequest = () => { if (waitingSince === null) waitingSince = Date.now(); };
        rustplus.on('request', onRequest);
        let watchdog = null;
        const stopWatchdog = () => {
            if (watchdog) clearInterval(watchdog);
            watchdog = null;
            rustplus.removeListener('request', onRequest);
        };
        ws.markAnswered = () => { waitingSince = null; };

        ws.on('open', () => {
            waitingSince = null;
            watchdog = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (waitingSince !== null && Date.now() - waitingSince > WATCHDOG.silentMs) {
                    if (typeof rustplus.log === 'function') {
                        rustplus.log('WARNING', `Rust+ relay: no answer for ${Math.round((Date.now() - waitingSince) / 1000)} s, ` +
                            'closing the connection to reconnect.', 'warn');
                    }
                    stopWatchdog();
                    ws.terminate();
                    return;
                }
                try { ws.ping(); } catch (e) { /* closing */ }
            }, WATCHDOG.checkMs);
            rustplus.emit('connected');
        });

        ws.on('error', (e) => {
            rustplus.emit('error', e);
        });

        ws.on('message', (data, isBinary) => {
            /* The relay may send text frames; only binary frames are protobuf AppMessages. */
            if (!isBinary) return;

            let message;
            try {
                message = rustplus.AppMessage.decode(data);
            }
            catch (e) {
                if (typeof rustplus.log === 'function') {
                    rustplus.log('ERROR', `Rust+ relay: could not decode a message (${data ? data.length : 0} ` +
                        `bytes): ${e.message}`, 'error');
                }
                return;
            }

            if (message.response) ws.markAnswered();

            if (message.response && message.response.seq && rustplus.seqCallbacks[message.response.seq]) {
                const callback = rustplus.seqCallbacks[message.response.seq];
                const result = callback(message);
                delete rustplus.seqCallbacks[message.response.seq];
                if (result) return;
            }

            rustplus.emit('message', message);
        });

        ws.on('close', (code, reason) => {
            stopWatchdog();
            rustplus.lastCloseCode = code;
            if (typeof rustplus.log === 'function') {
                const why = reason && reason.length ? ` (${reason.toString().slice(0, 100)})` : '';
                rustplus.log('INFO', `Rust+ relay connection closed, code ${code}${why}.`);
            }
            rustplus.emit('disconnected');
        });
    }).catch((e) => {
        rustplus.emit('error', e);
    });
}

/*
    Since the relay change, pairing notifications may no longer carry ip/port, only the relay
    server id ("id"). ip/port are only used as the server's key in the instance file. Lookup order:
      1. an entry (serverList, then serverListLite) already paired with the same relay id, the
         active server first when there are several;
      2. ip/port when the notification has them (the entry gets the relay id if it lacks it);
      3. an entry paired before the relay change (no relay id) with the same server name: it gets
         the relay id now (re-pairing the server/devices fixes it);
      4. 'relay-<id>'.
    It may store relayServerId on the given instance: the caller saves it (address.updated true).
*/
function pairingAddress(instance, body) {
    const relayId = body.id ? `${body.id}` : null;
    const serverList = instance.serverList || {};
    const serverListLite = instance.serverListLite || {};
    const active = instance.activeServer || null;
    const pick = (ids) => ids.includes(active) ? active : ids[0];

    if (relayId) {
        const ids = Object.keys(serverList).filter(id =>
            serverList[id] && serverList[id].serverIp && `${serverList[id].relayServerId}` === relayId);
        if (ids.length > 0) {
            const id = pick(ids);
            return { serverIp: serverList[id].serverIp, appPort: serverList[id].appPort, serverId: id };
        }

        const liteIds = [];
        const liteEntry = {};
        for (const [serverId, lites] of Object.entries(serverListLite)) {
            for (const lite of Object.values(lites || {})) {
                if (lite && lite.serverIp && `${lite.relayServerId}` === relayId) {
                    liteIds.push(serverId);
                    liteEntry[serverId] = lite;
                    break;
                }
            }
        }
        if (liteIds.length > 0) {
            const id = pick(liteIds);
            return { serverIp: liteEntry[id].serverIp, appPort: liteEntry[id].appPort, serverId: id };
        }
    }

    if (body.ip && body.port) {
        const serverId = `${body.ip}-${body.port}`;
        let updated = false;
        if (relayId && serverList[serverId] && !serverList[serverId].relayServerId) {
            serverList[serverId].relayServerId = relayId;
            updated = true;
        }
        return { serverIp: `${body.ip}`, appPort: `${body.port}`, serverId: serverId, updated: updated };
    }
    if (!relayId) return null;

    /* Paired before the relay change: same name, no relay id yet */
    const name = body.name ? `${body.name}`.trim() : null;
    if (name) {
        const ids = Object.keys(serverList).filter(id => serverList[id] && serverList[id].serverIp &&
            !serverList[id].relayServerId && `${serverList[id].title || ''}`.trim() === name);
        if (ids.length > 0) {
            const id = pick(ids);
            serverList[id].relayServerId = relayId;
            for (const lite of Object.values(serverListLite[id] || {})) {
                if (lite && !lite.relayServerId) lite.relayServerId = relayId;
            }
            return { serverIp: serverList[id].serverIp, appPort: serverList[id].appPort, serverId: id, updated: true };
        }
    }

    return { serverIp: 'relay', appPort: relayId, serverId: `relay-${relayId}` };
}

module.exports = {
    resolve, resolveDetailed, connect, pairingAddress, normaliseAuthToken, parseAuthToken,
    refusalStatus, warnTokenProblem, clearTokenWarning, SLOW_RETRY_MS, WATCHDOG
};
