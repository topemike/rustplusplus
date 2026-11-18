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

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const Scrape = require('../util/scrape.js');
const TrackerIntel = require('../util/trackerIntel.js');

const SEARCH_INTERVAL_MS = 10 * 60 * 1000;

module.exports = {
    /* BattleMetrics sometimes gets the server name cut at 63 characters (the game's server query
       limit), e.g. "... | No B" / "... | No BP Wipe |": that is not a real name change */
    isTruncatedName: function (a, b) {
        const x = `${a || ''}`, y = `${b || ''}`;
        const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
        if (shorter === '' || shorter === longer || !longer.startsWith(shorter)) return false;
        const bytes = Buffer.byteLength(shorter, 'utf8');
        return bytes >= 60 && bytes <= 64;
    },

    /* Name without the tracker's clan tag (the current one, or the one the names were made with) */
    baseName: function (name, ...clanTags) {
        const n = `${name || ''}`;
        for (const clanTag of clanTags) {
            if (clanTag && n.startsWith(`${clanTag} `)) return n.slice(`${clanTag} `.length);
        }
        return n;
    },

    /* One entry per BattleMetrics player: the same player added twice (by name and by Steam ID) is
       merged into the first entry (which gets the Steam ID). Returns true if something changed. */
    mergeDuplicatePlayers: function (tracker) {
        if (!tracker || !Array.isArray(tracker.players)) return false;
        const kept = [];
        let changed = false;
        for (const player of tracker.players) {
            const target = player.playerId ? kept.find(e => e.playerId && `${e.playerId}` === `${player.playerId}`) : null;
            /* Two different Steam accounts cannot be the same BattleMetrics player: leave them */
            if (target && !(target.steamId && player.steamId && `${target.steamId}` !== `${player.steamId}`)) {
                if (!target.steamId && player.steamId) target.steamId = player.steamId;
                if ((!target.name || target.name === '-') && player.name && player.name !== '-') {
                    target.name = player.name;
                }
                changed = true;
                continue;
            }
            kept.push(player);
        }
        if (changed) tracker.players = kept;
        return changed;
    },

    /* Returns true if some player of the tracker got its BattleMetrics id (or its name) now */
    findMissingPlayerIds: async function (client, tracker, bmInstance, now = Date.now()) {
        let changed = false;
        const tag = tracker.clanTag ? `${tracker.clanTag} ` : '';
        const bmPlayers = (bmInstance && bmInstance.players) || {};
        for (const player of tracker.players) {
            const noName = !player.name || player.name === '-';

            if (player.playerId) {
                /* Added by BattleMetrics id while that player was never seen: take the name when seen */
                const seen = bmPlayers[player.playerId];
                if (noName && seen && seen.name) {
                    player.name = seen.name;
                    changed = true;
                }
                continue;
            }
            /* Nothing to look for */
            if (!player.steamId && noName) continue;

            /* No name yet (the Steam profile could not be read when added): try again */
            if (player.steamId && noName) {
                if (player.nextSearch && now < player.nextSearch) continue;
                player.nextSearch = now + SEARCH_INTERVAL_MS;
                const steamName = await Scrape.scrapeSteamProfileName(client, player.steamId);
                if (!steamName) continue;
                player.name = `${tag}${steamName}`;
                changed = true;
            }
            const name = tag && player.name.startsWith(tag) ? player.name.slice(tag.length) : player.name;
            const names = [player.name, name];

            /* Online now with that name (with the clan tag, as the tracker shows it, or without) */
            const online = Object.keys(bmPlayers).find(e => names.includes(bmPlayers[e].name));
            if (online) {
                player.playerId = online;
                delete player.nextSearch;
                changed = true;
                continue;
            }

            /* Search the server's players on BattleMetrics, every 10 minutes at most */
            if (player.nextSearch && now < player.nextSearch) continue;
            player.nextSearch = now + SEARCH_INTERVAL_MS;
            const found = await require('../util/trackerResolve.js').searchBattlemetrics(bmInstance, name);
            const match = found.find(e => names.includes(e.name)) ||
                found.find(e => names.some(n => e.name.toLowerCase() === n.toLowerCase()));
            if (match) {
                player.playerId = match.id;
                delete player.nextSearch;
                changed = true;
            }
        }
        /* The id found may already belong to another entry of the tracker: merge them */
        if (module.exports.mergeDuplicatePlayers(tracker)) changed = true;
        return changed;
    },

    handler: async function (client, firstTime = false) {
        /* A slow round (BattleMetrics slow to answer) must not overlap the next one */
        if (client.battlemetricsBusy) return;
        client.battlemetricsBusy = true;
        try {
            await module.exports.handlerRound(client, firstTime);
        }
        finally {
            client.battlemetricsBusy = false;
        }
    },

    handlerRound: async function (client, firstTime = false) {
        const searchSteamProfiles = (client.battlemetricsIntervalCounter === 0) ? true : false;
        const calledSteamProfiles = new Object();

        if (!firstTime) await client.updateBattlemetricsInstances();

        for (const guildItem of client.guilds.cache) {
            const guildId = guildItem[0];
            const instance = client.getInstance(guildId);
            const rustplus = client.rustplusInstances[guildId];

            if (!firstTime) await module.exports.handleBattlemetricsChanges(client, guildId);

            /* Update information channel battlemetrics players */
            const bmId = instance.activeServer !== null ?
                instance.serverList[instance.activeServer].battlemetricsId : null;
            let condition = instance.generalSettings.displayInformationBattlemetricsAllOnlinePlayers;
            condition &= instance.activeServer !== null;
            condition &= bmId !== null;
            condition &= client.battlemetricsInstances.hasOwnProperty(bmId);
            condition &= rustplus && rustplus.isOperational;

            if (condition) {
                await DiscordMessages.sendUpdateBattlemetricsOnlinePlayersInformationMessage(rustplus, bmId);
            }
            else {
                if (instance.informationMessageId.battlemetricsPlayers !== null) {
                    await DiscordTools.deleteMessageById(guildId, instance.channelId.information,
                        instance.informationMessageId.battlemetricsPlayers);

                    instance.informationMessageId.battlemetricsPlayers = null;
                    client.setInstance(guildId, instance);
                }
            }

            for (const [trackerId, content] of Object.entries(instance.trackers)) {
                const battlemetricsId = content.battlemetricsId;
                const bmInstance = client.battlemetricsInstances[battlemetricsId];

                if (!bmInstance || !bmInstance.lastUpdateSuccessful) continue;

                if (module.exports.mergeDuplicatePlayers(content)) client.setInstance(guildId, instance);

                if (firstTime || searchSteamProfiles) {
                    for (const player of content.players) {
                        if (player.steamId === null) continue;

                        let name = null;
                        if (calledSteamProfiles.hasOwnProperty(player.steamId)) {
                            name = calledSteamProfiles[player.steamId];
                        }
                        else {
                            name = await Scrape.scrapeSteamProfileName(client, player.steamId);
                            calledSteamProfiles[player.steamId] = name;
                        }
                        if (name === null) continue;

                        const steamName = `${name}`;
                        name = (content.clanTag ? `${content.clanTag} ` : '') + steamName;

                        if (player.name !== name) {
                            /* Only the clan tag changed (edited in the tracker): not a name change */
                            const oldBase = module.exports.baseName(player.name, content.namesClanTag,
                                content.clanTag);
                            const known = player.name && player.name !== '-';
                            if (known && oldBase !== steamName) {
                                await module.exports.trackerNewNameDetected(client, guildId, trackerId,
                                    battlemetricsId, player.name, name);
                            }

                            /* Keep the BattleMetrics id found when the player was added unless the new
                               name matches someone online right now */
                            const newPlayerId = Object.keys(bmInstance.players)
                                .find(e => [name, steamName].includes(bmInstance.players[e]['name']));
                            if (newPlayerId) player.playerId = newPlayerId;
                            player.name = name;
                        }
                    }
                    /* The tag the names are made with now */
                    content.namesClanTag = content.clanTag || '';
                    module.exports.mergeDuplicatePlayers(content);

                    client.setInstance(guildId, instance);

                    if (firstTime) {
                        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                        continue;
                    }
                }

                /* Players added by Steam ID whose BattleMetrics player was not found yet (never played on
                   this server, or the Steam name could not be read): keep looking for them */
                if (await module.exports.findMissingPlayerIds(client, content, bmInstance)) {
                    client.setInstance(guildId, instance);
                    await DiscordMessages.sendTrackerMessage(guildId, trackerId);
                }

                /* Each BattleMetrics player once (an entry per player: one notice each) */
                const trackerPlayerIds = Array.from(new Set(content.players.map(e => e.playerId)
                    .filter(e => e !== null && e !== undefined && e !== '')));
                const entryOf = (playerId) => content.players.find(e => e.playerId === playerId);

                /* Check if Player just changed name: announced and stored (compared without the clan tag) */
                let namesChanged = false;
                for (const change of bmInstance.nameChangedPlayers.filter(e => trackerPlayerIds.includes(e.id))) {
                    const playerT = entryOf(change.id);
                    if (!playerT) continue;

                    const tags = [content.namesClanTag, content.clanTag];
                    const newBase = module.exports.baseName(change.to, ...tags);
                    const oldName = playerT.name;
                    const tagged = content.clanTag && `${oldName || ''}`.startsWith(`${content.clanTag} `);
                    const newName = tagged ? `${content.clanTag} ${newBase}` : `${change.to}`;
                    if (oldName === newName) continue;

                    playerT.name = newName;
                    namesChanged = true;
                    if (oldName && oldName !== '-' && module.exports.baseName(oldName, ...tags) !== newBase) {
                        await module.exports.trackerNewNameDetected(client, guildId, trackerId, battlemetricsId,
                            oldName, newName);
                    }
                }
                if (namesChanged) client.setInstance(guildId, instance);

                /* Check if Player just came online */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.newPlayers.includes(e))) {
                    {
                        const player = entryOf(playerId);
                        if (!player) continue;

                        const str = client.intlGet(guildId, 'playerJustConnectedTracker', {
                            name: player.name,
                            tracker: content.name
                        });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, content.serverId, Constants.COLOR_ACTIVE, str, null, content.title,
                            content.everyone);
                        if (rustplus && (rustplus.serverId === content.serverId) && content.inGame) {
                            rustplus.sendInGameMessage(str);
                        }
                    }
                }

                /* Check if Player just came online */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.loginPlayers.includes(e))) {
                    {
                        const player = entryOf(playerId);
                        if (!player) continue;

                        const str = client.intlGet(guildId, 'playerJustConnectedTracker', {
                            name: player.name,
                            tracker: content.name
                        });
                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, content.serverId, Constants.COLOR_ACTIVE, str, null, content.title,
                            content.everyone);
                        if (rustplus && (rustplus.serverId === content.serverId) && content.inGame) {
                            rustplus.sendInGameMessage(str);
                        }
                    }
                }

                /* Check if Player just went offline */
                for (const playerId of trackerPlayerIds.filter(e => bmInstance.logoutPlayers.includes(e))) {
                    {
                        const player = entryOf(playerId);
                        if (!player) continue;

                        const str = client.intlGet(guildId, 'playerJustDisconnectedTracker', {
                            name: player.name,
                            tracker: content.name
                        });

                        await DiscordMessages.sendActivityNotificationMessage(
                            guildId, content.serverId, Constants.COLOR_INACTIVE, str, null, content.title,
                            content.everyone);
                        if (rustplus && (rustplus.serverId === content.serverId) && content.inGame) {
                            rustplus.sendInGameMessage(str);
                        }
                    }
                }

                await module.exports.handleTrackerIntel(client, guildId, trackerId, content, bmInstance, rustplus);

                client.setInstance(guildId, instance);

                await DiscordMessages.sendTrackerMessage(guildId, trackerId);
            }

            TrackerIntel.cleanup(guildId, Object.keys(instance.trackers));
            try {
                TrackerIntel.save(guildId);
            }
            catch (e) {
                client.log(client.intlGet(null, 'errorCap'), `Tracker history save failed: ${e}`, 'error');
            }
        }

        /* Steam names are refreshed about every 30 minutes, whatever the interval */
        const cyclesIn30Min = Math.max(1, Math.round(1800 / Config.battlemetrics.intervalSeconds));
        if (client.battlemetricsIntervalCounter >= cyclesIn30Min - 1) {
            client.battlemetricsIntervalCounter = 0;
        }
        else {
            client.battlemetricsIntervalCounter += 1;
        }
    },

    handleTrackerIntel: async function (client, guildId, trackerId, tracker, bmInstance, rustplus) {
        let alerts = [];
        try {
            alerts = TrackerIntel.update(guildId, trackerId, tracker, bmInstance);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Tracker intel failed: ${e}`, 'error');
            return;
        }

        for (const alert of alerts) {
            let str = null, color = null;
            if (alert.type === 'allOffline') {
                str = client.intlGet(guildId, alert.lastName ? 'trackerAllOffline' : 'trackerAllOfflineNoName', {
                    tracker: tracker.name,
                    count: alert.count,
                    name: alert.lastName
                });
                color = Constants.COLOR_INACTIVE;
            }
            else if (alert.type === 'groupLogin') {
                str = client.intlGet(guildId, 'trackerGroupLogin', {
                    tracker: tracker.name,
                    count: alert.count,
                    minutes: alert.minutes,
                    names: alert.names.join(', ')
                });
                color = Constants.COLOR_ACTIVE;
            }
            if (str === null) continue;

            await DiscordMessages.sendActivityNotificationMessage(
                guildId, tracker.serverId, color, str, null, tracker.title, tracker.everyone);
            if (rustplus && (rustplus.serverId === tracker.serverId) && tracker.inGame) {
                rustplus.sendInGameMessage(str);
            }
        }
    },

    handleBattlemetricsChanges: async function (client, guildId) {
        const instance = client.getInstance(guildId);
        const settings = instance.generalSettings;

        const activeServer = instance.activeServer;
        const server = instance.serverList[activeServer];
        const battlemetricsIdActiveServer = server ? server.battlemetricsId : null;

        const battlemetricsIds = [];
        if (battlemetricsIdActiveServer && client.battlemetricsInstances.hasOwnProperty(battlemetricsIdActiveServer) &&
            client.battlemetricsInstances[battlemetricsIdActiveServer].lastUpdateSuccessful) {
            battlemetricsIds.push(battlemetricsIdActiveServer);
        }

        for (const [trackerId, content] of Object.entries(instance.trackers)) {
            const battlemetricsId = content.battlemetricsId;
            const bmInstance = client.battlemetricsInstances[battlemetricsId];

            if (!bmInstance || (bmInstance && !bmInstance.lastUpdateSuccessful)) continue;
            if (battlemetricsIds.includes(battlemetricsId)) continue;

            battlemetricsIds.push(battlemetricsId);
        }

        /* Go through each battlemetrics instance and notify changes */
        for (const battlemetricsId of battlemetricsIds) {
            const bmInstance = client.battlemetricsInstances[battlemetricsId];

            /* Server name changed? */
            if (settings.battlemetricsServerNameChanges && bmInstance.serverEvaluation.hasOwnProperty('server_name') &&
                !module.exports.isTruncatedName(bmInstance.serverEvaluation['server_name'].from,
                    bmInstance.serverEvaluation['server_name'].to)) {
                const oldName = bmInstance.serverEvaluation['server_name'].from;
                const newName = bmInstance.serverEvaluation['server_name'].to;

                const title = client.intlGet(guildId, 'battlemetricsServerNameChanged');
                const description = `__**${client.intlGet(guildId, 'old')}:**__ ${oldName}\n` +
                    `__**${client.intlGet(guildId, 'new')}:**__ ${newName}`;

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title, description);
            }

            /* Players whos name have changed */
            if (settings.battlemetricsGlobalNameChanges && bmInstance.nameChangedPlayers.length !== 0) {
                const title = client.intlGet(guildId, 'battlemetricsPlayersNameChanged');

                const oldNameFieldName = client.intlGet(guildId, 'old');
                const playerIdFieldName = client.intlGet(guildId, 'playerId');
                const newNameFieldName = client.intlGet(guildId, 'new');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */

                let oldName = [''], playerId = [''], newName = [''];
                let oldNameCharacters = 0, playerIdCharacters = 0, newNameCharacters = 0;
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const player of bmInstance.nameChangedPlayers) {
                    playerCounter += 1;
                    const fieldRowMaxLength = Constants.EMBED_FIELD_MAX_WIDTH_LENGTH_3;

                    let oldN = `${player.from}`;
                    oldN = oldN.length <= fieldRowMaxLength ? oldN : oldN.substring(0, fieldRowMaxLength - 2) + '..';
                    oldN += '\n';

                    const id = `[${player.id}](${Constants.BATTLEMETRICS_PROFILE_URL + `${player.id}`})\n`;

                    let newN = `${player.to}`;
                    newN = newN.length <= fieldRowMaxLength ? newN : newN.substring(0, fieldRowMaxLength - 2) + '..';
                    newN += '\n';



                    if (totalCharacters + (oldN.length + id.length + newN.length) >=
                        Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if ((oldNameCharacters + oldN.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                        (playerIdCharacters + id.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS ||
                        (newNameCharacters + newN.length) > Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldIndex += 1;

                        oldName.push('');
                        playerId.push('');
                        newName.push('');

                        oldNameCharacters = 0;
                        playerIdCharacters = 0;
                        newNameCharacters = 0;
                    }

                    oldNameCharacters += oldN.length;
                    playerIdCharacters += id.length;
                    newNameCharacters += newN.length;

                    totalCharacters += oldN.length + id.length + newN.length;

                    oldName[fieldIndex] += oldN;
                    playerId[fieldIndex] += id;
                    newName[fieldIndex] += newN;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: bmInstance.nameChangedPlayers.length - playerCounter
                    });
                }

                const fields = [];
                for (let i = 0; i < (fieldIndex + 1); i++) {
                    fields.push({
                        name: i === 0 ? oldNameFieldName : '\u200B',
                        value: oldName[i] !== '' ? oldName[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                    fields.push({
                        name: i === 0 ? playerIdFieldName : '\u200B',
                        value: playerId[i] !== '' ? playerId[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                    fields.push({
                        name: i === 0 ? newNameFieldName : '\u200B',
                        value: newName[i] !== '' ? newName[i] : client.intlGet(guildId, 'empty'),
                        inline: true
                    });
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, fields);
            }

            /* Players that just logged in */
            if (settings.battlemetricsGlobalLogin &&
                (bmInstance.loginPlayers.length !== 0 || bmInstance.newPlayers.length !== 0)) {
                const playerIds = Array.from(new Set(bmInstance.loginPlayers.concat(bmInstance.newPlayers)));
                const title = client.intlGet(guildId, 'battlemetricsPlayersLogin');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */
                let fieldCharacters = 0;

                const fields = [''];
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const playerId of playerIds) {
                    playerCounter += 1;
                    const name = bmInstance.players[playerId]['name'].replace(/\[/g, '(').replace(/\]/g, ')');
                    const playerStr = `[${name}](${Constants.BATTLEMETRICS_PROFILE_URL + `${playerId}`})\n`;

                    if (totalCharacters + playerStr.length >= Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if (fieldCharacters + playerStr.length >= Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldCharacters = 0;
                        fieldIndex += 1;
                        fields.push('');
                    }

                    fields[fieldIndex] += playerStr;
                    totalCharacters += playerStr.length;
                    fieldCharacters += playerStr.length;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: playerIds.length - playerCounter
                    });
                }

                let fieldCounter = 0;
                const outPutFields = [];
                for (const field of fields) {
                    outPutFields.push({
                        name: '\u200B',
                        value: field === '' ? '\u200B' : field,
                        inline: true
                    });
                    fieldCounter += 1;
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, outPutFields);
            }

            /* Players that just logged out */
            if (settings.battlemetricsGlobalLogout && bmInstance.logoutPlayers.length !== 0) {
                const title = client.intlGet(guildId, 'battlemetricsPlayersLogout');

                let totalCharacters = 50; /* Start of with 50 characters as a base. */
                let fieldCharacters = 0;

                const fields = [''];
                let fieldIndex = 0;
                let isEmbedFull = false;
                let playerCounter = 0;
                for (const playerId of bmInstance.logoutPlayers) {
                    playerCounter += 1;
                    const name = bmInstance.players[playerId]['name'].replace(/\[/g, '(').replace(/\]/g, ')');
                    const playerStr = `[${name}](${Constants.BATTLEMETRICS_PROFILE_URL + `${playerId}`})\n`;

                    if (totalCharacters + playerStr.length >= Constants.EMBED_MAX_TOTAL_CHARACTERS) {
                        isEmbedFull = true;
                        break;
                    }

                    if (fieldCharacters + playerStr.length >= Constants.EMBED_MAX_FIELD_VALUE_CHARACTERS) {
                        fieldCharacters = 0;
                        fieldIndex += 1;
                        fields.push('');
                    }

                    fields[fieldIndex] += playerStr;
                    totalCharacters += playerStr.length;
                    fieldCharacters += playerStr.length;
                }

                let description = '';
                if (isEmbedFull) {
                    description = client.intlGet(guildId, 'andMorePlayers', {
                        number: bmInstance.logoutPlayers.length - playerCounter
                    });
                }

                let fieldCounter = 0;
                const outPutFields = [];
                for (const field of fields) {
                    outPutFields.push({
                        name: '\u200B',
                        value: field === '' ? '\u200B' : field,
                        inline: true
                    });
                    fieldCounter += 1;
                }

                await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title,
                    description, outPutFields);
            }
        }
    },

    trackerNewNameDetected: async function (client, guildId, trackerId, battlemetricsId, oldName, newName) {
        const instance = client.getInstance(guildId);
        const trackerName = instance.trackers[trackerId].name;

        const title = client.intlGet(guildId, 'battlemetricsTrackerPlayerNameChanged');
        const description = `__**${client.intlGet(guildId, 'tracker')}:**__ ${trackerName}\n\n` +
            `__**${client.intlGet(guildId, 'old')}:**__ ${oldName}\n` +
            `__**${client.intlGet(guildId, 'new')}:**__ ${newName}`;

        await DiscordMessages.sendBattlemetricsEventMessage(guildId, battlemetricsId, title, description, null,
            instance.trackers[trackerId].everyone);
    },
}