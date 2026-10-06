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
 *  /limpieza (admins): shows a confirmation button, nothing is deleted until it is pressed.
 *  - server: everything about servers other than the active one (after moving to another server).
 *  - todo: everything about every server (disconnects the bot). Settings, credentials and the
 *    market watch list are kept.
 */

const Builder = require('@discordjs/builders');

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const ServerLifecycle = require('../util/serverLifecycle.js');

module.exports = {
	name: 'limpieza',

	getData(client, guildId) {
		return new Builder.SlashCommandBuilder()
			.setName('limpieza')
			.setDescription(client.intlGet(guildId, 'commandsCleanupDesc'))
			.addSubcommand(s => s.setName('server').setDescription(client.intlGet(guildId, 'commandsCleanupOthersDesc')))
			.addSubcommand(s => s.setName('todo').setDescription(client.intlGet(guildId, 'commandsCleanupAllDesc')));
	},

	async execute(client, interaction) {
		const guildId = interaction.guildId;
		const instance = client.getInstance(guildId);
		const verifyId = Math.floor(100000 + Math.random() * 900000);
		client.logInteraction(interaction, verifyId, 'slashCommand');

		if (!await client.validatePermissions(interaction)) return;
		await interaction.deferReply({ ephemeral: true });

		if (Config.discord.needAdminPrivileges && !client.isAdministrator(interaction)) {
			await client.interactionEditReply(interaction,
				DiscordEmbeds.getActionInfoEmbed(1, client.intlGet(guildId, 'missingPermission')));
			return;
		}

		const subcommand = interaction.options.getSubcommand();
		client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'slashCommandValueChange', {
			id: `${verifyId}`,
			value: `limpieza ${subcommand}`
		}));

		const active = instance.activeServer;
		let content = null;
		if (subcommand === 'server') {
			content = ServerLifecycle.getServerChangeMessage(client, guildId, active);
		}
		else {
			content = ServerLifecycle.getPurgeAllMessage(client, guildId);
		}

		if (!content) {
			await client.interactionEditReply(interaction, {
				embeds: [DiscordEmbeds.getEmbed({
					color: Constants.COLOR_DEFAULT,
					description: client.intlGet(guildId, 'cleanupNothing')
				})]
			});
			return;
		}
		await client.interactionEditReply(interaction, content);
	},
};
