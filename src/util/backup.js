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
 *
 *  Every file is ENCRYPTED (AES-256-GCM): credentials hold Steam/FCM tokens and instances hold the
 *  Rust+ token of each server. The key is RPP_BACKUP_KEY (stretched with scrypt), or else a random
 *  key created once in instances/backup.key and never overwritten. The key is never copied into the
 *  backups: keep a copy of it (or of RPP_BACKUP_KEY) somewhere safe, or the backups cannot be read.
 *  To restore, see scripts/backup-decrypt.js.
 */

const Crypto = require('crypto');
const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');

const ROOT = Path.join(__dirname, '..', '..');
const SOURCES = ['instances', 'credentials', Path.join('instances', 'trackerHistory'),
    Path.join('instances', 'dailyStats')];
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_FILE = Path.join(ROOT, 'instances', 'backup.key');
const EXT = '.enc';
const TAG_BYTES = 16;
const DATED = /^\d{4}-\d{2}-\d{2}$/;

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
 *  32-byte key: from RPP_BACKUP_KEY (any text, stretched with scrypt), or the random key saved in
 *  instances/backup.key. The key file is created only when `create` is true and never overwritten:
 *  an unreadable file is an error, so old backups are never left without their key.
 */
function getKey(create = false, client = null) {
    if (Config.backup.key) return Crypto.scryptSync(Config.backup.key, 'rustplusplus-backup-v1', 32);
    if (Fs.existsSync(KEY_FILE)) {
        const saved = Fs.readFileSync(KEY_FILE, 'utf8').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(saved)) throw new Error(`invalid backup key in ${KEY_FILE}`);
        return Buffer.from(saved, 'hex');
    }
    if (!create) throw new Error(`no backup key: set RPP_BACKUP_KEY or restore ${KEY_FILE}`);
    const key = Crypto.randomBytes(32);
    Fs.mkdirSync(Path.dirname(KEY_FILE), { recursive: true });
    Fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    if (client) {
        client.log(client.intlGet(null, 'warningCap'), `Backup key created in ${KEY_FILE}. Keep a copy ` +
            'somewhere safe (or set RPP_BACKUP_KEY): without it the backups cannot be read.', 'warn');
    }
    return key;
}

function encrypt(buffer, key) {
    const iv = Crypto.randomBytes(12);
    const cipher = Crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64') });
}

function decrypt(text, key) {
    const box = JSON.parse(text);
    const tag = Buffer.from(box.tag, 'base64');
    if (tag.length !== TAG_BYTES) throw new Error('invalid authentication tag');
    const decipher = Crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'),
        { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
}

function writeEncrypted(file, buffer, key) {
    Fs.writeFileSync(file, encrypt(buffer, key), { mode: 0o600 });
    Fs.chmodSync(file, 0o600);
}

/**
 *  Encrypts every .json file of instances/ and credentials/ into <backupDir>/<YYYY-MM-DD>/ as .json.enc.
 *  Running it twice the same day overwrites that day's backup.
 *  @return {string|null} The backup folder, or null if there was nothing to copy.
 */
function createBackup(client = null) {
    const target = Path.join(backupDir(), today());
    const key = getKey(true, client);
    let copied = 0;

    for (const source of SOURCES) {
        const sourceDir = Path.join(ROOT, source);
        if (!Fs.existsSync(sourceDir)) continue;

        const files = Fs.readdirSync(sourceDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) continue;

        const targetDir = Path.join(target, source);
        Fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        for (const file of files) {
            writeEncrypted(Path.join(targetDir, file + EXT), Fs.readFileSync(Path.join(sourceDir, file)), key);
            copied++;
        }
    }

    if (copied === 0) return null;

    if (client) {
        client.log(client.intlGet(null, 'infoCap'), `Backup created: ${target} (${copied} files, encrypted)`);
    }
    return target;
}

/**
 *  Backups made before encryption existed hold plain .json files: encrypt them in place.
 *  Only the dated backup folders are touched; a file that fails is logged and skipped.
 */
function encryptOldBackups(client = null) {
    const dir = backupDir();
    if (!Fs.existsSync(dir)) return 0;
    const plain = [];
    const walk = (folder) => {
        for (const entry of Fs.readdirSync(folder, { withFileTypes: true })) {
            const full = Path.join(folder, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.json')) plain.push(full);
        }
    };
    for (const name of Fs.readdirSync(dir)) {
        if (DATED.test(name) && Fs.statSync(Path.join(dir, name)).isDirectory()) walk(Path.join(dir, name));
    }
    if (plain.length === 0) return 0;

    const key = getKey(true, client);
    let done = 0;
    for (const full of plain) {
        try {
            writeEncrypted(full + EXT, Fs.readFileSync(full), key);
            Fs.rmSync(full);
            done++;
        }
        catch (e) {
            if (client) client.log(client.intlGet(null, 'errorCap'), `Could not encrypt old backup ${full}: ${e}`, 'error');
        }
    }
    if (done > 0 && client) {
        client.log(client.intlGet(null, 'infoCap'), `Old backups encrypted: ${done} files`);
    }
    return done;
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
        if (!DATED.test(name)) continue;

        const date = new Date(`${name}T00:00:00`);
        if (isNaN(date.getTime()) || date.getTime() >= limit) continue;

        Fs.rmSync(Path.join(dir, name), { recursive: true, force: true });
        if (client) client.log(client.intlGet(null, 'infoCap'), `Old backup removed: ${name}`);
    }
}

function run(client) {
    /* Separate steps: a problem with old backups never stops today's backup */
    for (const step of [encryptOldBackups, createBackup, pruneBackups]) {
        try {
            step(client);
        }
        catch (e) {
            if (client) client.log(client.intlGet(null, 'errorCap'), `Backup failed (${step.name}): ${e}`, 'error');
        }
    }
}

module.exports = {
    createBackup: createBackup,
    pruneBackups: pruneBackups,
    encryptOldBackups: encryptOldBackups,
    getKey: getKey,
    decrypt: decrypt,
    EXT: EXT,

    start: function (client) {
        if (!Config.backup.enabled) return;
        if (client.backupIntervalId) clearInterval(client.backupIntervalId);

        /* First backup shortly after startup, then once a day. */
        setTimeout(run, 60 * 1000, client);
        client.backupIntervalId = setInterval(run, DAY_MS, client);
    }
};
