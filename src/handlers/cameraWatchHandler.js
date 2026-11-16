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
 *  Camera watch: the bot looks at the base cameras by itself and warns in Discord when someone is seen.
 *  - Works while the bot's account is not in the game (Rust+ answers "player_online" otherwise).
 *  - Warns for players that are not of the team (teammates come with their name; players sleeping in the
 *    base are ignored); with @everyone when nobody of the team is online.
 *  - One warning when someone appears; again only if more people appear or they are still there
 *    after REPEAT_MS. "Gone" after QUIET_MS without seeing anyone.
 *  Commands: !vigilar (status) · !vigilar <CODE> (add) · !vigilar quitar <CODE> · !vigilar on / off
 *            !vigilar amigo STEAMID|NAME / quitaramigo / amigos · !vigilar pausa 30m / seguir
 */

const CameraProbe = require('../util/cameraProbe.js');

const TICK_MS = 5 * 1000;           /* one camera looked at every 5 s (in turns) */
const LOOK_MS = 3 * 1000;           /* how long each look lasts */
const QUIET_MS = 3 * 60 * 1000;     /* nobody seen (on any camera) for this long: the next one is a new warning */
const REPEAT_MS = 10 * 60 * 1000;   /* still around: remind every 10 minutes */

const state = {};                   /* guildId -> { index, cams: { id: { lastSeen, lastAlert, lastCount } }, busy } */

function settings(instance) {
    if (!instance.cameraWatch) instance.cameraWatch = { enabled: true, cameras: [] };
    if (!Array.isArray(instance.cameraWatch.friends)) instance.cameraWatch.friends = [];
    if (!Array.isArray(instance.cameraWatch.friendIds)) instance.cameraWatch.friendIds = [];
    return instance.cameraWatch;
}

const STEAM_ID = /^7656\d{13}$/;
const NAME_REFRESH_MS = 30 * 60 * 1000;

/* Allies saved by Steam ID: their current Steam name is looked up again every 30 minutes, so a
   name change is followed (the cameras only give names, not Steam IDs). */
async function refreshFriendNames(client, guildId, cfg, now) {
    let changed = false;
    for (const f of cfg.friendIds) {
        if (f.checked && now - f.checked < NAME_REFRESH_MS) continue;
        f.checked = now;
        const name = await require('../util/scrape.js').scrapeSteamProfileName(client, f.steamId);
        if (name && name !== f.name) { f.name = name; changed = true; }
    }
    if (changed) client.setInstance(guildId, client.getInstance(guildId));
}

function hosterInGame(rustplus) {
    if (!rustplus.team || !rustplus.team.players) return false;
    const me = rustplus.team.players.find(p => p.steamId === rustplus.playerId);
    return !!(me && me.isOnline);
}

function teamOnline(rustplus) {
    if (!rustplus.team || !rustplus.team.players) return 0;
    return rustplus.team.players.filter(p => p.isOnline).length;
}

function alertChannel(instance) {
    return instance.channelId.base || instance.channelId.activity;
}

const MOVE_M = 1.5;                 /* moved more than this between looks: awake, not sleeping */

function teamNames(rustplus, cfg) {
    const names = new Set((cfg && cfg.friends ? cfg.friends : []).map(n => `${n}`.toLowerCase()));
    for (const f of (cfg && cfg.friendIds ? cfg.friendIds : [])) if (f.name) names.add(`${f.name}`.toLowerCase());
    if (rustplus.team && rustplus.team.players) {
        for (const p of rustplus.team.players) names.add(`${p.name}`.toLowerCase());
    }
    return names;
}

function moved(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2) > MOVE_M;
}

/*
 *  Who is in view, sorted out:
 *  - team: a teammate (Rust+ sends the names of players that are awake)
 *  - stranger: someone with a name that is not of the team, or someone without a name that moves
 *  - sleeper: without a name and not moving (a player sleeping in the base) -> ignored
 *  A player without a name seen for the first time waits for the next look to know if it moves.
 */
function classify(cam, players, names, now) {
    const result = { team: [], strangers: [], sleepers: 0 };
    const current = new Set();
    for (const p of players) {
        current.add(p.id);
        if (p.name) {
            if (names.has(p.name.toLowerCase())) {
                result.team.push(p);
                /* remembered: later looks may bring the same player without the name */
                cam.entities[p.id] = { position: p.position, firstSeen: now, moving: true, friendly: true };
            }
            else result.strangers.push(p);
            continue;
        }
        const known = cam.entities[p.id];
        if (known && known.friendly) { result.team.push(p); continue; }
        if (!known) {
            cam.entities[p.id] = { position: p.position, firstSeen: now, moving: !!p.moved };
            if (p.moved) result.strangers.push(p);
            continue;
        }
        if (p.moved) known.moving = true;
        if (moved(known.position, p.position)) known.moving = true;
        known.position = p.position;
        if (known.moving) result.strangers.push(p);
        else result.sleepers++;
    }
    /* forget who is not in view any more */
    for (const id of Object.keys(cam.entities)) if (!current.has(id)) delete cam.entities[id];
    return result;
}

async function sendAlert(client, guildId, rustplus, cameraId, view, image, mention) {
    const instance = client.getInstance(guildId);
    const DiscordTools = require('../discordTools/discordTools.js');
    const channelId = alertChannel(instance);
    const channel = DiscordTools.getTextChannelById(guildId, channelId);
    if (!channel) return;
    const strangers = view.strangers.map(p => p.name ? `${p.name} a ${p.distance} m` : `desconocido a ${p.distance} m`);
    const online = teamOnline(rustplus);
    const lines = [
        `👁️ **${cameraId}**: ${view.strangers.length === 1 ? '1 jugador que no es del equipo' :
            `${view.strangers.length} jugadores que no son del equipo`} (${strangers.join(', ')}).`
    ];
    if (view.team.length > 0) lines.push(`Del equipo a la vista: ${view.team.map(p => p.name).join(', ')}.`);
    lines.push(mention ? '🔴 No hay nadie del equipo conectado.' :
        `🟢 ${online === 1 ? 'Hay 1 compañero conectado' : `Hay ${online} compañeros conectados`}.`);
    const payload = { content: (mention ? '@everyone\n' : '') + lines.join('\n') };
    if (image) payload.files = [{ attachment: image, name: 'camara.png' }];
    try {
        await channel.send(payload);
        client.log(client.intlGet(null, 'infoCap'),
            `Camera watch ${cameraId}: warned in #${channel.name} (not of the team: ${strangers.join(', ')})`);
    }
    catch (e) { client.log(client.intlGet(null, 'errorCap'), `Camera watch alert: ${e}`, 'error'); }
}

async function tickGuild(client, guildId, now) {
    const rustplus = client.rustplusInstances[guildId];
    if (!rustplus || !rustplus.isOperational) return;
    const instance = client.getInstance(guildId);
    const cfg = settings(instance);
    if (!cfg.enabled || cfg.cameras.length === 0) return;
    if (cfg.pausedUntil && now < cfg.pausedUntil) return;
    if (hosterInGame(rustplus)) return;
    try { await refreshFriendNames(client, guildId, cfg, now); }
    catch (e) { /* the old names are kept */ }     /* Rust+ does not allow cameras while in the game */

    const st = state[guildId] || (state[guildId] = { index: 0, cams: {}, busy: false });
    if (st.busy) return;
    st.busy = true;
    try {
        const cameraId = cfg.cameras[st.index % cfg.cameras.length];
        st.index++;
        const cam = st.cams[cameraId] || (st.cams[cameraId] = { lastSeen: 0, lastAlert: 0, lastCount: 0, entities: {} });

        const look = await CameraProbe.probe(rustplus, cameraId, LOOK_MS, false);
        if (!look.ok) {
            if (look.error !== 'busy' && look.error !== 'player_online' && !cam.errorLogged) {
                cam.errorLogged = true;
                client.log(client.intlGet(null, 'warningCap'), `Camera watch ${cameraId}: ${look.error}`, 'warning');
            }
            return;
        }
        cam.errorLogged = false;
        const names = teamNames(rustplus, cfg);
        const view = classify(cam, look.players, names, now);
        if (view.strangers.length === 0) return;

        /* One incident for all the cameras: someone walking past several cameras is one warning.
           Again only if more people are seen at once, or every REPEAT_MS while it goes on. */
        const inc = st.incident;
        const isNew = !inc || now - inc.lastSeen > QUIET_MS;
        const lastAlert = isNew ? 0 : inc.lastAlert;
        const maxCount = isNew ? 0 : inc.maxCount;
        const more = view.strangers.length > maxCount;
        const remind = now - lastAlert >= REPEAT_MS;
        if (!isNew) inc.lastSeen = now;
        if (!(isNew || more || remind)) return;

        /* A longer look before warning: a clearer picture, and Rust+ does not send the names in
           every frame, so a teammate that came without a name in the quick look is recognised now. */
        const full = await CameraProbe.probe(rustplus, cameraId, 6000, true);
        if (full.ok) {
            const named = new Map(full.players.filter(p => p.name).map(p => [p.id, p.name]));
            for (const p of view.strangers) if (!p.name && named.has(p.id)) p.name = named.get(p.id);
            const teammates = view.strangers.filter(p => p.name && names.has(p.name.toLowerCase()));
            if (teammates.length > 0) {
                view.team.push(...teammates);
                view.strangers = view.strangers.filter(p => !teammates.includes(p));
                for (const p of teammates) {
                    if (cam.entities[p.id]) cam.entities[p.id].friendly = true;
                }
            }
            if (view.strangers.length === 0) return;   /* it was one of ours: no warning */
        }

        if (isNew) st.incident = { lastSeen: now, lastAlert: 0, maxCount: 0 };
        const incident = st.incident;
        incident.lastSeen = now;
        incident.lastAlert = now;
        incident.maxCount = Math.max(incident.maxCount, view.strangers.length);
        await sendAlert(client, guildId, rustplus, cameraId, view, full.ok ? full.image : null, teamOnline(rustplus) === 0);
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Camera watch: ${e}`, 'error');
    }
    finally {
        st.busy = false;
    }
}

function friendList(cfg) {
    return [...cfg.friendIds.map(f => `${f.name || '(buscando nombre…)'} [${f.steamId}]`), ...cfg.friends].join(', ');
}

function command(rustplus, client, raw) {
    const prefix = rustplus.generalSettings.prefix;
    const text = `${raw}`.trim();
    const m = text.match(/^(\S+)\s*(.*)$/);
    if (!m) return null;
    const word = m[1].toLowerCase();
    if (![`${prefix}vigilar`, `${prefix}watch`].includes(word)) return null;

    const instance = client.getInstance(rustplus.guildId);
    const cfg = settings(instance);
    const args = m[2].trim().split(/\s+/).filter(a => a !== '');
    const save = () => client.setInstance(rustplus.guildId, instance);

    if (args.length === 0) {
        if (cfg.cameras.length === 0) return '👁️ Vigilancia: ninguna cámara. Añade una con !vigilar CODIGO';
        let paused = hosterInGame(rustplus) ? ' (en pausa: la cuenta del bot está en el juego)' : '';
        if (cfg.pausedUntil && Date.now() < cfg.pausedUntil) {
            paused = ` (en pausa ${Math.ceil((cfg.pausedUntil - Date.now()) / 60000)} min más; !vigilar seguir para quitarla)`;
        }
        const list = friendList(cfg);
        const friends = list ? ` Amigos (no avisan): ${list}.` : '';
        return `👁️ Vigilancia ${cfg.enabled ? 'ACTIVADA' : 'DESACTIVADA'}${paused}. Cámaras: ${cfg.cameras.join(', ')}.${friends}`;
    }
    const a0 = args[0].toLowerCase();
    const rest = args.slice(1).join(' ');

    /* Allies that are not in the in-game team (e.g. more than the team limit): they do not warn */
    if (['amigo', 'friend'].includes(a0)) {
        if (!rest) return 'Uso: !vigilar amigo STEAMID (o el nombre exacto del juego)';
        const idMatch = rest.match(/(7656\d{13})/);
        if (idMatch && STEAM_ID.test(idMatch[1])) {
            const steamId = idMatch[1];
            if (!cfg.friendIds.some(f => f.steamId === steamId)) cfg.friendIds.push({ steamId: steamId, name: null, checked: 0 });
            save();
            return `👁️ Steam ID ${steamId} añadido a los amigos: en unos segundos el bot mira su nombre de Steam y lo sigue aunque se lo cambie.`;
        }
        if (!cfg.friends.some(f => f.toLowerCase() === rest.toLowerCase())) cfg.friends.push(rest);
        save();
        return `👁️ ${rest} no hará saltar la vigilancia (si Rust+ manda su nombre).`;
    }
    if (['quitaramigo', 'unfriend'].includes(a0)) {
        const before = cfg.friends.length + cfg.friendIds.length;
        const key = rest.toLowerCase();
        cfg.friends = cfg.friends.filter(f => f.toLowerCase() !== key);
        cfg.friendIds = cfg.friendIds.filter(f => !rest.includes(f.steamId) && `${f.name}`.toLowerCase() !== key);
        save();
        return before === cfg.friends.length + cfg.friendIds.length ?
            `👁️ ${rest} no estaba en los amigos.` : `👁️ ${rest} quitado de los amigos.`;
    }
    if (['amigos', 'friends'].includes(a0)) {
        const list = friendList(cfg);
        return list ? `👁️ Amigos (no avisan): ${list}.` : '👁️ No hay amigos añadidos.';
    }

    /* Silence it for a while: !vigilar pausa 30m / 2h (1 hour by default) */
    if (['pausa', 'pause'].includes(a0)) {
        const m = (args[1] || '1h').match(/^(\d+)\s*(m|min|h)?$/i);
        if (!m) return 'Uso: !vigilar pausa 30m  (o 2h)';
        const minutes = parseInt(m[1]) * ((m[2] || 'm').toLowerCase() === 'h' ? 60 : 1);
        cfg.pausedUntil = Date.now() + Math.min(minutes, 24 * 60) * 60 * 1000;
        save();
        return `👁️ Vigilancia en pausa ${Math.min(minutes, 24 * 60)} min. !vigilar seguir para reanudarla antes.`;
    }
    if (['seguir', 'resume', 'reanudar'].includes(a0)) {
        delete cfg.pausedUntil;
        save();
        return '👁️ Vigilancia reanudada.';
    }
    if (['on', 'encender', 'activar'].includes(a0)) {
        cfg.enabled = true; save();
        return '👁️ Vigilancia de cámaras activada.';
    }
    if (['off', 'apagar', 'desactivar'].includes(a0)) {
        cfg.enabled = false; save();
        return '👁️ Vigilancia de cámaras desactivada.';
    }
    if (['quitar', 'remove', 'borrar'].includes(a0)) {
        const id = args[1];
        if (!id) return 'Uso: !vigilar quitar CODIGO';
        const before = cfg.cameras.length;
        cfg.cameras = cfg.cameras.filter(c => c.toLowerCase() !== id.toLowerCase());
        save();
        return before === cfg.cameras.length ? `👁️ ${id} no estaba en la vigilancia.` : `👁️ ${id} quitada de la vigilancia.`;
    }
    const id = args[0];
    if (cfg.cameras.some(c => c === id)) return `👁️ ${id} ya está en la vigilancia.`;
    cfg.cameras.push(id);
    save();
    return `👁️ ${id} añadida a la vigilancia. Avisará cuando vea a alguien (con @everyone si no hay nadie del equipo conectado).`;
}

module.exports = {
    command: command,
    tickGuild: tickGuild,
    _state: state,
    start: function (client) {
        if (client.cameraWatchIntervalId) clearInterval(client.cameraWatchIntervalId);
        client.cameraWatchIntervalId = setInterval(async () => {
            const now = Date.now();
            for (const guildId of Object.keys(client.rustplusInstances || {})) {
                await tickGuild(client, guildId, now);
            }
        }, TICK_MS);
    }
};
