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
	name: 'gangas',

	getData(client, guildId) {
		return new Builder.SlashCommandBuilder()
			.setName('gangas')
			.setDescription(client.intlGet(guildId, 'commandsBargainsDesc'))
			.addSubcommand(subcommand => subcommand
				.setName('ver')
				.setDescription(client.intlGet(guildId, 'commandsBargainsShowDesc')))
			.addSubcommand(subcommand => subcommand
				.setName('lista')
				.setDescription(client.intlGet(guildId, 'commandsBargainsListDesc')))
			.addSubcommand(subcommand => subcommand
				.setName('anadir')
				.setDescription(client.intlGet(guildId, 'commandsBargainsAddDesc'))
				.addStringOption(option => option
					.setName('objeto')
					.setDescription(client.intlGet(guildId, 'commandsFindItemDesc'))
					.setRequired(true))
				.addNumberOption(option => option
					.setName('maximo')
					.setDescription(client.intlGet(guildId, 'commandsBargainsMaxDesc'))
					.setRequired(false)
					.setMinValue(0))
				.addStringOption(option => option
					.setName('moneda')
					.setDescription(client.intlGet(guildId, 'commandsBargainsCurrencyDesc'))
					.setRequired(false)))
			.addSubcommand(subcommand => subcommand
				.setName('quitar')
				.setDescription(client.intlGet(guildId, 'commandsBargainsRemoveDesc'))
				.addIntegerOption(option => option
					.setName('numero')
					.setDescription(client.intlGet(guildId, 'commandsBargainsNumberDesc'))
					.setRequired(true)
					.setMinValue(1)))
			.addSubcommand(subcommand => subcommand
				.setName('vaciar')
				.setDescription(client.intlGet(guildId, 'commandsBargainsClearDesc')));
	},

	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const instance = client.getInstance(guildId);
		const rustplus = client.rustplusInstances[guildId];
		const intl = (id, v) => client.intlGet(guildId, id, v);
		const name = (id) => client.items.getName(id);

		const verifyId = Math.floor(100000 + Math.random() * 900000);
		client.logInteraction(interaction, verifyId, 'slashCommand');

		if (!await client.validatePermissions(interaction)) return;
		await interaction.deferReply({ ephemeral: true });

		if (MarketSearch.ensureBargainList(instance)) client.setInstance(guildId, instance);
		const subcommand = interaction.options.getSubcommand();
		const reply = async (title, description, color = Constants.COLOR_DEFAULT) => {
			await client.interactionEditReply(interaction, {
				embeds: [DiscordEmbeds.getEmbed({ color: color, title: title, description: `${description}`.slice(0, 4096) })]
			});
		};

		client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
			id: `${verifyId}`,
			value: `gangas ${subcommand}`
		}));

		const ruleText = (b) => {
			if (b.max !== null && b.max !== undefined) {
				return intl('marketRuleMax', { item: name(b.itemId), max: MarketSearch.formatNumber(b.max),
					currency: name(b.currencyId) });
			}
			if (b.currencyId) return intl('marketRuleCurrency', { item: name(b.itemId), currency: name(b.currencyId) });
			return intl('marketRuleAny', { item: name(b.itemId) });
		};
		const listText = () => instance.marketBargains.length === 0 ? intl('marketBargainListEmpty') :
			instance.marketBargains.map((b, i) => `**${i + 1}.** ${ruleText(b)}`).join('\n');

		switch (subcommand) {
			case 'ver': {
				if (!rustplus || !rustplus.isOperational || !rustplus.mapMarkers) {
					await reply(intl('marketBargainsTitle'), intl('notConnectedToRustServer'), Constants.COLOR_INACTIVE);
					return;
				}
				const hits = MarketSearch.findBargains(instance.marketBargains, rustplus.mapMarkers.vendingMachines);
				const offers = hits.map(h => h.offer).sort((a, b) =>
					a.itemId.localeCompare(b.itemId) || a.currencyId.localeCompare(b.currencyId) ||
					a.unitPrice - b.unitPrice);
				const lines = MarketSearch.formatOffersDiscord(client.items, offers, intl, 25);
				await reply(intl('marketBargainsTitle'), lines.length === 0 ? intl('marketNoBargainsNow') :
					lines.join('\n'), lines.length === 0 ? Constants.COLOR_DEFAULT : Constants.COLOR_ACTIVE);
			} break;

			case 'lista': {
				await reply(intl('marketBargainListTitle'), listText());
			} break;

			case 'anadir': {
				const query = interaction.options.getString('objeto');
				const max = interaction.options.getNumber('maximo');
				let currencyQuery = interaction.options.getString('moneda');
				if (max !== null && !currencyQuery) currencyQuery = 'scrap';   /* a price needs a currency */

				const itemIds = MarketSearch.resolveQuery(client.items, query);
				const currencyIds = currencyQuery ? MarketSearch.resolveQuery(client.items, currencyQuery) : [null];
				if (itemIds.length === 0 || currencyIds.length === 0) {
					await reply(intl('marketBargainListTitle'), intl('noItemWithNameFound', {
						name: itemIds.length === 0 ? query : currencyQuery }), Constants.COLOR_INACTIVE);
					return;
				}

				/* An alias can match several items (e.g. "cohetes"): one rule per item */
				const currencyId = currencyIds[0];
				const rules = [];
				for (const itemId of itemIds.slice(0, 10)) {
					let rule = instance.marketBargains.find(b => b.itemId === itemId &&
						(b.currencyId || null) === currencyId);
					if (rule) rule.max = max;
					else {
						rule = { itemId: itemId, currencyId: currencyId, max: max };
						instance.marketBargains.push(rule);
					}
					rules.push(rule);
				}
				client.setInstance(guildId, instance);

				/* Offers already on the map are shown here, and only later changes are notified */
				let current = '';
				if (rustplus && rustplus.isOperational && rustplus.mapMarkers) {
					const vms = rustplus.mapMarkers.vendingMachines;
					for (const rule of rules) MarketSearch.primeRule(guildId, rule, vms);
					const offers = MarketSearch.findBargains(rules, vms).map(h => h.offer)
						.sort((a, b) => a.unitPrice - b.unitPrice);
					current = `\n\n**${intl('marketNowOnMap')}**\n` + (offers.length === 0 ?
						intl('marketNothingForSale', { items: rules.map(r => name(r.itemId)).join(', ') }) :
						MarketSearch.formatOffersDiscord(client.items, offers, intl, 15).join('\n'));
				}

				await reply(intl('marketBargainListTitle'), `${intl('marketBargainAdded', {
					rules: rules.map(ruleText).join(', ') })}${current}\n\n${listText()}`, Constants.COLOR_ACTIVE);
			} break;

			case 'quitar': {
				const index = interaction.options.getInteger('numero') - 1;
				if (index < 0 || index >= instance.marketBargains.length) {
					await reply(intl('marketBargainListTitle'), listText(), Constants.COLOR_INACTIVE);
					return;
				}
				instance.marketBargains.splice(index, 1);
				client.setInstance(guildId, instance);
				await reply(intl('marketBargainListTitle'), listText());
			} break;

			case 'vaciar': {
				instance.marketBargains = [];
				client.setInstance(guildId, instance);
				await reply(intl('marketBargainListTitle'), listText());
			} break;

			default: {
			} break;
		}
	},
};
