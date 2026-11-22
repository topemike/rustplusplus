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

const CommandHandler = require('../handlers/inGameCommandHandler.js');
const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const InGameChatHandler = require('../handlers/inGameChatHandler.js');
const BaseWatchHandler = require('../handlers/baseWatchHandler.js');
const RaidHandler = require('../handlers/raidHandler.js');
const SmartSwitchGroupHandler = require('../handlers/smartSwitchGroupHandler.js');
const SwitchOverride = require('../util/switchOverride.js');
const SwitchTimers = require('../util/switchTimers.js');
const UpkeepClock = require('../util/upkeepClock.js');
const TeamChatHandler = require("../handlers/teamChatHandler.js");
const TeamHandler = require('../handlers/teamHandler.js');

module.exports = {
    name: 'message',
    async execute(rustplus, client, message) {
        if (!rustplus.isServerAvailable()) return rustplus.deleteThisRustplusInstance();
        if (rustplus.stopIfReplaced && rustplus.stopIfReplaced()) return;

        if (!rustplus.isOperational) return;

        if (message.hasOwnProperty('response')) {
            messageResponse(rustplus, client, message);
        }
        else if (message.hasOwnProperty('broadcast')) {
            messageBroadcast(rustplus, client, message);
        }
    },
};

async function messageResponse(rustplus, client, message) {
    /* Not implemented */
}

async function messageBroadcast(rustplus, client, message) {
    if (message.broadcast.hasOwnProperty('teamChanged')) {
        messageBroadcastTeamChanged(rustplus, client, message);
    }
    else if (message.broadcast.hasOwnProperty('teamMessage')) {
        messageBroadcastTeamMessage(rustplus, client, message);
    }
    else if (message.broadcast.hasOwnProperty('entityChanged')) {
        messageBroadcastEntityChanged(rustplus, client, message);
    }
    else if (message.broadcast.hasOwnProperty('cameraRays')) {
        messageBroadcastCameraRays(rustplus, client, message);
    }
}

async function messageBroadcastTeamChanged(rustplus, client, message) {
    const teamInfo = message.broadcast.teamChanged.teamInfo;
    /* Remembered at once: a poll whose team request was sent before this message carries an older
       team and is not processed (it would announce a false connect/disconnect pair). */
    rustplus.teamChangedSeq = (rustplus.teamChangedSeq || 0) + 1;
    rustplus.lastTeamChangedAt = Date.now();
    try {
        await TeamHandler.enqueue(rustplus, async () => {
            if (!rustplus.team) return;     /* no team information yet: the next poll creates it */
            const changed = rustplus.team.isLeaderSteamIdChanged(teamInfo);
            await TeamHandler.apply(rustplus, client, teamInfo);
            if (changed) rustplus.updateLeaderRustPlusLiteInstance();
        });
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Team changed: ${e}`, 'error');
    }
}

async function messageBroadcastTeamMessage(rustplus, client, message) {
    const instance = client.getInstance(rustplus.guildId);
    const steamId = message.broadcast.teamMessage.message.steamId.toString();

    if (steamId === rustplus.playerId) {
        /* Delay inGameChatHandler */
        clearTimeout(rustplus.inGameChatTimeout);
        const commandDelayMs = parseInt(rustplus.generalSettings.commandDelay) * 1000;
        rustplus.inGameChatTimeout = setTimeout(
            InGameChatHandler.inGameChatHandler, commandDelayMs, rustplus, client);
    }

    let tempName = message.broadcast.teamMessage.message.name;
    let tempMessage = message.broadcast.teamMessage.message.message;

    tempName = tempName.replace(/^<size=.*?><color=.*?>/, '');  /* Rustafied */
    tempName = tempName.replace(/<\/color><\/size>$/, '');      /* Rustafied */
    message.broadcast.teamMessage.message.name = tempName;

    tempMessage = tempMessage.replace(/^<size=.*?><color=.*?>/, '');  /* Rustafied */
    tempMessage = tempMessage.replace(/<\/color><\/size>$/, '');      /* Rustafied */
    tempMessage = tempMessage.replace(/^<color.+?<\/color>/g, '');      /* Unknown */
    message.broadcast.teamMessage.message.message = tempMessage;

    if (instance.blacklist['steamIds'].includes(`${steamId}`)) {
        rustplus.log(client.intlGet(null, 'infoCap'), client.intlGet(null, `userPartOfBlacklistInGame`, {
            user: `${message.broadcast.teamMessage.message.name} (${steamId})`,
            message: message.broadcast.teamMessage.message.message
        }));
        TeamChatHandler(rustplus, client, message.broadcast.teamMessage.message);
        return;
    }

    if (rustplus.messagesSentByBot.includes(message.broadcast.teamMessage.message.message)) {
        /* Remove message from messagesSendByBot */
        for (let i = rustplus.messagesSentByBot.length - 1; i >= 0; i--) {
            if (rustplus.messagesSentByBot[i] === message.broadcast.teamMessage.message.message) {
                rustplus.messagesSentByBot.splice(i, 1);
            }
        }
        return;
    }

    const isCommand = await CommandHandler.inGameCommandHandler(rustplus, client, message);
    if (isCommand) return;

    rustplus.log(client.intlGet(null, 'infoCap'), client.intlGet(null, `logInGameMessage`, {
        message: message.broadcast.teamMessage.message.message,
        user: `${message.broadcast.teamMessage.message.name} (${steamId})`
    }));

    TeamChatHandler(rustplus, client, message.broadcast.teamMessage.message);
}

async function messageBroadcastEntityChanged(rustplus, client, message) {
    const instance = client.getInstance(rustplus.guildId);
    const entityId = message.broadcast.entityChanged.entityId;
    if (!instance.serverList.hasOwnProperty(rustplus.serverId)) return;

    if (instance.serverList[rustplus.serverId].switches.hasOwnProperty(entityId)) {
        messageBroadcastEntityChangedSmartSwitch(rustplus, client, message);
    }
    else if (instance.serverList[rustplus.serverId].alarms.hasOwnProperty(entityId)) {
        messageBroadcastEntityChangedSmartAlarm(rustplus, client, message);
    }
    else if (instance.serverList[rustplus.serverId].storageMonitors.hasOwnProperty(entityId)) {
        messageBroadcastEntityChangedStorageMonitor(rustplus, client, message);
    }
}

async function messageBroadcastCameraRays(rustplus, client, message) {
    /* Not implemented */
}

async function messageBroadcastEntityChangedSmartSwitch(rustplus, client, message) {
    const instance = client.getInstance(rustplus.guildId);
    const serverId = rustplus.serverId;
    const entityId = message.broadcast.entityChanged.entityId;
    const server = instance.serverList[serverId];

    if (!server || (server && !server.switches[entityId])) return;

    const active = message.broadcast.entityChanged.payload.value;
    const sw = server.switches[entityId];

    /* The echo of the bot's own change (also when Rust+ timed out but the switch did change):
       not a person's order. A stale entry (no echo came) expires, and a different value is a person. */
    SwitchOverride.sweepInteractions(rustplus);
    const echo = SwitchOverride.takeBotEcho(rustplus, entityId, active, sw);
    if (echo) {
        if (sw.active !== active || sw.reachable === false || echo.onConfirm) {
            sw.active = active;
            sw.reachable = true;
            if (echo.onConfirm) {
                /* An alarm action whose Rust+ answer timed out: it did happen */
                if (echo.onConfirm.raidLock) {
                    sw.raidLock = true;
                    delete sw.manualOverride;
                }
                if (echo.onConfirm.holdUntil) sw.holdUntil = Math.max(sw.holdUntil || 0, echo.onConfirm.holdUntil);
            }
            client.setInstance(rustplus.guildId, instance);
            DiscordMessages.sendSmartSwitchMessage(rustplus.guildId, serverId, entityId);
            SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, rustplus.guildId, serverId, entityId);
        }
        return;
    }

    SwitchTimers.clear(client, rustplus.guildId, entityId);

    /* A change coming from the game. With SIEMPRE ENCENDIDO / SIEMPRE APAGADO it is respected like a
       command (also during a raid) until VOLVER A AUTOMÁTICO. The proximity / online modes keep deciding. */
    sw.active = active;
    if ([3, 4].includes(sw.autoDayNightOnOff)) {
        delete sw.raidLock;
        delete sw.holdUntil;
        if (active === (sw.autoDayNightOnOff === 3)) { delete sw.manualOverride; sw.orderAt = Date.now(); }
        else SwitchOverride.setManual(sw, active);
    }
    client.setInstance(rustplus.guildId, instance);

    DiscordMessages.sendSmartSwitchMessage(rustplus.guildId, serverId, entityId);
    SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(
        client, rustplus.guildId, serverId, entityId);
}

async function messageBroadcastEntityChangedSmartAlarm(rustplus, client, message) {
    const instance = client.getInstance(rustplus.guildId);
    const serverId = rustplus.serverId;
    const entityId = message.broadcast.entityChanged.entityId;
    const server = instance.serverList[serverId];

    if (!server || (server && !server.alarms[entityId])) return;

    const active = message.broadcast.entityChanged.payload.value;
    server.alarms[entityId].active = active;
    server.alarms[entityId].reachable = true;
    client.setInstance(rustplus.guildId, instance);

    if (active) {
        server.alarms[entityId].lastTrigger = Math.floor(new Date() / 1000);
        client.setInstance(rustplus.guildId, instance);

        if (server.alarms[entityId].raidMode !== false) {
            /* Grouped raid notification: one message, updated, with reminders */
            await RaidHandler.onAlarmTriggered(client, rustplus, rustplus.guildId, serverId, entityId);
        }
        else {
            await DiscordMessages.sendSmartAlarmTriggerMessage(rustplus.guildId, serverId, entityId);

            if (instance.generalSettings.smartAlarmNotifyInGame) {
                rustplus.sendInGameMessage(`${server.alarms[entityId].name}: ${server.alarms[entityId].message}`);
            }
        }
    }

    DiscordMessages.sendSmartAlarmMessage(rustplus.guildId, rustplus.serverId, entityId);
}

async function messageBroadcastEntityChangedStorageMonitor(rustplus, client, message) {
    const instance = client.getInstance(rustplus.guildId);
    const serverId = rustplus.serverId;
    const entityId = message.broadcast.entityChanged.entityId;
    const server = instance.serverList[serverId];

    if (!server || (server && !server.storageMonitors[entityId])) return;

    if (message.broadcast.entityChanged.payload.value === true) return;

    if (server.storageMonitors[entityId].type === 'toolCupboard' ||
        message.broadcast.entityChanged.payload.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY) {
        setTimeout(() => updateToolCupboard(rustplus, client, message).catch(e => {
            client.log(client.intlGet(null, 'errorCap'), `Tool Cupboard update failed: ${e}`, 'error');
        }), 2000);
    }
    else {
        const prevItems = rustplus.storageMonitors.hasOwnProperty(entityId) ?
            rustplus.storageMonitors[entityId].items : null;
        rustplus.storageMonitors[entityId] = {
            items: message.broadcast.entityChanged.payload.items,
            expiry: message.broadcast.entityChanged.payload.protectionExpiry,
            capacity: message.broadcast.entityChanged.payload.capacity,
            hasProtection: message.broadcast.entityChanged.payload.hasProtection
        }

        const info = await rustplus.getEntityInfoAsync(entityId);
        if (!isStillCurrent(rustplus, client, serverId, entityId)) return;
        server.storageMonitors[entityId].reachable = await rustplus.isResponseValid(info) ? true : false;

        if (server.storageMonitors[entityId].reachable) {
            if (info.entityInfo.payload.capacity === Constants.STORAGE_MONITOR_VENDING_MACHINE_CAPACITY) {
                server.storageMonitors[entityId].type = 'vendingMachine';
            }
            else if (info.entityInfo.payload.capacity === Constants.STORAGE_MONITOR_LARGE_WOOD_BOX_CAPACITY) {
                server.storageMonitors[entityId].type = 'largeWoodBox';
            }
        }
        client.setInstance(rustplus.guildId, instance);

        await BaseWatchHandler.onStorageUpdate(client, rustplus, entityId, prevItems,
            message.broadcast.entityChanged.payload);

        await DiscordMessages.sendStorageMonitorMessage(rustplus.guildId, serverId, entityId);
    }
}

/* After an await: the monitor may have been deleted, or the bot changed server / reconnected */
function isStillCurrent(rustplus, client, serverId, entityId) {
    if (rustplus.isDeleted) return false;
    if (client.rustplusInstances && client.rustplusInstances[rustplus.guildId] &&
        client.rustplusInstances[rustplus.guildId] !== rustplus) return false;
    const instance = client.getInstance(rustplus.guildId);
    const server = instance && instance.serverList ? instance.serverList[serverId] : null;
    return !!server && !!server.storageMonitors && server.storageMonitors.hasOwnProperty(entityId);
}

async function updateToolCupboard(rustplus, client, message) {
    const serverId = rustplus.serverId;
    const entityId = message.broadcast.entityChanged.entityId;
    if (!isStillCurrent(rustplus, client, serverId, entityId)) return;

    const info = await rustplus.getEntityInfoAsync(entityId);
    if (!isStillCurrent(rustplus, client, serverId, entityId)) return;
    const instance = client.getInstance(rustplus.guildId);
    const server = instance.serverList[serverId];
    server.storageMonitors[entityId].reachable = await rustplus.isResponseValid(info) ? true : false;
    client.setInstance(rustplus.guildId, instance);

    if (server.storageMonitors[entityId].reachable) {
        const prevItems = rustplus.storageMonitors.hasOwnProperty(entityId) ?
            rustplus.storageMonitors[entityId].items : null;
        const isCupboard = info.entityInfo.payload.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY;
        /* The same correction as the periodic reads (upkeepClock.js): with the raw value the
           countdown jumps back and forth and the upkeep alerts ring again */
        const expiry = isCupboard ? UpkeepClock.correct(UpkeepClock.storeFor(client, rustplus), entityId,
            info.entityInfo.payload.protectionExpiry, info.entityInfo.payload.items) :
            info.entityInfo.payload.protectionExpiry;
        rustplus.storageMonitors[entityId] = {
            items: info.entityInfo.payload.items,
            expiry: expiry,
            capacity: info.entityInfo.payload.capacity,
            hasProtection: info.entityInfo.payload.hasProtection
        }

        server.storageMonitors[entityId].type = 'toolCupboard';

        if (info.entityInfo.payload.protectionExpiry === 0 && server.storageMonitors[entityId].decaying === false) {
            server.storageMonitors[entityId].decaying = true;

            await DiscordMessages.sendDecayingNotificationMessage(rustplus.guildId, rustplus.serverId, entityId);

            if (server.storageMonitors[entityId].inGame) {
                rustplus.sendInGameMessage(client.intlGet(rustplus.guildId, 'isDecaying', {
                    device: server.storageMonitors[entityId].name
                }));
            }
        }
        else if (info.entityInfo.payload.protectionExpiry !== 0) {
            server.storageMonitors[entityId].decaying = false;
        }
        client.setInstance(rustplus.guildId, instance);

        await BaseWatchHandler.onStorageUpdate(client, rustplus, entityId, prevItems,
            { ...info.entityInfo.payload, protectionExpiry: expiry });
    }

    await DiscordMessages.sendStorageMonitorMessage(rustplus.guildId, serverId, entityId);
}