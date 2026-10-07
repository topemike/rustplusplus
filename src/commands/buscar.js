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

const Builder = require('@discordjs/builders');

const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const MarketSearch = require('../util/marketSearch.js');

module.exports = {
	name: 'buscar',

	getData(client, guildId) {
		return new Builder.SlashCommandBuilder()
			.setName('buscar')
			.setDescription(client.intlGet(guildId, 'commandsFindDesc'))
			.addStringOption(option => option
				.setName('objeto')
				.setDescription(client.intlGet(guildId, 'commandsFindItemDesc'))
				.setRequired(true))
			.addStringOption(option => option
				.setName('tipo')
				.setDescription(client.intlGet(guildId, 'commandsFindTypeDesc'))
				.setRequired(false)
				.addChoices(
					{ name: client.intlGet(guildId, 'marketTypeSell'), value: 'sell' },
					{ name: client.intlGet(guildId, 'marketTypeBuy'), value: 'buy' },
					{ name: client.intlGet(guildId, 'marketTypeAll'), value: 'all' }));
	},

	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const instance = client.getInstance(guildId);
		const rustplus = client.rustplusInstances[guildId];

		const verifyId = Math.floor(100000 + Math.random() * 900000);
		client.logInteraction(interaction, verifyId, 'slashCommand');

		if (!await client.validatePermissions(interaction)) return;
		await interaction.deferReply({ ephemeral: true });

		if (!rustplus || (rustplus && !rustplus.isOperational)) {
			const str = client.intlGet(guildId, 'notConnectedToRustServer');
			await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
			return;
		}

		const query = interaction.options.getString('objeto');
		const type = interaction.options.getString('tipo') || 'all';
		const itemIds = MarketSearch.resolveQuery(client.items, query);

		client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
			id: `${verifyId}`,
			value: `buscar, ${query}, ${type}`
		}));

		if (itemIds.length === 0) {
			const str = client.intlGet(guildId, 'noItemWithNameFound', { name: query });
			await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
			return;
		}

		const offers = MarketSearch.collectOffers(rustplus.mapMarkers.vendingMachines, itemIds, type);
		const intl = (id, v) => client.intlGet(guildId, id, v);
		const itemNames = itemIds.slice(0, 6).map(id => client.items.getName(id)).join(', ') +
			(itemIds.length > 6 ? ` +${itemIds.length - 6}` : '');

		const fields = [];
		let description = '';
		if (type !== 'buy') {
			description = offers.sell.length === 0 ? intl('marketNothingForSale', { items: itemNames }) :
				MarketSearch.formatOffersDiscord(client.items, offers.sell, intl, 25).join('\n');
		}
		if (type !== 'sell') {
			const buyLines = offers.buy.length === 0 ? [intl('marketNobodyBuys')] :
				MarketSearch.formatOffersDiscord(client.items, offers.buy, intl, 8);
			if (type === 'buy') description = buyLines.join('\n');
			else fields.push({ name: intl('marketWhoBuys'), value: buyLines.join('\n').slice(0, 1024) });
		}

		const embed = DiscordEmbeds.getEmbed({
			color: Constants.COLOR_DEFAULT,
			title: intl('marketSearchTitle', { query: query, count: type === 'buy' ? offers.buy.length : offers.sell.length }).slice(0, 256),
			description: `*${itemNames}*\n\n${description}`.slice(0, 4096),
			fields: fields,
			footer: { text: instance.serverList[rustplus.serverId].title }
		});
		await client.interactionEditReply(interaction, { embeds: [embed] });
	},
};
