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
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

const Battlemetrics = require('../structures/Battlemetrics');
const Constants = require('../util/constants.js');
const RustRelay = require('./rustRelay.js');
const DiscordButtons = require('../discordTools/discordButtons.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const FcmPairing = require('./fcmPairing.js');
const InstanceUtils = require('../util/instanceUtils.js');
const Scrape = require('../util/scrape.js');
const Config = require('../../config');

module.exports = async (client, guild) => {
    const credentials = InstanceUtils.readCredentialsFile(guild.id);
    const hoster = credentials.hoster;

    if (Object.keys(credentials).length === 1) {
        client.log(client.intlGet(null, 'warningCap'),
            client.intlGet(null, 'credentialsNotRegisteredForGuild', { id: guild.id }));
        return;
    }

    if (!hoster) {
        client.log(client.intlGet(null, 'warningCap'),
            client.intlGet(guild.id, 'credentialsHosterNotSetForGuild', { id: guild.id }));
        return;
    }

    /* Destroy previous instance of fcm listener */
    if (client.fcmListeners[guild.id]) client.fcmListeners[guild.id].destroy();
    if (client.fcmListenersLite[guild.id][hoster]) {
        client.fcmListenersLite[guild.id][hoster].destroy();
        delete client.fcmListenersLite[guild.id][hoster];
    }

    client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'fcmListenerStartHost', {
        guildId: guild.id,
        steamId: hoster
    }));

    const discordUserId = credentials[hoster].discord_user_id;

    const androidId = credentials[hoster].gcm.android_id;
    const securityToken = credentials[hoster].gcm.security_token;
    client.fcmListeners[guild.id] = new PushReceiverClient(androidId, securityToken, [])
    client.fcmListeners[guild.id].on('ON_DATA_RECEIVED', (data) => {
        const appData = data.appData;

        if (!appData) {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, appData could not be found.`)
            return;
        }

        const title = appData.find(item => item.key === 'title')?.value;
        const message = appData.find(item => item.key === 'message')?.value;
        const channelId = appData.find(item => item.key === 'channelId')?.value;

        if (!channelId) {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, channelId could not be found.`)
            return;
        }

        const bodyCheck = appData.find(item => item.key === 'body');

        if (!bodyCheck) {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, body could not be found.`)
            return;
        }

        let body;
        try {
            body = JSON.parse(bodyCheck.value);
        }
        catch (e) {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, body is not valid JSON.`);
            return;
        }
        if (!body || typeof body !== 'object') return;
        if (!body.ip || !body.port) {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, ` +
                `notification without ip/port (channel ${channelId}), keys: ${Object.keys(body).join(',')}`);
        }

        if (!body.type && channelId !== 'alarm') {
            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, body type could not be found.`)
            return;
        }

        switch (channelId) {
            case 'pairing': {
                switch (body.type) {
                    case 'server': {
                        client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, pairing: server`);
                        pairingServer(client, guild, title, message, body);
                    } break;

                    case 'entity': {
                        switch (body.entityName) {
                            case 'Smart Switch': {
                                client.log('FCM Host',
                                    `GuildID: ${guild.id}, SteamID: ${hoster}, pairing: entity: Switch`);
                                pairingEntitySwitch(client, guild, title, message, body);
                            } break;

                            case 'Smart Alarm': {
                                client.log('FCM Host',
                                    `GuildID: ${guild.id}, SteamID: ${hoster}, pairing: entity: Smart Alarm`);
                                pairingEntitySmartAlarm(client, guild, title, message, body);
                            } break;

                            case 'Storage Monitor': {
                                client.log('FCM Host',
                                    `GuildID: ${guild.id}, SteamID: ${hoster}, pairing: entity: Storage Monitor`);
                                pairingEntityStorageMonitor(client, guild, title, message, body);
                            } break;

                            default: {
                                client.log('FCM Host',
                                    `GuildID: ${guild.id}, SteamID: ${hoster}, ` +
                                    `pairing: entity: other\n${FcmPairing.redactNotification(data)}`);
                            } break;
                        }
                    } break;

                    default: {
                        client.log('FCM Host',
                            `GuildID: ${guild.id}, SteamID: ${hoster}, pairing: other\n${FcmPairing.redactNotification(data)}`);
                    } break;
                }
            } break;

            case 'alarm': {
                switch (body.type) {
                    case 'alarm': {
                        client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, alarm: alarm`);
                        alarmAlarm(client, guild, title, message, body);
                    } break;

                    default: {
                        if (title === 'You\'re getting raided!') {
                            /* Custom alarm from plugin: https://umod.org/plugins/raid-alarm */
                            client.log('FCM Host',
                                `GuildID: ${guild.id}, SteamID: ${hoster}, alarm: raid-alarm plugin`);
                            alarmRaidAlarm(client, guild, title, message, body);
                            break;
                        }
                        client.log('FCM Host',
                            `GuildID: ${guild.id}, SteamID: ${hoster}, alarm: other\n${FcmPairing.redactNotification(data)}`);
                    } break;
                }
            } break;

            case 'player': {
                switch (body.type) {
                    case 'death': {
                        client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, player: death`);
                        playerDeath(client, guild, title, message, body, discordUserId);
                    } break;

                    default: {
                        client.log('FCM Host',
                            `GuildID: ${guild.id}, SteamID: ${hoster}, player: other\n${FcmPairing.redactNotification(data)}`);
                    } break;
                }
            } break;

            case 'team': {
                switch (body.type) {
                    case 'login': {
                        client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, team: login`);
                        teamLogin(client, guild, title, message, body);
                    } break;

                    default: {
                        client.log('FCM Host',
                            `GuildID: ${guild.id}, SteamID: ${hoster}, team: other\n${FcmPairing.redactNotification(data)}`);
                    } break;
                }
            } break;

            //case 'news': {
            //    switch (body.type) {
            //        case 'news': {
            //            client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, news: news`);
            //            newsNews(client, guild, full, data, body);
            //        } break;

            //        default: {
            //            client.log('FCM Host',
            //                `GuildID: ${guild.id}, SteamID: ${hoster}, news: other\n${JSON.stringify(full)}`);
            //        } break;
            //    }
            //} break;

            default: {
                client.log('FCM Host', `GuildID: ${guild.id}, SteamID: ${hoster}, other\n${FcmPairing.redactNotification(data)}`);
            } break;
        }
    });

    client.fcmListeners[guild.id].connect();
};

function isValidUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.startsWith('https') || url.startsWith('http')) return true;
    return false;
}

async function pairingServer(client, guild, title, message, body) {
    const instance = client.getInstance(guild.id);
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) {
        client.log('FCM Host', `GuildID: ${guild.id}, server pairing without ip/port or relay id, ignored.`);
        return;
    }
    const serverId = address.serverId;
    const server = instance.serverList[serverId];

    let messageObj = undefined;
    if (server) messageObj = await DiscordTools.getMessageById(guild.id, instance.channelId.servers, server.messageId);

    let battlemetricsId = server?.battlemetricsId ?? null;
    let connect = server?.connect ?? null;
    if (Config.battlemetrics.token !== '') {
        const bmInstance = new Battlemetrics(null, title);
        await bmInstance.setup();
        if (bmInstance.lastUpdateSuccessful) {
            battlemetricsId = bmInstance.id;
            connect = `connect ${bmInstance.server_ip}:${bmInstance.server_port}`;
            if (!client.battlemetricsInstances.hasOwnProperty(bmInstance.id)) {
                client.battlemetricsInstances[bmInstance.id] = bmInstance;
            }
        }
    }

    instance.serverList[serverId] = {
        title: title || body.name || (server ? server.title : serverId),
        serverIp: address.serverIp,
        appPort: address.appPort,
        steamId: body.playerId,
        playerToken: body.playerToken,
        relayServerId: body.id ? body.id : (server ? (server.relayServerId || null) : null),
        description: `${body.desc || ''}`.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
        img: isValidUrl(body.img) ? body.img.replace(/ /g, '%20') : Constants.DEFAULT_SERVER_IMG,
        url: isValidUrl(body.url) ? body.url.replace(/ /g, '%20') : Constants.DEFAULT_SERVER_URL,
        notes: server ? server.notes : {},
        switches: server ? server.switches : {},
        alarms: server ? server.alarms : {},
        storageMonitors: server ? server.storageMonitors : {},
        markers: server ? server.markers : {},
        switchGroups: server ? server.switchGroups : {},
        messageId: (messageObj !== undefined) ? messageObj.id : null,
        battlemetricsId: battlemetricsId,
        connect: connect,
        cargoShipEgressTimeMs: server ? server.cargoShipEgressTimeMs : Constants.DEFAULT_CARGO_SHIP_EGRESS_TIME_MS,
        oilRigLockedCrateUnlockTimeMs: server ? server.oilRigLockedCrateUnlockTimeMs :
            Constants.DEFAULT_OIL_RIG_LOCKED_CRATE_UNLOCK_TIME_MS,
        timeTillDay: server ? server.timeTillDay : null,
        timeTillNight: server ? server.timeTillNight : null
    };

    if (!instance.serverListLite.hasOwnProperty(serverId)) instance.serverListLite[serverId] = new Object();

    instance.serverListLite[serverId][body.playerId] = {
        serverIp: address.serverIp,
        appPort: address.appPort,
        steamId: body.playerId,
        playerToken: body.playerToken,
        relayServerId: body.id || null,
    };
    client.setInstance(guild.id, instance);

    try {
        await DiscordMessages.sendServerMessage(guild.id, serverId, null);
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Pairing server ${serverId}: ${e}`, 'error');
    }
}

async function pairingEntitySwitch(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'switch', 'FCM Host');
}

async function pairingEntitySmartAlarm(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'alarm', 'FCM Host');
}

async function pairingEntityStorageMonitor(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'storageMonitor', 'FCM Host');
}

async function alarmAlarm(client, guild, title, message, body) {
    /* Unfortunately the alarm notification from the fcm listener is unreliable. The notification does not include
    which entityId that got triggered which makes it impossible to know which Smart Alarms are still being used
    actively. Also, from testing it seems that notifications don't always reach this fcm listener which makes it even
    more unreliable. The only advantage to using the fcm listener alarm notification is that it includes the title and
    description messagethat is configured on the Smart Alarm in the game. Due to missing out on this data, Smart Alarm
    title and description message needs to be re-configured via the /alarm slash command. Alarms that are used on the
    connected rust server will be handled through the message event from rustplus. Smart Alarms that are still attached
    to the credential owner and which is not part of the currently connected rust server can notify IF the general
    setting fcmAlarmNotificationEnabled is enabled. Those notifications will be handled here. */

    const instance = client.getInstance(guild.id);
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) return;
    const serverId = address.serverId;
    const entityId = body.entityId;
    const server = instance.serverList[serverId];
    const rustplus = client.rustplusInstances[guild.id];

    if (!server || (server && !server.alarms[entityId])) return;

    const alarm = server.alarms[entityId];
    const connectedHere = !!rustplus && rustplus.serverId === serverId;
    /* Handled by the rustplus broadcast (message.js) when the connection works */
    if (connectedHere && rustplus.isOperational) return;

    const isActiveServer = instance.activeServer === serverId;
    if (isActiveServer) {
        /* The bot should be connected to this server but the connection is down / not ready yet:
           the alarm is not lost */
        alarm.lastTrigger = Math.floor(new Date() / 1000);
        client.setInstance(guild.id, instance);
        try {
            if (alarm.raidMode !== false) {
                await require('../handlers/raidHandler.js').onAlarmTriggered(client, null, guild.id, serverId, entityId);
            }
            else {
                await DiscordMessages.sendSmartAlarmTriggerMessage(guild.id, serverId, entityId);
            }
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Smart Alarm (FCM): ${e}`, 'error');
            await DiscordMessages.sendSmartAlarmTriggerMessage(guild.id, serverId, entityId).catch(() => { });
        }
        client.log(client.intlGet(null, 'infoCap'), `${title}: ${message}`);
        return;
    }

    if (!connectedHere && instance.generalSettings.fcmAlarmNotificationEnabled) {
        alarm.lastTrigger = Math.floor(new Date() / 1000);
        client.setInstance(guild.id, instance);
        await DiscordMessages.sendSmartAlarmTriggerMessage(guild.id, serverId, entityId, server.alarms[entityId].everyone || instance.generalSettings.fcmAlarmNotificationEveryone);
        client.log(client.intlGet(null, 'infoCap'), `${title}: ${message}`);
    }
}

async function alarmRaidAlarm(client, guild, title, message, body) {
    const instance = client.getInstance(guild.id);
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) return;
    const serverId = address.serverId;
    const rustplus = client.rustplusInstances[guild.id];

    if (!instance.serverList.hasOwnProperty(serverId)) {
        client.log('FCM Host', `GuildID: ${guild.id}, raid alarm for server ${serverId} ("${body.name}") ` +
            `that is not paired with the bot, ignored.`);
        return;
    }

    const files = [];
    if (body.img === '') {
        files.push(new Discord.AttachmentBuilder(Path.join(__dirname, '..', `resources/images/rocket.png`)));
    }

    const content = {
        embeds: [DiscordEmbeds.getAlarmRaidAlarmEmbed({ title: title, message: message }, body)],
        content: '@everyone',
        files: files
    }

    /* Grouped with the Smart Alarm raid message (one pinned message, reminders, end of raid), also
       when the bot is not connected to that server (then without in-game message / switch actions) */
    const connected = rustplus && (serverId === rustplus.serverId) && rustplus.isOperational ? rustplus : null;
    try {
        await require('../handlers/raidHandler.js').onPluginAlarm(client, connected, guild.id, serverId, title, message);
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Raid plugin alarm: ${e}`, 'error');
        await DiscordMessages.sendMessage(guild.id, content, null, instance.channelId.base || instance.channelId.activity);
        if (connected) connected.sendInGameMessage(`${title}: ${message}`);
    }

    client.log(client.intlGet(null, 'infoCap'), `${title} ${message}`);
}

async function playerDeath(client, guild, title, message, body, discordUserId) {
    const user = await DiscordTools.getUserById(guild.id, discordUserId);

    let png = null;
    if (body.targetId !== '') png = await Scrape.scrapeSteamProfilePicture(client, body.targetId);
    if (png === null) png = isValidUrl(body.img) ? body.img : Constants.DEFAULT_SERVER_IMG;

    const content = {
        embeds: [DiscordEmbeds.getPlayerDeathEmbed({ title: title }, body, png)]
    }

    if (user) {
        await client.messageSend(user, content);
    }
}

async function teamLogin(client, guild, title, message, body) {
    const instance = client.getInstance(guild.id);

    const content = {
        embeds: [DiscordEmbeds.getTeamLoginEmbed(
            guild.id, body, await Scrape.scrapeSteamProfilePicture(client, body.targetId))]
    }

    const rustplus = client.rustplusInstances[guild.id];
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) return;
    const serverId = address.serverId;

    if (!rustplus || (rustplus && (serverId !== rustplus.serverId))) {
        await DiscordMessages.sendMessage(guild.id, content, null, instance.channelId.activity);
        client.log(client.intlGet(null, 'infoCap'),
            client.intlGet(null, 'playerJustConnectedTo', {
                name: body.targetName,
                server: body.name
            }));
    }
}

//async function newsNews(client, guild, full, data, body) {
//    const instance = client.getInstance(guild.id);
//
//    const content = {
//        embeds: [DiscordEmbeds.getNewsEmbed(guild.id, data)],
//        components: [DiscordButtons.getNewsButton(guild.id, body, isValidUrl(body.url))]
//    }
//
//    await DiscordMessages.sendMessage(guild.id, content, null, instance.channelId.activity);
//}
