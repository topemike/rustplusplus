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
 *  Posts the daily summary (util/dailyStats.js) once a day in the activity channel.
 */

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DailyStats = require('../util/dailyStats.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');

const CHECK_MS = 5 * 60 * 1000;

function getSummaryEmbed(client, guildId, now = Date.now()) {
    const summary = DailyStats.buildSummary(client, guildId, now);
    return DiscordEmbeds.getEmbed({
        color: Constants.COLOR_DEFAULT,
        title: summary.title,
        description: client.intlGet(guildId, 'summaryDescription'),
        fields: summary.fields,
        timestamp: true
    });
}

async function check(client, now = Date.now()) {
    for (const guildId of client.guilds.cache.keys()) {
        try {
            const instance = client.getInstance(guildId);
            if (!instance || !instance.channelId || !instance.channelId.activity) continue;
            if (!DailyStats.isDue(guildId, now)) continue;

            /* First run after installing: start counting today, first summary tomorrow */
            if (DailyStats.isFirstRun(guildId)) {
                DailyStats.markSent(guildId, now);
                continue;
            }

            await DiscordMessages.sendMessage(guildId, { embeds: [getSummaryEmbed(client, guildId, now)] },
                null, instance.channelId.activity);
            DailyStats.markSent(guildId, now);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Daily summary: ${e}`, 'error');
        }
    }
}

module.exports = {
    getSummaryEmbed: getSummaryEmbed,
    check: check,

    start: function (client) {
        if (!Config.dailySummary.enabled) return;
        if (client.dailySummaryIntervalId) clearInterval(client.dailySummaryIntervalId);
        setTimeout(() => check(client), 60 * 1000);
        client.dailySummaryIntervalId = setInterval(() => check(client), CHECK_MS);
    }
};
