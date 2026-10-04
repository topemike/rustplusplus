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
 *  Market board (#market channel):
 *  - A control message with an ADD button (several items at once: "hq, low, ak, c4, rockets").
 *  - One message per watched item with every offer on the map (cheapest first, location, stock),
 *    edited automatically when a shop opens/closes or a price changes.
 *  - New offers are marked 🆕 and price drops ⬇️ (price rises ⬆️) for a while, to spot bargains.
 *  Also the !find / !buscar text command.
 */

const Discord = require('discord.js');

const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const MarketSearch = require('../util/marketSearch.js');

/* How long an offer stays marked as new / price changed */
const HIGHLIGHT_MS = 30 * 60 * 1000;
/* Offers shown per item on the board */
const MAX_LINES_PER_ITEM = 12;
/* First board for a guild */
const DEFAULT_BOARD = ['hq', 'low', 'carbon', 'ak', 'm249', 'c4', 'rockets'];

/* guildId -> { offers: Map(key -> { cost, quantity, firstSeen, changedAt, direction }), signatures: {} } */
const state = new Object();

function getState(guildId) {
    if (!state[guildId]) state[guildId] = { offers: null, signatures: {}, controlSent: false };
    return state[guildId];
}

function newEntryId() {
    return Math.random().toString(36).slice(2, 10);
}

/**
 *  Makes sure the board exists in the instance (with the default items the first time).
 *  @return {boolean} true if the instance changed.
 */
function ensureBoard(instance, items) {
    let changed = false;
    if (!instance.channelId.hasOwnProperty('market')) {
        instance.channelId.market = null;
        changed = true;
    }
    if (instance.marketBoard && Array.isArray(instance.marketBoard.entries)) return changed;
    instance.marketBoard = { controlMessageId: null, entries: [] };
    for (const query of DEFAULT_BOARD) {
        const itemIds = MarketSearch.resolveQuery(items, query);
        if (itemIds.length > 0) {
            instance.marketBoard.entries.push({ id: newEntryId(), query: query, itemIds: itemIds, messageId: null });
        }
    }
    return true;
}

/**
 *  Adds items to the board from a comma separated text.
 *  @return {Object} { added: [query], unknown: [query], duplicated: [query] }
 */
function addToBoard(instance, items, text) {
    const result = { added: [], unknown: [], duplicated: [] };
    for (const raw of `${text}`.split(',')) {
        const query = raw.trim();
        if (query === '') continue;
        const itemIds = MarketSearch.resolveQuery(items, query);
        if (itemIds.length === 0) {
            result.unknown.push(query);
            continue;
        }
        const key = [...itemIds].sort().join(',');
        if (instance.marketBoard.entries.some(e => [...e.itemIds].sort().join(',') === key)) {
            result.duplicated.push(query);
            continue;
        }
        instance.marketBoard.entries.push({ id: newEntryId(), query: query, itemIds: itemIds, messageId: null });
        result.added.push(query);
    }
    return result;
}

/**
 *  Updates the memory of offers (to mark new offers and price changes).
 *  The first call only records what is already on the map.
 */
function trackOffers(guildId, offers, itemIds, now) {
    const st = getState(guildId);
    const first = st.offers === null;
    const known = st.offers || new Map();
    const trackedBefore = st.trackedItems || new Set();
    const current = new Map();

    for (const o of offers) {
        const key = `${o.vmKey}|${o.itemId}|${o.currencyId}`;
        const before = known.get(key);
        let info;
        if (!before) {
            /* Offers of items that were just added to the board are not "new" */
            const isNew = !first && trackedBefore.has(o.itemId);
            info = { cost: o.cost, quantity: o.quantity, firstSeen: isNew ? now : 0, changedAt: 0, direction: 0 };
        }
        else if (before.cost !== o.cost || before.quantity !== o.quantity) {
            const oldUnit = before.cost / Math.max(1, before.quantity);
            info = {
                cost: o.cost, quantity: o.quantity, firstSeen: before.firstSeen, changedAt: now,
                direction: o.unitPrice < oldUnit ? -1 : (o.unitPrice > oldUnit ? 1 : 0)
            };
        }
        else {
            info = before;
        }
        current.set(key, info);
    }
    st.offers = current;
    st.trackedItems = new Set(itemIds.map(id => `${id}`));
}

function getMark(guildId, o, now) {
    const st = getState(guildId);
    const info = st.offers ? st.offers.get(`${o.vmKey}|${o.itemId}|${o.currencyId}`) : null;
    if (!info) return '';
    if (info.changedAt && now - info.changedAt < HIGHLIGHT_MS) {
        return info.direction < 0 ? '⬇️ ' : (info.direction > 0 ? '⬆️ ' : '');
    }
    if (info.firstSeen && now - info.firstSeen < HIGHLIGHT_MS) return '\u{1F195} ';
    return '';
}

function getEntryContent(client, guildId, entry, vendingMachines, serverTitle, now) {
    const intl = (id, v) => client.intlGet(guildId, id, v);
    const names = entry.itemIds.slice(0, 4).map(id => client.items.getName(id)).join(', ') +
        (entry.itemIds.length > 4 ? ` +${entry.itemIds.length - 4}` : '');
    const { sell } = MarketSearch.collectOffers(vendingMachines, entry.itemIds, 'sell');

    let description;
    if (sell.length === 0) {
        description = intl('marketBoardNothing');
    }
    else {
        const lines = MarketSearch.formatOffersDiscord(client.items, sell, intl, MAX_LINES_PER_ITEM);
        description = sell.slice(0, MAX_LINES_PER_ITEM).map((o, i) => `${getMark(guildId, o, now)}${lines[i]}`)
            .concat(lines.slice(MAX_LINES_PER_ITEM)).join('\n');
    }

    const marked = sell.some(o => getMark(guildId, o, now) !== '');
    const embed = DiscordEmbeds.getEmbed({
        color: marked ? Constants.COLOR_ACTIVE : Constants.COLOR_DEFAULT,
        title: `${entry.query.toUpperCase()} · ${names}`.slice(0, 256),
        description: description.slice(0, 4096),
        footer: { text: intl('marketBoardFooter', { count: sell.length, server: serverTitle }) },
        timestamp: true
    });

    /* Signature without the timestamp: the message is edited only when something visible changes */
    const signature = JSON.stringify([embed.data.title, embed.data.description, embed.data.color,
        embed.data.footer.text]);

    return {
        signature: signature,
        content: {
            embeds: [embed],
            components: [new Discord.ActionRowBuilder().addComponents(
                new Discord.ButtonBuilder()
                    .setCustomId(`MarketBoardRemove${JSON.stringify({ id: entry.id })}`)
                    .setLabel(intl('marketBoardRemoveCap'))
                    .setStyle(Discord.ButtonStyle.Secondary))]
        }
    };
}

function getControlContent(client, guildId) {
    const intl = (id, v) => client.intlGet(guildId, id, v);
    return {
        embeds: [DiscordEmbeds.getEmbed({
            color: Constants.COLOR_DEFAULT,
            title: intl('marketBoardTitle'),
            description: intl('marketBoardHelp')
        })],
        components: [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId('MarketBoardAdd')
                .setLabel(intl('marketBoardAddCap'))
                .setStyle(Discord.ButtonStyle.Success))]
    };
}

/**
 *  Creates/edits the board messages. Only messages whose content changed are edited.
 *  @param {boolean} force Re-send everything.
 */
async function updateBoard(client, rustplus, force = false, now = Date.now()) {
    const guildId = rustplus.guildId;
    const instance = client.getInstance(guildId);
    if (ensureBoard(instance, client.items)) client.setInstance(guildId, instance);
    const channelId = instance.channelId.market;
    if (!channelId || !rustplus.mapMarkers) return;

    const st = getState(guildId);
    const board = instance.marketBoard;
    let changed = false;

    if (force || board.controlMessageId === null || !st.controlSent) {
        const message = await DiscordMessages.sendMessage(guildId, getControlContent(client, guildId),
            board.controlMessageId, channelId);
        if (message && message.id && message.id !== board.controlMessageId) {
            board.controlMessageId = message.id;
            changed = true;
        }
        st.controlSent = true;
    }

    const vms = rustplus.mapMarkers.vendingMachines;
    const allItemIds = [...new Set(board.entries.flatMap(e => e.itemIds))];
    trackOffers(guildId, MarketSearch.collectOffers(vms, allItemIds, 'sell').sell, allItemIds, now);

    const serverTitle = instance.serverList[rustplus.serverId] ? instance.serverList[rustplus.serverId].title : '';
    for (const entry of board.entries) {
        const { signature, content } = getEntryContent(client, guildId, entry, vms, serverTitle, now);
        if (!force && entry.messageId !== null && st.signatures[entry.id] === signature) continue;

        const message = await DiscordMessages.sendMessage(guildId, content, entry.messageId, channelId);
        if (message && message.id && message.id !== entry.messageId) {
            entry.messageId = message.id;
            changed = true;
        }
        st.signatures[entry.id] = signature;
    }

    if (changed) client.setInstance(guildId, instance);
}

async function removeEntry(client, guildId, entryId) {
    const instance = client.getInstance(guildId);
    if (!instance.marketBoard) return false;
    const entry = instance.marketBoard.entries.find(e => e.id === entryId);
    if (!entry) return false;
    try {
        await DiscordTools.deleteMessageById(guildId, instance.channelId.market, entry.messageId);
    }
    catch (e) { /* already deleted */ }
    instance.marketBoard.entries = instance.marketBoard.entries.filter(e => e.id !== entryId);
    delete getState(guildId).signatures[entryId];
    client.setInstance(guildId, instance);
    return true;
}

module.exports = {
    handler: async function (rustplus, client) {
        await updateBoard(client, rustplus);
    },

    ensureBoard: ensureBoard,
    addToBoard: addToBoard,
    removeEntry: removeEntry,
    updateBoard: updateBoard,
    getEntryContent: getEntryContent,
    DEFAULT_BOARD: DEFAULT_BOARD,

    /**
     *  !find <text> / !buscar <text> for the in-game chat and the Discord commands channel.
     *  @return {string|Array|null} Response, or null if the command is not a find command.
     */
    getCommandFind: function (rustplus, client, command, forDiscord = false) {
        const guildId = rustplus.guildId;
        const prefix = rustplus.generalSettings.prefix;
        const lower = command.toLowerCase();
        const syntaxes = [client.intlGet('en', 'commandSyntaxFind'), client.intlGet(guildId, 'commandSyntaxFind'),
            'find', 'buscar'];
        const syntax = syntaxes.find(s => lower.startsWith(`${prefix}${s} `));
        if (!syntax) return null;

        const query = command.slice(`${prefix}${syntax} `.length).trim();
        const itemIds = MarketSearch.resolveQuery(client.items, query);
        if (itemIds.length === 0) return client.intlGet(guildId, 'noItemWithNameFound', { name: query });

        const { sell } = MarketSearch.collectOffers(rustplus.mapMarkers.vendingMachines, itemIds, 'sell');
        if (sell.length === 0) {
            return client.intlGet(guildId, 'marketNothingForSale', {
                items: itemIds.slice(0, 3).map(id => client.items.getName(id)).join(', ')
            });
        }

        if (forDiscord) {
            return MarketSearch.formatOffersDiscord(client.items, sell, (id, v) => client.intlGet(guildId, id, v), 15);
        }
        return MarketSearch.formatOffersInGame(client.items, sell);
    },

    /* For tests */
    _reset: function () { for (const k of Object.keys(state)) delete state[k]; }
};
