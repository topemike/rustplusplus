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

const Discord = require('discord.js');

const DiscordEmbeds = require('../discordTools/discordEmbeds');

module.exports = {
    name: 'interactionCreate',
    async execute(client, interaction) {
        const instance = client.getInstance(interaction.guildId);

        /* Check so that the interaction comes from valid channels. Slash commands work everywhere, and so
           do buttons of private (ephemeral) answers, e.g. the /limpieza confirmation in any channel. */
        const isComponent = (typeof interaction.isButton === 'function' && interaction.isButton()) ||
            (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu());
        const ephemeral = interaction.message && interaction.message.flags &&
            typeof interaction.message.flags.has === 'function' &&
            interaction.message.flags.has(Discord.MessageFlags.Ephemeral);
        if (isComponent && !ephemeral && !Object.values(instance.channelId).includes(interaction.channelId)) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'interactionInvalidChannel'));
            try {
                await interaction.deferUpdate();
            }
            catch (e) {
                client.log(client.intlGet(null, 'errorCap'),
                    client.intlGet(null, 'couldNotDeferInteraction'), 'error');
            }
            return;     /* answered once: the handler must not answer again */
        }

        if (interaction.isButton()) {
            await require('../handlers/buttonHandler')(client, interaction)
                .catch(e => client.log(client.intlGet(null, 'errorCap'), e, 'error'));
        }
        else if (interaction.isStringSelectMenu()) {
            await require('../handlers/selectMenuHandler')(client, interaction)
                .catch(e => client.log(client.intlGet(null, 'errorCap'), e, 'error'));
        }
        else if (interaction.type === Discord.InteractionType.ApplicationCommand) {
            const command = interaction.client.commands.get(interaction.commandName);

            /* If the command doesn't exist, return */
            if (!command) return;

            try {
                await command.execute(client, interaction);
            }
            catch (e) {
                client.log(client.intlGet(null, 'errorCap'), e, 'error');

                const str = client.intlGet(interaction.guildId, 'errorExecutingCommand');
                await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(1, str));
                client.log(client.intlGet(null, 'errorCap'), str, 'error');
            }
        }
        else if (interaction.type === Discord.InteractionType.ModalSubmit) {
            await require('../handlers/modalHandler')(client, interaction)
                .catch(e => client.log(client.intlGet(null, 'errorCap'), e, 'error'));
        }
        else {
            client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'unknownInteraction'), 'error');

            if (interaction.isButton()) {
                try {
                    await interaction.deferUpdate();
                }
                catch (e) {
                    client.log(client.intlGet(null, 'errorCap'),
                        client.intlGet(null, 'couldNotDeferInteraction'), 'error');
                }
            }
        }
    },
};