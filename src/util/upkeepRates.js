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
 *  The cost is learned by watching the materials go down while the whole team is offline (nobody
 *  adds or takes anything, so every drop is upkeep). The measured proportions are then anchored to
 *  the protection time from the game, which is the time of the material that runs out first.
 */

const HOUR_MS = 60 * 60 * 1000;
/* Minimum offline time measured before giving numbers */
const MIN_HOURS = 2;
/* Older measurements fade out: only about the last day counts */
const MAX_HOURS = 24;

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

function addToHistory(st, window) {
    const hours = (window.tLast - window.t0) / HOUR_MS;
    if (hours <= 0) return;
    for (const m of MATERIALS) {
        st.used[m.key] = (st.used[m.key] || 0) + Math.max(0, window.c0[m.key] - window.cLast[m.key]);
    }
    st.hours += hours;
    if (st.hours > MAX_HOURS) {
        const f = MAX_HOURS / st.hours;
        for (const k of Object.keys(st.used)) st.used[k] *= f;
        st.hours = MAX_HOURS;
    }
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
     *  Feed a fresh snapshot of a TC. Stores the learning state in entity.upkeepStats.
     */
    observe: function (entity, items, teamOffline, now = Date.now()) {
        if (!entity.upkeepStats) entity.upkeepStats = { used: {}, hours: 0, window: null };
        const st = entity.upkeepStats;
        const c = counts(items);

        if (!teamOffline) {
            if (st.window) addToHistory(st, st.window);
            st.window = null;
            return;
        }
        if (!st.window) {
            st.window = { t0: now, c0: c, tLast: now, cLast: c };
            return;
        }
        /* Something was added (should not happen offline): close the window and start again */
        if (MATERIALS.some(m => c[m.key] > st.window.cLast[m.key])) {
            addToHistory(st, st.window);
            st.window = { t0: now, c0: c, tLast: now, cLast: c };
            return;
        }
        st.window.tLast = now;
        st.window.cLast = c;
    },

    /**
     *  Measured consumption per hour, or null while there is not enough data.
     */
    rates: function (entity) {
        const st = entity.upkeepStats;
        if (!st) return null;
        let hours = st.hours;
        const used = Object.assign({}, st.used);
        if (st.window) {
            hours += (st.window.tLast - st.window.t0) / HOUR_MS;
            for (const m of MATERIALS) used[m.key] = (used[m.key] || 0) + Math.max(0, st.window.c0[m.key] - st.window.cLast[m.key]);
        }
        if (hours < MIN_HOURS) return null;
        const rates = {};
        for (const m of MATERIALS) if ((used[m.key] || 0) > 0) rates[m.key] = used[m.key] / hours;
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
