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

*/

/*
 *  Compact customIds for buttons, select menus and modals.
 *
 *  Discord accepts at most 100 characters in a customId. Servers paired through the Facepunch
 *  relay are keyed 'relay-<36-char GUID>', which made ids like
 *  StorageMonitorToolCupboardEveryone{"serverId":"relay-...","entityId":"..."} too long, and
 *  discord.js refused to send the whole message.
 *
 *  New format: <prefix>{"s":"<server>","e":<entity>} with short keys, and a long serverId replaced
 *  by '~' + a 10-char hash that is resolved back through the keys of instance.serverList.
 *  The old format ({"serverId":..,"entityId":..}) is still accepted for messages already posted.
 */

const Crypto = require('crypto');

const MAX_LENGTH = 100;
const RAW_SERVER_ID_MAX = 24;          /* ip-port keys stay readable, relay GUID keys get an alias */
const ALIAS_PREFIX = '~';

const LONG_TO_SHORT = { serverId: 's', entityId: 'e', groupId: 'g', trackerId: 't' };
const SHORT_TO_LONG = { s: 'serverId', e: 'entityId', g: 'groupId', t: 'trackerId' };

function serverAlias(serverId) {
    return ALIAS_PREFIX + Crypto.createHash('sha1').update(`${serverId}`).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').slice(0, 10);
}

function encodeServerId(serverId) {
    if (typeof serverId !== 'string' || serverId.length <= RAW_SERVER_ID_MAX) return serverId;
    return serverAlias(serverId);
}

/* An alias back to the real serverId (unknown alias: returned as is, handlers treat it as stale) */
function resolveServerId(instance, value) {
    if (typeof value !== 'string' || !value.startsWith(ALIAS_PREFIX)) return value;
    const keys = [];
    if (instance && instance.serverList) keys.push(...Object.keys(instance.serverList));
    if (instance && instance.serverListLite) keys.push(...Object.keys(instance.serverListLite));
    if (instance && instance.activeServer) keys.push(instance.activeServer);
    for (const key of keys) {
        if (serverAlias(key) === value) return key;
    }
    return value;
}

/** Builds `${prefix}{...}` with short keys. */
function make(prefix, ids = {}) {
    const short = {};
    for (const [key, value] of Object.entries(ids)) {
        const k = LONG_TO_SHORT[key] || key;
        short[k] = key === 'serverId' ? encodeServerId(value) : value;
    }
    return `${prefix}${JSON.stringify(short)}`;
}

/**
 *  Reads the ids of a customId made by make() (new format) or by the old code (long keys).
 *  Always returns long keys: { serverId, entityId, groupId, trackerId, ... }.
 */
function parse(prefix, customId, instance = null) {
    let raw = {};
    try {
        raw = JSON.parse(customId.startsWith(prefix) ? customId.slice(prefix.length) : customId);
    }
    catch (e) {
        raw = {};
    }
    if (raw === null || typeof raw !== 'object') raw = {};

    const ids = {};
    for (const [key, value] of Object.entries(raw)) {
        ids[SHORT_TO_LONG[key] || key] = value;
    }
    if (ids.hasOwnProperty('serverId')) ids.serverId = resolveServerId(instance, ids.serverId);
    return ids;
}

module.exports = {
    MAX_LENGTH,
    make,
    parse,
    serverAlias,
    encodeServerId,
    resolveServerId
};
