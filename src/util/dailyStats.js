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
 *  Daily summary: what happened in the last 24 hours, posted once a day in the activity channel
 *  (and on demand with /resumen).
 *  - Events (counted from the event notifications), raids, tracked clans, Tool Cupboard upkeep
 *    and credential expiry.
 *  Records are kept per guild in instances/dailyStats/<guildId>.json (last 48 hours).
 */

const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');
const Constants = require('./constants.js');
const CredentialUtils = require('./credentialUtils.js');
const InstanceUtils = require('./instanceUtils.js');
const Timer = require('./timer');

const DIR = Path.join(__dirname, '..', '..', 'instances', 'dailyStats');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KEEP_MS = 2 * DAY_MS;

/* Event notification settings shown in the summary, in this order */
const EVENT_GROUPS = [
    { key: 'cargo', settings: ['cargoShipDetectedSetting'] },
    { key: 'heliDown', settings: ['patrolHelicopterDestroyedSetting'] },
    { key: 'bradley', settings: ['bradleyApcDestroyedSetting'] },
    { key: 'oilRig', settings: ['heavyScientistCalledSetting'] },
    { key: 'crates', settings: ['lockedCrateDroppedSetting'] },
    { key: 'chinook', settings: ['chinook47DetectedSetting'] },
    { key: 'vendor', settings: ['travelingVendorDetectedSetting'] },
    { key: 'deepSea', settings: ['deepSeaSetting'], text: /(open|abr)/i, exclude: /(\d+ (min|minutos))/i }
];

const cache = new Object();

function file(guildId) {
    return Path.join(DIR, `${guildId}.json`);
}

function load(guildId) {
    if (cache[guildId]) return cache[guildId];
    let data = { events: [], raids: [], lastSummaryDay: null };
    try {
        if (Fs.existsSync(file(guildId))) data = Object.assign(data, JSON.parse(Fs.readFileSync(file(guildId), 'utf8')));
    }
    catch (e) { /* start fresh */ }
    cache[guildId] = data;
    return data;
}

function save(guildId) {
    const data = cache[guildId];
    if (!data) return;
    const now = Date.now();
    data.events = data.events.filter(e => now - e.t <= KEEP_MS);
    data.raids = data.raids.filter(r => now - r.end <= KEEP_MS);
    try {
        Fs.mkdirSync(DIR, { recursive: true });
        Fs.writeFileSync(file(guildId), JSON.stringify(data));
    }
    catch (e) { /* not critical */ }
}

function recordEvent(guildId, settingKey, text, now = Date.now()) {
    if (!settingKey) return;
    const data = load(guildId);
    data.events.push({ t: now, s: settingKey, x: `${text}`.slice(0, 200) });
    save(guildId);
}

function recordRaid(guildId, raid) {
    const data = load(guildId);
    data.raids.push(raid);
    save(guildId);
}

/* ------------------------------------------------------------------------- */

function countEvents(data, since) {
    const counts = {};
    for (const group of EVENT_GROUPS) {
        counts[group.key] = data.events.filter(e => e.t >= since && group.settings.includes(e.s) &&
            (!group.text || group.text.test(e.x)) && (!group.exclude || !group.exclude.test(e.x))).length;
    }
    return counts;
}

function trackerLines(client, guildId, instance, since, now) {
    let history = null;
    try {
        history = JSON.parse(Fs.readFileSync(Path.join(__dirname, '..', '..', 'instances', 'trackerHistory',
            `${guildId}.json`), 'utf8'));
    }
    catch (e) {
        return [];
    }

    const lines = [];
    for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
        const th = history.trackers && history.trackers[trackerId];
        if (!th) continue;
        let totalMs = 0, online = 0, lastSeen = null;
        for (const p of Object.values(th.players)) {
            for (const s of p.sessions) {
                const end = s[1] === null ? now : s[1];
                if (s[1] === null) online++;
                if (end > since) totalMs += end - Math.max(s[0], since);
                if (lastSeen === null || end > lastSeen) lastSeen = end;
            }
        }
        lines.push(client.intlGet(guildId, 'summaryTrackerLine', {
            name: tracker.name,
            hours: (totalMs / HOUR_MS).toFixed(1),
            online: online,
            total: Object.keys(th.players).length,
            seen: lastSeen === null ? '-' : (online > 0 ? client.intlGet(guildId, 'summaryNow') :
                `<t:${Math.floor(lastSeen / 1000)}:R>`)
        }));
    }
    return lines;
}

function upkeepLines(client, guildId, instance, rustplus, now) {
    if (!rustplus || !rustplus.storageMonitors) return [];
    const server = instance.serverList[rustplus.serverId];
    if (!server) return [];
    const lines = [];
    for (const [entityId, entity] of Object.entries(server.storageMonitors || {})) {
        const content = rustplus.storageMonitors[entityId];
        if (!content || content.capacity !== Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY) continue;
        if (!content.expiry) {
            lines.push(client.intlGet(guildId, 'summaryUpkeepDecaying', { name: entity.name }));
            continue;
        }
        const left = content.expiry * 1000 - now;
        lines.push(client.intlGet(guildId, left < 6 * HOUR_MS ? 'summaryUpkeepLow' : 'summaryUpkeepLine', {
            name: entity.name,
            time: Timer.secondsToFullScale(Math.max(0, left) / 1000, 's')
        }));
    }
    return lines;
}

function credentialLine(client, guildId, now) {
    try {
        const credentials = InstanceUtils.readCredentialsFile(guildId);
        const hoster = credentials.hoster ? credentials[credentials.hoster] : null;
        if (!hoster) return null;
        const expire = CredentialUtils.toEpochSeconds(hoster.expire_date);
        if (expire === null) return null;
        return client.intlGet(guildId, expire * 1000 < now ? 'summaryCredentialsExpired' : 'summaryCredentials',
            { date: `<t:${expire}:R>` });
    }
    catch (e) {
        return null;
    }
}

/**
 *  Builds the summary of the last 24 hours.
 *  @return {Object} { title, fields: [{ name, value }] }
 */
function buildSummary(client, guildId, now = Date.now()) {
    const instance = client.getInstance(guildId);
    const rustplus = client.rustplusInstances ? client.rustplusInstances[guildId] : null;
    const data = load(guildId);
    const since = now - DAY_MS;
    const intl = (id, v) => client.intlGet(guildId, id, v);
    const fields = [];

    const counts = countEvents(data, since);
    const eventParts = EVENT_GROUPS.map(g => counts[g.key] > 0 ? intl(`summaryEvent_${g.key}`, { count: counts[g.key] }) : null)
        .filter(x => x !== null);
    fields.push({ name: intl('summaryEventsTitle'), value: eventParts.length ? eventParts.join(' · ') : intl('summaryNothing') });

    const raids = data.raids.filter(r => r.end >= since);
    fields.push({
        name: intl('summaryRaidsTitle'),
        value: raids.length === 0 ? intl('summaryNoRaids') : raids.slice(-5).map(r => intl('summaryRaidLine', {
            start: `<t:${Math.floor(r.start / 1000)}:t>`,
            duration: Timer.secondsToFullScale((r.end - r.start) / 1000, 's') || '0m',
            count: r.count,
            alarms: r.alarms
        })).join('\n')
    });

    const trackers = trackerLines(client, guildId, instance, since, now);
    if (trackers.length) fields.push({ name: intl('summaryTrackersTitle'), value: trackers.join('\n').slice(0, 1024) });

    const upkeep = upkeepLines(client, guildId, instance, rustplus, now);
    if (upkeep.length) fields.push({ name: intl('summaryUpkeepTitle'), value: upkeep.join('\n').slice(0, 1024) });

    const cred = credentialLine(client, guildId, now);
    if (cred) fields.push({ name: intl('summaryBotTitle'), value: cred });

    const server = instance.activeServer !== null ? instance.serverList[instance.activeServer] : null;
    return {
        title: intl('summaryTitle', { server: server ? server.title : '' }),
        fields: fields
    };
}

function localDayAndHour(now) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: Config.general.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(now));
    const get = (t) => parts.find(p => p.type === t).value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour')) };
}

/**
 *  Whether the daily summary is due now (once per local day, at or after the configured hour).
 */
function isDue(guildId, now = Date.now()) {
    const { day, hour } = localDayAndHour(now);
    const data = load(guildId);
    return hour >= Config.dailySummary.hour && data.lastSummaryDay !== day;
}

function isFirstRun(guildId) {
    return load(guildId).lastSummaryDay === null;
}

function markSent(guildId, now = Date.now()) {
    const data = load(guildId);
    data.lastSummaryDay = localDayAndHour(now).day;
    save(guildId);
}

module.exports = {
    recordEvent: recordEvent,
    recordRaid: recordRaid,
    buildSummary: buildSummary,
    isDue: isDue,
    markSent: markSent,
    isFirstRun: isFirstRun,
    DIR: DIR,
    _reset: () => { for (const k of Object.keys(cache)) delete cache[k]; }
};
