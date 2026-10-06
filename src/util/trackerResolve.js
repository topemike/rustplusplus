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
 *  Works out who to add to a tracker from whatever the user pastes:
 *  - BattleMetrics player id or link (battlemetrics.com/players/123)
 *  - Steam ID64 or Steam profile link (steamcommunity.com/profiles/7656... or /id/vanity)
 *  - A player name
 *  The BattleMetrics player is then looked up with the API on the tracker's server, so it is
 *  found even when the player is offline or the Steam name differs a bit.
 */

const Axios = require('axios');

const Scrape = require('./scrape.js');

const STEAM_ID_REGEX = /^7656\d{13}$/;

/**
 *  @return {Object} { kind: 'battlemetrics'|'steam'|'vanity'|'name', value }
 */
function parseInput(raw) {
    const text = `${raw || ''}`.trim();
    let m;
    if ((m = text.match(/battlemetrics\.com\/(?:rcon\/)?players\/(\d+)/i))) return { kind: 'battlemetrics', value: m[1] };
    if ((m = text.match(/steamcommunity\.com\/profiles\/(7656\d{13})/i))) return { kind: 'steam', value: m[1] };
    if ((m = text.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i))) return { kind: 'vanity', value: m[1] };
    if (STEAM_ID_REGEX.test(text)) return { kind: 'steam', value: text };
    if (/^\d+$/.test(text)) return { kind: 'battlemetrics', value: text };
    return { kind: 'name', value: text };
}

async function steamIdFromVanity(vanity) {
    try {
        const response = await Axios.get(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`);
        const m = `${response.data}`.match(/<steamID64>(\d{17})<\/steamID64>/);
        return m ? m[1] : null;
    }
    catch (e) {
        return null;
    }
}

/* Players of the tracker's server matching a search (name or Steam ID), most recently seen first */
async function searchBattlemetrics(bmInstance, query) {
    if (!bmInstance || !bmInstance.id || !query) return [];
    const url = `https://api.battlemetrics.com/players?filter[search]=${encodeURIComponent(`"${query}"`)}` +
        `&filter[servers]=${bmInstance.id}&page[size]=25`;
    const data = await bmInstance.request(url);
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map(p => ({
        id: `${p.id}`,
        name: p.attributes ? p.attributes.name : null,
        updatedAt: p.attributes && p.attributes.updatedAt ? Date.parse(p.attributes.updatedAt) : 0
    })).filter(p => p.name).sort((a, b) => b.updatedAt - a.updatedAt);
}

function pickByName(candidates, name) {
    if (!name) return null;
    const exact = candidates.filter(p => p.name === name);
    if (exact.length > 0) return exact[0];
    const lower = name.toLowerCase();
    const loose = candidates.filter(p => p.name.toLowerCase() === lower);
    return loose.length > 0 ? loose[0] : null;
}

function onlineMatch(bmInstance, name) {
    if (!bmInstance || !bmInstance.players || !name) return null;
    const id = Object.keys(bmInstance.players).find(e => bmInstance.players[e].name === name);
    return id ? { id: id, name: name } : null;
}

/**
 *  @return {Object} { name, steamId, playerId, found: bool, input: kind }
 */
async function resolve(client, bmInstance, raw) {
    const input = parseInput(raw);
    let steamId = null, playerId = null, name = null;

    if (input.kind === 'battlemetrics') {
        playerId = input.value;
        if (bmInstance && bmInstance.players && bmInstance.players[playerId]) {
            name = bmInstance.players[playerId].name;
        }
        else if (bmInstance) {
            const data = await bmInstance.request(`https://api.battlemetrics.com/players/${playerId}`);
            if (data && data.data && data.data.attributes) name = data.data.attributes.name;
        }
        return { name: name || '-', steamId: null, playerId: playerId, found: name !== null, input: input.kind };
    }

    if (input.kind === 'vanity') {
        steamId = await steamIdFromVanity(input.value);
        if (!steamId) return { name: input.value, steamId: null, playerId: null, found: false, input: input.kind };
    }
    else if (input.kind === 'steam') {
        steamId = input.value;
    }

    if (steamId) {
        name = await Scrape.scrapeSteamProfileName(client, steamId);
        /* 1) Online right now with the same name, 2) search the Steam ID, 3) search the Steam name */
        let match = onlineMatch(bmInstance, name);
        if (!match) {
            const byId = await searchBattlemetrics(bmInstance, steamId);
            match = byId.length === 1 ? byId[0] : pickByName(byId, name);
        }
        if (!match && name) match = pickByName(await searchBattlemetrics(bmInstance, name), name);
        return {
            name: name || (match ? match.name : '-'), steamId: steamId, playerId: match ? match.id : null,
            found: !!match, input: input.kind
        };
    }

    /* A name */
    name = input.value;
    let match = onlineMatch(bmInstance, name) || pickByName(await searchBattlemetrics(bmInstance, name), name);
    return { name: match ? match.name : name, steamId: null, playerId: match ? match.id : null, found: !!match,
        input: input.kind };
}

module.exports = {
    parseInput: parseInput,
    resolve: resolve,
    searchBattlemetrics: searchBattlemetrics
};
