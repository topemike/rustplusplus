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

const Battlemetrics = require('../structures/Battlemetrics');
const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const RaidTargets = require('../util/raidTargets.js');
const Keywords = require('../util/keywords.js');
const Scrape = require('../util/scrape.js');

module.exports = async (client, interaction) => {
    const instance = client.getInstance(interaction.guildId);
    const guildId = interaction.guildId;

    const verifyId = Math.floor(100000 + Math.random() * 900000);
    client.logInteraction(interaction, verifyId, 'userModal');

    if (instance.blacklist['discordIds'].includes(interaction.user.id) &&
        !interaction.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator)) {
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userPartOfBlacklist', {
            id: `${verifyId}`,
            user: `${interaction.user.username} (${interaction.user.id})`
        }));
        return;
    }

    if (interaction.customId.startsWith('CustomTimersEdit')) {
        const ids = JSON.parse(interaction.customId.replace('CustomTimersEdit', ''));
        const server = instance.serverList[ids.serverId];
        const cargoShipEgressTime = parseInt(interaction.fields.getTextInputValue('CargoShipEgressTime'));
        const oilRigCrateUnlockTime = parseInt(interaction.fields.getTextInputValue('OilRigCrateUnlockTime'));
        const bradleyRespawnTime = parseInt(interaction.fields.getTextInputValue('BradleyRespawnTime'));

        if (!server) {
            interaction.deferUpdate();
            return;
        }

        if (cargoShipEgressTime && ((cargoShipEgressTime * 1000) !== server.cargoShipEgressTimeMs)) {
            server.cargoShipEgressTimeMs = cargoShipEgressTime * 1000;
        }
        if (oilRigCrateUnlockTime && ((oilRigCrateUnlockTime * 1000) !== server.oilRigLockedCrateUnlockTimeMs)) {
            server.oilRigLockedCrateUnlockTimeMs = oilRigCrateUnlockTime * 1000;
        }
        if (bradleyRespawnTime && bradleyRespawnTime > 0) {
            server.bradleyRespawnTimeMs = bradleyRespawnTime * 1000;
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${server.cargoShipEgressTimeMs}, ${server.oilRigLockedCrateUnlockTimeMs}, ${server.bradleyRespawnTimeMs}`
        }));
    }
    else if (interaction.customId.startsWith('ServerEdit')) {
        const ids = JSON.parse(interaction.customId.replace('ServerEdit', ''));
        const server = instance.serverList[ids.serverId];
        const battlemetricsId = interaction.fields.getTextInputValue('ServerBattlemetricsId');

        if (battlemetricsId !== server.battlemetricsId) {
            if (battlemetricsId === '') {
                server.battlemetricsId = null;
            }
            else if (client.battlemetricsInstances.hasOwnProperty(battlemetricsId)) {
                const bmInstance = client.battlemetricsInstances[battlemetricsId];
                server.battlemetricsId = battlemetricsId;
                server.connect = `connect ${bmInstance.server_ip}:${bmInstance.server_port}`;
            }
            else {
                const bmInstance = new Battlemetrics(battlemetricsId);
                await bmInstance.setup();
                if (bmInstance.lastUpdateSuccessful) {
                    client.battlemetricsInstances[battlemetricsId] = bmInstance;
                    server.battlemetricsId = battlemetricsId;
                    server.connect = `connect ${bmInstance.server_ip}:${bmInstance.server_port}`;
                }
            }
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${server.battlemetricsId}`
        }));

        await DiscordMessages.sendServerMessage(interaction.guildId, ids.serverId);

        /* To force search of player name via scrape */
        client.battlemetricsIntervalCounter = 0;
    }
    else if (interaction.customId.startsWith('SmartSwitchEdit')) {
        const ids = JSON.parse(interaction.customId.replace('SmartSwitchEdit', ''));
        const server = instance.serverList[ids.serverId];
        const smartSwitchName = interaction.fields.getTextInputValue('SmartSwitchName');
        const smartSwitchCommand = interaction.fields.getTextInputValue('SmartSwitchCommand');
        let smartSwitchProximity = null;
        try {
            smartSwitchProximity = parseInt(interaction.fields.getTextInputValue('SmartSwitchProximity'));
        }
        catch (e) {
            smartSwitchProximity = null;
        }

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            interaction.deferUpdate();
            return;
        }

        server.switches[ids.entityId].name = smartSwitchName;

        if (smartSwitchCommand !== server.switches[ids.entityId].command &&
            !Keywords.getListOfUsedKeywords(client, guildId, ids.serverId).includes(smartSwitchCommand)) {
            server.switches[ids.entityId].command = smartSwitchCommand;
        }

        if (smartSwitchProximity !== null && smartSwitchProximity >= 0) {
            server.switches[ids.entityId].proximity = smartSwitchProximity;
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${smartSwitchName}, ${server.switches[ids.entityId].command}`
        }));

        await DiscordMessages.sendSmartSwitchMessage(guildId, ids.serverId, ids.entityId);
    }
    else if (interaction.customId.startsWith('GroupEdit')) {
        const ids = JSON.parse(interaction.customId.replace('GroupEdit', ''));
        const server = instance.serverList[ids.serverId];
        const groupName = interaction.fields.getTextInputValue('GroupName');
        const groupCommand = interaction.fields.getTextInputValue('GroupCommand');

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            interaction.deferUpdate();
            return;
        }

        server.switchGroups[ids.groupId].name = groupName;

        if (groupCommand !== server.switchGroups[ids.groupId].command &&
            !Keywords.getListOfUsedKeywords(client, interaction.guildId, ids.serverId).includes(groupCommand)) {
            server.switchGroups[ids.groupId].command = groupCommand;
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${groupName}, ${server.switchGroups[ids.groupId].command}`
        }));

        await DiscordMessages.sendSmartSwitchGroupMessage(interaction.guildId, ids.serverId, ids.groupId);
    }
    else if (interaction.customId.startsWith('GroupAddSwitch')) {
        const ids = JSON.parse(interaction.customId.replace('GroupAddSwitch', ''));
        const server = instance.serverList[ids.serverId];
        const switchId = interaction.fields.getTextInputValue('GroupAddSwitchId');

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            interaction.deferUpdate();
            return;
        }

        if (!Object.keys(server.switches).includes(switchId) ||
            server.switchGroups[ids.groupId].switches.includes(switchId)) {
            interaction.deferUpdate();
            return;
        }

        server.switchGroups[ids.groupId].switches.push(switchId);
        client.setInstance(interaction.guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${switchId}`
        }));

        await DiscordMessages.sendSmartSwitchGroupMessage(interaction.guildId, ids.serverId, ids.groupId);
    }
    else if (interaction.customId.startsWith('GroupRemoveSwitch')) {
        const ids = JSON.parse(interaction.customId.replace('GroupRemoveSwitch', ''));
        const server = instance.serverList[ids.serverId];
        const switchId = interaction.fields.getTextInputValue('GroupRemoveSwitchId');

        if (!server || (server && !server.switchGroups.hasOwnProperty(ids.groupId))) {
            interaction.deferUpdate();
            return;
        }

        server.switchGroups[ids.groupId].switches =
            server.switchGroups[ids.groupId].switches.filter(e => e !== switchId);
        client.setInstance(interaction.guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${switchId}`
        }));

        await DiscordMessages.sendSmartSwitchGroupMessage(interaction.guildId, ids.serverId, ids.groupId);
    }
    else if (interaction.customId === 'MarketBoardAdd') {
        const MarketHandler = require('./marketHandler.js');
        const text = interaction.fields.getTextInputValue('MarketBoardItems');
        MarketHandler.ensureBoard(instance, client.items);
        const result = MarketHandler.addToBoard(instance, client.items, text);
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `market board add: ${JSON.stringify(result)}`
        }));

        const lines = [];
        if (result.added.length > 0) lines.push(client.intlGet(guildId, 'marketBoardAdded', { items: result.added.join(', ') }));
        if (result.duplicated.length > 0) {
            lines.push(client.intlGet(guildId, 'marketBoardDuplicated', { items: result.duplicated.join(', ') }));
        }
        if (result.unknown.length > 0) lines.push(client.intlGet(guildId, 'marketBoardUnknown', { items: result.unknown.join(', ') }));
        await client.interactionReply(interaction, {
            embeds: [DiscordEmbeds.getEmbed({ color: Constants.COLOR_DEFAULT, description: lines.join('\n') || '-' })],
            ephemeral: true
        });

        const rustplus = client.rustplusInstances[guildId];
        if (rustplus && rustplus.isOperational) await MarketHandler.updateBoard(client, rustplus);
        return;
    }
    else if (interaction.customId.startsWith('SmartAlarmEdit')) {
        const ids = JSON.parse(interaction.customId.replace('SmartAlarmEdit', ''));
        const server = instance.serverList[ids.serverId];
        const smartAlarmName = interaction.fields.getTextInputValue('SmartAlarmName');
        const smartAlarmMessage = interaction.fields.getTextInputValue('SmartAlarmMessage');
        const smartAlarmCommand = interaction.fields.getTextInputValue('SmartAlarmCommand');

        if (!server || (server && !server.alarms.hasOwnProperty(ids.entityId))) {
            interaction.deferUpdate();
            return;
        }

        server.alarms[ids.entityId].name = smartAlarmName;
        server.alarms[ids.entityId].message = smartAlarmMessage;

        const actionsText = interaction.fields.getTextInputValue('SmartAlarmActions');
        const holdMinutes = parseInt(interaction.fields.getTextInputValue('SmartAlarmHoldMinutes'));
        const targets = RaidTargets.resolveActionTargets(server, actionsText);
        if (targets.groups.length === 0 && targets.switches.length === 0) {
            delete server.alarms[ids.entityId].actions;
        }
        else {
            server.alarms[ids.entityId].actions = {
                groups: targets.groups,
                switches: targets.switches,
                holdMinutes: holdMinutes > 0 ? holdMinutes : Config.raid.defaultHoldMinutes
            };
        }
        if (targets.unknown.length > 0) {
            client.log(client.intlGet(null, 'warningCap'),
                `Alarm actions: unknown switches/groups: ${targets.unknown.join(', ')}`);
        }

        if (smartAlarmCommand !== server.alarms[ids.entityId].command &&
            !Keywords.getListOfUsedKeywords(client, guildId, ids.serverId).includes(smartAlarmCommand)) {
            server.alarms[ids.entityId].command = smartAlarmCommand;
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${smartAlarmName}, ${smartAlarmMessage}, ${server.alarms[ids.entityId].command}`
        }));

        await DiscordMessages.sendSmartAlarmMessage(interaction.guildId, ids.serverId, ids.entityId);
    }
    else if (interaction.customId.startsWith('StorageMonitorEdit')) {
        const ids = JSON.parse(interaction.customId.replace('StorageMonitorEdit', ''));
        const server = instance.serverList[ids.serverId];
        const storageMonitorName = interaction.fields.getTextInputValue('StorageMonitorName');

        if (!server || (server && !server.storageMonitors.hasOwnProperty(ids.entityId))) {
            interaction.deferUpdate();
            return;
        }

        server.storageMonitors[ids.entityId].name = storageMonitorName;
        client.setInstance(interaction.guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${storageMonitorName}`
        }));

        await DiscordMessages.sendStorageMonitorMessage(interaction.guildId, ids.serverId, ids.entityId);
    }
    else if (interaction.customId.startsWith('TrackerEdit')) {
        const ids = JSON.parse(interaction.customId.replace('TrackerEdit', ''));
        const tracker = instance.trackers[ids.trackerId];
        const trackerName = interaction.fields.getTextInputValue('TrackerName');
        const trackerBattlemetricsId = interaction.fields.getTextInputValue('TrackerBattlemetricsId');
        const trackerClanTag = interaction.fields.getTextInputValue('TrackerClanTag');

        if (!tracker) {
            interaction.deferUpdate();
            return;
        }

        tracker.name = trackerName;
        if (trackerClanTag !== tracker.clanTag) {
            tracker.clanTag = trackerClanTag;
            client.battlemetricsIntervalCounter = 0;
        }

        if (trackerBattlemetricsId !== tracker.battlemetricsId) {
            if (client.battlemetricsInstances.hasOwnProperty(trackerBattlemetricsId)) {
                const bmInstance = client.battlemetricsInstances[trackerBattlemetricsId];
                tracker.battlemetricsId = trackerBattlemetricsId;
                tracker.serverId = `${bmInstance.server_ip}-${bmInstance.server_port}`;
                tracker.img = Constants.DEFAULT_SERVER_IMG;
                tracker.title = bmInstance.server_name;
            }
            else {
                const bmInstance = new Battlemetrics(trackerBattlemetricsId);
                await bmInstance.setup();
                if (bmInstance.lastUpdateSuccessful) {
                    client.battlemetricsInstances[trackerBattlemetricsId] = bmInstance;
                    tracker.battlemetricsId = trackerBattlemetricsId;
                    tracker.serverId = `${bmInstance.server_ip}-${bmInstance.server_port}`;
                    tracker.img = Constants.DEFAULT_SERVER_IMG;
                    tracker.title = bmInstance.server_name;
                }
            }
        }
        client.setInstance(guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${trackerName}, ${tracker.battlemetricsId}, ${tracker.clanTag}`
        }));

        await DiscordMessages.sendTrackerMessage(interaction.guildId, ids.trackerId);
    }
    else if (interaction.customId.startsWith('TrackerAddPlayer')) {
        const ids = JSON.parse(interaction.customId.replace('TrackerAddPlayer', ''));
        const tracker = instance.trackers[ids.trackerId];
        const id = interaction.fields.getTextInputValue('TrackerAddPlayerId').trim();

        if (!tracker || id === '') {
            interaction.deferUpdate();
            return;
        }

        /* Looking the player up can take a few seconds */
        await interaction.deferReply({ ephemeral: true });

        const bmInstance = client.battlemetricsInstances[tracker.battlemetricsId];
        let found;
        try {
            found = await require('../util/trackerResolve.js').resolve(client, bmInstance, id);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Tracker add player: ${e}`, 'error');
            await interaction.editReply({
                embeds: [DiscordEmbeds.getEmbed({
                    color: Constants.COLOR_INACTIVE,
                    description: client.intlGet(guildId, 'trackerPlayerLookupFailed')
                })]
            });
            return;
        }

        const duplicate = tracker.players.some(e =>
            (found.steamId !== null && e.steamId === found.steamId) ||
            (found.playerId !== null && e.playerId === found.playerId));

        let text;
        if (duplicate) {
            text = client.intlGet(guildId, 'trackerPlayerAlready', { name: found.name });
        }
        else {
            tracker.players.push({ name: found.name, steamId: found.steamId, playerId: found.playerId });
            client.setInstance(interaction.guildId, instance);
            await DiscordMessages.sendTrackerMessage(interaction.guildId, ids.trackerId);
            text = found.playerId !== null ?
                client.intlGet(guildId, 'trackerPlayerAdded', { name: found.name, id: found.playerId }) :
                client.intlGet(guildId, 'trackerPlayerAddedNotFound', { name: found.name });
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${id} -> ${JSON.stringify(found)}`
        }));

        await interaction.editReply({
            embeds: [DiscordEmbeds.getEmbed({
                color: duplicate || found.playerId === null ? Constants.COLOR_INACTIVE : Constants.COLOR_ACTIVE,
                description: text
            })]
        });
        return;
    }
    else if (interaction.customId.startsWith('TrackerRemovePlayer')) {
        const ids = JSON.parse(interaction.customId.replace('TrackerRemovePlayer', ''));
        const tracker = instance.trackers[ids.trackerId];
        const id = interaction.fields.getTextInputValue('TrackerRemovePlayerId').trim();

        if (!tracker || id === '') {
            interaction.deferUpdate();
            return;
        }

        /* A Steam link may need a lookup: answer later */
        await interaction.deferReply({ ephemeral: true });

        /* Same inputs as when adding: Steam ID, Steam/BattleMetrics link, BattleMetrics id or name */
        const TrackerResolve = require('../util/trackerResolve.js');
        const input = TrackerResolve.parseInput(id);
        let steamId = input.kind === 'steam' ? input.value : null;
        if (input.kind === 'vanity') steamId = await TrackerResolve.steamIdFromVanity(input.value);
        const matches = (e) => {
            if (steamId !== null) return e.steamId === steamId;
            if (input.kind === 'battlemetrics') return `${e.playerId}` === input.value;
            return `${e.name || ''}`.toLowerCase() === input.value.toLowerCase();
        };
        const removed = tracker.players.filter(matches);
        tracker.players = tracker.players.filter(e => !matches(e));
        client.setInstance(interaction.guildId, instance);

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'modalValueChange', {
            id: `${verifyId}`,
            value: `${id} -> removed ${removed.length}`
        }));

        if (removed.length > 0) await DiscordMessages.sendTrackerMessage(interaction.guildId, ids.trackerId);
        await interaction.editReply({
            embeds: [DiscordEmbeds.getEmbed({
                color: removed.length > 0 ? Constants.COLOR_ACTIVE : Constants.COLOR_INACTIVE,
                description: removed.length > 0 ?
                    client.intlGet(guildId, 'trackerPlayerRemoved', { name: removed.map(e => e.name).join(', ') }) :
                    client.intlGet(guildId, 'trackerPlayerNotInTracker', { id: id })
            })]
        });
        return;
    }

    client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userModalInteractionSuccess', {
        id: `${verifyId}`
    }));

    interaction.deferUpdate();
}