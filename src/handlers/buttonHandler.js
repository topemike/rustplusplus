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

const CustomId = require('../util/customId.js');

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const SmartSwitchGroupHandler = require('./smartSwitchGroupHandler.js');
const DiscordButtons = require('../discordTools/discordButtons.js');
const DiscordModals = require('../discordTools/discordModals.js');
const SwitchOverride = require('../util/switchOverride.js');
const SwitchTimers = require('../util/switchTimers.js');

module.exports = async (client, interaction) => {
    const instance = client.getInstance(interaction.guildId);
    const guildId = interaction.guildId;
    const rustplus = client.rustplusInstances[guildId];

    const verifyId = Math.floor(100000 + Math.random() * 900000);
    client.logInteraction(interaction, verifyId, 'userButton');

    /* Acknowledge the click without changing the message (Discord gives 3 seconds) */
    const defer = async () => {
        try {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'couldNotDeferInteraction'), 'error');
        }
    };
    /* Old message whose server/device no longer exists: answer first, then remove it */
    const deleteStale = async () => {
        await defer();
        try { await interaction.message.delete(); }
        catch (e) { /* already gone */ }
    };

    if (instance.blacklist['discordIds'].includes(interaction.user.id) &&
        !interaction.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator)) {
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userPartOfBlacklist', {
            id: `${verifyId}`,
            user: `${interaction.user.username} (${interaction.user.id})`
        }));
        await defer();
        return;
    }

    const BATTLEMETRICS_BUTTONS = ['DisplayInformationBattlemetricsAllOnlinePlayers', 'BattlemetricsServerNameChanges',
        'BattlemetricsTrackerNameChanges', 'BattlemetricsGlobalNameChanges', 'BattlemetricsGlobalLogin',
        'BattlemetricsGlobalLogout'];
    if (Config.battlemetrics.token === '' && (BATTLEMETRICS_BUTTONS.includes(interaction.customId) ||
        interaction.customId.startsWith('Tracker') || interaction.customId.startsWith('CreateTracker') ||
        interaction.customId.startsWith('ServerEdit'))) {
        /* Without a BattleMetrics token these do nothing, but the click must still be answered */
        await defer();
        return;
    }

    if (interaction.customId.startsWith('DiscordNotification')) {
        const ids = CustomId.parse('DiscordNotification', interaction.customId, instance);
        const setting = instance.notificationSettings[ids.setting];

        setting.discord = !setting.discord;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.notificationSettings[ids.setting].discord = setting.discord;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${setting.discord}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getNotificationButtons(
                guildId, ids.setting, setting.discord, setting.inGame, setting.voice)]
        });
    }
    else if (interaction.customId.startsWith('InGameNotification')) {
        const ids = CustomId.parse('InGameNotification', interaction.customId, instance);
        const setting = instance.notificationSettings[ids.setting];

        setting.inGame = !setting.inGame;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.notificationSettings[ids.setting].inGame = setting.inGame;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${setting.inGame}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getNotificationButtons(
                guildId, ids.setting, setting.discord, setting.inGame, setting.voice)]
        });
    }
    else if (interaction.customId.startsWith('VoiceNotification')) {
        const ids = CustomId.parse('VoiceNotification', interaction.customId, instance);
        const setting = instance.notificationSettings[ids.setting];

        setting.voice = !setting.voice;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.notificationSettings[ids.setting].voice = setting.voice;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${setting.voice}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getNotificationButtons(
                guildId, ids.setting, setting.discord, setting.inGame, setting.voice)]
        });
    }
    else if (interaction.customId === 'AllowInGameCommands') {
        instance.generalSettings.inGameCommandsEnabled = !instance.generalSettings.inGameCommandsEnabled;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.inGameCommandsEnabled = instance.generalSettings.inGameCommandsEnabled;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.inGameCommandsEnabled}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getInGameCommandsEnabledButton(guildId,
                instance.generalSettings.inGameCommandsEnabled)]
        });
    }
    else if (interaction.customId === 'BotMutedInGame') {
        instance.generalSettings.muteInGameBotMessages = !instance.generalSettings.muteInGameBotMessages;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.muteInGameBotMessages = instance.generalSettings.muteInGameBotMessages;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.muteInGameBotMessages}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getBotMutedInGameButton(guildId,
                instance.generalSettings.muteInGameBotMessages)]
        });
    }
    else if (interaction.customId === 'InGameTeammateConnection') {
        instance.generalSettings.connectionNotify = !instance.generalSettings.connectionNotify;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.connectionNotify = instance.generalSettings.connectionNotify;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.connectionNotify}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getInGameTeammateNotificationsButtons(guildId)]
        });
    }
    else if (interaction.customId === 'InGameTeammateAfk') {
        instance.generalSettings.afkNotify = !instance.generalSettings.afkNotify;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.afkNotify = instance.generalSettings.afkNotify;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.afkNotify}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getInGameTeammateNotificationsButtons(guildId)]
        });
    }
    else if (interaction.customId === 'InGameTeammateDeath') {
        instance.generalSettings.deathNotify = !instance.generalSettings.deathNotify;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.deathNotify = instance.generalSettings.deathNotify;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.deathNotify}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getInGameTeammateNotificationsButtons(guildId)]
        });
    }
    else if (interaction.customId === 'FcmAlarmNotification') {
        instance.generalSettings.fcmAlarmNotificationEnabled = !instance.generalSettings.fcmAlarmNotificationEnabled;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.fcmAlarmNotificationEnabled =
            instance.generalSettings.fcmAlarmNotificationEnabled;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.fcmAlarmNotificationEnabled}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getFcmAlarmNotificationButtons(
                guildId,
                instance.generalSettings.fcmAlarmNotificationEnabled,
                instance.generalSettings.fcmAlarmNotificationEveryone)]
        });
    }
    else if (interaction.customId === 'FcmAlarmNotificationEveryone') {
        instance.generalSettings.fcmAlarmNotificationEveryone = !instance.generalSettings.fcmAlarmNotificationEveryone;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.fcmAlarmNotificationEveryone =
            instance.generalSettings.fcmAlarmNotificationEveryone;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.fcmAlarmNotificationEveryone}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getFcmAlarmNotificationButtons(
                guildId,
                instance.generalSettings.fcmAlarmNotificationEnabled,
                instance.generalSettings.fcmAlarmNotificationEveryone)]
        });
    }
    else if (interaction.customId === 'SmartAlarmNotifyInGame') {
        instance.generalSettings.smartAlarmNotifyInGame = !instance.generalSettings.smartAlarmNotifyInGame;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.smartAlarmNotifyInGame =
            instance.generalSettings.smartAlarmNotifyInGame;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.smartAlarmNotifyInGame}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getSmartAlarmNotifyInGameButton(
                guildId,
                instance.generalSettings.smartAlarmNotifyInGame)]
        });
    }
    else if (interaction.customId === 'SmartSwitchNotifyInGameWhenChangedFromDiscord') {
        instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord =
            !instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord =
            instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getSmartSwitchNotifyInGameWhenChangedFromDiscordButton(
                guildId,
                instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord)]
        });
    }
    else if (interaction.customId === 'LeaderCommandEnabled') {
        instance.generalSettings.leaderCommandEnabled = !instance.generalSettings.leaderCommandEnabled;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.leaderCommandEnabled = instance.generalSettings.leaderCommandEnabled;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.leaderCommandEnabled}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getLeaderCommandEnabledButton(
                guildId,
                instance.generalSettings.leaderCommandEnabled)]
        });
    }
    else if (interaction.customId === 'LeaderCommandOnlyForPaired') {
        instance.generalSettings.leaderCommandOnlyForPaired = !instance.generalSettings.leaderCommandOnlyForPaired;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.leaderCommandOnlyForPaired =
            instance.generalSettings.leaderCommandOnlyForPaired;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.leaderCommandOnlyForPaired}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getLeaderCommandOnlyForPairedButton(
                guildId,
                instance.generalSettings.leaderCommandOnlyForPaired)]
        });
    }
    else if (interaction.customId === 'MapWipeNotifyEveryone') {
        instance.generalSettings.mapWipeNotifyEveryone = !instance.generalSettings.mapWipeNotifyEveryone;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.mapWipeNotifyEveryone =
            instance.generalSettings.mapWipeNotifyEveryone;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.mapWipeNotifyEveryone}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getMapWipeNotifyEveryoneButton(instance.generalSettings.mapWipeNotifyEveryone)]
        });
    }
    else if (interaction.customId === 'ItemAvailableNotifyInGame') {
        instance.generalSettings.itemAvailableInVendingMachineNotifyInGame =
            !instance.generalSettings.itemAvailableInVendingMachineNotifyInGame;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.itemAvailableInVendingMachineNotifyInGame =
            instance.generalSettings.itemAvailableInVendingMachineNotifyInGame;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.itemAvailableInVendingMachineNotifyInGame}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getItemAvailableNotifyInGameButton(guildId,
                instance.generalSettings.itemAvailableInVendingMachineNotifyInGame)]
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'DisplayInformationBattlemetricsAllOnlinePlayers') {
        instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers =
            !instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.displayInformationBattlemetricsAllOnlinePlayers =
            instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordButtons.getDisplayInformationBattlemetricsAllOnlinePlayersButton(guildId,
                instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers)]
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'BattlemetricsServerNameChanges') {
        instance.generalSettings.battlemetricsServerNameChanges =
            !instance.generalSettings.battlemetricsServerNameChanges;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.battlemetricsServerNameChanges =
            instance.generalSettings.battlemetricsServerNameChanges;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.battlemetricsServerNameChanges}`
        }));

        await client.interactionUpdate(interaction, {
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId)
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'BattlemetricsTrackerNameChanges') {
        instance.generalSettings.battlemetricsTrackerNameChanges =
            !instance.generalSettings.battlemetricsTrackerNameChanges;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.battlemetricsTrackerNameChanges =
            instance.generalSettings.battlemetricsTrackerNameChanges;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.battlemetricsTrackerNameChanges}`
        }));

        await client.interactionUpdate(interaction, {
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId)
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'BattlemetricsGlobalNameChanges') {
        instance.generalSettings.battlemetricsGlobalNameChanges =
            !instance.generalSettings.battlemetricsGlobalNameChanges;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.battlemetricsGlobalNameChanges =
            instance.generalSettings.battlemetricsGlobalNameChanges;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.battlemetricsGlobalNameChanges}`
        }));

        await client.interactionUpdate(interaction, {
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId)
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'BattlemetricsGlobalLogin') {
        instance.generalSettings.battlemetricsGlobalLogin =
            !instance.generalSettings.battlemetricsGlobalLogin;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.battlemetricsGlobalLogin =
            instance.generalSettings.battlemetricsGlobalLogin;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.battlemetricsGlobalLogin}`
        }));

        await client.interactionUpdate(interaction, {
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId)
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId === 'BattlemetricsGlobalLogout') {
        instance.generalSettings.battlemetricsGlobalLogout =
            !instance.generalSettings.battlemetricsGlobalLogout;
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.battlemetricsGlobalLogout =
            instance.generalSettings.battlemetricsGlobalLogout;

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.battlemetricsGlobalLogout}`
        }));

        await client.interactionUpdate(interaction, {
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId)
        });
    }
    else if (interaction.customId.startsWith('ServerConnectPurge')) {
        /* Confirmed: delete everything about the other servers, then connect to this one */
        const ids = CustomId.parse('ServerConnectPurge', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await client.interactionUpdate(interaction, {
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_INACTIVE,
                    description: client.intlGet(guildId, 'serverConnectPurgeNoPermission')
                })],
                components: []
            });
            return;
        }
        if (!server) {
            await client.interactionUpdate(interaction, {
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_DEFAULT,
                    description: client.intlGet(guildId, 'cleanupOutdated')
                })],
                components: []
            });
            return;
        }

        /* A second click while it is still working does nothing */
        if (!client.connectPurging) client.connectPurging = {};
        if (client.connectPurging[guildId]) {
            try { await interaction.deferUpdate(); } catch (e) { /* ignore */ }
            return;
        }
        client.connectPurging[guildId] = true;

        await client.interactionUpdate(interaction, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_DEFAULT,
                description: client.intlGet(guildId, 'serverConnectPurgeWorking', { server: server.title })
            })],
            components: []
        });

        /* The bot back to zero, keeping only the new server: disconnects (and stops any pending
           reconnect) before deleting, empties the channels' messages, removes everything else */
        let removed = { servers: 0, trackers: 0 };
        try {
            removed = await require('../util/serverLifecycle.js').purgeAllExcept(client, guildId, ids.serverId);
        }
        finally {
            client.connectPurging[guildId] = false;
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `connect ${ids.serverId} and purge ${JSON.stringify(removed)}`
        }));

        const fresh = client.getInstance(guildId);
        client.resetRustplusVariables(guildId);
        fresh.activeServer = ids.serverId;
        fresh.lastConnectedServer = ids.serverId;
        client.setInstance(guildId, fresh);

        const newRustplus = client.createRustplusInstance(
            guildId, server.serverIp, server.appPort, server.steamId, server.playerToken);
        await DiscordMessages.sendServerMessage(guildId, ids.serverId, null);
        if (newRustplus) newRustplus.isNewConnection = true;

        try {
            await interaction.editReply({
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_ACTIVE,
                    description: client.intlGet(guildId, 'serverConnectPurgeDone', {
                        server: server.title, servers: removed.servers, trackers: removed.trackers
                    })
                })],
                components: []
            });
        }
        catch (e) { /* the warning was in a channel that got emptied */ }
    }
    else if (interaction.customId.startsWith('ServerConnect')) {
        const ids = CustomId.parse('ServerConnect', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }

        /* Another server: everything about the previous ones is deleted first. Warn and ask. */
        if (ids.serverId !== instance.activeServer) {
            const warning = require('../util/serverLifecycle.js').getConnectPurgeMessage(client, guildId, ids.serverId);
            if (warning) {
                if (!client.canManage(interaction)) {
                    await client.interactionReply(interaction, {
                        embeds: [DiscordEmbeds.getEmbed({
                            color: Constants.COLOR_INACTIVE,
                            description: client.intlGet(guildId, 'serverConnectPurgeNoPermission')
                        })],
                        ephemeral: true
                    });
                    return;
                }
                await client.interactionReply(interaction, warning);
                return;
            }
        }

        client.resetRustplusVariables(guildId);

        if (instance.activeServer !== null) {
            await DiscordMessages.sendServerMessage(guildId, instance.activeServer, null);
        }

        instance.activeServer = ids.serverId;
        client.setInstance(guildId, instance);

        /* Disconnect previous instance is any */
        if (rustplus) {
            rustplus.isDeleted = true;
            rustplus.disconnect();
        }

        /* Create the rustplus instance */
        const newRustplus = client.createRustplusInstance(
            guildId, server.serverIp, server.appPort, server.steamId, server.playerToken);

        await DiscordMessages.sendServerMessage(guildId, ids.serverId, null, interaction);

        if (newRustplus) newRustplus.isNewConnection = true;
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('ServerEdit')) {
        const ids = CustomId.parse('ServerEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getServerEditModal(guildId, ids.serverId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('DeleteUnreachableDevices')) {
        const ids = CustomId.parse('DeleteUnreachableDevices', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server) {
            await deleteStale();
            return;
        }

        await defer();

        const groupsToUpdate = [];
        for (const [entityId, content] of Object.entries(server.switches)) {
            if (!content.reachable) {
                await DiscordTools.deleteMessageById(guildId, instance.channelId.switches, content.messageId);
                delete server.switches[entityId];

                for (const [groupId, groupContent] of Object.entries(server.switchGroups)) {
                    if (groupContent.switches.includes(`${entityId}`) && !groupsToUpdate.includes(groupId)) {
                        groupsToUpdate.push(groupId);
                    }
                }
            }
        }

        for (const groupId of groupsToUpdate) {
            await DiscordMessages.sendSmartSwitchGroupMessage(guildId, ids.serverId, groupId);
        }

        for (const [entityId, content] of Object.entries(server.alarms)) {
            if (!content.reachable) {
                await DiscordTools.deleteMessageById(guildId, instance.channelId.alarms, content.messageId)
                delete server.alarms[entityId];
            }
        }

        for (const [entityId, content] of Object.entries(server.storageMonitors)) {
            if (!content.reachable) {
                await DiscordTools.deleteMessageById(guildId, instance.channelId.storageMonitors, content.messageId)
                delete server.storageMonitors[entityId];
            }
        }

        client.setInstance(guildId, instance);
    }
    else if (interaction.customId.startsWith('CustomTimersEdit')) {
        const ids = CustomId.parse('CustomTimersEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getCustomTimersEditModal(guildId, ids.serverId);
        await interaction.showModal(modal);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('CreateTracker')) {
        const ids = CustomId.parse('CreateTracker', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }

        await defer();

        /* Find an available tracker id */
        const trackerId = client.findAvailableTrackerId(guildId);

        instance.trackers[trackerId] = {
            name: 'Tracker',
            serverId: ids.serverId,
            battlemetricsId: server.battlemetricsId,
            title: server.title,
            img: server.img,
            clanTag: '',
            everyone: false,
            inGame: true,
            players: [],
            messageId: null
        }
        client.setInstance(guildId, instance);

        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
    }
    else if (interaction.customId.startsWith('CreateGroup')) {
        const ids = CustomId.parse('CreateGroup', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }

        await defer();

        const groupId = client.findAvailableGroupId(guildId, ids.serverId);

        server.switchGroups[groupId] = {
            name: 'Group',
            command: `${groupId}`,
            switches: [],
            image: 'smart_switch.png',
            messageId: null
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${groupId}`
        }));

        await DiscordMessages.sendSmartSwitchGroupMessage(guildId, ids.serverId, groupId);
    }
    else if (interaction.customId.startsWith('ServerDisconnect') ||
        interaction.customId.startsWith('ServerReconnecting')) {
        const ids = CustomId.parse(interaction.customId.startsWith('ServerDisconnect') ?
            'ServerDisconnect' : 'ServerReconnecting', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server) {
            await deleteStale();
            return;
        }
        instance.activeServer = null;
        client.setInstance(guildId, instance);

        client.resetRustplusVariables(guildId);

        if (rustplus) {
            rustplus.isDeleted = true;
            rustplus.disconnect();
            delete client.rustplusInstances[guildId];
        }

        await DiscordMessages.sendServerMessage(guildId, ids.serverId, null, interaction);
    }
    else if (interaction.customId.startsWith('ServerDelete')) {
        const ids = CustomId.parse('ServerDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server) {
            await deleteStale();
            return;
        }

        /* Answer first: emptying the channels takes longer than the 3 seconds Discord gives */
        await defer();

        /* Deleting the server the bot is on (connected or waiting to reconnect): stop it first.
           Deleting another stored server does not touch the current connection. */
        if (ids.serverId === instance.activeServer || (rustplus && rustplus.serverId === ids.serverId)) {
            instance.activeServer = null;
            client.setInstance(guildId, instance);
            client.resetRustplusVariables(guildId);

            if (rustplus) {
                rustplus.isDeleted = true;
                rustplus.disconnect();
                delete client.rustplusInstances[guildId];
            }

            await DiscordTools.clearTextChannel(guildId, instance.channelId.switches, 100);
            await DiscordTools.clearTextChannel(guildId, instance.channelId.switchGroups, 100);
            await DiscordTools.clearTextChannel(guildId, instance.channelId.storageMonitors, 100);
        }

        for (const [entityId, content] of Object.entries(server.alarms)) {
            await DiscordTools.deleteMessageById(guildId, instance.channelId.alarms, content.messageId);
        }

        await DiscordTools.deleteMessageById(guildId, instance.channelId.servers, server.messageId);

        delete instance.serverList[ids.serverId];
        if (instance.serverListLite) delete instance.serverListLite[ids.serverId];
        client.setInstance(guildId, instance);
    }
    else if (interaction.customId.startsWith('SmartSwitchOn') ||
        interaction.customId.startsWith('SmartSwitchOff')) {
        const ids = CustomId.parse(interaction.customId.startsWith('SmartSwitchOn') ? 'SmartSwitchOn' : 'SmartSwitchOff',
            interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        if (!rustplus || (rustplus && (rustplus.serverId !== ids.serverId))) {
            await defer();
            return;
        }

        /* Answer the click now: talking to the switch can take longer than the 3 seconds Discord gives */
        await defer();

        SwitchTimers.clear(client, guildId, ids.entityId);

        const active = (interaction.customId.startsWith('SmartSwitchOn')) ? true : false;
        const prevActive = server.switches[ids.entityId].active;
        server.switches[ids.entityId].active = active;
        delete server.switches[ids.entityId].raidLock;     /* an order: the raid lock ends */
        SwitchOverride.setManual(server.switches[ids.entityId], active);
        client.setInstance(guildId, instance);

        rustplus.interactionSwitches.push(ids.entityId);

        const response = await rustplus.turnSmartSwitchAsync(ids.entityId, active);
        if (!(await rustplus.isResponseValid(response))) {
            if (server.switches[ids.entityId].reachable) {
                await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, ids.serverId, ids.entityId);
            }
            server.switches[ids.entityId].reachable = false;
            server.switches[ids.entityId].active = prevActive;
            client.setInstance(guildId, instance);

            rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== ids.entityId);
        }
        else {
            server.switches[ids.entityId].reachable = true;
            client.setInstance(guildId, instance);
        }

        if (instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord) {
            const user = interaction.user.username;
            const name = server.switches[ids.entityId].name;
            const status = active ? client.intlGet(guildId, 'onCap') : client.intlGet(guildId, 'offCap');
            const str = client.intlGet(guildId, 'userTurnedOnOffSmartSwitchFromDiscord', {
                user: user,
                name: name,
                status: status
            });

            try { rustplus.sendInGameMessage(str); } catch (e) { /* not critical */ }
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${active}`
        }));

        /* Already answered: refresh the message by its id, not through the interaction */
        const fresh = client.getInstance(guildId);
        if (fresh.serverList[ids.serverId] && fresh.serverList[ids.serverId].switches.hasOwnProperty(ids.entityId)) {
            await DiscordMessages.sendSmartSwitchMessage(guildId, ids.serverId, ids.entityId);
        }
        SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, ids.serverId, ids.entityId);
    }
    else if (interaction.customId.startsWith('SmartSwitchResumeAuto')) {
        const ids = CustomId.parse('SmartSwitchResumeAuto', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        SwitchOverride.clear(server.switches[ids.entityId]);
        client.setInstance(guildId, instance);

        /* A pending timed command (e.g. "turn back off in 5 min") would later go against the automatic mode */
        SwitchTimers.clear(client, guildId, ids.entityId);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `resume auto ${ids.entityId}`
        }));

        await DiscordMessages.sendSmartSwitchMessage(guildId, ids.serverId, ids.entityId, interaction);
    }
    else if (interaction.customId.startsWith('SmartSwitchEdit')) {
        const ids = CustomId.parse('SmartSwitchEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getSmartSwitchEditModal(guildId, ids.serverId, ids.entityId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('SmartSwitchDelete')) {
        const ids = CustomId.parse('SmartSwitchDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        await defer();

        /* Removed from the bot first: an update on its way can no longer bring the message back */
        const messageIdToDelete = server.switches[ids.entityId].messageId;
        delete server.switches[ids.entityId];
        client.setInstance(guildId, instance);
        await DiscordTools.deleteMessageById(guildId, instance.channelId.switches, messageIdToDelete);

        SwitchTimers.clear(client, guildId, ids.entityId);

        for (const [groupId, content] of Object.entries(server.switchGroups)) {
            if (content.switches.includes(ids.entityId.toString())) {
                server.switchGroups[groupId].switches = content.switches.filter(e => e !== ids.entityId.toString());
                client.setInstance(guildId, instance);
                await DiscordMessages.sendSmartSwitchGroupMessage(guildId, ids.serverId, groupId);
            }
        }
        client.setInstance(guildId, instance);
    }
    else if (interaction.customId.startsWith('SmartAlarmEveryone')) {
        const ids = CustomId.parse('SmartAlarmEveryone', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.alarms.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        server.alarms[ids.entityId].everyone = !server.alarms[ids.entityId].everyone;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${server.alarms[ids.entityId].everyone}`
        }));

        await DiscordMessages.sendSmartAlarmMessage(guildId, ids.serverId, ids.entityId, interaction);
    }
    else if (interaction.customId.startsWith('SmartAlarmRaidMode')) {
        const ids = CustomId.parse('SmartAlarmRaidMode', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.alarms.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        server.alarms[ids.entityId].raidMode = server.alarms[ids.entityId].raidMode === false;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${server.alarms[ids.entityId].raidMode}`
        }));

        await DiscordMessages.sendSmartAlarmMessage(guildId, ids.serverId, ids.entityId, interaction);
    }
    else if (interaction.customId === 'RaidAcknowledge') {
        await require('./raidHandler.js').acknowledge(client, interaction);
    }
    else if (interaction.customId.startsWith('SmartAlarmDelete')) {
        const ids = CustomId.parse('SmartAlarmDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server || (server && !server.alarms.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        await defer();

        /* Removed from the bot first: an update on its way can no longer bring the message back */
        const messageIdToDelete = server.alarms[ids.entityId].messageId;
        delete server.alarms[ids.entityId];
        client.setInstance(guildId, instance);
        await DiscordTools.deleteMessageById(guildId, instance.channelId.alarms, messageIdToDelete);
    }
    else if (interaction.customId.startsWith('SmartAlarmEdit')) {
        const ids = CustomId.parse('SmartAlarmEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.alarms.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getSmartAlarmEditModal(guildId, ids.serverId, ids.entityId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('StorageMonitorToolCupboardEveryone')) {
        const ids = CustomId.parse('StorageMonitorToolCupboardEveryone', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        server.storageMonitors[ids.entityId].everyone = !server.storageMonitors[ids.entityId].everyone;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${server.storageMonitors[ids.entityId].everyone}`
        }));

        await DiscordMessages.sendStorageMonitorMessage(guildId, ids.serverId, ids.entityId, interaction);
    }
    else if (interaction.customId.startsWith('StorageMonitorToolCupboardInGame')) {
        const ids = CustomId.parse('StorageMonitorToolCupboardInGame', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        server.storageMonitors[ids.entityId].inGame = !server.storageMonitors[ids.entityId].inGame;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${server.storageMonitors[ids.entityId].inGame}`
        }));

        await DiscordMessages.sendStorageMonitorMessage(guildId, ids.serverId, ids.entityId, interaction);
    }
    else if (interaction.customId.startsWith('StorageMonitorEdit')) {
        const ids = CustomId.parse('StorageMonitorEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getStorageMonitorEditModal(guildId, ids.serverId, ids.entityId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('StorageMonitorToolCupboardDelete')) {
        const ids = CustomId.parse('StorageMonitorToolCupboardDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        await defer();

        /* Removed from the bot first: an update on its way can no longer bring the message back */
        const messageIdToDelete = server.storageMonitors[ids.entityId].messageId;
        delete server.storageMonitors[ids.entityId];
        client.setInstance(guildId, instance);
        await DiscordTools.deleteMessageById(guildId, instance.channelId.storageMonitors, messageIdToDelete);
    }
    else if (interaction.customId.startsWith('StorageMonitorRecycle')) {
        const ids = CustomId.parse('StorageMonitorRecycle', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        await defer();

        if (!rustplus || (rustplus && rustplus.serverId !== ids.serverId)) return;

        const entityInfo = await rustplus.getEntityInfoAsync(ids.entityId);
        if (!(await rustplus.isResponseValid(entityInfo))) {
            if (server.storageMonitors[ids.entityId].reachable) {
                await DiscordMessages.sendStorageMonitorNotFoundMessage(guildId, ids.serverId, ids.entityId);
            }
            server.storageMonitors[ids.entityId].reachable = false;
            client.setInstance(guildId, instance);

            await DiscordMessages.sendStorageMonitorMessage(guildId, ids.serverId, ids.entityId);
            return;
        }

        server.storageMonitors[ids.entityId].reachable = true;
        client.setInstance(guildId, instance);

        const items = client.rustlabs.getRecycleDataFromArray(entityInfo.entityInfo.payload.items);

        const message = await DiscordMessages.sendStorageMonitorRecycleMessage(
            guildId, ids.serverId, ids.entityId, items);

        if (message && message.id) {
            setTimeout(async () => {
                try { await DiscordTools.deleteMessageById(guildId, instance.channelId.storageMonitors, message.id); }
                catch (e) { /* already gone */ }
            }, 30000);
        }
    }
    else if (interaction.customId.startsWith('StorageMonitorContainerDelete')) {
        const ids = CustomId.parse('StorageMonitorContainerDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            await deleteStale();
            return;
        }

        await defer();

        /* Removed from the bot first: an update on its way can no longer bring the message back */
        const messageIdToDelete = server.storageMonitors[ids.entityId].messageId;
        delete server.storageMonitors[ids.entityId];
        client.setInstance(guildId, instance);
        await DiscordTools.deleteMessageById(guildId, instance.channelId.storageMonitors, messageIdToDelete);
    }
    else if (interaction.customId === 'RecycleDelete') {
        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        await deleteStale();
    }
    else if (interaction.customId.startsWith('GroupTurnOn') ||
        interaction.customId.startsWith('GroupTurnOff')) {
        const ids = CustomId.parse(interaction.customId.startsWith('GroupTurnOn') ? 'GroupTurnOn' : 'GroupTurnOff',
            interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            await deleteStale();
            return;
        }

        await defer();

        /* Cleared even while reconnecting: the timers are kept per guild and survive it */
        SwitchTimers.clear(client, guildId, ids.groupId);

        if (rustplus) {
            if (rustplus.serverId === ids.serverId) {
                const active = (interaction.customId.startsWith('GroupTurnOn') ? true : false);

                if (instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord) {
                    const user = interaction.user.username;
                    const name = server.switchGroups[ids.groupId].name;
                    const status = active ? client.intlGet(guildId, 'onCap') : client.intlGet(guildId, 'offCap');
                    const str = client.intlGet(guildId, 'userTurnedOnOffSmartSwitchGroupFromDiscord', {
                        user: user,
                        name: name,
                        status: status
                    });

                    try { rustplus.sendInGameMessage(str); } catch (e) { /* not critical */ }
                }

                client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
                    id: `${verifyId}`,
                    value: `${active}`
                }));

                await SmartSwitchGroupHandler.TurnOnOffGroup(
                    client, rustplus, guildId, ids.serverId, ids.groupId, active);
            }
        }
    }
    else if (interaction.customId.startsWith('GroupEdit')) {
        const ids = CustomId.parse('GroupEdit', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getGroupEditModal(guildId, ids.serverId, ids.groupId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('GroupDelete')) {
        const ids = CustomId.parse('GroupDelete', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            await deleteStale();
            return;
        }

        SwitchTimers.clear(client, guildId, ids.groupId);

        await defer();

        if (server.switchGroups.hasOwnProperty(ids.groupId)) {
            /* Removed from the bot first: an update on its way can no longer bring the message back */
            const messageIdToDelete = server.switchGroups[ids.groupId].messageId;
            delete server.switchGroups[ids.groupId];
            client.setInstance(guildId, instance);
            await DiscordTools.deleteMessageById(guildId, instance.channelId.switchGroups, messageIdToDelete);
        }
    }
    else if (interaction.customId.startsWith('GroupAddSwitch')) {
        const ids = CustomId.parse('GroupAddSwitch', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getGroupAddSwitchModal(guildId, ids.serverId, ids.groupId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('GroupRemoveSwitch')) {
        const ids = CustomId.parse('GroupRemoveSwitch', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getGroupRemoveSwitchModal(guildId, ids.serverId, ids.groupId);
        await interaction.showModal(modal);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerEveryone')) {
        const ids = CustomId.parse('TrackerEveryone', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        tracker.everyone = !tracker.everyone;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${tracker.everyone}`
        }));

        await DiscordMessages.sendTrackerMessage(guildId, ids.trackerId, interaction);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerClanAlerts')) {
        const ids = CustomId.parse('TrackerClanAlerts', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        tracker.clanAlerts = tracker.clanAlerts === false;
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${tracker.clanAlerts}`
        }));

        await DiscordMessages.sendTrackerMessage(guildId, ids.trackerId, interaction);
    }
    else if (interaction.customId === 'MarketBoardAdd') {
        const modal = DiscordModals.getMarketBoardAddModal(guildId);
        await interaction.showModal(modal);
    }
    else if (interaction.customId.startsWith('MarketBoardRemove')) {
        const ids = CustomId.parse('MarketBoardRemove', interaction.customId, instance);

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        /* Answer first: the board is redrawn, which can take longer than 3 seconds */
        await defer();
        const removed = await require('./marketHandler.js').removeEntry(client, guildId, ids.id);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `market board remove ${ids.id}: ${removed}`
        }));

        if (!removed) {
            try { await interaction.message.delete(); } catch (e) { /* already gone */ }
        }
    }
    else if (interaction.customId === 'PurgeAll') {
        if (!client.canManage(interaction)) {
            await defer();
            return;
        }
        await client.interactionUpdate(interaction, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_DEFAULT,
                description: client.intlGet(guildId, 'serverChangeWorking')
            })],
            components: []
        });
        const removed = await require('../util/serverLifecycle.js').purgeEverything(client, guildId);
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `purge all ${JSON.stringify(removed)}`
        }));
        await DiscordMessages.sendMessage(guildId, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_ACTIVE,
                title: client.intlGet(guildId, 'serverChangeDoneTitle'),
                description: client.intlGet(guildId, 'purgeAllDoneDesc', removed)
            })]
        }, null, instance.channelId.activity);
    }
    else if (interaction.customId.startsWith('ServerChangeCleanup')) {
        const ids = CustomId.parse('ServerChangeCleanup', interaction.customId, instance);

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        /* Old button: the bot is now on another server, or that server no longer exists.
           Running it would delete the server the bot is connected to. */
        if (ids.serverId !== instance.activeServer || !instance.serverList[ids.serverId]) {
            await client.interactionUpdate(interaction, {
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_DEFAULT,
                    description: client.intlGet(guildId, 'cleanupOutdated')
                })],
                components: []
            });
            return;
        }

        await client.interactionUpdate(interaction, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_DEFAULT,
                description: client.intlGet(guildId, 'serverChangeWorking')
            })],
            components: []
        });

        const removed = await require('../util/serverLifecycle.js').purgeOtherServers(client, guildId, ids.serverId);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `server change cleanup ${JSON.stringify(removed)}`
        }));

        await DiscordMessages.sendMessage(guildId, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_ACTIVE,
                title: client.intlGet(guildId, 'serverChangeDoneTitle'),
                description: client.intlGet(guildId, 'serverChangeDoneDesc', removed)
            })]
        }, null, instance.channelId.activity);
    }
    else if (interaction.customId.startsWith('WipeCleanup')) {
        const ids = CustomId.parse('WipeCleanup', interaction.customId, instance);

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!instance.serverList[ids.serverId]) {
            await client.interactionUpdate(interaction, {
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_DEFAULT,
                    description: client.intlGet(guildId, 'cleanupOutdated')
                })],
                components: []
            });
            return;
        }

        /* Answer first: Discord gives only 3 seconds and the cleanup can take longer */
        await client.interactionUpdate(interaction, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_DEFAULT,
                description: client.intlGet(guildId, 'wipeCleanupWorking')
            })],
            components: []
        });

        const removed = await require('../util/serverLifecycle.js').cleanupUnreachableDevices(
            client, guildId, ids.serverId);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `wipe cleanup ${JSON.stringify(removed)}`
        }));

        let description = client.intlGet(guildId, 'wipeCleanupDoneDesc', removed);
        if (removed.kept > 0) description += `\n${client.intlGet(guildId, 'wipeCleanupKept', { kept: removed.kept })}`;
        const done = {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_ACTIVE,
                title: client.intlGet(guildId, 'wipeCleanupDoneTitle'),
                description: description
            })],
            components: []
        };
        try { await interaction.editReply(done); }
        catch (e) {
            /* The message was in #base, which the cleanup empties: send the result to #activity */
            await DiscordMessages.sendMessage(guildId, done, null, instance.channelId.activity);
        }
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerSchedule')) {
        const ids = CustomId.parse('TrackerSchedule', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        await client.interactionReply(interaction, {
            embeds: [DiscordEmbeds.getTrackerScheduleEmbed(guildId, ids.trackerId)],
            ephemeral: true
        });
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerUpdate')) {
        const ids = CustomId.parse('TrackerUpdate', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        // TODO! Remove name change icon from status

        await DiscordMessages.sendTrackerMessage(guildId, ids.trackerId, interaction);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerEdit')) {
        const ids = CustomId.parse('TrackerEdit', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getTrackerEditModal(guildId, ids.trackerId);
        await interaction.showModal(modal);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerDelete')) {
        const ids = CustomId.parse('TrackerDelete', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!client.canManage(interaction)) {
            await defer();
            return;
        }

        if (!tracker) {
            await deleteStale();
            return;
        }

        await defer();

        /* Removed from the bot first: an update on its way can no longer bring the message back */
        const messageIdToDelete = tracker.messageId;
        delete instance.trackers[ids.trackerId];
        client.setInstance(guildId, instance);
        await DiscordTools.deleteMessageById(guildId, instance.channelId.trackers, messageIdToDelete);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerAddPlayer')) {
        const ids = CustomId.parse('TrackerAddPlayer', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getTrackerAddPlayerModal(guildId, ids.trackerId);
        await interaction.showModal(modal);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerRemovePlayer')) {
        const ids = CustomId.parse('TrackerRemovePlayer', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        const modal = DiscordModals.getTrackerRemovePlayerModal(guildId, ids.trackerId);
        await interaction.showModal(modal);
    }
    else if (Config.battlemetrics.token !== '' && interaction.customId.startsWith('TrackerInGame')) {
        const ids = CustomId.parse('TrackerInGame', interaction.customId, instance);
        const tracker = instance.trackers[ids.trackerId];

        if (!tracker) {
            await deleteStale();
            return;
        }

        tracker.inGame = !tracker.inGame;
        client.setInstance(guildId, instance);


        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'buttonValueChange', {
            id: `${verifyId}`,
            value: `${tracker.inGame}`
        }));

        await DiscordMessages.sendTrackerMessage(guildId, ids.trackerId, interaction);
    }

    client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userButtonInteractionSuccess', {
        id: `${verifyId}`
    }));
}
