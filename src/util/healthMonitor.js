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
 *  Health monitor: warns in Discord when the bot is about to go "blind".
 *  - FCM credentials that are about to expire or have expired (no more pairing,
 *    smart alarm, death or login notifications): private message to the owner of the credentials.
 *  - Rust+ connection lost and not recovered after a while.
 */

const Config = require('../../config');
const Constants = require('./constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const { toEpochSeconds, formatDuration } = require('./credentialUtils.js');
const InstanceUtils = require('./instanceUtils.js');

const CHECK_INTERVAL_MS = 60 * 1000;

function getHealthState(instance) {
    if (!instance.hasOwnProperty('healthMonitor') || instance.healthMonitor === null) {
        instance.healthMonitor = { credentialWarnings: {} };
    }
    if (!instance.healthMonitor.hasOwnProperty('credentialWarnings')) {
        instance.healthMonitor.credentialWarnings = {};
    }
    return instance.healthMonitor;
}

async function sendHealthMessage(client, guildId, color, title, description, mentionUserId = null) {
    const instance = client.getInstance(guildId);
    if (!instance.channelId || !instance.channelId.activity) return false;

    const content = {
        embeds: [DiscordEmbeds.getEmbed({
            color: color,
            title: title,
            description: description,
            timestamp: true
        })]
    };
    if (mentionUserId) content.content = `<@${mentionUserId}>`;

    await DiscordMessages.sendMessage(guildId, content, null, instance.channelId.activity);
    return true;
}

/**
 *  Private message (DM) to the owner of the credentials: credential warnings are an admin matter
 *  and are not posted in the team channels.
 *  @return {boolean} true if the message was delivered.
 */
async function sendPrivateMessage(client, guildId, userId, color, title, description) {
    if (!userId) return false;
    try {
        const guild = client.guilds.cache.get(guildId);
        const options = { color: color, title: title, description: description, timestamp: true };
        if (guild && guild.name) options.footer = { text: guild.name };
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [DiscordEmbeds.getEmbed(options)] });
        return true;
    }
    catch (e) {
        client.log(client.intlGet(null, 'warningCap'),
            `Health monitor: could not send a private message to ${userId} (DMs closed?): ${e}`);
        return false;
    }
}

async function checkCredentials(client, guildId) {
    let credentials;
    try {
        credentials = InstanceUtils.readCredentialsFile(guildId);
    }
    catch (e) {
        return;
    }

    const instance = client.getInstance(guildId);
    const state = getHealthState(instance);
    const warnBeforeSeconds = Config.healthMonitor.credentialsWarnHoursBefore * 3600;
    const now = Math.floor(Date.now() / 1000);
    let changed = false;

    for (const [steamId, credential] of Object.entries(credentials)) {
        if (steamId === 'hoster' || credential === null || typeof credential !== 'object') continue;

        const expire = toEpochSeconds(credential.expire_date);
        if (expire === null) continue;

        const isHoster = steamId === credentials.hoster;
        const warned = state.credentialWarnings[steamId] || {};
        const remaining = expire - now;
        const userId = credential.discord_user_id || null;

        if (remaining <= 0) {
            if (warned.expired === expire) continue;

            await sendPrivateMessage(client, guildId, userId, Constants.COLOR_INACTIVE,
                client.intlGet(guildId, isHoster ? 'healthCredentialsExpiredHosterTitle' :
                    'healthCredentialsExpiredTitle'),
                client.intlGet(guildId, isHoster ? 'healthCredentialsExpiredHosterDesc' :
                    'healthCredentialsExpiredDesc', { steamId: steamId }));

            /* Marked even if the DM could not be delivered, so it is not retried every minute */
            state.credentialWarnings[steamId] = { soon: expire, expired: expire };
            changed = true;
        }
        else if (remaining <= warnBeforeSeconds) {
            if (warned.soon === expire) continue;

            await sendPrivateMessage(client, guildId, userId, Constants.COLOR_CARGO_SHIP_ENTERS_EGRESS_STAGE,
                client.intlGet(guildId, 'healthCredentialsExpireSoonTitle', { time: formatDuration(remaining) }),
                client.intlGet(guildId, isHoster ? 'healthCredentialsExpireSoonHosterDesc' :
                    'healthCredentialsExpireSoonDesc', {
                    steamId: steamId,
                    date: `<t:${expire}:F>`
                }));

            state.credentialWarnings[steamId] = { soon: expire, expired: warned.expired || null };
            changed = true;
        }
    }

    /* Forget warnings for credentials that no longer exist */
    for (const steamId of Object.keys(state.credentialWarnings)) {
        if (!credentials.hasOwnProperty(steamId)) {
            delete state.credentialWarnings[steamId];
            changed = true;
        }
    }

    if (changed) client.setInstance(guildId, instance);
}

async function checkRustplusConnection(client, guildId) {
    if (!client.healthDisconnect) client.healthDisconnect = new Object();
    const tracker = client.healthDisconnect[guildId] || { since: null, alerted: false };

    const reconnecting = client.activeRustplusInstances[guildId] === true &&
        client.rustplusReconnecting[guildId] === true;

    if (reconnecting) {
        if (tracker.since === null) tracker.since = Date.now();

        const elapsedMs = Date.now() - tracker.since;
        const limitMs = Config.healthMonitor.disconnectAlertMinutes * 60 * 1000;
        if (!tracker.alerted && elapsedMs >= limitMs) {
            const credentials = safeReadCredentials(guildId);
            const hosterUserId = credentials && credentials.hoster && credentials[credentials.hoster] ?
                credentials[credentials.hoster].discord_user_id : null;

            tracker.alerted = await sendHealthMessage(client, guildId, Constants.COLOR_INACTIVE,
                client.intlGet(guildId, 'healthRustplusDownTitle'),
                client.intlGet(guildId, 'healthRustplusDownDesc', { time: formatDuration(elapsedMs / 1000) }),
                hosterUserId);
        }
    }
    else {
        if (tracker.alerted && client.activeRustplusInstances[guildId] === true) {
            await sendHealthMessage(client, guildId, Constants.COLOR_ACTIVE,
                client.intlGet(guildId, 'healthRustplusBackTitle'),
                client.intlGet(guildId, 'healthRustplusBackDesc', {
                    time: formatDuration((Date.now() - tracker.since) / 1000)
                }));
        }
        tracker.since = null;
        tracker.alerted = false;
    }

    client.healthDisconnect[guildId] = tracker;
}

function safeReadCredentials(guildId) {
    try {
        return InstanceUtils.readCredentialsFile(guildId);
    }
    catch (e) {
        return null;
    }
}

async function check(client) {
    for (const guildId of client.guilds.cache.keys()) {
        try {
            await checkCredentials(client, guildId);
            await checkRustplusConnection(client, guildId);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Health monitor: ${e}`, 'error');
        }
    }
}

module.exports = {
    start: function (client) {
        if (client.healthMonitorIntervalId) clearInterval(client.healthMonitorIntervalId);
        setTimeout(check, 30 * 1000, client);
        client.healthMonitorIntervalId = setInterval(check, CHECK_INTERVAL_MS, client);
    }
};
