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
 *  "Device not found" notices are never sent on a single failed answer. They are held and the
 *  device is checked again while the server is ON: connected and answering. A notice goes out only
 *  when the server clearly answers "not found" several times in a row. A timeout, a lost
 *  connection or a server that does not come back counts for nothing, so a restart (or a server
 *  that stays down) never sends false notices. Devices that answer again are dropped silently.
 */

const CHECK_EVERY_MS = 30 * 1000;   /* between two checks of the same device */
const CONFIRMATIONS = 3;            /* "not found" answers in a row needed to send the notice */

/* type -> list in the server object */
const LISTS = { switch: 'switches', alarm: 'alarms', storageMonitor: 'storageMonitors' };

function pendingFor(client, guildId) {
    if (!client.pendingDeviceNotices) client.pendingDeviceNotices = {};
    if (!client.pendingDeviceNotices[guildId]) client.pendingDeviceNotices[guildId] = {};
    return client.pendingDeviceNotices[guildId];
}

/* The server answered: does the answer say the device does not exist? */
function answeredNotFound(response) {
    return !!response && typeof response === 'object' && response.error === 'not_found';
}
function answeredFound(response) {
    return !!response && typeof response === 'object' && !response.error && !!response.entityInfo;
}

/* Errors from Rust+ that mean "this device is not there for us" (gone, or no longer authorised) */
const MISSING_ERRORS = ['not_found', 'access_denied'];
/* Errors that say nothing about the device (busy server, our own request limit) */
const TRANSIENT_ERRORS = ['rate_limit', 'server_error'];
const loggedErrors = new Set();

/**
 *  What the server said about a device: 'found', 'missing' or 'unknown' (timeout, no answer, busy
 *  server). An error text not in the lists above is logged once, so a change in Rust+ is noticed
 *  instead of silently never sending a notice.
 */
function classify(response, client = null) {
    if (answeredFound(response)) return 'found';
    const error = response && typeof response === 'object' && typeof response.error === 'string' ? response.error : null;
    if (error === null) return 'unknown';
    if (MISSING_ERRORS.includes(error)) return 'missing';
    if (!TRANSIENT_ERRORS.includes(error) && !loggedErrors.has(error)) {
        loggedErrors.add(error);
        if (client && typeof client.log === 'function') {
            client.log(client.intlGet(null, 'warningCap'), `Device check: unexpected Rust+ answer "${error}"`, 'warn');
        }
    }
    return 'unknown';
}

module.exports = {
    answeredNotFound: answeredNotFound,
    answeredFound: answeredFound,
    classify: classify,
    CHECK_EVERY_MS: CHECK_EVERY_MS,
    CONFIRMATIONS: CONFIRMATIONS,

    /**
     *  Holds the notice until the device is confirmed missing with the server on.
     *  @return {boolean} always false: the notice is sent later by verify() if confirmed.
     */
    shouldSendNow: function (client, guildId, type, serverId, entityId) {
        const pending = pendingFor(client, guildId);
        const key = `${type}:${serverId}:${entityId}`;
        if (!pending[key]) pending[key] = { type, serverId, entityId, misses: 0, lastCheck: 0, session: null };
        return false;
    },

    /**
     *  Called on every poll, only once the server has answered (it is on). Checks the held devices
     *  again and calls `confirmed(type, serverId, entityId)` for the ones the server keeps
     *  reporting as not found.
     */
    verify: async function (client, rustplus, confirmed, now = Date.now()) {
        const guildId = rustplus.guildId;
        const pending = pendingFor(client, guildId);
        if (Object.keys(pending).length === 0 || !rustplus.isOperational) return 0;
        const instance = client.getInstance(guildId);
        let sent = 0;
        for (const [key, p] of Object.entries(pending)) {
            /* Another server, or the device was removed from the bot: forget it */
            const server = instance.serverList[p.serverId];
            const entity = server && server[LISTS[p.type]] ? server[LISTS[p.type]][p.entityId] : null;
            if (p.serverId !== rustplus.serverId || !entity) { delete pending[key]; continue; }

            /* New connection (the server went down meanwhile): start counting again */
            if (p.session !== rustplus.operationalSince) {
                p.session = rustplus.operationalSince;
                p.misses = 0;
                p.lastCheck = 0;
            }
            if (now - p.lastCheck < CHECK_EVERY_MS) continue;
            p.lastCheck = now;

            let response;
            try { response = await rustplus.getEntityInfoAsync(p.entityId); }
            catch (e) { response = undefined; }

            const state = classify(response, client);
            if (state === 'found') { delete pending[key]; continue; }
            if (state !== 'missing') continue;    /* timeout / no answer: proves nothing */

            p.misses++;
            if (p.misses < CONFIRMATIONS) continue;
            delete pending[key];
            await confirmed(p.type, p.serverId, p.entityId);
            sent++;
        }
        return sent;
    }
};
