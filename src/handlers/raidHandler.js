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
 *  - First trigger: one message (with @everyone if the alarm has it) and an "I'm on it" button.
 *  - Further triggers only update that message (counter, last trigger), throttled.
 *  - If nobody acknowledges, one reminder every N minutes while alarms keep triggering.
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

const TICK_MS = 5 * 1000;
const ACTION_INTERVAL_MS = 30 * 1000;

const incidents = new Object();

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
    if (!alarm.actions || !rustplus) return;
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    if (!server) return;

    const holdUntil = now + (alarm.actions.holdMinutes || Config.raid.defaultHoldMinutes) * 60 * 1000;

    /* Mark every affected switch as held so automatic modes leave it alone */
    const affected = new Set(alarm.actions.switches || []);
    for (const groupId of alarm.actions.groups || []) {
        if (!server.switchGroups[groupId]) continue;
        for (const entityId of server.switchGroups[groupId].switches) affected.add(`${entityId}`);
    }
    for (const entityId of affected) {
        if (server.switches[entityId]) {
            server.switches[entityId].holdUntil = Math.max(server.switches[entityId].holdUntil || 0, holdUntil);
        }
    }
    client.setInstance(guildId, instance);

    /* Turned off by the alarm (e.g. the SAM to its normal mode): stays like that, ignoring its
       automatic mode, until someone gives an order (button, mode, command) */
    const locked = new Set(alarm.actions.offSwitches || []);
    for (const groupId of alarm.actions.offGroups || []) {
        if (!server.switchGroups[groupId]) continue;
        for (const entityId of server.switchGroups[groupId].switches) locked.add(`${entityId}`);
    }
    for (const entityId of locked) {
        if (server.switches[entityId]) {
            server.switches[entityId].raidLock = true;
            delete server.switches[entityId].manualOverride;
        }
    }
    client.setInstance(guildId, instance);
    for (const groupId of alarm.actions.offGroups || []) {
        if (!server.switchGroups[groupId]) continue;
        await SmartSwitchGroupHandler.TurnOnOffGroup(client, rustplus, guildId, serverId, groupId, false, false);
    }
    for (const entityId of alarm.actions.offSwitches || []) {
        await setSwitch(client, rustplus, guildId, serverId, entityId, false);
    }

    for (const groupId of alarm.actions.groups || []) {
        if (!server.switchGroups[groupId]) continue;
        await SmartSwitchGroupHandler.TurnOnOffGroup(client, rustplus, guildId, serverId, groupId, true, false);
    }
    for (const entityId of alarm.actions.switches || []) {
        await setSwitch(client, rustplus, guildId, serverId, entityId, true);
    }
}

/* Turns one switch on/off for an alarm (the bot's own change, not a person's) */
async function setSwitch(client, rustplus, guildId, serverId, entityId, value) {
    const sw = client.getInstance(guildId).serverList[serverId].switches[entityId];
    if (!sw) return;
    if (sw.active === value) {
        DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
        return;
    }
    const fresh = client.getInstance(guildId);
    fresh.serverList[serverId].switches[entityId].active = value;
    client.setInstance(guildId, fresh);
    rustplus.interactionSwitches.push(entityId);
    const response = await rustplus.turnSmartSwitchAsync(entityId, value);
    if (!(await rustplus.isResponseValid(response))) {
        const failed = client.getInstance(guildId);
        failed.serverList[serverId].switches[entityId].active = !value;
        failed.serverList[serverId].switches[entityId].reachable = false;
        client.setInstance(guildId, failed);
        rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
    }
    DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
    await SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, serverId, entityId);
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
            if (mention && incident.everyone) content.content = getMention(client, guildId);
            mention = false;

            if (!incident.channelId) incident.channelId = raidChannel(instance);
            const message = await DiscordMessages.sendMessage(guildId, content, incident.messageId, incident.channelId);
            if (message && message.id) incident.messageId = message.id;
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
    const content = {
        content: incident.everyone ? getMention(client, guildId) : undefined,
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_INACTIVE,
            title: client.intlGet(guildId, 'raidReminderTitle'),
            description: client.intlGet(guildId, 'raidReminderDesc', {
                count: incident.count,
                started: `<t:${Math.floor(incident.startedAt / 1000)}:R>`
            })
        })]
    };
    if (!content.content) delete content.content;
    await DiscordMessages.sendMessage(guildId, content, null, incident.channelId || raidChannel(instance));
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

/**
 *  Called when a Smart Alarm of the connected server triggers (raid mode on).
 */
async function onAlarmTriggered(client, rustplus, guildId, serverId, entityId, now = Date.now()) {
    const instance = client.getInstance(guildId);
    const server = instance.serverList[serverId];
    const alarm = server.alarms[entityId];

    let incident = incidents[guildId];
    /* A raid of another server (the bot changed server) is not continued */
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
    incident.dirty = true;

    /* The alert first (with the mention), the actions after: they can take a few seconds */
    if (isNew) {
        await sendOrEditIncident(client, guildId, incident, true);
        if (rustplus && instance.generalSettings.smartAlarmNotifyInGame) {
            rustplus.sendInGameMessage(`${alarm.name}: ${alarm.message}`);
        }
    }

    /* Alarm actions (rate limited) */
    if (alarm.actions && now - incident.lastActionAt >= ACTION_INTERVAL_MS) {
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
        if (incident.endedAt) continue;
        try {
            if (now - incident.lastTriggerAt >= s.quietMs) {
                await endIncident(client, guildId, incident, now);
                continue;
            }

            if (!incident.acknowledgedBy && now - incident.lastReminderAt >= s.reminderMs &&
                incident.lastTriggerAt > incident.lastReminderAt) {
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
    tick: tick,
    acknowledge: acknowledge,
    onAlarmLost: onAlarmLost,
    getMention: getMention,
    resolveActionTargets: resolveActionTargets,
    describeActionTargets: describeActionTargets,
    getIncident: (guildId) => incidents[guildId],

    start: function (client) {
        if (client.raidIntervalId) clearInterval(client.raidIntervalId);
        client.raidIntervalId = setInterval(() => tick(client), TICK_MS);
    },

    /* For tests */
    _reset: function () { for (const k of Object.keys(incidents)) delete incidents[k]; }
};
