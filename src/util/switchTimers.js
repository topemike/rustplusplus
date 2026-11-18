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
 *  Timers of the timed commands ("!sam off 10m", "!base on 5m").
 *  They are kept per Discord server on the client, not on the Rust+ connection: a reconnect
 *  creates a new connection object and the timers must survive it. Every connection's
 *  `currentSwitchTimeouts` points to the same per-guild object, so the old pattern
 *  `clearTimeout(rustplus.currentSwitchTimeouts[id]); delete rustplus.currentSwitchTimeouts[id];`
 *  keeps working.
 *  When a timer fires it uses the connection that is live at that moment. If there is none
 *  (reconnecting), it tries again every RETRY_MS, up to MAX_WAIT_MS, then gives up with a log.
 */

function forGuild(client, guildId) {
    if (!client.switchTimeouts) client.switchTimeouts = {};
    if (!client.switchTimeouts[guildId]) client.switchTimeouts[guildId] = {};
    const timers = client.switchTimeouts[guildId];
    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    if (rustplus) attach(rustplus, timers);
    return timers;
}

function attach(rustplus, timers) {
    if (rustplus.currentSwitchTimeouts === timers) return;
    const old = rustplus.currentSwitchTimeouts;
    if (old && typeof old === 'object') {
        for (const key of Object.keys(old)) {
            if (!timers.hasOwnProperty(key)) timers[key] = old[key];
        }
    }
    rustplus.currentSwitchTimeouts = timers;
}

/* Makes rustplus.currentSwitchTimeouts the per-guild object (call when a connection is created) */
function bind(client, rustplus) {
    if (!rustplus || !rustplus.guildId) return null;
    const timers = forGuild(client, rustplus.guildId);
    attach(rustplus, timers);
    return timers;
}

function liveRustplus(client, guildId, serverId) {
    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    if (!rustplus || rustplus.isDeleted || !rustplus.isOperational) return null;
    if (serverId && rustplus.serverId !== serverId) return null;
    return rustplus;
}

function has(client, guildId, key) {
    return forGuild(client, guildId).hasOwnProperty(`${key}`);
}

/* Cancels the pending timer of a switch or group (nothing happens when the time is up) */
function clear(client, guildId, key) {
    const timers = forGuild(client, guildId);
    if (!timers.hasOwnProperty(`${key}`)) return false;
    clearTimeout(timers[`${key}`]);
    delete timers[`${key}`];
    return true;
}

/**
 *  Arms a timer for a switch / group. fn(rustplus) runs with the live connection when the
 *  time is up (waiting for it if the bot is reconnecting).
 */
function arm(client, guildId, serverId, key, ms, fn, label = `${key}`) {
    key = `${key}`;
    const timers = forGuild(client, guildId);
    clear(client, guildId, key);

    let waitingSince = null;
    let handle = null;
    const fire = async function () {
        if (timers[key] !== handle) return;        /* cancelled or replaced */
        const rustplus = liveRustplus(client, guildId, serverId);
        if (!rustplus) {
            if (waitingSince === null) waitingSince = Date.now();
            if (Date.now() - waitingSince >= module.exports.MAX_WAIT_MS) {
                delete timers[key];
                client.log(client.intlGet(null, 'warningCap'),
                    `Timed command ${label}: not connected to the server for ` +
                    `${Math.round(module.exports.MAX_WAIT_MS / 1000)} s, given up.`, 'warning');
                return;
            }
            handle = setTimeout(fire, module.exports.RETRY_MS);
            timers[key] = handle;
            return;
        }
        delete timers[key];
        try {
            await fn(rustplus);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Timed command ${label} failed: ${e}`, 'error');
        }
    };
    handle = setTimeout(fire, ms);
    timers[key] = handle;
    return handle;
}

module.exports = {
    RETRY_MS: 15 * 1000,
    MAX_WAIT_MS: 5 * 60 * 1000,
    forGuild: forGuild,
    bind: bind,
    has: has,
    clear: clear,
    arm: arm,
    liveRustplus: liveRustplus
};
