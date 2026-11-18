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

/* Top level text commands ("!craft", "!heli"...): their syntax keys */
const COMMAND_SYNTAX_KEYS = [
    'commandSyntaxAfk', 'commandSyntaxAlive', 'commandSyntaxBase', 'commandSyntaxBradley', 'commandSyntaxCargo',
    'commandSyntaxChinook', 'commandSyntaxConnection', 'commandSyntaxConnections', 'commandSyntaxCraft',
    'commandSyntaxCrate', 'commandSyntaxDeath', 'commandSyntaxDeaths', 'commandSyntaxDecay', 'commandSyntaxDeepSea',
    'commandSyntaxDespawn', 'commandSyntaxEvents', 'commandSyntaxFind', 'commandSyntaxHeli', 'commandSyntaxLarge',
    'commandSyntaxLeader', 'commandSyntaxMarker', 'commandSyntaxMarkers', 'commandSyntaxMarket', 'commandSyntaxMute',
    'commandSyntaxNote', 'commandSyntaxNotes', 'commandSyntaxOffline', 'commandSyntaxOnline', 'commandSyntaxPlayer',
    'commandSyntaxPlayers', 'commandSyntaxPop', 'commandSyntaxProx', 'commandSyntaxRecycle', 'commandSyntaxResearch',
    'commandSyntaxSend', 'commandSyntaxSmall', 'commandSyntaxStack', 'commandSyntaxSteamid', 'commandSyntaxTeam',
    'commandSyntaxTime', 'commandSyntaxTimer', 'commandSyntaxTimers', 'commandSyntaxTranslateTo',
    'commandSyntaxTranslateFromTo', 'commandSyntaxTTS', 'commandSyntaxUnmute', 'commandSyntaxUpkeep',
    'commandSyntaxUptime', 'commandSyntaxWipe', 'commandSyntaxTravelingVendor'
];

/* Words after the command ("!marker add x", "!market search ..."): accents are optional there too */
const SUBCOMMAND_SYNTAX_KEYS = [
    'commandSyntaxAdd', 'commandSyntaxRemove', 'commandSyntaxSearch', 'commandSyntaxSubscribe',
    'commandSyntaxUnsubscribe', 'commandSyntaxList', 'commandSyntaxLanguage', 'commandSyntaxStatus'
];

/* Built-in words that are not language keys (both languages are always understood) */
const EXTRA_COMMAND_WORDS = ['base', 'bradley', 'crate', 'vendor', 'deepsea', 'find', 'buscar', 'cam', 'camara',
    'cámara', 'watch', 'vigilar'];

function plain(str) {
    return `${str}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function escapeRegExp(str) {
    return `${str}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    COMMAND_SYNTAX_KEYS: COMMAND_SYNTAX_KEYS,

    /* Lower case and without accents: "Caída" -> "caida" */
    plain: plain,

    getListOfCommandKeywords: function (client, guildId) {
        const list = [];
        for (const lang of [guildId, 'en']) {
            for (const key of COMMAND_SYNTAX_KEYS) list.push(client.intlGet(lang, key));
        }
        list.push(...EXTRA_COMMAND_WORDS);
        /* The same words without accents are understood as well ("!caida", "!lider") */
        for (const word of [...list]) {
            if (plain(word) !== word) list.push(plain(word));
        }
        return [...new Set(list)];
    },

    getListOfUsedKeywords: function (client, guildId, serverId) {
        const instance = client.getInstance(guildId);

        let list = [];
        list = [...module.exports.getListOfCommandKeywords(client, guildId)];
        for (const [id, value] of Object.entries(instance.serverList[serverId].alarms)) {
            list.push(value.command);
        }

        for (const [id, value] of Object.entries(instance.serverList[serverId].switches)) {
            list.push(value.command);
        }

        for (const [id, value] of Object.entries(instance.serverList[serverId].switchGroups)) {
            list.push(value.command);
        }

        /* Commands are matched without caring about upper case or accents ("!Craft" = "!craft"), so a
           device can not be called "Craft" either: includes() on this list ignores both. */
        const plainList = new Set(list.map(e => plain(e)));
        list.includes = (word) => plainList.has(plain(word));

        return list;
    },

    /**
     *  Aliases (/alias): only replaced as a whole word at the start of the command, not inside it
     *  (an alias "h" must not change "!send bob hello").
     */
    applyAliases: function (aliases, prefix, command) {
        for (const alias of (aliases || [])) {
            if (!alias || typeof alias.alias !== 'string' || alias.alias === '') continue;
            const value = `${alias.value}`;
            const re = new RegExp(`^${escapeRegExp(alias.alias)}(?=\\s|$)`);
            if (re.test(command)) {
                command = command.replace(re, () => value);
                continue;
            }
            if (!alias.alias.startsWith(prefix) && !value.startsWith(prefix)) {
                const rePrefixed = new RegExp(`^${escapeRegExp(prefix)}${escapeRegExp(alias.alias)}(?=\\s|$)`);
                if (rePrefixed.test(command)) {
                    command = command.replace(rePrefixed, () => `${prefix}${value}`);
                }
            }
        }
        return command;
    },

    /**
     *  "!Caida wooden door" -> "!caída wooden door", "!LIDER bob" -> "!líder bob", "!nota anadir x" ->
     *  "!nota añadir x": the command word (and a known subcommand word) is written like the syntax of
     *  the language, so upper case and missing accents do not matter. Anything else is not touched.
     */
    normalizeCommand: function (client, guildId, prefix, command) {
        if (typeof command !== 'string' || !prefix || !command.startsWith(prefix)) return command;
        const m = command.slice(prefix.length).match(/^(\S+)(\s+(\S+))?([\s\S]*)$/);
        if (!m) return command;

        const find = (word, keys) => {
            const p = plain(word);
            for (const lang of [guildId, 'en']) {
                for (const key of keys) {
                    const syntax = client.intlGet(lang, key);
                    if (plain(syntax) === p) return syntax;
                }
            }
            return null;
        };

        const first = find(m[1], COMMAND_SYNTAX_KEYS);
        if (first === null) return command;
        let rest = m[2] !== undefined ? `${m[2]}${m[4]}` : m[4];
        const withSubcommands = ['commandSyntaxMarker', 'commandSyntaxMarket', 'commandSyntaxNote',
            'commandSyntaxTimer', 'commandSyntaxTranslateTo'];
        if (m[3] !== undefined && find(m[1], withSubcommands) !== null) {
            const second = find(m[3], SUBCOMMAND_SYNTAX_KEYS);
            if (second !== null) rest = `${m[2].replace(m[3], second)}${m[4]}`;
        }
        return `${prefix}${first}${rest}`;
    }
};
