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
 *  Upkeep per material for a Tool Cupboard.
 *  Rust+ only gives the TC contents and the total protection time, not what the base costs.
 *  The cost is learned from every pair of snapshots in which the materials only went down by
 *  "upkeep-sized" amounts, online or offline:
 *  - A material can never be consumed faster than amount / protection time (every material lasts
 *    at least the protection time), so a bigger drop is somebody taking items: that interval is
 *    skipped. Any increase (refill) is skipped too.
 *  - If the protection time jumps while the materials do not change, the base cost changed
 *    (built, upgraded or demolished): the learned costs are scaled by that factor.
 *  The proportions are finally anchored to the protection time from the game, which is the time
 *  of the material that runs out first.
 */

const HOUR_MS = 60 * 60 * 1000;
/* Minimum clean time measured before giving numbers */
const MIN_HOURS = 1;
/* Older measurements fade out: only about the last day counts */
const MAX_HOURS = 24;
/* Tolerances when classifying an interval */
const DROP_SLACK = 10;            /* items */
const DROP_FACTOR = 1.5;
const LEARNED_FACTOR = 3;
const MIN_INTERVAL_MS = 20 * 60 * 1000;
const EXPIRY_JUMP_MS = 10 * 60 * 1000;
/* Longer gaps between snapshots are not used (bot offline...) */
const MAX_GAP_MS = 2 * HOUR_MS;

const MATERIALS = [
    { key: 'wood', itemId: '-151838493' },
    { key: 'stones', itemId: '-2099697608' },
    { key: 'metal', itemId: '69511070' },
    { key: 'hqm', itemId: '317398316' }
];

function counts(items) {
    const out = {};
    for (const m of MATERIALS) out[m.key] = 0;
    for (const item of (Array.isArray(items) ? items : [])) {
        const m = MATERIALS.find(x => x.itemId === `${item.itemId}`);
        if (m) out[m.key] += item.quantity || 0;
    }
    return out;
}

function capHistory(st) {
    if (st.hours > MAX_HOURS) {
        const f = MAX_HOURS / st.hours;
        for (const k of Object.keys(st.used)) st.used[k] *= f;
        st.hours = MAX_HOURS;
    }
}

/**
 *  Classify the interval between two snapshots and learn from it.
 *  @return {string} 'clean' | 'refill' | 'taken' | 'cost' | 'skip'
 */
function learn(st, prev, cur) {
    const dt = cur.t - prev.t;
    if (dt <= 0 || dt > MAX_GAP_MS || !prev.expiry || !cur.expiry) return 'skip';

    if (MATERIALS.some(m => cur.c[m.key] > prev.c[m.key])) return 'refill';

    const gameHours = (prev.expiry * 1000 - prev.t) / HOUR_MS;
    if (gameHours <= 0) return 'skip';
    const drops = {};
    /* Upkeep is paid in small chunks every few minutes, so short intervals may contain one */
    const dtH = Math.max(dt, MIN_INTERVAL_MS) / HOUR_MS;
    const known = st.hours >= MIN_HOURS;
    for (const m of MATERIALS) {
        const d = prev.c[m.key] - cur.c[m.key];
        /* Upkeep can never take more than amount / protection time per hour from a material,
           and once learned, not much more than its usual cost */
        let bound = prev.c[m.key] * dtH / gameHours * DROP_FACTOR + DROP_SLACK;
        if (known) bound = Math.min(bound, ((st.used[m.key] || 0) / st.hours) * dtH * LEARNED_FACTOR + DROP_SLACK);
        if (d > bound) return 'taken';
        drops[m.key] = d;
    }

    /* Same materials (only upkeep-sized drops) but the protection end moved: the cost changed */
    const expiryMove = (cur.expiry - prev.expiry) * 1000;
    if (Math.abs(expiryMove) > EXPIRY_JUMP_MS) {
        const prevLeft = prev.expiry * 1000 - cur.t, curLeft = cur.expiry * 1000 - cur.t;
        if (prevLeft > 0 && curLeft > 0) {
            const f = prevLeft / curLeft;   /* > 1: the base costs more now */
            for (const k of Object.keys(st.used)) st.used[k] *= f;
        }
        return 'cost';
    }

    for (const m of MATERIALS) st.used[m.key] = (st.used[m.key] || 0) + drops[m.key];
    st.hours += dt / HOUR_MS;
    capHistory(st);
    return 'clean';
}

function fmtAmount(n) {
    return Math.round(n).toLocaleString('es-ES');
}

module.exports = {
    MATERIALS: MATERIALS,
    fmtAmount: fmtAmount,

    /* Short text with the material that runs out first and what to add for 24 h, or null */
    shortAdvice: function (client, guildId, b) {
        if (!b || b.materials.length === 0) return null;
        const first = b.materials[0];
        const name = client.intlGet(guildId, `upkeepMat_${first.key}`);
        if (b.add.length === 0) return client.intlGet(guildId, 'upkeepFirstOut', { material: name });
        return client.intlGet(guildId, 'upkeepAddFor24', {
            material: name,
            items: b.add.map(a => `${fmtAmount(a.amount)} ${client.intlGet(guildId, `upkeepMat_${a.key}`)}`).join(', ')
        });
    },
    counts: counts,

    /**
     *  Feed a fresh snapshot of a TC (any time, team online or not). State in entity.upkeepStats.
     *  @return {string} How the interval since the previous snapshot was classified.
     */
    observe: function (entity, items, expirySeconds, now = Date.now()) {
        if (!entity.upkeepStats || entity.upkeepStats.window !== undefined) {
            entity.upkeepStats = { used: {}, hours: 0, last: null };
        }
        const st = entity.upkeepStats;
        const cur = { t: now, c: counts(items), expiry: expirySeconds || 0 };
        const result = st.last ? learn(st, st.last, cur) : 'skip';
        st.last = cur;
        return result;
    },

    /**
     *  Measured consumption per hour, or null while there is not enough data.
     */
    rates: function (entity) {
        const st = entity.upkeepStats;
        if (!st || st.hours < MIN_HOURS) return null;
        const rates = {};
        for (const m of MATERIALS) if ((st.used[m.key] || 0) > 0) rates[m.key] = st.used[m.key] / st.hours;
        return Object.keys(rates).length > 0 ? rates : null;
    },

    /**
     *  How long each material lasts and what to add.
     *  @param {number} expirySeconds Protection end (unix seconds) from the game, 0 = decaying.
     *  @return {Object|null} { materials: [{ key, itemId, count, perHour, hours, limiting }],
     *                          add: [{ key, itemId, amount }] (to reach targetHours) }
     */
    breakdown: function (entity, items, expirySeconds, now = Date.now(), targetHours = 24) {
        const rates = module.exports.rates(entity);
        if (!rates) return null;
        const c = counts(items);

        let list = MATERIALS.filter(m => rates[m.key]).map(m => ({
            key: m.key, itemId: m.itemId, count: c[m.key], perHour: rates[m.key], hours: c[m.key] / rates[m.key]
        }));

        /* Anchor to the game: the first material to run out lasts exactly the protection time */
        const gameHours = expirySeconds ? (expirySeconds * 1000 - now) / HOUR_MS : 0;
        const minHours = Math.min(...list.map(x => x.hours));
        if (gameHours > 0 && minHours > 0) {
            const f = minHours / gameHours;
            list = list.map(x => Object.assign(x, { perHour: x.perHour * f, hours: x.hours / f }));
        }

        const limitingHours = Math.min(...list.map(x => x.hours));
        for (const x of list) x.limiting = x.hours <= limitingHours + 0.01;

        const add = list.filter(x => x.hours < targetHours).map(x => ({
            key: x.key, itemId: x.itemId,
            amount: Math.ceil((targetHours - x.hours) * x.perHour / 100) * 100
        })).filter(x => x.amount > 0);

        return { materials: list.sort((a, b) => a.hours - b.hours), add: add };
    }
};
