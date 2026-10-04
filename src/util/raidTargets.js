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
 *  Helpers to configure the switches / switch groups an alarm turns on.
 */

/**
 *  Resolves a comma separated list of switch / group names, commands or ids.
 *  @return {Object} { groups: [groupId], switches: [entityId], unknown: [token] }
 */
function resolveActionTargets(server, text) {
    const result = { groups: [], switches: [], unknown: [] };
    if (!text) return result;

    const norm = (s) => `${s}`.trim().toLowerCase();
    for (const raw of text.split(',')) {
        const token = norm(raw);
        if (token === '') continue;

        const groupId = Object.keys(server.switchGroups || {}).find(id =>
            norm(id) === token || norm(server.switchGroups[id].name) === token ||
            norm(server.switchGroups[id].command) === token);
        if (groupId !== undefined) {
            if (!result.groups.includes(groupId)) result.groups.push(groupId);
            continue;
        }

        const switchId = Object.keys(server.switches || {}).find(id =>
            norm(id) === token || norm(server.switches[id].name) === token ||
            norm(server.switches[id].command) === token);
        if (switchId !== undefined) {
            if (!result.switches.includes(switchId)) result.switches.push(switchId);
            continue;
        }

        result.unknown.push(raw.trim());
    }
    return result;
}

/**
 *  Text shown in the alarm edit modal for the configured actions.
 */
function describeActionTargets(server, alarm) {
    if (!alarm.actions) return '';
    const names = [];
    for (const groupId of alarm.actions.groups || []) {
        if (server.switchGroups && server.switchGroups[groupId]) names.push(server.switchGroups[groupId].name);
    }
    for (const entityId of alarm.actions.switches || []) {
        if (server.switches && server.switches[entityId]) names.push(server.switches[entityId].name);
    }
    return names.join(', ');
}

module.exports = {
    resolveActionTargets: resolveActionTargets,
    describeActionTargets: describeActionTargets
};
