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

/*
 *  Raid incidents: groups Smart Alarm triggers into a single Discord message.
 *  - First trigger: one pinned message with @everyone and an "I'm on it" button (the only one).
 *  - Further triggers only update that message (counter, last trigger), throttled.
 *  - While the raid lasts and nobody pressed the button: every N minutes (2) the same reminder is
 *    posted again with @everyone (the previous one is deleted, so there is only ever one).
 *    It stops when someone presses the button, the raid ends or the alarm stops responding.
 *  - After M minutes without triggers the raid is considered over and a summary is posted.
 *  - Alarm actions: switches / switch groups turned on when the alarm triggers, with a hold
 *    time during which automatic switch modes do not turn them off.
 */

const Discord = require('discord.js');

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const SmartSwitchGroupHandler = require('./smartSwitchGroupHandler.js');
const { resolveActionTargets, describeActionTargets } = require('../util/raidTargets.js');
const Timer = require('../util/timer');
const SwitchOverride = require('../util/switchOverride.js');
const SwitchTimers = require('../util/switchTimers.js');

const TICK_MS = 5 * 1000;
const ACTION_INTERVAL_MS = 30 * 1000;
const PENDING_RETRY_MS = 15 * 1000;

const incidents = new Object();
const pendingActions = new Object();   /* guildId -> entityId -> { serverId, value, effect, at, triedAt } */

function settings() {
    return {
        reminderMs: Config.raid.reminderMinutes * 60 * 1000,
        quietMs: Config.raid.quietMinutes * 60 * 1000,
        editThrottleMs: Config.raid.editThrottleSeconds * 1000
    };
}

/* ------------------------------------------------------------------------- */
/* Alarm actions                                                              */
/* ------------------------------------------------------------------------- */

async function runAlarmActions(client, rustplus, guildId, serverId, alarm, now = Date.now()) {
    if (!alarm.actions) return;
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    if (!server) return;

    const holdUntil = now + (alarm.actions.holdMinutes || Config.raid.defaultHoldMinutes) * 60 * 1000;
    const members = (groupIds) => {
        const ids = [];
        for (const groupId of groupIds || []) {
            if (!server.switchGroups[groupId]) continue;
            for (const entityId of server.switchGroups[groupId].switches) ids.push(`${entityId}`);
        }
        return ids;
    };
    const onIds = [...new Set([...(alarm.actions.switches || []).map(e => `${e}`), ...members(alarm.actions.groups)])]
        .filter(e => !isOrdered(client, guildId, serverId, e));
    const offIds = [...new Set([...(alarm.actions.offSwitches || []).map(e => `${e}`),
        ...members(alarm.actions.offGroups)])].filter(e => !isOrdered(client, guildId, serverId, e));

    /* A timed command still pending (e.g. "!sammode off 10m") must not undo the raid when its time is up */
    const touched = new Set([...onIds, ...offIds]);
    const timers = SwitchTimers.forGuild(client, guildId);
    for (const key of Object.keys(timers)) {
        const group = server.switchGroups[key];
        if (!touched.has(`${key}`) && !(group && group.switches.some(e => touched.has(`${e}`)))) continue;
        SwitchTimers.clear(client, guildId, key);
    }

    /* raidLock (turned off by the alarm, e.g. the SAM to attack mode: stays like that until someone gives
       an order) and holdUntil (held on: automatic modes leave it alone for a while) are only set when the
       switch really changed. Not connected / no answer: remembered and done when possible. */
    for (const entityId of offIds) {
        await setSwitch(client, rustplus, guildId, serverId, entityId, false, { raidLock: true }, now);
    }
    for (const entityId of onIds) {
        await setSwitch(client, rustplus, guildId, serverId, entityId, true, { holdUntil: holdUntil }, now);
    }
}

/* Someone gave an order to the switch during this raid (command, button, VOLVER A AUTOMÁTICO...):
   the alarm triggers of the same raid do not take it back */
function isOrdered(client, guildId, serverId, entityId) {
    const server = client.getInstance(guildId).serverList[serverId];
    const sw = server ? server.switches[entityId] : null;
    const incident = incidents[guildId];
    return !sw || !!(incident && !incident.endedAt && sw.orderAt && sw.orderAt > incident.startedAt);
}

function usableRustplus(client, rustplus, guildId, serverId) {
    if (rustplus && !rustplus.isDeleted && rustplus.isOperational !== false && rustplus.serverId === serverId) {
        return rustplus;
    }
    return SwitchTimers.liveRustplus(client, guildId, serverId);
}

/* What the alarm did to the switch once it really changed */
function applyEffect(sw, effect) {
    if (effect.raidLock) {
        sw.raidLock = true;
        delete sw.manualOverride;
    }
    if (effect.holdUntil) sw.holdUntil = Math.max(sw.holdUntil || 0, effect.holdUntil);
}

function queuePending(guildId, serverId, entityId, value, effect, now) {
    if (!pendingActions[guildId]) pendingActions[guildId] = {};
    pendingActions[guildId][`${entityId}`] = { serverId: serverId, value: value, effect: effect, at: now, triedAt: 0 };
}

/* Turns one switch on/off for an alarm (the bot's own change, not a person's).
   Returns true when done (or already like that). */
async function setSwitch(client, rustplus, guildId, serverId, entityId, value, effect = {}, now = Date.now()) {
    const instance = client.getInstance(guildId);
    const sw = instance.serverList[serverId] ? instance.serverList[serverId].switches[entityId] : null;
    if (!sw) return false;

    rustplus = usableRustplus(client, rustplus, guildId, serverId);
    if (!rustplus) {
        queuePending(guildId, serverId, entityId, value, effect, now);
        return false;
    }
    if (pendingActions[guildId]) delete pendingActions[guildId][`${entityId}`];

    if (sw.active === value) {
        applyEffect(sw, effect);
        client.setInstance(guildId, instance);
        DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
        return true;
    }
    const prevActive = sw.active;
    sw.active = value;
    client.setInstance(guildId, instance);
    /* The echo of this change is the bot's, even if it comes after a Rust+ timeout */
    SwitchOverride.markBotChange(rustplus, entityId, value, Object.keys(effect).length > 0 ? effect : null);
    rustplus.interactionSwitches.push(entityId);
    const response = await rustplus.turnSmartSwitchAsync(entityId, value);
    const fresh = client.getInstance(guildId).serverList[serverId];
    const now2 = fresh ? fresh.switches[entityId] : null;
    if (!now2) return false;
    let done = false;
    if (!(await rustplus.isResponseValid(response))) {
        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
        const echoed = !(rustplus.botSwitchChanges && rustplus.botSwitchChanges[`${entityId}`]);
        if (!echoed) {
            /* No late echo meanwhile: not changed (yet). The mark stays (a late echo still confirms it,
               see message.js), and it is tried again later. */
            now2.active = prevActive;
            now2.reachable = false;
            queuePending(guildId, serverId, entityId, value, effect, now);
            pendingActions[guildId][`${entityId}`].triedAt = Date.now();
        }
        else done = true;     /* the echo came: it did change (the effect was set by message.js) */
    }
    else {
        SwitchOverride.clearBotChangeConfirm(rustplus, entityId);
        now2.reachable = true;
        done = true;
    }
    if (done) applyEffect(now2, effect);
    client.setInstance(guildId, client.getInstance(guildId));
    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
    await SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, serverId, entityId);
    return done;
}

/* Alarm actions that could not be done (not connected, no answer): done when possible, while the raid
   lasts and nobody gave the switch an order since */
async function runPendingActions(client, guildId, now = Date.now()) {
    const pending = pendingActions[guildId];
    if (!pending || Object.keys(pending).length === 0) return;
    const incident = incidents[guildId];
    for (const [entityId, p] of Object.entries(pending)) {
        if (!incident || incident.endedAt || incident.serverId !== p.serverId) {
            delete pending[entityId];
            client.log(client.intlGet(null, 'warningCap'),
                `Raid alarm action on switch ${entityId} not done: the raid is over.`, 'warning');
            continue;
        }
        if (isOrdered(client, guildId, p.serverId, entityId)) {
            delete pending[entityId];
            continue;
        }
        if (now - (p.triedAt || 0) < PENDING_RETRY_MS) continue;
        const rustplus = SwitchTimers.liveRustplus(client, guildId, p.serverId);
        if (!rustplus) continue;
        p.triedAt = now;
        try {
            await setSwitch(client, rustplus, guildId, p.serverId, entityId, p.value, p.effect, p.at);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Alarm action failed: ${e}`, 'error');
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Incident message                                                           */
/* ------------------------------------------------------------------------- */

function getIncidentEmbed(client, guildId, incident, now = Date.now()) {
    const s = settings();
    const t = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
    const alarms = Object.values(incident.alarms).map(a => `${a.name} (${a.count})`).join(', ');

    let title, color;
    let description = '';
    if (incident.endedAt) {
        title = client.intlGet(guildId, 'raidEndedTitle');
        color = Constants.COLOR_GREY;
        description += client.intlGet(guildId, 'raidEndedDesc', {
            duration: Timer.secondsToFullScale((incident.lastTriggerAt - incident.startedAt) / 1000) || '0s',
            count: incident.count
        });
        if (incident.alarmsLost) description += `\n${client.intlGet(guildId, 'raidAlarmsLost')}`;
        /* Switches the alarm turned off stay like that until someone says so: remind it */
        const server = client.getInstance(guildId).serverList[incident.serverId];
        const locked = server ? Object.values(server.switches || {}).filter(e => e.raidLock).map(e => e.name) : [];
        if (locked.length > 0) {
            description += `\n${client.intlGet(guildId, 'raidEndedLockedReminder', { targets: locked.join(', ') })}`;
        }
    }
    else {
        title = client.intlGet(guildId, 'raidActiveTitle', { server: incident.serverTitle });
        color = incident.acknowledgedBy ? Constants.COLOR_CARGO_SHIP_ENTERS_EGRESS_STAGE : Constants.COLOR_INACTIVE;
        description += client.intlGet(guildId, 'raidActiveDesc', {
            count: incident.count,
            started: t(incident.startedAt),
            last: t(incident.lastTriggerAt)
        });
    }

    description += `\n${client.intlGet(guildId, 'raidAlarms', { alarms: alarms })}`;
    /* Last text sent by the raid-alarm plugin (e.g. where the attack is) */
    if (incident.pluginNote) description += `\n> ${incident.pluginNote}`;
    if (incident.acknowledgedBy) {
        description += `\n${client.intlGet(guildId, 'raidAcknowledgedBy', { user: `<@${incident.acknowledgedBy}>` })}`;
    }
    else if (!incident.endedAt) {
        description += `\n${client.intlGet(guildId, 'raidNotAcknowledged', {
            minutes: Math.round(s.reminderMs / 60000)
        })}`;
    }
    if (incident.actionsText) description += `\n${incident.actionsText}`;

    return DiscordEmbeds.getEmbed({
        color: color,
        title: title,
        description: description,
        footer: { text: incident.serverTitle },
        timestamp: true
    });
}

/* Raid messages go to #base (#activity if it does not exist) */
function raidChannel(instance) {
    return instance.channelId.base || instance.channelId.activity;
}

/* Raid pings go to the whole Discord channel */
function getMention() {
    return '@everyone';
}

/* Pin the raid message while the raid is active and nobody acknowledged it */
async function setPinned(client, guildId, incident, pinned) {
    if (!incident.messageId || !incident.channelId) return;
    if (!!incident.pinned === pinned) return;
    try {
        const message = await DiscordTools.getMessageById(guildId, incident.channelId, incident.messageId);
        if (message) {
            if (pinned) await message.pin(); else await message.unpin();
        }
    }
    catch (e) { /* missing permission: not critical */ }
    incident.pinned = pinned;
}

function getAckButton(client, guildId, incident) {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('RaidAcknowledge')
            .setLabel(client.intlGet(guildId, 'raidAcknowledgeCap'))
            .setStyle(Discord.ButtonStyle.Primary)
            .setEmoji('\u{1F440}')
            .setDisabled(!!incident.acknowledgedBy || !!incident.endedAt));
}

async function sendOrEditIncident(client, guildId, incident, mention) {
    /* One send at a time: otherwise two messages could be created for the same raid */
    if (incident.sending) {
        incident.resend = true;
        incident.dirty = true;
        return;
    }
    incident.sending = true;
    try {
        do {
            incident.resend = false;
            const instance = client.getInstance(guildId);
            const content = {
                embeds: [getIncidentEmbed(client, guildId, incident)],
                components: [getAckButton(client, guildId, incident)]
            };
            if (mention) content.content = getMention(client, guildId);
            mention = false;

            if (!incident.channelId) incident.channelId = raidChannel(instance);
            const message = await DiscordMessages.sendMessage(guildId, content, incident.messageId, incident.channelId);
            if (message && message.id) incident.messageId = message.id;
            /* Pinned until someone has seen it or the raid is over */
            await setPinned(client, guildId, incident, !incident.endedAt && !incident.acknowledgedBy);
            incident.lastEditAt = Date.now();
            incident.dirty = false;
        } while (incident.resend);
    }
    finally {
        incident.sending = false;
    }
}

async function sendReminder(client, guildId, incident) {
    const instance = client.getInstance(guildId);
    const channelId = incident.channelId || raidChannel(instance);
    /* Always the same single reminder: the previous one is removed and posted again (a new message
       is what makes @everyone ring). The button is only on the raid message. */
    await deleteReminder(guildId, incident);
    const content = {
        content: getMention(client, guildId),
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_INACTIVE,
            title: client.intlGet(guildId, 'raidReminderTitle'),
            description: client.intlGet(guildId, 'raidReminderDesc', {
                count: incident.count,
                started: `<t:${Math.floor(incident.startedAt / 1000)}:R>`
            })
        })]
    };
    const message = await DiscordMessages.sendMessage(guildId, content, null, channelId);
    if (!message || !message.id) return;
    /* LO VEO or the end of the raid came while it was being posted: it is not needed any more */
    if (incident.acknowledgedBy || incident.endedAt) {
        try { await DiscordTools.deleteMessageById(guildId, channelId, message.id); }
        catch (e) { /* already gone */ }
        return;
    }
    incident.reminderId = message.id;
}

async function deleteReminder(guildId, incident) {
    if (!incident.reminderId) return;
    try { await DiscordTools.deleteMessageById(guildId, incident.channelId, incident.reminderId); }
    catch (e) { /* already gone */ }
    incident.reminderId = null;
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

/**
 *  Called when a Smart Alarm of the connected server triggers (raid mode on).
 */
async function onAlarmTriggered(client, rustplus, guildId, serverId, entityId, now = Date.now()) {
    const server = client.getInstance(guildId).serverList[serverId];
    if (!server || !server.alarms[entityId]) return;
    await trigger(client, rustplus, guildId, serverId, entityId, server.alarms[entityId], true, now);
}

/**
 *  Raid alert pushed by the "raid-alarm" server plugin (FCM): no Smart Alarm entity behind it.
 *  It joins the same grouped raid message instead of an @everyone message per notification.
 */
async function onPluginAlarm(client, rustplus, guildId, serverId, title, message, now = Date.now()) {
    const alarm = { name: title || 'Raid alarm', message: message || '', everyone: true };
    /* It is a raid too: do what the raid-mode Smart Alarms do (e.g. "sammode off": SAM to attack mode) */
    const server = client.getInstance(guildId).serverList[serverId];
    const merged = { groups: [], switches: [], offGroups: [], offSwitches: [], holdMinutes: 0 };
    for (const a of Object.values((server && server.alarms) || {})) {
        if (a.raidMode === false || !a.actions) continue;
        for (const k of ['groups', 'switches', 'offGroups', 'offSwitches']) {
            for (const id of a.actions[k] || []) if (!merged[k].includes(id)) merged[k].push(id);
        }
        merged.holdMinutes = Math.max(merged.holdMinutes, a.actions.holdMinutes || 0);
    }
    if (['groups', 'switches', 'offGroups', 'offSwitches'].some(k => merged[k].length > 0)) {
        if (!merged.holdMinutes) delete merged.holdMinutes;
        alarm.actions = merged;
    }
    await trigger(client, rustplus, guildId, serverId, `plugin:${alarm.name}`, alarm, false, now);
}

/* key = the alarm entity id, or a pseudo id for plugin alerts. alarm = { name, message, everyone, actions? } */
async function trigger(client, rustplus, guildId, serverId, entityId, alarm, isSmartAlarm, now) {
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];

    if (!server) return;

    let incident = incidents[guildId];
    /* A raid of another server (the bot changed server) is not continued: it is ended properly
       (reminder deleted, unpinned, stats recorded) before the new one starts */
    if (incident && !incident.endedAt && incident.serverId !== serverId) {
        try {
            await endIncident(client, guildId, incident, now);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Raid handler: ${e}`, 'error');
        }
        if (pendingActions[guildId]) delete pendingActions[guildId];
        if (incidents[guildId] !== incident) incident = incidents[guildId];
    }
    const isNew = !incident || incident.endedAt || incident.serverId !== serverId;
    if (isNew) {
        incident = {
            serverId: serverId,
            serverTitle: server.title,
            startedAt: now,
            lastTriggerAt: now,
            count: 0,
            alarms: {},
            everyone: false,
            messageId: null,
            acknowledgedBy: null,
            lastReminderAt: now,
            lastEditAt: 0,
            lastActionAt: 0,
            dirty: false,
            endedAt: null,
            actionsText: null
        };
        incidents[guildId] = incident;
    }

    incident.count++;
    incident.lastTriggerAt = now;
    incident.everyone = incident.everyone || !!alarm.everyone;
    if (!incident.alarms[entityId]) incident.alarms[entityId] = { name: alarm.name, count: 0 };
    incident.alarms[entityId].name = alarm.name;
    incident.alarms[entityId].count++;
    if (!isSmartAlarm && alarm.message) incident.pluginNote = `${alarm.message}`.slice(0, 300);
    incident.dirty = true;

    /* The alert first (with the mention), the actions after: they can take a few seconds */
    if (isNew) {
        await sendOrEditIncident(client, guildId, incident, true);
        /* Plugin alerts always went to the game chat; Smart Alarms follow their setting */
        if (rustplus && (!isSmartAlarm || instance.generalSettings.smartAlarmNotifyInGame)) {
            rustplus.sendInGameMessage(`${alarm.name}: ${alarm.message}`);
        }
    }

    /* Alarm actions (rate limited) */
    if (!incident.lastActionAtBy) incident.lastActionAtBy = {};
    if (alarm.actions && now - (incident.lastActionAtBy[entityId] || 0) >= ACTION_INTERVAL_MS) {
        incident.lastActionAtBy[entityId] = now;
        incident.lastActionAt = now;
        const names = describeActionTargets(server, alarm, 'on');
        const offNames = describeActionTargets(server, alarm, 'off');
        const parts = [];
        if (names !== '') {
            parts.push(client.intlGet(guildId, 'raidActionsDone', {
                targets: names,
                minutes: alarm.actions.holdMinutes || Config.raid.defaultHoldMinutes
            }));
        }
        if (offNames !== '') parts.push(client.intlGet(guildId, 'raidActionsOff', { targets: offNames }));
        if (parts.length > 0) incident.actionsText = parts.join('\n');
        try {
            await runAlarmActions(client, rustplus, guildId, serverId, alarm, now);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Alarm actions failed: ${e}`, 'error');
        }
        /* Show what was done */
        if (incident.actionsText) incident.dirty = true;
    }
}

/**
 *  Periodic work: throttled message updates, reminders and end of raid.
 */
async function tick(client, now = Date.now()) {
    const s = settings();
    for (const [guildId, incident] of Object.entries(incidents)) {
        if (incident.endedAt) {
            if (pendingActions[guildId]) await runPendingActions(client, guildId, now);
            continue;
        }
        try {
            await runPendingActions(client, guildId, now);

            if (now - incident.lastTriggerAt >= s.quietMs) {
                await endIncident(client, guildId, incident, now);
                continue;
            }

            /* Nobody has seen it yet: the reminder rings again (@everyone) every few minutes */
            if (!incident.acknowledgedBy && now - incident.lastReminderAt >= s.reminderMs) {
                incident.lastReminderAt = now;
                await sendReminder(client, guildId, incident);
            }

            if (incident.dirty && now - incident.lastEditAt >= s.editThrottleMs) {
                await sendOrEditIncident(client, guildId, incident, false);
            }
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Raid handler: ${e}`, 'error');
        }
    }
}

/* Raid over: quiet for a while, or every alarm of the raid stopped responding (destroyed) */
async function endIncident(client, guildId, incident, now = Date.now(), alarmsLost = false) {
    if (incident.endedAt) return;
    incident.endedAt = now;
    incident.alarmsLost = alarmsLost;
    await deleteReminder(guildId, incident);
    await sendOrEditIncident(client, guildId, incident, false);
    require('../util/dailyStats.js').recordRaid(guildId, {
        start: incident.startedAt,
        end: incident.lastTriggerAt,
        count: incident.count,
        alarms: Object.values(incident.alarms).map(a => a.name).join(', ')
    });
    const instance = client.getInstance(guildId);
    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    if (rustplus && instance.generalSettings.smartAlarmNotifyInGame) {
        rustplus.sendInGameMessage(client.intlGet(guildId, 'raidEndedInGame', { count: incident.count }));
    }
}

/* A Smart Alarm stopped responding: if it was part of the active raid, the raid is over */
async function onAlarmLost(client, guildId, entityId, now = Date.now()) {
    const incident = incidents[guildId];
    if (!incident || incident.endedAt || !incident.alarms[entityId]) return;
    await endIncident(client, guildId, incident, now, true);
}

async function acknowledge(client, interaction) {
    const guildId = interaction.guildId;
    const incident = incidents[guildId];
    if (!incident || incident.endedAt || incident.acknowledgedBy ||
        (interaction.message && incident.messageId && interaction.message.id !== incident.messageId)) {
        /* Old raid message (e.g. the bot restarted during the raid): unpin it and disable the button */
        try {
            if (!interaction.message) throw new Error("no message");
            if (interaction.message.pinned) await interaction.message.unpin();
            const rows = interaction.message.components.map(row => {
                const r = Discord.ActionRowBuilder.from(row);
                r.setComponents(row.components.map(c => Discord.ButtonBuilder.from(c).setDisabled(true)));
                return r;
            });
            await interaction.update({ components: rows });
        }
        catch (e) {
            try { await interaction.deferUpdate(); } catch (e2) { }
        }
        return;
    }
    incident.acknowledgedBy = interaction.user.id;
    await client.interactionUpdate(interaction, {
        embeds: [getIncidentEmbed(client, guildId, incident)],
        components: [getAckButton(client, guildId, incident)]
    });
    await setPinned(client, guildId, incident, false);
    await deleteReminder(guildId, incident);
    incident.lastEditAt = Date.now();
    incident.dirty = false;
}

/* The raid messages were deleted (cleanup): forget the raid in progress */
function forget(guildId) {
    delete incidents[guildId];
}

module.exports = {
    forget: forget,
    onAlarmTriggered: onAlarmTriggered,
    onPluginAlarm: onPluginAlarm,
    tick: tick,
    acknowledge: acknowledge,
    onAlarmLost: onAlarmLost,
    getMention: getMention,
    resolveActionTargets: resolveActionTargets,
    describeActionTargets: describeActionTargets,
    getIncident: (guildId) => incidents[guildId],
    getPendingActions: (guildId) => pendingActions[guildId] || {},

    start: function (client) {
        if (client.raidIntervalId) clearInterval(client.raidIntervalId);
        client.raidIntervalId = setInterval(() => tick(client), TICK_MS);
    },

    /* For tests */
    _reset: function () {
        for (const k of Object.keys(incidents)) delete incidents[k];
        for (const k of Object.keys(pendingActions)) delete pendingActions[k];
    }
};
