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

const DiscordMessages = require('../discordTools/discordMessages.js');
const Info = require('../structures/Info');
const Map = require('../structures/Map');
const PollingHandler = require('../handlers/pollingHandler.js');
const RustRelay = require('../util/rustRelay.js');
const ServerLifecycle = require('../util/serverLifecycle.js');

module.exports = {
    name: 'connected',
    async execute(rustplus, client) {
        if (!rustplus.isServerAvailable()) return rustplus.deleteThisRustplusInstance();
        if (rustplus.stopIfReplaced()) return;

        rustplus.log(client.intlGet(null, 'connectedCap'), client.intlGet(null, 'connectedToServer'));

        const instance = client.getInstance(rustplus.guildId);
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;

        rustplus.uptimeServer = new Date();

        /* Start the token replenish task */
        rustplus.tokensReplenishTaskId = setInterval(rustplus.replenishTokens.bind(rustplus), 1000);

        /* Request the map. Act as a check to see if connection is truly operational. */
        const map = await rustplus.getMapAsync(3 * 60 * 1000); /* 3 min timeout */
        if (rustplus.stopIfReplaced()) return;
        if (!(await rustplus.isResponseValid(map))) {
            rustplus.log(client.intlGet(null, 'errorCap'),
                client.intlGet(null, 'somethingWrongWithConnection'), 'error');

            /* It worked before (reconnecting after a drop, e.g. the server is still starting):
               try again later instead of giving up */
            if (client.rustplusReconnecting[guildId] && client.activeRustplusInstances[guildId]) {
                rustplus.disconnect();
                return;
            }

            instance.activeServer = null;
            client.setInstance(guildId, instance);

            await DiscordMessages.sendServerConnectionInvalidMessage(guildId, serverId);
            await DiscordMessages.sendServerMessage(guildId, serverId, null);

            client.resetRustplusVariables(guildId);

            rustplus.disconnect();
            if (client.rustplusInstances[guildId] === rustplus) delete client.rustplusInstances[guildId];
            return;
        }
        rustplus.log(client.intlGet(null, 'connectedCap'), client.intlGet(null, 'rustplusOperational'));
        /* The connection works: a later token problem warns again */
        RustRelay.clearTokenWarning(client, guildId, rustplus.playerId);
        rustplus.reconnectDelayMs = null;

        try {
            const info = await rustplus.getInfoAsync();
            if (await rustplus.isResponseValid(info)) rustplus.info = new Info(info.info);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Connected, info: ${e}`, 'error');
        }

        let wipeDetected = false;
        try {
            if (client.rustplusMaps.hasOwnProperty(guildId) && client.isJpgImageChanged(guildId, map.map)) {
                wipeDetected = true;
            }
            rustplus.map = new Map(map.map, rustplus);
            await rustplus.map.writeMap(false, true);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Connected, map: ${e}`, 'error');
        }

        const wasReconnecting = !!client.rustplusReconnecting[guildId];
        if (wasReconnecting) {
            client.rustplusReconnecting[guildId] = false;

            if (client.rustplusReconnectTimers[guildId]) {
                clearTimeout(client.rustplusReconnectTimers[guildId]);
                client.rustplusReconnectTimers[guildId] = null;
            }
        }

        /* The Rust+ side first: polling (team, time, switches, alarms) starts right away. Operational only
           once the first poll produced team/time/info/map markers; if it did not, pollingHandler retries
           it on every interval and marks it operational then. */
        rustplus.awaitingFirstData = true;
        await optional(client, 'first poll', () => PollingHandler.pollingHandler(rustplus, client));
        if (rustplus.stopIfReplaced()) return;
        if (rustplus.isDeleted) return;
        clearInterval(rustplus.pollingTaskId);
        rustplus.pollingTaskId = setInterval(PollingHandler.pollingHandler, client.pollingIntervalMs, rustplus, client);
        if (!rustplus.isOperational && !rustplus.markOperationalIfReady()) {
            rustplus.log(client.intlGet(null, 'warningCap'),
                'First poll incomplete (no team/time/info/map markers yet): retrying on the next interval.',
                'warn');
        }

        /* The Discord side (map, server and device messages...) runs on its own: a slow or rate limited
           Discord must not keep the polling from starting */
        discordSide(rustplus, client, guildId, serverId, wipeDetected, wasReconnecting).catch((e) => {
            client.log(client.intlGet(null, 'errorCap'), `Connected, Discord messages: ${e && e.stack ? e.stack : e}`,
                'error');
        });
    },
};

async function discordSide(rustplus, client, guildId, serverId, wipeDetected, wasReconnecting) {
    if (wipeDetected) {
        await optional(client, 'wipe message', () => DiscordMessages.sendServerWipeDetectedMessage(guildId, serverId));
    }
    await optional(client, 'map message', () => DiscordMessages.sendInformationMapMessage(guildId));

    if (wasReconnecting) {
        await optional(client, 'state message', () => DiscordMessages.sendServerChangeStateMessage(guildId, serverId, 0));
    }

    await optional(client, 'server message', () => DiscordMessages.sendServerMessage(guildId, serverId, null));

    /* Setup Smart Devices: one broken device / channel must not abort the connection */
    for (const setup of ['SetupSwitches', 'SetupSwitchGroups', 'SetupAlarms', 'SetupStorageMonitors']) {
        if (rustplus.stopIfReplaced()) return;
        await optional(client, setup, () => require(`../discordTools/${setup}`)(client, rustplus));
    }
    rustplus.isNewConnection = false;
    await optional(client, 'markers', () => rustplus.loadMarkers());

    /* After a wipe, offer to remove the devices of the previous wipe */
    try {
        if (wipeDetected) {
            await ServerLifecycle.sendWipeCleanupOffer(client, guildId, serverId);
            /* The Deep Sea cycle starts again after a wipe */
            const wipedInstance = client.getInstance(guildId);
            /* The base is somewhere else after a wipe */
            const wipedServer = wipedInstance.serverList[serverId];
            if (wipedServer && (wipedServer.deepSea || wipedServer.baseLocation)) {
                delete wipedServer.deepSea;
                delete wipedServer.baseLocation;
                client.setInstance(guildId, wipedInstance);
            }
        }
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Server lifecycle: ${e}`, 'error');
    }

    /* Moved to another server: offer to remove everything about the previous ones */
    try {
        const lastInstance = client.getInstance(guildId);
        const previous = lastInstance.lastConnectedServer;
        if (previous !== serverId) {
            /* Changing server already deleted the previous ones (CONNECT asks before) */
            lastInstance.lastConnectedServer = serverId;
            client.setInstance(guildId, lastInstance);
        }
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Server change: ${e}`, 'error');
    }
}

/* Runs an optional step of the connection; an error is logged and the connection goes on */
async function optional(client, what, fn) {
    try {
        return await fn();
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Connected, ${what}: ${e && e.stack ? e.stack : e}`, 'error');
        return undefined;
    }
}
