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

const Discord = require('discord.js');
const Path = require('path');

const Constants = require('../util/constants.js');
const Client = require('../../index.ts');
const DiscordButtons = require('./discordButtons.js');
const DiscordEmbeds = require('./discordEmbeds.js');
const DeviceNotices = require('../util/deviceNotices.js');
const DiscordSelectMenus = require('./discordSelectMenus.js');
const DiscordTools = require('./discordTools.js');
const Scrape = require('../util/scrape.js');

/* A device deleted while its message was being sent: the new message must not stay behind */
async function removeOrphan(guildId, message) {
    try { if (message && typeof message.delete === 'function') await message.delete(); }
    catch (e) { /* already gone */ }
}

const GONE = Symbol('gone');
const SAME_CONTENT_REFRESH_MS = 10 * 60 * 1000;
const editStates = new Object();

/* What a message shows (embeds without their timestamp, buttons, image names) */
function contentHash(content) {
    try {
        const plain = (x) => (x && typeof x.toJSON === 'function') ? x.toJSON() : x;
        const embeds = (content.embeds || []).map(e => { const j = Object.assign({}, plain(e)); delete j.timestamp; return j; });
        const components = (content.components || []).map(plain);
        const files = (content.files || []).map(f => (f && (f.name || (f.attachment && Path.basename(String(f.attachment))))) || '?');
        return JSON.stringify([content.content || null, embeds, components, files]);
    }
    catch (e) {
        return `${Math.random()}`;  /* cannot compare: always send */
    }
}

function stillThere(message) {
    try {
        const cache = message.channel && message.channel.messages && message.channel.messages.cache;
        return !cache || typeof cache.has !== 'function' || cache.has(message.id);
    }
    catch (e) {
        return false;
    }
}

async function doEdit(guildId, channelId, messageId, content) {
    if (DiscordTools.deletedByBot && DiscordTools.deletedByBot.has(`${messageId}`)) return undefined;
    const message = await DiscordTools.getMessageById(guildId, channelId, messageId);
    if (message === undefined) return GONE;
    try {
        return await message.edit(module.exports.withoutReuploads(message, content));
    }
    catch (e) {
        if (e && e.code === 10008) {
            /* The message was deleted (it was still cached): a new one is sent, its id is saved */
            try { message.channel.messages.cache.delete(messageId); } catch (err) { /* not cached */ }
            return GONE;
        }
        Client.client.log(Client.client.intlGet(null, 'errorCap'),
            Client.client.intlGet(null, 'messageEditFailed', { error: e }), 'error');
        return undefined;
    }
}

module.exports = {
    _editStates: editStates,
    /**
     *  Editing a message with the same images it already has: the images are not uploaded again
     *  (Discord keeps the attachments of a message when an edit does not mention them). Every edit
     *  used to upload the thumbnails again, which made each edit much slower.
     */
    withoutReuploads: function (message, content) {
        try {
            if (!content || !Array.isArray(content.files) || content.files.length === 0 || content.attachments) {
                return content;
            }
            const have = new Set();
            if (message.attachments && typeof message.attachments.values === 'function') {
                for (const a of message.attachments.values()) if (a && a.name) have.add(a.name);
            }
            if (have.size !== content.files.length) return content;
            const names = content.files.map(f => (f && (f.name || (f.attachment && Path.basename(String(f.attachment))))) || null);
            if (names.some(n => !n || !have.has(n))) return content;
            const rest = Object.assign({}, content);
            delete rest.files;
            return rest;
        }
        catch (e) {
            return content;
        }
    },

    sendMessage: async function (guildId, content, messageId, channelId, interaction = null) {
        if (interaction) {
            /* The message changed outside editMessage(): forget what was last sent to it */
            try {
                if (interaction.message) delete editStates[`${interaction.message.channelId}/${interaction.message.id}`];
                if (messageId) delete editStates[`${channelId}/${messageId}`];
            }
            catch (e) { /* nothing remembered */ }
            await Client.client.interactionUpdate(interaction, content);
            return;
        }

        if (messageId !== null && messageId !== undefined) {
            /* Deleted on purpose by the bot (device removed): nothing to update, nothing to re-create */
            if (DiscordTools.deletedByBot && DiscordTools.deletedByBot.has(`${messageId}`)) return undefined;
            const edited = await module.exports.editMessage(guildId, channelId, messageId, content);
            if (edited !== GONE) return edited;
            if (DiscordTools.deletedByBot && DiscordTools.deletedByBot.has(`${messageId}`)) return undefined;
        }

        const channel = DiscordTools.getTextChannelById(guildId, channelId);
        if (!channel) {
            Client.client.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'couldNotGetChannelWithId', { id: channelId }), 'error');
            return;
        }
        return await Client.client.messageSend(channel, content);
    },

    /**
     *  Edits a message, with two rules that keep the number of Discord requests low (Discord answers
     *  them one after another per channel; when more come in than it serves, they pile up for hours):
     *  - an edit with exactly the same content as the last one is not sent (refreshed every 10 min);
     *  - one edit at a time per message: edits that come while one is on its way are merged, only
     *    the newest content is sent after it.
     *  Returns GONE if the message no longer exists (a new one has to be sent).
     */
    editMessage: async function (guildId, channelId, messageId, content) {
        const key = `${channelId}/${messageId}`;
        const state = editStates[key] || (editStates[key] = { busy: false, next: null, waiters: [], hash: null, at: 0, message: null });
        const hash = contentHash(content);

        if (state.busy) {
            state.next = { content, hash };
            return await new Promise((resolve) => state.waiters.push(resolve));
        }
        /* Same content as the last edit, and the message is still there (a deleted message leaves the
           channel cache: then it is sent again) */
        if (state.hash === hash && state.message && Date.now() - state.at < SAME_CONTENT_REFRESH_MS &&
            stillThere(state.message)) {
            return state.message;
        }

        state.busy = true;
        let result;
        try {
            result = await doEdit(guildId, channelId, messageId, content);
            if (result && result !== GONE) {
                state.hash = hash; state.at = Date.now(); state.message = result;
            }
            else if (result === GONE) {
                delete editStates[key];
            }
        }
        finally {
            state.busy = false;
            if (state.next && editStates[key] === state) {
                const next = state.next, waiters = state.waiters;
                state.next = null; state.waiters = [];
                module.exports.editMessage(guildId, channelId, messageId, next.content).then(
                    (r) => { for (const w of waiters) w(r); }, () => { for (const w of waiters) w(undefined); });
            }
            else if (state.waiters.length) {
                const waiters = state.waiters;
                state.waiters = []; state.next = null;
                for (const w of waiters) w(result);
            }
        }
        return result;
    },

    sendServerMessage: async function (guildId, serverId, state = null, interaction = null) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];

        const content = {
            embeds: [await DiscordEmbeds.getServerEmbed(guildId, serverId)],
            components: DiscordButtons.getServerButtons(guildId, serverId, state)
        }

        const message = await module.exports.sendMessage(guildId, content, server.messageId,
            instance.channelId.servers, interaction);

        if (!interaction && message && message.id) {
            instance.serverList[serverId].messageId = message.id;
            Client.client.setInstance(guildId, instance);
        }
    },

    sendTrackerMessage: async function (guildId, trackerId, interaction = null) {
        const instance = Client.client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        if (!tracker) return;   /* deleted meanwhile */

        const content = {
            embeds: [DiscordEmbeds.getTrackerEmbed(guildId, trackerId)],
            components: DiscordButtons.getTrackerButtons(guildId, trackerId)
        }

        const message = await module.exports.sendMessage(guildId, content, tracker.messageId,
            instance.channelId.trackers, interaction);

        if (!interaction && message && message.id) {
            {
                const target = instance.trackers && instance.trackers[trackerId];
                if (!target) { await removeOrphan(guildId, message); return; }
                target.messageId = message.id;
            }
            Client.client.setInstance(guildId, instance);
        }
    },

    sendSmartSwitchMessage: async function (guildId, serverId, entityId, interaction = null) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].switches[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [entity.reachable ?
                DiscordEmbeds.getSmartSwitchEmbed(guildId, serverId, entityId) :
                DiscordEmbeds.getNotFoundSmartDeviceEmbed(guildId, serverId, entityId, 'switches')],
            components: [
                DiscordSelectMenus.getSmartSwitchSelectMenu(guildId, serverId, entityId),
                DiscordButtons.getSmartSwitchButtons(guildId, serverId, entityId)
            ],
            files: [
                new Discord.AttachmentBuilder(Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))
            ]
        }

        const message = await module.exports.sendMessage(guildId, content, entity.messageId,
            instance.channelId.switches, interaction);

        if (!interaction && message && message.id) {
            {
                const target = instance.serverList && instance.serverList[serverId] && instance.serverList[serverId].switches && instance.serverList[serverId].switches[entityId];
                if (!target) { await removeOrphan(guildId, message); return; }
                target.messageId = message.id;
            }
            Client.client.setInstance(guildId, instance);
        }
    },

    sendSmartAlarmMessage: async function (guildId, serverId, entityId, interaction = null) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].alarms[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [entity.reachable ?
                DiscordEmbeds.getSmartAlarmEmbed(guildId, serverId, entityId) :
                DiscordEmbeds.getNotFoundSmartDeviceEmbed(guildId, serverId, entityId, 'alarms')],
            components: [DiscordButtons.getSmartAlarmButtons(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))]
        }

        const message = await module.exports.sendMessage(guildId, content, entity.messageId,
            instance.channelId.alarms, interaction);

        if (!interaction && message && message.id) {
            {
                const target = instance.serverList && instance.serverList[serverId] && instance.serverList[serverId].alarms && instance.serverList[serverId].alarms[entityId];
                if (!target) { await removeOrphan(guildId, message); return; }
                target.messageId = message.id;
            }
            Client.client.setInstance(guildId, instance);
        }
    },

    sendStorageMonitorMessage: async function (guildId, serverId, entityId, interaction = null) {
        let instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].storageMonitors[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [entity.reachable ?
                DiscordEmbeds.getStorageMonitorEmbed(guildId, serverId, entityId) :
                DiscordEmbeds.getNotFoundSmartDeviceEmbed(guildId, serverId, entityId, 'storageMonitors')],
            components: [entity.type === 'toolCupboard' ?
                DiscordButtons.getStorageMonitorToolCupboardButtons(guildId, serverId, entityId) :
                DiscordButtons.getStorageMonitorContainerButton(guildId, serverId, entityId)],
            files: [
                new Discord.AttachmentBuilder(
                    Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))]
        }

        instance = Client.client.getInstance(guildId);

        const message = await module.exports.sendMessage(guildId, content, entity.messageId,
            instance.channelId.storageMonitors, interaction);

        if (!interaction && message && message.id) {
            {
                const target = instance.serverList && instance.serverList[serverId] && instance.serverList[serverId].storageMonitors && instance.serverList[serverId].storageMonitors[entityId];
                if (!target) { await removeOrphan(guildId, message); return; }
                target.messageId = message.id;
            }
            Client.client.setInstance(guildId, instance);
        }
    },

    sendSmartSwitchGroupMessage: async function (guildId, serverId, groupId, interaction = null) {
        const instance = Client.client.getInstance(guildId);
        const group = instance.serverList[serverId] ? instance.serverList[serverId].switchGroups[groupId] : undefined;
        if (!group) return;   /* deleted meanwhile */

        const content = {
            embeds: [DiscordEmbeds.getSmartSwitchGroupEmbed(guildId, serverId, groupId)],
            components: DiscordButtons.getSmartSwitchGroupButtons(guildId, serverId, groupId),
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${group.image}`))]
        }

        const message = await module.exports.sendMessage(guildId, content, group.messageId,
            instance.channelId.switchGroups, interaction);

        if (!interaction && message && message.id) {
            {
                const target = instance.serverList && instance.serverList[serverId] && instance.serverList[serverId].switchGroups && instance.serverList[serverId].switchGroups[groupId];
                if (!target) { await removeOrphan(guildId, message); return; }
                target.messageId = message.id;
            }
            Client.client.setInstance(guildId, instance);
        }
    },

    sendStorageMonitorRecycleMessage: async function (guildId, serverId, entityId, items) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getStorageMonitorRecycleEmbed(guildId, serverId, entityId, items)],
            components: [DiscordButtons.getRecycleDeleteButton()],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/electrics/recycler.png'))]
        }

        return await module.exports.sendMessage(guildId, content, null, instance.channelId.storageMonitors);
    },

    sendDecayingNotificationMessage: async function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].storageMonitors[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [DiscordEmbeds.getDecayingNotificationEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))],
            content: entity.everyone ? '@everyone' : ''
        }

        /* Storage monitor / Tool Cupboard messages go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    sendStorageMonitorDisconnectNotificationMessage: async function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].storageMonitors[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [DiscordEmbeds.getStorageMonitorDisconnectNotificationEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))],
            content: entity.everyone ? '@everyone' : ''
        }

        /* Storage monitor / Tool Cupboard messages go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    sendStorageMonitorNotFoundMessage: async function (guildId, serverId, entityId, force = false) {
        /* Only once the server, while on, confirms the device is missing (deviceNotices.js) */
        if (!force && !DeviceNotices.shouldSendNow(Client.client, guildId, 'storageMonitor', serverId, entityId)) return;
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].storageMonitors[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [await DiscordEmbeds.getStorageMonitorNotFoundEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))],
            content: entity.everyone ? '@everyone' : ''
        }

        /* Storage monitor / Tool Cupboard messages go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    sendSmartSwitchNotFoundMessage: async function (guildId, serverId, entityId, force = false) {
        /* Only once the server, while on, confirms the device is missing (deviceNotices.js) */
        if (!force && !DeviceNotices.shouldSendNow(Client.client, guildId, 'switch', serverId, entityId)) return;
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].switches[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [await DiscordEmbeds.getSmartSwitchNotFoundEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))]
        }

        /* Base devices go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    sendSmartAlarmNotFoundMessage: async function (guildId, serverId, entityId, force = false) {
        /* Only once the server, while on, confirms the device is missing (deviceNotices.js) */
        if (!force && !DeviceNotices.shouldSendNow(Client.client, guildId, 'alarm', serverId, entityId)) return;
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].alarms[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */

        const content = {
            embeds: [await DiscordEmbeds.getSmartAlarmNotFoundEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))],
            content: entity.everyone ? '@everyone' : ''
        }

        /* Base devices go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    /* everyone: null = the alarm's own @everyone setting; true/false forces it (fcmAlarmNotificationEveryone) */
    sendSmartAlarmTriggerMessage: async function (guildId, serverId, entityId, everyone = null) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId] ? instance.serverList[serverId].alarms[entityId] : undefined;
        if (!entity) return;   /* deleted meanwhile */
        const mention = everyone === null ? entity.everyone : everyone;

        const content = {
            embeds: [await DiscordEmbeds.getAlarmEmbed(guildId, serverId, entityId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/electrics/${entity.image}`))],
            content: mention ? '@everyone' : ''
        }

        /* Base alarms go to #base (#activity if it does not exist) */
        await module.exports.sendMessage(guildId, content, null, instance.channelId.base || instance.channelId.activity);
    },

    sendServerChangeStateMessage: async function (guildId, serverId, state) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getServerChangedStateEmbed(guildId, serverId, state)]
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.activity);
    },

    sendServerWipeDetectedMessage: async function (guildId, serverId) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getServerWipeDetectedEmbed(guildId, serverId)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', '..', `maps/${guildId}_map_full.png`))],
            content: instance.generalSettings.mapWipeNotifyEveryone ? '@everyone' : ''
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.activity);
    },

    sendServerConnectionInvalidMessage: async function (guildId, serverId) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getServerConnectionInvalidEmbed(guildId, serverId)]
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.activity);
    },

    sendInformationMapMessage: async function (guildId) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', '..', `maps/${guildId}_map_full.png`))]
        }

        const message = await module.exports.sendMessage(guildId, content, instance.informationMessageId.map,
            instance.channelId.information);

        if (message) {
            instance.informationMessageId.map = message.id;
            Client.client.setInstance(guildId, instance);
        }
    },

    sendDiscordEventMessage: async function (guildId, serverId, text, image, color) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getEventEmbed(guildId, serverId, text, image, color)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', `resources/images/events/${image}`))]
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.events);
    },

    sendActivityNotificationMessage: async function (guildId, serverId, color, text, steamId, title = null, everyone = false) {
        const instance = Client.client.getInstance(guildId);

        let png = null;
        if (steamId !== null) {
            png = await Scrape.scrapeSteamProfilePicture(Client.client, steamId);
        }
        const content = {
            embeds: [DiscordEmbeds.getActivityNotificationEmbed(guildId, serverId, color, text, steamId, png, title)]
        }

        if (everyone) {
            content.content = '@everyone';
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.activity);
    },

    sendTeamChatMessage: async function (guildId, message) {
        const instance = Client.client.getInstance(guildId);

        let color = Constants.COLOR_TEAMCHAT_DEFAULT;
        if (instance.teamChatColors.hasOwnProperty(message.steamId)) {
            color = instance.teamChatColors[message.steamId];
        }

        const content = {
            embeds: [DiscordEmbeds.getEmbed({
                color: color,
                description: `**${message.name}**: ${message.message}`
            })]
        }

        if (message.message.includes('@everyone')) {
            content.content = '@everyone';
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.teamchat);
    },

    sendTTSMessage: async function (guildId, name, text) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            content: Client.client.intlGet(guildId, 'userSaid', { user: name, text: text }),
            tts: true
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.teamchat);
    },

    sendUpdateMapInformationMessage: async function (rustplus) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', '..', `maps/${rustplus.guildId}_map_full.png`))]
        }

        const message = await module.exports.sendMessage(rustplus.guildId, content,
            instance.informationMessageId.map, instance.channelId.information);

        if (message && message.id && message.id !== instance.informationMessageId.map) {
            instance.informationMessageId.map = message.id;
            Client.client.setInstance(rustplus.guildId, instance);
        }
    },

    sendUpdateServerInformationMessage: async function (rustplus) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            embeds: [DiscordEmbeds.getUpdateServerInformationEmbed(rustplus)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/server_info_logo.png')
            )]
        }

        const message = await module.exports.sendMessage(rustplus.guildId, content,
            instance.informationMessageId.server, instance.channelId.information);

        if (message && message.id && message.id !== instance.informationMessageId.server) {
            instance.informationMessageId.server = message.id;
            Client.client.setInstance(rustplus.guildId, instance);
        }
    },

    sendUpdateEventInformationMessage: async function (rustplus) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            embeds: [DiscordEmbeds.getUpdateEventInformationEmbed(rustplus)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/event_info_logo.png')
            )]
        }

        const message = await module.exports.sendMessage(rustplus.guildId, content,
            instance.informationMessageId.event, instance.channelId.information);

        if (message && message.id && message.id !== instance.informationMessageId.event) {
            instance.informationMessageId.event = message.id;
            Client.client.setInstance(rustplus.guildId, instance);
        }
    },

    sendUpdateTeamInformationMessage: async function (rustplus) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            embeds: [DiscordEmbeds.getUpdateTeamInformationEmbed(rustplus)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/team_info_logo.png')
            )]
        }

        const message = await module.exports.sendMessage(rustplus.guildId, content,
            instance.informationMessageId.team, instance.channelId.information);

        if (message && message.id && message.id !== instance.informationMessageId.team) {
            instance.informationMessageId.team = message.id;
            Client.client.setInstance(rustplus.guildId, instance);
        }
    },

    sendUpdateBattlemetricsOnlinePlayersInformationMessage: async function (rustplus, battlemetricsId) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            embeds: [DiscordEmbeds.getUpdateBattlemetricsOnlinePlayersInformationEmbed(rustplus, battlemetricsId)]
        }

        const message = await module.exports.sendMessage(rustplus.guildId, content,
            instance.informationMessageId.battlemetricsPlayers, instance.channelId.information);

        if (message && message.id && message.id !== instance.informationMessageId.battlemetricsPlayers) {
            instance.informationMessageId.battlemetricsPlayers = message.id;
            Client.client.setInstance(rustplus.guildId, instance);
        }
    },

    sendDiscordCommandResponseMessage: async function (rustplus, client, message, response) {
        const content = {
            embeds: [DiscordEmbeds.getDiscordCommandResponseEmbed(rustplus, response)]
        }

        await client.messageReply(message, content);
    },

    sendCredentialsShowMessage: async function (interaction) {
        const content = {
            embeds: [await DiscordEmbeds.getCredentialsShowEmbed(interaction.guildId)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendItemAvailableInVendingMachineMessage: async function (rustplus, str) {
        const instance = Client.client.getInstance(rustplus.guildId);

        const content = {
            embeds: [DiscordEmbeds.getItemAvailableVendingMachineEmbed(
                rustplus.guildId, rustplus.serverId, str
            )]
        }

        /* Market alerts go to #market (#activity if it does not exist) */
        await module.exports.sendMessage(rustplus.guildId, content, null, instance.channelId.market || instance.channelId.activity);
    },

    sendHelpMessage: async function (interaction) {
        const content = {
            embeds: [DiscordEmbeds.getHelpEmbed(interaction.guildId)],
            components: DiscordButtons.getHelpButtons(),
            ephemeral: true
        }

        await Client.client.interactionReply(interaction, content);
    },

    sendCctvMessage: async function (interaction, monument, cctvCodes, dynamic) {
        const content = {
            embeds: [DiscordEmbeds.getCctvEmbed(interaction.guildId, monument, cctvCodes, dynamic)],
            ephemeral: true
        }

        await Client.client.interactionReply(interaction, content);
    },

    sendUptimeMessage: async function (interaction, uptime) {
        const content = {
            embeds: [DiscordEmbeds.getUptimeEmbed(interaction.guildId, uptime)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendVoiceMessage: async function (interaction, state) {
        const content = {
            embeds: [DiscordEmbeds.getVoiceEmbed(interaction.guildId, state)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendCraftMessage: async function (interaction, craftDetails, quantity) {
        const content = {
            embeds: [DiscordEmbeds.getCraftEmbed(interaction.guildId, craftDetails, quantity)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendResearchMessage: async function (interaction, researchDetails) {
        const content = {
            embeds: [DiscordEmbeds.getResearchEmbed(interaction.guildId, researchDetails)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendRecycleMessage: async function (interaction, recycleDetails, quantity, recyclerType) {
        const content = {
            embeds: [DiscordEmbeds.getRecycleEmbed(interaction.guildId, recycleDetails, quantity, recyclerType)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },

    sendBattlemetricsEventMessage: async function (guildId, battlemetricsId, title, description, fields = null, everyone = false) {
        const instance = Client.client.getInstance(guildId);

        const content = {
            embeds: [DiscordEmbeds.getBattlemetricsEventEmbed(guildId, battlemetricsId, title, description, fields)]
        }

        if (everyone) {
            content.content = '@everyone';
        }

        await module.exports.sendMessage(guildId, content, null, instance.channelId.activity);
    },

    sendItemMessage: async function (interaction, itemName, itemId, type) {
        const content = {
            embeds: [DiscordEmbeds.getItemEmbed(interaction.guildId, itemName, itemId, type)],
            ephemeral: true
        }

        await Client.client.interactionEditReply(interaction, content);
    },
}
/*
 *  One update at a time per Discord message owner (a device, a group, a tracker, the server, each
 *  #information message). Two updates of the same device that both find its message missing (after
 *  /reset, or while it is first posted) would otherwise both post a new one: the copy that is not
 *  remembered is never updated again and stays when the device is deleted. Here the second update
 *  waits for the first and then sees the message it posted. An update that is already waiting with
 *  the same arguments is not queued twice (it reads the newest state when it runs).
 *  Updates answering a button or form (interaction) are not queued: they must answer within 3 s
 *  and only edit the message that was clicked.
 */
const ownerQueues = {};
const OWNER_WAIT_MAX_MS = 90 * 1000;   /* a stuck update does not block the next ones for ever */

function argsSignature(args) {
    return args.map((v) => {
        if (v === null || v === undefined) return String(v);
        if (typeof v !== 'object') return `${typeof v}:${v}`;
        if (v.guildId !== undefined) return `rustplus:${v.guildId}:${v.serverId}`;
        return '[object]';
    }).join('|');
}

function serialPerOwner(name, keyOf, interactionIndex) {
    const original = module.exports[name];
    module.exports[name] = function (...args) {
        if (interactionIndex !== null && args[interactionIndex]) return original.apply(this, args);
        const key = keyOf(args);
        const signature = argsSignature(args);
        const q = ownerQueues[key] || (ownerQueues[key] = { tail: Promise.resolve(), waiting: null, waitingSig: null });
        if (q.waiting && q.waitingSig === signature) return q.waiting;

        const job = q.tail.then(() => {
            if (q.waiting === job) { q.waiting = null; q.waitingSig = null; }
            return new Promise((resolve) => {
                const timer = setTimeout(() => resolve(undefined), OWNER_WAIT_MAX_MS);
                Promise.resolve().then(() => original.apply(this, args)).then(
                    (r) => { clearTimeout(timer); resolve(r); },
                    (e) => {
                        clearTimeout(timer);
                        Client.client.log(Client.client.intlGet(null, 'errorCap'), `${name}: ${e}`, 'error');
                        resolve(undefined);
                    });
            });
        });
        q.waiting = job; q.waitingSig = signature;
        const tail = job.then(() => {
            if (ownerQueues[key] === q && q.tail === tail) delete ownerQueues[key];
        });
        q.tail = tail;
        return job;
    };
}

const guildOf = (a) => (a && a.guildId !== undefined ? a.guildId : a);
serialPerOwner('sendServerMessage', (a) => `server/${a[0]}/${a[1]}`, 3);
serialPerOwner('sendTrackerMessage', (a) => `tracker/${a[0]}/${a[1]}`, 2);
serialPerOwner('sendSmartSwitchMessage', (a) => `switch/${a[0]}/${a[1]}/${a[2]}`, 3);
serialPerOwner('sendSmartAlarmMessage', (a) => `alarm/${a[0]}/${a[1]}/${a[2]}`, 3);
serialPerOwner('sendStorageMonitorMessage', (a) => `storage/${a[0]}/${a[1]}/${a[2]}`, 3);
serialPerOwner('sendSmartSwitchGroupMessage', (a) => `group/${a[0]}/${a[1]}/${a[2]}`, 3);
serialPerOwner('sendUpdateMapInformationMessage', (a) => `info/${guildOf(a[0])}/map`, null);
serialPerOwner('sendUpdateServerInformationMessage', (a) => `info/${guildOf(a[0])}/server`, null);
serialPerOwner('sendUpdateEventInformationMessage', (a) => `info/${guildOf(a[0])}/event`, null);
serialPerOwner('sendUpdateTeamInformationMessage', (a) => `info/${guildOf(a[0])}/team`, null);
serialPerOwner('sendUpdateBattlemetricsOnlinePlayersInformationMessage',
    (a) => `info/${guildOf(a[0])}/battlemetrics/${a[1]}`, null);
