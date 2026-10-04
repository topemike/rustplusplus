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

    for (const groupId of alarm.actions.groups || []) {
        if (!server.switchGroups[groupId]) continue;
        await SmartSwitchGroupHandler.TurnOnOffGroup(client, rustplus, guildId, serverId, groupId, true);
    }
    for (const entityId of alarm.actions.switches || []) {
        const sw = client.getInstance(guildId).serverList[serverId].switches[entityId];
        if (!sw || sw.active) continue;
        const fresh = client.getInstance(guildId);
        fresh.serverList[serverId].switches[entityId].active = true;
        client.setInstance(guildId, fresh);
        rustplus.interactionSwitches.push(entityId);
        const response = await rustplus.turnSmartSwitchOnAsync(entityId);
        if (!(await rustplus.isResponseValid(response))) {
            const failed = client.getInstance(guildId);
            failed.serverList[serverId].switches[entityId].active = false;
            failed.serverList[serverId].switches[entityId].reachable = false;
            client.setInstance(guildId, failed);
            rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => e !== entityId);
        }
        DiscordMessages.sendSmartSwitchMessage(guildId, serverId, entityId);
        await SmartSwitchGroupHandler.updateSwitchGroupIfContainSwitch(client, guildId, serverId, entityId);
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
    const instance = client.getInstance(guildId);
    const content = {
        embeds: [getIncidentEmbed(client, guildId, incident)],
        components: [getAckButton(client, guildId, incident)]
    };
    if (mention && incident.everyone) content.content = '@everyone';

    const message = await DiscordMessages.sendMessage(guildId, content, incident.messageId,
        instance.channelId.activity);
    if (message && message.id) incident.messageId = message.id;
    incident.lastEditAt = Date.now();
    incident.dirty = false;
}

async function sendReminder(client, guildId, incident) {
    const instance = client.getInstance(guildId);
    const content = {
        content: incident.everyone ? '@everyone' : undefined,
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
    await DiscordMessages.sendMessage(guildId, content, null, instance.channelId.activity);
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
    const isNew = !incident || incident.endedAt;
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

    /* Alarm actions (rate limited) */
    if (alarm.actions && now - incident.lastActionAt >= ACTION_INTERVAL_MS) {
        incident.lastActionAt = now;
        const names = describeActionTargets(server, alarm);
        if (names !== '') {
            incident.actionsText = client.intlGet(guildId, 'raidActionsDone', {
                targets: names,
                minutes: alarm.actions.holdMinutes || Config.raid.defaultHoldMinutes
            });
        }
        try {
            await runAlarmActions(client, rustplus, guildId, serverId, alarm, now);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Alarm actions failed: ${e}`, 'error');
        }
    }

    if (isNew) {
        await sendOrEditIncident(client, guildId, incident, true);
        if (rustplus && instance.generalSettings.smartAlarmNotifyInGame) {
            rustplus.sendInGameMessage(`${alarm.name}: ${alarm.message}`);
        }
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
                incident.endedAt = now;
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

async function acknowledge(client, interaction) {
    const guildId = interaction.guildId;
    const incident = incidents[guildId];
    if (!incident || incident.endedAt || incident.acknowledgedBy) {
        try { await interaction.deferUpdate(); } catch (e) { }
        return;
    }
    incident.acknowledgedBy = interaction.user.id;
    await client.interactionUpdate(interaction, {
        embeds: [getIncidentEmbed(client, guildId, incident)],
        components: [getAckButton(client, guildId, incident)]
    });
    incident.lastEditAt = Date.now();
    incident.dirty = false;
}

module.exports = {
    onAlarmTriggered: onAlarmTriggered,
    tick: tick,
    acknowledge: acknowledge,
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
