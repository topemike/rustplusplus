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

const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

const Constants = require('../util/constants.js');
const RustRelay = require('./rustRelay.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const FcmPairing = require('./fcmPairing.js');
const InstanceUtils = require('../util/instanceUtils.js');
const Scrape = require('../util/scrape.js');

module.exports = async (client, guild, steamId) => {
    const credentials = InstanceUtils.readCredentialsFile(guild.id);
    const hoster = credentials.hoster;

    if (!Object.keys(credentials).includes(steamId)) {
        client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'credentialsNotRegistered', {
            steamId: steamId
        }));
        return;
    }

    if (steamId === hoster) {
        client.log(client.intlGet(null, 'warningCap'),
            client.intlGet(null, 'credentialsCannotStartLiteAlreadyHoster', {
                steamId: steamId
            }));
        return;
    }

    if (client.fcmListenersLite[guild.id][steamId]) {
        client.fcmListenersLite[guild.id][steamId].destroy();
        delete client.fcmListenersLite[guild.id][steamId];
    }

    client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'fcmListenerStartLite', {
        guildId: guild.id,
        steamId: steamId
    }));

    const discordUserId = credentials[steamId].discord_user_id;

    const androidId = credentials[steamId].gcm.android_id;
    const securityToken = credentials[steamId].gcm.security_token;
    client.fcmListenersLite[guild.id][steamId] = new PushReceiverClient(androidId, securityToken, [])
    client.fcmListenersLite[guild.id][steamId].on('ON_DATA_RECEIVED', (data) => {
        const appData = data.appData;

        if (!appData) {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, appData could not be found.`)
            return;
        }

        const title = appData.find(item => item.key === 'title')?.value;
        const message = appData.find(item => item.key === 'message')?.value;
        const channelId = appData.find(item => item.key === 'channelId')?.value;

        if (!channelId) {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, channelId could not be found.`)
            return;
        }

        const bodyCheck = appData.find(item => item.key === 'body');

        if (!bodyCheck) {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, body could not be found.`)
            return;
        }

        let body;
        try {
            body = JSON.parse(bodyCheck.value);
        }
        catch (e) {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, body is not valid JSON.`);
            return;
        }
        if (!body || typeof body !== 'object') return;
        if (!body.ip || !body.port) {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, ` +
                `notification without ip/port (channel ${channelId}), keys: ${Object.keys(body).join(',')}`);
        }

        if (!body.type && channelId !== 'alarm') {
            client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, body type could not be found.`)
            return;
        }

        switch (channelId) {
            case 'pairing': {
                switch (body.type) {
                    case 'server': {
                        client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, pairing: server`);
                        pairingServer(client, guild, steamId, title, message, body);
                    } break;

                    case 'entity': {
                        switch (body.entityName) {
                            case 'Smart Switch': {
                                client.log('FCM LITE',
                                    `GuildID: ${guild.id}, SteamID: ${steamId}, pairing: entity: Switch`);
                                pairingEntitySwitch(client, guild, title, message, body);
                            } break;

                            case 'Smart Alarm': {
                                client.log('FCM LITE',
                                    `GuildID: ${guild.id}, SteamID: ${steamId}, pairing: entity: Smart Alarm`);
                                pairingEntitySmartAlarm(client, guild, title, message, body);
                            } break;

                            case 'Storage Monitor': {
                                client.log('FCM LITE',
                                    `GuildID: ${guild.id}, SteamID: ${steamId}, pairing: entity: Storage Monitor`);
                                pairingEntityStorageMonitor(client, guild, title, message, body);
                            } break;

                            default: {
                                client.log('FCM LITE',
                                    `GuildID: ${guild.id}, SteamID: ${steamId}, ` +
                                    `pairing: entity: other\n${FcmPairing.redactNotification(data)}`);
                            } break;
                        }
                    } break;

                    default: {
                    } break;
                }
            } break;

            case 'player': {
                switch (body.type) {
                    case 'death': {
                        client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, player: death`);
                        playerDeath(client, guild, title, message, body, discordUserId);
                    } break;

                    default: {
                    } break;
                }
            } break;

            default: {
            } break;
        }
    });

    client.fcmListenersLite[guild.id][steamId].connect();
};

function isValidUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.startsWith('https') || url.startsWith('http')) return true;
    return false;
}

async function pairingServer(client, guild, steamId, title, message, body) {
    const instance = client.getInstance(guild.id);
    const address = RustRelay.pairingAddress(instance, body);
    if (!address) {
        client.log('FCM LITE', `GuildID: ${guild.id}, SteamID: ${steamId}, server pairing without ip/port ` +
            `or relay id, ignored.`);
        return;
    }
    const serverId = address.serverId;

    if (!instance.serverListLite.hasOwnProperty(serverId)) instance.serverListLite[serverId] = new Object();

    instance.serverListLite[serverId][steamId] = {
        serverIp: address.serverIp,
        appPort: address.appPort,
        steamId: body.playerId,
        playerToken: body.playerToken,
        relayServerId: body.id || null,
    };
    client.setInstance(guild.id, instance);

    const rustplus = client.rustplusInstances[guild.id];
    if (rustplus && (rustplus.serverId === serverId) && rustplus.team?.leaderSteamId === steamId) {
        rustplus.updateLeaderRustPlusLiteInstance();
    }
}

async function pairingEntitySwitch(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'switch', 'FCM LITE');
}

async function pairingEntitySmartAlarm(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'alarm', 'FCM LITE');
}

async function pairingEntityStorageMonitor(client, guild, title, message, body) {
    await FcmPairing.pairEntity(client, guild, body, 'storageMonitor', 'FCM LITE');
}

async function playerDeath(client, guild, title, message, body, discordUserId) {
    const user = await DiscordTools.getUserById(guild.id, discordUserId);
    if (!user) return;

    let png = null;
    if (body.targetId !== '') png = await Scrape.scrapeSteamProfilePicture(client, body.targetId);
    if (png === null) png = isValidUrl(body.img) ? body.img : Constants.DEFAULT_SERVER_IMG;

    const content = {
        embeds: [DiscordEmbeds.getPlayerDeathEmbed({ title: title }, body, png)]
    }

    await client.messageSend(user, content);
}
