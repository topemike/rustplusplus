/* Panel del team: client side. No framework; text is always inserted as text (never HTML). */
(function () {
    'use strict';

    /* ---------- Login page ---------- */
    const errorBox = document.getElementById('error');
    if (errorBox) {
        const params = new URLSearchParams(location.search);
        if (params.get('error')) {
            errorBox.textContent = 'No se pudo iniciar sesión con Discord. Vuelve a intentarlo.';
            errorBox.hidden = false;
        }
        else if (params.get('denied')) {
            errorBox.textContent = 'Has cancelado el inicio de sesión en Discord.';
            errorBox.hidden = false;
        }
        return;
    }

    const view = document.getElementById('view');
    if (!view) return;

    /* ---------- Helpers ---------- */
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            /* CSSOM (not the style attribute), so the strict Content-Security-Policy allows it */
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const child of children.flat(Infinity)) {
            if (child === null || child === undefined || child === false) continue;
            el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
        }
        return el;
    }

    const fmtTime = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
    const fmtDay = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    const fmtDayTime = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    function duration(ms, withSeconds) {
        ms = Math.max(0, ms);
        const s = Math.floor(ms / 1000);
        const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
        if (d > 0) return `${d}d ${hh}h`;
        if (hh > 0) return withSeconds ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${hh}h ${mm}m`;
        return withSeconds ? `${mm}:${String(ss).padStart(2, '0')}` : `${mm} min`;
    }

    function ago(ts) {
        if (!ts) return '';
        const ms = Date.now() - ts;
        if (ms < 60000) return 'ahora';
        return `hace ${duration(ms)}`;
    }

    function grid(location) {
        return location ? h('span', { class: 'grid', title: 'Cuadrícula del mapa' }, location) : null;
    }

    function empty(text) { return h('p', { class: 'empty' }, text); }

    let guildId = null;
    async function api(path) {
        const url = guildId ? `${path}?guild=${encodeURIComponent(guildId)}` : path;
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (res.status === 401) { location.href = '/'; throw new Error('login'); }
        if (res.status === 403) { location.reload(); throw new Error('forbidden'); }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    /* Elements with data-countdown="<epoch ms>" tick every second */
    function tickCountdowns() {
        for (const el of document.querySelectorAll('[data-countdown]')) {
            const left = Number(el.dataset.countdown) - Date.now();
            el.textContent = left > 0 ? duration(left, true) : '0:00';
        }
    }
    setInterval(tickCountdowns, 1000);

    const tooltip = document.getElementById('tooltip');
    function showTip(event, text) {
        tooltip.textContent = text;
        tooltip.hidden = false;
        const r = event.currentTarget.getBoundingClientRect();
        const x = Math.min(window.innerWidth - tooltip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tooltip.offsetWidth / 2));
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${Math.max(8, r.top - tooltip.offsetHeight - 8)}px`;
    }
    function hideTip() { tooltip.hidden = true; }

    /* ---------- Header ---------- */
    function renderHeader(server, raid) {
        document.getElementById('server-title').textContent = server.title || 'Sin servidor conectado';
        document.title = server.title ? `${server.title} · Panel del team` : 'Panel del team';
        document.getElementById('server-sub').textContent = server.guildName ?
            `Discord: ${server.guildName}${server.map ? ` — ${server.map}` : ''}` : '';

        const readouts = document.getElementById('readouts');
        readouts.replaceChildren(...[
            server.players !== null ? h('div', { class: 'readout' },
                h('span', { class: 'value' }, `${server.players}/${server.maxPlayers}`),
                h('span', { class: 'label' }, server.queued ? `jugadores, ${server.queued} en cola` : 'jugadores')) : null,
            server.inGameTime ? h('div', { class: 'readout' },
                h('span', { class: 'value' }, server.inGameTime),
                h('span', { class: 'label' }, server.isDay ? 'de día en el juego' : 'de noche en el juego')) : null,
            server.wipeTime ? h('div', { class: 'readout' },
                h('span', { class: 'value' }, duration(Date.now() - server.wipeTime)),
                h('span', { class: 'label' }, 'desde el wipe')) : null,
            h('div', { class: 'readout' },
                h('span', { class: 'value' }, h('span', { class: `dot ${server.connected ? 'ok' : 'bad'}` }),
                    server.connected ? 'Conectado' : 'Sin conexión'),
                h('span', { class: 'label' }, 'bot con Rust+'))].filter(Boolean));

        const raidBox = document.getElementById('raid');
        if (raid) {
            raidBox.className = 'raid-banner';
            raidBox.setAttribute('role', 'alert');
            raidBox.replaceChildren(h('div', { class: 'wrap' },
                h('strong', {}, '¡Raid en curso!'),
                h('span', {}, `${raid.count} activaciones desde las ${fmtTime.format(raid.startedAt)}: ${raid.alarms.map(a => `${a.name} (${a.count})`).join(', ')}`),
                h('span', {}, raid.acknowledged ? 'Alguien ya lo ha visto en Discord.' : 'Nadie lo ha visto todavía en Discord.')));
        }
        else {
            raidBox.className = '';
            raidBox.removeAttribute('role');
            raidBox.replaceChildren();
        }
    }

    /* ---------- Base ---------- */
    const KIND_NAMES = {
        cargo: 'Cargo', heli: 'Heli', bradley: 'Bradley', crate: 'Crates', oilrig: 'Oil Rig', chinook: 'Chinook',
        vendor: 'Vendedor', vending: 'Vending', deepsea: 'Deep Sea', other: 'Otro'
    };

    function eventList(list) {
        return h('ol', { class: 'events' },
            list.map(e => h('li', {},
                h('time', { datetime: new Date(e.at).toISOString(), title: fmtDayTime.format(e.at) }, fmtTime.format(e.at)),
                h('span', { class: 'kind' }, KIND_NAMES[e.kind] || e.kind),
                h('span', {}, e.text))));
    }

    async function renderBase() {
        const data = await api('/api/overview');
        renderHeader(data.server, data.raid);

        const tcs = data.upkeep.slice().sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
        const upkeep = h('section', { class: 'block area-a' },
            h('h2', {}, 'Upkeep de los TC'),
            tcs.length === 0 ? empty('No hay ningún TC vigilado. Pon un storage monitor en cada Tool Cupboard y emparéjalo para ver aquí cuánto le queda.') :
                h('ul', { class: 'tc-list' }, tcs.map(tc => {
                    let state = 'unknown', time, meta;
                    if (!tc.reachable) { time = 'Sin datos'; meta = 'El storage monitor no responde'; }
                    else if (tc.decaying) { state = 'bad'; time = 'Decay'; meta = 'Sin upkeep: la base se está cayendo'; }
                    else {
                        const left = tc.expiresAt - Date.now();
                        state = left < 6 * 3600e3 ? 'bad' : (left < 24 * 3600e3 ? 'warn' : 'ok');
                        time = h('span', { 'data-countdown': tc.expiresAt }, duration(left, true));
                        meta = `Se acaba ${fmtDayTime.format(tc.expiresAt)}`;
                    }
                    return h('li', { class: `tc ${state}` },
                        h('span', { class: 'name' }, tc.name, ' ', grid(tc.location)),
                        h('span', { class: 'meta' }, meta),
                        h('span', { class: 'time' }, time));
                })));

        const ds = data.deepSea;
        const deepSea = h('div', { class: 'panel' },
            h('h3', {}, 'Deep Sea'),
            !ds.synced ? h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Sin sincronizar. Cuando abra, escribe !deepsea abierto en el chat del juego.') :
                [h('p', { class: 'big' }, h('span', { 'data-countdown': ds.nextChangeAt }, duration(ds.nextChangeAt - Date.now(), true))),
                    h('p', { style: 'margin:0;color:var(--ink-2)' }, ds.isOpen ? `Abierto: cierra a las ${fmtTime.format(ds.nextChangeAt)}` :
                        `Cerrado: abre a las ${fmtTime.format(ds.nextChangeAt)}`)]);

        const counts = Object.entries(data.eventCounts).filter(([k]) => k !== 'vending');
        const last24 = h('div', { class: 'panel' },
            h('h3', { style: 'margin-bottom:10px' }, 'Últimas 24 horas'),
            counts.length === 0 ? h('p', { style: 'margin:0;color:var(--ink-2)' }, 'Sin eventos registrados.') :
                h('ul', { class: 'counts' }, counts.map(([k, n]) => h('li', {}, h('span', { class: 'n' }, n), h('span', { class: 'k' }, KIND_NAMES[k] || k)))));

        const recent = h('section', { class: 'block area-r' },
            h('h2', {}, 'Lo último'),
            data.recentEvents.length === 0 ? empty('Todavía no hay eventos. Aparecerán aquí en cuanto el bot vea Cargo, heli, Bradley, crates…') :
                eventList(data.recentEvents));

        return h('div', { class: 'columns' }, upkeep, h('div', { class: 'area-s' }, deepSea, last24), recent);
    }

    /* ---------- Trackers ---------- */
    function strip(schedule) {
        const hours = schedule.hours;
        const bars = hours.map((hr, i) => {
            const pct = hr.anyOnline === null ? 0 : Math.round(hr.anyOnline * 100);
            const label = hr.anyOnline === null ? `${String(i).padStart(2, '0')}:00 sin datos` :
                `${String(i).padStart(2, '0')}:00–${String((i + 1) % 24).padStart(2, '0')}:00: ${pct}% de las veces había alguien online, ${hr.avgOnline.toFixed(1)} de media`;
            return h('div', {
                class: `bar${hr.anyOnline === null ? ' none' : ''}`, tabindex: 0, 'aria-label': label,
                onmouseenter: (e) => showTip(e, label), onfocus: (e) => showTip(e, label),
                onmouseleave: hideTip, onblur: hideTip
            }, h('span', { style: `height:${hr.anyOnline === null ? 2 : Math.max(2, pct)}%` }));
        });
        const windows = schedule.windows.map(w => {
            const length = (w.end - w.start + 24) % 24 || 24;
            const segments = w.start + length <= 24 ? [[w.start, length]] : [[w.start, 24 - w.start], [0, length - (24 - w.start)]];
            return segments.map(([s, l]) => h('div', { class: 'window', style: `left:calc(${s} / 24 * 100%);width:calc(${l} / 24 * 100%)` }));
        });
        return [
            h('div', { class: 'strip', role: 'img', 'aria-label': 'Actividad del clan por hora del día' }, bars, windows),
            h('div', { class: 'hours', 'aria-hidden': 'true' }, hours.map((_, i) => h('span', {}, String(i).padStart(2, '0'))))
        ];
    }

    async function renderTrackers() {
        const list = await api('/api/trackers');
        if (list.length === 0) {
            return h('section', { class: 'block' }, h('h2', {}, 'Trackers'),
                empty('No hay trackers. Créalos desde el canal #servers de Discord y añade a los jugadores por su SteamID: aquí verás cuándo se conectan y sus horas de juego.'));
        }
        return list.map(t => {
            const known = t.players.filter(p => p.online !== null);
            const online = known.filter(p => p.online).length;
            const state = known.length === 0 ? 'Sin datos de BattleMetrics' :
                (online === 0 ? `Todos offline (${known.length})` : `${online} de ${known.length} online`);
            const s = t.schedule;
            return h('section', { class: 'tracker' },
                h('header', {}, h('h2', { style: 'margin:0' }, t.name), h('span', { class: 'state' },
                    h('span', { class: `dot ${online > 0 ? 'ok' : 'off'}` }), state)),
                h('ul', { class: 'members' }, t.players.map(p => h('li', {},
                    h('span', { class: `dot ${p.online ? 'ok' : (p.online === false ? 'off' : 'off')}` }),
                    p.name,
                    p.since ? h('span', { class: 'ago' }, p.online ? `online ${duration(Date.now() - p.since)}` : ago(p.since)) : null))),
                !s ? empty('Todavía no hay historial. El horario se completa solo a medida que el bot ve conectarse y desconectarse a estos jugadores.') : [
                    h('h3', { style: 'margin-bottom:8px' }, 'Cuándo suelen estar online'),
                    h('p', { class: 'hint', style: 'margin:0 0 12px' },
                        `Hora de ${s.timeZone}, con ${s.days} día${s.days === 1 ? '' : 's'} de datos. Barra alta: casi siempre hay alguien conectado a esa hora.`),
                    strip(s),
                    h('p', { class: 'windows' }, s.windows.length === 0 ? 'Aún no hay datos suficientes para recomendar horas de raid.' : [
                        'Mejores horas para raidear: ',
                        s.windows.map((w, i) => [i > 0 ? ' y ' : '', h('strong', {}, `${String(w.start).padStart(2, '0')}:00–${String(w.end).padStart(2, '0')}:00`),
                            ` (${Math.round(w.anyOnline * 100)}% de actividad)`])]),
                    h('div', { class: 'scroll' }, h('table', { class: 'week' },
                        h('thead', {}, h('tr', {}, h('th', {}, 'Jugador'), h('th', {}, 'Horas online (7 días)'), h('th', {}, 'Última vez'))),
                        h('tbody', {}, s.week.map(p => h('tr', {},
                            h('td', {}, p.name),
                            h('td', { class: 'num' }, (p.onlineMs / 3600e3).toFixed(1)),
                            h('td', {}, p.online ? 'Online ahora' : (p.lastSeen ? `${fmtDayTime.format(p.lastSeen)}` : '—')))))))
                ]);
        });
    }

    /* ---------- Raids ---------- */
    async function renderRaids() {
        const data = await api('/api/raids');
        const items = [];
        if (data.active) {
            items.push(h('div', { class: 'panel', style: 'border-color:var(--bad)' },
                h('h3', { style: 'color:var(--bad)' }, 'Raid en curso'),
                h('p', { style: 'margin:6px 0 0' }, `${data.active.count} activaciones desde las ${fmtTime.format(data.active.startedAt)}.`)));
        }
        items.push(h('section', { class: 'block' }, h('h2', {}, 'Raids de los últimos 14 días'),
            data.history.length === 0 ? empty('Ningún raid registrado. Si pones alarmas con sensores sísmicos y activas MODO RAID, cada raid aparecerá aquí.') :
                h('ul', { class: 'raid-list' }, data.history.map(r => h('li', {},
                    h('div', { class: 'when' }, `${fmtDay.format(r.startedAt)}, ${fmtTime.format(r.startedAt)}–${fmtTime.format(r.endedAt)}`),
                    h('div', { class: 'what' }, `${r.count} activaciones en ${duration(r.endedAt - r.startedAt)}: ${r.alarms}`))))));
        return items;
    }

    /* ---------- Market ---------- */
    const MARKS = { new: 'nueva', down: 'baja', up: 'sube' };
    function price(n) { return Number.isInteger(n) ? String(n) : (n < 10 ? n.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(n))); }

    async function renderMarket() {
        const data = await api('/api/market');
        const blocks = [h('h2', {}, 'Mercado')];
        if (data.vendingMachines === 0) {
            blocks.push(empty('El servidor no está enviando ninguna vending machine por Rust+ (algunos servers las ocultan). En un server que las envíe, aquí verás todas las ofertas de tu lista.'));
        }
        else {
            blocks.push(h('p', { class: 'hint' }, `${data.vendingMachines} vending machines en el mapa. La lista se cambia desde el canal #market de Discord.`));
        }
        for (const entry of data.entries) {
            blocks.push(h('section', { class: 'market-item' },
                h('h3', {}, entry.query),
                h('p', { class: 'items' }, entry.items.slice(0, 6).join(', ') + (entry.items.length > 6 ? ` y ${entry.items.length - 6} más` : '')),
                entry.offers.length === 0 ? h('p', { style: 'color:var(--muted);margin:0' }, 'Ahora mismo nadie lo vende.') :
                    h('div', { class: 'scroll' }, h('table', { class: 'offers' },
                        h('thead', {}, h('tr', {}, h('th', {}, 'Objeto'), h('th', { class: 'num' }, 'Cantidad'), h('th', {}, 'Precio'),
                            h('th', { class: 'num' }, 'Por unidad'), h('th', {}, 'Dónde'), h('th', { class: 'num' }, 'Stock'))),
                        h('tbody', {}, entry.offers.map(o => h('tr', { class: o.mark || '' },
                            h('td', {}, o.item, o.blueprint ? ' (BP)' : '', o.mark ? h('span', { class: `mark ${o.mark}` }, MARKS[o.mark]) : null),
                            h('td', { class: 'num' }, `×${o.quantity}`),
                            h('td', {}, `${o.cost} ${o.currency}`),
                            h('td', { class: 'num' }, o.quantity > 1 ? price(o.unitPrice) : '—'),
                            h('td', {}, grid(o.location)),
                            h('td', { class: 'num' }, o.stock))))))));
        }
        return blocks;
    }

    /* ---------- Events ---------- */
    let eventFilter = '';
    async function renderEvents() {
        const list = await api('/api/events');
        const kinds = [...new Set(list.map(e => e.kind))];
        const shown = eventFilter ? list.filter(e => e.kind === eventFilter) : list;
        const select = h('select', { id: 'event-filter', onchange: (e) => { eventFilter = e.target.value; refresh(); } },
            h('option', { value: '' }, 'Todos'),
            kinds.map(k => h('option', { value: k, selected: k === eventFilter }, KIND_NAMES[k] || k)));
        return h('section', { class: 'block' },
            h('h2', {}, 'Eventos de los últimos 14 días'),
            list.length === 0 ? empty('Todavía no hay eventos registrados.') : [
                h('div', { class: 'filter' }, h('label', { for: 'event-filter' }, 'Mostrar'), select),
                eventList(shown)]);
    }

    /* ---------- Tabs and refresh ---------- */
    const RENDER = { base: renderBase, trackers: renderTrackers, raids: renderRaids, market: renderMarket, events: renderEvents };
    let current = (location.hash || '#base').slice(1);
    if (!RENDER[current]) current = 'base';
    let busy = false;

    async function refresh() {
        if (busy) return;
        busy = true;
        try {
            const content = await RENDER[current]();
            hideTip();
            view.replaceChildren(...[content].flat(3).filter(Boolean));
            tickCountdowns();
            if (current !== 'base') {
                const overview = await api('/api/overview');
                renderHeader(overview.server, overview.raid);
            }
        }
        catch (e) {
            if (!['login', 'forbidden'].includes(e.message)) {
                console.error(e);
                view.replaceChildren(empty('No se pudieron cargar los datos. Se reintentará en unos segundos.'));
            }
        }
        finally {
            busy = false;
        }
    }

    function select(tab) {
        current = tab;
        history.replaceState(null, '', `#${tab}`);
        for (const b of document.querySelectorAll('nav.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        view.replaceChildren(h('p', { style: 'color:var(--muted)' }, 'Cargando…'));
        refresh();
    }

    for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => select(b.dataset.tab));
    window.addEventListener('hashchange', () => {
        const tab = location.hash.slice(1);
        if (RENDER[tab] && tab !== current) select(tab);
    });

    (async function init() {
        try {
            const me = await api('/api/me');
            guildId = me.guilds[0].id;
            document.getElementById('user').replaceChildren(...[
                me.user.avatar ? h('img', { src: me.user.avatar, alt: '' }) : null,
                h('span', {}, me.user.name),
                h('a', { href: '/logout' }, 'Cerrar sesión')].filter(Boolean));
        }
        catch (e) {
            return;
        }
        select(current);
        setInterval(refresh, 20000);
    })();
})();
