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

const Fs = require('fs');
const Path = require('path');
const RustPlusLib = require('@liamcottle/rustplus.js');
const Translate = require('translate');

const Client = require('../../index.ts');
const Config = require('../../config');
const Constants = require('../util/constants.js');
const DailyStats = require('../util/dailyStats.js');
const Decay = require('../util/decay.js');
const DiscordEmbeds = require('../discordTools/discordEmbeds');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordVoice = require('../discordTools/discordVoice.js');
const DiscordTools = require('../discordTools/discordTools.js');
const InGameChatHandler = require('../handlers/inGameChatHandler.js');
const InstanceUtils = require('../util/instanceUtils.js');
const Languages = require('../util/languages.js');
const Logger = require('./Logger.js');
const Map = require('../util/map.js');
const RustPlusLite = require('../structures/RustPlusLite');
const RustRelay = require('../util/rustRelay.js');
const TeamHandler = require('../handlers/teamHandler.js');
const Timer = require('../util/timer.js');
const Utils = require('../util/utils.js');
const Keywords = require('../util/keywords.js');

const TOKENS_LIMIT = 24;        /* Per player */
const TOKENS_REPLENISH = 3;     /* Per second */

class RustPlus extends RustPlusLib {
    constructor(guildId, serverIp, appPort, steamId, playerToken) {
        super(serverIp, appPort, steamId, playerToken);

        this.serverId = `${this.server}-${this.port}`;
        this.guildId = guildId;

        this.leaderRustPlusInstance = null;
        this.uptimeServer = null;

        /* Status flags */
        this.isOperational = false;         /* Connected to the server, and request is verified. */
        this.isDeleted = false;             /* Is the rustplus instance deleted? */
        this.isNewConnection = false;       /* Is it an actively selected connection (pressed CONNECT button)? */
        this.isFirstPoll = true;            /* Is this the first poll since connection started? */
        this.awaitingFirstData = false;     /* Connected, waiting for the first complete poll. */
        this.reconnectDelayMs = null;       /* Slower reconnection (relay refused / no or expired token). */

        /* Interval ids */
        this.pollingTaskId = 0;             /* The id of the main polling mechanism of the rustplus instance. */
        this.tokensReplenishTaskId = 0;     /* The id of the replenish task for rustplus tokens. */

        /* Other variable initializations */
        this.tokens = 24;                           /* The amount of tokens that is available at start. */
        this.timers = new Object();                 /* Stores all custom timers that are created. */
        this.markers = new Object();                /* Stores all custom markers that are created. */
        this.storageMonitors = new Object();        /* Contain content information of paired storage monitors. */
        this.currentSwitchTimeouts = new Object();  /* Stores timer ids for auto ON/OFF Smart Switch timeouts. */
        this.passedFirstSunriseOrSunset = false;    /* Becomes true when first sunrise/sunset. */
        this.startTimeObject = new Object();        /* Stores in-game time points before first sunrise/sunset. */
        this.informationIntervalCounter = 0;        /* Counter to decide when information should be updated. */
        this.storageMonitorIntervalCounter = 0;     /* Counter to decide when storage monitors should be updated */
        this.smartSwitchIntervalCounter = 10;       /* Counter to decide when smart switches should be updated */
        this.smartAlarmIntervalCounter = 20;        /* Counter to decide when smart alarms should be updated */
        this.interactionSwitches = [];              /* Stores the ids of smart switches that are interacted in-game. */
        this.messagesSentByBot = [];                /* Stores the last messages sent by the bot to the team chat */

        /* Chat handler variables */
        this.inGameChatQueue = [];
        this.inGameChatTimeout = null;

        /* Stores found vending machine items that are subscribed to */
        this.foundSubscriptionItems = { all: [], buy: [], sell: [] };

        /* When a new item is added to subscription list, dont notify about the already available items. */
        this.firstPollItems = { all: [], buy: [], sell: [] };

        this.allConnections = [];
        this.playerConnections = new Object();
        this.allDeaths = [];
        this.playerDeaths = new Object();
        this.events = {
            all: [],
            cargo: [],
            heli: [],
            small: [],
            large: [],
            chinook: []
        };
        this.patrolHelicopterTracers = new Object();
        this.cargoShipTracers = new Object();

        /* Rustplus structures */
        this.map = null;            /* Stores the Map structure. */
        this.info = null;           /* Stores the Info structure. */
        this.time = null;           /* Stores the Time structure. */
        this.team = null;           /* Stores the Team structure. */
        this.mapMarkers = null;     /* Stores the MapMarkers structure. */

        this.loadRustPlusEvents();
    }

    loadRustPlusEvents() {
        const eventFiles = Fs.readdirSync(
            Path.join(__dirname, '..', 'rustplusEvents')).filter(file => file.endsWith('.js'));
        for (const file of eventFiles) {
            const event = require(`../rustplusEvents/${file}`);
            this.on(event.name, (...args) => event.execute(this, Client.client, ...args));
        }
    }

    loadMarkers() {
        const instance = Client.client.getInstance(this.guildId);

        for (const [name, location] of Object.entries(instance.serverList[this.serverId].markers)) {
            this.markers[name] = { x: location.x, y: location.y, location: location.location };
        }
    }

    build() {
        const instance = Client.client.getInstance(this.guildId);

        /* Setup the logger */
        this.logger = new Logger(Path.join(__dirname, '..', '..', `logs/${this.guildId}.log`), 'guild');
        this.logger.setGuildId(this.guildId);
        this.logger.serverName = instance.serverList[this.serverId].title;

        /* Setup settings */
        this.generalSettings = instance.generalSettings;
        this.notificationSettings = instance.notificationSettings;

        this.connect();
    }

    /* Connect through the Facepunch Rust+ relay when this server has a relay id and the player has
       an auth token; otherwise fall back to the legacy direct connection (never for servers only
       known by their relay id: serverIp 'relay'). Refused/expired/missing tokens retry slowly. */
    connect() {
        const detail = RustRelay.resolveDetailed(this.guildId, this.server, this.port, this.playerId);
        const relay = detail.relay;
        this.reconnectDelayMs = null;

        if (!relay) {
            if (`${this.server}` === 'relay' || (detail.reason === 'noToken' && detail.relayServerId)) {
                /* Direct connections are dropped since the relay change: wait for a token */
                this.connectionMode = 'blocked';
                this.reconnectDelayMs = RustRelay.SLOW_RETRY_MS;
                this.log(Client.client.intlGet(null, 'warningCap'),
                    `Rust+ relay: no rustplus_auth_token for ${this.playerId} ` +
                    `(${detail.reason}) - not connecting, next try in ` +
                    `${Math.round(RustRelay.SLOW_RETRY_MS / 60000)} min.`, 'warn');
                RustRelay.warnTokenProblem(Client.client, this.guildId, this.playerId, 'noToken', {});
                /* Same path as a failed connection: disconnected.js schedules the (slow) retry */
                setImmediate(() => this.emit('disconnected'));
                return;
            }

            this.connectionMode = 'direct';
            this.log(Client.client.intlGet(null, 'infoCap'),
                'Rust+ relay unavailable (no relay server id or auth token) - using direct connection.');
            return super.connect();
        }

        this.connectionMode = 'relay';
        if (detail.reason === 'expired') {
            this.reconnectDelayMs = RustRelay.SLOW_RETRY_MS;
            this.log(Client.client.intlGet(null, 'warningCap'),
                `Rust+ auth token for ${this.playerId} expired at ` +
                `${new Date(relay.expiresAt * 1000).toISOString()}. Re-add credentials.`, 'warn');
            RustRelay.warnTokenProblem(Client.client, this.guildId, this.playerId, 'expired',
                { expiresAt: relay.expiresAt });
        }
        this.log(Client.client.intlGet(null, 'infoCap'),
            `Connecting via Rust+ relay (server id ${relay.relayServerId}).`);

        RustRelay.connect(this, relay);
    }

    /* The first poll produced everything the commands use (info, time, team, map markers) */
    isDataReady() {
        return !!(this.info && this.time && this.team && this.mapMarkers);
    }

    /* After connecting: becomes operational once the first complete poll is in (retried on every
       polling interval when the first one failed). Returns true when it just became operational. */
    markOperationalIfReady() {
        if (this.isOperational || !this.awaitingFirstData || this.isDeleted) return false;
        if (!this.isDataReady()) return false;
        this.awaitingFirstData = false;
        this.isOperational = true;
        this.operationalSince = Date.now();
        try {
            this.updateLeaderRustPlusLiteInstance();
        }
        catch (e) {
            this.log(Client.client.intlGet(null, 'errorCap'), `Leader connection: ${e}`, 'error');
        }
        return true;
    }

    /* Custom (!timer) timers in a form that survives a reconnection: [{ id, message, endsAt }] */
    exportCustomTimers() {
        const list = [];
        for (const [id, content] of Object.entries(this.timers || {})) {
            try {
                if (!content || !content.timer || !content.timer.getStateRunning()) continue;
                list.push({ id: id, message: content.message, endsAt: Date.now() + content.timer.getTimeLeft() });
            }
            catch (e) { /* broken timer: dropped */ }
        }
        return list;
    }

    /* Re-arms custom timers saved with exportCustomTimers(). Timers that ended while the bot was
       disconnected ring shortly after (if not more than 10 min late). */
    restoreCustomTimers(list) {
        let restored = 0;
        for (const saved of list || []) {
            if (!saved || typeof saved.message !== 'string' || !saved.endsAt) continue;
            let remaining = saved.endsAt - Date.now();
            if (remaining < -10 * 60 * 1000) continue;
            if (remaining < 15 * 1000) remaining = 15 * 1000;

            let id = parseInt(saved.id);
            if (isNaN(id) || Object.keys(this.timers).map(Number).includes(id)) {
                id = 0;
                while (Object.keys(this.timers).map(Number).includes(id)) id += 1;
            }
            const message = saved.message;
            this.timers[id] = {
                timer: new Timer.timer(() => {
                    const text = Client.client.intlGet(this.guildId, 'timer', { message: message });
                    this.sendInGameMessage(text, 'TIMER');
                    try {
                        const instance = Client.client.getInstance(this.guildId);
                        const channelId = instance.channelId.activity || instance.channelId.teamchat;
                        if (channelId) {
                            DiscordMessages.sendMessage(this.guildId, { content: `⏰ ${text}` }, null, channelId)
                                .catch(() => { });
                        }
                    }
                    catch (e) { /* the game message is enough */ }
                    delete this.timers[id];
                }, remaining),
                message: message
            };
            this.timers[id].timer.start();
            restored++;
        }
        return restored;
    }

    /* Promotes a team member to leader (directly, or through the leader's own connection).
       Returns null when it worked, else the text to answer. */
    async transferLeadership(steamId, name) {
        let response;
        if (this.team && this.team.leaderSteamId === this.playerId) {
            response = await this.promoteToLeaderAsync(steamId);
            if (!(await this.isResponseValid(response))) response = response || { error: 'no response' };
            else return null;
        }
        else if (this.leaderRustPlusInstance) {
            response = await this.leaderRustPlusInstance.promoteToLeaderAsync(steamId);
            if (this.leaderRustPlusInstance && this.leaderRustPlusInstance.isResponseValid(response)) return null;
        }
        else {
            return Client.client.intlGet(this.guildId, 'leaderNotConnected');
        }

        const error = response && response.error ? `${response.error}` :
            (response instanceof Error ? response.message : `${response}`);
        this.log(Client.client.intlGet(null, 'warningCap'), `Leader transfer to ${steamId} failed: ${error}`, 'warn');
        return Client.client.intlGet(this.guildId, 'leaderTransferFailed', { name: name, error: error });
    }

    updateLeaderRustPlusLiteInstance() {
        if (this.leaderRustPlusInstance !== null) {
            if (Client.client.rustplusLiteReconnectTimers[this.guildId]) {
                clearTimeout(Client.client.rustplusLiteReconnectTimers[this.guildId]);
                Client.client.rustplusLiteReconnectTimers[this.guildId] = null;
            }
            this.leaderRustPlusInstance.isActive = false;
            this.leaderRustPlusInstance.disconnect();
            this.leaderRustPlusInstance = null;
        }

        if (!this.team) return;     /* no team information yet (first poll failed) */
        const instance = Client.client.getInstance(this.guildId);
        const leader = this.team.leaderSteamId;
        if (leader === this.playerId) return;
        if (!(leader in instance.serverListLite[this.serverId])) return;
        const serverLite = instance.serverListLite[this.serverId][leader];

        this.leaderRustPlusInstance = new RustPlusLite(
            this.guildId,
            this.logger,
            this,
            serverLite.serverIp,
            serverLite.appPort,
            serverLite.steamId,
            serverLite.playerToken
        );
        this.leaderRustPlusInstance.connect();
    }

    isServerAvailable() {
        const instance = Client.client.getInstance(this.guildId);
        return instance.serverList.hasOwnProperty(this.serverId);
    }

    updateConnections(steamId, str) {
        const time = Timer.getCurrentDateTime();
        const savedString = `${time} - ${str}`;

        if (this.allConnections.length === 10) {
            this.allConnections.pop();
        }
        this.allConnections.unshift(savedString)

        if (!this.playerConnections.hasOwnProperty(steamId)) {
            this.playerConnections[steamId] = [];
        }

        if (this.playerConnections[steamId].length === 10) {
            this.playerConnections[steamId].pop();
        }
        this.playerConnections[steamId].unshift(savedString);
    }

    updateDeaths(steamId, data) {
        const time = Timer.getCurrentDateTime();
        data['time'] = time;

        if (this.allDeaths.length === 10) {
            this.allDeaths.pop();
        }
        this.allDeaths.unshift(data)

        if (!this.playerDeaths.hasOwnProperty(steamId)) {
            this.playerDeaths[steamId] = [];
        }

        if (this.playerDeaths[steamId].length === 10) {
            this.playerDeaths[steamId].pop();
        }
        this.playerDeaths[steamId].unshift(data);
    }

    updateEvents(event, message) {
        const commandCargoEn = `${Client.client.intlGet('en', 'commandSyntaxCargo')}`;
        const commandHeliEn = `${Client.client.intlGet('en', 'commandSyntaxHeli')}`;
        const commandSmallEn = `${Client.client.intlGet('en', 'commandSyntaxSmall')}`;
        const commandLargeEn = `${Client.client.intlGet('en', 'commandSyntaxLarge')}`;
        const commandChinookEn = `${Client.client.intlGet('en', 'commandSyntaxChinook')}`;
        if (![commandCargoEn, commandHeliEn, commandSmallEn, commandLargeEn, commandChinookEn].includes(event)) return;

        const str = `${Timer.getCurrentDateTime()} - ${message}`;

        if (this.events['all'].length === 10) {
            this.events['all'].pop();
        }
        this.events['all'].unshift(str);

        if (this.events[event].length === 10) {
            this.events[event].pop();
        }
        this.events[event].unshift(str);
    }

    updateBotMessages(message) {
        while (this.messagesSentByBot.length >= Constants.BOT_MESSAGE_HISTORY_LIMIT) {
            this.messagesSentByBot.pop();
        }
        this.messagesSentByBot.unshift(message);
    }

    /* Is this the connection the bot is using now? An older one that is still alive answers
       everything a second time (commands, deaths...), so it must stop. */
    isCurrent() {
        return !this.isDeleted && Client.client.rustplusInstances[this.guildId] === this;
    }

    /* Returns true (and closes this connection) if another connection replaced this one */
    stopIfReplaced() {
        if (this.isCurrent()) return false;
        if (!this.replacedLogged) {
            this.replacedLogged = true;
            this.log(Client.client.intlGet(null, 'warningCap'),
                'Old connection still alive (another one replaced it): closing it to avoid duplicated messages.', 'warning');
        }
        this.isDeleted = true;
        clearInterval(this.pollingTaskId);
        this.disconnect();
        return true;
    }

    deleteThisRustplusInstance() {
        this.isDeleted = true;
        this.disconnect();

        if (Client.client.rustplusInstances.hasOwnProperty(this.guildId)) {
            if (Client.client.rustplusInstances[this.guildId].serverId === this.serverId) {
                delete Client.client.rustplusInstances[this.guildId];
                return true;
            }
        }
        return false;
    }

    log(title, text, level = 'info') {
        this.logger.log(title, text, level);
    }

    logInGameCommand(type = 'Default', message) {
        const args = new Object();
        args['type'] = type;
        args['command'] = message.broadcast.teamMessage.message.message;
        args['user'] = `${message.broadcast.teamMessage.message.name}`;
        args['user'] += ` (${message.broadcast.teamMessage.message.steamId.toString()})`;

        this.log(Client.client.intlGet(null, 'infoCap'), Client.client.intlGet(null, `logInGameCommand`, args));
    }

    sendInGameMessage(message) {
        InGameChatHandler.inGameChatHandler(this, Client.client, message);
    }

    async sendEvent(setting, text, event, embed_color, firstPoll = false, image = null) {
        const img = (image !== null) ? image : setting.image;

        if (!firstPoll) {
            const settingKey = Object.keys(this.notificationSettings).find(k => this.notificationSettings[k] === setting);
            DailyStats.recordEvent(this.guildId, settingKey, text);
        }

        this.updateEvents(event, text);

        if (!firstPoll && setting.discord) {
            await DiscordMessages.sendDiscordEventMessage(this.guildId, this.serverId, text, img, embed_color);
        }
        if (!firstPoll && setting.inGame) {
            await this.sendInGameMessage(`${text}`);
        }
        if (!firstPoll && setting.voice) {
            await DiscordVoice.sendDiscordVoiceMessage(this.guildId, text);
        }
        this.log(Client.client.intlGet(null, 'eventCap'), text);
    }

    replenishTokens() {
        this.tokens += TOKENS_REPLENISH;
        if (this.tokens > TOKENS_LIMIT) this.tokens = TOKENS_LIMIT;
    }

    async waitForAvailableTokens(cost) {
        let timeoutCounter = 0;
        while (this.tokens < cost) {
            if (timeoutCounter === 90) return false;

            await Timer.sleep(1000 / 3);
            timeoutCounter += 1;
        }
        this.tokens -= cost;
        return true;
    }

    async turnSmartSwitchAsync(id, value, timeout = 10000) {
        if (value) {
            return await this.turnSmartSwitchOnAsync(id, timeout);
        }
        else {
            return await this.turnSmartSwitchOffAsync(id, timeout);
        }
    }

    async turnSmartSwitchOnAsync(id, timeout = 10000) {
        try {
            return await this.setEntityValueAsync(id, true, timeout);
        }
        catch (e) {
            return e;
        }
    }

    async turnSmartSwitchOffAsync(id, timeout = 10000) {
        try {
            return await this.setEntityValueAsync(id, false, timeout);
        }
        catch (e) {
            return e;
        }
    }

    async setEntityValueAsync(id, value, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                setEntityValue: {
                    value: value
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async sendTeamMessageAsync(message, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(2))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                sendTeamMessage: {
                    message: message
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getEntityInfoAsync(id, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                getEntityInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getMapAsync(timeout = 30000) {
        try {
            if (!(await this.waitForAvailableTokens(5))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getMap: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTimeAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTime: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getMapMarkersAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getMapMarkers: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getInfoAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTeamInfoAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTeamInfo: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async subscribeToCameraAsync(identifier, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraSubscribe: {
                    cameraId: identifier
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async unsubscribeFromCameraAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraUnsubscribe: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async sendCameraInputAsync(buttons, x, y, timeout = 1000) {
        try {
            if (!(await this.waitForAvailableTokens(0.01))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                cameraInput: {
                    buttons: buttons,
                    mouseDelta: {
                        x: x,
                        y: y
                    }
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async promoteToLeaderAsync(steamId, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                promoteToLeader: {
                    steamId: steamId
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getTeamChatAsync(timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getTeamChat: {}
            }, timeout).catch((e) => {
                return e;
            })
        }
        catch (e) {
            return e;
        }
    }

    async checkSubscriptionAsync(id, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                checkSubscription: {}
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async setSubscriptionAsync(id, value, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(1))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                entityId: id,
                setSubscription: {
                    value: value
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async getCameraFrameAsync(identifier, frame, timeout = 10000) {
        try {
            if (!(await this.waitForAvailableTokens(2))) {
                return { error: Client.client.intlGet(null, 'tokensDidNotReplenish') };
            }

            return await this.sendRequestAsync({
                getCameraFrame: {
                    identifier: identifier,
                    frame: frame
                }
            }, timeout).catch((e) => {
                return e;
            });
        }
        catch (e) {
            return e;
        }
    }

    async isResponseValid(response) {
        if (response === undefined) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsUndefined'), 'error');
            return false;
        }
        else if (response === null) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsUndefined'), 'error');
            return false;
        }
        else if (response.toString() === 'Error: Timeout reached while waiting for response') {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseTimeout'), 'error');
            return false;
        }
        else if (response instanceof Error) {
            /* e.g. the socket is not open yet / was closed: the polling keeps going (it reconnects) */
            this.log(Client.client.intlGet(null, 'errorCap'), Client.client.intlGet(null, 'responseContainError', {
                error: response.message
            }), 'error');
            return false;
        }
        else if (response.hasOwnProperty('error')) {
            this.log(Client.client.intlGet(null, 'errorCap'), Client.client.intlGet(null, 'responseContainError', {
                error: response.error
            }), 'error');
            return false;
        }
        else if (Object.keys(response).length === 0) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsEmpty'), 'error');
            clearInterval(this.pollingTaskId);
            return false;
        }
        return true;
    }

    /* Commands */

    /* What comes after the command word ("!craft rifle 2" -> "rifle 2"), or null if it is not that command */
    getCommandArgs(command, ...keys) {
        const prefix = this.generalSettings.prefix;
        const lower = command.toLowerCase();
        for (const key of keys) {
            for (const lang of [this.guildId, 'en']) {
                const syntax = `${prefix}${Client.client.intlGet(lang, key)}`.toLowerCase();
                if (lower === syntax || lower.startsWith(`${syntax} `)) return command.slice(syntax.length).trim();
            }
        }
        return null;
    }

    /* "!craft" in the language of the guild, for the usage texts */
    getCommandName(key) {
        return `${this.generalSettings.prefix}${Client.client.intlGet(this.guildId, key)}`;
    }

    /* A teammate by name, upper/lower case does not matter: the exact name first, then part of it */
    findTeammate(name) {
        if (name === null || name === undefined || !this.team) return null;
        const lower = `${name}`.toLowerCase();
        if (lower === '') return null;
        return this.team.players.find(p => `${p.name}`.toLowerCase() === lower) ||
            this.team.players.find(p => `${p.name}`.toLowerCase().includes(lower)) || null;
    }

    /* A whole number written by a user ("2", not "-1", "1.5" or "1e3"), or null */
    parseWholeNumber(str) {
        if (!/^\d+$/.test(`${str}`)) return null;
        const number = parseInt(str);
        return Number.isSafeInteger(number) ? number : null;
    }

    /* Facepunch stopped sending some map markers to Rust+ (see MapMarkers.isTypeUnavailable) */
    isMarkerTypeUnavailable(typeName) {
        if (!this.mapMarkers || typeof this.mapMarkers.isTypeUnavailable !== 'function') return false;
        return this.mapMarkers.isTypeUnavailable(this.mapMarkers.types[typeName]);
    }

    getMarkerTypeUnavailableText(key, isInfoChannel = false) {
        return Client.client.intlGet(this.guildId, isInfoChannel ? 'rustPlusNotSentShort' : key);
    }

    /* "Item name 2" -> { name: 'Item name', quantity: 2 }; { error } if the number is not valid */
    splitItemAndNumber(text, defaultNumber, minimum) {
        const words = text.split(/\s+/);
        const lastWord = words[words.length - 1];
        /* Ends with something that looks like a number ("-1", "1.5", "1e3"): it must be a valid one */
        if (words.length > 1 && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(lastWord)) {
            const number = this.parseWholeNumber(lastWord);
            if (number === null || number < minimum) {
                return { error: Client.client.intlGet(this.guildId, 'invalidNumber', { value: lastWord }) };
            }
            return { name: words.slice(0, -1).join(' '), quantity: number };
        }
        return { name: text, quantity: defaultNumber };
    }

    getCommandAfk() {
        let string = '';
        for (const player of this.team.players) {
            if (player.isOnline) {
                if (player.getAfkSeconds() >= Constants.AFK_TIME_SECONDS) {
                    string += `${player.name} [${player.getAfkTime('dhs')}], `;
                }
            }
        }

        return string !== '' ? `${string.slice(0, -2)}.` : Client.client.intlGet(this.guildId, 'noOneIsAfk');
    }

    getCommandAlive(command) {
        const name = this.getCommandArgs(command, 'commandSyntaxAlive');
        if (name === null) return null;

        if (name === '') {
            /* Only who is alive and online: a dead or offline player has not "been alive" */
            const candidates = this.team.players.filter(p => p.isAlive && p.isOnline);
            if (candidates.length === 0) {
                return Client.client.intlGet(this.guildId,
                    this.team.players.some(p => p.isOnline) ? 'allTeammatesAreDead' : 'noOneIsOnline');
            }
            const player = candidates.reduce((prev, curr) => prev.getAliveSeconds() >= curr.getAliveSeconds() ? prev : curr);
            return Client.client.intlGet(this.guildId, 'hasBeenAliveLongest', {
                name: player.name,
                time: player.getAliveTime()
            });
        }

        const player = this.findTeammate(name);
        if (player) {
            return Client.client.intlGet(this.guildId, 'playerHasBeenAliveFor', {
                name: player.name,
                time: player.getAliveTime()
            });
        }

        return Client.client.intlGet(this.guildId, 'couldNotFindTeammate', {
            name: name
        });
    }

    getCommandCargo(isInfoChannel = false) {
        const strings = [];
        let unhandled = this.mapMarkers.cargoShips.map(e => e.id);
        for (const [id, timer] of Object.entries(this.mapMarkers.cargoShipEgressTimers)) {
            const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, parseInt(id));
            const time = Timer.getTimeLeftOfTimer(timer);
            if (time) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'egressInTime', {
                        time: Timer.getTimeLeftOfTimer(timer, 's'),
                        location: cargoShip.location.string
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCargoEntersEgress', {
                        time: time,
                        location: cargoShip.location.string
                    }));
                }
            }
            unhandled = unhandled.filter(e => e != parseInt(id));
        }

        if (unhandled.length > 0) {
            for (const id of unhandled) {
                const cargoShip = this.mapMarkers.getMarkerByTypeId(this.mapMarkers.types.CargoShip, id);
                if (cargoShip.onItsWayOut) {
                    if (isInfoChannel) {
                        return Client.client.intlGet(this.guildId, 'leavingMapAt', {
                            location: cargoShip.location.string
                        });
                    }
                    else {
                        strings.push(Client.client.intlGet(this.guildId, 'cargoLeavingMapAt', {
                            location: cargoShip.location.string
                        }));
                    }
                }
                else {
                    if (isInfoChannel) {
                        return Client.client.intlGet(this.guildId, 'cargoAt', {
                            location: cargoShip.location.string
                        });
                    }
                    else {
                        strings.push(Client.client.intlGet(this.guildId, 'cargoLocatedAt', {
                            location: cargoShip.location.string
                        }));
                    }
                }
            }
        }

        if (strings.length === 0 && this.isMarkerTypeUnavailable('CargoShip')) {
            return this.getMarkerTypeUnavailableText('rustPlusNoCargoShip', isInfoChannel);
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceCargoShipWasOut === null) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'notActive');;
                }
                else {
                    return Client.client.intlGet(this.guildId, 'cargoNotCurrentlyOnMap');
                }
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceCargoShipWasOut) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceCargoLeft', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    getCommandChinook(isInfoChannel = false) {
        const strings = [];
        for (const ch47 of this.mapMarkers.ch47s) {
            if (ch47.ch47Type === 'crate') {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'atLocation', {
                        location: ch47.location.string
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'chinook47Located', {
                        location: ch47.location.string
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceCH47WasOut === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'chinook47NotOnMap');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceCH47WasOut) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeSinceChinook47OnMap', {
                        time: Timer.secondsToFullScale(secondsSince)
                    }));
                }
            }
        }

        return strings;
    }

    getCommandConnection(command) {
        const all = this.getCommandArgs(command, 'commandSyntaxConnections');
        if (all !== null) {
            let number = null;
            if (all !== '') {
                number = this.parseWholeNumber(all);
                if (number === null) return Client.client.intlGet(this.guildId, 'invalidNumber', { value: all });
            }

            if (this.allConnections.length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredConnectionEvents');
            }

            const strings = [];
            let counter = 1;
            for (const event of this.allConnections) {
                if (counter === 6) break;
                if (number === counter) return event;

                strings.push(event);
                counter += 1;
            }

            return strings;
        }

        const args = this.getCommandArgs(command, 'commandSyntaxConnection');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageNameNumber', {
                cmd: this.getCommandName('commandSyntaxConnection'),
                all: this.getCommandName('commandSyntaxConnections')
            });
        }

        const { name, number } = this.splitNameAndNumber(args);
        const player = this.findTeammate(name);
        if (player) {
            if (!this.playerConnections.hasOwnProperty(player.steamId)) {
                this.playerConnections[player.steamId] = [];
            }

            if (this.playerConnections[player.steamId].length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredConnectionEventsUser', {
                    user: player.name
                });
            }

            const strings = [];
            let counter = 1;
            for (const event of this.playerConnections[player.steamId]) {
                if (counter === 6) break;
                if (number === counter) return event;

                strings.push(event);
                counter += 1;
            }

            return strings;
        }

        return Client.client.intlGet(this.guildId, 'couldNotFindTeammate', {
            name: name
        });
    }

    /* "Bob 2" -> { name: 'Bob', number: 2 }, "Big Bob" -> { name: 'Big Bob', number: null } */
    splitNameAndNumber(text) {
        const m = text.match(/^(.*\S)\s+(\d+)$/);
        if (m && this.parseWholeNumber(m[2]) !== null) return { name: m[1], number: parseInt(m[2]) };
        return { name: text, number: null };
    }

    getCommandCraft(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxCraft');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageItemAmount', { cmd: this.getCommandName('commandSyntaxCraft') });
        }

        const parsed = this.splitItemAndNumber(args, 1, 1);
        if (parsed.error) return parsed.error;
        const itemSearchName = parsed.name, itemSearchQuantity = parsed.quantity;

        const item = Client.client.items.getClosestItemIdByName(itemSearchName)
        if (item === null || itemSearchName === '') {
            const str = Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: itemSearchName
            });
            return str;
        }

        const itemId = item;
        const itemName = Client.client.items.getName(itemId);
        const quantity = itemSearchQuantity;

        const craftDetails = Client.client.rustlabs.getCraftDetailsById(itemId);
        if (craftDetails === null) {
            const str = Client.client.intlGet(this.guildId, 'couldNotFindCraftDetails', {
                name: itemName
            });
            return str;
        }

        let str = `${itemName} `;
        if (quantity === 1) {
            str += `(${craftDetails[2].timeString}): `;
        }
        else {
            const time = Timer.secondsToFullScale(craftDetails[2].time * quantity, '', true);
            str += `x${quantity} (${time}): `;
        }

        for (const ingredient of craftDetails[2].ingredients) {
            const ingredientName = Client.client.items.getName(ingredient.id);
            str += `${ingredientName} x${ingredient.quantity * quantity}, `;
        }

        str = str.slice(0, -2);

        return str;
    }

    async getCommandDeath(command, callerSteamId) {
        const all = this.getCommandArgs(command, 'commandSyntaxDeaths');
        const args = all === null ? this.getCommandArgs(command, 'commandSyntaxDeath') : null;
        if (all === null && args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageNameNumber', {
                cmd: this.getCommandName('commandSyntaxDeath'),
                all: this.getCommandName('commandSyntaxDeaths')
            });
        }

        const teamInfo = await this.getTeamInfoAsync();
        if (!(await this.isResponseValid(teamInfo))) return null;
        TeamHandler.handler(this, Client.client, teamInfo.teamInfo);
        this.team.updateTeam(teamInfo.teamInfo);

        /* After the refresh: the distances are measured from who wrote the command */
        const caller = this.team.getPlayer(callerSteamId);
        if (!caller) {
            return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                name: callerSteamId === null ? '' : `${callerSteamId}`
            });
        }

        const describe = (event, prefixString) => {
            const location = event.location;
            if (location === null || location === undefined) {
                return `${prefixString}${Client.client.intlGet(this.guildId, 'unknown')}`;
            }
            const distance = Math.floor(Map.getDistance(caller.x, caller.y, location.x, location.y));
            const direction = Map.getAngleBetweenPoints(caller.x, caller.y, location.x, location.y);
            return prefixString + Client.client.intlGet(this.guildId, 'distanceDirectionGrid', {
                distance: distance, direction: direction, grid: location.location
            });
        };

        if (all !== null) {
            let number = null;
            if (all !== '') {
                number = this.parseWholeNumber(all);
                if (number === null) return Client.client.intlGet(this.guildId, 'invalidNumber', { value: all });
            }

            if (this.allDeaths.length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredDeathEvents');
            }

            const strings = [];
            let counter = 1;
            for (const event of this.allDeaths) {
                if (counter === 6) break;
                const str = describe(event, `${event.time} - ${event.name}: `);
                if (counter === number) return str;
                strings.push(str);
                counter += 1;
            }

            return strings;
        }

        const { name, number } = this.splitNameAndNumber(args);
        const player = this.findTeammate(name);
        if (player) {
            if (!this.playerDeaths.hasOwnProperty(player.steamId)) {
                this.playerDeaths[player.steamId] = [];
            }

            if (this.playerDeaths[player.steamId].length === 0) {
                return Client.client.intlGet(this.guildId, 'noRegisteredDeathEventsUser', {
                    user: player.name
                });
            }

            const strings = [];
            let counter = 1;
            for (const event of this.playerDeaths[player.steamId]) {
                if (counter === 6) break;
                const str = describe(event, `${event.time} - `);
                if (counter === number) return str;
                strings.push(str);
                counter += 1;
            }

            return strings;
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: name
        });
    }

    /**
     *  The thing whose decay is asked: an exact name (any upper/lower case) in vehicles & co., building
     *  blocks or items first; otherwise the closest name of the three together.
     *  @return {Object|null} { type: 'items'|'buildingBlocks'|'other', id } (id = item id or name)
     */
    findDecayTarget(name) {
        const rustlabs = Client.client.rustlabs;
        const items = Client.client.items;
        const candidates = [];
        for (const type of ['other', 'buildingBlocks']) {
            for (const n of Object.keys(rustlabs.decayData[type] || {})) candidates.push({ type: type, id: n, name: n });
        }
        for (const id of Object.keys(rustlabs.decayData['items'] || {})) {
            const itemName = items.getName(id);
            if (itemName) candidates.push({ type: 'items', id: id, name: itemName });
        }

        const lower = name.toLowerCase();
        const exact = candidates.find(c => c.name.toLowerCase() === lower);
        if (exact) return exact;

        const closest = Utils.findClosestString(name, candidates.map(c => c.name));
        if (closest === null) return null;
        return candidates.find(c => c.name === closest) || null;
    }

    getCommandDecay(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxDecay');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageDecay', { cmd: this.getCommandName('commandSyntaxDecay') });
        }

        const parsed = this.splitItemAndNumber(args, null, 0);
        if (parsed.error) return parsed.error;
        const decayItemName = parsed.name, decayItemHp = parsed.quantity;

        const target = this.findDecayTarget(decayItemName);
        if (!target) {
            const str = Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: decayItemName
            });
            return str;
        }
        const type = target.type;
        const itemId = target.id;

        let itemName = null;
        let decayDetails = null;
        if (type === 'items') {
            itemName = Client.client.items.getName(itemId);
            decayDetails = Client.client.rustlabs.getDecayDetailsById(itemId);
        }
        else {
            itemName = itemId;
            const data = Client.client.rustlabs.decayData[type][itemId];
            decayDetails = data ? [type, itemId, itemId, data] : null;
        }

        if (decayDetails === null) {
            const str = Client.client.intlGet(this.guildId, 'couldNotFindDecayDetails', {
                name: itemName
            });
            return str;
        }

        const details = decayDetails[3];

        const hp = decayItemHp === null ? details.hp : decayItemHp;
        if (hp > details.hp) {
            const str = Client.client.intlGet(this.guildId, 'hpExceedMax', {
                hp: hp,
                max: details.hp
            });
            return str;
        }

        const decayMultiplier = hp / details.hp;

        let decayString = `${itemName} (${hp}/${details.hp}) `;
        const decayStrings = [];
        if (details.decayString !== null) {
            let str = `${Client.client.intlGet(this.guildId, 'decay')}: `;
            if (hp === details.hp) {
                decayStrings.push(`${str}${details.decayString}`);
            }
            else {
                const time = Timer.secondsToFullScale(Math.floor(details.decay * decayMultiplier));
                decayStrings.push(`${str}${time}`);
            }
        }

        if (details.decayOutsideString !== null) {
            let str = `${Client.client.intlGet(this.guildId, 'outside')}: `;
            if (hp === details.hp) {
                decayStrings.push(`${str}${details.decayOutsideString}`);
            }
            else {
                const time = Timer.secondsToFullScale(Math.floor(details.decayOutside * decayMultiplier));
                decayStrings.push(`${str}${time}`);
            }
        }

        if (details.decayInsideString !== null) {
            let str = `${Client.client.intlGet(this.guildId, 'inside')}: `;
            if (hp === details.hp) {
                decayStrings.push(`${str}${details.decayInsideString}`);
            }
            else {
                const time = Timer.secondsToFullScale(Math.floor(details.decayInside * decayMultiplier));
                decayStrings.push(`${str}${time}`);
            }
        }

        if (details.decayUnderwaterString !== null) {
            let str = `${Client.client.intlGet(this.guildId, 'underwater')}: `;
            if (hp === details.hp) {
                decayStrings.push(`${str}${details.decayUnderwaterString}`);
            }
            else {
                const time = Timer.secondsToFullScale(Math.floor(details.decayUnderwater * decayMultiplier));
                decayStrings.push(`${str}${time}`);
            }
        }
        decayString += `${decayStrings.join(', ')}.`;

        return decayString;
    }

    getCommandDespawn(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxDespawn');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageItem', { cmd: this.getCommandName('commandSyntaxDespawn') });
        }
        command = args;

        const itemId = Client.client.items.getClosestItemIdByName(command);
        if (itemId === null) {
            return Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: command
            });
        }

        const itemName = Client.client.items.getName(itemId);
        const despawnDetails = Client.client.rustlabs.getDespawnDetailsById(itemId);
        if (despawnDetails === null) {
            return Client.client.intlGet(this.guildId, 'couldNotFindDespawnDetails', {
                name: itemName
            });
        }

        const despawnTime = despawnDetails[2].timeString;

        return Client.client.intlGet(this.guildId, 'despawnTimeOfItem', {
            item: itemName,
            time: despawnTime
        });
    }

    getCommandEvents(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxEvents');
        if (args === null) return null;

        const EVENTS = {
            cargo: 'commandSyntaxCargo', heli: 'commandSyntaxHeli', small: 'commandSyntaxSmall',
            large: 'commandSyntaxLarge', chinook: 'commandSyntaxChinook'
        };
        const usage = () => Client.client.intlGet(this.guildId, 'usageEvents', {
            cmd: this.getCommandName('commandSyntaxEvents'),
            events: Object.values(EVENTS).map(k => Client.client.intlGet(this.guildId, k)).join('|')
        });

        const words = args === '' ? [] : args.split(/\s+/);
        let event = 'all';
        if (words.length > 0 && this.parseWholeNumber(words[0]) === null) {
            const word = Keywords.plain(words.shift());
            event = Object.keys(EVENTS).find(e => [Client.client.intlGet(this.guildId, EVENTS[e]),
                Client.client.intlGet('en', EVENTS[e])].some(w => Keywords.plain(w) === word));
            if (!event) return usage();
        }
        if (words.length > 1) return usage();

        let number = 5;
        if (words.length === 1) {
            number = this.parseWholeNumber(words[0]);
            if (number === null) return usage();
            number = Math.min(Math.max(number, 1), 10);   /* only the last 10 are kept */
        }

        const strings = this.events[event].slice(0, number);
        if (strings.length === 0) {
            if (event === 'cargo' && this.isMarkerTypeUnavailable('CargoShip')) {
                return Client.client.intlGet(this.guildId, 'rustPlusNoCargoShip');
            }
            if (event === 'heli' && this.isMarkerTypeUnavailable('PatrolHelicopter')) {
                return Client.client.intlGet(this.guildId, 'rustPlusNoPatrolHelicopter');
            }
            return Client.client.intlGet(this.guildId, 'noRegisteredEvents');
        }

        return strings;
    }

    getCommandBase(command, callerSteamId) {
        return this.mapMarkers.extraEvents.getCommandBase(command, callerSteamId);
    }

    getCommandBradley(isInfoChannel = false) {
        /* Known from the explosion markers: without them nothing can be known */
        if (this.mapMarkers.extraEvents.bradleyDestroyedAt === null && this.isMarkerTypeUnavailable('Explosion')) {
            return this.getMarkerTypeUnavailableText('rustPlusNoExplosions', isInfoChannel);
        }
        return this.mapMarkers.extraEvents.getCommandBradley(isInfoChannel);
    }

    getCommandCrate(isInfoChannel = false) {
        return this.mapMarkers.extraEvents.getCommandCrate(isInfoChannel);
    }

    getCommandHeli(isInfoChannel = false) {
        const strings = [];
        for (const patrolHelicopter of this.mapMarkers.patrolHelicopters) {
            if (isInfoChannel) {
                return Client.client.intlGet(this.guildId, 'atLocation', {
                    location: patrolHelicopter.location.string
                });
            }
            else {
                strings.push(Client.client.intlGet(this.guildId, 'patrolHelicopterLocatedAt', {
                    location: patrolHelicopter.location.string
                }));
            }
        }

        if (strings.length === 0 && this.isMarkerTypeUnavailable('PatrolHelicopter')) {
            return this.getMarkerTypeUnavailableText('rustPlusNoPatrolHelicopter', isInfoChannel);
        }

        if (strings.length === 0) {
            const wasOnMap = this.mapMarkers.timeSincePatrolHelicopterWasOnMap;
            const wasDestroyed = this.mapMarkers.timeSincePatrolHelicopterWasDestroyed;

            if (wasOnMap == null && wasDestroyed === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'patrolHelicopterNotCurrentlyOnMap');
            }
            else if (wasOnMap !== null && wasDestroyed === null) {
                const secondsSince = (new Date() - wasOnMap) / 1000;
                if (isInfoChannel) {
                    const timeSince = Timer.secondsToFullScale(secondsSince, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: timeSince
                    });
                }
                else {
                    const timeSince = Timer.secondsToFullScale(secondsSince);
                    return Client.client.intlGet(this.guildId, 'timeSincePatrolHelicopterWasOnMap', {
                        time: timeSince
                    });
                }
            }
            else if (wasOnMap !== null && wasDestroyed !== null) {
                if (isInfoChannel) {
                    const timeSinceOnMap = Timer.secondsToFullScale((new Date() - wasOnMap) / 1000, 's');
                    const timeSinceDestroyed = Timer.secondsToFullScale((new Date() - wasDestroyed) / 1000, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLastSinceDestroyedShort', {
                        time1: timeSinceOnMap,
                        time2: timeSinceDestroyed,
                        location: this.mapMarkers.patrolHelicopterDestroyedLocation === null ? '' :
                            ` [${this.mapMarkers.patrolHelicopterDestroyedLocation}]`
                    });
                }
                else {
                    const timeSinceOnMap = Timer.secondsToFullScale((new Date() - wasOnMap) / 1000);
                    const timeSinceDestroyed = Timer.secondsToFullScale((new Date() - wasDestroyed) / 1000);
                    return Client.client.intlGet(this.guildId, 'timeSinceLastSinceDestroyedLong', {
                        time1: timeSinceOnMap,
                        time2: timeSinceDestroyed,
                        location: this.mapMarkers.patrolHelicopterDestroyedLocation === null ? '' :
                            ` [${this.mapMarkers.patrolHelicopterDestroyedLocation}]`
                    });
                }
            }

            /* Destroyed known but not when it was last seen (e.g. only the crash was seen) */
            return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                Client.client.intlGet(this.guildId, 'patrolHelicopterNotCurrentlyOnMap');
        }

        return strings;
    }

    getCommandLarge(isInfoChannel = false) {
        const strings = [];
        if (this.mapMarkers.crateLargeOilRigTimer) {
            const time = Timer.getTimeLeftOfTimer(this.mapMarkers.crateLargeOilRigTimer);
            if (time) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeUntilUnlocksAt', {
                        time: Timer.getTimeLeftOfTimer(this.mapMarkers.crateLargeOilRigTimer, 's'),
                        location: this.mapMarkers.crateLargeOilRigLocation
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCrateAtLargeOilRigUnlocks', {
                        time: time,
                        location: this.mapMarkers.crateLargeOilRigLocation
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceLargeOilRigWasTriggered === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'noData') :
                    Client.client.intlGet(this.guildId, 'noDataOnLargeOilRig');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceLargeOilRigWasTriggered) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLastEvent', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceHeavyScientistsOnLarge', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    async getCommandLeader(command, callerSteamId) {
        const prefix = this.generalSettings.prefix;
        const commandLeader = `${prefix}${Client.client.intlGet(this.guildId, 'commandSyntaxLeader')}`;
        const commandLeaderEn = `${prefix}${Client.client.intlGet('en', 'commandSyntaxLeader')}`;

        if (!this.generalSettings.leaderCommandEnabled) {
            return Client.client.intlGet(this.guildId, 'leaderCommandIsDisabled');
        }

        const instance = Client.client.getInstance(this.guildId);
        if (!Object.keys(instance.serverListLite[this.serverId]).includes(this.team.leaderSteamId)) {
            let names = '';
            for (const player of this.team.players) {
                if (Object.keys(instance.serverListLite[this.serverId]).includes(player.steamId)) {
                    names += `${player.name}, `
                }
            }
            names = names.slice(0, -2);

            return Client.client.intlGet(this.guildId, 'leaderCommandOnlyWorks', {
                name: names
            });
        }

        if (command.toLowerCase() === `${commandLeader}` || command.toLowerCase() === `${commandLeaderEn}`) {
            if (callerSteamId === null) return null;

            if (this.team.leaderSteamId !== callerSteamId) {
                if (this.generalSettings.leaderCommandOnlyForPaired) {
                    if (!Object.keys(instance.serverListLite[this.serverId]).includes(callerSteamId)) {
                        return Client.client.intlGet(this.guildId, 'youAreNotPairedWithServer');
                    }
                }

                const player = this.team.getPlayer(callerSteamId);
                const name = player ? player.name : callerSteamId;
                const failed = await this.transferLeadership(callerSteamId, name);
                if (failed) return failed;

                return Client.client.intlGet(this.guildId, 'leaderTransferred', {
                    name: name
                });
            }
            else {
                return Client.client.intlGet(this.guildId, 'youAreAlreadyLeader');
            }
        }
        else if (command.toLowerCase().startsWith(`${commandLeader} `) ||
            command.toLowerCase().startsWith(`${commandLeaderEn} `)) {
            let name = null;
            if (command.toLowerCase().startsWith(`${commandLeader} `)) {
                name = command.slice(`${commandLeader} `.length).trim();
            }
            else {
                name = command.slice(`${commandLeaderEn} `.length).trim();
            }

            for (const player of this.team.players) {
                if (player.name.includes(name)) {
                    if (this.team.leaderSteamId === player.steamId) {
                        return Client.client.intlGet(this.guildId, 'leaderAlreadyLeader', {
                            name: player.name
                        });
                    }
                    else {
                        if (this.generalSettings.leaderCommandOnlyForPaired) {
                            if (!Object.keys(instance.serverListLite[this.serverId]).includes(player.steamId)) {
                                return Client.client.intlGet(this.guildId, 'playerNotPairedWithServer', {
                                    name: player.name
                                });
                            }
                        }

                        const failed = await this.transferLeadership(player.steamId, player.name);
                        if (failed) return failed;

                        return Client.client.intlGet(this.guildId, 'leaderTransferred', {
                            name: player.name
                        });
                    }
                }
            }

            return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                name: name
            });
        }

        return null;
    }

    /* A saved marker by name, upper/lower case does not matter */
    findMarkerName(name) {
        if (name in this.markers) return name;
        const lower = `${name}`.toLowerCase();
        return Object.keys(this.markers).find(n => n.toLowerCase() === lower) || null;
    }

    async getCommandMarker(command, callerSteamId) {
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (this.getCommandArgs(command, 'commandSyntaxMarkers') === '') {
            let str = '';
            for (const name in this.markers) str += `${name} [${this.markers[name].location}], `;

            return str !== '' ? str.slice(0, -2) : Client.client.intlGet(this.guildId, 'noRegisteredMarkers');
        }

        const args = this.getCommandArgs(command, 'commandSyntaxMarker');
        if (args === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usageMarker', {
            cmd: this.getCommandName('commandSyntaxMarker'), add: commandAdd, remove: commandRemove,
            all: this.getCommandName('commandSyntaxMarkers')
        });
        if (args === '') return usage;

        const subcommand = args.replace(/\s.*/, '');
        const name = args.slice(subcommand.length).trim();

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                const lowerName = name.toLowerCase();
                if (name === '' || [commandAdd, commandRemove, commandAddEn, commandRemoveEn].some(w =>
                    lowerName === w || lowerName.startsWith(`${w} `))) {
                    return usage;
                }

                const teamInfo = await this.getTeamInfoAsync();
                if (!(await this.isResponseValid(teamInfo))) return null;

                for (const player of teamInfo.teamInfo.members) {
                    if (player.steamId.toString() === callerSteamId) {
                        const instance = Client.client.getInstance(this.guildId);
                        const location = Map.getPos(player.x, player.y, this.info.correctedMapSize, this);
                        /* Same name in other case: the old one is replaced */
                        const old = this.findMarkerName(name);
                        if (old !== null && old !== name) {
                            delete this.markers[old];
                            delete instance.serverList[this.serverId].markers[old];
                        }
                        instance.serverList[this.serverId].markers[name] =
                            { x: player.x, y: player.y, location: location.location };
                        Client.client.setInstance(this.guildId, instance);
                        this.markers[name] = { x: player.x, y: player.y, location: location.location };

                        return Client.client.intlGet(this.guildId, 'markerAdded', {
                            name: name,
                            location: location.location
                        });
                    }
                }
                return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                    name: callerSteamId === null ? '' : `${callerSteamId}`
                });
            } break;

            case commandRemoveEn:
            case commandRemove: {
                if (name === '') return usage;
                const instance = Client.client.getInstance(this.guildId);
                const found = this.findMarkerName(name);

                if (found !== null) {
                    const location = this.markers[found].location;
                    delete this.markers[found];
                    delete instance.serverList[this.serverId].markers[found];
                    Client.client.setInstance(this.guildId, instance);

                    return Client.client.intlGet(this.guildId, 'markerRemoved', {
                        name: found,
                        location: location
                    });
                }
                return Client.client.intlGet(this.guildId, 'markerDoesNotExist', {
                    name: name
                });
            } break;

            default: {
                const found = this.findMarkerName(args);
                if (found === null) {
                    return Client.client.intlGet(this.guildId, 'markerDoesNotExist', {
                        name: args
                    });
                }

                const teamInfo = await this.getTeamInfoAsync();
                if (!(await this.isResponseValid(teamInfo))) return null;

                for (const player of teamInfo.teamInfo.members) {
                    if (player.steamId.toString() === callerSteamId) {
                        const marker = this.markers[found];
                        const direction = Map.getAngleBetweenPoints(player.x, player.y, marker.x, marker.y);
                        const distance = Math.floor(Map.getDistance(player.x, player.y, marker.x, marker.y));

                        return Client.client.intlGet(this.guildId, 'markerLocation', {
                            name: found,
                            location: marker.location,
                            distance: distance,
                            player: player.name,
                            direction: direction
                        });
                    }
                }
                return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                    name: callerSteamId === null ? '' : `${callerSteamId}`
                });
            } break;
        }
    }

    getCommandMarket(command) {
        const instance = Client.client.getInstance(this.guildId);
        const commandSearch = `${Client.client.intlGet(this.guildId, 'commandSyntaxSearch')}`;
        const commandSearchEn = `${Client.client.intlGet('en', 'commandSyntaxSearch')}`;
        const commandSub = `${Client.client.intlGet(this.guildId, 'commandSyntaxSubscribe')}`;
        const commandSubEn = `${Client.client.intlGet('en', 'commandSyntaxSubscribe')}`;
        const commandUnsub = `${Client.client.intlGet(this.guildId, 'commandSyntaxUnsubscribe')}`;
        const commandUnsubEn = `${Client.client.intlGet('en', 'commandSyntaxUnsubscribe')}`;
        const commandList = `${Client.client.intlGet(this.guildId, 'commandSyntaxList')}`;
        const commandListEn = `${Client.client.intlGet('en', 'commandSyntaxList')}`;

        const args = this.getCommandArgs(command, 'commandSyntaxMarket');
        if (args === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usageMarket', {
            cmd: this.getCommandName('commandSyntaxMarket'), search: commandSearch, sub: commandSub,
            unsub: commandUnsub, list: commandList
        });
        if (args === '') return usage;

        const subcommand = args.replace(/\s.*/, '').toLowerCase();
        command = args.slice(subcommand.length).trim();

        const orderType = command.replace(/\s.*/, '').toLowerCase();
        const name = command.slice(orderType.length).trim();

        if ([commandSearch, commandSearchEn, commandSub, commandSubEn, commandUnsub, commandUnsubEn].includes(subcommand)) {
            if (orderType === '') return usage;
            if (['all', 'buy', 'sell'].includes(orderType) && name === '') return usage;
        }
        if ([commandSearch, commandSearchEn].includes(subcommand) && this.isMarkerTypeUnavailable('VendingMachine')) {
            return Client.client.intlGet(this.guildId, 'rustPlusNoVendingMachines');
        }

        switch (subcommand) {
            case commandSearchEn:
            case commandSearch: {
                if (!['all', 'buy', 'sell'].includes(orderType)) {
                    return Client.client.intlGet(this.guildId, 'notAValidOrderType', {
                        order: orderType
                    });
                }

                const itemId = Client.client.items.getClosestItemIdByName(name);
                if (itemId === null) {
                    return Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                        name: name
                    });
                }

                const locations = [];
                for (const vendingMachine of this.mapMarkers.vendingMachines) {
                    if (!vendingMachine.hasOwnProperty('sellOrders')) continue;

                    for (const order of vendingMachine.sellOrders) {
                        if (order.amountInStock === 0) continue;

                        const orderItemId =
                            (Object.keys(Client.client.items.items).includes(order.itemId.toString())) ?
                                order.itemId : null;
                        const orderCurrencyId =
                            (Object.keys(Client.client.items.items).includes(order.currencyId.toString())) ?
                                order.currencyId : null;

                        if ((orderType === 'all' &&
                            (orderItemId === parseInt(itemId) || orderCurrencyId === parseInt(itemId))) ||
                            (orderType === 'buy' && orderCurrencyId === parseInt(itemId)) ||
                            (orderType === 'sell' && orderItemId === parseInt(itemId))) {
                            if (locations.includes(vendingMachine.location.location)) continue;
                            locations.push(vendingMachine.location.location);
                        }
                    }
                }

                if (locations.length === 0) {
                    return Client.client.intlGet(this.guildId, 'noItemFound');
                }

                return locations.join(', ');
            } break;

            case commandSubEn:
            case commandSub: {
                if (!['all', 'buy', 'sell'].includes(orderType)) {
                    return Client.client.intlGet(this.guildId, 'notAValidOrderType', {
                        order: orderType
                    });
                }

                const itemId = Client.client.items.getClosestItemIdByName(name);
                if (itemId === null) {
                    return Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                        name: name
                    });
                }
                const itemName = Client.client.items.getName(itemId);


                if (instance.marketSubscriptionList[orderType].includes(itemId)) {
                    return Client.client.intlGet(this.guildId, 'alreadySubscribedToItem', {
                        name: itemName
                    });
                }
                else {
                    instance.marketSubscriptionList[orderType].push(itemId);
                    this.firstPollItems[orderType].push(itemId);
                    Client.client.setInstance(this.guildId, instance);

                    return Client.client.intlGet(this.guildId, 'justSubscribedToItem', {
                        name: itemName
                    });
                }
            } break;

            case commandUnsubEn:
            case commandUnsub: {
                if (!['all', 'buy', 'sell'].includes(orderType)) {
                    return Client.client.intlGet(this.guildId, 'notAValidOrderType', {
                        order: orderType
                    });
                }

                const itemId = Client.client.items.getClosestItemIdByName(name);
                if (itemId === null) {
                    return Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                        name: name
                    });
                }
                const itemName = Client.client.items.getName(itemId);

                if (instance.marketSubscriptionList[orderType].includes(itemId)) {
                    instance.marketSubscriptionList[orderType] =
                        instance.marketSubscriptionList[orderType].filter(e => e !== itemId);
                    Client.client.setInstance(this.guildId, instance);

                    return Client.client.intlGet(this.guildId, 'removedSubscribeItem', {
                        name: itemName
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'notExistInSubscription', {
                        name: itemName
                    });
                }
            } break;

            case commandListEn:
            case commandList: {
                const names = { all: '', buy: '', sell: '' };
                for (const [ot, itemIds] of Object.entries(instance.marketSubscriptionList)) {
                    let counter = 0;
                    for (const itemId of itemIds) {
                        if (counter === 0) names[ot] += `${Client.client.intlGet(this.guildId, ot)}: `;
                        names[ot] += `${Client.client.items.getName(itemId)} (${itemId}), `;
                        counter += 1;
                    }
                    if (counter !== 0) names[ot] = names[ot].slice(0, -2);
                }

                if (names.all === '' && names.buy === '' && names.sell === '') {
                    return Client.client.intlGet(this.guildId, 'subscriptionListEmpty');
                }

                let str = '';
                for (const [ot, otString] of Object.entries(names)) {
                    str += otString;
                }

                return str;
            } break;

            default: {
                return usage;
            } break;
        }
    }

    getCommandMute() {
        const instance = Client.client.getInstance(this.guildId);
        instance.generalSettings.muteInGameBotMessages = true;
        this.generalSettings.muteInGameBotMessages = true;
        Client.client.setInstance(this.guildId, instance);

        return Client.client.intlGet(this.guildId, 'inGameBotMessagesMuted');
    }

    getCommandNote(command) {
        const instance = Client.client.getInstance(this.guildId);
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (this.getCommandArgs(command, 'commandSyntaxNotes') === '') {
            if (Object.keys(instance.serverList[this.serverId].notes).length === 0) {
                return Client.client.intlGet(this.guildId, 'noSavedNotes');
            }

            const strings = [];
            for (const [id, note] of Object.entries(instance.serverList[this.serverId].notes)) {
                strings.push(`${id}: ${note}`);
            }
            return strings;
        }

        const args = this.getCommandArgs(command, 'commandSyntaxNote');
        if (args === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usageNote', {
            cmd: this.getCommandName('commandSyntaxNote'), add: commandAdd, remove: commandRemove,
            all: this.getCommandName('commandSyntaxNotes')
        });

        const subcommand = args.replace(/\s.*/, '');
        const rest = args.slice(subcommand.length).trim();

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                if (rest === '') return usage;
                let index = 0;
                while (Object.keys(instance.serverList[this.serverId].notes).map(Number).includes(index)) {
                    index += 1;
                }

                instance.serverList[this.serverId].notes[index] = `${rest}`;
                Client.client.setInstance(this.guildId, instance);
                return Client.client.intlGet(this.guildId, 'noteSaved');
            } break;

            case commandRemoveEn:
            case commandRemove: {
                const id = this.parseWholeNumber(rest);

                if (id !== null) {
                    if (!Object.keys(instance.serverList[this.serverId].notes).map(Number).includes(id)) {
                        return Client.client.intlGet(this.guildId, 'noteIdDoesNotExist', { id: id });
                    }

                    delete instance.serverList[this.serverId].notes[id];
                    Client.client.setInstance(this.guildId, instance);
                    return Client.client.intlGet(this.guildId, 'noteIdWasRemoved', { id: id });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'noteIdInvalid');
                }
            } break;

            default: {
                return usage;
            } break;
        }
    }

    getCommandOffline() {
        let string = '';
        let counter = 0;
        for (const player of this.team.players) {
            if (!player.isOnline) {
                string += `${player.name}, `;
                counter += 1;
            }
        }
        const amount = `(${counter}/${this.team.players.length}) `;

        return string !== '' ? `${amount}${string.slice(0, -2)}.` :
            `${amount}${Client.client.intlGet(this.guildId, 'noOneIsOffline')}`;
    }

    getCommandOnline() {
        let string = '';
        let counter = 0;
        for (const player of this.team.players) {
            if (player.isOnline) {
                string += `${player.name}, `;
                counter += 1;
            }
        }
        const amount = `(${counter}/${this.team.players.length}) `;

        return string !== '' ? `${amount}${string.slice(0, -2)}.` :
            `${amount}${Client.client.intlGet(this.guildId, 'noOneIsOnline')}`;
    }

    getCommandPlayer(command) {
        const all = this.getCommandArgs(command, 'commandSyntaxPlayers');
        const one = all === null ? this.getCommandArgs(command, 'commandSyntaxPlayer') : null;
        if (all === null && one === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usagePlayers', {
            cmd: this.getCommandName('commandSyntaxPlayer'), all: this.getCommandName('commandSyntaxPlayers')
        });
        if (all !== null && all !== '') return usage;
        if (one === '') return usage;

        if (!Config.battlemetrics || !Config.battlemetrics.token) {
            return Client.client.intlGet(this.guildId, 'battlemetricsTokenNotConfigured');
        }

        const instance = Client.client.getInstance(this.guildId);
        const battlemetricsId = instance.serverList[this.serverId].battlemetricsId;
        const bmInstance = Client.client.battlemetricsInstances[battlemetricsId];

        if (!bmInstance || !bmInstance.lastUpdateSuccessful) {
            return Client.client.intlGet(this.guildId, 'battlemetricsInstanceCouldNotBeFound', {
                id: battlemetricsId
            });
        }

        let foundPlayers = [];
        if (all !== null) {
            foundPlayers = bmInstance.getOnlinePlayerIdsOrderedByTime();
            if (foundPlayers.length === 0) {
                return Client.client.intlGet(this.guildId, 'couldNotFindAnyPlayers');
            }
        }
        else {
            const name = one.toLowerCase();
            for (const playerId of bmInstance.getOnlinePlayerIdsOrderedByTime()) {
                if (`${bmInstance.players[playerId]['name']}`.toLowerCase().includes(name)) foundPlayers.push(playerId);
            }

            if (foundPlayers.length === 0) {
                return Client.client.intlGet(this.guildId, 'couldNotFindPlayer', {
                    name: one
                });
            }
        }

        const trademark = this.generalSettings.trademark;
        const trademarkString = (trademark === 'NOT SHOWING') ? '' : `${trademark} | `;
        const messageMaxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - trademarkString.length;
        const leftLength = `...xxx ${Client.client.intlGet(this.guildId, 'more')}.`.length;

        let string = '';
        let playerIndex = 0;
        for (const playerId of foundPlayers) {
            const time = bmInstance.getOnlineTime(playerId);
            const playerString = `${bmInstance.players[playerId]['name']} [${time[1]}], `;

            if ((string.length + playerString.length + leftLength) < messageMaxLength) {
                string += playerString;
            }
            else if ((string.length + playerString.length + leftLength) > messageMaxLength) {
                break;
            }

            playerIndex += 1;
        }

        if (string !== '') {
            string = string.slice(0, -2);

            if (playerIndex < foundPlayers.length) {
                return Client.client.intlGet(this.guildId, 'morePlayers', {
                    players: string,
                    number: foundPlayers.length - playerIndex
                });
            }
            else {
                return `${string}.`;
            }
        }

        return null;
    }

    getCommandPop(isInfoChannel = false) {
        if (isInfoChannel) {
            return `${this.info.players}${this.info.isQueue() ? `(${this.info.queuedPlayers})` : ''}` +
                `/${this.info.maxPlayers}`;
        }
        else {
            const string = Client.client.intlGet(this.guildId, 'populationPlayers', {
                current: this.info.players,
                max: this.info.maxPlayers
            });
            const queuedPlayers = this.info.isQueue() ?
                ` ${Client.client.intlGet(this.guildId, 'populationQueue', { number: this.info.queuedPlayers })}` : '';

            return `${string}${queuedPlayers}`;
        }
    }

    async getCommandProx(command, callerSteamId) {
        const memberName = this.getCommandArgs(command, 'commandSyntaxProx');
        if (memberName === null) return null;

        const teamInfo = await this.getTeamInfoAsync();
        if (!(await this.isResponseValid(teamInfo))) return null;
        TeamHandler.handler(this, Client.client, teamInfo.teamInfo);
        this.team.updateTeam(teamInfo.teamInfo);

        /* After the refresh: someone that just joined the team is in it now */
        const caller = this.team.getPlayer(callerSteamId);
        if (!caller) {
            return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
                name: callerSteamId === null ? '' : `${callerSteamId}`
            });
        }

        if (memberName === '') {
            const closestPlayers = [];
            let players = [...this.team.players].filter(e => e.steamId !== callerSteamId && e.isAlive === true);
            if (players.length === 0) {
                return Client.client.intlGet(this.guildId, 'onlyOneInTeam');
            }

            for (let i = 0; i < 3; i++) {
                if (players.length > 0) {
                    const player = players.reduce(function (prev, curr) {
                        if (Map.getDistance(prev.x, prev.y, caller.x, caller.y) <
                            Map.getDistance(curr.x, curr.y, caller.x, caller.y)) {
                            return prev;
                        }
                        else {
                            return curr;
                        }
                    });
                    closestPlayers.push(player);
                    players = players.filter(e => e.steamId !== player.steamId);
                }
            }

            let string = '';
            for (const player of closestPlayers) {
                const distance = Math.floor(Map.getDistance(player.x, player.y, caller.x, caller.y));
                string += `${player.name} (${distance}m [${player.pos.location}]), `;
            }

            return string === '' ? Client.client.intlGet(this.guildId, 'allTeammatesAreDead') :
                `${string.slice(0, -2)}.`
        }

        const player = this.findTeammate(memberName);
        if (player) {
            const distance = Math.floor(Map.getDistance(caller.x, caller.y, player.x, player.y));
            const direction = Map.getAngleBetweenPoints(caller.x, caller.y, player.x, player.y);
            return Client.client.intlGet(this.guildId, 'proxLocation', {
                name: player.name,
                distance: distance,
                caller: caller.name,
                direction: direction,
                location: player.pos.location
            });
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: memberName
        });
    }

    getCommandRecycle(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxRecycle');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageItemAmount', { cmd: this.getCommandName('commandSyntaxRecycle') });
        }

        const parsed = this.splitItemAndNumber(args, 1, 1);
        if (parsed.error) return parsed.error;
        const itemSearchName = parsed.name, itemSearchQuantity = parsed.quantity;

        const item = Client.client.items.getClosestItemIdByName(itemSearchName)
        if (item === null || itemSearchName === '') {
            const str = Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: itemSearchName
            });
            return str;
        }

        const itemId = item;
        const itemName = Client.client.items.getName(itemId);
        const quantity = itemSearchQuantity;

        const recycleDetails = Client.client.rustlabs.getRecycleDetailsById(itemId);
        if (recycleDetails === null) {
            const str = Client.client.intlGet(this.guildId, 'couldNotFindRecycleDetails', {
                name: itemName
            });
            return str;
        }

        const recycleData = Client.client.rustlabs.getRecycleDataFromArray([
            { itemId: recycleDetails[0], quantity: quantity, itemIsBlueprint: false }
        ]);

        let str = `${itemName}: `;
        for (const item of recycleData['recycler']) {
            str += `${Client.client.items.getName(item.itemId)} x${item.quantity}, `;
        }
        str = str.slice(0, -2);

        return str;
    }

    getCommandResearch(command) {
        const itemResearchName = this.getCommandArgs(command, 'commandSyntaxResearch');
        if (itemResearchName === null) return null;
        if (itemResearchName === '') {
            return Client.client.intlGet(this.guildId, 'usageItem', { cmd: this.getCommandName('commandSyntaxResearch') });
        }

        const item = Client.client.items.getClosestItemIdByName(itemResearchName)
        if (item === null || itemResearchName === '') {
            const str = Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: itemResearchName
            });
            return str;
        }

        const itemId = item;
        const itemName = Client.client.items.getName(itemId);

        const researchDetails = Client.client.rustlabs.getResearchDetailsById(itemId);
        if (researchDetails === null) {
            const str = Client.client.intlGet(this.guildId, 'couldNotFindResearchDetails', {
                name: itemName
            });
            return str;
        }



        let str = `${itemName}: `;
        if (researchDetails[2].researchTable !== null) {
            const researchTable = `${Client.client.intlGet(this.guildId, 'researchTable')}`;
            const scrap = `${researchDetails[2].researchTable}`;
            str += `${researchTable} (${scrap})`
        }
        if (researchDetails[2].workbench !== null) {
            const type = `${Client.client.items.getName(researchDetails[2].workbench.type)}`;
            const scrap = researchDetails[2].workbench.scrap;
            const totalScrap = researchDetails[2].workbench.totalScrap;
            str += `, ${type} (${scrap} (${totalScrap}))`;
        }
        str += '.';

        return str;
    }

    async getCommandSend(command, callerName) {
        const credentials = InstanceUtils.readCredentialsFile(this.guildId);
        const args = this.getCommandArgs(command, 'commandSyntaxSend');
        if (args === null) return null;
        const name = args.replace(/\s.*/, '');
        const message = args.slice(name.length).trim();

        if (name === '' || message === '') {
            return Client.client.intlGet(this.guildId, 'usageSend', { cmd: this.getCommandName('commandSyntaxSend') });
        }

        const player = this.findTeammate(name);
        if (player) {
            if (!(player.steamId in credentials)) {
                return Client.client.intlGet(this.guildId, 'userNotRegistered', {
                    user: player.name
                });
            }

            const discordUserId = credentials[player.steamId].discord_user_id;
            const user = await DiscordTools.getUserById(this.guildId, discordUserId);

            const content = {
                embeds: [DiscordEmbeds.getUserSendEmbed(this.guildId, this.serverId, callerName, message)]
            }

            if (user) {
                await Client.client.messageSend(user, content);
                return Client.client.intlGet(this.guildId, 'messageWasSent');
            }

            return Client.client.intlGet(this.guildId, 'couldNotFindUser', {
                userId: discordUserId
            });
        }

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: name
        });
    }

    getCommandSmall(isInfoChannel = false) {
        const strings = [];
        if (this.mapMarkers.crateSmallOilRigTimer) {
            const time = Timer.getTimeLeftOfTimer(this.mapMarkers.crateSmallOilRigTimer);
            if (time) {
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeUntilUnlocksAt', {
                        time: Timer.getTimeLeftOfTimer(this.mapMarkers.crateSmallOilRigTimer, 's'),
                        location: this.mapMarkers.crateSmallOilRigLocation
                    });
                }
                else {
                    strings.push(Client.client.intlGet(this.guildId, 'timeBeforeCrateAtSmallOilRigUnlocks', {
                        time: time,
                        location: this.mapMarkers.crateSmallOilRigLocation
                    }));
                }
            }
        }

        if (strings.length === 0) {
            if (this.mapMarkers.timeSinceSmallOilRigWasTriggered === null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'noData') :
                    Client.client.intlGet(this.guildId, 'noDataOnSmallOilRig');
            }
            else {
                const secondsSince = (new Date() - this.mapMarkers.timeSinceSmallOilRigWasTriggered) / 1000;
                if (isInfoChannel) {
                    return Client.client.intlGet(this.guildId, 'timeSinceLastEvent', {
                        time: Timer.secondsToFullScale(secondsSince, 's')
                    });
                }
                else {
                    return Client.client.intlGet(this.guildId, 'timeSinceHeavyScientistsOnSmall', {
                        time: Timer.secondsToFullScale(secondsSince)
                    });
                }
            }
        }

        return strings;
    }

    getCommandStack(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxStack');
        if (args === null) return null;
        if (args === '') {
            return Client.client.intlGet(this.guildId, 'usageItem', { cmd: this.getCommandName('commandSyntaxStack') });
        }
        command = args;

        const itemId = Client.client.items.getClosestItemIdByName(command);
        if (itemId === null) {
            return Client.client.intlGet(this.guildId, 'noItemWithNameFound', {
                name: command
            });
        }

        const itemName = Client.client.items.getName(itemId);
        const stackDetails = Client.client.rustlabs.getStackDetailsById(itemId);
        if (stackDetails === null) {
            return Client.client.intlGet(this.guildId, 'couldNotFindStackDetails', {
                name: itemName
            });
        }

        const quantity = stackDetails[2].quantity;

        return Client.client.intlGet(this.guildId, 'stackSizeOfItem', {
            item: itemName,
            quantity: quantity
        });
    }

    getCommandSteamId(command, callerSteamId, callerName) {
        const name = this.getCommandArgs(command, 'commandSyntaxSteamid');
        if (name === null) return null;

        if (name === '') {
            if (callerSteamId === null || callerName === null) {
                return Client.client.intlGet(this.guildId, 'usageName', { cmd: this.getCommandName('commandSyntaxSteamid') });
            }
            return `${callerName}: ${callerSteamId}`;
        }

        const player = this.findTeammate(name);
        if (player) return `${player.name}: ${player.steamId}`;

        return Client.client.intlGet(this.guildId, 'couldNotIdentifyMember', {
            name: name
        });
    }

    getCommandTeam() {
        let string = '';
        for (const player of this.team.players) {
            string += `${player.name}, `;
        }

        return string !== '' ? `${string.slice(0, -2)}.` : null;
    }

    getCommandTime(isInfoChannel = false) {
        const time = Timer.convertDecimalToHoursMinutes(this.time.time);
        if (isInfoChannel) {
            return [time, this.time.getTimeTillDayOrNight('s')];
        }
        else {
            const currentTime = Client.client.intlGet(this.guildId, 'inGameTime', { time: time });
            const timeLeft = this.time.getTimeTillDayOrNight();

            if (timeLeft === null) return currentTime;

            const locString = this.time.isDay() ? 'timeTillNightfall' : 'timeTillDaylight';
            const timeTilltransition = Client.client.intlGet(this.guildId, locString, { time: timeLeft });

            return `${currentTime} ${timeTilltransition}`;
        }
    }

    getCommandTimer(command) {
        const commandAdd = `${Client.client.intlGet(this.guildId, 'commandSyntaxAdd')}`;
        const commandAddEn = `${Client.client.intlGet('en', 'commandSyntaxAdd')}`;
        const commandRemove = `${Client.client.intlGet(this.guildId, 'commandSyntaxRemove')}`;
        const commandRemoveEn = `${Client.client.intlGet('en', 'commandSyntaxRemove')}`;

        if (this.getCommandArgs(command, 'commandSyntaxTimers') === '') {
            if (Object.keys(this.timers).length === 0) {
                return Client.client.intlGet(this.guildId, 'noActiveTimers');
            }

            const strings = [];
            for (const [id, content] of Object.entries(this.timers)) {
                const timeLeft = Timer.getTimeLeftOfTimer(content.timer);
                strings.push(Client.client.intlGet(this.guildId, 'timeLeftTimer', {
                    id: parseInt(id),
                    time: timeLeft,
                    message: content.message
                }));
            }
            return strings;
        }

        const args = this.getCommandArgs(command, 'commandSyntaxTimer');
        if (args === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usageTimer', {
            cmd: this.getCommandName('commandSyntaxTimer'), add: commandAdd, remove: commandRemove,
            all: this.getCommandName('commandSyntaxTimers')
        });

        const subcommand = args.replace(/\s.*/, '');
        const rest = args.slice(subcommand.length).trim();

        switch (subcommand.toLowerCase()) {
            case commandAddEn:
            case commandAdd: {
                if (rest === '') return usage;
                const time = rest.replace(/\s.*/, '');
                const message = rest.slice(time.length).trim();
                if (message === '') return Client.client.intlGet(this.guildId, 'missingTimerMessage');

                /* "1H30M" = "1h30m"; the whole word must be a time ("10x" is not) */
                const lowerTime = time.toLowerCase();
                const timeSeconds = /^(\d+[dhms])+$/.test(lowerTime) ? Timer.getSecondsFromStringTime(lowerTime) : null;
                if (timeSeconds === null || timeSeconds <= 0) return Client.client.intlGet(this.guildId, 'timeFormatInvalid');
                /* setTimeout can not wait longer than 2^31-1 ms (~24.8 days): it would fire at once */
                const MAX_TIMER_SECONDS = 24 * 24 * 60 * 60;
                if (timeSeconds > MAX_TIMER_SECONDS) {
                    return Client.client.intlGet(this.guildId, 'timerTooLong', {
                        max: Timer.secondsToFullScale(MAX_TIMER_SECONDS)
                    });
                }

                let id = 0;
                while (Object.keys(this.timers).map(Number).includes(id)) {
                    id += 1;
                }

                this.timers[id] = {
                    timer: new Timer.timer(
                        () => {
                            const text = Client.client.intlGet(this.guildId, 'timer', { message: message });
                            this.sendInGameMessage(text, 'TIMER');
                            /* Also in Discord: in the game it is not shown when nobody of the team is
                               connected (or the bot is muted in game) */
                            try {
                                const instance = Client.client.getInstance(this.guildId);
                                const channelId = instance.channelId.activity || instance.channelId.teamchat;
                                if (channelId) {
                                    DiscordMessages.sendMessage(this.guildId, { content: `⏰ ${text}` }, null, channelId)
                                        .catch(() => { });
                                }
                            }
                            catch (e) { /* the game message is enough */ }
                            delete this.timers[id]
                        },
                        timeSeconds * 1000),
                    message: message
                };
                this.timers[id].timer.start();

                return Client.client.intlGet(this.guildId, 'timerSet', { time: lowerTime });
            } break;

            case commandRemoveEn:
            case commandRemove: {
                const id = this.parseWholeNumber(rest);
                if (id === null) return Client.client.intlGet(this.guildId, 'timerIdInvalid');

                if (!Object.keys(this.timers).map(Number).includes(id)) {
                    return Client.client.intlGet(this.guildId, 'timerIdDoesNotExist', { id: id });
                }

                this.timers[id].timer.stop();
                delete this.timers[id];

                return Client.client.intlGet(this.guildId, 'timerRemoved', { id: id });
            } break;

            default: {
                return usage;
            } break;
        }
    }

    /* The translation failed: an unknown language, or the service did not answer */
    getTranslateErrorText(e, language = null) {
        const text = e && e.message ? `${e.message}` : `${e}`;
        if (/ISO 639/i.test(text)) {
            const invalidLanguage = /The language "(.*?)"/.exec(text);
            if (invalidLanguage && invalidLanguage.length === 2) {
                return Client.client.intlGet(this.guildId, 'languageLangNotSupported', { language: invalidLanguage[1] });
            }
            if (language !== null) {
                return Client.client.intlGet(this.guildId, 'languageLangNotSupported', { language: language });
            }
            return Client.client.intlGet(this.guildId, 'languageNotSupported');
        }
        this.log(Client.client.intlGet(null, 'warningCap'), `Translation failed: ${text}`, 'warning');
        return Client.client.intlGet(this.guildId, 'translationServiceUnavailable');
    }

    async getCommandTranslateTo(command) {
        const commandLanguage = `${Client.client.intlGet(this.guildId, 'commandSyntaxLanguage')}`;
        const commandLanguageEn = `${Client.client.intlGet('en', 'commandSyntaxLanguage')}`;

        const args = this.getCommandArgs(command, 'commandSyntaxTranslateTo');
        if (args === null) return null;
        const usage = Client.client.intlGet(this.guildId, 'usageTr', {
            cmd: this.getCommandName('commandSyntaxTranslateTo'), language: commandLanguage
        });

        const first = args.replace(/\s.*/, '');
        if ([commandLanguage, commandLanguageEn].includes(first.toLowerCase())) {
            const language = args.slice(first.length).trim().toLowerCase();
            if (language === '') return usage;

            if (language in Languages) {
                return Client.client.intlGet(this.guildId, 'languageCode', {
                    code: Languages[language]
                });
            }
            else {
                return Client.client.intlGet(this.guildId, 'couldNotFindLanguage', {
                    language: language
                });
            }
        }

        const language = first;
        const text = args.slice(language.length).trim();

        if (language === '' || text === '') return usage;

        try {
            return await Translate(text, language);
        }
        catch (e) {
            return this.getTranslateErrorText(e, language);
        }
    }

    async getCommandTranslateFromTo(command) {
        const args = this.getCommandArgs(command, 'commandSyntaxTranslateFromTo');
        if (args === null) return null;

        const languageFrom = args.replace(/\s.*/, '');
        const restFrom = args.slice(languageFrom.length).trim();
        const languageTo = restFrom.replace(/\s.*/, '');
        const text = restFrom.slice(languageTo.length).trim();

        if (languageFrom === '' || languageTo === '' || text === '') {
            return Client.client.intlGet(this.guildId, 'usageTrf', {
                cmd: this.getCommandName('commandSyntaxTranslateFromTo')
            });
        }

        try {
            return await Translate(text, { from: languageFrom, to: languageTo });
        }
        catch (e) {
            return this.getTranslateErrorText(e);
        }
    }

    async getCommandTTS(command, callerName) {
        const text = this.getCommandArgs(command, 'commandSyntaxTTS');
        if (text === null) return null;
        if (text === '') {
            return Client.client.intlGet(this.guildId, 'usageTts', { cmd: this.getCommandName('commandSyntaxTTS') });
        }

        await DiscordMessages.sendTTSMessage(this.guildId, callerName, text);
        return Client.client.intlGet(this.guildId, 'sentTextToSpeech');
    }

    getCommandUnmute() {
        const instance = Client.client.getInstance(this.guildId);
        instance.generalSettings.muteInGameBotMessages = false;
        this.generalSettings.muteInGameBotMessages = false;
        Client.client.setInstance(this.guildId, instance);

        return Client.client.intlGet(this.guildId, 'inGameBotMessagesUnmuted');
    }

    getCommandUpkeep() {
        const instance = Client.client.getInstance(this.guildId);
        let cupboardFound = false;
        const strings = [];
        for (const [key, value] of Object.entries(instance.serverList[this.serverId].storageMonitors)) {
            if (value.type !== 'toolCupboard') continue;

            if (value.upkeep) {
                cupboardFound = true;
                const upkeepStr = Client.client.intlGet(this.guildId, 'upkeep').toLowerCase();
                strings.push(`${value.name} [${key}] ${upkeepStr}: ${value.upkeep}`);
            }
        }

        if (!cupboardFound) return Client.client.intlGet(this.guildId, 'noToolCupboardWereFound');

        return strings;
    }

    getCommandUptime() {
        let uptimeBot = Client.client.uptimeBot;
        let uptimeServer = this.uptimeServer;

        if (uptimeBot !== null) {
            const seconds = (new Date() - uptimeBot) / 1000;
            uptimeBot = Timer.secondsToFullScale(seconds);
        }
        else {
            uptimeBot = Client.client.intlGet(this.guildId, 'offline');
        }

        if (uptimeServer !== null) {
            const seconds = (new Date() - uptimeServer) / 1000;
            uptimeServer = Timer.secondsToFullScale(seconds);
        }
        else {
            uptimeServer = Client.client.intlGet(this.guildId, 'offline');
        }

        let string = `${Client.client.intlGet(this.guildId, 'bot')}: ${uptimeBot} `;
        string += `${Client.client.intlGet(this.guildId, 'server')}: ${uptimeServer}.`;

        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    getCommandWipe(isInfoChannel = false) {
        if (isInfoChannel) {
            return Client.client.intlGet(this.guildId, 'dayOfWipe', {
                day: Math.ceil(this.info.getSecondsSinceWipe() / (60 * 60 * 24))
            });
        }
        else {
            return Client.client.intlGet(this.guildId, 'timeSinceWipe', {
                time: this.info.getTimeSinceWipe()
            });
        }
    }

    getCommandTravelingVendor(isInfoChannel = false) {
        const strings = [];
        for (const travelingVendor of this.mapMarkers.travelingVendors) {
            if (isInfoChannel) {
                return Client.client.intlGet(this.guildId, 'atLocation', {
                    location: travelingVendor.location.string
                });
            }
            else {
                strings.push(Client.client.intlGet(this.guildId, 'travelingVendorLocatedAt', {
                    location: travelingVendor.location.string
                }));
            }
        }

        if (strings.length === 0 && this.isMarkerTypeUnavailable('TravelingVendor')) {
            return this.getMarkerTypeUnavailableText('rustPlusNoTravelingVendor', isInfoChannel);
        }

        if (strings.length === 0) {
            const wasOnMap = this.mapMarkers.timeSinceTravelingVendorWasOnMap;

            if (wasOnMap == null) {
                return isInfoChannel ? Client.client.intlGet(this.guildId, 'notActive') :
                    Client.client.intlGet(this.guildId, 'travelingVendorNotCurrentlyOnMap');
            }
            else if (wasOnMap !== null) {
                const secondsSince = (new Date() - wasOnMap) / 1000;
                if (isInfoChannel) {
                    const timeSince = Timer.secondsToFullScale(secondsSince, 's');
                    return Client.client.intlGet(this.guildId, 'timeSinceLast', {
                        time: timeSince
                    });
                }
                else {
                    const timeSince = Timer.secondsToFullScale(secondsSince);
                    return Client.client.intlGet(this.guildId, 'timeSinceTravelingVendorWasOnMap', {
                        time: timeSince
                    });
                }
            }
        }

        return strings;
    }
}

module.exports = RustPlus;
