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

const Axios = require('axios');

const Constants = require('../util/constants.js');
const Utils = require('../util/utils.js');

module.exports = {
    scrape: async function (url) {
        try {
            return await Axios.get(url);
        }
        catch (e) {
            return {};
        }
    },

    scrapeSteamProfilePicture: async function (client, steamId) {
        const response = await module.exports.scrape(`${Constants.STEAM_PROFILES_URL}${steamId}`);

        if (response.status !== 200) {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfilePicture', {
                link: `${Constants.STEAM_PROFILES_URL}${steamId}`
            }), 'error');
            return null;
        }

        let png = response.data.match(/<img src="(.*_full.jpg)(.*?(?="))/);
        if (png) {
            return png[1];
        }

        return null;
    },

    scrapeSteamProfileName: async function (client, steamId) {
        const link = `${Constants.STEAM_PROFILES_URL}${steamId}`;
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en;q=0.9' };

        /* 1) The XML version of the profile: small and stable, has the name even for private profiles */
        const xml = await module.exports.scrapeWith(`${link}/?xml=1`, headers);
        if (xml.status === 200 && typeof xml.data === 'string') {
            const m = xml.data.match(/<steamID>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/steamID>/) ||
                xml.data.match(/<steamID>([^<]+)<\/steamID>/);
            if (m && m[1].trim() !== '') return Utils.decodeHtml(m[1].trim());
        }

        /* 2) The normal profile page */
        const response = await module.exports.scrapeWith(link, headers);
        if (response.status === 200 && typeof response.data === 'string') {
            let data = /class="actual_persona_name">(.+?)<\/span>/m.exec(response.data);
            if (data) return Utils.decodeHtml(data[1]);
            data = /<title>Steam Community :: (.+?)<\/title>/m.exec(response.data);
            if (data) return Utils.decodeHtml(data[1]);
        }

        client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'failedToScrapeProfileName', {
            link: link
        }) + ` (HTTP ${response.status || xml.status || 'sin respuesta'})`, 'error');
        return null;
    },

    scrapeWith: async function (url, headers) {
        try {
            return await Axios.get(url, { headers: headers, timeout: 15000 });
        }
        catch (e) {
            return e && e.response ? e.response : {};
        }
    },
}