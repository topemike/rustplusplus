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
 *    (e.g. 24h, 6h, 1h), once per threshold until upkeep is refilled.
 *  - Watched containers (new WATCH button): warns when many items disappear at once,
 *    by default only while the whole team is offline (a teammate looting is not an alert).
 */

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const Timer = require('../util/timer');

/* Several updates in a short time are merged into one alert */
const ITEM_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const lastItemAlert = new Object();

function totalItems(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

function countByItem(items) {
    const counts = new Object();
    if (!Array.isArray(items)) return counts;
    for (const item of items) counts[item.itemId] = (counts[item.itemId] || 0) + (item.quantity || 0);
    return counts;
}

/**
 *  Items that went missing between two snapshots: [{ itemId, quantity }] sorted by quantity.
 */
function missingItems(prevItems, newItems) {
    const before = countByItem(prevItems);
    const after = countByItem(newItems);
    const missing = [];
    for (const [itemId, quantity] of Object.entries(before)) {
        const diff = quantity - (after[itemId] || 0);
        if (diff > 0) missing.push({ itemId: itemId, quantity: diff });
    }
    return missing.sort((a, b) => b.quantity - a.quantity);
}

function isWholeTeamOffline(rustplus) {
    if (!rustplus || !rustplus.team || !Array.isArray(rustplus.team.players)) return false;
    return rustplus.team.players.every(p => !p.isOnline);
}

async function sendAlert(client, guildId, title, description, color, everyone) {
    const instance = client.getInstance(guildId);
    const content = {
        embeds: [DiscordEmbeds.getEmbed({ color: color, title: title, description: description, timestamp: true })]
    };
    if (everyone) content.content = '@everyone';
    await DiscordMessages.sendMessage(guildId, content, null, instance.channelId.activity);
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
        const before = entity.upkeepWarnedHours;
        const crossed = checkUpkeep(entity, payload.protectionExpiry, nowMs);
        if (before !== entity.upkeepWarnedHours) client.setInstance(guildId, instance);

        if (crossed !== null) {
            const left = Timer.secondsToFullScale((payload.protectionExpiry * 1000 - nowMs) / 1000);
            await sendAlert(client, guildId,
                client.intlGet(guildId, 'upkeepLowTitle', { name: entity.name, time: left }),
                client.intlGet(guildId, 'upkeepLowDesc', {
                    name: entity.name,
                    date: `<t:${payload.protectionExpiry}:F>`,
                    location: entity.location || '-'
                }),
                Constants.COLOR_INACTIVE, entity.everyone);
            if (entity.inGame) {
                rustplus.sendInGameMessage(client.intlGet(guildId, 'upkeepLowInGame', { name: entity.name, time: left }));
            }
        }
    }

    /* Watched containers */
    if (!entity.watch || prevItems === null || prevItems === undefined) return;

    const prevTotal = totalItems(prevItems);
    const newTotal = totalItems(payload.items);
    const lost = prevTotal - newTotal;
    if (lost <= 0 || prevTotal === 0) return;

    const lostPercent = lost / prevTotal * 100;
    if (lostPercent < Config.baseWatch.boxDropPercent) return;

    const teamOffline = isWholeTeamOffline(rustplus);
    if (Config.baseWatch.boxAlertOnlyWhenTeamOffline && !teamOffline) return;

    const key = `${guildId}-${entityId}`;
    if (lastItemAlert[key] && nowMs - lastItemAlert[key] < ITEM_ALERT_COOLDOWN_MS) return;
    lastItemAlert[key] = nowMs;

    const missing = missingItems(prevItems, payload.items).slice(0, 8)
        .map(m => `${m.quantity}× ${client.items ? client.items.getName(m.itemId) : m.itemId}`).join(', ');

    await sendAlert(client, guildId,
        client.intlGet(guildId, 'boxLootedTitle', { name: entity.name }),
        client.intlGet(guildId, teamOffline ? 'boxLootedDescOffline' : 'boxLootedDesc', {
            percent: Math.round(lostPercent),
            items: missing,
            location: entity.location || '-'
        }),
        Constants.COLOR_INACTIVE, teamOffline);
}

module.exports = {
    onStorageUpdate: onStorageUpdate,
    checkUpkeep: checkUpkeep,
    missingItems: missingItems,

    /* For tests */
    _reset: function () { for (const k of Object.keys(lastItemAlert)) delete lastItemAlert[k]; }
};
