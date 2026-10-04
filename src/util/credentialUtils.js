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

/**
 *  Converts the stored issued/expire date of a credential to seconds since epoch.
 *  The credential applications store the JWT 'exp' claim (seconds), but be lenient
 *  with milliseconds and date strings.
 *  @param {string|number} value The stored date.
 *  @return {number|null} Seconds since epoch or null if it can't be parsed.
 */
function toEpochSeconds(value) {
    if (value === undefined || value === null || value === '') return null;

    const number = Number(value);
    if (!isNaN(number) && number > 0) {
        return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
    }

    const parsed = Date.parse(value);
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);

    return null;
}

/**
 *  Formats a duration in seconds as a short human readable string, e.g. '1d 4h' or '35m'.
 */
function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

module.exports = {
    toEpochSeconds: toEpochSeconds,
    formatDuration: formatDuration
};
