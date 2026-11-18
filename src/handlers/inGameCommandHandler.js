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

const SmartAlarmHandler = require('./smartAlarmHandler.js');
const SmartSwitchGroupHandler = require('./smartSwitchGroupHandler.js');
const SmartSwitchHandler = require('./smartSwitchHandler.js');

const MarketHandler = require('./marketHandler.js');
const DeepSeaHandler = require('./deepSeaHandler.js');
const Keywords = require('../util/keywords.js');

/* The game chat does not show emoji: they are removed from the answers of the camera commands */
function stripEmoji(text) {
    return `${text}`.replace(/\*\*/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍]/gu, '')
        .split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(l => l !== '').join(' ');
}

module.exports = {
    stripEmoji: stripEmoji,

    inGameCommandHandler: async function (rustplus, client, message) {
        const guildId = rustplus.guildId;
        const instance = client.getInstance(guildId);
        const prefix = rustplus.generalSettings.prefix;

        let command = message.broadcast.teamMessage.message.message;
        command = Keywords.applyAliases(instance.aliases, prefix, command);
        command = Keywords.normalizeCommand(client, guildId, prefix, `${command}`.trim());

        const callerSteamId = message.broadcast.teamMessage.message.steamId.toString();
        const callerName = message.broadcast.teamMessage.message.name;
        const commandLowerCase = command.toLowerCase();

        /* "!craft" or "!craft ...", but not "!crafty" (that could be a Smart Switch) */
        const syntaxes = (key) => [`${prefix}${client.intlGet('en', key)}`, `${prefix}${client.intlGet(guildId, key)}`];
        const is = (key) => syntaxes(key).some(s => commandLowerCase === s || commandLowerCase.startsWith(`${s} `));
        const isExact = (key) => syntaxes(key).some(s => commandLowerCase === s);

        let reply = null; /* result of the commands below that change state: run them once */
        if (!rustplus.isOperational) {
            return false;
        }
        else if (!rustplus.generalSettings.inGameCommandsEnabled) {
            return false;
        }

        /* The first poll has not filled team/time/map markers/info yet: the commands need them */
        if (!rustplus.team || !rustplus.time || !rustplus.mapMarkers || !rustplus.info) {
            const word = commandLowerCase.startsWith(prefix) ?
                commandLowerCase.slice(prefix.length).split(/\s+/)[0] : null;
            const server = instance.serverList[rustplus.serverId];
            if (word && server && Keywords.getListOfUsedKeywords(client, guildId, rustplus.serverId).includes(word)) {
                /* The normal chat queue needs the team: sent directly */
                const trademark = rustplus.generalSettings.trademark;
                const trademarkString = (trademark === 'NOT SHOWING') ? '' : `${trademark} | `;
                try {
                    await rustplus.sendTeamMessageAsync(`${trademarkString}${client.intlGet(guildId, 'commandStillLoading')}`);
                }
                catch (e) { /* nothing more can be done */ }
                return true;
            }
            return false;
        }

        if (isExact('commandSyntaxAfk')) {
            rustplus.sendInGameMessage(rustplus.getCommandAfk());
        }
        else if (is('commandSyntaxAlive')) {
            rustplus.sendInGameMessage(rustplus.getCommandAlive(command));
        }
        else if (isExact('commandSyntaxCargo')) {
            rustplus.sendInGameMessage(rustplus.getCommandCargo());
        }
        else if (isExact('commandSyntaxChinook')) {
            rustplus.sendInGameMessage(rustplus.getCommandChinook());
        }
        else if (is('commandSyntaxConnection') || is('commandSyntaxConnections')) {
            rustplus.sendInGameMessage(rustplus.getCommandConnection(command));
        }
        else if (is('commandSyntaxCraft')) {
            rustplus.sendInGameMessage(rustplus.getCommandCraft(command));
        }
        else if (is('commandSyntaxDeath') || is('commandSyntaxDeaths')) {
            rustplus.sendInGameMessage(await rustplus.getCommandDeath(command, callerSteamId));
        }
        else if (is('commandSyntaxDecay')) {
            rustplus.sendInGameMessage(rustplus.getCommandDecay(command));
        }
        else if (is('commandSyntaxDespawn')) {
            rustplus.sendInGameMessage(rustplus.getCommandDespawn(command));
        }
        else if (is('commandSyntaxEvents')) {
            rustplus.sendInGameMessage(rustplus.getCommandEvents(command));
        }
        else if (isExact('commandSyntaxHeli')) {
            rustplus.sendInGameMessage(rustplus.getCommandHeli());
        }
        else if (is('commandSyntaxBase')) {
            rustplus.sendInGameMessage(rustplus.getCommandBase(command, callerSteamId));
        }
        else if (isExact('commandSyntaxBradley')) {
            rustplus.sendInGameMessage(rustplus.getCommandBradley());
        }
        else if (isExact('commandSyntaxCrate')) {
            rustplus.sendInGameMessage(rustplus.getCommandCrate());
        }
        else if (isExact('commandSyntaxLarge')) {
            rustplus.sendInGameMessage(rustplus.getCommandLarge());
        }
        else if (is('commandSyntaxLeader')) {
            rustplus.sendInGameMessage(await rustplus.getCommandLeader(command, callerSteamId));
        }
        else if (is('commandSyntaxMarker') || isExact('commandSyntaxMarkers')) {
            rustplus.sendInGameMessage(await rustplus.getCommandMarker(command, callerSteamId));
        }
        else if ((reply = DeepSeaHandler.command(rustplus, client, command)) !== null) {
            rustplus.sendInGameMessage(reply);
        }
        else if ((reply = require('./cameraWatchHandler.js').command(rustplus, client, command)) !== null) {
            rustplus.sendInGameMessage(stripEmoji(reply));
        }
        else if ((reply = MarketHandler.getCommandFind(rustplus, client, command)) !== null) {
            rustplus.sendInGameMessage(reply);
        }
        else if (is('commandSyntaxMarket')) {
            rustplus.sendInGameMessage(rustplus.getCommandMarket(command));
        }
        else if (isExact('commandSyntaxMute')) {
            /* The answer first: once muted, nothing is said in the game */
            rustplus.sendInGameMessage(client.intlGet(guildId, 'inGameBotMessagesMuted'));
            rustplus.getCommandMute();
        }
        else if (is('commandSyntaxNote') || isExact('commandSyntaxNotes')) {
            rustplus.sendInGameMessage(rustplus.getCommandNote(command));
        }
        else if (isExact('commandSyntaxOffline')) {
            rustplus.sendInGameMessage(rustplus.getCommandOffline());
        }
        else if (isExact('commandSyntaxOnline')) {
            rustplus.sendInGameMessage(rustplus.getCommandOnline());
        }
        else if (is('commandSyntaxPlayer') || is('commandSyntaxPlayers')) {
            rustplus.sendInGameMessage(rustplus.getCommandPlayer(command));
        }
        else if (isExact('commandSyntaxPop')) {
            rustplus.sendInGameMessage(rustplus.getCommandPop());
        }
        else if (is('commandSyntaxProx')) {
            rustplus.sendInGameMessage(await rustplus.getCommandProx(command, callerSteamId));
        }
        else if (is('commandSyntaxRecycle')) {
            rustplus.sendInGameMessage(rustplus.getCommandRecycle(command));
        }
        else if (is('commandSyntaxResearch')) {
            rustplus.sendInGameMessage(rustplus.getCommandResearch(command));
        }
        else if (is('commandSyntaxSend')) {
            rustplus.sendInGameMessage(await rustplus.getCommandSend(command, callerName));
        }
        else if (isExact('commandSyntaxSmall')) {
            rustplus.sendInGameMessage(rustplus.getCommandSmall());
        }
        else if (is('commandSyntaxStack')) {
            rustplus.sendInGameMessage(await rustplus.getCommandStack(command));
        }
        else if (is('commandSyntaxSteamid')) {
            rustplus.sendInGameMessage(await rustplus.getCommandSteamId(command, callerSteamId, callerName));
        }
        else if (isExact('commandSyntaxTeam')) {
            rustplus.sendInGameMessage(rustplus.getCommandTeam());
        }
        else if (isExact('commandSyntaxTime')) {
            rustplus.sendInGameMessage(rustplus.getCommandTime());
        }
        else if (is('commandSyntaxTimer') || isExact('commandSyntaxTimers')) {
            rustplus.sendInGameMessage(rustplus.getCommandTimer(command));
        }
        else if (is('commandSyntaxTranslateTo')) {
            rustplus.sendInGameMessage(await rustplus.getCommandTranslateTo(command));
        }
        else if (is('commandSyntaxTranslateFromTo')) {
            rustplus.sendInGameMessage(await rustplus.getCommandTranslateFromTo(command));
        }
        else if (is('commandSyntaxTTS')) {
            rustplus.sendInGameMessage(await rustplus.getCommandTTS(command, callerName));
        }
        else if (isExact('commandSyntaxUnmute')) {
            rustplus.sendInGameMessage(rustplus.getCommandUnmute());
        }
        else if (isExact('commandSyntaxUpkeep')) {
            rustplus.sendInGameMessage(rustplus.getCommandUpkeep());
        }
        else if (isExact('commandSyntaxUptime')) {
            rustplus.sendInGameMessage(rustplus.getCommandUptime());
        }
        else if (isExact('commandSyntaxWipe')) {
            rustplus.sendInGameMessage(rustplus.getCommandWipe());
        }
        else if (isExact('commandSyntaxTravelingVendor')) {
            rustplus.sendInGameMessage(rustplus.getCommandTravelingVendor());
        }
        else if (new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(cam|camara|cámara)(\\s|$)`).test(commandLowerCase)) {
            /* Camera test: the summary in the game, and the picture in the Discord team chat channel */
            const cameraId = command.trim().split(/\s+/)[1];
            if (!cameraId) {
                rustplus.sendInGameMessage(client.intlGet(guildId, 'usageCam', { cmd: `${prefix}cam` }));
            }
            else {
                const CameraProbe = require('./../util/cameraProbe.js');
                const result = await CameraProbe.probe(rustplus, cameraId);
                const text = CameraProbe.describe(cameraId, result, (id, v) => client.intlGet(guildId, id, v));
                rustplus.sendInGameMessage(stripEmoji(text));
                const channelId = client.getInstance(guildId).channelId.teamchat;
                const channel = channelId ? require('../discordTools/discordTools.js').getTextChannelById(guildId, channelId) : null;
                if (channel) {
                    const payload = { content: text };
                    if (result.ok && result.image) payload.files = [{ attachment: result.image, name: 'camara.png' }];
                    try { await channel.send(payload); }
                    catch (e) { client.log(client.intlGet(null, 'errorCap'), `Camera test: ${e}`, 'error'); }
                }
            }
        }
        else {
            /* Maybe a custom command? */

            if (SmartAlarmHandler.smartAlarmCommandHandler(rustplus, client, command)) {
                rustplus.logInGameCommand('Smart Alarm', message);
                return true;
            }

            if (await SmartSwitchHandler.smartSwitchCommandHandler(rustplus, client, command, callerSteamId)) {
                rustplus.logInGameCommand('Smart Switch', message);
                return true;
            }

            if (await SmartSwitchGroupHandler.smartSwitchGroupCommandHandler(rustplus, client, command)) {
                rustplus.logInGameCommand('Smart Switch Group', message);
                return true;
            }

            return false;
        }

        rustplus.logInGameCommand('Default', message);

        return true;
    },
};
