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
 *  Manual override for switches in an automatic mode (always on/off, proximity, any online).
 *  When someone turns such a switch on/off by hand, the automatic mode leaves it alone
 *  until the situation it reacts to changes (e.g. everyone leaves the base or logs off),
 *  and then takes over again.
 */

const OVERRIDABLE_MODES = [3, 4, 5, 6, 7, 8];

module.exports = {
    OVERRIDABLE_MODES: OVERRIDABLE_MODES,

    /* The automatic mode is paused because someone changed the switch by hand */
    isPaused: function (switchContent) {
        return !!switchContent && !!switchContent.manualOverride &&
            OVERRIDABLE_MODES.includes(switchContent.autoDayNightOnOff);
    },

    /* Turned off by a raid alarm: stays like that until someone gives an order */
    isRaidLocked: function (switchContent) {
        return !!switchContent && !!switchContent.raidLock;
    },

    /* Back to automatic: the mode decides again from the next check */
    /* byPerson = false when the bot itself goes back to automatic (a timed command ending) */
    clear: function (switchContent, byPerson = true) {
        if (!switchContent) return;
        delete switchContent.manualOverride;
        delete switchContent.raidLock;
        delete switchContent.holdUntil;
        if (byPerson) switchContent.orderAt = Date.now();   /* an order: the raid in progress does not take it back */
    },

    /* Call when a switch is turned on/off by hand (Discord, in-game command, in game). */
    setManual: function (switchContent, active, byPerson = true) {
        if (!switchContent) return false;
        /* An order ends what a raid alarm did to it, and the raid in progress does not take it back */
        delete switchContent.raidLock;
        delete switchContent.holdUntil;
        if (byPerson) switchContent.orderAt = Date.now();
        if (!OVERRIDABLE_MODES.includes(switchContent.autoDayNightOnOff)) return false;
        switchContent.manualOverride = { active: active, condition: null };
        return true;
    },

    /* Call from the automatic mode with what it wants. Returns true if it must not touch
       the switch. May change switchContent.manualOverride (caller saves the instance). */
    respectManual: function (switchContent, shouldBeOn) {
        const override = switchContent.manualOverride;
        if (!override) return false;

        if (override.active === shouldBeOn) {
            delete switchContent.manualOverride;
            return false;
        }
        if (override.condition === null || override.condition === undefined) {
            override.condition = shouldBeOn;
            return true;
        }
        if (override.condition === shouldBeOn) return true;

        delete switchContent.manualOverride;
        return false;
    },

    /* ---------------------------------------------------------------------
     *  Recognising the bot's own changes when the game echoes them back.
     * --------------------------------------------------------------------- */

    /* The bot is changing this switch (kept even if Rust+ times out, so the late echo is
       still recognised). onConfirm: fields to set on the switch when the echo confirms it. */
    markBotChange: function (rustplus, entityId, value, onConfirm = null) {
        if (!rustplus) return;
        if (!rustplus.botSwitchChanges) rustplus.botSwitchChanges = {};
        rustplus.botSwitchChanges[`${entityId}`] = { value: value, at: Date.now(), onConfirm: onConfirm };
    },

    /* An alarm action on this switch is under way (or waiting for its late echo): automatic modes wait */
    raidChangeInProgress: function (rustplus, entityId, now = Date.now()) {
        const change = rustplus && rustplus.botSwitchChanges ? rustplus.botSwitchChanges[`${entityId}`] : null;
        return !!change && !!change.onConfirm && now - change.at < module.exports.BOT_CHANGE_TTL_MS;
    },

    /* The change was confirmed by Rust+: drop the confirm-on-echo part (the echo is still the bot's) */
    clearBotChangeConfirm: function (rustplus, entityId) {
        const change = rustplus && rustplus.botSwitchChanges ? rustplus.botSwitchChanges[`${entityId}`] : null;
        if (change) change.onConfirm = null;
    },

    /* Entries of rustplus.interactionSwitches (pushed by whoever changes a switch) that never got an
       echo (e.g. set to the value it already had) expire, so they can not swallow a real in-game flip */
    sweepInteractions: function (rustplus, now = Date.now()) {
        if (!rustplus || !Array.isArray(rustplus.interactionSwitches)) return;
        if (!rustplus.interactionSeenAt) rustplus.interactionSeenAt = {};
        const seen = rustplus.interactionSeenAt;
        const ids = new Set(rustplus.interactionSwitches.map(e => `${e}`));
        for (const id of Object.keys(seen)) if (!ids.has(id)) delete seen[id];
        const expired = [];
        for (const id of ids) {
            if (!seen.hasOwnProperty(id)) seen[id] = now;
            else if (now - seen[id] >= module.exports.INTERACTION_TTL_MS) expired.push(id);
        }
        if (expired.length > 0) {
            rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => !expired.includes(`${e}`));
            for (const id of expired) delete seen[id];
        }
        if (rustplus.botSwitchChanges) {
            for (const [id, c] of Object.entries(rustplus.botSwitchChanges)) {
                if (now - c.at >= module.exports.BOT_CHANGE_TTL_MS) delete rustplus.botSwitchChanges[id];
            }
        }
    },

    /**
     *  An entityChanged broadcast of a switch: is it the echo of the bot's own change?
     *  Consumes the matching marker. Returns null (not the bot's) or { onConfirm }.
     */
    takeBotEcho: function (rustplus, entityId, value, switchContent, now = Date.now()) {
        const id = `${entityId}`;
        let result = null;
        const change = rustplus.botSwitchChanges ? rustplus.botSwitchChanges[id] : null;
        if (change) {
            delete rustplus.botSwitchChanges[id];
            if (change.value === value && now - change.at < module.exports.BOT_CHANGE_TTL_MS) {
                result = { onConfirm: change.onConfirm };
            }
        }
        if (Array.isArray(rustplus.interactionSwitches) &&
            rustplus.interactionSwitches.some(e => `${e}` === id)) {
            rustplus.interactionSwitches = rustplus.interactionSwitches.filter(e => `${e}` !== id);
            if (rustplus.interactionSeenAt) delete rustplus.interactionSeenAt[id];
            /* The bot stores the value it asks for before asking: a different value is a person */
            if (!result && switchContent && switchContent.active === value) result = { onConfirm: null };
        }
        return result;
    },

    INTERACTION_TTL_MS: 10 * 1000,
    BOT_CHANGE_TTL_MS: 30 * 1000
};
