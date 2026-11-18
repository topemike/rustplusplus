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
const DiscordTools = require('../discordTools/discordTools');

const MarketHandler = require('./marketHandler.js');
const DeepSeaHandler = require('./deepSeaHandler.js');
const Keywords = require('../util/keywords.js');

module.exports = {
    discordCommandHandler: async function (rustplus, client, message) {
        const guildId = rustplus.guildId;
        const instance = client.getInstance(guildId);

        const prefix = rustplus.generalSettings.prefix;
        let command = message.cleanContent;
        command = Keywords.applyAliases(instance.aliases, prefix, command);
        command = Keywords.normalizeCommand(client, guildId, prefix, `${command}`.trim());

        const callerName = message.author.username;
        const commandLowerCase = command.toLowerCase();

        /* "!craft" or "!craft ...", but not "!crafty" */
        const syntaxes = (key) => [`${prefix}${client.intlGet('en', key)}`, `${prefix}${client.intlGet(guildId, key)}`];
        const is = (key) => syntaxes(key).some(s => commandLowerCase === s || commandLowerCase.startsWith(`${s} `));
        const isExact = (key) => syntaxes(key).some(s => commandLowerCase === s);
        const cmdName = (key) => `${prefix}${client.intlGet(guildId, key)}`;

        let response = null;
        let reply = null; /* result of the commands below that change state: run them once */

        /* The first poll has not filled team/time/map markers/info yet: the commands need them */
        if (!rustplus.team || !rustplus.time || !rustplus.mapMarkers || !rustplus.info) {
            const word = commandLowerCase.startsWith(prefix) ?
                commandLowerCase.slice(prefix.length).split(/\s+/)[0] : null;
            if (!word || !Keywords.getListOfCommandKeywords(client, guildId).includes(word)) return false;
            response = client.intlGet(guildId, 'commandStillLoading');
        }
        else if (isExact('commandSyntaxAfk')) {
            response = rustplus.getCommandAfk();
        }
        else if (is('commandSyntaxAlive')) {
            response = rustplus.getCommandAlive(command);
        }
        else if (isExact('commandSyntaxCargo')) {
            response = rustplus.getCommandCargo();
        }
        else if (isExact('commandSyntaxChinook')) {
            response = rustplus.getCommandChinook();
        }
        else if (is('commandSyntaxConnection') || is('commandSyntaxConnections')) {
            response = rustplus.getCommandConnection(command);
        }
        else if (is('commandSyntaxCraft')) {
            response = rustplus.getCommandCraft(command);
        }
        else if (is('commandSyntaxDeath') || is('commandSyntaxDeaths')) {
            response = client.intlGet(rustplus.guildId, 'commandNotPossibleDiscord');
        }
        else if (is('commandSyntaxDecay')) {
            response = rustplus.getCommandDecay(command);
        }
        else if (is('commandSyntaxDespawn')) {
            response = rustplus.getCommandDespawn(command);
        }
        else if (is('commandSyntaxEvents')) {
            response = rustplus.getCommandEvents(command);
        }
        else if (isExact('commandSyntaxHeli')) {
            response = rustplus.getCommandHeli();
        }
        else if (is('commandSyntaxBase')) {
            /* Only the information: marking/clearing needs the position of who writes, in the game */
            const arg = command.trim().split(/\s+/).slice(1).join(' ').toLowerCase();
            if (['info', 'status', 'estado', '?'].includes(arg)) {
                response = rustplus.getCommandBase(command, null);
            }
            else {
                response = `${client.intlGet(guildId, 'commandNotPossibleDiscord')} ` +
                    client.intlGet(guildId, 'usageBaseDiscord', { cmd: cmdName('commandSyntaxBase') });
            }
        }
        else if (isExact('commandSyntaxBradley')) {
            response = rustplus.getCommandBradley();
        }
        else if (isExact('commandSyntaxCrate')) {
            response = rustplus.getCommandCrate();
        }
        else if (isExact('commandSyntaxLarge')) {
            response = rustplus.getCommandLarge();
        }
        else if (is('commandSyntaxLeader')) {
            if (isExact('commandSyntaxLeader')) {
                /* From Discord there is no caller to give the leadership to */
                response = client.intlGet(guildId, 'usageName', { cmd: cmdName('commandSyntaxLeader') });
            }
            else {
                response = await rustplus.getCommandLeader(command, null);
            }
        }
        else if (is('commandSyntaxMarker') || isExact('commandSyntaxMarkers')) {
            response = client.intlGet(rustplus.guildId, 'commandNotPossibleDiscord');
        }
        else if ((reply = DeepSeaHandler.command(rustplus, client, command)) !== null) {
            response = reply;
        }
        else if ((reply = require('./cameraWatchHandler.js').command(rustplus, client, command)) !== null) {
            response = reply;
        }
        else if ((reply = MarketHandler.getCommandFind(rustplus, client, command, true)) !== null) {
            response = reply;
        }
        else if (is('commandSyntaxMarket')) {
            response = rustplus.getCommandMarket(command);
        }
        else if (isExact('commandSyntaxMute')) {
            response = rustplus.getCommandMute();
        }
        else if (is('commandSyntaxNote') || isExact('commandSyntaxNotes')) {
            response = rustplus.getCommandNote(command);
        }
        else if (isExact('commandSyntaxOffline')) {
            response = rustplus.getCommandOffline();
        }
        else if (isExact('commandSyntaxOnline')) {
            response = rustplus.getCommandOnline();
        }
        else if (is('commandSyntaxPlayer') || is('commandSyntaxPlayers')) {
            response = rustplus.getCommandPlayer(command);
        }
        else if (isExact('commandSyntaxPop')) {
            response = rustplus.getCommandPop();
        }
        else if (is('commandSyntaxProx')) {
            response = client.intlGet(rustplus.guildId, 'commandNotPossibleDiscord');
        }
        else if (is('commandSyntaxRecycle')) {
            response = rustplus.getCommandRecycle(command);
        }
        else if (is('commandSyntaxResearch')) {
            response = rustplus.getCommandResearch(command);
        }
        else if (is('commandSyntaxSend')) {
            response = client.intlGet(rustplus.guildId, 'commandNotPossibleDiscord');
        }
        else if (isExact('commandSyntaxSmall')) {
            response = rustplus.getCommandSmall();
        }
        else if (is('commandSyntaxStack')) {
            response = await rustplus.getCommandStack(command);
        }
        else if (is('commandSyntaxSteamid')) {
            if (isExact('commandSyntaxSteamid')) {
                /* From Discord there is no caller: the name is needed */
                response = client.intlGet(guildId, 'usageName', { cmd: cmdName('commandSyntaxSteamid') });
            }
            else {
                response = await rustplus.getCommandSteamId(command, null, null);
            }
        }
        else if (isExact('commandSyntaxTeam')) {
            response = rustplus.getCommandTeam();
        }
        else if (isExact('commandSyntaxTime')) {
            response = rustplus.getCommandTime();
        }
        else if (is('commandSyntaxTimer') || isExact('commandSyntaxTimers')) {
            response = rustplus.getCommandTimer(command);
        }
        else if (is('commandSyntaxTranslateTo')) {
            response = await rustplus.getCommandTranslateTo(command);
        }
        else if (is('commandSyntaxTranslateFromTo')) {
            response = await rustplus.getCommandTranslateFromTo(command);
        }
        else if (is('commandSyntaxTTS')) {
            response = await rustplus.getCommandTTS(command, callerName);
        }
        else if (isExact('commandSyntaxUnmute')) {
            response = rustplus.getCommandUnmute();
        }
        else if (isExact('commandSyntaxUpkeep')) {
            response = rustplus.getCommandUpkeep();
        }
        else if (isExact('commandSyntaxUptime')) {
            response = rustplus.getCommandUptime();
        }
        else if (isExact('commandSyntaxWipe')) {
            response = rustplus.getCommandWipe();
        }
        else if (isExact('commandSyntaxTravelingVendor')) {
            response = rustplus.getCommandTravelingVendor();
        }
        else if (/^\S+$/.test(prefix) && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(cam|camara|cámara)(\\s|$)`).test(commandLowerCase)) {
            /* Camera test: "!cam BaseControl1" -> what the camera sees (players, range) and a picture */
            const cameraId = command.trim().split(/\s+/)[1];
            if (!cameraId) {
                response = client.intlGet(guildId, 'usageCam', { cmd: `${prefix}cam` });
            }
            else {
                const CameraProbe = require('../util/cameraProbe.js');
                const result = await CameraProbe.probe(rustplus, cameraId);
                const text = CameraProbe.describe(cameraId, result, (id, v) => client.intlGet(guildId, id, v));
                const payload = { content: text };
                if (result.ok && result.image) payload.files = [{ attachment: result.image, name: 'camara.png' }];
                try { await message.channel.send(payload); }
                catch (e) { client.log(client.intlGet(null, 'errorCap'), `Camera test: ${e}`, 'error'); }
            }
        }
        else {
            /* Smart Switches/ Group Switches are not currently supported through discord. */
            return false;
        }

        if (response !== null) {
            await DiscordMessages.sendDiscordCommandResponseMessage(rustplus, client, message, response);
        }

        const guild = DiscordTools.getGuild(message.guild.id);
        const channel = DiscordTools.getTextChannelById(guild.id, message.channelId);
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, `logDiscordCommand`, {
            guild: `${guild.name} (${guild.id})`,
            channel: `${channel.name} (${channel.id})`,
            user: `${message.author.username} (${message.author.id})`,
            message: message.cleanContent
        }));

        return true;
    },
};