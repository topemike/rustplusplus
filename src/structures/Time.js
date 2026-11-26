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
        const hadTime = typeof this.time === 'number';
        const wasDay = hadTime ? this.isDay() : null;
        this.measureSpeed(time, now);
        this.dayLengthMinutes = time.dayLengthMinutes;
        this.timeScale = time.timeScale;
        this.sunrise = time.sunrise;
        this.sunset = time.sunset;
        this.time = time.time;
        if (hadTime && wasDay !== this.isDay()) this.logTransition(now);
        this.recordPrediction(now);
    }

    /* What the bot predicted, kept for 15 min: checked in the log when day or night really starts */
    recordPrediction(now) {
        if (!this._predictions) this._predictions = [];
        let seconds = null;
        try { seconds = this.secondsTillDayOrNight(now); } catch (e) { seconds = null; }
        if (seconds !== null) this._predictions.push({ at: now, eta: now + seconds * 1000, day: this.isDay() });
        while (this._predictions.length && now - this._predictions[0].at > 15 * 60 * 1000) this._predictions.shift();
    }

    logTransition(now) {
        try {
            const fmt = (ms) => new Date(ms).toISOString().slice(11, 19);
            const before = (this._predictions || []).filter(p => p.day !== this.isDay());
            const pick = (ago) => {
                let best = null;
                for (const p of before) if (now - p.at >= ago && (!best || p.at > best.at)) best = p;
                return best;
            };
            const parts = [];
            for (const ago of [10, 5, 1]) {
                const p = pick(ago * 60 * 1000);
                if (p) parts.push(`${ago} min before it said ${fmt(p.eta)} (${Math.round((p.eta - now) / 1000)} s off)`);
            }
            const sp = this._speed || {};
            const rate = (r) => r ? `${(r * 60).toFixed(3)} h/min` : '-';
            this.rustplus.log(this.client.intlGet(null, 'infoCap'),
                `${this.isDay() ? 'Day' : 'Night'} started at ${fmt(now)} (game ${Number(this.time).toFixed(2)}, ` +
                `sunrise ${this.sunrise}, sunset ${this.sunset}; speed day ${rate(sp.day)}, night ${rate(sp.night)}). ` +
                (parts.length ? parts.join('; ') : 'No earlier prediction.'));
        }
        catch (e) { /* only a log line */ }
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
        if (seconds < 5 || seconds > 120 || hours <= 0 || hours > 1) { this._binAcc = null; return; }
        const wasDay = last.time >= this.sunrise && last.time < this.sunset;
        const isDay = time.time >= time.sunrise && time.time < time.sunset;
        if (wasDay !== isDay) { if (this._speed && this._binAcc) this.closeBin(this._binAcc); return; }

        if (!this._speed) this._speed = this.loadSpeed();
        const key = isDay ? 'day' : 'night';
        const rate = hours / seconds;                           /* in-game hours per real second */
        const old = this._speed[key];
        this._speed[key] = old ? old * 0.9 + rate * 0.1 : rate;

        /* The clock does not go at the same speed all day (Rust's time curve: faster in the morning and
           evening, slower at midday): the speed is also learned per half hour of game time */
        /* Day and night kept apart: the half hour where the sun sets (or rises) has some day and some
           night in it, and the night goes much faster; mixed, the end of the day looked faster than
           it is and the night was announced too early */
        if (!this._speed.bins) this._speed.bins = new Array(Time.BINS).fill(null);
        if (!this._speed.nightBins) this._speed.nightBins = new Array(Time.BINS).fill(null);
        /* The speed of a half hour is the whole half hour (game hours / real seconds spent in it), not
           its last readings: the speed changes inside it too */
        let mid = last.time + hours / 2;
        if (mid >= 24) mid -= 24;
        const bin = Math.floor(mid * Time.BINS / 24) % Time.BINS;
        const acc = this._binAcc;
        if (acc && (acc.bin !== bin || acc.isDay !== isDay)) this.closeBin(acc);
        if (!this._binAcc || this._binAcc.bin !== bin || this._binAcc.isDay !== isDay) {
            this._binAcc = { bin, isDay, hours: 0, seconds: 0 };
        }
        this._binAcc.hours += hours;
        this._binAcc.seconds += seconds;
        /* First time here: a first value at once (the whole half hour is folded in when it ends) */
        const binsOfSide = isDay ? this._speed.bins : this._speed.nightBins;
        if (!binsOfSide[bin]) binsOfSide[bin] = rate;
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

    /* A half hour is over: what was measured in it goes into its learned speed */
    closeBin(acc) {
        this._binAcc = null;
        const step = 24 / Time.BINS;
        if (!acc || acc.seconds <= 0 || acc.hours < step * 0.2) return;   /* too little of it seen */
        const binsOfSide = acc.isDay ? this._speed.bins : this._speed.nightBins;
        const rate = acc.hours / acc.seconds;
        const old = binsOfSide[acc.bin];
        const tag = `${acc.isDay ? 'd' : 'n'}${acc.bin}`;
        const fromOldVersion = Array.isArray(this._speed.oldBins) && this._speed.oldBins.includes(tag);
        if (fromOldVersion) this._speed.oldBins = this._speed.oldBins.filter(x => x !== tag);
        binsOfSide[acc.bin] = old && !fromOldVersion ? old * 0.5 + rate * 0.5 : rate;
    }

    loadSpeed() {
        try {
            const instance = this.client.getInstance(this.rustplus.guildId);
            const server = instance.serverList[this.rustplus.serverId];
            if (server && server.daySpeed) {
                const ok = (b) => Array.isArray(b) && b.length === Time.BINS;
                const bins = ok(server.daySpeed.bins) ? server.daySpeed.bins.slice() : new Array(Time.BINS).fill(null);
                let nightBins = ok(server.daySpeed.nightBins) ? server.daySpeed.nightBins.slice() : null;
                /* Speeds learned by the old version were biased to the end of each half hour: the first
                   whole half hour measured replaces them (instead of averaging), so it is right after
                   one game day instead of several */
                let oldBins = Array.isArray(server.daySpeed.oldBins) ? server.daySpeed.oldBins.slice() : null;
                if (!nightBins) {
                    /* Saved before day and night were kept apart: the night half hours go to the night,
                       and the half hours with sunrise or sunset in them (day and night mixed) are
                       learned again */
                    nightBins = new Array(Time.BINS).fill(null);
                    const step = 24 / Time.BINS;
                    for (let b = 0; b < Time.BINS; b++) {
                        const from = b * step, to = from + step;
                        const mixed = [this.sunrise, this.sunset].some(x => typeof x === 'number' && x > from && x < to);
                        const mid = from + step / 2;
                        const night = !(mid >= this.sunrise && mid < this.sunset);
                        if (mixed) bins[b] = null;
                        else if (night) { nightBins[b] = bins[b]; bins[b] = null; }
                    }
                    oldBins = [...bins.map((r, b) => r ? `d${b}` : null), ...nightBins.map((r, b) => r ? `n${b}` : null)]
                        .filter(Boolean);
                }
                return { day: server.daySpeed.day || null, night: server.daySpeed.night || null, bins, nightBins,
                    oldBins: oldBins || [] };
            }
        }
        catch (e) { /* none saved */ }
        return { day: null, night: null, bins: new Array(Time.BINS).fill(null), nightBins: new Array(Time.BINS).fill(null) };
    }

    /* Speed at a game time: learned for that half hour, else the nearest learned half hours of the same
       part (day / night), else the average of that part */
    rateAt(gameTime, isDay) {
        const bins = (isDay ? this._speed.bins : this._speed.nightBins) || [];
        const bin = Math.floor(gameTime * Time.BINS / 24) % Time.BINS;
        if (bins[bin]) return bins[bin];
        const sameSide = () => true;   /* each list only has speeds of its own part (day / night) */
        for (let d = 1; d <= 4; d++) {
            const a = (bin + d) % Time.BINS, b = (bin - d + Time.BINS) % Time.BINS;
            const ra = bins[a] && sameSide(a) ? bins[a] : null, rb = bins[b] && sameSide(b) ? bins[b] : null;
            if (ra && rb) return (ra + rb) / 2;
            if (ra || rb) return ra || rb;
        }
        /* Not learned near here yet: the average of what is learned for that part of the day */
        let sum = 0, n = 0;
        for (let b = 0; b < Time.BINS; b++) if (bins[b] && sameSide(b)) { sum += bins[b]; n++; }
        if (n >= 4) return sum / n;
        return isDay ? this._speed.day : this._speed.night;
    }

    /* The in-game time now (the last reading moved forward at the learned speed) */
    currentTime(nowMs = Date.now()) {
        if (typeof this.time !== 'number' || this._updatedAt === undefined || this.isTimeStopped()) return this.time;
        if (!this._speed) this._speed = this.loadSpeed();
        let left = Math.min(120, Math.max(0, (nowMs - this._updatedAt) / 1000)), t = this.time;
        while (left > 0) {
            const day = t >= this.sunrise && t < this.sunset;
            const rate = this.rateAt(t % 24, day);
            if (!rate) return this.time;
            const dt = Math.min(left, 1);
            t += rate * dt; if (t >= 24) t -= 24;
            left -= dt;
        }
        return t;
    }

    /* Real seconds until sunset (by day) or sunrise (by night), or null while it is not known */
    isTimeStopped() {
        if (this._advancedAt === undefined || this._updatedAt === undefined) return false;
        return (this._updatedAt - this._advancedAt) > Time.STOPPED_AFTER_MS;
    }

    secondsTillDayOrNight(nowMs = Date.now()) {
        if (this.isTimeStopped()) return null;     /* the clock does not move: no day/night change */
        if (!this._speed) this._speed = this.loadSpeed();
        const isDay = this.isDay();
        if (!(isDay ? this._speed.day : this._speed.night)) return null;
        let hours = isDay ? this.sunset - this.time : this.sunrise - this.time;
        if (hours < 0) hours += 24;
        /* Counted from when the in-game time was read; data older than 2 minutes is not trusted */
        const since = this._updatedAt !== undefined ? (nowMs - this._updatedAt) / 1000 : 0;
        if (since > 120) return null;

        /* Half hour by half hour, each at its own speed */
        const step = 24 / Time.BINS;
        let t = this.time, left = hours, seconds = 0;
        while (left > 1e-9) {
            const binEnd = (Math.floor(t / step) + 1) * step;
            const seg = Math.min(left, binEnd - t);
            const rate = this.rateAt(t % 24, isDay);
            if (!rate) return null;
            seconds += seg / rate;
            left -= seg;
            t += seg;
            if (t >= 24) t -= 24;
        }
        return Math.max(0, seconds - since);
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
/* Speed learned per half hour of game time */
Time.BINS = 48;

module.exports = Time;