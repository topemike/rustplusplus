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
 *  "Device not found" notices are held back while the server is down, reconnecting or has just
 *  come back (a restarting server answers that nothing exists). After the grace period, the ones
 *  whose device still does not respond are sent; the rest are dropped.
 */

const GRACE_MS = 10 * 60 * 1000;

/* type -> list in the server object */
const LISTS = { switch: 'switches', alarm: 'alarms', storageMonitor: 'storageMonitors' };

function pendingFor(client, guildId) {
    if (!client.pendingDeviceNotices) client.pendingDeviceNotices = {};
    if (!client.pendingDeviceNotices[guildId]) client.pendingDeviceNotices[guildId] = {};
    return client.pendingDeviceNotices[guildId];
}

/* True when the connection is not stable enough to trust a "not found" answer */
function inGrace(client, guildId, now = Date.now()) {
    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    if (!rustplus || !rustplus.isOperational) return true;
    if (client.rustplusReconnecting && client.rustplusReconnecting[guildId]) return true;
    return !rustplus.operationalSince || now - rustplus.operationalSince < GRACE_MS;
}

module.exports = {
    GRACE_MS: GRACE_MS,
    inGrace: inGrace,

    /**
     *  @return {boolean} true if the notice must be sent now, false if it was held back.
     */
    shouldSendNow: function (client, guildId, type, serverId, entityId, now = Date.now()) {
        if (!inGrace(client, guildId, now)) return true;
        pendingFor(client, guildId)[`${type}:${serverId}:${entityId}`] = { type, serverId, entityId };
        return false;
    },

    /**
     *  Called periodically: after the grace period, sends the held-back notices whose device still
     *  does not respond. `send(type, serverId, entityId)` sends one.
     */
    flush: async function (client, guildId, send, now = Date.now()) {
        const pending = pendingFor(client, guildId);
        if (Object.keys(pending).length === 0 || inGrace(client, guildId, now)) return 0;
        const instance = client.getInstance(guildId);
        let sent = 0;
        for (const [key, p] of Object.entries(pending)) {
            delete pending[key];
            const server = instance.serverList[p.serverId];
            const entity = server && server[LISTS[p.type]] ? server[LISTS[p.type]][p.entityId] : null;
            if (!entity || entity.reachable !== false) continue;
            await send(p.type, p.serverId, p.entityId);
            sent++;
        }
        return sent;
    }
};
