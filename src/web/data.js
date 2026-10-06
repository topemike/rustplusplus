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
 *  Data for the web panel. Every value is picked explicitly: no tokens, credentials or
 *  Rust+ player tokens ever leave this module.
 */

const Constants = require('../util/constants.js');
const DailyStats = require('../util/dailyStats.js');
const DeepSea = require('../handlers/deepSeaHandler.js');
const MarketHandler = require('../handlers/marketHandler.js');
const MarketSearch = require('../util/marketSearch.js');
const RaidHandler = require('../handlers/raidHandler.js');
const Timer = require('../util/timer');
const TrackerIntel = require('../util/trackerIntel.js');

function activeServer(instance) {
    return instance.activeServer !== null && instance.serverList[instance.activeServer] ?
        instance.serverList[instance.activeServer] : null;
}

function server(client, guildId) {
    const instance = client.getInstance(guildId);
    const rustplus = client.rustplusInstances[guildId];
    const srv = activeServer(instance);
    const out = {
        guildName: client.guilds.cache.get(guildId) ? client.guilds.cache.get(guildId).name : '',
        title: srv ? srv.title : null,
        connected: !!(rustplus && rustplus.isOperational),
        players: null, maxPlayers: null, queued: null, map: null, wipeTime: null,
        inGameTime: null, isDay: null
    };
    if (rustplus && rustplus.isOperational && rustplus.info) {
        out.players = rustplus.info.players;
        out.maxPlayers = rustplus.info.maxPlayers;
        out.queued = rustplus.info.queuedPlayers;
        out.map = rustplus.info.map;
        out.wipeTime = rustplus.info.wipeTime ? rustplus.info.wipeTime * 1000 : null;
    }
    if (rustplus && rustplus.isOperational && rustplus.time) {
        out.inGameTime = Timer.convertDecimalToHoursMinutes(rustplus.time.time);
        out.isDay = rustplus.time.isDay();
    }
    return out;
}

function upkeep(client, guildId) {
    const instance = client.getInstance(guildId);
    const rustplus = client.rustplusInstances[guildId];
    const srv = rustplus ? instance.serverList[rustplus.serverId] : null;
    if (!srv) return [];
    const list = [];
    for (const [entityId, entity] of Object.entries(srv.storageMonitors || {})) {
        const content = rustplus.storageMonitors ? rustplus.storageMonitors[entityId] : null;
        const isTc = entity.type === 'toolCupboard' ||
            (content && content.capacity === Constants.STORAGE_MONITOR_TOOL_CUPBOARD_CAPACITY);
        if (!isTc) continue;
        const reachable = entity.reachable !== false && !!content && content.capacity !== 0;
        list.push({
            name: entity.name,
            location: entity.location || null,
            reachable: reachable,
            expiresAt: reachable && content.expiry ? content.expiry * 1000 : null,
            decaying: reachable && !content.expiry
        });
    }
    return list;
}

function deepSea(client, guildId) {
    const instance = client.getInstance(guildId);
    const srv = activeServer(instance);
    if (!srv || !srv.deepSea) return { synced: false };
    const p = DeepSea.predict(srv.deepSea);
    if (!p) return { synced: false };
    return { synced: true, phase: p.phase, isOpen: p.isOpen, closesAt: p.closesAt || null,
        opensFrom: p.opensFrom || null, opensTo: p.opensTo || null };
}

function raid(client, guildId) {
    const incident = RaidHandler.getIncident(guildId);
    if (!incident || incident.endedAt) return null;
    return {
        startedAt: incident.startedAt,
        lastTriggerAt: incident.lastTriggerAt,
        count: incident.count,
        alarms: Object.values(incident.alarms).map(a => ({ name: a.name, count: a.count })),
        acknowledged: !!incident.acknowledgedBy
    };
}

/* Event key (setting name) -> short kind for the panel */
const EVENT_KINDS = {
    cargoShipDetectedSetting: 'cargo', cargoShipLeftSetting: 'cargo', cargoShipEgressSetting: 'cargo',
    cargoShipDockingAtHarborSetting: 'cargo',
    patrolHelicopterDetectedSetting: 'heli', patrolHelicopterLeftSetting: 'heli',
    patrolHelicopterDestroyedSetting: 'heli', heliNearBaseSetting: 'heli', cargoNearBaseSetting: 'cargo',
    bradleyApcDestroyedSetting: 'bradley', bradleyApcRespawnSetting: 'bradley',
    lockedCrateOilRigUnlockedSetting: 'crate', lockedCrateDroppedSetting: 'crate', lockedCrateGoneSetting: 'crate',
    heavyScientistCalledSetting: 'oilrig', chinook47DetectedSetting: 'chinook',
    travelingVendorDetectedSetting: 'vendor', travelingVendorHaltedSetting: 'vendor',
    travelingVendorLeftSetting: 'vendor', vendingMachineDetectedSetting: 'vending',
    deepSeaSetting: 'deepsea'
};

function events(guildId, sinceMs = 14 * 24 * 60 * 60 * 1000) {
    const since = Date.now() - sinceMs;
    return DailyStats.getEvents(guildId).filter(e => e.t >= since).sort((a, b) => b.t - a.t).slice(0, 500)
        .map(e => ({ at: e.t, kind: EVENT_KINDS[e.s] || 'other', text: e.x }));
}

function raids(guildId) {
    return DailyStats.getRaids(guildId).slice().sort((a, b) => b.end - a.end)
        .map(r => ({ startedAt: r.start, endedAt: r.end, count: r.count, alarms: r.alarms }));
}

function trackers(client, guildId) {
    const instance = client.getInstance(guildId);
    const out = [];
    for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
        const bm = client.battlemetricsInstances ? client.battlemetricsInstances[tracker.battlemetricsId] : null;
        const players = tracker.players.map(p => {
            const data = bm && p.playerId && bm.players[p.playerId] ? bm.players[p.playerId] : null;
            return {
                name: p.name,
                steamId: p.steamId || null,
                online: data ? data.status === true : null,
                since: data ? (data.status ? (data.updatedAt ? Date.parse(data.updatedAt) : null) :
                    (data.logoutDate ? Date.parse(data.logoutDate) : null)) : null
            };
        });
        const schedule = TrackerIntel.getSchedule(guildId, trackerId);
        out.push({
            id: trackerId,
            name: tracker.name,
            server: tracker.title,
            players: players,
            schedule: schedule ? {
                days: schedule.days,
                timeZone: schedule.timeZone,
                hours: schedule.hours,
                windows: schedule.windows,
                week: schedule.players.map(p => ({ name: p.name, onlineMs: p.onlineMs7d, lastSeen: p.lastSeen, online: p.online }))
            } : null
        });
    }
    return out;
}

function market(client, guildId) {
    const instance = client.getInstance(guildId);
    const rustplus = client.rustplusInstances[guildId];
    const vms = rustplus && rustplus.mapMarkers ? rustplus.mapMarkers.vendingMachines : [];
    const board = instance.marketBoard && Array.isArray(instance.marketBoard.entries) ? instance.marketBoard.entries : [];
    const name = (id) => client.items.getName(id) || `${id}`;
    const now = Date.now();
    return {
        vendingMachines: (vms || []).length,
        entries: board.map(entry => {
            const { sell } = MarketSearch.collectOffers(vms, entry.itemIds, 'sell');
            return {
                query: entry.query,
                items: entry.itemIds.map(name),
                offers: sell.map(o => {
                    const mark = MarketHandler.getMark(guildId, o, now);
                    return {
                        item: name(o.itemId), quantity: o.quantity, cost: o.cost, currency: name(o.currencyId),
                        unitPrice: o.unitPrice, stock: o.stock, location: o.grid,
                        blueprint: o.itemIsBlueprint,
                        mark: mark.includes('\u{1F195}') ? 'new' : (mark.includes('⬇') ? 'down' : (mark.includes('⬆') ? 'up' : null))
                    };
                })
            };
        })
    };
}

module.exports = {
    overview: function (client, guildId) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const recent = DailyStats.getEvents(guildId).filter(e => e.t >= since);
        const counts = {};
        for (const e of recent) {
            const kind = EVENT_KINDS[e.s] || 'other';
            counts[kind] = (counts[kind] || 0) + 1;
        }
        return {
            server: server(client, guildId),
            raid: raid(client, guildId),
            upkeep: upkeep(client, guildId),
            deepSea: deepSea(client, guildId),
            eventCounts: counts,
            recentEvents: events(guildId, 24 * 60 * 60 * 1000).slice(0, 8)
        };
    },
    trackers: trackers,
    raids: (client, guildId) => ({ active: raid(client, guildId), history: raids(guildId) }),
    market: market,
    events: (client, guildId) => events(guildId)
};
