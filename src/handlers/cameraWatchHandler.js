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
 */

const CameraProbe = require('../util/cameraProbe.js');

const TICK_MS = 5 * 1000;           /* one camera looked at every 5 s (in turns) */
const LOOK_MS = 3 * 1000;           /* how long each look lasts */
const QUIET_MS = 2 * 60 * 1000;     /* nobody seen for this long: the next one is a new warning */
const REPEAT_MS = 5 * 60 * 1000;    /* still there: remind every 5 minutes */

const state = {};                   /* guildId -> { index, cams: { id: { lastSeen, lastAlert, lastCount } }, busy } */

function settings(instance) {
    if (!instance.cameraWatch) instance.cameraWatch = { enabled: true, cameras: [] };
    return instance.cameraWatch;
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

function teamNames(rustplus) {
    if (!rustplus.team || !rustplus.team.players) return new Set();
    return new Set(rustplus.team.players.map(p => `${p.name}`.toLowerCase()));
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
            if (names.has(p.name.toLowerCase())) result.team.push(p);
            else result.strangers.push(p);
            continue;
        }
        const known = cam.entities[p.id];
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
            `Camera watch ${cameraId}: warned in #${channel.name} (${view.strangers.length} not of the team)`);
    }
    catch (e) { client.log(client.intlGet(null, 'errorCap'), `Camera watch alert: ${e}`, 'error'); }
}

async function tickGuild(client, guildId, now) {
    const rustplus = client.rustplusInstances[guildId];
    if (!rustplus || !rustplus.isOperational) return;
    const instance = client.getInstance(guildId);
    const cfg = settings(instance);
    if (!cfg.enabled || cfg.cameras.length === 0) return;
    if (hosterInGame(rustplus)) return;     /* Rust+ does not allow cameras while in the game */

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
        const view = classify(cam, look.players, teamNames(rustplus), now);
        if (view.strangers.length === 0) {
            if (cam.lastSeen && now - cam.lastSeen > QUIET_MS) cam.lastCount = 0;
            return;
        }

        const isNew = !cam.lastSeen || now - cam.lastSeen > QUIET_MS;
        const more = view.strangers.length > cam.lastCount;
        const remind = now - cam.lastAlert >= REPEAT_MS;
        cam.lastSeen = now;
        if (!(isNew || more || remind)) return;

        cam.lastAlert = now;
        cam.lastCount = view.strangers.length;
        /* A clearer picture for the warning */
        const full = await CameraProbe.probe(rustplus, cameraId, 6000, true);
        await sendAlert(client, guildId, rustplus, cameraId, view, full.ok ? full.image : null, teamOnline(rustplus) === 0);
    }
    catch (e) {
        client.log(client.intlGet(null, 'errorCap'), `Camera watch: ${e}`, 'error');
    }
    finally {
        st.busy = false;
    }
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
        const paused = hosterInGame(rustplus) ? ' (en pausa: la cuenta del bot está en el juego)' : '';
        return `👁️ Vigilancia ${cfg.enabled ? 'ACTIVADA' : 'DESACTIVADA'}${paused}. Cámaras: ${cfg.cameras.join(', ')}.`;
    }
    const a0 = args[0].toLowerCase();
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
