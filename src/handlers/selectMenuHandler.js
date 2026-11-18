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

const CustomId = require('../util/customId.js');

const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordSelectMenus = require('../discordTools/discordSelectMenus.js');
const DiscordTools = require('../discordTools/discordTools.js');

module.exports = async (client, interaction) => {
    const instance = client.getInstance(interaction.guildId);
    const guildId = interaction.guildId;
    const rustplus = client.rustplusInstances[guildId];

    const verifyId = Math.floor(100000 + Math.random() * 900000);
    client.logInteraction(interaction, verifyId, 'userSelectMenu');

    if (instance.blacklist['discordIds'].includes(interaction.user.id) &&
        !interaction.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator)) {
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userPartOfBlacklist', {
            id: `${verifyId}`,
            user: `${interaction.user.username} (${interaction.user.id})`
        }));
        try { await interaction.deferUpdate(); }
        catch (e) { /* already answered */ }
        return;
    }

    if (interaction.customId === 'language') {
        instance.generalSettings.language = interaction.values[0];
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.language = interaction.values[0];

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.language}`
        }));

        await interaction.deferUpdate();

        client.loadGuildIntl(guildId);

        await client.interactionEditReply(interaction, {
            components: [DiscordSelectMenus.getLanguageSelectMenu(guildId, interaction.values[0])]
        });

        /* Re-register the slash commands in the new language; a failure is only logged (no exit) */
        const guild = DiscordTools.getGuild(guildId);
        try { await require('../discordTools/RegisterSlashCommands')(client, guild, false); }
        catch (e) { client.log(client.intlGet(null, 'errorCap'), `${e}`, 'error'); }
    }
    else if (interaction.customId === 'Prefix') {
        instance.generalSettings.prefix = interaction.values[0];
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.prefix = interaction.values[0];

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.prefix}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordSelectMenus.getPrefixSelectMenu(guildId, interaction.values[0])]
        });
    }
    else if (interaction.customId === 'Trademark') {
        instance.generalSettings.trademark = interaction.values[0];
        client.setInstance(guildId, instance);

        if (rustplus) {
            rustplus.generalSettings.trademark = interaction.values[0];
            rustplus.trademarkString = (instance.generalSettings.trademark === 'NOT SHOWING') ?
                '' : `${instance.generalSettings.trademark} | `;
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.trademark}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordSelectMenus.getTrademarkSelectMenu(guildId, interaction.values[0])]
        });
    }
    else if (interaction.customId === 'CommandDelay') {
        instance.generalSettings.commandDelay = interaction.values[0];
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.commandDelay = interaction.values[0];

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.commandDelay}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordSelectMenus.getCommandDelaySelectMenu(guildId, interaction.values[0])]
        });
    }
    else if (interaction.customId === 'VoiceGender') {
        instance.generalSettings.voiceGender = interaction.values[0];
        client.setInstance(guildId, instance);

        if (rustplus) rustplus.generalSettings.voiceGender = interaction.values[0];

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${instance.generalSettings.voiceGender}`
        }));

        await client.interactionUpdate(interaction, {
            components: [DiscordSelectMenus.getVoiceGenderSelectMenu(guildId, interaction.values[0])]
        });
    }
    else if (interaction.customId.startsWith('AutoDayNightOnOff')) {
        const ids = CustomId.parse('AutoDayNightOnOff', interaction.customId, instance);
        const server = instance.serverList[ids.serverId];

        if (!server || (server && !server.switches.hasOwnProperty(ids.entityId))) {
            try { await interaction.deferUpdate(); }
            catch (e) { /* already answered */ }
            try { await interaction.message.delete(); }
            catch (e) { /* already gone */ }
            return;
        }

        const value = parseInt(interaction.values[0]);
        if ((value !== 5 && value !== 6) ||
            ((value === 5 || value === 6) && server.switches[ids.entityId].location !== null)) {
            server.switches[ids.entityId].autoDayNightOnOff = value;
            /* The mode chosen now prevails over an earlier change by hand */
            require('../util/switchOverride.js').clear(server.switches[ids.entityId]);
            client.setInstance(guildId, instance);

            /* A pending timed command would later turn the switch against the chosen mode */
            if (rustplus && rustplus.currentSwitchTimeouts) {
                clearTimeout(rustplus.currentSwitchTimeouts[ids.entityId]);
                delete rustplus.currentSwitchTimeouts[ids.entityId];
            }
        }

        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'selectMenuValueChange', {
            id: `${verifyId}`,
            value: `${server.switches[ids.entityId].autoDayNightOnOff}`
        }));

        await DiscordMessages.sendSmartSwitchMessage(guildId, ids.serverId, ids.entityId, interaction);
    }

    client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'userSelectMenuInteractionSuccess', {
        id: `${verifyId}`
    }));
}