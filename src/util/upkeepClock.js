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
 *  The Tool Cupboard protection end that Rust+ sends ("protectionExpiry") is "now + protected time",
 *  but the game does not always recalculate the protected time: between recalculations the end it
 *  sends moves forward with the clock, so the countdown seems to stop (the game showed 8h 39m while
 *  Rust+ still said 9h 04m). The real end does not move unless materials are added or the base
 *  cost changes, so:
 *  - keep the earliest end seen since the last time materials were added (it is the freshest one);
 *  - when materials are added (or the end comes earlier), take the new value.
 */

const UPKEEP_ITEMS = [-151838493 /* wood */, -2099697608 /* stones */, 69511070 /* metal frags */,
    317398316 /* high quality metal */];

function amounts(items) {
    const out = {};
    for (const id of UPKEEP_ITEMS) out[id] = 0;
    for (const item of items || []) {
        if (out.hasOwnProperty(item.itemId)) out[item.itemId] += item.quantity;
    }
    return out;
}

module.exports = {
    /**
     *  @param {Object} store Where the state is kept (in memory, e.g. rustplus.upkeepClock).
     *  @param {number} rawExpiry Protection end from Rust+ (unix seconds, 0 = decaying).
     *  @return {number} Corrected protection end (unix seconds, 0 = decaying).
     */
    correct: function (store, entityId, rawExpiry, items) {
        if (!rawExpiry) {
            delete store[entityId];
            return 0;
        }
        const now = amounts(items);
        const state = store[entityId];
        const added = !state || UPKEEP_ITEMS.some(id => now[id] > state.amounts[id]);
        const expiry = added ? rawExpiry : Math.min(state.expiry, rawExpiry);
        store[entityId] = { expiry: expiry, amounts: now };
        return expiry;
    },

    amounts: amounts
};
