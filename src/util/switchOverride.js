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
 *  Manual override for switches in a proximity / any-online automatic mode.
 *  When someone turns such a switch on/off by hand, the automatic mode leaves it alone
 *  until the situation it reacts to changes (e.g. everyone leaves the base or logs off),
 *  and then takes over again.
 */

const OVERRIDABLE_MODES = [5, 6, 7, 8];

module.exports = {
    /* Call when a switch is turned on/off by hand (Discord, in-game command, in game). */
    setManual: function (switchContent, active) {
        if (!switchContent || !OVERRIDABLE_MODES.includes(switchContent.autoDayNightOnOff)) return false;
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
    }
};
