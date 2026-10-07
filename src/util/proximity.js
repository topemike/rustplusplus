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
 *  Proximity modes (AUTO-ON/OFF-PROXIMITY), made safe for things like a SAM site:
 *  - "Someone near" counts at once; "nobody near" only after it lasts AWAY_CONFIRM_MS,
 *    so a short glitch in the team data (lag, a reconnect, someone respawning) does not flip it.
 *  - If the position of an online teammate cannot be read (missing or 0,0), it counts as near:
 *    it never decides "nobody is home" from data it does not have.
 */

const Map = require('./map.js');

const AWAY_CONFIRM_MS = 30 * 1000;

function hasPosition(player) {
    return Number.isFinite(player.x) && Number.isFinite(player.y) && !(player.x === 0 && player.y === 0);
}

module.exports = {
    AWAY_CONFIRM_MS: AWAY_CONFIRM_MS,
    hasPosition: hasPosition,

    /* What the team data says right now */
    check: function (rustplus, sw) {
        const result = { near: false, unknown: [], nearest: null, online: 0 };
        const players = (rustplus.team && rustplus.team.players) ? rustplus.team.players : [];
        for (const player of players) {
            if (!player.isOnline) continue;
            result.online++;
            if (!hasPosition(player)) {
                result.unknown.push(player.name);
                continue;
            }
            const distance = Map.getDistance(sw.x, sw.y, player.x, player.y);
            if (result.nearest === null || distance < result.nearest.distance) {
                result.nearest = { name: player.name, distance: Math.round(distance) };
            }
            if (distance <= sw.proximity) result.near = true;
        }
        return result;
    },

    /* Decision for the automatic mode: is someone near (with the "nobody near" confirmation time) */
    decide: function (rustplus, entityId, sw, now = Date.now()) {
        const state = module.exports.check(rustplus, sw);
        if (!rustplus.proximityAwaySince) rustplus.proximityAwaySince = {};

        if (state.near || state.unknown.length > 0) {
            delete rustplus.proximityAwaySince[entityId];
            state.decidedNear = true;
        }
        else {
            if (!rustplus.proximityAwaySince[entityId]) rustplus.proximityAwaySince[entityId] = now;
            state.decidedNear = (now - rustplus.proximityAwaySince[entityId]) < module.exports.AWAY_CONFIRM_MS;
        }
        return state;
    },

    /* AUTO-ON/OFF-ANY-ONLINE: is someone in the team online (with the same confirmation time,
       so a short glitch where everyone looks offline does not flip it) */
    decideOnline: function (rustplus, entityId, now = Date.now()) {
        const players = (rustplus.team && rustplus.team.players) ? rustplus.team.players : [];
        const online = players.filter(p => p.isOnline).map(p => p.name);
        if (!rustplus.onlineAwaySince) rustplus.onlineAwaySince = {};
        let decidedOnline;
        if (online.length > 0) {
            delete rustplus.onlineAwaySince[entityId];
            decidedOnline = true;
        }
        else {
            if (!rustplus.onlineAwaySince[entityId]) rustplus.onlineAwaySince[entityId] = now;
            decidedOnline = (now - rustplus.onlineAwaySince[entityId]) < module.exports.AWAY_CONFIRM_MS;
        }
        return { online: online, decidedOnline: decidedOnline };
    },

    /* Short text for logs and the in-game status: "tope a 35 m (límite 500 m)" */
    describe: function (client, guildId, sw, state) {
        const parts = [];
        if (state.nearest) {
            parts.push(client.intlGet(guildId, 'proximityNearest', {
                name: state.nearest.name, distance: state.nearest.distance, proximity: sw.proximity
            }));
        }
        else if (state.online === 0) {
            parts.push(client.intlGet(guildId, 'proximityNobodyOnline'));
        }
        if (state.unknown.length > 0) {
            parts.push(client.intlGet(guildId, 'proximityUnknown', { names: state.unknown.join(', ') }));
        }
        return parts.join(' ');
    }
};
