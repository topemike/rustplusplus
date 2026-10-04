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
 *  Wipes: offer a button to remove the Smart Devices of the previous wipe that no longer
 *  respond (switches, alarms, storage monitors), keeping switch groups so they can be refilled.
 */

const Discord = require('discord.js');

const Constants = require('./constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');

function countUnreachable(server) {
    const count = (list) => Object.values(list || {}).filter(e => e.reachable === false).length;
    return {
        switches: count(server.switches),
        alarms: count(server.alarms),
        storageMonitors: count(server.storageMonitors)
    };
}

async function sendWipeCleanupOffer(client, guildId, serverId) {
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    if (!server) return;

    const total = Object.keys(server.switches || {}).length + Object.keys(server.alarms || {}).length +
        Object.keys(server.storageMonitors || {}).length;
    if (total === 0) return;

    const unreachable = countUnreachable(server);
    await DiscordMessages.sendMessage(guildId, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_DEFAULT,
            title: client.intlGet(guildId, 'wipeCleanupTitle'),
            description: client.intlGet(guildId, 'wipeCleanupDesc', {
                switches: unreachable.switches,
                alarms: unreachable.alarms,
                storageMonitors: unreachable.storageMonitors
            }),
            footer: { text: server.title }
        })],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`WipeCleanup${JSON.stringify({ serverId: serverId })}`)
                .setLabel(client.intlGet(guildId, 'wipeCleanupCap'))
                .setStyle(Discord.ButtonStyle.Danger))]
    }, null, instance.channelId.activity);
}

/**
 *  Removes Smart Devices of a server that do not respond. Switch groups are kept (emptied).
 *  @return {Object} Number of removed switches, alarms and storage monitors.
 */
async function cleanupUnreachableDevices(client, guildId, serverId) {
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    const removed = { switches: 0, alarms: 0, storageMonitors: 0 };
    if (!server) return removed;

    const lists = [
        ['switches', instance.channelId.switches],
        ['alarms', instance.channelId.alarms],
        ['storageMonitors', instance.channelId.storageMonitors]
    ];
    const removedSwitchIds = [];

    for (const [key, channelId] of lists) {
        for (const [entityId, entity] of Object.entries(server[key] || {})) {
            if (entity.reachable !== false) continue;
            try {
                await DiscordTools.deleteMessageById(guildId, channelId, entity.messageId);
            }
            catch (e) { /* message already gone */ }
            delete server[key][entityId];
            removed[key]++;
            if (key === 'switches') removedSwitchIds.push(`${entityId}`);
        }
    }

    const changedGroups = [];
    for (const [groupId, group] of Object.entries(server.switchGroups || {})) {
        const before = group.switches.length;
        group.switches = group.switches.filter(e => !removedSwitchIds.includes(`${e}`));
        if (group.switches.length !== before) changedGroups.push(groupId);
    }

    client.setInstance(guildId, instance);

    for (const groupId of changedGroups) {
        try {
            await DiscordMessages.sendSmartSwitchGroupMessage(guildId, serverId, groupId);
        }
        catch (e) { /* refreshed on next connection */ }
    }

    return removed;
}

module.exports = {
    sendWipeCleanupOffer: sendWipeCleanupOffer,
    cleanupUnreachableDevices: cleanupUnreachableDevices,
    countUnreachable: countUnreachable
};
