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
 *  Base watch, based on Storage Monitors:
 *  - Tool Cupboard upkeep: warns when the protection time drops below configured thresholds
 *    (3h and 1h by default), once per threshold until upkeep is refilled, saying which material
 *    runs out first and how much to add (learned by util/upkeepRates.js).
 */

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const Timer = require('../util/timer');
const UpkeepRates = require('../util/upkeepRates.js');


async function sendAlert(client, guildId, title, description, color, everyone) {
    const instance = client.getInstance(guildId);
    const content = {
        embeds: [DiscordEmbeds.getEmbed({ color: color, title: title, description: description, timestamp: true })]
    };
    if (everyone) content.content = '@everyone';
    /* Own channel for base alerts (upkeep, looted boxes); #activity as fallback */
    await DiscordMessages.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
}

/**
 *  Tool Cupboard upkeep thresholds.
 *  @return {number|null} The threshold (hours) that was just crossed, or null.
 */
function checkUpkeep(entity, expirySeconds, nowMs) {
    const thresholds = [...Config.baseWatch.upkeepWarnHours].sort((a, b) => b - a);
    if (!expirySeconds || expirySeconds <= 0) return null;

    const hoursLeft = (expirySeconds * 1000 - nowMs) / 3600000;
    const crossed = thresholds.filter(h => hoursLeft <= h);
    if (crossed.length === 0) {
        entity.upkeepWarnedHours = null;   /* refilled above every threshold */
        return null;
    }

    const lowest = crossed[crossed.length - 1];
    const warned = entity.upkeepWarnedHours === undefined ? null : entity.upkeepWarnedHours;
    if (warned !== null && warned < lowest) {
        entity.upkeepWarnedHours = lowest; /* partially refilled: warn again if it drops below `warned` */
        return null;
    }
    if (warned !== null && warned === lowest) return null;   /* already warned for this threshold */
    entity.upkeepWarnedHours = lowest;
    return lowest;
}

/**
 *  Called whenever fresh contents of a Storage Monitor are known.
 *  @param {Array|null} prevItems Items before the update (null if unknown).
 *  @param {Object} payload entityInfo payload: { items, protectionExpiry, capacity }.
 */
async function onStorageUpdate(client, rustplus, entityId, prevItems, payload, nowMs = Date.now()) {
    const guildId = rustplus.guildId;
    const serverId = rustplus.serverId;
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    if (!server || !server.storageMonitors[entityId] || !payload || payload.capacity === 0) return;
    const entity = server.storageMonitors[entityId];

    /* Upkeep */
    if (payload.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY) {
        /* Learn what the base costs per material from the upkeep-sized drops */
        UpkeepRates.observe(entity, payload.items, payload.protectionExpiry, nowMs);
        const crossed = checkUpkeep(entity, payload.protectionExpiry, nowMs);
        client.setInstance(guildId, instance);

        if (crossed !== null) {
            const advice = UpkeepRates.shortAdvice(client, guildId,
                UpkeepRates.breakdown(entity, payload.items, payload.protectionExpiry, nowMs));
            const left = Timer.secondsToFullScale((payload.protectionExpiry * 1000 - nowMs) / 1000);
            await sendAlert(client, guildId,
                client.intlGet(guildId, 'upkeepLowTitle', { name: entity.name, time: left }),
                client.intlGet(guildId, 'upkeepLowDesc', {
                    name: entity.name,
                    date: `<t:${payload.protectionExpiry}:F>`,
                    location: entity.location || '-'
                }) + (advice ? `\n\n${advice}` : ''),
                Constants.COLOR_INACTIVE, entity.everyone);
            if (entity.inGame) {
                rustplus.sendInGameMessage(client.intlGet(guildId, 'upkeepLowInGame', { name: entity.name, time: left }) +
                    (advice ? ` ${advice}` : ''));
            }
        }
    }
}

module.exports = {
    onStorageUpdate: onStorageUpdate,
    checkUpkeep: checkUpkeep
};
