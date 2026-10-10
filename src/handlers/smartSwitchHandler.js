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
const SwitchOverride = require('../util/switchOverride.js');
const Map = require('../util/map.js');
const Proximity = require('../util/proximity.js');
const SmartSwitchGroupHandler = require('./smartSwitchGroupHandler.js');
const Timer = require('../util/timer');

function warnUnknownPositions(rustplus, client, content, state) {
    if (state.unknown.length === 0 || rustplus.proximityUnknownWarned) return;
    rustplus.proximityUnknownWarned = true;
    rustplus.log(client.intlGet(null, 'warningCap'), `Proximity: ${content.name}: ` +
        `${Proximity.describe(client, null, content, state)} Counted as near (safe side).`, 'warning');
}

module.exports = {
    handler: async function (rustplus, client, time) {
        const instance = client.getInstance(rustplus.guildId);
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;

        if (!instance.serverList.hasOwnProperty(serverId)) return;

        if (rustplus.smartSwitchIntervalCounter === 29) {
            rustplus.smartSwitchIntervalCounter = 0;
        }
        else {
            rustplus.smartSwitchIntervalCounter += 1;
        }

        /* Go through all Smart Switches and see if some of them do not answer on request. */
        const changedSwitches = [];
        if (rustplus.smartSwitchIntervalCounter === 0) {
            for (const entityId in instance.serverList[serverId].switches) {
                const info = await rustplus.getEntityInfoAsync(entityId);
                if (!(await rustplus.isResponseValid(info))) {
                    if (instance.serverList[serverId].switches[entityId].reachable) {
                        await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        instance.serverList[serverId].switches[entityId].reachable = false;
                        client.setInstance(guildId, instance);

                        await DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                        changedSwitches.push(entityId);
                    }
                }
                else {
                    const sw = instance.serverList[serverId].switches[entityId];
                    /* What the switch really is (a failed or missed change must not stay wrong) */
                    const real = info.entityInfo && info.entityInfo.payload ? info.entityInfo.payload.value : undefined;
                    const realChanged = typeof real === 'boolean' && sw.active !== real;
                    if (!sw.reachable || realChanged) {
                        sw.reachable = true;
                        if (realChanged) sw.active = real;
                        client.setInstance(guildId, instance);

                        await DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                        changedSwitches.push(entityId);
                    }
                }
            }
        }

        /* Go through all Smart Switches and see if the auto day/night setting is on and if it just became day/night */
        if (rustplus.time.isTurnedDay(time)) {
            for (const [entityId, content] of Object.entries(instance.serverList[serverId].switches)) {
                /* Held on by an alarm action: automatic modes must not change it */
                if ((content.holdUntil && Date.now() < content.holdUntil) || content.raidLock) continue;
                if (content.autoDayNightOnOff === 1) {
                    instance.serverList[serverId].switches[entityId].active = true;
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchOnAsync(entityId);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = false;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
                else if (content.autoDayNightOnOff === 2) {
                    instance.serverList[serverId].switches[entityId].active = false;
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchOffAsync(entityId);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = true;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
        }
        else if (rustplus.time.isTurnedNight(time)) {
            for (const [entityId, content] of Object.entries(instance.serverList[serverId].switches)) {
                /* Held on by an alarm action: automatic modes must not change it */
                if ((content.holdUntil && Date.now() < content.holdUntil) || content.raidLock) continue;
                if (content.autoDayNightOnOff === 1) {
                    instance.serverList[serverId].switches[entityId].active = false;
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchOffAsync(entityId);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = true;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
                else if (content.autoDayNightOnOff === 2) {
                    instance.serverList[serverId].switches[entityId].active = true;
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchOnAsync(entityId);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = false;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
        }

        for (const [entityId, content] of Object.entries(instance.serverList[serverId].switches)) {
            /* Held on by an alarm action: automatic modes must not change it */
            if ((content.holdUntil && Date.now() < content.holdUntil) || content.raidLock) continue;
            /* Not answering: the check every 5 minutes marks it reachable again, then it is set */
            if (content.reachable === false) continue;
            if (content.autoDayNightOnOff === 3) { /* ALWAYS ON: what the Discord menu says */
                /* An order by hand (command / Discord button) prevails until its time is up or VOLVER A AUTOMÁTICO */
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, true)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused) {
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }
                if (content.active) continue;
                rustplus.log(client.intlGet(null, 'infoCap'), `Always ON: ${content.name} (${content.command}) -> ON.`);

                instance.serverList[serverId].switches[entityId].active = true;
                client.setInstance(guildId, instance);

                rustplus.interactionSwitches.push(entityId);

                const response = await rustplus.turnSmartSwitchOnAsync(entityId);
                if (!(await rustplus.isResponseValid(response))) {
                    /* Not turned: keep what the switch really is, so it is tried again */
                    instance.serverList[serverId].switches[entityId].active = false;
                    if (instance.serverList[serverId].switches[entityId].reachable) {
                        await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                    }
                    instance.serverList[serverId].switches[entityId].reachable = false;

                    rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                }
                else {
                    instance.serverList[serverId].switches[entityId].reachable = true;
                }
                client.setInstance(guildId, instance);

                DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                changedSwitches.push(entityId);
            }
            else if (content.autoDayNightOnOff === 4) { /* ALWAYS OFF: what the Discord menu says */
                /* An order by hand (command / Discord button) prevails until its time is up or VOLVER A AUTOMÁTICO */
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, false)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused) {
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }
                if (!content.active) continue;
                rustplus.log(client.intlGet(null, 'infoCap'), `Always OFF: ${content.name} (${content.command}) -> OFF.`);

                instance.serverList[serverId].switches[entityId].active = false;
                client.setInstance(guildId, instance);

                rustplus.interactionSwitches.push(entityId);

                const response = await rustplus.turnSmartSwitchOffAsync(entityId);
                if (!(await rustplus.isResponseValid(response))) {
                    /* Not turned: keep what the switch really is, so it is tried again */
                    instance.serverList[serverId].switches[entityId].active = true;
                    if (instance.serverList[serverId].switches[entityId].reachable) {
                        await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                    }
                    instance.serverList[serverId].switches[entityId].reachable = false;

                    rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                }
                else {
                    instance.serverList[serverId].switches[entityId].reachable = true;
                }
                client.setInstance(guildId, instance);

                DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                changedSwitches.push(entityId);
            }
            else if (content.autoDayNightOnOff === 5 && content.location !== null) { /* AUTO-ON-PROXIMITY */
                const state = Proximity.decide(rustplus, entityId, content);
                const shouldBeOn = state.decidedNear;
                warnUnknownPositions(rustplus, client, content, state);
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, shouldBeOn)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused && content.active === shouldBeOn) {
                    /* Back to automatic without changing the switch: remove the "paused" notice */
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }

                if ((shouldBeOn && !content.active) || (!shouldBeOn && content.active)) {
                    instance.serverList[serverId].switches[entityId].active = shouldBeOn;
                    rustplus.log(client.intlGet(null, 'infoCap'), `Proximity: ${content.name} (${content.command}) -> ` +
                        `${shouldBeOn ? 'ON' : 'OFF'}. ${Proximity.describe(client, null, content, state)}`);
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchAsync(entityId, shouldBeOn);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = !shouldBeOn;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
            else if (content.autoDayNightOnOff === 6 && content.location !== null) { /* AUTO-OFF-PROXIMITY */
                const state = Proximity.decide(rustplus, entityId, content);
                const shouldBeOn = !state.decidedNear;
                warnUnknownPositions(rustplus, client, content, state);
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, shouldBeOn)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused && content.active === shouldBeOn) {
                    /* Back to automatic without changing the switch: remove the "paused" notice */
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }

                if ((shouldBeOn && !content.active) || (!shouldBeOn && content.active)) {
                    instance.serverList[serverId].switches[entityId].active = shouldBeOn;
                    rustplus.log(client.intlGet(null, 'infoCap'), `Proximity: ${content.name} (${content.command}) -> ` +
                        `${shouldBeOn ? 'ON' : 'OFF'}. ${Proximity.describe(client, null, content, state)}`);
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchAsync(entityId, shouldBeOn);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = !shouldBeOn;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
            else if (content.autoDayNightOnOff === 7) { /* AUTO-ON-ANY-ONLINE */
                const onlineState = Proximity.decideOnline(rustplus, entityId);
                const shouldBeOn = onlineState.decidedOnline;
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, shouldBeOn)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused && content.active === shouldBeOn) {
                    /* Back to automatic without changing the switch: remove the "paused" notice */
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }

                if ((shouldBeOn && !content.active) || (!shouldBeOn && content.active)) {
                    instance.serverList[serverId].switches[entityId].active = shouldBeOn;
                    rustplus.log(client.intlGet(null, 'infoCap'), `Any online: ${content.name} (${content.command}) -> ` +
                        `${shouldBeOn ? 'ON' : 'OFF'}. Online: ${onlineState.online.join(', ') || 'nobody'}.`);
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchAsync(entityId, shouldBeOn);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = !shouldBeOn;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
            else if (content.autoDayNightOnOff === 8) { /* AUTO-OFF-ANY-ONLINE */
                const onlineState = Proximity.decideOnline(rustplus, entityId);
                const shouldBeOn = !onlineState.decidedOnline;
                const wasPaused = SwitchOverride.isPaused(content);
                if (SwitchOverride.respectManual(content, shouldBeOn)) {
                    client.setInstance(guildId, instance);
                    continue;
                }
                if (wasPaused && content.active === shouldBeOn) {
                    /* Back to automatic without changing the switch: remove the "paused" notice */
                    client.setInstance(guildId, instance);
                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                }

                if ((shouldBeOn && !content.active) || (!shouldBeOn && content.active)) {
                    instance.serverList[serverId].switches[entityId].active = shouldBeOn;
                    rustplus.log(client.intlGet(null, 'infoCap'), `Any online: ${content.name} (${content.command}) -> ` +
                        `${shouldBeOn ? 'ON' : 'OFF'}. Online: ${onlineState.online.join(', ') || 'nobody'}.`);
                    client.setInstance(guildId, instance);

                    rustplus.interactionSwitches.push(entityId);

                    const response = await rustplus.turnSmartSwitchAsync(entityId, shouldBeOn);
                    if (!(await rustplus.isResponseValid(response))) {
                        /* Not turned: keep what the switch really is, so it is tried again */
                        instance.serverList[serverId].switches[entityId].active = !shouldBeOn;
                        if (instance.serverList[serverId].switches[entityId].reachable) {
                            await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
                        }
                        instance.serverList[serverId].switches[entityId].reachable = false;

                        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
                    }
                    else {
                        instance.serverList[serverId].switches[entityId].reachable = true;
                    }
                    client.setInstance(guildId, instance);

                    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                    changedSwitches.push(entityId);
                }
            }
        }

        let groupsId = SmartSwitchGroupHandler.getGroupsFromSwitchList(
            client, guildId, serverId, changedSwitches);

        for (let groupId of groupsId) {
            await DiscordMessages.sendSmartSwitchGroupMessage(guildId, serverId, groupId);
        }
    },

    smartSwitchCommandHandler: async function (rustplus, client, command, callerSteamId = null) {
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;
        const instance = client.getInstance(guildId);
        const switches = instance.serverList[serverId].switches;
        const prefix = rustplus.generalSettings.prefix;

        const onCap = client.intlGet(guildId, 'onCap');
        const offCap = client.intlGet(guildId, 'offCap');

        const onEn = client.intlGet('en', 'commandSyntaxOn');
        const onLang = client.intlGet(guildId, 'commandSyntaxOn');
        const offEn = client.intlGet('en', 'commandSyntaxOff');
        const offLang = client.intlGet(guildId, 'commandSyntaxOff');
        const statusEn = client.intlGet('en', 'commandSyntaxStatus');
        const statusLang = client.intlGet(guildId, 'commandSyntaxStatus');

        /* Upper or lower case does not matter: "!SAM off" = "!sam off" */
        const lower = command.toLowerCase();
        const entityId = Object.keys(switches).find(e => {
            const c = `${prefix}${switches[e].command}`.toLowerCase();
            return lower === c || lower.startsWith(`${c} `);
        });

        if (!entityId) return false;
        command = `${prefix}${switches[entityId].command}${command.slice(`${prefix}${switches[entityId].command}`.length)}`;

        const entityCommand = `${prefix}${switches[entityId].command}`;
        /* Also understood: "encender/encendido/apagar/apagado" (and any case), e.g. "!sam encendido 2m" */
        const words = command.slice(entityCommand.length).trim().split(/\s+/);
        const word = (words[0] || '').toLowerCase();
        if (words[0]) words[0] = word;
        if ([onEn, onLang, 'on', 'encender', 'encendido'].includes(word)) words[0] = onEn;
        else if ([offEn, offLang, 'off', 'apagar', 'apagado'].includes(word)) words[0] = offEn;
        command = `${entityCommand} ${words.join(' ')}`.trim();

        /* "!sam aquí": the switch is where I am now (the proximity modes measure from this point) */
        if (['aquí', 'aqui', 'here'].includes(word)) {
            const caller = callerSteamId && rustplus.team ? rustplus.team.getPlayer(callerSteamId) : null;
            if (!caller || !caller.isAlive || !Proximity.hasPosition(caller)) {
                rustplus.sendInGameMessage(client.intlGet(guildId, 'proximityHereNoPosition'));
                return true;
            }
            const pos = Map.getPos(caller.x, caller.y, rustplus.info.correctedMapSize, rustplus);
            switches[entityId].x = caller.x;
            switches[entityId].y = caller.y;
            switches[entityId].location = pos.location;
            if (rustplus.proximityAwaySince) delete rustplus.proximityAwaySince[entityId];
            client.setInstance(guildId, instance);
            DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
            rustplus.sendInGameMessage(client.intlGet(guildId, 'proximityHereSaved', {
                device: switches[entityId].name, location: pos.location, proximity: switches[entityId].proximity
            }));
            return true;
        }

        /* An unknown word must not switch anything (before, "!sam xyz" toggled it) */
        const knownWords = [onEn, onLang, offEn, offLang, statusEn, statusLang];
        if (words[0] && !knownWords.includes(words[0]) &&
            Timer.getSecondsFromStringTime(words.join(' ')) === null) {
            rustplus.sendInGameMessage(client.intlGet(guildId, 'smartSwitchCommandUsage', { command: entityCommand }));
            return true;
        }

        let rest = command.replace(`${entityCommand} ${onEn}`, '');
        rest = rest.replace(`${entityCommand} ${onLang}`, '');
        rest = rest.replace(`${entityCommand} ${offEn}`, '');
        rest = rest.replace(`${entityCommand} ${offLang}`, '');
        rest = rest.replace(`${entityCommand}`, '').trim();

        let active;
        if (command.startsWith(`${entityCommand} ${onEn}`) || command.startsWith(`${entityCommand} ${onLang}`)) {
            if (!switches[entityId].active) {
                active = true;
            }
            else {
                const str = client.intlGet(guildId, 'deviceIsAlreadyOnOff', {
                    device: switches[entityId].name,
                    status: onCap
                });
                rustplus.sendInGameMessage(str);
                return true;
            }
        }
        else if (command.startsWith(`${entityCommand} ${offEn}`) || command.startsWith(`${entityCommand} ${offLang}`)) {
            if (switches[entityId].active) {
                active = false;
            }
            else {
                const str = client.intlGet(guildId, 'deviceIsAlreadyOnOff', {
                    device: switches[entityId].name,
                    status: offCap
                });
                rustplus.sendInGameMessage(str);
                return true;
            }
        }
        else if (command === `${entityCommand} ${statusEn}` || command === `${entityCommand} ${statusLang}`) {
            const info = await rustplus.getEntityInfoAsync(entityId);
            if (!(await rustplus.isResponseValid(info))) {
                switches[entityId].reachable = false;
                client.setInstance(guildId, instance);
                DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, serverId, entityId);

                rustplus.sendInGameMessage(client.intlGet(guildId, 'noCommunicationSmartSwitch', {
                    name: switches[entityId].name
                }));
                return true;
            }

            rustplus.sendInGameMessage(client.intlGet(guildId, 'deviceIsCurrentlyOnOff', {
                device: switches[entityId].name,
                status: info.entityInfo.payload.value ? onCap : offCap
            }));
            const sw = switches[entityId];
            if ([5, 6].includes(sw.autoDayNightOnOff)) {
                if (sw.location === null || sw.x === null) {
                    rustplus.sendInGameMessage(client.intlGet(guildId, 'proximityNoLocation', { command: entityCommand }));
                }
                else {
                    const state = Proximity.check(rustplus, sw);
                    rustplus.sendInGameMessage(client.intlGet(guildId, 'proximityStatus', {
                        location: sw.location, details: Proximity.describe(client, guildId, sw, state)
                    }));
                }
            }
            return true;
        }
        else if (command.startsWith(`${entityCommand}`)) {
            active = !switches[entityId].active;
        }
        else {
            return true;
        }

        if (rustplus.currentSwitchTimeouts.hasOwnProperty(entityId)) {
            clearTimeout(rustplus.currentSwitchTimeouts[entityId]);
            delete rustplus.currentSwitchTimeouts[entityId];
        }

        const timeSeconds = Timer.getSecondsFromStringTime(rest);

        rustplus.log(client.intlGet(null, 'infoCap'), client.intlGet(null, `logSmartSwitchValueChange`, {
            value: active
        }));

        module.exports.smartSwitchCommandTurnOnOff(rustplus, client, entityId, active);

        if (!switches[entityId].reachable) return true;

        let str = client.intlGet(guildId, 'deviceWasTurnedOnOff', {
            device: switches[entityId].name,
            status: active ? onCap : offCap
        });

        if (timeSeconds === null) {
            rustplus.sendInGameMessage(str);
            return true;
        }

        const time = Timer.secondsToFullScale(timeSeconds);
        /* With an automatic mode (proximity / online), when the time is up the mode decides again */
        const backToAuto = SwitchOverride.OVERRIDABLE_MODES.includes(switches[entityId].autoDayNightOnOff);
        str += backToAuto ?
            client.intlGet(guildId, 'switchBackToAutoIn', { time: time }) :
            client.intlGet(guildId, 'automaticallyTurnBackOnOff', {
                status: active ? offCap : onCap,
                time: time
            });

        rustplus.currentSwitchTimeouts[entityId] = setTimeout(async function () {
            const instance = client.getInstance(guildId);
            if (!instance.serverList[serverId].switches.hasOwnProperty(entityId)) return;
            delete rustplus.currentSwitchTimeouts[entityId];
            /* A raid took it over meanwhile: the raid decides now */
            if (instance.serverList[serverId].switches[entityId].raidLock) return;

            if (SwitchOverride.OVERRIDABLE_MODES.includes(instance.serverList[serverId].switches[entityId].autoDayNightOnOff)) {
                SwitchOverride.clear(instance.serverList[serverId].switches[entityId], false);
                client.setInstance(guildId, instance);
                DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
                rustplus.sendInGameMessage(client.intlGet(guildId, 'switchBackToAuto', {
                    device: instance.serverList[serverId].switches[entityId].name
                }));
                return;
            }

            await module.exports.smartSwitchCommandTurnOnOff(rustplus, client, entityId, !active, false);

            const str = client.intlGet(guildId, 'automaticallyTurningBackOnOff', {
                device: instance.serverList[serverId].switches[entityId].name,
                status: !active ? onCap : offCap
            });

            rustplus.sendInGameMessage(str);
        }, timeSeconds * 1000);

        rustplus.sendInGameMessage(str);
        return true;
    },

    smartSwitchCommandTurnOnOff: async function (rustplus, client, entityId, active, byPerson = true) {
        const guildId = rustplus.guildId;
        const serverId = rustplus.serverId;
        const instance = client.getInstance(guildId);
        const switches = instance.serverList[serverId].switches;

        const prevActive = switches[entityId].active;
        switches[entityId].active = active;
        delete switches[entityId].raidLock;     /* an order: the raid lock ends */
        SwitchOverride.setManual(switches[entityId], active, byPerson);
        client.setInstance(guildId, instance);

        rustplus.interactionSwitches.push(entityId);

        const response = await rustplus.turnSmartSwitchAsync(entityId, active);
        if (!(await rustplus.isResponseValid(response))) {
            rustplus.sendInGameMessage(client.intlGet(guildId, 'noCommunicationSmartSwitch', {
                name: switches[entityId].name
            }));
            if (switches[entityId].reachable) {
                await DiscordMessages.sendSmartSwitchNotFoundMessage(guildId, serverId, entityId);
            }
            switches[entityId].reachable = false;
            switches[entityId].active = prevActive;

            rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
        }
        else {
            switches[entityId].reachable = true;
        }
        client.setInstance(guildId, instance);

        DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
        SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, serverId, entityId);
    },
}