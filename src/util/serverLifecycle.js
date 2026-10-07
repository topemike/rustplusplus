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
 *  After a wipe: deletes every Smart Device of the previous wipe. The only ones kept are those that
 *  answer right now, with the bot connected to that server (paired again in the new wipe). If the
 *  bot is not connected to it, everything is deleted. Switch groups are kept (emptied).
 *  @return {Object} Number of removed switches, alarms and storage monitors, and `kept`.
 */
async function cleanupUnreachableDevices(client, guildId, serverId) {
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    const removed = { switches: 0, alarms: 0, storageMonitors: 0, kept: 0 };
    if (!server) return removed;

    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    const live = !!rustplus && rustplus.isOperational && rustplus.serverId === serverId;
    const DeviceNotices = require('./deviceNotices.js');

    const lists = [
        ['switches', instance.channelId.switches],
        ['alarms', instance.channelId.alarms],
        ['storageMonitors', instance.channelId.storageMonitors]
    ];
    const removedSwitchIds = [];

    for (const [key, channelId] of lists) {
        for (const [entityId, entity] of Object.entries(server[key] || {})) {
            /* Kept only if it answers now: it belongs to the new wipe */
            if (live) {
                let response;
                try { response = await rustplus.getEntityInfoAsync(entityId); }
                catch (e) { response = undefined; }
                if (DeviceNotices.answeredFound(response)) {
                    entity.reachable = true;
                    removed.kept++;
                    continue;
                }
            }

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

    /* The base alerts were about the previous wipe */
    if (instance.channelId.base) {
        try {
            await DiscordTools.clearTextChannel(guildId, instance.channelId.base, 100);
        }
        catch (e) { /* ignore */ }
    }
    try { require('../handlers/raidHandler.js').forget(guildId); }
    catch (e) { /* not critical */ }

    for (const groupId of changedGroups) {
        try {
            await DiscordMessages.sendSmartSwitchGroupMessage(guildId, serverId, groupId);
        }
        catch (e) { /* refreshed on next connection */ }
    }

    return removed;
}

/* ------------------------------------------------------------------------- */
/* Moving to another server                                                   */
/* ------------------------------------------------------------------------- */

function otherServers(instance, keepServerId) {
    return Object.keys(instance.serverList || {}).filter(id => id !== keepServerId);
}

/* Message offering to remove everything about the servers other than `keepServerId`, or null */
function getServerChangeMessage(client, guildId, keepServerId) {
    const instance = client.getInstance(guildId);
    if (!keepServerId || !instance.serverList[keepServerId]) return null;
    const others = otherServers(instance, keepServerId);
    if (others.length === 0) return null;
    const keep = instance.serverList[keepServerId];
    const trackers = Object.values(instance.trackers || {}).filter(t => t.serverId !== keepServerId).length;
    return {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_DEFAULT,
            title: client.intlGet(guildId, 'serverChangeTitle', { server: keep ? keep.title : keepServerId }),
            description: client.intlGet(guildId, 'serverChangeDesc', {
                servers: others.map(id => `• ${instance.serverList[id].title || id}`).join('\n'),
                trackers: trackers
            })
        })],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`ServerChangeCleanup${JSON.stringify({ serverId: keepServerId })}`)
                .setLabel(client.intlGet(guildId, 'serverChangeCap'))
                .setStyle(Discord.ButtonStyle.Danger))]
    };
}

/**
 *  Warning shown when someone presses CONNECT on a server while others are still stored: connecting
 *  deletes everything about them first. null if there is nothing to delete.
 */
function getConnectPurgeMessage(client, guildId, targetServerId) {
    const instance = client.getInstance(guildId);
    const target = instance.serverList[targetServerId];
    const others = otherServers(instance, targetServerId);
    if (!target || others.length === 0) return null;
    const trackers = Object.values(instance.trackers || {}).filter(t => t.serverId !== targetServerId).length;
    return {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_INACTIVE,
            title: client.intlGet(guildId, 'serverConnectPurgeTitle', { server: target.title || targetServerId }),
            description: client.intlGet(guildId, 'serverConnectPurgeDesc', {
                servers: others.map(id => `• ${instance.serverList[id].title || id}`).join('\n'),
                trackers: trackers
            })
        })],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(`ServerConnectPurge${JSON.stringify({ serverId: targetServerId })}`)
                .setLabel(client.intlGet(guildId, 'serverConnectPurgeCap'))
                .setStyle(Discord.ButtonStyle.Danger))],
        ephemeral: true
    };
}

/**
 *  Removes everything that belongs to servers other than `keepServerId`: the servers with their
 *  devices, groups, Deep Sea and base, their trackers and tracker history, the event and raid
 *  history, and the messages in #events, #activity and #base.
 *  @return {Object} { servers, trackers }
 */
async function purgeOtherServers(client, guildId, keepServerId) {
    const instance = client.getInstance(guildId);
    const removed = { servers: 0, trackers: 0 };

    for (const serverId of otherServers(instance, keepServerId)) {
        const server = instance.serverList[serverId];
        /* Every message of that server's devices: alarms, switches, groups and storage monitors */
        for (const [list, channelId] of [['alarms', instance.channelId.alarms], ['switches', instance.channelId.switches],
            ['switchGroups', instance.channelId.switchGroups], ['storageMonitors', instance.channelId.storageMonitors]]) {
            for (const entity of Object.values(server[list] || {})) {
                if (!channelId || !entity || !entity.messageId) continue;
                try { await DiscordTools.deleteMessageById(guildId, channelId, entity.messageId); }
                catch (e) { /* already gone */ }
            }
        }
        try { await DiscordTools.deleteMessageById(guildId, instance.channelId.servers, server.messageId); }
        catch (e) { /* already gone */ }
        delete instance.serverList[serverId];
        if (instance.serverListLite) delete instance.serverListLite[serverId];
        removed.servers++;
    }

    for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
        if (tracker.serverId === keepServerId) continue;
        try { await DiscordTools.deleteMessageById(guildId, instance.channelId.trackers, tracker.messageId); }
        catch (e) { /* already gone */ }
        delete instance.trackers[trackerId];
        removed.trackers++;
    }
    client.setInstance(guildId, instance);

    try { require('./trackerIntel.js').keepOnly(guildId, Object.keys(instance.trackers || {})); }
    catch (e) { /* not critical */ }
    try { require('./dailyStats.js').clear(guildId); }
    catch (e) { /* not critical */ }

    for (const channelId of [instance.channelId.events, instance.channelId.base, instance.channelId.activity]) {
        if (!channelId) continue;
        try { await DiscordTools.clearTextChannel(guildId, channelId, 1000); }
        catch (e) { /* ignore */ }
    }
    try { require('../handlers/raidHandler.js').forget(guildId); }
    catch (e) { /* not critical */ }
    return removed;
}

/* Message with the button that deletes ALL game data (every server, including the active one) */
function getPurgeAllMessage(client, guildId) {
    const instance = client.getInstance(guildId);
    const servers = Object.values(instance.serverList || {});
    const trackers = Object.keys(instance.trackers || {}).length;
    if (servers.length === 0 && trackers === 0) return null;
    return {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_INACTIVE,
            title: client.intlGet(guildId, 'purgeAllTitle'),
            description: client.intlGet(guildId, 'purgeAllDesc', {
                servers: servers.map(s => `• ${s.title}`).join('\n') || '-',
                trackers: trackers
            })
        })],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId('PurgeAll')
                .setLabel(client.intlGet(guildId, 'purgeAllCap'))
                .setStyle(Discord.ButtonStyle.Danger))]
    };
}

/**
 *  Leaves the bot at zero, as if it had never been used, except for `keepServerId` (the server
 *  about to be connected; null = keep nothing). Disconnects first (and stops any pending
 *  reconnect), empties the device channels and #information, then removes every other server,
 *  trackers and history (see purgeOtherServers). Channels, settings and credentials stay: on the
 *  next connection the bot fills the channels again for the new server.
 */
async function purgeAllExcept(client, guildId, keepServerId) {
    try { client.resetRustplusVariables(guildId); } catch (e) { /* not critical */ }
    const rustplus = client.rustplusInstances[guildId];
    if (rustplus) {
        rustplus.isDeleted = true;
        try { rustplus.disconnect(); } catch (e) { /* already disconnected */ }
        delete client.rustplusInstances[guildId];
    }
    const instance = client.getInstance(guildId);
    instance.activeServer = null;
    for (const key of Object.keys(instance.informationMessageId || {})) instance.informationMessageId[key] = null;
    client.setInstance(guildId, instance);

    for (const channelId of [instance.channelId.switches, instance.channelId.switchGroups,
        instance.channelId.storageMonitors, instance.channelId.information]) {
        if (!channelId) continue;
        try { await DiscordTools.clearTextChannel(guildId, channelId, 1000); }
        catch (e) { /* ignore */ }
    }
    return await purgeOtherServers(client, guildId, keepServerId);
}

/* Deletes everything about every server (/limpieza todo) */
async function purgeEverything(client, guildId) {
    return await purgeAllExcept(client, guildId, null);
}

module.exports = {
    getPurgeAllMessage: getPurgeAllMessage,
    purgeEverything: purgeEverything,
    purgeAllExcept: purgeAllExcept,
    getServerChangeMessage: getServerChangeMessage,
    getConnectPurgeMessage: getConnectPurgeMessage,
    purgeOtherServers: purgeOtherServers,
    sendWipeCleanupOffer: sendWipeCleanupOffer,
    cleanupUnreachableDevices: cleanupUnreachableDevices,
    countUnreachable: countUnreachable
};
