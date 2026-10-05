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
 *  Extra map events that Rust+ exposes but the base bot ignored:
 *  - Bradley APC destroyed: an Explosion marker inside Launch Site (that is not the
 *    Patrol Helicopter crashing), plus a respawn timer.
 *  - Locked crates (Crate markers): where they appear (Chinook drop, Cargo Ship...)
 *    and when they disappear (looted or despawned).
 *  - Unknown marker types are logged once, to discover new content (e.g. Deep Sea).
 *  - Patrol Helicopter / Cargo Ship near the team base (set in-game with !base).
 */

const Constants = require('../util/constants.js');
const Map = require('../util/map.js');
const Timer = require('../util/timer');

const TYPE_EXPLOSION = 2;
const TYPE_CH47 = 4;
const TYPE_CARGO_SHIP = 5;
const TYPE_CRATE = 6;
const TYPE_PATROL_HELICOPTER = 8;
const KNOWN_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const MINUTE_MS = 60 * 1000;

/* An explosion this close (m) to where the Patrol Helicopter was last seen, shortly after it
   disappeared, is the helicopter crash, not the Bradley. */
const HELI_CRASH_DISTANCE = 400;
const HELI_CRASH_WINDOW_MS = 3 * MINUTE_MS;
/* Extra margin around the Launch Site radius where the Bradley can be destroyed. */
const LAUNCH_SITE_MARGIN = 100;
/* Ignore further explosions at Launch Site for a while (debris, multiple markers). */
const BRADLEY_DEDUPE_MS = 10 * MINUTE_MS;
/* A crate appearing this close to a Cargo Ship / oil rig belongs to it. */
const CARGO_SHIP_CRATE_DISTANCE = 150;
const OIL_RIG_CRATE_DISTANCE = 150;
/* A crate appearing while a Chinook is on the map (or just left) was dropped by it. */
const CHINOOK_RECENT_MS = 3 * MINUTE_MS;
/* Warn when the Patrol Helicopter / Cargo Ship comes this close to the base (in grids), and
   again when it moves away past the leave distance (a margin, so it does not flap). */
const NEAR_BASE_GRIDS = 3;
const LEAVE_BASE_GRIDS = 3.5;
const BASE_CLEAR_WORDS = ['clear', 'remove', 'delete', 'borrar', 'quitar'];
const BASE_INFO_WORDS = ['info', 'status', 'estado', '?'];

class ExtraEvents {
    constructor(mapMarkers) {
        this.mapMarkers = mapMarkers;
        this.reset();
    }

    get rustplus() { return this.mapMarkers.rustplus; }
    get client() { return this.mapMarkers.client; }

    reset() {
        if (this.bradleyRespawnTimer) this.bradleyRespawnTimer.stop();
        this.bradleyRespawnTimer = null;
        this.bradleyDestroyedAt = null;
        this.bradleyDestroyedLocation = null;

        this.crates = [];
        this.lastHelis = {};          /* id -> { x, y, lastSeen } */
        this.lastHeliGone = null;     /* { x, y, time } */
        this.lastChinookSeen = null;  /* time */
        this.seenExplosions = new Set();
        this.loggedUnknownTypes = new Set();
        this.nearBase = {};           /* 'type:id' -> { near, lastGrids } */
    }

    getServer() {
        const instance = this.client.getInstance(this.rustplus.guildId);
        return instance.serverList[this.rustplus.serverId];
    }

    getBradleyRespawnMs() {
        const server = this.getServer();
        return server && server.bradleyRespawnTimeMs ? server.bradleyRespawnTimeMs :
            Constants.DEFAULT_BRADLEY_RESPAWN_TIME_MS;
    }

    getMonuments(token) {
        const map = this.rustplus.map;
        if (!map || !map.monuments) return [];
        return map.monuments.filter(m => m.token === token);
    }

    getMonumentRadius(token, fallback) {
        const info = this.rustplus.map && this.rustplus.map.monumentInfo ?
            this.rustplus.map.monumentInfo[token] : null;
        return info && info.radius ? info.radius : fallback;
    }

    isNear(x, y, points, distance) {
        return points.some(p => Map.getDistance(x, y, p.x, p.y) <= distance);
    }

    getPos(marker) {
        return Map.getPos(marker.x, marker.y, this.rustplus.info.correctedMapSize, this.rustplus);
    }

    /* --------------------------------------------------------------------- */

    update(mapMarkers, now = Date.now()) {
        const markers = mapMarkers.markers;
        this.logUnknownTypes(markers);
        this.updateHeliPositions(markers, now);
        if (markers.some(m => m.type === TYPE_CH47)) this.lastChinookSeen = now;
        this.updateExplosions(markers, now);
        this.updateCrates(markers, now);
        this.updateNearBase(markers);
    }

    logUnknownTypes(markers) {
        for (const marker of markers) {
            if (KNOWN_TYPES.includes(marker.type) || this.loggedUnknownTypes.has(marker.type)) continue;
            this.loggedUnknownTypes.add(marker.type);
            this.rustplus.log(this.client.intlGet(null, 'infoCap'),
                `Unknown map marker type ${marker.type} at x=${Math.round(marker.x)} y=${Math.round(marker.y)}` +
                ` ${JSON.stringify(marker)}`);
        }
    }

    updateHeliPositions(markers, now) {
        const current = markers.filter(m => m.type === TYPE_PATROL_HELICOPTER);
        const currentIds = new Set(current.map(m => m.id));

        for (const [id, heli] of Object.entries(this.lastHelis)) {
            if (!currentIds.has(Number(id)) && !currentIds.has(id)) {
                this.lastHeliGone = { x: heli.x, y: heli.y, time: now };
                delete this.lastHelis[id];
            }
        }
        for (const heli of current) {
            this.lastHelis[heli.id] = { x: heli.x, y: heli.y, lastSeen: now };
        }
    }

    isHeliCrash(x, y, now) {
        const gone = this.lastHeliGone;
        return gone !== null && now - gone.time <= HELI_CRASH_WINDOW_MS &&
            Map.getDistance(x, y, gone.x, gone.y) <= HELI_CRASH_DISTANCE;
    }

    updateExplosions(markers, now) {
        const explosions = markers.filter(m => m.type === TYPE_EXPLOSION);
        const currentIds = new Set(explosions.map(m => m.id));

        for (const explosion of explosions) {
            if (this.seenExplosions.has(explosion.id)) continue;
            this.seenExplosions.add(explosion.id);
            if (this.rustplus.isFirstPoll) continue;

            const launchSites = this.getMonuments('launchsite');
            const radius = this.getMonumentRadius('launchsite', 250) + LAUNCH_SITE_MARGIN;
            const atLaunchSite = this.isNear(explosion.x, explosion.y, launchSites, radius);
            const pos = this.getPos(explosion);

            if (atLaunchSite && !this.isHeliCrash(explosion.x, explosion.y, now)) {
                if (this.bradleyDestroyedAt !== null && now - this.bradleyDestroyedAt < BRADLEY_DEDUPE_MS) continue;
                this.onBradleyDestroyed(pos, now);
            }
            else {
                this.rustplus.log(this.client.intlGet(null, 'infoCap'),
                    `Explosion marker at ${pos.string}` +
                    `${this.isHeliCrash(explosion.x, explosion.y, now) ? ' (Patrol Helicopter crash)' : ''}`);
            }
        }

        /* Forget explosions that are gone */
        for (const id of [...this.seenExplosions]) {
            if (!currentIds.has(id)) this.seenExplosions.delete(id);
        }
    }

    onBradleyDestroyed(pos, now) {
        const respawnMs = this.getBradleyRespawnMs();
        this.bradleyDestroyedAt = now;
        this.bradleyDestroyedLocation = pos.string;

        this.rustplus.sendEvent(
            this.rustplus.notificationSettings.bradleyApcDestroyedSetting,
            this.client.intlGet(this.rustplus.guildId, 'bradleyApcDestroyed', {
                location: pos.string,
                time: Timer.secondsToFullScale(respawnMs / 1000)
            }),
            'bradley',
            Constants.COLOR_BRADLEY_APC_DESTROYED);

        if (this.bradleyRespawnTimer) this.bradleyRespawnTimer.stop();
        this.bradleyRespawnTimer = new Timer.timer(this.notifyBradleyRespawn.bind(this), respawnMs);
        this.bradleyRespawnTimer.start();
    }

    notifyBradleyRespawn() {
        if (this.bradleyRespawnTimer) this.bradleyRespawnTimer.stop();
        this.bradleyRespawnTimer = null;

        this.rustplus.sendEvent(
            this.rustplus.notificationSettings.bradleyApcRespawnSetting,
            this.client.intlGet(this.rustplus.guildId, 'bradleyApcShouldBeBack'),
            'bradley',
            Constants.COLOR_BRADLEY_APC_RESPAWN);
    }

    classifyCrate(crate, markers, now) {
        const cargoShips = markers.filter(m => m.type === TYPE_CARGO_SHIP);
        if (this.isNear(crate.x, crate.y, cargoShips, CARGO_SHIP_CRATE_DISTANCE)) return 'cargo';

        const oilRigs = [...this.getMonuments('oil_rig_small'), ...this.getMonuments('large_oil_rig')];
        if (this.isNear(crate.x, crate.y, oilRigs, OIL_RIG_CRATE_DISTANCE)) return 'oilRig';

        if (this.lastChinookSeen !== null && now - this.lastChinookSeen <= CHINOOK_RECENT_MS) return 'chinook';

        return 'other';
    }

    updateCrates(markers, now) {
        const current = markers.filter(m => m.type === TYPE_CRATE);
        const currentIds = new Set(current.map(m => m.id));

        for (const marker of current) {
            if (this.crates.some(c => c.id === marker.id)) continue;

            const pos = this.getPos(marker);
            const crate = {
                id: marker.id, x: marker.x, y: marker.y, location: pos, appearedAt: now,
                kind: this.classifyCrate(marker, markers, now),
                silent: this.rustplus.isFirstPoll
            };
            this.crates.push(crate);

            /* Oil rig crates are already covered by the "heavy scientists called" notifications */
            if (crate.silent || crate.kind === 'oilRig') continue;

            const phrase = crate.kind === 'chinook' ? 'lockedCrateDroppedByChinook' :
                crate.kind === 'cargo' ? 'lockedCrateOnCargoShip' : 'lockedCrateDetected';
            this.rustplus.sendEvent(
                this.rustplus.notificationSettings.lockedCrateDroppedSetting,
                this.client.intlGet(this.rustplus.guildId, phrase, { location: pos.string }),
                'crate',
                Constants.COLOR_LOCKED_CRATE_DROPPED);
        }

        for (const crate of [...this.crates]) {
            if (currentIds.has(crate.id)) continue;
            this.crates = this.crates.filter(c => c.id !== crate.id);

            if (crate.silent || crate.kind === 'oilRig') continue;

            this.rustplus.sendEvent(
                this.rustplus.notificationSettings.lockedCrateGoneSetting,
                this.client.intlGet(this.rustplus.guildId, 'lockedCrateGone', {
                    location: crate.location.string,
                    time: Timer.secondsToFullScale((now - crate.appearedAt) / 1000)
                }),
                'crate',
                Constants.COLOR_LOCKED_CRATE_GONE);
        }
    }

    /* --------------------------------------------------------------------- */
    /* Commands                                                              */
    /* --------------------------------------------------------------------- */

    getBase() {
        const server = this.getServer();
        return server && server.baseLocation ? server.baseLocation : null;
    }

    formatGrids(grids) {
        const instance = this.client.getInstance(this.rustplus.guildId);
        const language = instance.generalSettings && instance.generalSettings.language ?
            instance.generalSettings.language : 'en';
        try {
            return grids.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        }
        catch (e) {
            return grids.toFixed(1);
        }
    }

    updateNearBase(markers) {
        const base = this.getBase();
        if (!base) {
            this.nearBase = {};
            return;
        }

        const tracked = markers.filter(m => m.type === TYPE_PATROL_HELICOPTER || m.type === TYPE_CARGO_SHIP);
        const keys = new Set(tracked.map(m => `${m.type}:${m.id}`));
        for (const key of Object.keys(this.nearBase)) {
            if (!keys.has(key)) delete this.nearBase[key];
        }

        for (const marker of tracked) {
            const key = `${marker.type}:${marker.id}`;
            const grids = Map.getDistance(marker.x, marker.y, base.x, base.y) / Map.gridDiameter;
            const state = this.nearBase[key] || (this.nearBase[key] = { near: false, lastGrids: null });
            const approaching = state.lastGrids !== null && grids < state.lastGrids;
            const isHeli = marker.type === TYPE_PATROL_HELICOPTER;

            if (!state.near && grids <= NEAR_BASE_GRIDS) {
                state.near = true;
                const phrase = (isHeli ? 'heliNearBase' : 'cargoNearBase') + (approaching ? 'Approaching' : '');
                this.rustplus.sendEvent(
                    isHeli ? this.rustplus.notificationSettings.heliNearBaseSetting :
                        this.rustplus.notificationSettings.cargoNearBaseSetting,
                    this.client.intlGet(this.rustplus.guildId, phrase, {
                        distance: this.formatGrids(grids),
                        location: this.getPos(marker).string
                    }),
                    isHeli ? 'heli' : 'cargo',
                    isHeli ? Constants.COLOR_PATROL_HELICOPTER_NEAR_BASE : Constants.COLOR_CARGO_SHIP_NEAR_BASE);
            }
            else if (state.near && grids > LEAVE_BASE_GRIDS) {
                state.near = false;
                this.rustplus.sendEvent(
                    isHeli ? this.rustplus.notificationSettings.heliNearBaseSetting :
                        this.rustplus.notificationSettings.cargoNearBaseSetting,
                    this.client.intlGet(this.rustplus.guildId, isHeli ? 'heliLeftBase' : 'cargoLeftBase', {
                        location: this.getPos(marker).string
                    }),
                    isHeli ? 'heli' : 'cargo',
                    isHeli ? Constants.COLOR_PATROL_HELICOPTER_LEFT_BASE : Constants.COLOR_CARGO_SHIP_LEFT_BASE);
            }
            state.lastGrids = grids;
        }
    }

    /* !base: mark the base at the caller's position. !base info / !base clear */
    getCommandBase(command, callerSteamId) {
        const guildId = this.rustplus.guildId;
        const arg = command.trim().split(/\s+/).slice(1).join(' ').toLowerCase();
        const instance = this.client.getInstance(guildId);
        const server = instance.serverList[this.rustplus.serverId];
        if (!server) return this.client.intlGet(guildId, 'noData');

        if (BASE_CLEAR_WORDS.includes(arg)) {
            delete server.baseLocation;
            this.client.setInstance(guildId, instance);
            this.nearBase = {};
            return this.client.intlGet(guildId, 'baseCleared');
        }
        if (BASE_INFO_WORDS.includes(arg)) {
            if (!server.baseLocation) return this.client.intlGet(guildId, 'baseNotSet');
            return this.client.intlGet(guildId, 'baseInfo', {
                location: this.getPos(server.baseLocation).string,
                name: server.baseLocation.setBy || '?'
            });
        }

        const player = this.rustplus.team ? this.rustplus.team.getPlayer(callerSteamId) : null;
        if (!player || typeof player.x !== 'number' || typeof player.y !== 'number') {
            return this.client.intlGet(guildId, 'baseNoPosition');
        }
        server.baseLocation = { x: player.x, y: player.y, setBy: player.name, setAt: Date.now() };
        this.client.setInstance(guildId, instance);
        this.nearBase = {};
        return this.client.intlGet(guildId, 'baseSet', {
            location: this.getPos(server.baseLocation).string,
            distance: NEAR_BASE_GRIDS
        });
    }

    getCommandBradley(isInfoChannel = false, now = Date.now()) {
        const guildId = this.rustplus.guildId;
        if (this.bradleyDestroyedAt === null) {
            return isInfoChannel ? this.client.intlGet(guildId, 'noData') :
                this.client.intlGet(guildId, 'bradleyApcNoData');
        }

        const sinceSeconds = (now - this.bradleyDestroyedAt) / 1000;
        const leftSeconds = (this.bradleyDestroyedAt + this.getBradleyRespawnMs() - now) / 1000;
        const format = (s) => Timer.secondsToFullScale(s, isInfoChannel ? 's' : '');

        if (leftSeconds > 0) {
            return this.client.intlGet(guildId, isInfoChannel ? 'bradleyApcDestroyedAgoShort' :
                'bradleyApcDestroyedAgo', { time: format(sinceSeconds), time2: format(leftSeconds) });
        }
        return this.client.intlGet(guildId, isInfoChannel ? 'bradleyApcShouldBeUpShort' :
            'bradleyApcShouldBeUp', { time: format(sinceSeconds) });
    }

    getCommandCrate(isInfoChannel = false, now = Date.now()) {
        const guildId = this.rustplus.guildId;
        const crates = this.crates.filter(c => c.kind !== 'oilRig');
        if (crates.length === 0) {
            return isInfoChannel ? this.client.intlGet(guildId, 'notActive') :
                this.client.intlGet(guildId, 'lockedCrateNone');
        }

        const format = (s) => Timer.secondsToFullScale(s, isInfoChannel ? 's' : '');
        return crates.map(c => this.client.intlGet(guildId, isInfoChannel ? 'lockedCrateAtShort' : 'lockedCrateAt', {
            location: isInfoChannel ? c.location.location : c.location.string,
            time: format((now - c.appearedAt) / 1000)
        })).join(isInfoChannel ? ', ' : ' | ');
    }
}

module.exports = ExtraEvents;
