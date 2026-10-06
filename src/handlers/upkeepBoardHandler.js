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
 *  Upkeep board in the information channel: every Tool Cupboard with a Storage Monitor, with the
 *  time left in hours and minutes (the message is edited once a minute) and the exact date.
 */

const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const UpkeepRates = require('../util/upkeepRates.js');

const HOUR_MS = 60 * 60 * 1000;
const signatures = new Object();


function getTcList(instance, rustplus) {
    const server = instance.serverList[rustplus.serverId];
    if (!server) return [];
    const list = [];
    for (const [entityId, entity] of Object.entries(server.storageMonitors || {})) {
        const content = rustplus.storageMonitors ? rustplus.storageMonitors[entityId] : null;
        const isTc = entity.type === 'toolCupboard' ||
            (content && content.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY);
        if (!isTc) continue;
        list.push({
            id: entityId,
            name: entity.name,
            location: entity.location,
            reachable: entity.reachable !== false && !!content && content.capacity !== 0,
            expiry: content && content.expiry ? content.expiry : 0,
            breakdown: content ? UpkeepRates.breakdown(entity, content.items, content.expiry) : null
        });
    }
    /* Most urgent first: decaying / no data, then by time left */
    const rank = (tc) => (!tc.reachable || !tc.expiry) ? -1 : tc.expiry;
    return list.sort((a, b) => rank(a) - rank(b));
}

/* "14h 23m", "2d 3h 5m" (minutes, the board is refreshed every minute) */
function hoursMinutes(ms) {
    const total = Math.max(0, Math.ceil(ms / 60000));
    const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
    return (d ? `${d}d ` : '') + ((d || h) ? `${h}h ` : '') + `${m}m`;
}

function line(client, guildId, tc, now) {
    const where = tc.location ? ` (${tc.location})` : '';
    if (!tc.reachable) return client.intlGet(guildId, 'upkeepBoardNoData', { name: tc.name, where: where });
    if (!tc.expiry) return client.intlGet(guildId, 'upkeepBoardDecaying', { name: tc.name, where: where });
    const left = tc.expiry * 1000 - now;
    const icon = left < 6 * HOUR_MS ? '\u{1F534}' : (left < 24 * HOUR_MS ? '\u{1F7E1}' : '\u{1F7E2}');
    const advice = left < 24 * HOUR_MS ? UpkeepRates.shortAdvice(client, guildId, tc.breakdown) : null;
    return client.intlGet(guildId, 'upkeepBoardLine', {
        icon: icon, name: tc.name, where: where,
        countdown: `\`${hoursMinutes(left)}\``, date: `<t:${tc.expiry}:f>`
    }) + (advice ? `\n\u2003${advice}` : '');
}

function getContent(client, guildId, tcs, now) {
    const description = tcs.length === 0 ? client.intlGet(guildId, 'upkeepBoardEmpty') :
        tcs.map(tc => line(client, guildId, tc, now)).join('\n');
    const anyLow = tcs.some(tc => !tc.reachable || !tc.expiry || tc.expiry * 1000 - now < 6 * HOUR_MS);
    return {
        embeds: [DiscordEmbeds.getEmbed({
            color: anyLow && tcs.length ? Constants.COLOR_INACTIVE : Constants.COLOR_DEFAULT,
            title: client.intlGet(guildId, 'upkeepBoardTitle'),
            description: description.slice(0, 4096),
            footer: { text: client.intlGet(guildId, 'upkeepBoardFooter') }
        })]
    };
}

/* What must change for the message to be edited: TCs, reachability and rounded expiry, colour band */
function signature(tcs, now) {
    return JSON.stringify(tcs.map(tc => [tc.id, tc.name, tc.location, tc.reachable,
        tc.breakdown ? tc.breakdown.add.map(a => `${a.key}${Math.round(a.amount / 1000)}`).join() : '',
        tc.expiry ? Math.ceil((tc.expiry * 1000 - now) / 60000) : 0,
        tc.expiry ? (tc.expiry * 1000 - now < 6 * HOUR_MS ? 2 : (tc.expiry * 1000 - now < 24 * HOUR_MS ? 1 : 0)) : -1]));
}

module.exports = {
    handler: async function (rustplus, client, now = Date.now()) {
        const guildId = rustplus.guildId;
        const instance = client.getInstance(guildId);
        if (!instance.channelId || !instance.channelId.information) return;
        if (!instance.informationMessageId.hasOwnProperty('upkeep')) instance.informationMessageId.upkeep = null;

        const tcs = getTcList(instance, rustplus);
        const sig = signature(tcs, now);
        if (signatures[guildId] === sig && instance.informationMessageId.upkeep !== null) return;

        const message = await DiscordMessages.sendMessage(guildId, getContent(client, guildId, tcs, now),
            instance.informationMessageId.upkeep, instance.channelId.information);
        signatures[guildId] = sig;
        if (message && message.id && message.id !== instance.informationMessageId.upkeep) {
            instance.informationMessageId.upkeep = message.id;
            client.setInstance(guildId, instance);
        }
    },

    getTcList: getTcList,
    getContent: getContent,
    hoursMinutes: hoursMinutes,
    _reset: () => { for (const k of Object.keys(signatures)) delete signatures[k]; }
};
