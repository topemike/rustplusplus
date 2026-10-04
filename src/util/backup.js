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
 *  Daily backup of the bot configuration (instances + credentials).
 *  Backups are stored as dated folders, by default inside logs/backups so they
 *  survive container rebuilds without extra docker volumes.
 */

const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');

const ROOT = Path.join(__dirname, '..', '..');
const SOURCES = ['instances', 'credentials', Path.join('instances', 'trackerHistory')];
const DAY_MS = 24 * 60 * 60 * 1000;

function backupDir() {
    const dir = Config.backup.directory;
    return Path.isAbsolute(dir) ? dir : Path.join(ROOT, dir);
}

function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 *  Copies every .json file of instances/ and credentials/ into <backupDir>/<YYYY-MM-DD>/.
 *  Running it twice the same day overwrites that day's backup.
 *  @return {string|null} The backup folder, or null if there was nothing to copy.
 */
function createBackup(client = null) {
    const target = Path.join(backupDir(), today());
    let copied = 0;

    for (const source of SOURCES) {
        const sourceDir = Path.join(ROOT, source);
        if (!Fs.existsSync(sourceDir)) continue;

        const files = Fs.readdirSync(sourceDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) continue;

        const targetDir = Path.join(target, source);
        Fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        for (const file of files) {
            Fs.copyFileSync(Path.join(sourceDir, file), Path.join(targetDir, file));
            Fs.chmodSync(Path.join(targetDir, file), 0o600);
            copied++;
        }
    }

    if (copied === 0) return null;

    if (client) {
        client.log(client.intlGet(null, 'infoCap'), `Backup created: ${target} (${copied} files)`);
    }
    return target;
}

/**
 *  Removes dated backup folders older than the configured number of days.
 */
function pruneBackups(client = null) {
    const dir = backupDir();
    if (!Fs.existsSync(dir)) return;

    const keepDays = Config.backup.keepDays;
    const limit = Date.now() - keepDays * DAY_MS;

    for (const name of Fs.readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;

        const date = new Date(`${name}T00:00:00`);
        if (isNaN(date.getTime()) || date.getTime() >= limit) continue;

        Fs.rmSync(Path.join(dir, name), { recursive: true, force: true });
        if (client) client.log(client.intlGet(null, 'infoCap'), `Old backup removed: ${name}`);
    }
}

function run(client) {
    try {
        createBackup(client);
        pruneBackups(client);
    }
    catch (e) {
        if (client) client.log(client.intlGet(null, 'errorCap'), `Backup failed: ${e}`, 'error');
    }
}

module.exports = {
    createBackup: createBackup,
    pruneBackups: pruneBackups,

    start: function (client) {
        if (!Config.backup.enabled) return;
        if (client.backupIntervalId) clearInterval(client.backupIntervalId);

        /* First backup shortly after startup, then once a day. */
        setTimeout(run, 60 * 1000, client);
        client.backupIntervalId = setInterval(run, DAY_MS, client);
    }
};
