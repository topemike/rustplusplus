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
 *  Camera test: connects to a CCTV / PTZ camera through Rust+ for a few seconds and reports what it
 *  gets: camera type, how far it sees, the players in view (Rust+ sends their names) and a picture.
 */

const Camera = require('@liamcottle/rustplus.js/camera.js');

const LISTEN_MS = 8000;
const PLAYER = 2, TREE = 1;

function length(v) {
    if (!v) return 0;
    return Math.sqrt((v.x || 0) ** 2 + (v.y || 0) ** 2 + (v.z || 0) ** 2);
}

/**
 *  @return {Object} { ok, error?, info, frames, players: [{ name, distance }], trees, fov, image (PNG buffer|null) }
 */
async function probe(rustplus, cameraId, listenMs = LISTEN_MS, withImage = true) {
    if (busy.has(rustplus.guildId)) return { ok: false, error: 'busy' };
    busy.add(rustplus.guildId);
    const frames = [];
    const onMessage = (message) => {
        if (message && message.broadcast && message.broadcast.cameraRays) frames.push(message.broadcast.cameraRays);
    };
    try {
        if (rustplus.waitForAvailableTokens && !(await rustplus.waitForAvailableTokens(1))) {
            return { ok: false, error: 'tokens' };
        }
        let response;
        try {
            response = await rustplus.sendRequestAsync({ cameraSubscribe: { cameraId: cameraId } }, 10000);
        }
        catch (e) {
            return { ok: false, error: (e && e.error) ? e.error : `${e}` };
        }
        if (!response || response.error || !response.cameraSubscribeInfo) {
            return { ok: false, error: response && response.error ? response.error : 'no_info' };
        }
        const info = response.cameraSubscribeInfo;

        rustplus.on('message', onMessage);
        await new Promise(r => setTimeout(r, listenMs));
        rustplus.removeListener('message', onMessage);

        try { await rustplus.sendRequestAsync({ cameraUnsubscribe: {} }, 5000); }
        catch (e) { /* the subscription ends by itself */ }

        /* Players in view (closest distance each), trees */
        const seen = new Map();
        let trees = 0, fov = null;
        for (const frame of frames) {
            if (typeof frame.verticalFov === 'number') fov = frame.verticalFov;
            for (const entity of frame.entities || []) {
                if (entity.type === PLAYER) {
                    const key = `${entity.entityId}`;
                    const d = Math.round(length(entity.position));
                    const p = entity.position || {};
                    const pos = { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
                    const prev = seen.get(key);
                    if (!prev) {
                        seen.set(key, { id: key, name: entity.name || null, distance: d, position: pos, first: pos, moved: false });
                        continue;
                    }
                    /* Moving during the look (someone walking, not sleeping) */
                    if (Math.sqrt((pos.x - prev.first.x) ** 2 + (pos.y - prev.first.y) ** 2 + (pos.z - prev.first.z) ** 2) > 1.5) {
                        prev.moved = true;
                    }
                    if (!prev.name && entity.name) prev.name = entity.name;
                    if (d < prev.distance) prev.distance = d;
                    prev.position = pos;
                }
                else if (entity.type === TREE) trees++;
            }
        }

        let image = null;
        if (withImage && frames.length > 0) {
            try {
                /* Each frame only fills part of the picture: with all the frames received the picture is
                   complete (instead of the last 10). Then it is enlarged 3x so it is easier to see. */
                const png = await Camera.prototype._renderCameraFrame.call({}, frames, info.width, info.height);
                const Jimp = require('jimp');
                const picture = await Jimp.read(png);
                picture.resize(info.width * 3, info.height * 3, Jimp.RESIZE_BICUBIC);
                image = await picture.getBufferAsync(Jimp.MIME_PNG);
            }
            catch (e) { image = null; }
        }

        return {
            ok: true, info: info, frames: frames.length, fov: fov, trees: trees,
            players: [...seen.values()],
            image: image
        };
    }
    finally {
        rustplus.removeListener('message', onMessage);
        busy.delete(rustplus.guildId);
    }
}

const busy = new Set();

/* Short text for Discord / the game */
function describe(cameraId, r) {
    if (!r.ok) {
        const why = r.error === 'busy' ? 'ya hay una prueba de cámara en marcha, espera unos segundos' :
            r.error === 'tokens' ? 'Rust+ está ocupado, prueba en unos segundos' :
            `Rust+ contestó: ${r.error}` + (/not_found|no_info/i.test(r.error) ? ' (¿el código es exacto, mayúsculas incluidas, y la cámara tiene corriente?)' : '');
        return `📷 ${cameraId}: no se pudo ver la cámara — ${why}.`;
    }
    const i = r.info;
    const type = (i.controlFlags & Camera.ControlFlags.MOUSE) ? 'PTZ (se puede girar)' : 'fija';
    const lines = [
        `📷 ${cameraId}: cámara ${type}.`,
        `Ve hasta unos ${Math.round(i.farPlane)} m` + (r.fov ? `, ángulo vertical ${Math.round(r.fov)}°` : '') +
            `, imagen ${i.width}×${i.height}. Datos recibidos: ${r.frames}.`,
        r.players.length > 0 ?
            `👤 Jugadores a la vista: ${r.players.map(p => `${p.name || `#${p.id}`} (${p.distance} m)`).join(', ')}.` :
            '👤 Ningún jugador a la vista ahora mismo.'
    ];
    if (r.frames === 0) lines.push('⚠️ La cámara no mandó imagen: puede que el server tenga limitadas las cámaras en Rust+.');
    return lines.join('\n');
}

module.exports = { probe: probe, describe: describe };
