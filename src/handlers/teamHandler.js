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

const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');

const QUEUE_ITEM_MS = 30 * 1000;
const STALE_TEAM_MS = 3 * 60 * 1000;
const RECENT_DEATH_S = 3 * 60;
const NOTICE_MS = 20 * 1000;

module.exports = {
    STALE_TEAM_MS: STALE_TEAM_MS,
    handler: async function (rustplus, client, teamInfo) {
        /* Handle team changes */
        await module.exports.sendNotices(module.exports.checkChanges(rustplus, client, teamInfo));
    },

    /* The notices of one change, in order. A failing one does not stop the others, and one that does
       not finish (a Discord call that hangs) does not hold back the next ones for more than NOTICE_MS. */
    sendNotices: async function (notices) {
        for (const notice of notices) {
            let timer = null;
            const limit = new Promise((resolve) => { timer = setTimeout(resolve, NOTICE_MS); });
            try { await Promise.race([Promise.resolve().then(notice), limit]); }
            catch (e) {
                const Client = require('../../index.ts');
                Client.client.log(Client.client.intlGet(null, 'errorCap'), `Team notice: ${e}`, 'error');
            }
            finally {
                clearTimeout(timer);
            }
        }
    },

    /* Team changes are processed one at a time per connection (poll and the game's "team changed"
       message must never interleave: the notices are worked out against the team as it was before
       the change, and the team is updated right after). */
    enqueue: function (rustplus, fn) {
        const previous = rustplus.teamQueue || Promise.resolve();
        /* One change that never finishes (e.g. a Discord send that hangs) must not block the queue:
           after QUEUE_ITEM_MS the next one goes on. */
        const next = previous.catch(() => { }).then(() => {
            let timer = null;
            const limit = new Promise((resolve) => { timer = setTimeout(resolve, QUEUE_ITEM_MS); });
            return Promise.race([Promise.resolve().then(fn), limit]).finally(() => clearTimeout(timer));
        });
        rustplus.teamQueue = next.catch(() => { });
        return next;
    },

    /**
     *  Announces the changes and updates the team. If the team has not been updated for a while (the
     *  connection or the polling was stuck), the differences are hours old and would be announced as if
     *  they had just happened (deaths, connections that are not true any more): the team is then
     *  brought up to date without notices.
     */
    apply: async function (rustplus, client, teamInfo, now = Date.now()) {
        if (!rustplus.team || !teamInfo) return;
        const last = rustplus.lastTeamUpdateAt;
        if (last && now - last > STALE_TEAM_MS) {
            rustplus.log(client.intlGet(null, 'warningCap'),
                `Team not updated for ${Math.round((now - last) / 1000)} s: brought up to date without notices.`,
                'warning');
            /* Deaths of the last minutes are still real news: those are announced */
            const recent = [];
            const nowSeconds = now / 1000;
            for (const member of (teamInfo.members || [])) {
                const steamId = member.steamId.toString();
                const deathTime = Number(member.deathTime) || 0;
                const known = rustplus.teamNotified && rustplus.teamNotified.death[steamId];
                const player = rustplus.team.getPlayer(steamId);
                if (deathTime && nowSeconds - deathTime < RECENT_DEATH_S && deathTime !== known &&
                    player && Number(player.deathTime) !== deathTime) {
                    recent.push({ steamId: steamId, name: player.name, pos: player.pos });
                }
            }
            rustplus.team.updateTeam(teamInfo);
            rustplus.lastTeamUpdateAt = Date.now();
            module.exports.syncNotified(rustplus, teamInfo);
            for (const dead of recent) {
                await module.exports.announceDeath(rustplus, client, dead.steamId, dead.name, dead.pos);
            }
        }
        else {
            /* What to announce is worked out against the team as it was, the team is updated at once,
               and only then are the notices sent: a slow Discord / Steam must not leave the team old
               meanwhile (notices worked out on it later were lost or wrong, e.g. "went AFK"), nor let
               an older change overwrite a newer one when its notices outlast the queue limit. */
            const notices = module.exports.checkChanges(rustplus, client, teamInfo);
            rustplus.team.updateTeam(teamInfo);
            rustplus.lastTeamUpdateAt = Date.now();
            await module.exports.sendNotices(notices);
        }
    },

    announceDeath: async function (rustplus, client, steamId, name, pos) {
        const guildId = rustplus.guildId;
        const instance = client.getInstance(guildId);
        const location = !pos ? 'spawn' : pos.string;
        const str = client.intlGet(guildId, 'playerJustDied', { name: name, location: location });
        /* The game, the log and !death first: a slow or failing Discord must not lose them */
        if (instance.generalSettings.deathNotify) rustplus.sendInGameMessage(str);
        rustplus.log(client.intlGet(null, 'infoCap'), str);
        rustplus.updateDeaths(steamId, { name: name, location: pos });
        await DiscordMessages.sendActivityNotificationMessage(
            guildId, rustplus.serverId, Constants.COLOR_INACTIVE, str, steamId);
    },

    /* What was "already announced" is set to the current state (after a silent update) */
    syncNotified: function (rustplus, teamInfo) {
        if (!rustplus.teamNotified) rustplus.teamNotified = { death: {}, online: {}, member: {} };
        for (const member of (teamInfo.members || [])) {
            const steamId = member.steamId.toString();
            rustplus.teamNotified.member[steamId] = true;
            rustplus.teamNotified.online[steamId] = !!member.isOnline;
            const deathTime = Number(member.deathTime) || 0;
            if (deathTime) rustplus.teamNotified.death[steamId] = deathTime;
        }
    },

    /* Works out the notices of a team change (synchronously, against the team before the change) and
       returns them as functions to call in order, after the team has been updated. */
    checkChanges: function (rustplus, client, teamInfo) {
        let instance = client.getInstance(rustplus.guildId);
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;
        const server = instance.serverList[serverId];
        const notices = [];

        /* A leader change is handled by Team.updateTeam: the joins, leaves, deaths and connections of
           the same update are still announced. */
        const newPlayers = rustplus.team.getNewPlayers(teamInfo);
        const leftPlayers = rustplus.team.getLeftPlayers(teamInfo);

        /* The same change can be seen twice (the poll and the game's "team changed" message arrive
           at the same time): each death / connection / team change is announced only once. */
        if (!rustplus.teamNotified) rustplus.teamNotified = { death: {}, online: {}, member: {} };
        const once = (kind, steamId, value) => {
            if (rustplus.teamNotified[kind][steamId] === value) return false;
            rustplus.teamNotified[kind][steamId] = value;
            return true;
        };
        /* A death is announced once, and an older answer (with an older death) is not a new death */
        const newDeath = (steamId, deathTime) => {
            const time = Number(deathTime) || 0;
            const last = rustplus.teamNotified.death[steamId];
            if (time === 0) {
                /* No death time from the server: at most one death notice every 30 s per player */
                const at = rustplus.teamNotified.deathAt || (rustplus.teamNotified.deathAt = {});
                if (at[steamId] && Date.now() - at[steamId] < 30 * 1000) return false;
                at[steamId] = Date.now();
                return true;
            }
            if (last !== undefined && time <= last) return false;
            rustplus.teamNotified.death[steamId] = time;
            return true;
        };
        /* A connection notice: Discord, the game (if enabled) and the history */
        const connectionNotice = (steamId, str, color, logText) => {
            notices.push(async () => {
                if (instance.generalSettings.connectionNotify) rustplus.sendInGameMessage(str);
                rustplus.log(client.intlGet(null, 'infoCap'), logText || str);
                rustplus.updateConnections(steamId, str);
                await DiscordMessages.sendActivityNotificationMessage(guildId, serverId, color, str, steamId);
            });
        };

        for (const steamId of leftPlayers) {
            if (!once('member', steamId, false)) continue;
            /* Out of the team: the next connection / disconnection is compared from scratch */
            delete rustplus.teamNotified.online[steamId];
            const player = rustplus.team.getPlayer(steamId);
            const str = client.intlGet(guildId, 'playerLeftTheTeam', { name: player ? player.name : steamId });
            connectionNotice(steamId, str, Constants.COLOR_GREY);
        }

        for (const steamId of newPlayers) {
            for (const player of teamInfo.members) {
                if (player.steamId.toString() === steamId) {
                    if (!once('member', steamId, true)) continue;
                    /* What was announced before leaving does not count: a player who left the team
                       offline and comes back online must have his next disconnection announced */
                    rustplus.teamNotified.online[steamId] = !!player.isOnline;
                    const str = client.intlGet(guildId, 'playerJoinedTheTeam', { name: player.name });
                    connectionNotice(steamId, str, Constants.COLOR_ACTIVE);
                }
            }
        }

        for (const player of rustplus.team.players) {
            if (leftPlayers.includes(player.steamId)) continue;
            for (const playerUpdated of teamInfo.members) {
                if (player.steamId === playerUpdated.steamId.toString()) {
                    if (player.isGoneDead(playerUpdated) && newDeath(player.steamId, playerUpdated.deathTime)) {
                        const steamId = player.steamId, name = player.name, pos = player.pos;
                        notices.push(() => module.exports.announceDeath(rustplus, client, steamId, name, pos));
                    }

                    if (player.isGoneAfk(playerUpdated)) {
                        if (instance.generalSettings.afkNotify) {
                            const str = client.intlGet(guildId, 'playerJustWentAfk', { name: player.name });
                            notices.push(async () => {
                                rustplus.sendInGameMessage(str);
                                rustplus.log(client.intlGet(null, 'infoCap'), str);
                            });
                        }
                    }

                    if (player.isAfk() && player.isMoved(playerUpdated)) {
                        if (instance.generalSettings.afkNotify) {
                            const str = client.intlGet(guildId, 'playerJustReturned', {
                                name: player.name,
                                time: player.getAfkTime('dhs')
                            });
                            notices.push(async () => {
                                rustplus.sendInGameMessage(str);
                                rustplus.log(client.intlGet(null, 'infoCap'), str);
                            });
                        }
                    }

                    if (player.isGoneOnline(playerUpdated) && once('online', player.steamId, true)) {
                        const str = client.intlGet(guildId, 'playerJustConnected', { name: player.name });
                        connectionNotice(player.steamId, str, Constants.COLOR_ACTIVE,
                            client.intlGet(null, 'playerJustConnectedTo', { name: player.name, server: server.title }));
                    }

                    if (player.isGoneOffline(playerUpdated) && once('online', player.steamId, false)) {
                        const str = client.intlGet(guildId, 'playerJustDisconnected', { name: player.name });
                        connectionNotice(player.steamId, str, Constants.COLOR_INACTIVE,
                            client.intlGet(null, 'playerJustDisconnectedFrom', { name: player.name, server: server.title }));
                    }
                    break;
                }
            }
        }
        return notices;
    },
}