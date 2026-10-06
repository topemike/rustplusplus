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
const DeepSea = require('../handlers/deepSeaHandler.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const Timer = require('../util/timer');

module.exports = {
	name: 'deepsea',

	getData(client, guildId) {
		return new Builder.SlashCommandBuilder()
			.setName('deepsea')
			.setDescription(client.intlGet(guildId, 'commandsDeepSeaDesc'))
			.addSubcommand(subcommand => subcommand
				.setName('abierto')
				.setDescription(client.intlGet(guildId, 'commandsDeepSeaOpenDesc'))
				.addIntegerOption(option => option
					.setName('hace')
					.setDescription(client.intlGet(guildId, 'commandsDeepSeaAgoDesc'))
					.setRequired(false)
					.setMinValue(0)
					.setMaxValue(600)))
			.addSubcommand(subcommand => subcommand
				.setName('cerrado')
				.setDescription(client.intlGet(guildId, 'commandsDeepSeaClosedDesc'))
				.addIntegerOption(option => option
					.setName('hace')
					.setDescription(client.intlGet(guildId, 'commandsDeepSeaAgoDesc'))
					.setRequired(false)
					.setMinValue(0)
					.setMaxValue(600)))
			.addSubcommand(subcommand => subcommand
				.setName('estado')
				.setDescription(client.intlGet(guildId, 'commandsDeepSeaStatusDesc')))
			.addSubcommand(subcommand => subcommand
				.setName('tiempos')
				.setDescription(client.intlGet(guildId, 'commandsDeepSeaTimesDesc'))
				.addIntegerOption(option => option
					.setName('abierto_min')
					.setDescription(client.intlGet(guildId, 'commandsDeepSeaOpenMinDesc'))
					.setRequired(false)
					.setMinValue(10))
				.addIntegerOption(option => option
					.setName('cerrado_min')
					.setDescription(client.intlGet(guildId, 'commandsDeepSeaClosedMinDesc'))
					.setRequired(false)
					.setMinValue(5))
				.addIntegerOption(option => option
					.setName('cerrado_max')
					.setDescription(client.intlGet(guildId, 'commandsDeepSeaClosedMaxDesc'))
					.setRequired(false)
					.setMinValue(5)))
			.addSubcommand(subcommand => subcommand
				.setName('borrar')
				.setDescription(client.intlGet(guildId, 'commandsDeepSeaResetDesc')));
	},

	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const instance = client.getInstance(guildId);
		const intl = (id, v) => client.intlGet(guildId, id, v);

		const verifyId = Math.floor(100000 + Math.random() * 900000);
		client.logInteraction(interaction, verifyId, 'slashCommand');

		if (!await client.validatePermissions(interaction)) return;
		await interaction.deferReply({ ephemeral: false });

		const reply = async (text, color = Constants.COLOR_DEFAULT) => {
			await client.interactionEditReply(interaction, {
				embeds: [DiscordEmbeds.getEmbed({ color: color, title: intl('deepSeaTitle'), description: text })]
			});
		};

		const server = instance.activeServer !== null ? instance.serverList[instance.activeServer] : null;
		if (!server) {
			await reply(intl('notConnectedToRustServer'), Constants.COLOR_INACTIVE);
			return;
		}

		const subcommand = interaction.options.getSubcommand();
		client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
			id: `${verifyId}`,
			value: `deepsea ${subcommand}`
		}));

		switch (subcommand) {
			case 'abierto':
			case 'cerrado': {
				await reply(DeepSea.markAndDescribe(client, guildId, instance, server, subcommand === 'abierto',
					Date.now(), interaction.options.getInteger('hace') || 0),
					subcommand === 'abierto' ? Constants.COLOR_ACTIVE : Constants.COLOR_DEFAULT);
			} break;

			case 'estado': {
				const ds = DeepSea.getDeepSea(server);
				const d = DeepSea.durations(ds);
				await reply(`${DeepSea.statusText(client, guildId, ds)}\n\n${intl('deepSeaDurations', {
					open: Timer.secondsToFullScale(d.openMs / 1000, 's'),
					closedMin: Timer.secondsToFullScale(d.closedMinMs / 1000, 's'),
					closedMax: Timer.secondsToFullScale(d.closedMaxMs / 1000, 's')
				})}`);
			} break;

			case 'tiempos': {
				const ds = DeepSea.getDeepSea(server);
				const open = interaction.options.getInteger('abierto_min');
				const closedMin = interaction.options.getInteger('cerrado_min');
				const closedMax = interaction.options.getInteger('cerrado_max');
				if (open !== null) ds.openMs = open * 60 * 1000;
				if (closedMin !== null) ds.closedMinMs = closedMin * 60 * 1000;
				if (closedMax !== null) ds.closedMaxMs = closedMax * 60 * 1000;
				ds.warned = {};
				client.setInstance(guildId, instance);
				const d = DeepSea.durations(ds);
				await reply(`${intl('deepSeaDurations', {
					open: Timer.secondsToFullScale(d.openMs / 1000, 's'),
					closedMin: Timer.secondsToFullScale(d.closedMinMs / 1000, 's'),
					closedMax: Timer.secondsToFullScale(d.closedMaxMs / 1000, 's')
				})}\n${DeepSea.statusText(client, guildId, ds)}`);
			} break;

			case 'borrar': {
				DeepSea.reset(server);
				client.setInstance(guildId, instance);
				await reply(intl('deepSeaNotSynced'));
			} break;

			default: {
			} break;
		}
	},
};
