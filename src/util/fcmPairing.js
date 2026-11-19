/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

    Entity pairing (Smart Switch / Smart Alarm / Storage Monitor) shared by the FCM listener of the
    hoster (FcmListener.js) and the FCM listeners of the other accounts (FcmListenerLite.js).
*/

const Constants = require('./constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const Map = require('./map.js');
const RustRelay = require('./rustRelay.js');

/* Fields kept from an already paired entity; the defaults for a new one */
function newSwitch(client, guildId, body, old) {
    return {
        active: old ? old.active : false,
        reachable: old ? old.reachable : true,
        name: old ? old.name : client.intlGet(guildId, 'smartSwitch'),
        command: old ? old.command : body.entityId,
        image: old ? old.image : 'smart_switch.png',
        autoDayNightOnOff: old ? old.autoDayNightOnOff : 0,
        location: old ? old.location : null,
        x: old ? old.x : null,
        y: old ? old.y : null,
        server: old ? old.server : body.name,
        proximity: old ? old.proximity : Constants.PROXIMITY_SETTING_DEFAULT_METERS,
        messageId: old ? old.messageId : null
    };
}

function newAlarm(client, guildId, body, old) {
    return {
        active: old ? old.active : false,
        reachable: old ? old.reachable : true,
        everyone: old ? old.everyone : false,
        name: old ? old.name : client.intlGet(guildId, 'smartAlarm'),
        message: old ? old.message : client.intlGet(guildId, 'baseIsUnderAttack'),
        lastTrigger: old ? old.lastTrigger : null,
        command: old ? old.command : body.entityId,
        id: old ? old.id : body.entityId,
        image: old ? old.image : 'smart_alarm.png',
        location: old ? old.location : null,
        server: old ? old.server : body.name,
        messageId: old ? old.messageId : null
    };
}

function newStorageMonitor(client, guildId, body, old) {
    return {
        name: old ? old.name : client.intlGet(guildId, 'storageMonitor'),
        reachable: old ? old.reachable : true,
        id: old ? old.id : body.entityId,
        type: old ? old.type : null,
        decaying: old ? old.decaying : false,
        upkeep: old ? old.upkeep : null,
        everyone: old ? old.everyone : false,
        inGame: old ? old.inGame : true,
        image: old ? old.image : 'storage_monitor.png',
        location: old ? old.location : null,
        server: old ? old.server : body.name,
        messageId: old ? old.messageId : null
    };
}

const KINDS = {
    switch: { list: 'switches', create: newSwitch, send: 'sendSmartSwitchMessage', xy: true },
    alarm: { list: 'alarms', create: newAlarm, send: 'sendSmartAlarmMessage', xy: false },
    storageMonitor: { list: 'storageMonitors', create: newStorageMonitor, send: 'sendStorageMonitorMessage', xy: false }
};

/**
 *  Stores a paired entity and sends/updates its Discord message.
 *  @param kind 'switch' | 'alarm' | 'storageMonitor'
 *  @param tag log prefix ('FCM Host' / 'FCM LITE')
 *  @return the serverId it was stored in, or null.
 */
async function pairEntity(client, guild, body, kind, tag) {
    const def = KINDS[kind];
    const guildId = guild.id;
    const instance = client.getInstance(guildId);
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) {
        client.log(tag, `GuildID: ${guildId}, pairing ${kind} ${body.entityId}: notification without ` +
            `ip/port or relay id, ignored.`);
        return null;
    }
    const serverId = address.serverId;
    if (!instance.serverList.hasOwnProperty(serverId)) {
        client.log(tag, `GuildID: ${guildId}, pairing ${kind} ${body.entityId}: server ${serverId} ` +
            `("${body.name}") is not paired with the bot. Pair the server first (in game: Rust+ > Pair).`);
        if (address.updated) client.setInstance(guildId, instance);
        return null;
    }

    const server = instance.serverList[serverId];
    if (!server[def.list]) server[def.list] = {};
    const old = server[def.list].hasOwnProperty(body.entityId) ? server[def.list][body.entityId] : null;
    server[def.list][body.entityId] = def.create(client, guildId, body, old);
    client.setInstance(guildId, instance);

    const entity = server[def.list][body.entityId];
    const rustplus = client.rustplusInstances[guildId];
    if (rustplus && serverId === rustplus.serverId) {
        try {
            const info = await rustplus.getEntityInfoAsync(body.entityId);
            const valid = await rustplus.isResponseValid(info);
            const payload = valid && info.entityInfo ? info.entityInfo.payload : null;
            /* Fresh answer: reachable or not now (also when re-pairing) */
            entity.reachable = !!payload;

            /* Location of the player who paired it (optional: needs info and map) */
            try {
                const mapSize = rustplus.info ? rustplus.info.correctedMapSize : null;
                if (mapSize && rustplus.map) {
                    const teamInfo = await rustplus.getTeamInfoAsync();
                    if ((await rustplus.isResponseValid(teamInfo)) && teamInfo.teamInfo) {
                        const pairer = `${body.playerId || rustplus.playerId}`;
                        const player = (teamInfo.teamInfo.members || []).find(e => `${e.steamId}` === pairer);
                        if (player) {
                            const location = Map.getPos(player.x, player.y, mapSize, rustplus);
                            entity.location = location.location;
                            if (def.xy) {
                                entity.x = location.x;
                                entity.y = location.y;
                            }
                        }
                    }
                }
            }
            catch (e) {
                client.log(client.intlGet(null, 'errorCap'), `Pairing ${kind} ${body.entityId}: location: ${e}`, 'error');
            }

            if (payload) {
                if (kind === 'switch' || kind === 'alarm') {
                    entity.active = payload.value;
                }
                else {
                    if (payload.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY) {
                        entity.type = 'toolCupboard';
                        entity.image = 'tool_cupboard.png';
                        if (payload.protectionExpiry === 0) entity.decaying = true;
                    }
                    else if (payload.capacity === Constants.STORAGE_MONITOR_VENDING_MACHINE_CAPACITY) {
                        entity.type = 'vendingMachine';
                        entity.image = 'vending_machine.png';
                    }
                    else if (payload.capacity === Constants.STORAGE_MONITOR_LARGE_WOOD_BOX_CAPACITY) {
                        entity.type = 'largeWoodBox';
                        entity.image = 'large_wood_box.png';
                    }

                    if (!rustplus.storageMonitors) rustplus.storageMonitors = {};
                    rustplus.storageMonitors[body.entityId] = {
                        items: payload.items,
                        expiry: payload.protectionExpiry,
                        capacity: payload.capacity,
                        hasProtection: payload.hasProtection
                    };
                }
            }
            client.setInstance(guildId, instance);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Pairing ${kind} ${body.entityId}: ${e}`, 'error');
        }
    }

    /* Always shown in Discord, also when the bot is not connected to that server right now */
    try {
        await DiscordMessages[def.send](guildId, serverId, body.entityId);
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Pairing ${kind} ${body.entityId}: ` +
            `could not send the Discord message: ${e}`, 'error');
    }
    return serverId;
}

/* JSON of an FCM notification for the logs, without the secrets (player token, auth data). */
function redactNotification(data) {
    const SECRET = /token|auth|secret|password|key$/i;
    const seen = new WeakSet();
    const redact = (value) => {
        if (typeof value === 'string') {
            if (value.length > 0 && (value.trim().startsWith('{') || value.trim().startsWith('['))) {
                try {
                    return JSON.stringify(redact(JSON.parse(value)));
                }
                catch (e) { /* plain string */ }
            }
            return value;
        }
        if (value === null || typeof value !== 'object') return value;
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        if (Buffer.isBuffer(value)) return '[binary]';
        if (Array.isArray(value)) {
            return value.map((item) => {
                /* appData: [{ key, value }] */
                if (item && typeof item === 'object' && typeof item.key === 'string' && SECRET.test(item.key) &&
                    item.key !== 'key') {
                    return Object.assign({}, item, { value: '[redacted]' });
                }
                return redact(item);
            });
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = (SECRET.test(k) && k !== 'key') ? '[redacted]' : redact(v);
        }
        return out;
    };
    try {
        return JSON.stringify(redact(data));
    }
    catch (e) {
        return '[unserializable]';
    }
}

module.exports = { pairEntity, redactNotification };
