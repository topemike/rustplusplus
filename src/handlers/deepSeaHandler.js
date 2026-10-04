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
 *  Rust+ does not report the Deep Sea, but it follows a fixed cycle per server (open for a while,
 *  closed for a while). The team marks once when it opens (or closes) and the bot predicts the
 *  next openings/closings, warning 10 and 5 minutes before and at the moment.
 *  - Durations default to 3h open / 90 min closed (editable) and are learned from the marks:
 *    marking "open" and later "closed" measures the open time of that server, and vice versa.
 *  - A wipe clears the timer (the Deep Sea does not open right after a wipe).
 */

const Config = require('../../config');
const Constants = require('../util/constants.js');
const Timer = require('../util/timer');

const MINUTE_MS = 60 * 1000;
const TICK_MS = 15 * 1000;

/* Measured durations outside these limits are ignored (forgotten mark, server restart...) */
const OPEN_LIMITS_MS = [20 * MINUTE_MS, 12 * 60 * MINUTE_MS];
const CLOSED_LIMITS_MS = [5 * MINUTE_MS, 12 * 60 * MINUTE_MS];

function defaults() {
    return {
        openMs: Config.deepSea.openMinutes * MINUTE_MS,
        closedMs: Config.deepSea.closedMinutes * MINUTE_MS
    };
}

function getDeepSea(server) {
    if (!server.deepSea) {
        server.deepSea = {
            lastOpenedAt: null, lastClosedAt: null,
            openMs: null, closedMs: null,          /* null = default */
            warned: {}
        };
    }
    if (!server.deepSea.warned) server.deepSea.warned = {};
    return server.deepSea;
}

function durations(ds) {
    const d = defaults();
    return { openMs: ds.openMs || d.openMs, closedMs: ds.closedMs || d.closedMs };
}

/**
 *  Current phase and next transition, from the most recent mark.
 *  @return {Object|null} { isOpen, nextChangeAt, nextIsOpening } or null when not synchronized.
 */
function predict(ds, now = Date.now()) {
    const { openMs, closedMs } = durations(ds);
    const cycle = openMs + closedMs;

    let anchorOpen = null;   /* a moment when the Deep Sea opened */
    if (ds.lastOpenedAt !== null && (ds.lastClosedAt === null || ds.lastOpenedAt >= ds.lastClosedAt)) {
        anchorOpen = ds.lastOpenedAt;
    }
    else if (ds.lastClosedAt !== null) {
        anchorOpen = ds.lastClosedAt - openMs;
    }
    if (anchorOpen === null) return null;

    const elapsed = ((now - anchorOpen) % cycle + cycle) % cycle;
    const cycleStart = now - elapsed;
    if (elapsed < openMs) {
        return { isOpen: true, nextChangeAt: cycleStart + openMs, nextIsOpening: false };
    }
    return { isOpen: false, nextChangeAt: cycleStart + cycle, nextIsOpening: true };
}

/**
 *  Records that the Deep Sea just opened or closed, learning the durations.
 *  @return {Object} { learned: 'open'|'closed'|null, ms }
 */
function mark(server, opened, now = Date.now()) {
    const ds = getDeepSea(server);
    let learned = null, ms = null;

    if (opened) {
        if (ds.lastClosedAt !== null && (ds.lastOpenedAt === null || ds.lastClosedAt > ds.lastOpenedAt)) {
            const diff = now - ds.lastClosedAt;
            if (diff >= CLOSED_LIMITS_MS[0] && diff <= CLOSED_LIMITS_MS[1]) {
                ds.closedMs = diff; learned = 'closed'; ms = diff;
            }
        }
        ds.lastOpenedAt = now;
    }
    else {
        if (ds.lastOpenedAt !== null && (ds.lastClosedAt === null || ds.lastOpenedAt > ds.lastClosedAt)) {
            const diff = now - ds.lastOpenedAt;
            if (diff >= OPEN_LIMITS_MS[0] && diff <= OPEN_LIMITS_MS[1]) {
                ds.openMs = diff; learned = 'open'; ms = diff;
            }
        }
        ds.lastClosedAt = now;
    }
    /* The change that was just marked must not be announced again */
    ds.warned = { [`${now}-0`]: true };
    return { learned: learned, ms: ms };
}

function reset(server) {
    delete server.deepSea;
}

/**
 *  Warnings due now: 10 and 5 minutes before the next change, and at the change.
 *  @return {Array} [{ key, minutes (10|5|0), opening }]
 */
function dueWarnings(ds, now = Date.now()) {
    const p = predict(ds, now);
    if (p === null) return [];
    const due = [];
    for (const minutes of Config.deepSea.warnMinutes) {
        const at = p.nextChangeAt - minutes * MINUTE_MS;
        const key = `${p.nextChangeAt}-${minutes}`;
        /* Only fire within one minute of the moment, so old warnings are not sent late */
        if (now >= at && now - at < MINUTE_MS && !ds.warned[key]) due.push({ key: key, minutes: minutes, opening: p.nextIsOpening });
    }
    /* The change itself may have just passed (we are now in the next phase) */
    const justChanged = predict(ds, now - MINUTE_MS);
    if (justChanged && justChanged.nextChangeAt <= now && justChanged.nextChangeAt > now - MINUTE_MS) {
        const key = `${justChanged.nextChangeAt}-0`;
        if (!ds.warned[key]) due.push({ key: key, minutes: 0, opening: justChanged.nextIsOpening });
    }
    return due;
}

function statusText(client, guildId, ds, now = Date.now(), short = false) {
    const p = predict(ds, now);
    if (p === null) return client.intlGet(guildId, short ? 'deepSeaNotSyncedShort' : 'deepSeaNotSynced');
    const left = Timer.secondsToFullScale((p.nextChangeAt - now) / 1000, short ? 's' : '');
    const id = p.isOpen ? (short ? 'deepSeaOpenShort' : 'deepSeaOpenStatus') :
        (short ? 'deepSeaClosedShort' : 'deepSeaClosedStatus');
    return client.intlGet(guildId, id, { time: left || '0m' });
}

function warningText(client, guildId, w) {
    if (w.minutes === 0) return client.intlGet(guildId, w.opening ? 'deepSeaOpeningNow' : 'deepSeaClosingNow');
    return client.intlGet(guildId, w.opening ? 'deepSeaOpensIn' : 'deepSeaClosesIn', { minutes: w.minutes });
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
                await rustplus.sendEvent(setting, warningText(client, guildId, w), 'deepsea',
                    w.opening ? Constants.COLOR_ACTIVE : Constants.COLOR_INACTIVE);
            }
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Deep Sea: ${e}`, 'error');
        }
    }
}

/**
 *  !deepsea [open|abierto|closed|cerrado] for the in-game chat and the Discord commands channel.
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

    if (['open', 'opened', 'abierto', 'abre', 'abrio'].includes(arg)) {
        return markAndDescribe(client, guildId, instance, server, true, now);
    }
    if (['closed', 'close', 'cerrado', 'cierra', 'cerro'].includes(arg)) {
        return markAndDescribe(client, guildId, instance, server, false, now);
    }
    return statusText(client, guildId, getDeepSea(server), now);
}

function markAndDescribe(client, guildId, instance, server, opened, now = Date.now()) {
    const result = mark(server, opened, now);
    client.setInstance(guildId, instance);
    let text = client.intlGet(guildId, opened ? 'deepSeaMarkedOpen' : 'deepSeaMarkedClosed');
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
    getDeepSea: getDeepSea,
    tick: tick,

    start: function (client) {
        if (client.deepSeaIntervalId) clearInterval(client.deepSeaIntervalId);
        client.deepSeaIntervalId = setInterval(() => tick(client), TICK_MS);
    }
};
