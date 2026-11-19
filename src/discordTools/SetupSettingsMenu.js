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
const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordButtons = require('./discordButtons.js');
const DiscordEmbeds = require('./discordEmbeds.js');
const DiscordSelectMenus = require('./discordSelectMenus.js');
const DiscordTools = require('./discordTools.js');
const CustomId = require('../util/customId.js');

/* Raise when the texts of the settings menu change: existing guilds get the menu drawn again once */
const SETTINGS_MENU_VERSION = 2;

/* Since the Rust update of August 2026 ("Power Trip") Facepunch no longer sends these map markers to Rust+.
   The settings and their code stay: if Facepunch brings the markers back, they work again. */
const NOT_SENT_BY_FACEPUNCH = [
    'cargoShipDetectedSetting', 'cargoShipLeftSetting', 'cargoShipEgressSetting', 'cargoShipDockingAtHarborSetting',
    'cargoNearBaseSetting', 'patrolHelicopterDetectedSetting', 'patrolHelicopterLeftSetting',
    'patrolHelicopterDestroyedSetting', 'heliNearBaseSetting', 'bradleyApcDestroyedSetting',
    'bradleyApcRespawnSetting', 'travelingVendorDetectedSetting', 'travelingVendorHaltedSetting',
    'travelingVendorLeftSetting', 'vendingMachineDetectedSetting', 'itemAvailableNotifyInGameSetting'
];

/* The language's header image, or the English one when there is none for that language (e.g. pt) */
function getLogoPath(kind, language) {
    const path = Path.join(__dirname, '..', `resources/images/settings/${kind}_settings_logo_${language}.png`);
    if (Fs.existsSync(path)) return path;
    return Path.join(__dirname, '..', `resources/images/settings/${kind}_settings_logo_en.png`);
}

function getFacepunchNoteFields(client, guildId, key) {
    if (!NOT_SENT_BY_FACEPUNCH.includes(key)) return [];
    return [{
        name: client.intlGet(guildId, 'noteCap'),
        value: client.intlGet(guildId, 'facepunchNoLongerSendsNote'),
        inline: false
    }];
}

/* The customIds every settings message should carry (general ones and one per notification setting) */
function getExpectedIds(client, guildId) {
    const instance = client.getInstance(guildId);
    const ids = ['language', 'VoiceGender', 'Prefix', 'Trademark', 'AllowInGameCommands', 'BotMutedInGame',
        'InGameTeammateConnection', 'CommandDelay', 'FcmAlarmNotification', 'SmartAlarmNotifyInGame',
        'SmartSwitchNotifyInGameWhenChangedFromDiscord', 'LeaderCommandEnabled', 'LeaderCommandOnlyForPaired',
        'MapWipeNotifyEveryone', 'ItemAvailableNotifyInGame'];
    if (Config.battlemetrics.token !== '') {
        ids.push('DisplayInformationBattlemetricsAllOnlinePlayers', 'BattlemetricsServerNameChanges');
    }
    const template = client.readNotificationSettingsTemplate();
    for (const setting in instance.notificationSettings) {
        if (template.hasOwnProperty(setting)) ids.push(`DiscordNotification:${setting}`);
    }
    return ids;
}

/* Which expected settings messages are not in the channel (null if the channel could not be read) */
async function getMissingIds(client, guildId, channel) {
    let messages = null;
    try {
        messages = await channel.messages.fetch({ limit: 100 });
    }
    catch (e) {
        return null;
    }
    const present = new Set();
    for (const message of messages.values()) {
        for (const row of (message.components || [])) {
            for (const component of (row.components || [])) {
                const customId = component.customId || (component.data ? component.data.custom_id : null);
                if (!customId) continue;
                if (customId.startsWith('DiscordNotification')) {
                    present.add(`DiscordNotification:${CustomId.parse('DiscordNotification', customId).setting}`);
                }
                else {
                    present.add(customId);
                }
            }
        }
    }
    return getExpectedIds(client, guildId).filter(e => !present.has(e));
}

module.exports = async (client, guild, forced = false) => {
    const instance = client.getInstance(guild.id);
    const channel = DiscordTools.getTextChannelById(guild.id, instance.channelId.settings);

    if (!channel) {
        client.log(client.intlGet(null, 'errorCap'), 'SetupSettingsMenu: ' +
            client.intlGet(null, 'invalidGuildOrChannel'), 'error');
        return;
    }

    let redraw = instance.firstTime || forced;
    if (!redraw) {
        /* Existing guild: draw the menu again if it is from an older version or a setting is missing
           (settings added by an update never appeared otherwise) */
        const missing = await getMissingIds(client, guild.id, channel);
        if (instance.settingsMenuVersion !== SETTINGS_MENU_VERSION || (missing !== null && missing.length > 0)) {
            client.log(client.intlGet(null, 'infoCap'), `SetupSettingsMenu: redrawing the settings menu ` +
                `(version ${instance.settingsMenuVersion} -> ${SETTINGS_MENU_VERSION}, missing: ` +
                `${missing === null ? '?' : missing.join(', ') || '-'})`);
            redraw = true;
        }
    }

    if (redraw) {
        await DiscordTools.clearTextChannel(guild.id, instance.channelId.settings, 100);

        await setupGeneralSettings(client, guild.id, channel);
        await setupNotificationSettings(client, guild.id, channel);

        instance.firstTime = false;
        instance.settingsMenuVersion = SETTINGS_MENU_VERSION;
        client.setInstance(guild.id, instance);
    }

};

module.exports.getExpectedIds = getExpectedIds;
module.exports.getMissingIds = getMissingIds;
module.exports.getLogoPath = getLogoPath;
module.exports.NOT_SENT_BY_FACEPUNCH = NOT_SENT_BY_FACEPUNCH;
module.exports.SETTINGS_MENU_VERSION = SETTINGS_MENU_VERSION;

async function setupGeneralSettings(client, guildId, channel) {
    const instance = client.getInstance(guildId);

    await client.messageSend(channel, {
        files: [new Discord.AttachmentBuilder(getLogoPath('general', instance.generalSettings.language))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'selectLanguageSetting'),
            thumbnail: `attachment://settings_logo.png`,
            fields: [
                {
                    name: client.intlGet(guildId, 'noteCap'),
                    value: client.intlGet(guildId, 'selectLanguageExtendSetting'),
                    inline: true
                }]
        })],
        components: [DiscordSelectMenus.getLanguageSelectMenu(guildId, instance.generalSettings.language)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'commandsVoiceGenderDesc'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordSelectMenus.getVoiceGenderSelectMenu(guildId, instance.generalSettings.voiceGender)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'selectInGamePrefixSetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordSelectMenus.getPrefixSelectMenu(guildId, instance.generalSettings.prefix)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'selectTrademarkSetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordSelectMenus.getTrademarkSelectMenu(guildId, instance.generalSettings.trademark)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldCommandsEnabledSetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordButtons.getInGameCommandsEnabledButton(guildId,
            instance.generalSettings.inGameCommandsEnabled)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldBotBeMutedSetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordButtons.getBotMutedInGameButton(guildId, instance.generalSettings.muteInGameBotMessages)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'inGameTeamNotificationsSetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordButtons.getInGameTeammateNotificationsButtons(guildId)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'commandDelaySetting'),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordSelectMenus.getCommandDelaySelectMenu(guildId, instance.generalSettings.commandDelay)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldSmartAlarmNotifyNotConnectedSetting'),
            thumbnail: `attachment://settings_logo.png`,
            fields: [
                {
                    name: client.intlGet(guildId, 'noteCap'),
                    value: client.intlGet(guildId, 'smartAlarmNotifyExtendSetting'),
                    inline: true
                }]
        })],
        components: [
            DiscordButtons.getFcmAlarmNotificationButtons(
                guildId,
                instance.generalSettings.fcmAlarmNotificationEnabled,
                instance.generalSettings.fcmAlarmNotificationEveryone)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldSmartAlarmsNotifyInGameSetting'),
            thumbnail: `attachment://settings_logo.png`,
        })],
        components: [DiscordButtons.getSmartAlarmNotifyInGameButton(guildId,
            instance.generalSettings.smartAlarmNotifyInGame)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldSmartSwitchNotifyInGameWhenChangedFromDiscord'),
            thumbnail: `attachment://settings_logo.png`,
        })],
        components: [DiscordButtons.getSmartSwitchNotifyInGameWhenChangedFromDiscordButton(guildId,
            instance.generalSettings.smartSwitchNotifyInGameWhenChangedFromDiscord)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldLeaderCommandEnabledSetting'),
            thumbnail: `attachment://settings_logo.png`,
        })],
        components: [DiscordButtons.getLeaderCommandEnabledButton(guildId,
            instance.generalSettings.leaderCommandEnabled)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'shouldLeaderCommandOnlyForPairedSetting'),
            thumbnail: `attachment://settings_logo.png`,
        })],
        components: [DiscordButtons.getLeaderCommandOnlyForPairedButton(guildId,
            instance.generalSettings.leaderCommandOnlyForPaired)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'mapWipeDetectedNotifySetting', { group: '@everyone' }),
            thumbnail: `attachment://settings_logo.png`
        })],
        components: [DiscordButtons.getMapWipeNotifyEveryoneButton(instance.generalSettings.mapWipeNotifyEveryone)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    await client.messageSend(channel, {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_SETTINGS,
            title: client.intlGet(guildId, 'itemAvailableNotifyInGameSetting'),
            thumbnail: `attachment://settings_logo.png`,
            fields: getFacepunchNoteFields(client, guildId, 'itemAvailableNotifyInGameSetting')
        })],
        components: [DiscordButtons.getItemAvailableNotifyInGameButton(guildId,
            instance.generalSettings.itemAvailableInVendingMachineNotifyInGame)],
        files: [new Discord.AttachmentBuilder(
            Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
    });

    if (Config.battlemetrics.token !== '') {
        await client.messageSend(channel, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_SETTINGS,
                title: client.intlGet(guildId, 'displayInformationBattlemetricsAllOnlinePlayers'),
                thumbnail: `attachment://settings_logo.png`
            })],
            components: [DiscordButtons.getDisplayInformationBattlemetricsAllOnlinePlayersButton(guildId,
                instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers)],
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
        });

        await client.messageSend(channel, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_SETTINGS,
                title: client.intlGet(guildId, 'subscribeToChangesBattlemetrics'),
                thumbnail: `attachment://settings_logo.png`
            })],
            components: DiscordButtons.getSubscribeToChangesBattlemetricsButtons(guildId),
            files: [new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', 'resources/images/settings_logo.png'))]
        });
    }
}

async function setupNotificationSettings(client, guildId, channel) {
    const instance = client.getInstance(guildId);

    await client.messageSend(channel, {
        files: [new Discord.AttachmentBuilder(getLogoPath('notification', instance.generalSettings.language))]
    });

    /* Only the settings the bot knows (an unknown one is kept in the file but not shown) */
    const template = client.readNotificationSettingsTemplate();
    for (const setting in instance.notificationSettings) {
        if (!template.hasOwnProperty(setting)) continue;
        await client.messageSend(channel, {
            embeds: [DiscordEmbeds.getEmbed({
                color: Constants.COLOR_SETTINGS,
                /* {grids}: the heli distance comes from the code, not written by hand in the text */
                title: client.intlGet(guildId, setting, { grids: Constants.HELI_NEAR_BASE_GRIDS }),
                thumbnail: `attachment://${instance.notificationSettings[setting].image}`,
                fields: getFacepunchNoteFields(client, guildId, setting)
            })],
            components: [
                DiscordButtons.getNotificationButtons(
                    guildId, setting,
                    instance.notificationSettings[setting].discord,
                    instance.notificationSettings[setting].inGame,
                    instance.notificationSettings[setting].voice)],
            files: [
                new Discord.AttachmentBuilder(
                    Path.join(__dirname, '..',
                        `resources/images/events/${instance.notificationSettings[setting].image}`))]
        });
    }
}