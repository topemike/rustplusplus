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

const Constants = require('../util/constants.js');
const CustomId = require('../util/customId.js');
const Client = require('../../index.ts');
const Config = require('../../config');

const SUCCESS = Discord.ButtonStyle.Success;
const DANGER = Discord.ButtonStyle.Danger;
const PRIMARY = Discord.ButtonStyle.Primary;
const SECONDARY = Discord.ButtonStyle.Secondary;
const LINK = Discord.ButtonStyle.Link;

module.exports = {
    getButton: function (options = {}) {
        const button = new Discord.ButtonBuilder();

        if (options.hasOwnProperty('customId')) button.setCustomId(options.customId);
        if (options.hasOwnProperty('label')) button.setLabel(options.label);
        if (options.hasOwnProperty('style')) button.setStyle(options.style);
        if (options.hasOwnProperty('url') && options.url !== '') button.setURL(options.url);
        if (options.hasOwnProperty('emoji')) button.setEmoji(options.emoji);
        if (options.hasOwnProperty('disabled')) button.setDisabled(options.disabled);

        return button;
    },

    getServerButtons: function (guildId, serverId, state = null) {
        const instance = Client.client.getInstance(guildId);
        const server = instance.serverList[serverId];
        const ids = { "serverId": serverId };

        if (state === null) {
            if (instance.activeServer === serverId && Client.client.activeRustplusInstances[guildId]) {
                state = 1;
            }
            else {
                state = 0;
            }
        }

        let connectionButton = null;
        if (state === 0) {
            connectionButton = module.exports.getButton({
                customId: CustomId.make('ServerConnect', ids),
                label: Client.client.intlGet(guildId, 'connectCap'),
                style: PRIMARY
            });
        }
        else if (state === 1) {
            connectionButton = module.exports.getButton({
                customId: CustomId.make('ServerDisconnect', ids),
                label: Client.client.intlGet(guildId, 'disconnectCap'),
                style: DANGER
            });
        }
        else if (state === 2) {
            connectionButton = module.exports.getButton({
                customId: CustomId.make('ServerReconnecting', ids),
                label: Client.client.intlGet(guildId, 'reconnectingCap'),
                style: DANGER
            });
        }

        const deleteUnreachableDevicesButton = module.exports.getButton({
            customId: CustomId.make('DeleteUnreachableDevices', ids),
            label: Client.client.intlGet(guildId, 'deleteUnreachableDevicesCap'),
            style: PRIMARY
        });
        const customTimersButton = module.exports.getButton({
            customId: CustomId.make('CustomTimersEdit', ids),
            label: Client.client.intlGet(guildId, 'customTimersCap'),
            style: PRIMARY
        });
        const trackerButton = module.exports.getButton({
            customId: CustomId.make('CreateTracker', ids),
            label: Client.client.intlGet(guildId, 'createTrackerCap'),
            style: PRIMARY
        });
        const groupButton = module.exports.getButton({
            customId: CustomId.make('CreateGroup', ids),
            label: Client.client.intlGet(guildId, 'createGroupCap'),
            style: PRIMARY
        });
        let linkButton = module.exports.getButton({
            label: Client.client.intlGet(guildId, 'websiteCap'),
            style: LINK,
            url: server.url
        });
        let battlemetricsButton = module.exports.getButton({
            label: Client.client.intlGet(guildId, 'battlemetricsCap'),
            style: LINK,
            url: `${Constants.BATTLEMETRICS_SERVER_URL}${server.battlemetricsId}`
        });
        let editButton = module.exports.getButton({
            customId: CustomId.make('ServerEdit', ids),
            label: Client.client.intlGet(guildId, 'editCap'),
            style: PRIMARY
        });
        let deleteButton = module.exports.getButton({
            customId: CustomId.make('ServerDelete', ids),
            style: SECONDARY,
            emoji: '🗑️'
        });

        if (Config.battlemetrics.token !== '' && server.battlemetricsId !== null) {
            return [
                new Discord.ActionRowBuilder().addComponents(
                    connectionButton, linkButton, battlemetricsButton, editButton, deleteButton
                ),
                new Discord.ActionRowBuilder().addComponents(
                    customTimersButton, trackerButton, groupButton
                ),
                new Discord.ActionRowBuilder().addComponents(
                    deleteUnreachableDevicesButton
                )
            ];
        }
        else {
            return [
                new Discord.ActionRowBuilder().addComponents(
                    connectionButton, linkButton, editButton, deleteButton
                ),
                new Discord.ActionRowBuilder().addComponents(
                    customTimersButton, groupButton
                ),
                new Discord.ActionRowBuilder().addComponents(
                    deleteUnreachableDevicesButton
                )
            ];
        }
    },

    getSmartSwitchButtons: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].switches[entityId];
        const ids = { "serverId": serverId, "entityId": entityId };

        const row = new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: CustomId.make(`SmartSwitch${entity.active ? 'Off' : 'On'}`, ids),
                label: entity.active ?
                    Client.client.intlGet(guildId, 'turnOffCap') :
                    Client.client.intlGet(guildId, 'turnOnCap'),
                style: entity.active ? DANGER : SUCCESS
            }),
            module.exports.getButton({
                customId: CustomId.make('SmartSwitchEdit', ids),
                label: Client.client.intlGet(guildId, 'editCap'),
                style: PRIMARY
            }),
            module.exports.getButton({
                customId: CustomId.make('SmartSwitchDelete', ids),
                style: SECONDARY,
                emoji: '🗑️'
            }));
        /* Automatic mode paused by a change by hand: one click to give control back to it */
        const SO = require('../util/switchOverride.js');
        if (SO.isPaused(entity) || SO.isRaidLocked(entity)) {
            row.addComponents(module.exports.getButton({
                customId: CustomId.make('SmartSwitchResumeAuto', ids),
                label: Client.client.intlGet(guildId, 'switchAutoResumeCap'),
                style: PRIMARY
            }));
        }
        return row;
    },

    getSmartSwitchGroupButtons: function (guildId, serverId, groupId) {
        const ids = { "serverId": serverId, "groupId": groupId };

        return [
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: CustomId.make('GroupTurnOn', ids),
                    label: Client.client.intlGet(guildId, 'turnOnCap'),
                    style: PRIMARY
                }),
                module.exports.getButton({
                    customId: CustomId.make('GroupTurnOff', ids),
                    label: Client.client.intlGet(guildId, 'turnOffCap'),
                    style: PRIMARY
                }),
                module.exports.getButton({
                    customId: CustomId.make('GroupEdit', ids),
                    label: Client.client.intlGet(guildId, 'editCap'),
                    style: PRIMARY
                }),
                module.exports.getButton({
                    customId: CustomId.make('GroupDelete', ids),
                    style: SECONDARY,
                    emoji: '🗑️'
                })),
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: CustomId.make('GroupAddSwitch', ids),
                    label: Client.client.intlGet(guildId, 'addSwitchCap'),
                    style: SUCCESS
                }),
                module.exports.getButton({
                    customId: CustomId.make('GroupRemoveSwitch', ids),
                    label: Client.client.intlGet(guildId, 'removeSwitchCap'),
                    style: DANGER
                }))
        ];
    },

    getSmartAlarmButtons: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].alarms[entityId];
        const ids = { "serverId": serverId, "entityId": entityId };

        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: CustomId.make('SmartAlarmEveryone', ids),
                label: '@everyone',
                style: entity.everyone ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('SmartAlarmRaidMode', ids),
                label: Client.client.intlGet(guildId, 'raidModeCap'),
                style: entity.raidMode !== false ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('SmartAlarmEdit', ids),
                label: Client.client.intlGet(guildId, 'editCap'),
                style: PRIMARY
            }),
            module.exports.getButton({
                customId: CustomId.make('SmartAlarmDelete', ids),
                style: SECONDARY,
                emoji: '🗑️'
            }));
    },

    getStorageMonitorToolCupboardButtons: function (guildId, serverId, entityId) {
        const instance = Client.client.getInstance(guildId);
        const entity = instance.serverList[serverId].storageMonitors[entityId];
        const ids = { "serverId": serverId, "entityId": entityId };

        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorToolCupboardEveryone', ids),
                label: '@everyone',
                style: entity.everyone ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorToolCupboardInGame', ids),
                label: Client.client.intlGet(guildId, 'inGameCap'),
                style: entity.inGame ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorEdit', ids),
                label: Client.client.intlGet(guildId, 'editCap'),
                style: PRIMARY,
            }),
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorToolCupboardDelete', ids),
                style: SECONDARY,
                emoji: '🗑️'
            }));
    },

    getStorageMonitorContainerButton: function (guildId, serverId, entityId) {
        const ids = { "serverId": serverId, "entityId": entityId };

        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorEdit', ids),
                label: Client.client.intlGet(guildId, 'editCap'),
                style: PRIMARY,
            }),
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorRecycle', ids),
                label: Client.client.intlGet(guildId, 'recycleCap'),
                style: PRIMARY,
            }),
            module.exports.getButton({
                customId: CustomId.make('StorageMonitorContainerDelete', ids),
                style: SECONDARY,
                emoji: '🗑️'
            }));
    },

    getRecycleDeleteButton: function () {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'RecycleDelete',
                style: SECONDARY,
                emoji: '🗑️'
            }));
    },

    getNotificationButtons: function (guildId, setting, discordActive, inGameActive, voiceActive) {
        const ids = { "setting": setting };

        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: CustomId.make('DiscordNotification', ids),
                label: Client.client.intlGet(guildId, 'discordCap'),
                style: discordActive ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('InGameNotification', ids),
                label: Client.client.intlGet(guildId, 'inGameCap'),
                style: inGameActive ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: CustomId.make('VoiceNotification', ids),
                label: Client.client.intlGet(guildId, 'voiceCap'),
                style: voiceActive ? SUCCESS : DANGER
            }));
    },

    getInGameCommandsEnabledButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'AllowInGameCommands',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getInGameTeammateNotificationsButtons: function (guildId) {
        const instance = Client.client.getInstance(guildId);

        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'InGameTeammateConnection',
                label: Client.client.intlGet(guildId, 'connectionsCap'),
                style: instance.generalSettings.connectionNotify ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: 'InGameTeammateAfk',
                label: Client.client.intlGet(guildId, 'afkCap'),
                style: instance.generalSettings.afkNotify ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: 'InGameTeammateDeath',
                label: Client.client.intlGet(guildId, 'deathCap'),
                style: instance.generalSettings.deathNotify ? SUCCESS : DANGER
            }));
    },

    getFcmAlarmNotificationButtons: function (guildId, enabled, everyone) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'FcmAlarmNotification',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }),
            module.exports.getButton({
                customId: 'FcmAlarmNotificationEveryone',
                label: '@everyone',
                style: everyone ? SUCCESS : DANGER
            }));
    },

    getSmartAlarmNotifyInGameButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'SmartAlarmNotifyInGame',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getSmartSwitchNotifyInGameWhenChangedFromDiscordButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'SmartSwitchNotifyInGameWhenChangedFromDiscord',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getLeaderCommandEnabledButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'LeaderCommandEnabled',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getLeaderCommandOnlyForPairedButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'LeaderCommandOnlyForPaired',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getTrackerButtons: function (guildId, trackerId) {
        const instance = Client.client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        const ids = { "trackerId": trackerId };

        return [
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: CustomId.make('TrackerAddPlayer', ids),
                    label: Client.client.intlGet(guildId, 'addPlayerCap'),
                    style: SUCCESS
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerRemovePlayer', ids),
                    label: Client.client.intlGet(guildId, 'removePlayerCap'),
                    style: DANGER
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerEdit', ids),
                    label: Client.client.intlGet(guildId, 'editCap'),
                    style: PRIMARY
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerDelete', ids),
                    style: SECONDARY,
                    emoji: '🗑️'
                })),
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: CustomId.make('TrackerInGame', ids),
                    label: Client.client.intlGet(guildId, 'inGameCap'),
                    style: tracker.inGame ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerEveryone', ids),
                    label: '@everyone',
                    style: tracker.everyone ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerUpdate', ids),
                    label: Client.client.intlGet(guildId, 'updateCap'),
                    style: PRIMARY
                })),
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: CustomId.make('TrackerClanAlerts', ids),
                    label: Client.client.intlGet(guildId, 'trackerClanAlertsCap'),
                    style: tracker.clanAlerts !== false ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: CustomId.make('TrackerSchedule', ids),
                    label: Client.client.intlGet(guildId, 'trackerScheduleCap'),
                    style: PRIMARY,
                    emoji: '\u{1F4C5}'
                }))
        ];
    },

    getNewsButton: function (guildId, body, validURL) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                style: LINK,
                label: Client.client.intlGet(guildId, 'linkCap'),
                url: validURL ? body.url : Constants.DEFAULT_SERVER_URL
            }));
    },

    getBotMutedInGameButton: function (guildId, isMuted) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'BotMutedInGame',
                label: isMuted ?
                    Client.client.intlGet(guildId, 'mutedCap') :
                    Client.client.intlGet(guildId, 'unmutedCap'),
                style: isMuted ? DANGER : SUCCESS
            }));
    },

    getMapWipeNotifyEveryoneButton: function (everyone) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'MapWipeNotifyEveryone',
                label: '@everyone',
                style: everyone ? SUCCESS : DANGER
            }));
    },

    getItemAvailableNotifyInGameButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'ItemAvailableNotifyInGame',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getHelpButtons: function () {
        return [
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    style: Discord.ButtonStyle.Link,
                    label: 'DEVELOPER',
                    url: 'https://github.com/alexemanuelol'
                }),
                module.exports.getButton({
                    style: Discord.ButtonStyle.Link,
                    label: 'REPOSITORY',
                    url: 'https://github.com/alexemanuelol/rustplusplus'
                })
            ),
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    style: Discord.ButtonStyle.Link,
                    label: 'DOCUMENTATION',
                    url: 'https://github.com/alexemanuelol/rustplusplus/blob/master/docs/documentation.md'
                }),
                module.exports.getButton({
                    style: Discord.ButtonStyle.Link,
                    label: 'CREDENTIALS',
                    url: 'https://github.com/alexemanuelol/rustplusplus-Credential-Application/releases/v1.4.0'
                })
            )];
    },

    getDisplayInformationBattlemetricsAllOnlinePlayersButton: function (guildId, enabled) {
        return new Discord.ActionRowBuilder().addComponents(
            module.exports.getButton({
                customId: 'DisplayInformationBattlemetricsAllOnlinePlayers',
                label: enabled ?
                    Client.client.intlGet(guildId, 'enabledCap') :
                    Client.client.intlGet(guildId, 'disabledCap'),
                style: enabled ? SUCCESS : DANGER
            }));
    },

    getSubscribeToChangesBattlemetricsButtons: function (guildId) {
        const instance = Client.client.getInstance(guildId);

        return [
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: 'BattlemetricsServerNameChanges',
                    label: Client.client.intlGet(guildId, 'battlemetricsServerNameChangesCap'),
                    style: instance.generalSettings.battlemetricsServerNameChanges ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: 'BattlemetricsTrackerNameChanges',
                    label: Client.client.intlGet(guildId, 'battlemetricsTrackerNameChangesCap'),
                    style: instance.generalSettings.battlemetricsTrackerNameChanges ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: 'BattlemetricsGlobalNameChanges',
                    label: Client.client.intlGet(guildId, 'battlemetricsGlobalNameChangesCap'),
                    style: instance.generalSettings.battlemetricsGlobalNameChanges ? SUCCESS : DANGER
                })),
            new Discord.ActionRowBuilder().addComponents(
                module.exports.getButton({
                    customId: 'BattlemetricsGlobalLogin',
                    label: Client.client.intlGet(guildId, 'battlemetricsGlobalLoginCap'),
                    style: instance.generalSettings.battlemetricsGlobalLogin ? SUCCESS : DANGER
                }),
                module.exports.getButton({
                    customId: 'BattlemetricsGlobalLogout',
                    label: Client.client.intlGet(guildId, 'battlemetricsGlobalLogoutCap'),
                    style: instance.generalSettings.battlemetricsGlobalLogout ? SUCCESS : DANGER
                }))];
    },
}