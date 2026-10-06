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
 *  Deep Sea timer.
 *  Rust+ does not report the Deep Sea. It stays open a fixed time (about 3 h) and then closed a
 *  RANDOM time (1h30 to 2h30 by default), so only the closing can be predicted exactly:
 *  - Marked open: warnings 10 and 5 minutes before it closes and when it closes.
 *  - Closed: the bot gives the window in which it will reopen and warns when the window starts.
 *    If nobody marks the opening, it reminds once at the end of the window.
 *  - Marks can be given late ("!deepsea open 20" = it opened 20 minutes ago).
 *  - The open time and the closed range are learned from the marks.
 *  - A wipe clears the timer.
 */

const Config = require('../../config');
const Constants = require('../util/constants.js');
const Timer = require('../util/timer');

const MINUTE_MS = 60 * 1000;
const TICK_MS = 15 * 1000;
const MAX_LATE_MINUTES = 600;

/* Measured durations outside these limits are ignored (forgotten mark, server restart...) */
const OPEN_LIMITS_MS = [20 * MINUTE_MS, 12 * 60 * MINUTE_MS];
const CLOSED_LIMITS_MS = [5 * MINUTE_MS, 12 * 60 * MINUTE_MS];

const OPEN_WORDS = ['open', 'opened', 'abierto', 'abre', 'abrio', 'abrió'];
const CLOSED_WORDS = ['closed', 'close', 'cerrado', 'cierra', 'cerro', 'cerró'];

function defaults() {
    return {
        openMs: Config.deepSea.openMinutes * MINUTE_MS,
        closedMinMs: Config.deepSea.closedMinMinutes * MINUTE_MS,
        closedMaxMs: Config.deepSea.closedMaxMinutes * MINUTE_MS
    };
}

function getDeepSea(server) {
    if (!server.deepSea) {
        server.deepSea = {
            lastOpenedAt: null, lastClosedAt: null,
            openMs: null, closedMinMs: null, closedMaxMs: null,   /* null = default */
            warned: {}
        };
    }
    if (!server.deepSea.warned) server.deepSea.warned = {};
    return server.deepSea;
}

function durations(ds) {
    const d = defaults();
    const closedMinMs = ds.closedMinMs || d.closedMinMs;
    const closedMaxMs = Math.max(ds.closedMaxMs || d.closedMaxMs, closedMinMs);
    return { openMs: ds.openMs || d.openMs, closedMinMs: closedMinMs, closedMaxMs: closedMaxMs };
}

/**
 *  Current phase from the most recent mark.
 *  @return {Object|null} null when never marked, otherwise one of:
 *    { phase: 'open', isOpen: true, closesAt, nextChangeAt }
 *    { phase: 'closed', isOpen: false, opensFrom, opensTo, nextChangeAt (= opensFrom) }
 *    { phase: 'overdue', isOpen: null, opensTo }   (should have reopened, nobody marked it)
 */
function predict(ds, now = Date.now()) {
    const { openMs, closedMinMs, closedMaxMs } = durations(ds);
    let closedAt = null;

    if (ds.lastOpenedAt !== null && ds.lastOpenedAt !== undefined &&
        (ds.lastClosedAt === null || ds.lastClosedAt === undefined || ds.lastOpenedAt >= ds.lastClosedAt)) {
        const closesAt = ds.lastOpenedAt + openMs;
        if (now < closesAt) return { phase: 'open', isOpen: true, closesAt: closesAt, nextChangeAt: closesAt };
        closedAt = closesAt;
    }
    else if (ds.lastClosedAt !== null && ds.lastClosedAt !== undefined) {
        closedAt = ds.lastClosedAt;
    }
    if (closedAt === null) return null;

    const opensFrom = closedAt + closedMinMs, opensTo = closedAt + closedMaxMs;
    if (now <= opensTo) {
        return { phase: 'closed', isOpen: false, opensFrom: opensFrom, opensTo: opensTo, nextChangeAt: opensFrom };
    }
    return { phase: 'overdue', isOpen: null, opensTo: opensTo };
}

/**
 *  Records that the Deep Sea opened or closed at `at` (now, or some minutes ago), learning durations.
 *  @return {Object} { learned: 'open'|'closed'|null, ms }
 */
function mark(server, opened, at = Date.now()) {
    const ds = getDeepSea(server);
    let learned = null, ms = null;

    if (opened) {
        if (ds.lastClosedAt !== null && (ds.lastOpenedAt === null || ds.lastClosedAt > ds.lastOpenedAt)) {
            const diff = at - ds.lastClosedAt;
            if (diff >= CLOSED_LIMITS_MS[0] && diff <= CLOSED_LIMITS_MS[1]) {
                const d = durations(ds);
                ds.closedMinMs = Math.min(d.closedMinMs, diff);
                ds.closedMaxMs = Math.max(d.closedMaxMs, diff);
                learned = 'closed'; ms = diff;
            }
        }
        ds.lastOpenedAt = at;
    }
    else {
        if (ds.lastOpenedAt !== null && (ds.lastClosedAt === null || ds.lastOpenedAt > ds.lastClosedAt)) {
            const diff = at - ds.lastOpenedAt;
            if (diff >= OPEN_LIMITS_MS[0] && diff <= OPEN_LIMITS_MS[1]) {
                ds.openMs = diff; learned = 'open'; ms = diff;
            }
        }
        ds.lastClosedAt = at;
    }
    /* Warnings only fire within a minute of their moment, so nothing old is re-sent */
    ds.warned = {};
    return { learned: learned, ms: ms };
}

function reset(server) {
    delete server.deepSea;
}

/**
 *  Warnings due now.
 *  @return {Array} [{ key, type: 'closesIn'|'closingNow'|'mayOpen'|'overdue', minutes, opensTo }]
 */
function dueWarnings(ds, now = Date.now()) {
    const due = [];
    const inWindow = (at) => now >= at && now - at < MINUTE_MS;
    const p = predict(ds, now);
    const before = predict(ds, now - MINUTE_MS);

    if (p !== null && p.phase === 'open') {
        for (const minutes of Config.deepSea.warnMinutes) {
            const key = `${p.closesAt}-${minutes}`;
            if (inWindow(p.closesAt - minutes * MINUTE_MS) && !ds.warned[key]) {
                due.push({ key: key, type: 'closesIn', minutes: minutes });
            }
        }
    }
    /* It has just closed (by the timer) */
    if (before !== null && before.phase === 'open' && inWindow(before.closesAt)) {
        const key = `${before.closesAt}-0`;
        if (!ds.warned[key]) due.push({ key: key, type: 'closingNow' });
    }
    if (p !== null && p.phase === 'closed' && inWindow(p.opensFrom)) {
        const key = `${p.opensFrom}-from`;
        if (!ds.warned[key]) due.push({ key: key, type: 'mayOpen', opensTo: p.opensTo });
    }
    if (p !== null && p.phase === 'overdue' && inWindow(p.opensTo)) {
        const key = `${p.opensTo}-late`;
        if (!ds.warned[key]) due.push({ key: key, type: 'overdue' });
    }
    return due;
}

function statusText(client, guildId, ds, now = Date.now(), short = false) {
    const p = predict(ds, now);
    const fmt = (ms) => Timer.secondsToFullScale(Math.max(ms, 0) / 1000, short ? 's' : '') || '0m';
    if (p === null) return client.intlGet(guildId, short ? 'deepSeaNotSyncedShort' : 'deepSeaNotSynced');
    if (p.phase === 'open') {
        return client.intlGet(guildId, short ? 'deepSeaOpenShort' : 'deepSeaOpenStatus', { time: fmt(p.closesAt - now) });
    }
    if (p.phase === 'closed') {
        if (now < p.opensFrom) {
            return client.intlGet(guildId, short ? 'deepSeaClosedWindowShort' : 'deepSeaClosedWindow',
                { from: fmt(p.opensFrom - now), to: fmt(p.opensTo - now) });
        }
        return client.intlGet(guildId, short ? 'deepSeaMayOpenShort' : 'deepSeaMayOpenStatus', { to: fmt(p.opensTo - now) });
    }
    return client.intlGet(guildId, short ? 'deepSeaOverdueShort' : 'deepSeaOverdueStatus');
}

function warningText(client, guildId, w, now = Date.now()) {
    switch (w.type) {
        case 'closesIn': return client.intlGet(guildId, 'deepSeaClosesIn', { minutes: w.minutes });
        case 'closingNow': return client.intlGet(guildId, 'deepSeaClosingNow');
        case 'mayOpen': return client.intlGet(guildId, 'deepSeaMayOpenNow',
            { to: Timer.secondsToFullScale(Math.max(w.opensTo - now, 0) / 1000, 's') || '0m' });
        default: return client.intlGet(guildId, 'deepSeaOverdueReminder');
    }
}

/**
 *  Parses "open", "abierto hace 20", "open 20m", "cerrado 1h" -> { opened, lateMinutes } or null.
 */
function parseMark(arg) {
    const words = arg.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    let opened = null;
    if (OPEN_WORDS.includes(words[0])) opened = true;
    else if (CLOSED_WORDS.includes(words[0])) opened = false;
    if (opened === null) return null;

    const rest = words.slice(1).filter(w => !['hace', 'ago'].includes(w)).join(' ');
    const hours = rest.match(/(\d+)\s*h/);
    const minutes = (hours ? rest.replace(hours[0], '') : rest).match(/(\d+)/);
    let lateMinutes = (hours ? parseInt(hours[1]) * 60 : 0) + (minutes ? parseInt(minutes[1]) : 0);
    if (lateMinutes > MAX_LATE_MINUTES) lateMinutes = MAX_LATE_MINUTES;
    return { opened: opened, lateMinutes: lateMinutes };
}

async function tick(client, now = Date.now()) {
    for (const [guildId, rustplus] of Object.entries(client.rustplusInstances || {})) {
        try {
            if (!rustplus || !rustplus.isOperational) continue;
            const instance = client.getInstance(guildId);
            const server = instance.serverList[rustplus.serverId];
            if (!server || !server.deepSea) continue;

            /* Forget warnings older than a day */
            for (const key of Object.keys(server.deepSea.warned || {})) {
                if (parseInt(key) < now - 24 * 60 * MINUTE_MS) delete server.deepSea.warned[key];
            }

            const due = dueWarnings(server.deepSea, now);
            if (due.length === 0) continue;
            for (const w of due) server.deepSea.warned[w.key] = true;
            client.setInstance(guildId, instance);

            const setting = rustplus.notificationSettings.deepSeaSetting;
            if (!setting) continue;
            for (const w of due) {
                await rustplus.sendEvent(setting, warningText(client, guildId, w, now), 'deepsea',
                    w.type === 'mayOpen' || w.type === 'overdue' ? Constants.COLOR_ACTIVE : Constants.COLOR_INACTIVE);
            }
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Deep Sea: ${e}`, 'error');
        }
    }
}

/**
 *  !deepsea [open|abierto|closed|cerrado] [minutes ago] for the in-game chat and Discord commands.
 *  @return {string|null}
 */
function command(rustplus, client, text, now = Date.now()) {
    const guildId = rustplus.guildId;
    const prefix = rustplus.generalSettings.prefix;
    const lower = text.toLowerCase().trim();
    const words = [client.intlGet('en', 'commandSyntaxDeepSea'), client.intlGet(guildId, 'commandSyntaxDeepSea'), 'deepsea'];
    const word = words.find(w => lower === `${prefix}${w}` || lower.startsWith(`${prefix}${w} `));
    if (!word) return null;

    const arg = lower.slice(`${prefix}${word}`.length).trim();
    const instance = client.getInstance(guildId);
    const server = instance.serverList[rustplus.serverId];
    if (!server) return null;

    const parsed = parseMark(arg);
    if (parsed) return markAndDescribe(client, guildId, instance, server, parsed.opened, now, parsed.lateMinutes);
    return statusText(client, guildId, getDeepSea(server), now);
}

function markAndDescribe(client, guildId, instance, server, opened, now = Date.now(), lateMinutes = 0) {
    const result = mark(server, opened, now - lateMinutes * MINUTE_MS);
    client.setInstance(guildId, instance);
    let text = client.intlGet(guildId, opened ? 'deepSeaMarkedOpen' : 'deepSeaMarkedClosed');
    if (lateMinutes > 0) {
        text += ' ' + client.intlGet(guildId, 'deepSeaMarkedAgo', { time: Timer.secondsToFullScale(lateMinutes * 60, 's') });
    }
    if (result.learned) {
        text += ' ' + client.intlGet(guildId, result.learned === 'open' ? 'deepSeaLearnedOpen' : 'deepSeaLearnedClosed',
            { time: Timer.secondsToFullScale(result.ms / 1000, 's') });
    }
    return `${text} ${statusText(client, guildId, server.deepSea, now)}`;
}

module.exports = {
    predict: predict,
    mark: mark,
    reset: reset,
    durations: durations,
    dueWarnings: dueWarnings,
    statusText: statusText,
    command: command,
    markAndDescribe: markAndDescribe,
    parseMark: parseMark,
    getDeepSea: getDeepSea,
    tick: tick,

    start: function (client) {
        if (client.deepSeaIntervalId) clearInterval(client.deepSeaIntervalId);
        client.deepSeaIntervalId = setInterval(() => tick(client), TICK_MS);
    }
};
