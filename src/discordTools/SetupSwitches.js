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

const DiscordMessages = require('./discordMessages.js');
const SwitchOverride = require('../util/switchOverride.js');
const DiscordTools = require('./discordTools.js');

module.exports = async (client, rustplus) => {
    const instance = client.getInstance(rustplus.guildId);
    const guildId = rustplus.guildId;
    const serverId = rustplus.serverId;

    if (rustplus.isNewConnection) {
        await DiscordTools.clearTextChannel(guildId, instance.channelId.switches, 100);
    }

    for (const entityId in instance.serverList[serverId].switches) {
        const entity = instance.serverList[serverId].switches[entityId];
        const info = await rustplus.getEntityInfoAsync(entityId);

        const wasReachable = entity.reachable === true;
        if (!(await rustplus.isResponseValid(info))) {
            if (entity.reachable === true) {
                await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
            }
            entity.reachable = false;
        }
        else {
            entity.reachable = true;
        }

        if (entity.reachable) {
            const real = info.entityInfo.payload.value;
            /* Changed while the bot was not connected: only a person can have done that, so in an
               automatic mode (always on/off, proximity...) it counts as an order by hand, the same as a
               change seen in game while connected. Otherwise ALWAYS ON would turn it back on at once. */
            if (wasReachable && typeof entity.active === 'boolean' && typeof real === 'boolean' &&
                entity.active !== real && SwitchOverride.setManual(entity, real)) {
                rustplus.log(client.intlGet(null, 'infoCap'),
                    `Switch ${entity.name} (${entityId}) changed while disconnected -> ${real ? 'ON' : 'OFF'}, kept as an order by hand.`);
            }
            entity.active = real;
        }

        client.setInstance(guildId, instance);

        await DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
    }
};
