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
 *  Fast market search over every Vending Machine on the map.
 *  - Understands Rust slang and Spanish ("ak", "semi", "hq", "low grade", "azufre", "semilla"...),
 *    partial words ("seed", "berry") and falls back to the closest item name.
 *  - Lists every offer with unit price and location, cheapest first, and who buys the item.
 *  - Used by /buscar, !buscar and the #market board.
 */

/* Slang / Spanish -> exact item names. A value starting with '~' is a word to search inside names. */
const ALIASES = {
    /* Weapons */
    'ak': ['Assault Rifle'], 'ak47': ['Assault Rifle'], 'ak 47': ['Assault Rifle'],
    'lr': ['LR-300 Assault Rifle'], 'lr300': ['LR-300 Assault Rifle'], 'lr 300': ['LR-300 Assault Rifle'],
    'm2': ['M249'], 'm249': ['M249'],
    'mp5': ['MP5A4'], 'tommy': ['Thompson'], 'thompson': ['Thompson'],
    'smg': ['Custom SMG'], 'custom': ['Custom SMG'],
    'semi': ['Semi-Automatic Rifle', 'Semi-Automatic Pistol'],
    'sar': ['Semi-Automatic Rifle'], 'semi rifle': ['Semi-Automatic Rifle'],
    'sap': ['Semi-Automatic Pistol'], 'p2': ['Semi-Automatic Pistol'], 'semi pistol': ['Semi-Automatic Pistol'],
    'python': ['Python Revolver'], 'revolver': ['Revolver'],
    'm39': ['M39 Rifle'], 'bolt': ['Bolt Action Rifle'], 'bolty': ['Bolt Action Rifle'], 'l96': ['L96 Rifle'],
    'pump': ['Pump Shotgun'], 'spas': ['Spas-12 Shotgun'],
    'db': ['Double Barrel Shotgun'], 'doble': ['Double Barrel Shotgun'], 'waterpipe': ['Waterpipe Shotgun'],
    'ballesta': ['Crossbow'], 'crossbow': ['Crossbow'],
    'compound': ['Compound Bow'], 'arco compuesto': ['Compound Bow'],
    'arco': ['Hunting Bow', 'Compound Bow'], 'bow': ['Hunting Bow', 'Compound Bow'],
    'rpg': ['Rocket Launcher'], 'lanzacohetes': ['Rocket Launcher'], 'launcher': ['Rocket Launcher'],
    'nailgun': ['Nailgun'], 'mgl': ['Multiple Grenade Launcher'],

    /* Explosives */
    'c4': ['Timed Explosive Charge'], 'satchel': ['Satchel Charge'],
    'cohete': ['Rocket', 'High Velocity Rocket', 'Incendiary Rocket'],
    'cohetes': ['Rocket', 'High Velocity Rocket', 'Incendiary Rocket'],
    'rocket': ['Rocket', 'High Velocity Rocket', 'Incendiary Rocket'],
    'rockets': ['Rocket', 'High Velocity Rocket', 'Incendiary Rocket'],
    'explo': ['Explosives'], 'explosivos': ['Explosives'], 'explosives': ['Explosives'],
    'beancan': ['Beancan Grenade'], 'f1': ['F1 Grenade'], 'granada': ['F1 Grenade', 'Beancan Grenade'],

    /* Ammo */
    '556': ['5.56 Rifle Ammo', 'HV 5.56 Rifle Ammo', 'Incendiary 5.56 Rifle Ammo', 'Explosive 5.56 Rifle Ammo'],
    '5.56': ['5.56 Rifle Ammo', 'HV 5.56 Rifle Ammo', 'Incendiary 5.56 Rifle Ammo', 'Explosive 5.56 Rifle Ammo'],
    'balas rifle': ['5.56 Rifle Ammo'], 'municion rifle': ['5.56 Rifle Ammo'],
    'explo ammo': ['Explosive 5.56 Rifle Ammo'], 'municion explosiva': ['Explosive 5.56 Rifle Ammo'],
    'pistol ammo': ['Pistol Bullet'], 'balas pistola': ['Pistol Bullet'], 'municion pistola': ['Pistol Bullet'],
    'buckshot': ['12 Gauge Buckshot'], 'cartuchos': ['12 Gauge Buckshot'],
    'ammo': ['~ammo', '~bullet', '~buckshot', '~slug', '~arrow'],
    'municion': ['~ammo', '~bullet', '~buckshot', '~slug', '~arrow'],
    'balas': ['~ammo', '~bullet', '~buckshot', '~slug'],

    /* Resources */
    'hq': ['High Quality Metal'], 'hqm': ['High Quality Metal'], 'alta calidad': ['High Quality Metal'],
    'hq ore': ['High Quality Metal Ore'], 'hqm ore': ['High Quality Metal Ore'],
    'metal': ['Metal Fragments'], 'frags': ['Metal Fragments'], 'fragmentos': ['Metal Fragments'],
    'metal ore': ['Metal Ore'], 'mineral metal': ['Metal Ore'],
    'azufre': ['Sulfur'], 'sulfur': ['Sulfur'], 'sulfur ore': ['Sulfur Ore'], 'mineral azufre': ['Sulfur Ore'],
    'chatarra': ['Scrap'], 'scrap': ['Scrap'],
    'low': ['Low Grade Fuel'], 'low grade': ['Low Grade Fuel'], 'lowgrade': ['Low Grade Fuel'],
    'lgf': ['Low Grade Fuel'], 'gasolina': ['Low Grade Fuel'], 'combustible': ['Low Grade Fuel'],
    'crudo': ['Crude Oil'], 'crude': ['Crude Oil'], 'diesel': ['Diesel Fuel'],
    'polvora': ['Gun Powder'], 'gp': ['Gun Powder'], 'gunpowder': ['Gun Powder'],
    'carbon': ['Charcoal'], 'tela': ['Cloth'], 'cuero': ['Leather'],
    'madera': ['Wood'], 'piedra': ['Stones'], 'piedras': ['Stones'], 'stone': ['Stones'],
    'grasa': ['Animal Fat'], 'huesos': ['Bone Fragments'],

    /* Components */
    'tech': ['Tech Trash'], 'techtrash': ['Tech Trash'], 'tech trash': ['Tech Trash'],
    'rifle body': ['Rifle Body'], 'smg body': ['SMG Body'], 'semi body': ['Semi Automatic Body'],
    'muelle': ['Metal Spring'], 'spring': ['Metal Spring'], 'muelles': ['Metal Spring'],
    'tubo': ['Metal Pipe'], 'tubos': ['Metal Pipe'], 'pipe': ['Metal Pipe'],
    'engranajes': ['Gears'], 'gears': ['Gears'],
    'chapa': ['Sheet Metal'], 'sheet': ['Sheet Metal'], 'sheet metal': ['Sheet Metal'],
    'road signs': ['Road Signs'], 'senales': ['Road Signs'],
    'cuerda': ['Rope'], 'lona': ['Tarp'], 'sewing': ['Sewing Kit'], 'kit de costura': ['Sewing Kit'],
    'propano': ['Empty Propane Tank'], 'fusible': ['Electric Fuse'], 'fuse': ['Electric Fuse'],
    'targeting': ['Targeting Computer'], 'computadora': ['Targeting Computer'],
    'cctv': ['CCTV Camera'], 'camara': ['CCTV Camera'],

    /* Medical */
    'medkit': ['Large Medkit'], 'botiquin': ['Large Medkit'],
    'jeringa': ['Medical Syringe'], 'jeringas': ['Medical Syringe'], 'syringe': ['Medical Syringe'],
    'syringes': ['Medical Syringe'], 'venda': ['Bandage'], 'vendas': ['Bandage'],

    /* Armor */
    'facemask': ['Metal Facemask'], 'mascara': ['Metal Facemask'], 'metal mask': ['Metal Facemask'],
    'chest': ['Metal Chest Plate'], 'chestplate': ['Metal Chest Plate'], 'peto': ['Metal Chest Plate'],
    'kilt': ['Road Sign Kilt'], 'roadsign': ['Road Sign Jacket', 'Road Sign Kilt'],
    'road sign': ['Road Sign Jacket', 'Road Sign Kilt'], 'hazmat': ['Hazmat Suit'],
    'heavy': ['Heavy Plate Helmet', 'Heavy Plate Jacket', 'Heavy Plate Pants'],
    'pesada': ['Heavy Plate Helmet', 'Heavy Plate Jacket', 'Heavy Plate Pants'],
    'coffee can': ['Coffee Can Helmet'],

    /* Base */
    'garage': ['Garage Door'], 'garaje': ['Garage Door'],
    'puerta metal': ['Sheet Metal Door'], 'sheet door': ['Sheet Metal Door'],
    'armored door': ['Armored Door'], 'blindada': ['Armored Door'],
    'torreta': ['Auto Turret'], 'torretas': ['Auto Turret'], 'turret': ['Auto Turret'],
    'sam': ['SAM Site', 'SAM Ammo'], 'code lock': ['Code Lock'], 'candado': ['Code Lock'],
    'tc': ['Tool Cupboard'], 'refinery': ['Small Oil Refinery'], 'refineria': ['Small Oil Refinery'],
    'horno': ['Furnace', 'Large Furnace'], 'furnace': ['Furnace', 'Large Furnace'],

    /* Attachments and tools */
    'holo': ['Holosight'], 'holosight': ['Holosight'], '8x': ['8x Zoom Scope'], 'mira': ['8x Zoom Scope', 'Holosight'],
    'silenciador': ['Military Silencer', 'Oil Filter Silencer', 'Soda Can Silencer'],
    'silencer': ['Military Silencer', 'Oil Filter Silencer', 'Soda Can Silencer'],
    'laser': ['Weapon Lasersight'], 'linterna': ['Weapon flashlight'], 'flashlight': ['Weapon flashlight'],
    'cargador': ['Extended Magazine'], 'extended': ['Extended Magazine'],
    'boost': ['Muzzle Boost'], 'brake': ['Muzzle Brake'],
    'jackhammer': ['Jackhammer'], 'motosierra': ['Chainsaw'], 'chainsaw': ['Chainsaw'],
    'supply': ['Supply Signal'], 'senal': ['Supply Signal'],

    /* Workbenches and tables */
    'wb': ['Workbench Level 1', 'Workbench Level 2', 'Workbench Level 3'],
    'workbench': ['Workbench Level 1', 'Workbench Level 2', 'Workbench Level 3'],
    'banco': ['Workbench Level 1', 'Workbench Level 2', 'Workbench Level 3'],
    'banco de trabajo': ['Workbench Level 1', 'Workbench Level 2', 'Workbench Level 3'],
    'wb1': ['Workbench Level 1'], 'wb 1': ['Workbench Level 1'], 'workbench 1': ['Workbench Level 1'],
    'banco 1': ['Workbench Level 1'], 't1': ['Workbench Level 1'],
    'wb2': ['Workbench Level 2'], 'wb 2': ['Workbench Level 2'], 'workbench 2': ['Workbench Level 2'],
    'banco 2': ['Workbench Level 2'], 't2': ['Workbench Level 2'],
    'wb3': ['Workbench Level 3'], 'wb 3': ['Workbench Level 3'], 'workbench 3': ['Workbench Level 3'],
    'banco 3': ['Workbench Level 3'], 't3': ['Workbench Level 3'],
    'research': ['Research Table'], 'mesa investigacion': ['Research Table'], 'investigacion': ['Research Table'],
    'repair': ['Repair Bench'], 'banco reparacion': ['Repair Bench'], 'reparacion': ['Repair Bench'],
    'mixing': ['Mixing Table'], 'mesa mezclas': ['Mixing Table'],
    'engineering': ['Engineering Workbench'], 'cooking': ['Cooking Workbench'],

    /* Electricity */
    'bateria': ['~battery'], 'baterias': ['~battery'], 'battery': ['~battery'],
    'solar': ['Large Solar Panel'], 'panel solar': ['Large Solar Panel'],
    'turbina': ['Wind Turbine'], 'turbine': ['Wind Turbine'],
    'generador': ['Small Generator'], 'generator': ['Small Generator'],

    /* Vehicles, keycards */
    'mini': ['Minicopter'], 'minicopter': ['Minicopter'], 'helicoptero': ['Minicopter'],
    'barca': ['Rowboat'], 'rowboat': ['Rowboat'], 'kayak': ['Kayak'],
    'caballo': ['Horse'], 'montura': ['~saddle'],
    'tarjeta': ['~keycard'], 'tarjetas': ['~keycard'], 'keycard': ['~keycard'], 'keycards': ['~keycard'],
    'piston': ['~pistons'], 'pistones': ['~pistons'], 'bujias': ['~spark'], 'valvulas': ['~valves'],
    'ciguenal': ['~crankshaft'], 'carburador': ['~carburetor'],

    /* Generic Spanish words */
    'puerta': ['~door'], 'puertas': ['~door'], 'ventana': ['~window'], 'caja': ['~box'], 'cajas': ['~box'],
    'cama': ['~bed'], 'saco de dormir': ['Sleeping Bag'], 'saco': ['Sleeping Bag'],

    /* Farming */
    'semilla': ['~seed'], 'semillas': ['~seed'], 'seed': ['~seed'], 'seeds': ['~seed'],
    'clon': ['~clone'], 'clones': ['~clone'], 'fertilizante': ['Fertilizer']
};

function normalize(text) {
    return `${text}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 *  Resolves a free text query to a set of item ids.
 *  @param {Object} items Items structure ({ items: { id: { name, shortname } }, getClosestItemIdByName })
 *  @return {Array} Item ids (strings), best matches first. Empty when nothing matches.
 */
function resolveQuery(items, query) {
    const q = normalize(query);
    if (q === '') return [];

    const entries = Object.entries(items.items);
    const byName = new Map(entries.map(([id, item]) => [item.name, id]));
    const result = [];
    const add = (id) => { if (id !== undefined && !result.includes(id)) result.push(id); };

    const addWord = (word) => {
        for (const [id, item] of entries) {
            if (normalize(item.name).split(' ').some(w => w.startsWith(word))) add(id);
        }
    };

    if (ALIASES.hasOwnProperty(q)) {
        for (const target of ALIASES[q]) {
            if (target.startsWith('~')) addWord(target.slice(1));
            else add(byName.get(target));
        }
        if (result.length > 0) return result;
    }

    /* Exact name or shortname */
    for (const [id, item] of entries) {
        if (normalize(item.name) === q || (item.shortname && item.shortname.toLowerCase() === q)) add(id);
    }
    if (result.length > 0) return result;

    /* Every word of the query inside the item name (expanding hq/mq/lq) */
    const expanded = q.replace(/\bhq\b/g, 'high quality').replace(/\bmq\b/g, 'medium quality')
        .replace(/\blq\b/g, 'low quality');
    const words = expanded.split(' ');
    for (const [id, item] of entries) {
        const name = normalize(item.name);
        if (words.every(w => name.includes(w))) add(id);
    }
    if (result.length > 0) return result;

    /* Closest name */
    const closest = items.getClosestItemIdByName(query);
    if (closest !== null && closest !== undefined) add(`${closest}`);
    return result;
}

/**
 *  Collects offers from the Vending Machines.
 *  @param {string} type 'sell' (machines selling the item), 'buy' (machines paying with the item) or 'all'.
 *  @return {Object} { sell: [offer], buy: [offer] } sorted by unit price (cheapest first, per currency).
 */
function collectOffers(vendingMachines, itemIds, type = 'all') {
    const wanted = new Set(itemIds.map(id => `${id}`));
    const sell = [], buy = [];

    for (const vm of vendingMachines || []) {
        if (!Array.isArray(vm.sellOrders)) continue;
        for (const order of vm.sellOrders) {
            if (!order.amountInStock) continue;
            const offer = {
                itemId: `${order.itemId}`,
                quantity: order.quantity,
                currencyId: `${order.currencyId}`,
                cost: order.costPerItem,
                stock: order.amountInStock,
                itemIsBlueprint: !!order.itemIsBlueprint,
                currencyIsBlueprint: !!order.currencyIsBlueprint,
                unitPrice: order.quantity > 0 ? order.costPerItem / order.quantity : order.costPerItem,
                vmKey: `${Math.round(vm.x)}:${Math.round(vm.y)}`,
                location: vm.location ? (vm.location.string || vm.location.location) : '?',
                grid: vm.location ? vm.location.location : '?',
                shop: vm.name || ''
            };
            if ((type === 'all' || type === 'sell') && wanted.has(offer.itemId)) sell.push(offer);
            if ((type === 'all' || type === 'buy') && wanted.has(offer.currencyId)) buy.push(offer);
        }
    }

    buy.sort((a, b) => b.unitPrice - a.unitPrice);
    return { sell: groupSort(sell), buy: buy };
}

/* Group by item, then by currency, each group cheapest first; groups with the cheapest offers first. */
function groupSort(offers) {
    const groups = new Map();
    for (const o of offers) {
        const key = `${o.itemId}|${o.currencyId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
    }
    const list = [...groups.values()].map(g => g.sort((a, b) => a.unitPrice - b.unitPrice));
    list.sort((a, b) => b.length - a.length || a[0].unitPrice - b[0].unitPrice);
    return list.flat();
}

function formatNumber(n) {
    if (Number.isInteger(n)) return `${n}`;
    return n < 10 ? n.toFixed(2).replace(/\.?0+$/, '') : `${Math.round(n)}`;
}

/**
 *  Lines for Discord.
 */
function formatOffersDiscord(items, offers, intl, maxLines = 25) {
    const name = (id, bp) => `${items.getName(id) || id}${bp ? ' (BP)' : ''}`;
    const lines = [];
    for (const o of offers.slice(0, maxLines)) {
        const unit = o.quantity > 1 ? ` · ${formatNumber(o.unitPrice)}/u` : '';
        lines.push(`**${name(o.itemId, o.itemIsBlueprint)}** ×${o.quantity} → ` +
            `**${o.cost} ${name(o.currencyId, o.currencyIsBlueprint)}**${unit} · ${o.location} · ` +
            `${intl('marketStock', { stock: o.stock })}`);
    }
    if (offers.length > maxLines) lines.push(intl('marketMore', { count: offers.length - maxLines }));
    return lines;
}

/**
 *  Short lines for the in-game team chat (max ~3 offers per item).
 */
function formatOffersInGame(items, offers, perItem = 3, maxItems = 3) {
    const byItem = new Map();
    for (const o of offers) {
        if (!byItem.has(o.itemId)) byItem.set(o.itemId, []);
        byItem.get(o.itemId).push(o);
    }
    const lines = [];
    for (const [itemId, list] of [...byItem.entries()].slice(0, maxItems)) {
        const parts = list.slice(0, perItem).map(o =>
            `${o.quantity > 1 ? `${o.quantity}x ` : ''}${o.cost} ${items.getName(o.currencyId)} @${o.grid}`);
        const more = list.length > perItem ? ` +${list.length - perItem}` : '';
        lines.push(`${items.getName(itemId)}: ${parts.join(' | ')}${more}`);
    }
    return lines;
}

module.exports = {
    ALIASES: ALIASES,
    normalize: normalize,
    resolveQuery: resolveQuery,
    collectOffers: collectOffers,
    formatOffersDiscord: formatOffersDiscord,
    formatOffersInGame: formatOffersInGame,
    formatNumber: formatNumber
};
