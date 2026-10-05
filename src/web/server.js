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
 *  Private web panel. Plain Node http server (no extra dependencies), meant to run behind a
 *  reverse proxy with HTTPS (see docker-compose.web.yml and web/Caddyfile).
 *  Only enabled when RPP_WEB_DOMAIN and RPP_WEB_CLIENT_SECRET are set.
 */

const Fs = require('fs');
const Http = require('http');
const Path = require('path');

const Auth = require('./auth.js');
const Config = require('../../config');
const Data = require('./data.js');

const PUBLIC_DIR = Path.join(__dirname, 'public');
const STATIC = {
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};

const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; " +
        "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000'
};

function send(res, status, body, type, extra = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
}

function sendJson(res, status, data) {
    send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function sendFile(res, file, type) {
    try {
        send(res, 200, Fs.readFileSync(Path.join(PUBLIC_DIR, file)), type);
    }
    catch (e) {
        send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
}

function redirect(res, location, extra = {}) {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: location, ...extra });
    res.end();
}

const API = {
    '/api/overview': Data.overview,
    '/api/trackers': Data.trackers,
    '/api/raids': Data.raids,
    '/api/market': Data.market,
    '/api/events': Data.events
};

async function handle(client, req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');

    if (STATIC[path]) return sendFile(res, STATIC[path][0], STATIC[path][1]);
    if (path === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

    if (path === '/login') return Auth.loginRedirect(res);

    if (path === '/callback') {
        if (url.searchParams.get('error')) return redirect(res, '/?denied=1');
        let user = null;
        try {
            user = await Auth.handleCallback(req, url);
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Web login failed: ${e.message}`, 'error');
        }
        if (!user) return redirect(res, '/?error=login', { 'Set-Cookie': Auth.clearCookies() });
        client.log(client.intlGet(null, 'infoCap'), `Web panel login: ${user.name} (${user.id})`);
        return redirect(res, '/', { 'Set-Cookie': [Auth.sessionCookie(user), Auth.clearCookies()[1]] });
    }

    if (path === '/logout') return redirect(res, '/', { 'Set-Cookie': Auth.clearCookies() });

    const session = Auth.getSession(req);
    const isApi = path.startsWith('/api/');

    if (!session) {
        if (isApi) return sendJson(res, 401, { error: 'login' });
        return sendFile(res, 'login.html', 'text/html; charset=utf-8');
    }

    const guilds = await Auth.allowedGuilds(client, session.id);
    if (guilds.length === 0) {
        if (isApi) return sendJson(res, 403, { error: 'forbidden' });
        return sendFile(res, 'forbidden.html', 'text/html; charset=utf-8');
    }

    if (path === '/api/me') {
        return sendJson(res, 200, {
            user: { name: session.name, avatar: session.avatar },
            guilds: guilds.map(id => ({ id: id, name: client.guilds.cache.get(id) ? client.guilds.cache.get(id).name : id }))
        });
    }

    if (API[path]) {
        const guildId = url.searchParams.get('guild') || guilds[0];
        if (!guilds.includes(guildId)) return sendJson(res, 403, { error: 'forbidden' });
        try {
            return sendJson(res, 200, API[path](client, guildId));
        }
        catch (e) {
            client.log(client.intlGet(null, 'errorCap'), `Web API ${path}: ${e.message}`, 'error');
            return sendJson(res, 500, { error: 'internal' });
        }
    }

    if (path === '/' || !isApi) return sendFile(res, 'index.html', 'text/html; charset=utf-8');
    return sendJson(res, 404, { error: 'not found' });
}

module.exports = {
    handle: handle,

    start: function (client) {
        if (!Config.web.domain || !Config.web.clientSecret) {
            client.log(client.intlGet(null, 'infoCap'),
                'Web panel disabled (set RPP_WEB_DOMAIN and RPP_WEB_CLIENT_SECRET to enable it).');
            return null;
        }
        const server = Http.createServer((req, res) => {
            handle(client, req, res).catch(e => {
                client.log(client.intlGet(null, 'errorCap'), `Web panel: ${e.message}`, 'error');
                if (!res.headersSent) send(res, 500, 'Error', 'text/plain; charset=utf-8');
            });
        });
        /* A web problem (e.g. port in use) must never take the bot down */
        server.on('error', (e) => {
            client.log(client.intlGet(null, 'errorCap'), `Web panel could not start: ${e.message}`, 'error');
        });
        server.listen(Config.web.port, () => {
            client.log(client.intlGet(null, 'infoCap'),
                `Web panel listening on port ${Config.web.port} for https://${Config.web.domain}`);
        });
        client.webServer = server;
        return server;
    }
};
