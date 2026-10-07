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

module.exports = {
    pollingHandler: async function (rustplus, client) {
        /* A slow poll must not overlap the next one (duplicated messages) */
        if (rustplus.pollingBusy) return;
        rustplus.pollingBusy = true;
        try {
            await module.exports.poll(rustplus, client);
        }
        finally {
            rustplus.pollingBusy = false;
        }
    },

    poll: async function (rustplus, client) {
        /* Poll information such as info, mapMarkers, teamInfo and time */
        let info = await rustplus.getInfoAsync();
        if (!(await rustplus.isResponseValid(info))) return;

        /* The server is on and answering: confirm the held "not found" notices */
        try {
            await require('../util/deviceNotices.js').verify(client, rustplus, async (type, serverId, entityId) => {
                const fn = { switch: 'sendSmartSwitchNotFoundMessage', alarm: 'sendSmartAlarmNotFoundMessage',
                    storageMonitor: 'sendStorageMonitorNotFoundMessage' }[type];
                await require('../discordTools/discordMessages.js')[fn](rustplus.guildId, serverId, entityId, true);
                /* A Smart Alarm confirmed gone (destroyed): the raid it was part of is over */
                if (type === 'alarm') {
                    await require('./raidHandler.js').onAlarmLost(client, rustplus.guildId, entityId);
                }
            });
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Device notices: ${e}`, 'error');
        }
        let mapMarkers = await rustplus.getMapMarkersAsync();
        if (!(await rustplus.isResponseValid(mapMarkers))) return;
        let teamInfo = await rustplus.getTeamInfoAsync();
        if (!(await rustplus.isResponseValid(teamInfo))) return;
        let time = await rustplus.getTimeAsync();
        if (!(await rustplus.isResponseValid(time))) return;

        if (rustplus.isFirstPoll) {
            rustplus.info = new Info(info.info);
            rustplus.time = new Time(time.time, rustplus, client);
            rustplus.team = new Team(teamInfo.teamInfo, rustplus);
            rustplus.mapMarkers = new MapMarkers(mapMarkers.mapMarkers, rustplus, client);
        }

        await module.exports.handlers(rustplus, client, info, mapMarkers, teamInfo, time);
        rustplus.isFirstPoll = false;
    },

    handlers: async function (rustplus, client, info, mapMarkers, teamInfo, time) {
        await TeamHandler.handler(rustplus, client, teamInfo.teamInfo);
        rustplus.team.updateTeam(teamInfo.teamInfo);

        await SmartSwitchHandler.handler(rustplus, client, time.time);
        TimeHandler.handler(rustplus, client, time.time);
        await VendingMachines.handler(rustplus, client, mapMarkers.mapMarkers);

        rustplus.time.updateTime(time.time);
        rustplus.info.updateInfo(info.info);
        rustplus.mapMarkers.updateMapMarkers(mapMarkers.mapMarkers);
        try {
            await MarketHandler.handler(rustplus, client);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Market handler: ${e}`, 'error');
        }

        await InformationHandler.handler(rustplus);
        await StorageMonitorHandler.handler(rustplus, client);
        await SmartAlarmHandler.handler(rustplus, client);
        try {
            await UpkeepBoardHandler.handler(rustplus, client);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Upkeep board: ${e}`, 'error');
        }
    },
};