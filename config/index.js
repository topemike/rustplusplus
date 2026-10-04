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

module.exports = {
    general: {
        language: process.env.RPP_LANGUAGE || 'en',
        pollingIntervalMs: process.env.RPP_POLLING_INTERVAL || 10000,
        showCallStackError: process.env.RPP_LOG_CALL_STACK || false,
        reconnectIntervalMs: process.env.RPP_RECONNECT_INTERVAL || 15000,
        /* Time zone used for tracker schedules (IANA name, e.g. Europe/Madrid) */
        timezone: process.env.RPP_TIMEZONE || 'Europe/Madrid',
    },
    discord: {
        username: process.env.RPP_DISCORD_USERNAME || 'rustplusplus',
        clientId: process.env.RPP_DISCORD_CLIENT_ID || '',
        token: process.env.RPP_DISCORD_TOKEN || '',
        needAdminPrivileges: process.env.RPP_NEED_ADMIN_PRIVILEGES || true, /* If true, only admins can delete (server, switch..), manage credentials and reset a channel */
    },
    battlemetrics: {
        token: process.env.RPP_BATTLEMETRICS_TOKEN || ''
    },
    healthMonitor: {
        /* Warn in Discord this many hours before FCM credentials expire */
        credentialsWarnHoursBefore: parseInt(process.env.RPP_CREDENTIALS_WARN_HOURS) || 48,
        /* Warn in Discord if the Rust+ connection is down for this many minutes */
        disconnectAlertMinutes: parseInt(process.env.RPP_DISCONNECT_ALERT_MINUTES) || 10
    },
    trackerIntel: {
        /* Days of login/logout history kept per tracked player */
        historyDays: parseInt(process.env.RPP_TRACKER_HISTORY_DAYS) || 30,
        /* Days used to calculate the online schedule of a tracker */
        scheduleDays: parseInt(process.env.RPP_TRACKER_SCHEDULE_DAYS) || 14,
        /* Minutes the whole clan must stay offline before the "all offline" alert */
        allOfflineConfirmMinutes: parseInt(process.env.RPP_TRACKER_OFFLINE_CONFIRM_MINUTES) || 2,
        /* "Clan logging in" alert: this many members connecting within the window */
        groupLoginThreshold: parseInt(process.env.RPP_TRACKER_GROUP_LOGIN_THRESHOLD) || 2,
        groupLoginWindowMinutes: parseInt(process.env.RPP_TRACKER_GROUP_LOGIN_WINDOW_MINUTES) || 10,
        groupLoginCooldownMinutes: parseInt(process.env.RPP_TRACKER_GROUP_LOGIN_COOLDOWN_MINUTES) || 30
    },
    raid: {
        /* Grouped raid alarms: reminder every N minutes while nobody acknowledges */
        reminderMinutes: parseInt(process.env.RPP_RAID_REMINDER_MINUTES) || 5,
        /* The raid is considered over after N minutes without alarm triggers */
        quietMinutes: parseInt(process.env.RPP_RAID_QUIET_MINUTES) || 10,
        /* Minimum seconds between edits of the raid message */
        editThrottleSeconds: parseInt(process.env.RPP_RAID_EDIT_THROTTLE_SECONDS) || 5,
        /* Default minutes that alarm actions keep switches on */
        defaultHoldMinutes: parseInt(process.env.RPP_RAID_HOLD_MINUTES) || 15
    },
    backup: {
        /* Daily backup of instances/ and credentials/ */
        enabled: process.env.RPP_BACKUP_ENABLED !== 'false',
        directory: process.env.RPP_BACKUP_DIR || 'logs/backups',
        keepDays: parseInt(process.env.RPP_BACKUP_KEEP_DAYS) || 14
    }
};
