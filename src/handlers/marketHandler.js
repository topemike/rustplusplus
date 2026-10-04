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
 *  Market: bargain notifications on every poll, and the !find / !buscar text command.
 */

const Constants = require('../util/constants.js');
const MarketSearch = require('../util/marketSearch.js');

/* Avoid flooding when a lot of bargains appear at once (e.g. start of wipe) */
const MAX_BARGAINS_PER_POLL = 5;

function bargainText(client, guildId, change) {
    const o = change.offer;
    const vars = {
        item: client.items.getName(o.itemId),
        quantity: o.quantity,
        cost: o.cost,
        currency: client.items.getName(o.currencyId),
        location: o.location,
        stock: o.stock
    };
    if (change.previous) {
        vars.oldCost = change.previous.cost;
        vars.oldQuantity = change.previous.quantity;
        return client.intlGet(guildId, 'marketPriceChanged', vars);
    }
    return client.intlGet(guildId, 'marketNewOffer', vars);
}

module.exports = {
    handler: async function (rustplus, client) {
        const guildId = rustplus.guildId;
        const instance = client.getInstance(guildId);
        if (MarketSearch.ensureBargainList(instance)) client.setInstance(guildId, instance);
        if (!rustplus.mapMarkers || instance.marketBargains.length === 0) return;

        /* The first call only records the offers already on the map (see /gangas ver) */
        const changes = MarketSearch.newBargains(guildId, instance.marketBargains,
            rustplus.mapMarkers.vendingMachines);

        const setting = rustplus.notificationSettings.marketBargainSetting;
        if (!setting) return;

        for (const change of changes.slice(0, MAX_BARGAINS_PER_POLL)) {
            await rustplus.sendEvent(setting, bargainText(client, guildId, change), 'market',
                change.previous ? Constants.COLOR_CARGO_SHIP_ENTERS_EGRESS_STAGE : Constants.COLOR_ACTIVE);
        }
    },

    /**
     *  !find <text> / !buscar <text> for the in-game chat and the Discord commands channel.
     *  @return {string|Array|null} Response, or null if the command is not a find command.
     */
    getCommandFind: function (rustplus, client, command, forDiscord = false) {
        const guildId = rustplus.guildId;
        const prefix = rustplus.generalSettings.prefix;
        const lower = command.toLowerCase();
        const syntaxes = [client.intlGet('en', 'commandSyntaxFind'), client.intlGet(guildId, 'commandSyntaxFind'), 'find', 'buscar'];
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

    bargainText: bargainText
};
