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
 *  Helpers to configure the switches / switch groups an alarm turns on, or off ("-name").
 */

/**
 *  Resolves a comma separated list of switch / group names, commands or ids. A "-" in front
 *  means "turn it off" (e.g. "turrets, -sam").
 *  @return {Object} { groups, switches, offGroups, offSwitches, unknown }
 */
function resolveActionTargets(server, text) {
    const result = { groups: [], switches: [], offGroups: [], offSwitches: [], unknown: [] };
    if (!text) return result;

    const norm = (s) => `${s}`.trim().toLowerCase();
    for (const raw of text.split(',')) {
        let token = norm(raw);
        const off = token.startsWith('-');
        if (off) token = norm(token.slice(1));
        if (token === '') continue;
        const groups = off ? result.offGroups : result.groups;
        const switches = off ? result.offSwitches : result.switches;

        const groupId = Object.keys(server.switchGroups || {}).find(id =>
            norm(id) === token || norm(server.switchGroups[id].name) === token ||
            norm(server.switchGroups[id].command) === token);
        if (groupId !== undefined) {
            if (!groups.includes(groupId)) groups.push(groupId);
            continue;
        }

        const switchId = Object.keys(server.switches || {}).find(id =>
            norm(id) === token || norm(server.switches[id].name) === token ||
            norm(server.switches[id].command) === token);
        if (switchId !== undefined) {
            if (!switches.includes(switchId)) switches.push(switchId);
            continue;
        }

        result.unknown.push(raw.trim());
    }
    return result;
}

function hasTargets(targets) {
    return targets.groups.length + targets.switches.length +
        (targets.offGroups || []).length + (targets.offSwitches || []).length > 0;
}

/**
 *  Names of the configured actions. which: 'on', 'off', or 'all' (for the edit form, with "-"
 *  in front of the ones turned off).
 */
function describeActionTargets(server, alarm, which = 'on') {
    if (!alarm.actions) return '';
    const names = (groups, switches, prefix) => {
        const out = [];
        for (const groupId of groups || []) {
            if (server.switchGroups && server.switchGroups[groupId]) out.push(prefix + server.switchGroups[groupId].name);
        }
        for (const entityId of switches || []) {
            if (server.switches && server.switches[entityId]) out.push(prefix + server.switches[entityId].name);
        }
        return out;
    };
    const on = names(alarm.actions.groups, alarm.actions.switches, '');
    const off = names(alarm.actions.offGroups, alarm.actions.offSwitches, which === 'all' ? '-' : '');
    if (which === 'off') return off.join(', ');
    if (which === 'all') return on.concat(off).join(', ');
    return on.join(', ');
}

module.exports = {
    resolveActionTargets: resolveActionTargets,
    describeActionTargets: describeActionTargets,
    hasTargets: hasTargets
};
