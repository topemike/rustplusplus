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

const RustPlusLib = require('@liamcottle/rustplus.js');

const Client = require('../../index.ts');
const RustRelay = require('../util/rustRelay.js');
const Config = require('../../config');

class RustPlusLite extends RustPlusLib {
    constructor(guildId, logger, rustplus, serverIp, appPort, steamId, playerToken) {
        super(serverIp, appPort, steamId, playerToken);

        this.serverId = `${this.server}-${this.port}`;
        this.guildId = guildId;
        this.logger = logger;
        this.rustplus = rustplus;

        this.isActive = true;
        this.reconnectDelayMs = null;

        this.loadRustPlusLiteEvents();
    }

    /* Same as RustPlus.connect(): relay when possible, legacy direct connection otherwise. */
    connect() {
        const detail = RustRelay.resolveDetailed(this.guildId, this.server, this.port, this.playerId);
        const relay = detail.relay;
        this.reconnectDelayMs = null;
        if (!relay) {
            if (`${this.server}` === 'relay' || (detail.reason === 'noToken' && detail.relayServerId)) {
                /* No direct connection to relay-only servers: no token, nothing to retry until
                   /credentials add (which updates the leader connection again) */
                this.isActive = false;
                this.log(Client.client.intlGet(null, 'warningCap'),
                    `Rust+ relay: no rustplus_auth_token for ${this.playerId} - leader connection not started.`,
                    'warn');
                RustRelay.warnTokenProblem(Client.client, this.guildId, this.playerId, 'noToken', {});
                return;
            }
            return super.connect();
        }
        if (detail.reason === 'expired') {
            this.reconnectDelayMs = RustRelay.SLOW_RETRY_MS;
            RustRelay.warnTokenProblem(Client.client, this.guildId, this.playerId, 'expired',
                { expiresAt: relay.expiresAt });
        }
        RustRelay.connect(this, relay);
    }

    loadRustPlusLiteEvents() {
        this.on('connected', (...args) => rustPlusLiteConnectedEvent(this, ...args));
        this.on('connecting', (...args) => rustPlusLiteConnectingEvent(this, ...args));
        this.on('disconnected', (...args) => rustPlusLiteDisconnectedEvent(this, ...args));
        this.on('error', (...args) => rustPlusLiteErrorEvent(this, ...args));
    }

    log(title, text, level = 'info') {
        this.logger.log(`${title} LITE`, text, level);
    }

    async getInfoAsync(timeout = 10000) {
        try {
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

    async promoteToLeaderAsync(steamId, timeout = 10000) {
        try {
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

    isResponseValid(response) {
        if (response === undefined) {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseIsUndefined'), 'error');
            return false;
        }
        else if (response.toString() === 'Error: Timeout reached while waiting for response') {
            this.log(Client.client.intlGet(null, 'errorCap'),
                Client.client.intlGet(null, 'responseTimeout'), 'error');
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
            return false;
        }
        return true;
    }
}

async function rustPlusLiteConnectedEvent(rustplusLite) {
    rustplusLite.log(Client.client.intlGet(null, 'connectedCap'),
        Client.client.intlGet(null, 'connectedToServer'));

    const info = await rustplusLite.getInfoAsync();
    if (!rustplusLite.isResponseValid(info)) {
        rustplusLite.log(Client.client.intlGet(null, 'errorCap'),
            Client.client.intlGet(null, 'somethingWrongWithConnection'), 'error');
        rustplusLite.disconnect();
        return;
    }
    rustplusLite.log(Client.client.intlGet(null, 'connectedCap'),
        Client.client.intlGet(null, 'rustplusOperational'));
    RustRelay.clearTokenWarning(Client.client, rustplusLite.guildId, rustplusLite.playerId);
}

async function rustPlusLiteConnectingEvent(rustplusLite) {
    rustplusLite.log(Client.client.intlGet(null, 'connectingCap'),
        Client.client.intlGet(null, 'connectingToServer'));
}

async function rustPlusLiteDisconnectedEvent(rustplusLite) {
    rustplusLite.log(Client.client.intlGet(null, 'disconnectedCap'),
        Client.client.intlGet(null, 'disconnectedFromServer'));

    /* Was the disconnection unexpected? */
    if (rustplusLite.isActive && Client.client.activeRustplusInstances[rustplusLite.guildId]) {
        rustplusLite.log(Client.client.intlGet(null, 'reconnectingCap'),
            Client.client.intlGet(null, 'reconnectingToServer'));

        if (Client.client.rustplusLiteReconnectTimers[rustplusLite.guildId]) {
            clearTimeout(Client.client.rustplusLiteReconnectTimers[rustplusLite.guildId]);
            Client.client.rustplusLiteReconnectTimers[rustplusLite.guildId] = null;
        }

        Client.client.rustplusLiteReconnectTimers[rustplusLite.guildId] = setTimeout(
            rustplusLite.rustplus.updateLeaderRustPlusLiteInstance.bind(rustplusLite.rustplus),
            rustplusLite.reconnectDelayMs || Config.general.reconnectIntervalMs);
    }
}

async function rustPlusLiteErrorEvent(rustplusLite, error) {
    rustplusLite.log(Client.client.intlGet(null, 'errorCap'), error, 'error');

    /* Relay refused the token: one warning and slow retries instead of every few seconds */
    const status = RustRelay.refusalStatus(error);
    if (status !== null) {
        rustplusLite.reconnectDelayMs = RustRelay.SLOW_RETRY_MS;
        const detail = RustRelay.resolveDetailed(rustplusLite.guildId, rustplusLite.server, rustplusLite.port,
            rustplusLite.playerId);
        await RustRelay.warnTokenProblem(Client.client, rustplusLite.guildId, rustplusLite.playerId,
            detail.reason === 'expired' ? 'expired' : 'refused', { status: status, expiresAt: detail.expiresAt });
    }
}

module.exports = RustPlusLite;
