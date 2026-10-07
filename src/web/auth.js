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
 *  Web panel authentication: "Log in with Discord" (OAuth2, scope identify only) and signed
 *  session cookies. Access is granted to members of the Discord servers where the bot is,
 *  optionally only with a role. The bot checks membership itself, so no extra Discord scopes
 *  are needed and the panel never sees passwords.
 */

const Axios = require('axios');
const Crypto = require('crypto');
const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'rpp_session';
const STATE_COOKIE = 'rpp_state';
const SESSION_DAYS = 7;
const ACCESS_CACHE_MS = 60 * 1000;
const SECRET_FILE = Path.join(__dirname, '..', '..', 'instances', 'web-session-secret');

let secret = null;
const accessCache = new Map();

function getSecret() {
    if (secret) return secret;
    if (Config.web.sessionSecret) {
        secret = Config.web.sessionSecret;
        return secret;
    }
    try {
        if (Fs.existsSync(SECRET_FILE)) secret = Fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    catch (e) { /* create a new one */ }
    if (!secret || secret.length < 32) {
        secret = Crypto.randomBytes(48).toString('hex');
        Fs.mkdirSync(Path.dirname(SECRET_FILE), { recursive: true });
        Fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    }
    return secret;
}

function sign(value) {
    return Crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function encode(payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${sign(data)}`;
}

function decode(token) {
    if (typeof token !== 'string') return null;
    const [data, signature] = token.split('.');
    if (!data || !signature) return null;
    const expected = sign(data);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !Crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        if (!payload.exp || payload.exp < Date.now()) return null;
        return payload;
    }
    catch (e) {
        return null;
    }
}

function parseCookies(req) {
    const cookies = {};
    for (const part of `${req.headers.cookie || ''}`.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

function cookie(name, value, maxAgeSeconds) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function publicUrl() {
    return `https://${Config.web.domain}`;
}

function redirectUri() {
    return `${publicUrl()}/callback`;
}

/* ------------------------------------------------------------------------- */

/**
 *  Redirect to Discord. A random state, bound to a short-lived cookie, protects against CSRF.
 */
function loginRedirect(res) {
    const state = Crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
        client_id: Config.discord.clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: 'identify',
        state: state,
        prompt: 'none'
    });
    res.writeHead(302, {
        Location: `https://discord.com/oauth2/authorize?${params.toString()}`,
        'Set-Cookie': cookie(STATE_COOKIE, encode({ state: state, exp: Date.now() + 10 * 60 * 1000 }), 600)
    });
    res.end();
}

/**
 *  Discord sends the user back here with a code; exchange it for the user identity.
 *  @return {Object|null} { id, name, avatar } or null.
 */
async function handleCallback(req, url) {
    const cookies = parseCookies(req);
    const state = decode(cookies[STATE_COOKIE]);
    if (!state || state.state !== url.searchParams.get('state')) return null;
    const code = url.searchParams.get('code');
    if (!code) return null;

    const token = await Axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({
        client_id: Config.discord.clientId,
        client_secret: Config.web.clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri()
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });

    const user = await Axios.get(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${token.data.access_token}` }, timeout: 10000
    });

    /* The access token is not kept: only the identity is needed */
    return {
        id: user.data.id,
        name: user.data.global_name || user.data.username,
        avatar: user.data.avatar ? `https://cdn.discordapp.com/avatars/${user.data.id}/${user.data.avatar}.png?size=64` : null
    };
}

function sessionCookie(user) {
    return cookie(SESSION_COOKIE, encode({ ...user, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 }),
        SESSION_DAYS * 24 * 60 * 60);
}

function clearCookies() {
    return [cookie(SESSION_COOKIE, '', 0), cookie(STATE_COOKIE, '', 0)];
}

function getSession(req) {
    return decode(parseCookies(req)[SESSION_COOKIE]);
}

/**
 *  Discord servers (where the bot is) that this user may see in the panel.
 *  Member of the server, not on the bot's blacklist, and able to see the bot's channels (or with
 *  RPP_WEB_ROLE if it is set; Administrators skip that last check).
 *  @return {Array} [guildId]
 */
function canSeeBot(guild, member, instance) {
    const role = Config.web.role;
    if (role) return member.roles.cache.some(r => r.name === role || r.id === role);

    const channelId = instance && instance.channelId ? instance.channelId.information : null;
    const channel = channelId && guild.channels && guild.channels.cache ? guild.channels.cache.get(channelId) : null;
    if (channel && typeof channel.permissionsFor === 'function') {
        const perms = channel.permissionsFor(member);
        return !!perms && perms.has(require('discord.js').PermissionFlagsBits.ViewChannel);
    }
    /* Channels not created yet: the bot's /role, or any member if there is none */
    if (instance && instance.role) return member.roles.cache.some(r => r.id === instance.role || r.name === instance.role);
    return true;
}

async function allowedGuilds(client, userId) {
    const cached = accessCache.get(userId);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) return cached.guilds;

    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
        let member = null;
        try {
            member = await guild.members.fetch(userId);
        }
        catch (e) {
            continue;   /* not a member */
        }
        /* Never someone on the bot's blacklist, administrators included (an admin can take
           themselves off it). Then: the panel role if RPP_WEB_ROLE is set; if not, the same people
           who can see the bot's channels (#information), which follows the bot's /role setup. */
        const Discord = require('discord.js');
        let instance = null;
        try { instance = client.getInstance(guild.id); } catch (e) { instance = null; }
        if (instance && instance.blacklist && Array.isArray(instance.blacklist.discordIds) &&
            instance.blacklist.discordIds.includes(member.id)) continue;
        const isAdmin = member.permissions && member.permissions.has &&
            member.permissions.has(Discord.PermissionFlagsBits.Administrator);
        if (!isAdmin && !canSeeBot(guild, member, instance)) continue;
        guilds.push(guild.id);
    }
    accessCache.set(userId, { at: Date.now(), guilds: guilds });
    return guilds;
}

module.exports = {
    loginRedirect: loginRedirect,
    handleCallback: handleCallback,
    sessionCookie: sessionCookie,
    clearCookies: clearCookies,
    getSession: getSession,
    allowedGuilds: allowedGuilds,
    encode: encode,
    decode: decode,
    _resetCache: () => accessCache.clear()
};
