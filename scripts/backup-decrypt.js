/*
 *  Decrypts a backup made by src/util/backup.js, to restore it.
 *
 *  Usage (inside the bot container, so it uses the same key):
 *      docker exec rpp node scripts/backup-decrypt.js logs/backups/2026-10-07
 *  It writes the plain .json files to the output folder (default: logs/restore/<date>, outside
 *  the backups, visible on the VPS in /opt/rustplusplus/logs/restore), keeping the folder layout (instances/, credentials/...). Copy the ones you need back
 *  into place with the bot stopped. Delete the restore folder afterwards: it holds tokens in clear.
 */

const Fs = require('fs');
const Path = require('path');
const Backup = require('../src/util/backup.js');

const source = process.argv[2];
if (!source || !Fs.existsSync(source)) {
    console.error('Usage: node scripts/backup-decrypt.js <backup folder or .enc file> [output folder]');
    process.exit(1);
}
const output = process.argv[3] || Path.join(__dirname, '..', 'logs', 'restore', Path.basename(source.replace(/[\\/]+$/, '')));
let key;
try { key = Backup.getKey(false); }    /* never creates a key: that would be the wrong one */
catch (e) {
    console.error(e.message);
    process.exit(1);
}
let count = 0;

function one(file, rel) {
    const out = Path.join(output, rel.slice(0, -Backup.EXT.length));
    Fs.mkdirSync(Path.dirname(out), { recursive: true, mode: 0o700 });
    Fs.writeFileSync(out, Backup.decrypt(Fs.readFileSync(file, 'utf8'), key), { mode: 0o600 });
    count++;
}

function walk(folder, rel) {
    for (const entry of Fs.readdirSync(folder, { withFileTypes: true })) {
        const full = Path.join(folder, entry.name);
        const r = Path.join(rel, entry.name);
        if (entry.isDirectory()) walk(full, r);
        else if (entry.name.endsWith(Backup.EXT)) one(full, r);
    }
}

try {
    if (Fs.statSync(source).isDirectory()) walk(source, '');
    else one(source, Path.basename(source));
}
catch (e) {
    console.error(`Could not decrypt (wrong key?): ${e.message}`);
    process.exit(1);
}
console.log(`${count} files decrypted into ${output}`);
