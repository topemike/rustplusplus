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

const TimeLib = require('../util/timer.js');

class Time {
    constructor(time, rustplus, client) {
        this._dayLengthMinutes = time.dayLengthMinutes;
        this._timeScale = time.timeScale;
        this._sunrise = time.sunrise;
        this._sunset = time.sunset;
        this._time = time.time;

        this._rustplus = rustplus;
        this._client = client;

        this._startTime = time.time;
        this._timeTillDay = new Object();
        this._timeTillNight = new Object();
        this._timeTillActive = false;

        this.loadTimeTillConfig();
    }

    /* Getters and Setters */
    get dayLengthMinutes() { return this._dayLengthMinutes; }
    set dayLengthMinutes(dayLengthMinutes) { this._dayLengthMinutes = dayLengthMinutes; }
    get timeScale() { return this._timeScale; }
    set timeScale(timeScale) { this._timeScale = timeScale; }
    get sunrise() { return this._sunrise; }
    set sunrise(sunrise) { this._sunrise = sunrise; }
    get sunset() { return this._sunset; }
    set sunset(sunset) { this._sunset = sunset; }
    get time() { return this._time; }
    set time(time) { this._time = time; }
    get rustplus() { return this._rustplus; }
    set rustplus(rustplus) { this._rustplus = rustplus; }
    get client() { return this._client; }
    set client(client) { this._client = client; }
    get startTime() { return this._startTime; }
    set startTime(startTime) { this._startTime = startTime; }
    get timeTillDay() { return this._timeTillDay; }
    set timeTillDay(timeTillDay) { this._timeTillDay = timeTillDay; }
    get timeTillNight() { return this._timeTillNight; }
    set timeTillNight(timeTillNight) { this._timeTillNight = timeTillNight; }
    get timeTillActive() { return this._timeTillActive; }
    set timeTillActive(timeTillActive) { this._timeTillActive = timeTillActive; }

    /* Change checkers */
    isDayLengthMinutesChanged(time) { return ((this.dayLengthMinutes) !== (time.dayLengthMinutes)); }
    isTimeScaleChanged(time) { return ((this.timeScale) !== (time.timeScale)); }
    isSunriseChanged(time) { return ((this.sunrise) !== (time.sunrise)); }
    isSunsetChanged(time) { return ((this.sunset) !== (time.sunset)); }
    isTimeChanged(time) { return ((this.time) !== (time.time)); }

    /* Other checkers */
    isDay() { return ((this.time >= this.sunrise) && (this.time < this.sunset)); }
    isNight() { return !this.isDay(); }
    isTurnedDay(time) { return (this.isNight() && time.time >= time.sunrise && time.time < time.sunset); }
    isTurnedNight(time) { return (this.isDay() && !(time.time >= time.sunrise && time.time < time.sunset)); }

    loadTimeTillConfig() {
        let instance = this.client.getInstance(this.rustplus.guildId);

        if (instance.serverList[this.rustplus.serverId].timeTillDay !== null) {
            this.timeTillDay = instance.serverList[this.rustplus.serverId].timeTillDay;
        }
        if (instance.serverList[this.rustplus.serverId].timeTillNight !== null) {
            this.timeTillNight = instance.serverList[this.rustplus.serverId].timeTillNight;
        }

        this.timeTillActive =
            Object.keys(this.timeTillDay).length !== 0 &&
            Object.keys(this.timeTillNight).length !== 0;
    }

    updateTime(time, now = Date.now()) {
        /* When the in-game clock last moved (a server with time progression turned off never does) */
        if (this._advancedAt === undefined || time.time !== this.time) this._advancedAt = now;
        this._updatedAt = now;
        this.measureSpeed(time, now);
        this.dayLengthMinutes = time.dayLengthMinutes;
        this.timeScale = time.timeScale;
        this.sunrise = time.sunrise;
        this.sunset = time.sunset;
        this.time = time.time;
    }

    /*
     *  How fast the in-game clock goes, measured with the real clock, separately by day and by night
     *  (many servers have shorter nights). Smoothed, kept up to date all the time and saved per server.
     *  Samples that cross sunrise/sunset or jump (skip-night plugins, restarts) are not used.
     */
    measureSpeed(time, now) {
        const last = this._lastSample;
        this._lastSample = { t: now, time: time.time };
        if (!last) return;
        const seconds = (now - last.t) / 1000;
        let hours = time.time - last.time;
        if (hours < 0) hours += 24;
        if (seconds < 5 || seconds > 120 || hours <= 0 || hours > 1) return;
        const wasDay = last.time >= this.sunrise && last.time < this.sunset;
        const isDay = time.time >= time.sunrise && time.time < time.sunset;
        if (wasDay !== isDay) return;

        if (!this._speed) this._speed = this.loadSpeed();
        const key = isDay ? 'day' : 'night';
        const rate = hours / seconds;                           /* in-game hours per real second */
        const old = this._speed[key];
        this._speed[key] = old ? old * 0.9 + rate * 0.1 : rate;
        if (!this._speedSavedAt || now - this._speedSavedAt > 5 * 60 * 1000) {
            this._speedSavedAt = now;
            try {
                const instance = this.client.getInstance(this.rustplus.guildId);
                const server = instance.serverList[this.rustplus.serverId];
                if (server) {
                    server.daySpeed = this._speed;
                    this.client.setInstance(this.rustplus.guildId, instance);
                }
            }
            catch (e) { /* kept in memory */ }
        }
    }

    loadSpeed() {
        try {
            const instance = this.client.getInstance(this.rustplus.guildId);
            const server = instance.serverList[this.rustplus.serverId];
            if (server && server.daySpeed) return { day: server.daySpeed.day || null, night: server.daySpeed.night || null };
        }
        catch (e) { /* none saved */ }
        return { day: null, night: null };
    }

    /* Real seconds until sunset (by day) or sunrise (by night), or null while it is not known */
    isTimeStopped() {
        if (this._advancedAt === undefined || this._updatedAt === undefined) return false;
        return (this._updatedAt - this._advancedAt) > Time.STOPPED_AFTER_MS;
    }

    secondsTillDayOrNight() {
        if (this.isTimeStopped()) return null;     /* the clock does not move: no day/night change */
        if (!this._speed) this._speed = this.loadSpeed();
        const rate = this.isDay() ? this._speed.day : this._speed.night;
        if (!rate) return null;
        let hours = this.isDay() ? this.sunset - this.time : this.sunrise - this.time;
        if (hours < 0) hours += 24;
        /* Counted from when the in-game time was read; data older than 2 minutes is not trusted */
        const since = this._updatedAt !== undefined ? (Date.now() - this._updatedAt) / 1000 : 0;
        if (since > 120) return null;
        return Math.max(0, hours / rate - since);
    }

    getTimeTillDayOrNight(ignore = '') {
        /* Measured speed of the in-game clock (always up to date); the old table only as a fallback */
        const seconds = this.secondsTillDayOrNight();
        if (seconds !== null) return TimeLib.secondsToFullScale(seconds, ignore);
        if (this.isTimeStopped()) return null;
        if (this._updatedAt !== undefined && Date.now() - this._updatedAt > 120 * 1000) return null;

        if (!this.timeTillActive) {
            return null;
        }

        let object = null;
        if (this.isDay()) {
            object = this.timeTillNight;
        }
        else {
            object = this.timeTillDay;
        }

        let time = this.time;
        let closest = Object.keys(object).map(Number).reduce(function (a, b) {
            return (Math.abs(b - time) < Math.abs(a - time) ? b : a);
        });

        return TimeLib.secondsToFullScale(object[closest], ignore);
    }

}

/* In-game clock unchanged for longer than this (real time): time progression is off */
Time.STOPPED_AFTER_MS = 5 * 60 * 1000;

module.exports = Time;