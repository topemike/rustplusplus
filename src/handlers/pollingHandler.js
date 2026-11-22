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

const Info = require('../structures/Info');
const InformationHandler = require('../handlers/informationHandler.js');
const MapMarkers = require('../structures/MapMarkers.js');
const SmartAlarmHandler = require('../handlers/smartAlarmHandler.js');
const SmartSwitchHandler = require('../handlers/smartSwitchHandler.js');
const StorageMonitorHandler = require('../handlers/storageMonitorHandler.js');
const Team = require('../structures/Team');
const TeamHandler = require('../handlers/teamHandler.js');
const Time = require('../structures/Time');
const MarketHandler = require('../handlers/marketHandler.js');
const TimeHandler = require('../handlers/timeHandler.js');
const UpkeepBoardHandler = require('../handlers/upkeepBoardHandler.js');
const VendingMachines = require('../handlers/vendingMachineHandler.js');

const POLL_STUCK_MS = 2 * 60 * 1000;
const STEP_TIMEOUT_MS = 45 * 1000;
const HEARTBEAT_MS = 15 * 60 * 1000;

/* Runs one poll step with a time limit. A failing or hanging step is logged and the poll goes on. */
async function runStep(rustplus, client, name, fn) {
    rustplus.pollingStep = name;
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('__timeout__'), STEP_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([Promise.resolve().then(fn), timeout]);
        if (result === '__timeout__') {
            client.log(client.intlGet(null, 'warningCap'),
                `Polling: step "${name}" took more than ${STEP_TIMEOUT_MS / 1000} s, skipped.`, 'warning');
        }
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Polling step "${name}": ${e && e.stack ? e.stack : e}`, 'error');
    }
    finally {
        clearTimeout(timer);
    }
}

/* A line in the log every 15 min: shows the polling is alive and how fresh the data is */
function heartbeat(rustplus, client) {
    const now = Date.now();
    if (rustplus.lastHeartbeatAt && now - rustplus.lastHeartbeatAt < HEARTBEAT_MS) return;
    rustplus.lastHeartbeatAt = now;
    const teamAge = rustplus.lastTeamUpdateAt ? Math.round((now - rustplus.lastTeamUpdateAt) / 1000) : '-';
    const gameTime = rustplus.time && rustplus.time.time !== undefined ? Number(rustplus.time.time).toFixed(2) : '-';
    rustplus.log(client.intlGet(null, 'infoCap'),
        `Polling OK. Team updated ${teamAge} s ago, game time ${gameTime}, operational ${!!rustplus.isOperational}.`);
}

/* After a reconnection the AFK and offline times go on from where they were (same server, < 30 min) */
function restoreTeamState(rustplus, client) {
    const all = client.previousTeamState;
    const state = all ? all[rustplus.guildId] : null;
    if (!state) return;
    delete all[rustplus.guildId];
    if (state.serverId !== rustplus.serverId || Date.now() - state.at > 30 * 60 * 1000) return;
    for (const player of rustplus.team.players) {
        const old = state.players[player.steamId];
        if (!old) continue;
        if (old.x === player.x && old.y === player.y && old.isOnline === player.isOnline && old.lastMovement) {
            player.lastMovement = old.lastMovement;
            /* Already AFK before the reconnection: not announced as "just went AFK" a second time */
            player.afkSeconds = (Date.now() - new Date(old.lastMovement).getTime()) / 1000;
        }
        if (!player.isOnline && old.isOnline === false && old.wentOfflineTime) {
            player.wentOfflineTime = old.wentOfflineTime;
        }
    }
}

module.exports = {
    runStep: runStep,
    restoreTeamState: restoreTeamState,
    pollingHandler: async function (rustplus, client) {
        /* A slow poll must not overlap the next one (duplicated messages) */
        if (rustplus.stopIfReplaced && rustplus.stopIfReplaced()) return;
        if (rustplus.pollingBusy) {
            /* A poll that never finishes would freeze team, time and devices for hours: give up on it */
            if (Date.now() - (rustplus.pollingBusySince || 0) < POLL_STUCK_MS) return;
            client.log(client.intlGet(null, 'warningCap'), `Polling: the previous poll was stuck for ` +
                `${Math.round((Date.now() - rustplus.pollingBusySince) / 1000)} s at "${rustplus.pollingStep}", ` +
                `starting a new one.`, 'warning');
        }
        rustplus.pollingBusy = true;
        rustplus.pollingBusySince = Date.now();
        const myPoll = rustplus.pollingBusySince;
        try {
            await module.exports.poll(rustplus, client);
            rustplus.lastPollOkAt = Date.now();
            heartbeat(rustplus, client);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Polling: ${e && e.stack ? e.stack : e}`, 'error');
        }
        finally {
            if (rustplus.pollingBusySince === myPoll) rustplus.pollingBusy = false;
        }
        /* The first poll after connecting failed: it becomes operational when one completes */
        if (!rustplus.isOperational && typeof rustplus.markOperationalIfReady === 'function' &&
            rustplus.markOperationalIfReady()) {
            rustplus.log(client.intlGet(null, 'connectedCap'), 'First complete poll: operational.');
        }
    },

    poll: async function (rustplus, client) {
        /* Poll information such as info, mapMarkers, teamInfo and time */
        rustplus.pollingStep = 'requests';
        let info = await rustplus.getInfoAsync();
        if (!(await rustplus.isResponseValid(info))) return;

        /* The server is on and answering: confirm the held "not found" notices */
        await runStep(rustplus, client, 'deviceNotices', async () => {
            await require('../util/deviceNotices.js').verify(client, rustplus, async (type, serverId, entityId) => {
                const fn = { switch: 'sendSmartSwitchNotFoundMessage', alarm: 'sendSmartAlarmNotFoundMessage',
                    storageMonitor: 'sendStorageMonitorNotFoundMessage' }[type];
                await require('../discordTools/discordMessages.js')[fn](rustplus.guildId, serverId, entityId, true);
                /* A Smart Alarm confirmed gone (destroyed): the raid it was part of is over */
                if (type === 'alarm') {
                    await require('./raidHandler.js').onAlarmLost(client, rustplus.guildId, entityId);
                }
            });
        });
        rustplus.pollingStep = 'requests';
        let mapMarkers = await rustplus.getMapMarkersAsync();
        if (!(await rustplus.isResponseValid(mapMarkers))) return;
        /* "Team changed" messages seen before the team request is sent (see message.js) */
        const teamSeq = rustplus.teamChangedSeq || 0;
        let teamInfo = await rustplus.getTeamInfoAsync();
        if (!(await rustplus.isResponseValid(teamInfo))) return;
        let time = await rustplus.getTimeAsync();
        const timeStamp = Date.now();   /* when the in-game time was read (not after the handlers) */
        if (!(await rustplus.isResponseValid(time))) return;

        if (rustplus.isFirstPoll) {
            rustplus.info = new Info(info.info);
            rustplus.time = new Time(time.time, rustplus, client);
            rustplus.team = new Team(teamInfo.teamInfo, rustplus);
            rustplus.lastTeamUpdateAt = Date.now();
            restoreTeamState(rustplus, client);
            rustplus.mapMarkers = new MapMarkers(mapMarkers.mapMarkers, rustplus, client);
        }

        await module.exports.handlers(rustplus, client, info, mapMarkers, teamInfo, time,
            { teamSeq: teamSeq, timeStamp: timeStamp });
        rustplus.isFirstPoll = false;
    },

    handlers: async function (rustplus, client, info, mapMarkers, teamInfo, time, meta = {}) {
        /* Each step has a time limit: one step that hangs (Discord, Rust+) must not freeze the rest */
        const step = (name, fn) => runStep(rustplus, client, name, fn);

        /* Team processing is serialised with the "team changed" messages. If one arrived after this
           poll's team request was sent, this answer is older than what is already applied: skip it
           (the next poll catches up). */
        await step('team', () => TeamHandler.enqueue(rustplus, async () => {
            if (meta.teamSeq !== undefined && (rustplus.teamChangedSeq || 0) !== meta.teamSeq) return;
            await TeamHandler.apply(rustplus, client, teamInfo.teamInfo);
        }));

        await step('switches', () => SmartSwitchHandler.handler(rustplus, client, time.time));
        await step('time', () => TimeHandler.handler(rustplus, client, time.time));
        await step('vendingMachines', () => VendingMachines.handler(rustplus, client, mapMarkers.mapMarkers));

        rustplus.time.updateTime(time.time, meta.timeStamp);
        rustplus.info.updateInfo(info.info);
        rustplus.mapMarkers.updateMapMarkers(mapMarkers.mapMarkers);

        await step('market', () => MarketHandler.handler(rustplus, client));
        await step('information', () => InformationHandler.handler(rustplus));
        await step('storageMonitors', () => StorageMonitorHandler.handler(rustplus, client));
        await step('alarms', () => SmartAlarmHandler.handler(rustplus, client));
        await step('upkeepBoard', () => UpkeepBoardHandler.handler(rustplus, client));
        rustplus.pollingStep = 'done';
    },
};