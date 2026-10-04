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
 *  Tracker intelligence:
 *  - Keeps a session history (login/logout) of every tracked player.
 *  - Clan alerts: "whole clan offline" and "several members logging in".
 *  - Schedule analysis: when a clan is usually online and the best raid windows.
 *
 *  History is stored per guild in instances/trackerHistory/<guildId>.json.
 */

const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');

const HISTORY_DIR = Path.join(__dirname, '..', '..', 'instances', 'trackerHistory');
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* If the bot was down longer than this, open sessions are closed at the last known check. */
const STALE_TICK_MS = 5 * MINUTE_MS;
/* Sampling step used for the schedule analysis. */
const SAMPLE_STEP_MS = 5 * MINUTE_MS;

const histories = new Object();

/* ------------------------------------------------------------------------- */
/* Storage                                                                    */
/* ------------------------------------------------------------------------- */

function historyPath(guildId) {
    return Path.join(HISTORY_DIR, `${guildId}.json`);
}

function loadHistory(guildId) {
    if (histories[guildId]) return histories[guildId];

    let history = { trackers: {} };
    try {
        const path = historyPath(guildId);
        if (Fs.existsSync(path)) {
            history = JSON.parse(Fs.readFileSync(path, 'utf8'));
            if (!history.trackers) history.trackers = {};
        }
    }
    catch (e) {
        history = { trackers: {} };
    }

    histories[guildId] = history;
    return history;
}

function saveHistory(guildId) {
    const history = histories[guildId];
    if (!history) return;

    Fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const path = historyPath(guildId);
    const tmp = `${path}.tmp`;
    Fs.writeFileSync(tmp, JSON.stringify(history));
    Fs.renameSync(tmp, path);
}

function getTrackerHistory(history, trackerId) {
    if (!history.trackers[trackerId]) {
        history.trackers[trackerId] = {
            players: {},
            recentLogins: [],
            lastTick: null,
            lastOnlineCount: null,
            offlineSince: null,
            allOfflineAlerted: false,
            lastGroupAlert: null
        };
    }
    return history.trackers[trackerId];
}

/**
 *  Stable key for a tracked player: SteamID if known, otherwise the BattleMetrics player id.
 */
function playerKey(player) {
    if (player.steamId) return `steam:${player.steamId}`;
    if (player.playerId) return `bm:${player.playerId}`;
    return null;
}

/**
 *  Online state of a tracked player according to BattleMetrics.
 *  @return {boolean|null} true/false, or null when unknown.
 */
function isPlayerOnline(player, bmInstance) {
    if (!player.playerId || !bmInstance.players.hasOwnProperty(player.playerId)) return null;
    return bmInstance.players[player.playerId]['status'] === true;
}

function pruneHistory(trackerHistory, now) {
    const limit = now - Config.trackerIntel.historyDays * DAY_MS;
    for (const data of Object.values(trackerHistory.players)) {
        data.sessions = data.sessions.filter(s => s[1] === null || s[1] >= limit);
    }
    trackerHistory.recentLogins = trackerHistory.recentLogins.filter(
        l => now - l.time <= Config.trackerIntel.groupLoginWindowMinutes * MINUTE_MS);
}

/* ------------------------------------------------------------------------- */
/* Tick processing (called every minute per tracker)                          */
/* ------------------------------------------------------------------------- */

/**
 *  Updates the session history of a tracker and returns the clan alerts to send.
 *  Pure with respect to Discord: the caller sends the alerts.
 *  @return {Array} List of alerts: { type: 'allOffline'|'groupLogin', ... }
 */
function update(guildId, trackerId, tracker, bmInstance, now = Date.now()) {
    const history = loadHistory(guildId);
    const th = getTrackerHistory(history, trackerId);
    const alerts = [];

    /* Bot was down: close sessions that were open at the last check. Players that are online now
       start a new session, but are not counted as fresh logins (we don't know when they joined). */
    const resumed = th.lastTick === null || now - th.lastTick > STALE_TICK_MS;
    if (th.lastTick !== null && now - th.lastTick > STALE_TICK_MS) {
        for (const data of Object.values(th.players)) {
            const last = data.sessions[data.sessions.length - 1];
            if (last && last[1] === null) last[1] = th.lastTick;
        }
        th.lastOnlineCount = null;
        th.offlineSince = null;
    }

    let known = 0;
    let online = 0;
    let lastLogoutName = null;
    let lastLogoutTime = 0;

    for (const player of tracker.players) {
        const key = playerKey(player);
        if (key === null) continue;

        const state = isPlayerOnline(player, bmInstance);
        if (!th.players[key]) th.players[key] = { name: player.name, sessions: [] };
        const data = th.players[key];
        data.name = player.name;

        if (state === null) continue;
        known++;

        const last = data.sessions[data.sessions.length - 1];
        const open = last && last[1] === null;

        if (state) {
            online++;
            if (!open) {
                data.sessions.push([now, null]);
                if (!resumed) th.recentLogins.push({ key: key, name: player.name, time: now });
            }
        }
        else if (open) {
            last[1] = now;
        }

        if (!state) {
            const closed = data.sessions[data.sessions.length - 1];
            if (closed && closed[1] !== null && closed[1] > lastLogoutTime) {
                lastLogoutTime = closed[1];
                lastLogoutName = player.name;
            }
        }
    }

    /* Forget players removed from the tracker */
    const keys = new Set(tracker.players.map(playerKey).filter(k => k !== null));
    for (const key of Object.keys(th.players)) {
        if (!keys.has(key)) delete th.players[key];
    }

    pruneHistory(th, now);

    const alertsEnabled = tracker.clanAlerts !== false;

    /* Whole clan offline (confirmed for a while to ignore quick reconnects) */
    if (known >= 2) {
        if (online === 0) {
            if (th.lastOnlineCount !== null && th.lastOnlineCount > 0) th.offlineSince = now;
            const confirmMs = Config.trackerIntel.allOfflineConfirmMinutes * MINUTE_MS;
            if (alertsEnabled && th.offlineSince !== null && !th.allOfflineAlerted &&
                now - th.offlineSince >= confirmMs) {
                th.allOfflineAlerted = true;
                alerts.push({ type: 'allOffline', count: known, lastName: lastLogoutName });
            }
        }
        else {
            th.offlineSince = null;
            th.allOfflineAlerted = false;
        }
    }

    /* Several members logging in within a short window */
    if (known >= 2) {
        const threshold = Math.min(Config.trackerIntel.groupLoginThreshold, known);
        const distinct = new Map();
        for (const login of th.recentLogins) distinct.set(login.key, login.name);
        const cooldownMs = Config.trackerIntel.groupLoginCooldownMinutes * MINUTE_MS;

        if (alertsEnabled && distinct.size >= threshold &&
            (th.lastGroupAlert === null || now - th.lastGroupAlert >= cooldownMs)) {
            th.lastGroupAlert = now;
            alerts.push({
                type: 'groupLogin',
                count: distinct.size,
                online: online,
                names: [...distinct.values()],
                minutes: Config.trackerIntel.groupLoginWindowMinutes
            });
            th.recentLogins = [];
        }
    }

    th.lastOnlineCount = known > 0 ? online : th.lastOnlineCount;
    th.lastTick = now;

    return alerts;
}

/**
 *  Removes the history of trackers that no longer exist.
 */
function cleanup(guildId, trackerIds) {
    const history = loadHistory(guildId);
    let changed = false;
    for (const trackerId of Object.keys(history.trackers)) {
        if (!trackerIds.includes(trackerId)) {
            delete history.trackers[trackerId];
            changed = true;
        }
    }
    return changed;
}

/* ------------------------------------------------------------------------- */
/* Schedule analysis                                                          */
/* ------------------------------------------------------------------------- */

function localParts(time, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(time));
    const get = (type) => parts.find(p => p.type === type).value;
    return { hour: parseInt(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

function onlineAt(sessions, time, now) {
    for (const s of sessions) {
        const end = s[1] === null ? now : s[1];
        if (s[0] <= time && time < end) return true;
    }
    return false;
}

/**
 *  Analyses when the members of a tracker are usually online.
 *  @return {Object|null} null if there is no data yet.
 *    hours[0..23]: { anyOnline: 0..1, avgOnline: number }
 *    windows: best raid windows [{ start, end, anyOnline }]
 *    days: number of days covered
 *    players: [{ name, onlineMs7d, lastSeen, online }]
 */
function getSchedule(guildId, trackerId, now = Date.now()) {
    const history = loadHistory(guildId);
    const th = history.trackers[trackerId];
    if (!th) return null;

    const timeZone = Config.general.timezone;
    const players = Object.values(th.players);
    const allSessions = players.map(p => p.sessions);

    let first = null;
    for (const sessions of allSessions) {
        if (sessions.length > 0 && (first === null || sessions[0][0] < first)) first = sessions[0][0];
    }
    if (first === null) return null;

    /* Sample from the first recorded data (max scheduleDays back) */
    const from = Math.max(first, now - Config.trackerIntel.scheduleDays * DAY_MS);
    const buckets = Array.from({ length: 24 }, () => ({ samples: 0, any: 0, members: 0 }));
    const days = new Set();

    for (let t = from; t <= now; t += SAMPLE_STEP_MS) {
        const local = localParts(t, timeZone);
        days.add(local.day);

        let count = 0;
        for (const sessions of allSessions) if (onlineAt(sessions, t, now)) count++;

        const bucket = buckets[local.hour];
        bucket.samples++;
        bucket.members += count;
        if (count > 0) bucket.any++;
    }

    const hours = buckets.map(b => ({
        anyOnline: b.samples > 0 ? b.any / b.samples : null,
        avgOnline: b.samples > 0 ? b.members / b.samples : null
    }));

    /* Best raid windows: 3h windows (circular) with the lowest chance of anyone online */
    const size = 3;
    const candidates = [];
    for (let start = 0; start < 24; start++) {
        let sum = 0, n = 0;
        for (let i = 0; i < size; i++) {
            const h = hours[(start + i) % 24];
            if (h.anyOnline !== null) { sum += h.anyOnline; n++; }
        }
        if (n === size) candidates.push({ start: start, end: (start + size) % 24, anyOnline: sum / n });
    }
    candidates.sort((a, b) => a.anyOnline - b.anyOnline);
    const windows = [];
    for (const c of candidates) {
        const overlaps = windows.some(w => {
            const d = Math.abs(w.start - c.start);
            return Math.min(d, 24 - d) < size;
        });
        if (!overlaps) windows.push(c);
        if (windows.length === 2) break;
    }

    const weekAgo = now - 7 * DAY_MS;
    const playerStats = players.map(p => {
        let onlineMs = 0;
        let lastSeen = null;
        let isOnline = false;
        for (const s of p.sessions) {
            const end = s[1] === null ? now : s[1];
            if (s[1] === null) isOnline = true;
            if (end > weekAgo) onlineMs += end - Math.max(s[0], weekAgo);
            if (lastSeen === null || end > lastSeen) lastSeen = end;
        }
        return { name: p.name, onlineMs7d: onlineMs, lastSeen: lastSeen, online: isOnline };
    }).sort((a, b) => b.onlineMs7d - a.onlineMs7d);

    return {
        hours: hours,
        windows: windows,
        days: Math.max(1, Math.round((now - from) / DAY_MS)),
        timeZone: timeZone,
        players: playerStats
    };
}

module.exports = {
    update: update,
    cleanup: cleanup,
    save: saveHistory,
    getSchedule: getSchedule,
    HISTORY_DIR: HISTORY_DIR,

    /* For tests */
    _reset: function () { for (const k of Object.keys(histories)) delete histories[k]; }
};
