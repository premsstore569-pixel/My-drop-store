
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Optional production middleware & drivers (pure-JS, Render-safe)
let compression = null;
try { compression = require('compression'); } catch (_) {}
let pgPool = null;
if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
    try {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL.trim(),
            ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
        });
        pgPool.on('error', function(err) {
            console.error('[PG_POOL_WARN]', err.message);
        });
    } catch (err) {
        console.log('[DB] Using 8GB Sharded Disk Engine:', err.message);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;
const MERCHANT_PIN = process.env.MERCHANT_PIN || '9014';
const DB_CAPACITY_GB = 8;
const SHARD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB shards (160+ shards = 8 GB+ with <50 MB RAM)

// Replaceable Store Settings (env vars OR live in Merchant Portal)
const DEFAULT_SETTINGS = {
    storeName: process.env.STORE_NAME || "Prem's Store",
    upiId: process.env.OWNER_UPI || 'premkumarmanthena289@oksbi',
    payeeName: process.env.OWNER_NAME || 'Prem Store',
    whatsapp: process.env.OWNER_WHATSAPP || '919014044915',
    promoCode: process.env.PROMO_CODE || 'PREM10',
    promoPercent: Number(process.env.PROMO_PERCENT || 10),
    freeShipThreshold: Number(process.env.FREE_SHIP_THRESHOLD || 999),
    freeGiftThreshold: Number(process.env.FREE_GIFT_THRESHOLD || 1499),
    deliveryMinDays: 4,
    deliveryMaxDays: 6
};

app.use(cors());
if (compression) app.use(compression());
// Increased JSON limit to 12mb to smoothly store compressed payment screenshots, landmark gate photos & review photos in 8GB DB
app.use(express.json({ limit: '12mb' }));
app.use(express.static(__dirname));

// ============================================================================
// 1. ENTERPRISE 8GB+ DUAL-TIER STORAGE ENGINE (ZERO BACKTICKS)
//    Stores: orders (with payment screenshots), customers (with addresses,
//    landmarks & gate photos), products, reviews (with photos), tickets, settings
// ============================================================================
class ShardedStorageEngine {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.shardsDir = path.join(baseDir, 'shards');
        this.indexDir = path.join(baseDir, 'index');
        this.mode = pgPool ? 'POSTGRESQL_CLOUD + SHARDED_8GB' : 'SHARDED_NDJSON_8GB';
        this.readOnly = false;
        this.collections = ['orders', 'customers', 'products', 'reviews', 'utrs', 'settings', 'tickets'];
        this.indexes = {};
        this.ramFallback = {};
        this.activeShards = {};
        for (let i = 0; i < this.collections.length; i++) {
            const c = this.collections[i];
            this.indexes[c] = new Map();
            this.ramFallback[c] = new Map();
        }
        this.init();
    }

    init() {
        try {
            fs.mkdirSync(this.shardsDir, { recursive: true });
            fs.mkdirSync(this.indexDir, { recursive: true });
            const probe = path.join(this.baseDir, '.write_probe');
            fs.writeFileSync(probe, 'ok');
            fs.unlinkSync(probe);

            const legacyFile = path.join(__dirname, 'database.json');
            if (fs.existsSync(legacyFile)) {
                try {
                    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
                    if (legacy && Array.isArray(legacy.orders) && !fs.existsSync(path.join(this.indexDir, 'orders.idx'))) {
                        legacy.orders.forEach(o => {
                            if (o && o.orderId) this.put('orders', String(o.orderId).toUpperCase(), o);
                        });
                    }
                } catch (_) {}
            }
            this.collections.forEach(col => this.loadIndex(col));
        } catch (err) {
            this.readOnly = true;
            this.mode = pgPool ? 'POSTGRESQL_CLOUD + RAM_CACHE' : 'CLOUD_RAM_FALLBACK';
            console.log('[DB] Read-only disk detected. Active mode:', this.mode);
        }

        if (pgPool) {
            this.initPostgres().catch(err => console.error('[PG_INIT_WARN]', err.message));
        }
    }

    async initPostgres() {
        await pgPool.query(
            'CREATE TABLE IF NOT EXISTS prems_kv_store (col TEXT NOT NULL, doc_key TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (col, doc_key))'
        );
        const res = await pgPool.query('SELECT col, doc_key, payload FROM prems_kv_store ORDER BY updated_at ASC');
        for (let i = 0; i < res.rows.length; i++) {
            const row = res.rows[i];
            if (this.collections.indexOf(row.col) !== -1) {
                this.putLocalOnly(row.col, row.doc_key, row.payload);
            }
        }
        console.log('[DB] PostgreSQL Cloud hydrated:', res.rows.length, 'records.');
    }

    loadIndex(col) {
        const idxPath = path.join(this.indexDir, col + '.idx');
        if (!fs.existsSync(idxPath)) return;
        const lines = fs.readFileSync(idxPath, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split('|');
            if (parts.length === 4) {
                this.indexes[col].set(parts[0], { shard: parts[1], offset: Number(parts[2]), length: Number(parts[3]) });
            }
        }
    }

    getWritableShard(col) {
        const prefix = col + '_';
        if (!this.activeShards[col]) {
            const files = fs.readdirSync(this.shardsDir).filter(f => f.startsWith(prefix) && f.endsWith('.ndjson')).sort();
            if (files.length === 0) {
                this.activeShards[col] = prefix + '0001.ndjson';
            } else {
                const last = files[files.length - 1];
                const stat = fs.statSync(path.join(this.shardsDir, last));
                this.activeShards[col] = stat.size >= SHARD_MAX_BYTES
                    ? (prefix + String(files.length + 1).padStart(4, '0') + '.ndjson')
                    : last;
            }
        } else {
            const currentPath = path.join(this.shardsDir, this.activeShards[col]);
            if (fs.existsSync(currentPath) && fs.statSync(currentPath).size >= SHARD_MAX_BYTES) {
                const num = parseInt(this.activeShards[col].replace(prefix, '').replace('.ndjson', ''), 10) || 1;
                this.activeShards[col] = prefix + String(num + 1).padStart(4, '0') + '.ndjson';
            }
        }
        return this.activeShards[col];
    }

    putLocalOnly(col, key, doc) {
        const normKey = String(key);
        if (this.readOnly) {
            this.ramFallback[col].set(normKey, doc);
            return doc;
        }
        const shardName = this.getWritableShard(col);
        const shardPath = path.join(this.shardsDir, shardName);
        const payload = Buffer.from(JSON.stringify(doc) + '\n', 'utf8');
        const offset = fs.existsSync(shardPath) ? fs.statSync(shardPath).size : 0;
        fs.appendFileSync(shardPath, payload);
        const meta = { shard: shardName, offset: offset, length: payload.length };
        this.indexes[col].set(normKey, meta);
        fs.appendFileSync(path.join(this.indexDir, col + '.idx'), normKey + '|' + shardName + '|' + offset + '|' + payload.length + '\n');
        return doc;
    }

    put(col, key, doc) {
        this.putLocalOnly(col, key, doc);
        if (pgPool) {
            pgPool.query(
                'INSERT INTO prems_kv_store (col, doc_key, payload, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (col, doc_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()',
                [col, String(key), doc]
            ).catch(err => console.error('[PG_SYNC_WARN]', err.message));
        }
        return doc;
    }

    get(col, key) {
        const normKey = String(key);
        if (this.readOnly) return this.ramFallback[col].get(normKey) || null;
        const meta = this.indexes[col].get(normKey);
        if (!meta) return null;
        try {
            const shardPath = path.join(this.shardsDir, meta.shard);
            const fd = fs.openSync(shardPath, 'r');
            const buf = Buffer.alloc(meta.length);
            fs.readSync(fd, buf, 0, meta.length, meta.offset);
            fs.closeSync(fd);
            return JSON.parse(buf.toString('utf8').trim());
        } catch (_) {
            return null;
        }
    }

    list(col, limit, filterFn) {
        const max = limit || 200;
        const results = [];
        if (this.readOnly) {
            const arr = Array.from(this.ramFallback[col].values()).reverse();
            for (let i = 0; i < arr.length; i++) {
                if (!filterFn || filterFn(arr[i])) {
                    results.push(arr[i]);
                    if (results.length >= max) break;
                }
            }
            return results;
        }
        const keys = Array.from(this.indexes[col].keys()).reverse();
        for (let i = 0; i < keys.length; i++) {
            const doc = this.get(col, keys[i]);
            if (doc && (!filterFn || filterFn(doc))) {
                results.push(doc);
                if (results.length >= max) break;
            }
        }
        return results;
    }

    count(col) {
        return this.readOnly ? this.ramFallback[col].size : this.indexes[col].size;
    }

    getStorageStats() {
        let totalBytes = 0;
        let shardCount = 0;
        if (!this.readOnly) {
            try {
                const shardFiles = fs.readdirSync(this.shardsDir);
                shardCount = shardFiles.length;
                shardFiles.forEach(f => { totalBytes += fs.statSync(path.join(this.shardsDir, f)).size; });
                fs.readdirSync(this.indexDir).forEach(f => { totalBytes += fs.statSync(path.join(this.indexDir, f)).size; });
            } catch (_) {}
        }
        const capacityBytes = DB_CAPACITY_GB * 1024 * 1024 * 1024;
        return {
            engine: this.mode,
            postgresConnected: Boolean(pgPool),
            capacityGB: DB_CAPACITY_GB,
            usedBytes: totalBytes,
            usedMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
            percentUsed: Number(((totalBytes / capacityBytes) * 100).toFixed(5)),
            shardCount: shardCount,
            shardMaxMB: SHARD_MAX_BYTES / (1024 * 1024),
            counts: {
                orders: this.count('orders'),
                customers: this.count('customers'),
                customProducts: this.count('products'),
                reviews: this.count('reviews'),
                tickets: this.count('tickets')
            }
        };
    }
}

const db = new ShardedStorageEngine(path.join(__dirname, 'data_store_8gb'));

function getLiveSettings() {
    const saved = db.get('settings', 'store_config');
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
}

// ============================================================================
// 2. COMPLETE 66-PRODUCT CATALOG (50 EXISTING + 8 SPIRITUAL/PUJA + 8 GLYCERIN & COW CARE)
// ============================================================================
const DEFAULT_PRODUCTS = [
    // --- 30 MONSOON & UTILITY ---
    { id: 1, title: "Foldable Hot Air Clothes Drying Bag", price: 3339, category: "Home", rating: 4.9, reviews: 412, stock: 8, artType: "drying_bag", artAccent: "#38BDF8", badge: "Top Seller", fbtId: 6, description: "The ultimate indoor laundry drying solution for home and travel. Attaches to any hair dryer or blower to dry damp garments in 6 minutes.", highlights: ["Dries shirts & jeans in 6–10 mins", "Heat-resistant ripstop polyester", "Folds flat into travel pouch"], specs: { Material: "Heat-Safe Oxford Nylon", Compatibility: "Universal Hair Dryer Nozzle", Warranty: "6 Months Replacement" } },
    { id: 2, title: "Inverted Reverse LED Umbrella", price: 1069, category: "Gear", rating: 4.9, reviews: 142, stock: 12, artType: "umbrella", artAccent: "#6366F1", badge: "Trending", fbtId: 7, description: "Folds inside-out to trap rainwater inside so your car and floors stay dry. Built-in LED rotatable handle flashlight.", highlights: ["Reverse-fold drip-free canopy", "Built-in night LED torch handle", "Windproof fiberglass ribs"], specs: { Canopy: "210T Pongee Water-Repellent", Frame: "10-Rib Windproof Fiberglass", Power: "3x LR44 Included" } },
    { id: 3, title: "Portable Mini Dehumidifier", price: 1999, category: "Home", rating: 4.9, reviews: 84, stock: 6, artType: "dehumidifier", artAccent: "#22D3EE", badge: "Trending", fbtId: 24, description: "Eliminates closet dampness, musty odors, and mold from expensive clothes and camera gear.", highlights: ["Whisper-quiet Peltier cooling", "Auto shut-off when tank full", "Ideal for wardrobes & bedrooms"], specs: { Capacity: "600ml Tank", Power: "22W Low Energy", Noise: "<32 dB Ultra Quiet" } },
    { id: 4, title: "Anti-Fog Helmet Visor Film", price: 539, category: "Vehicle", rating: 4.9, reviews: 230, stock: 18, artType: "helmet_visor", artAccent: "#0EA5E9", badge: "Essential", fbtId: 5, description: "Clear nano-adhesive shield. Prevents fogging from breath and rain instantly for crystal-clear night riding.", highlights: ["Optical-grade clarity", "Zero breath fog in winter & rain", "Universal fit for full-face helmets"], specs: { Material: "Nano Hydrophilic PET", Size: "24.5 x 7 cm Universal", Lifespan: "Up to 2 Years" } },
    { id: 5, title: "Hydrophobic Side Mirror Film (2 Pc)", price: 339, category: "Vehicle", rating: 4.6, reviews: 67, stock: 15, artType: "mirror_film", artAccent: "#0284C7", badge: "Essential", fbtId: 4, description: "Nano-coating prevents car side mirrors from holding water droplets during heavy downpours.", highlights: ["Anti-glare + anti-rain droplets", "Includes wet/dry install kit", "Fits all cars & SUVs"], specs: { Pack: "2 Oval Films (100x150mm)", Coating: "Micro-Nano Hydrophobic", Install: "Bubble-Free 2-Min Peel" } },
    { id: 6, title: "Electric Hot Air Clothes Hanger", price: 2539, category: "Home", rating: 4.9, reviews: 154, stock: 7, artType: "air_hanger", artAccent: "#F97316", badge: "Top Seller", fbtId: 1, description: "Portable travel hanger with dual hot/cold airflow vents. Dries wet office shirts rapidly overnight.", highlights: ["Dual hot & cold airflow modes", "Detachable arms for suitcase", "Includes shoe-drying tube"], specs: { Power: "150W PTC Ceramic", Load: "Up to 5 kg", Voltage: "220V Indian Plug" } },
    { id: 7, title: "Waterproof Laptop Backpack Cover", price: 399, category: "Gear", rating: 4.8, reviews: 175, stock: 16, artType: "backpack_cover", artAccent: "#10B981", badge: "Popular", fbtId: 15, description: "High-density nylon elastic shield keeps expensive laptops and books 100% dry in heavy rain.", highlights: ["Fits 20L–40L backpacks", "Reflective night safety strip", "Folds into palm-size pouch"], specs: { Material: "190T Silver-Coated Nylon", Waterproof: "3000mm Hydrostatic", Weight: "65g" } },
    { id: 8, title: "Full-Body Scooter Rain Poncho", price: 869, category: "Vehicle", rating: 4.7, reviews: 110, stock: 9, artType: "rain_poncho", artAccent: "#3B82F6", badge: "Popular", fbtId: 12, description: "Heavy-duty hooded rain suit featuring a transparent visor cutout and mirror slots.", highlights: ["Covers rider + scooter headlight", "Transparent headlight panel", "Mirror sleeves for safe riding"], specs: { Material: "Thick Eco-EVA", Size: "Universal Free Size", Feature: "Reflective Back Strip" } },
    { id: 9, title: "Heavy-Duty Motorcycle Rain Cover", price: 669, category: "Vehicle", rating: 4.7, reviews: 142, stock: 10, artType: "bike_cover", artAccent: "#64748B", badge: "Popular", fbtId: 4, description: "UV and silver-coated waterproof cover shielding parked two-wheelers from rust and rain.", highlights: ["Double-stitched waterproof seams", "Bottom buckle wind-lock", "Heat-resistant silver outer"], specs: { Fit: "All 100cc–350cc Bikes", Material: "210D Oxford UV", Storage: "Carry Pouch Included" } },
    { id: 10, title: "Rapid-Absorb Microfiber Travel Towel", price: 599, category: "Gear", rating: 4.7, reviews: 119, stock: 14, artType: "travel_towel", artAccent: "#14B8A6", badge: "Trending", fbtId: 17, description: "Soaks up 4x its weight in water and wrings out dry. Folds into a pocket-sized pouch.", highlights: ["Dries 3x faster than cotton", "Antibacterial silver-ion weave", "Includes breathable zip pouch"], specs: { Size: "120 x 60 cm", Material: "80/20 Ultrafine Microfiber", Weight: "180g" } },
    { id: 11, title: "Magic Microfiber Cleaning Towels (3 Pk)", price: 139, category: "Home", rating: 4.8, reviews: 512, stock: 24, artType: "cleaning_cloth", artAccent: "#EAB308", badge: "Steal Deal", fbtId: 14, description: "Ultra-absorbent lint-free cloths. Perfect for wiping wet bike seats, windshields, and counters.", highlights: ["Zero streaks on glass & paint", "800 GSM plush double-sided", "Machine washable 300+ times"], specs: { Pack: "3 Assorted Cloths", Size: "30 x 40 cm", Density: "800 GSM" } },
    { id: 12, title: "Reusable PVC Rain Shoe Covers", price: 189, category: "Footwear", rating: 4.6, reviews: 289, stock: 19, artType: "shoe_cover", artAccent: "#06B6D4", badge: "Steal Deal", fbtId: 21, description: "Foldable waterproof zipper shoe covers with reinforced anti-slip tread.", highlights: ["Full-length waterproof zipper", "Deep anti-skid rubber sole", "Elastic ankle drawcord"], specs: { Material: "Thickened PVC", Sizes: "M / L / XL", Reusable: "Yes, Wash & Fold" } },
    { id: 13, title: "Anti-Mosquito Herbal Patches (72 Pc)", price: 139, category: "Gear", rating: 4.9, reviews: 834, stock: 28, artType: "mosquito_patch", artAccent: "#22C55E", badge: "Steal Deal", fbtId: 18, description: "100% natural citronella oil patches. Stick on clothes to repel mosquitoes for 12 hours.", highlights: ["DEET-free & kid-safe", "Pure citronella & eucalyptus oil", "12-hour protection per patch"], specs: { Count: "72 Patches (12 Sheets)", Ingredients: "Natural Essential Oils", Usage: "Clothes, Bags, Strollers" } },
    { id: 14, title: "Silicone Anti-Clog Drain Strainer", price: 95, category: "Home", rating: 4.7, reviews: 145, stock: 30, artType: "drain_strainer", artAccent: "#38BDF8", badge: "Steal Deal", fbtId: 19, description: "Suction-cup flexible silicone trap. Prevents hair and debris from clogging shower drains.", highlights: ["4 strong bottom suction cups", "Catches hair without slowing flow", "Easy lift-and-rinse cleaning"], specs: { Material: "Food-Grade TPR Silicone", Diameter: "13 cm", Fit: "All Flat Drains" } },
    { id: 15, title: "Universal Waterproof Phone Pouch", price: 269, category: "Gear", rating: 4.7, reviews: 312, stock: 17, artType: "phone_pouch", artAccent: "#0EA5E9", badge: "Popular", fbtId: 16, description: "IPX8 certified touch-sensitive dry bag. Take calls and record underwater or in heavy rain.", highlights: ["IPX8 waterproof up to 30m", "Crystal-clear camera window", "Includes neck lanyard"], specs: { Fit: "Phones up to 7.0 inch", Seal: "Dual Snap-Lock Clip", Touch: "Full Screen Sensitive" } },
    { id: 16, title: "Multi-Angle Aluminum Phone Stand", price: 119, category: "Gear", rating: 4.8, reviews: 420, stock: 22, artType: "phone_stand", artAccent: "#94A3B8", badge: "Steal Deal", fbtId: 17, description: "Foldable desktop dock. Keeps your phone elevated for hands-free calls and charging.", highlights: ["270° smooth hinge tilt", "Anti-slip silicone pads", "Charging cable cutout"], specs: { Material: "Anodized Aluminum Alloy", Weight: "95g", Fit: "All Smartphones & Mini Tabs" } },
    { id: 17, title: "Waterproof Travel Cable Organizer", price: 239, category: "Gear", rating: 4.7, reviews: 198, stock: 14, artType: "cable_bag", artAccent: "#6366F1", badge: "Popular", fbtId: 39, description: "Cushioned tech pouch that shields power banks, adapters, and cables from moisture.", highlights: ["Water-repellent cationic fabric", "Elastic loops + mesh pockets", "Shock-padded interior"], specs: { Dimensions: "24 x 17 x 4 cm", Compartments: "8 Organizers", Zipper: "Smooth Dual-Pull" } },
    { id: 18, title: "Pocket Raincoat Emergency Keyring Ball", price: 95, category: "Gear", rating: 4.5, reviews: 620, stock: 32, artType: "keyring_poncho", artAccent: "#F43F5E", badge: "Steal Deal", fbtId: 2, description: "Full-size emergency poncho packed inside a compact keychain sphere that clips to your bag.", highlights: ["Clip to backpack or bike key", "Unfolds to full-body hooded coat", "Weighs only 45 grams"], specs: { SphereSize: "6.5 cm Diameter", Material: "Waterproof PE Film", Clip: "Carabiner Hook" } },
    { id: 19, title: "Silicone Door Bottom Seal Strip", price: 169, category: "Home", rating: 4.6, reviews: 180, stock: 21, artType: "door_seal", artAccent: "#A855F7", badge: "Essential", fbtId: 14, description: "Self-adhesive acoustic and weather strip. Blocks rainwater, dust, insects, and AC drafts.", highlights: ["Blocks cockroaches, dust & rain", "Saves up to 20% AC cooling", "Peel-and-stick 3M backing"], specs: { Length: "1 Meter Roll", Width: "45 mm", Material: "Flexible Clear Silicone" } },
    { id: 20, title: "Waterproof LED Runner Shoe Clip", price: 189, category: "Gear", rating: 4.8, reviews: 115, stock: 11, artType: "shoe_led", artAccent: "#EF4444", badge: "Popular", fbtId: 23, description: "High-visibility heel safety light clip. Keeps night runners and cyclists visible in fog and rain.", highlights: ["Steady + strobe safety modes", "Grips firmly on any running shoe", "Rainproof sealed casing"], specs: { Runtime: "Up to 70 Hours", Visibility: "500m Night Range", Weight: "28g" } },
    { id: 21, title: "UV Thermal Shoe & Boot Dryer", price: 1339, category: "Footwear", rating: 5.0, reviews: 210, stock: 6, artType: "shoe_dryer", artAccent: "#8B5CF6", badge: "Top Seller", fbtId: 24, description: "360-degree internal heat blower dries wet sneakers overnight while UV light neutralizes odor bacteria.", highlights: ["Constant 48°C shoe-safe heat", "Built-in UV odor sterilizer", "Auto-timer 3 / 6 / 9 hours"], specs: { Power: "20W Safe PTC", Fit: "Sneakers, Leather & Boots", Cord: "1.4m Indian Plug" } },
    { id: 22, title: "Silicone Slip-On Shoe Protectors", price: 469, category: "Footwear", rating: 4.8, reviews: 98, stock: 13, artType: "silicone_shoe", artAccent: "#2DD4BF", badge: "Trending", fbtId: 21, description: "Stretchable skin-tight silicone overshoes. Protects white sneakers from mud and puddles.", highlights: ["3x elastic tear-resistant silicone", "Wave-pattern anti-slip sole", "Rinse clean in 10 seconds"], specs: { Material: "100% Liquid Silicone", Fit: "UK 6 to UK 11", Weight: "160g/pair" } },
    { id: 23, title: "Breathable Quick-Dry Aqua Shoes", price: 839, category: "Footwear", rating: 4.7, reviews: 142, stock: 9, artType: "aqua_shoes", artAccent: "#0EA5E9", badge: "Popular", fbtId: 30, description: "Ultra-lightweight amphibious mesh shoes with sole drainage channels for treks and wet streets.", highlights: ["8-port sole water drainage", "Sock-like breathable stretch mesh", "Grippy rubber trail outsole"], specs: { Upper: "Quick-Dry Lycra Mesh", Sole: "Drainage Rubber", Weight: "240g" } },
    { id: 24, title: "Bamboo Charcoal Deodorizer Bags", price: 329, category: "Footwear", rating: 4.9, reviews: 310, stock: 18, artType: "charcoal_bag", artAccent: "#475569", badge: "Essential", fbtId: 21, description: "Natural activated charcoal pouches that pull moisture and odor out of shoes and gym bags.", highlights: ["100% fragrance-free Moso bamboo", "Recharge in sunlight every month", "Lasts up to 2 full years"], specs: { Pack: "2 x 100g Linen Pouches", Lifespan: "24 Months Reusable", Safety: "Pet & Kid Safe" } },
    { id: 25, title: "Men's Tactical Windbreaker Rain Jacket", price: 1779, category: "Apparel", rating: 4.9, reviews: 275, stock: 7, artType: "rain_jacket", artAccent: "#334155", badge: "Top Seller", fbtId: 26, description: "Matte-black hydrophobic shell jacket with seam-sealed zippers and breathable mesh lining.", highlights: ["Seam-sealed waterproof zippers", "Hidden zip chest & inner pockets", "Detachable storm hood"], specs: { Fabric: "3-Layer Softshell", Waterproof: "8000mm Rated", Sizes: "M, L, XL, XXL" } },
    { id: 26, title: "Quick-Dry 4-Way Stretch Trousers", price: 1399, category: "Apparel", rating: 4.8, reviews: 190, stock: 10, artType: "trousers", artAccent: "#475569", badge: "Trending", fbtId: 25, description: "Water-repellent tailored commuter pants that shed water and dry in 15 minutes.", highlights: ["4-way athletic stretch comfort", "DWR lotus-effect water beading", "Hidden zip security pocket"], specs: { Fabric: "90% Nylon / 10% Spandex", Fit: "Tapered Smart Casual", DryTime: "15 Mins Air Dry" } },
    { id: 27, title: "All-Weather Storm Hooded Parka", price: 2149, category: "Apparel", rating: 5.0, reviews: 88, stock: 5, artType: "storm_parka", artAccent: "#1E293B", badge: "Premium", fbtId: 29, description: "Extended-length storm parka engineered for zero water penetration during heavy travel.", highlights: ["Knee-length monsoon coverage", "Thermal-sealed storm flap", "Adjustable Velcro cuffs"], specs: { Fabric: "Heavy Ripstop PU", Rating: "10,000mm Stormproof", Fit: "Relaxed Layering" } },
    { id: 28, title: "Hydrophobic Stain-Proof Men's Polo", price: 749, category: "Apparel", rating: 4.7, reviews: 165, stock: 14, artType: "polo_shirt", artAccent: "#2563EB", badge: "Popular", fbtId: 26, description: "Nano-treated breathable cotton blend. Coffee, soda, and raindrops roll right off the fabric.", highlights: ["Repels coffee, tea & rain splashes", "Anti-odor breathable pique knit", "Retains effect 40+ washes"], specs: { Material: "Nano-Treated Combed Cotton", Fit: "Regular Tailored", Care: "Cold Gentle Wash" } },
    { id: 29, title: "Lightweight Zip-On Rain Overpants", price: 939, category: "Apparel", rating: 4.6, reviews: 112, stock: 9, artType: "overpants", artAccent: "#64748B", badge: "Essential", fbtId: 25, description: "Ankle-zip waterproof over-trousers that slip easily over formal pants without removing shoes.", highlights: ["Wide ankle zipper for easy slip-on", "Taped crotch & leg seams", "Packs into built-in pocket"], specs: { Material: "Waterproof Polyester PVC", Waist: "Elastic + Drawcord", Weight: "290g" } },
    { id: 30, title: "Orthopedic Arch Waterproof Sandals", price: 1119, category: "Footwear", rating: 4.8, reviews: 320, stock: 11, artType: "sandals", artAccent: "#0D9488", badge: "Trending", fbtId: 23, description: "High-rebound EVA recovery sandals with deep anti-skid grooves for wet surfaces.", highlights: ["Anatomical arch pain relief", "Cloud-cushion 3.5cm EVA sole", "Zero-slip wet tile traction"], specs: { Material: "Dual-Density EVA", WaterSafe: "100% Washable", Fit: "Unisex UK 6–11" } },

    // --- 10 EVERGREEN WINNERS ---
    { id: 31, title: "Smart Sensor Posture Corrector Brace", price: 1299, category: "Gear", rating: 4.8, reviews: 540, stock: 10, artType: "posture_brace", artAccent: "#6366F1", badge: "Evergreen", fbtId: 32, description: "Gently vibrates whenever your back slouches past 25 degrees. Builds upright spinal muscle memory.", highlights: ["Real-time 25° tilt vibration alert", "LCD slouch counter display", "USB-C rechargeable (15 days/charge)"], specs: { Battery: "500mAh Li-Ion", Straps: "Breathable Nylon", Fit: "Teens & Adults" } },
    { id: 32, title: "Portable EMS Thermal Neck Massager", price: 1899, category: "Home", rating: 4.9, reviews: 812, stock: 8, artType: "neck_massager", artAccent: "#EC4899", badge: "Top Seller", fbtId: 31, description: "Melts away desk-job neck stiffness in 15 minutes using warm compress and TENS pulse therapy.", highlights: ["42°C soothing thermal compress", "6 massage modes + 15 intensities", "Featherlight 140g U-shape"], specs: { Therapy: "EMS + Constant Heat", Charging: "USB-C Fast Charge", AutoOff: "15-Min Smart Timer" } },
    { id: 33, title: "Mini 1080p Wide-Angle Car Dash Cam", price: 2199, category: "Vehicle", rating: 4.7, reviews: 320, stock: 9, artType: "dash_cam", artAccent: "#EF4444", badge: "Essential", fbtId: 34, description: "Discreet windshield camera with night vision, G-sensor collision lock, and loop recording.", highlights: ["Full HD 1080p 170° wide lens", "G-sensor emergency video lock", "Starlight night-vision clarity"], specs: { Resolution: "1920x1080 @ 30fps", Storage: "Supports up to 128GB SD", Mount: "3M Suction + Car Charger" } },
    { id: 34, title: "Auto-Clamping Wireless Car Charger Mount", price: 1449, category: "Vehicle", rating: 4.8, reviews: 450, stock: 12, artType: "car_charger", artAccent: "#3B82F6", badge: "Trending", fbtId: 33, description: "Infrared sensor arms open automatically when you bring your phone near and fast-charge on the go.", highlights: ["15W Qi fast wireless charging", "Auto IR-sensor clamping arms", "AC vent + dashboard mount"], specs: { Output: "15W / 10W / 7.5W", Input: "USB-C QC 3.0", Rotation: "360° Ball Joint" } },
    { id: 35, title: "6-Blade Portable USB Blender Bottle", price: 1199, category: "Home", rating: 4.6, reviews: 920, stock: 15, artType: "usb_blender", artAccent: "#10B981", badge: "Bestseller", fbtId: 38, description: "Crush ice, fruit, and protein shakes in 30 seconds at the gym or office. USB-C rechargeable.", highlights: ["6 stainless 304 steel blades", "15 blends per full USB-C charge", "BPA-free 380ml borosilicate cup"], specs: { Capacity: "380 ml", Motor: "18,000 RPM High Torque", Safety: "Magnetic Auto-Lock" } },
    { id: 36, title: "Ergonomic Memory Foam Knee Pillow", price: 899, category: "Home", rating: 4.9, reviews: 1105, stock: 13, artType: "knee_pillow", artAccent: "#8B5CF6", badge: "Evergreen", fbtId: 32, description: "Contoured leg pillow aligns hips and lower spine for side-sleepers, relieving sciatica and back pain.", highlights: ["High-density slow-rebound foam", "Breathable washable zip cover", "Elastic leg strap stays in place"], specs: { Core: "100% Pure Memory Foam", Cover: "Hypoallergenic Bamboo", Size: "25 x 20 x 14 cm" } },
    { id: 37, title: "Self-Cleaning Pet Hair Lint Roller", price: 549, category: "Home", rating: 4.7, reviews: 670, stock: 18, artType: "lint_roller", artAccent: "#F59E0B", badge: "Popular", fbtId: 11, description: "Electrostatic brush traps fur and lint from sofas and clothes into a push-button dust chamber.", highlights: ["Zero sticky refill tape needed", "1-click self-emptying bin", "Works on sofas, beds & car seats"], specs: { Material: "ABS + Nylon Bristle", Reusable: "100% Eco-Friendly", Power: "No Batteries Needed" } },
    { id: 38, title: "12-in-1 Mandoline Vegetable Chopper Pro", price: 999, category: "Home", rating: 4.8, reviews: 1432, stock: 9, artType: "veg_chopper", artAccent: "#22C55E", badge: "Top Seller", fbtId: 35, description: "Stainless steel dicer, julienne slicer, and colander basket that cuts kitchen prep time by 70%.", highlights: ["7 interchangeable 420-steel blades", "Built-in drain colander + hand guard", "Cuts onions without tears"], specs: { Blades: "Rust-Proof 420 Steel", Container: "1.5L BPA-Free", Includes: "Cleaning Fork & Guard" } },
    { id: 39, title: "Anti-Theft Crossbody Sling Tech Bag", price: 1249, category: "Gear", rating: 4.8, reviews: 490, stock: 11, artType: "sling_bag", artAccent: "#475569", badge: "Trending", fbtId: 17, description: "Slash-resistant commuter sling with TSA combination lock, hidden pockets, and external USB port.", highlights: ["3-digit TSA anti-theft lock", "External USB charging pass-through", "Waterproof hard-shell front"], specs: { Material: "Waterproof Oxford + EVA", Fit: "Fits iPad Mini & Powerbank", Strap: "Breathable Padded" } },
    { id: 40, title: "Wireless Charging LED Minimalist Desk Lamp", price: 1699, category: "Home", rating: 4.7, reviews: 215, stock: 8, artType: "desk_lamp", artAccent: "#FBBF24", badge: "Essential", fbtId: 16, description: "Eye-care dimmable studio lamp with 3 color temperatures and a built-in 15W fast wireless charger.", highlights: ["Flicker-free eye-care LED panel", "15W Qi phone charger in base", "Touch dimmer (Warm / Neutral / Cool)"], specs: { CRI: ">90 True Color", Charger: "15W Wireless Pad", Arm: "Foldable Aluminum" } },

    // --- 10 FEMALE BEAUTY HARDWARE WINNERS ---
    { id: 41, title: "Electric Makeup Brush Spinner Cleaner & Dryer", price: 1499, category: "Beauty & Care", rating: 4.9, reviews: 1204, stock: 10, artType: "brush_cleaner", artAccent: "#F472B6", badge: "Viral Winner", fbtId: 50, description: "Washes and spin-dries foundation brushes in 30 seconds. Stops breakouts caused by dirty bristles.", highlights: ["98% bacteria & makeup removal", "8 silicone collars fit all brushes", "Dry & ready to use in 30 secs"], specs: { Collars: "8 Sizes (3mm–30mm)", Bowl: "Splash-Guard Acrylic", Speed: "High-Torque Spinner" } },
    { id: 42, title: "7-Color LED Photon Therapy Face Mask", price: 4999, category: "Beauty & Care", rating: 5.0, reviews: 312, stock: 5, artType: "led_mask", artAccent: "#FF3366", badge: "Premium", fbtId: 48, description: "Clinical light therapy at home. Red wavelengths boost collagen; blue light targets active acne bacteria.", highlights: ["7 clinical LED spectrum modes", "Red 630nm anti-aging + Blue 470nm acne", "Wireless rechargeable comfort fit"], specs: { LEDs: "150 Medical-Grade Diodes", Session: "15-Min Auto Timer", Charging: "USB-C Wireless" } },
    { id: 43, title: "Rechargeable Heated Eyelash Curler", price: 999, category: "Beauty & Care", rating: 4.8, reviews: 856, stock: 14, artType: "lash_curler", artAccent: "#EC4899", badge: "Trending", fbtId: 47, description: "2-temperature ceramic thermal comb lifts lashes in 10 seconds for a 24-hour curl without pinching.", highlights: ["Heats up in 10 seconds", "Anti-burn curved thermal guard", "24-hour natural lift with mascara"], specs: { Temps: "65°C & 85°C Dual Mode", Battery: "USB-C Rechargeable", Weight: "32g Pocket Size" } },
    { id: 44, title: "Soft Silicone Scalp Massager & Hair Growth Brush", price: 449, category: "Beauty & Care", rating: 4.9, reviews: 1840, stock: 22, artType: "scalp_brush", artAccent: "#A855F7", badge: "Essential", fbtId: 49, description: "Deeply exfoliates dandruff buildup and boosts follicle blood flow during shampooing or oil massage.", highlights: ["Gentle food-grade silicone teeth", "Boosts scalp circulation & lather", "Protects manicured nails"], specs: { Material: "100% Soft Silicone + ABS", Use: "Wet Shampoo or Dry Oil", Fit: "Ergonomic Palm Grip" } },
    { id: 45, title: "Cryo Ice Roller & Rose Quartz Gua Sha Set", price: 1299, category: "Beauty & Care", rating: 4.7, reviews: 920, stock: 11, artType: "gua_sha", artAccent: "#FB7185", badge: "Bestseller", fbtId: 46, description: "Morning lymphatic drainage kit. Instantly depuffs under-eyes, tightens pores, and contours the jawline.", highlights: ["Natural Rose Quartz Gua Sha stone", "Leak-free refillable cryo ice roller", "Instant morning de-puffing"], specs: { Includes: "Ice Roller + Gua Sha", Material: "Natural Quartz + Silicone", Benefit: "Lymphatic Contour" } },
    { id: 46, title: "Reusable Medical-Grade Silicone Eye Patches", price: 699, category: "Beauty & Care", rating: 4.8, reviews: 630, stock: 16, artType: "eye_patches", artAccent: "#F43F5E", badge: "Eco-Luxury", fbtId: 45, description: "Locks in your favorite eye cream to plump fine lines and dark circles. Washable and reusable 100+ times.", highlights: ["Boosts eye serum absorption 3x", "Includes travel storage tin", "Zero-waste 100+ reuses"], specs: { Material: "100% Medical Silicone", Care: "Rinse with Mild Soap", Case: "Brushed Metal Tin" } },
    { id: 47, title: "18K Gold-Plated Precision Eyebrow & Peach Fuzz Trimmer", price: 799, category: "Beauty & Care", rating: 4.6, reviews: 1450, stock: 17, artType: "brow_trimmer", artAccent: "#F59E0B", badge: "Top Seller", fbtId: 43, description: "Hypoallergenic micro-blade with built-in LED light removes facial hair painlessly with zero redness.", highlights: ["18K gold-plated hypoallergenic head", "Built-in precision LED spotlight", "Painless lipstick-sized design"], specs: { Power: "USB Rechargeable", Blade: "Washable Detachable Head", Skin: "Safe for Sensitive Skin" } },
    { id: 48, title: "3D Microcurrent EMS Facial Sculpting Wand", price: 1899, category: "Beauty & Care", rating: 4.7, reviews: 420, stock: 8, artType: "ems_wand", artAccent: "#E879F9", badge: "Viral Winner", fbtId: 42, description: "High-frequency sonic vibration + gentle microcurrents tone sagging cheeks for a lifted V-line contour.", highlights: ["Microcurrent jawline & cheek lift", "10,000 RPM sonic serum infusion", "Ergonomic dolphin-tail contour"], specs: { Modes: "Lift / Glow / Warm Relax", Charging: "USB-C Fast Charge", Runtime: "90 Mins" } },
    { id: 49, title: "Antibacterial Silicone Body Scrubber", price: 549, category: "Beauty & Care", rating: 4.9, reviews: 2100, stock: 24, artType: "body_scrubber", artAccent: "#38BDF8", badge: "Essential", fbtId: 60, description: "Soft silicone bristles lather rich foam, unclog back pores, and never harbor mold like mesh loofahs.", highlights: ["35x more hygienic than loofahs", "Gentle exfoliation for glowing skin", "Built-in hanging hook"], specs: { Material: "BPA-Free Soft Silicone", Bristles: "Dual-Zone Soft/Massage", Lifespan: "1+ Year" } },
    { id: 50, title: "Tri-Tone Rechargeable LED Travel Vanity Mirror", price: 1599, category: "Beauty & Care", rating: 4.8, reviews: 750, stock: 9, artType: "vanity_mirror", artAccent: "#FDE047", badge: "Must Have", fbtId: 41, description: "Simulates natural daylight, warm evening, and office lighting so your makeup is never cakey.", highlights: ["3 color temps (Day / Warm / Cool)", "Stepless touch brightness dimmer", "Ultra-slim foldable stand"], specs: { LEDs: "72 High-CRI Diodes", Battery: "1200mAh USB-C", Size: "20 x 14 cm Slim" } },

    // --- 8 HINDU SPIRITUAL & PUJA ESSENTIALS ---
    { id: 51, title: "Authentic 5-Mukhi Nepali Rudraksha Mala (108+1 Beads)", price: 699, category: "Spiritual & Puja", rating: 4.9, reviews: 648, stock: 14, artType: "rudraksha_mala", artAccent: "#EA580C", badge: "Lab Certified", fbtId: 53, description: "Hand-knotted sacred 5-Mukhi Nepali Rudraksha prayer mala with traditional red silk tassel. Ideal for daily Shiva japa, meditation, and wearing.", highlights: ["100% genuine natural 5-Mukhi Nepali beads", "Traditional knotted thread + Guru bead", "Includes authenticity certificate & velvet pouch"], specs: { Beads: "108 + 1 Guru Bead (7–8mm)", Origin: "Nepal Himalayan Region", Certification: "Lab Tested Natural" } },
    { id: 52, title: "Lab-Certified 7-Mukhi Laxmi Rudraksha Pendant", price: 1199, category: "Spiritual & Puja", rating: 5.0, reviews: 284, stock: 7, artType: "rudraksha_pendant", artAccent: "#F59E0B", badge: "Auspicious", fbtId: 51, description: "Sacred 7-Mukhi Rudraksha capped in pure silver-tone panchdhatu setting with red mouli cord. Revered for prosperity, focus, and Goddess Mahalaxmi blessings.", highlights: ["Natural 7-face grooves verified", "Ready-to-wear panchdhatu capping", "Energized & packed in sacred gift box"], specs: { Mukhi: "7-Mukhi (Mahalaxmi)", Origin: "Nepal Natural Bead", Includes: "Certificate + Red Cord" } },
    { id: 53, title: "Pure Brass Akhand Jyoti Diya with Glass Chimney", price: 749, category: "Spiritual & Puja", rating: 4.9, reviews: 512, stock: 12, artType: "brass_diya", artAccent: "#FBBF24", badge: "Devotional Hit", fbtId: 64, description: "Heavyweight solid brass Akhand Jyoti oil/ghee lamp with heat-resistant borosilicate glass shield that keeps the sacred flame steady even under fans.", highlights: ["Heavy virgin brass construction", "Windproof borosilicate glass cover", "Easy-lift cotton wick adjuster knob"], specs: { Material: "100% Solid Brass + Glass", Height: "15 cm", Weight: "320g Heavy Base" } },
    { id: 54, title: "100% Pure Bhimseni Camphor (Karpooram) — 250g Jar", price: 499, category: "Spiritual & Puja", rating: 4.9, reviews: 920, stock: 20, artType: "camphor_jar", artAccent: "#E2E8F0", badge: "100% Pure", fbtId: 58, description: "Pine-derived crystalline Bhimseni Kapoor that burns cleanly with zero black soot residue. Purifies home aura during aarti and evening puja.", highlights: ["Burns 100% cleanly — zero black soot", "Rich natural pine-camphor aroma", "Airtight reusable glass jar"], specs: { Weight: "250 Grams Crystals", Purity: "100% Natural Pine Derived", Use: "Aarti, Diffuser & Puja" } },
    { id: 55, title: "Mysore Pure Chandan (Sandalwood) Tilak Paste — 100g", price: 349, category: "Spiritual & Puja", rating: 4.8, reviews: 410, stock: 16, artType: "chandan_paste", artAccent: "#D97706", badge: "Authentic", fbtId: 51, description: "Aromatic cooling sandalwood paste blended with kesar (saffron) for daily forehead tilak and deity abhishek.", highlights: ["Authentic Mysore sandalwood fragrance", "Infused with Kashmiri kesar strands", "Cooling, skin-safe natural formula"], specs: { Weight: "100g Airtight Jar", Ingredients: "Sandalwood, Kesar, Rose", Use: "Daily Tilak & Mandir" } },
    { id: 56, title: "Antique Brass Ganesh & Laxmi Idol Duo for Mandir", price: 1499, category: "Spiritual & Puja", rating: 5.0, reviews: 335, stock: 6, artType: "brass_idol", artAccent: "#F59E0B", badge: "Handcrafted", fbtId: 53, description: "Intricately hand-cast Moradabad antique-finish brass Lord Ganesh and Goddess Laxmi murtis for home temple, office desk, and auspicious gifting.", highlights: ["Artisan-cast solid Moradabad brass", "Fine antique gold patina finish", "Velvet-lined auspicious gift box"], specs: { Material: "100% Solid Brass", Height: "11 cm Each", Weight: "850g Pair" } },
    { id: 57, title: "Pure Copper Kalash & Panchamrit Pooja Set (5 Pc)", price: 999, category: "Spiritual & Puja", rating: 4.8, reviews: 276, stock: 10, artType: "copper_kalash", artAccent: "#C2410C", badge: "Vedic Pure", fbtId: 54, description: "99.9% pure hammered copper puja set featuring Kalash Lota, Achamani spoon, Panchpatra bowl, Plate, and Chandan katori.", highlights: ["99.9% lab-grade pure copper", "Traditional hammered temple finish", "Complete 5-piece daily puja kit"], specs: { Pieces: "5-Piece Complete Set", Material: "Heavy Gauge Pure Copper", Care: "Pitambari / Lemon Wash" } },
    { id: 58, title: "Natural Loban & Sambrani Havan Dhoop Cups (36 Pc)", price: 399, category: "Spiritual & Puja", rating: 4.9, reviews: 785, stock: 22, artType: "sambrani_cups", artAccent: "#B45309", badge: "Bestseller", fbtId: 62, description: "Charcoal-free herbal havan cups filled with pure Guggal, Loban, and Sambrani resin. Includes reusable brass holder plate.", highlights: ["Charcoal-free sacred resin blend", "20-minute rich temple fragrance", "Free brass burner stand included"], specs: { Count: "36 Ready-to-Light Cups", Ingredients: "Loban, Guggal, Herbs", Holder: "1 Brass Stand Included" } },

    // --- 8 GLYCERIN & DESI COW (PANCHAGAVYA) PRODUCTS ---
    { id: 59, title: "100% Pure Vegetable Glycerin (USP Grade Skin & Hair, 250ml)", price: 299, category: "Ayurveda & Cow Care", rating: 4.9, reviews: 1120, stock: 25, artType: "glycerin_bottle", artAccent: "#38BDF8", badge: "USP 99.7% Pure", fbtId: 65, description: "Crystal-clear, food & cosmetic-grade 100% plant-derived vegetable glycerin. Deeply hydrates cracked heels, dry winter skin, lips, and DIY face serums.", highlights: ["99.7% Pure USP Vegetable-Derived", "Odorless, non-sticky humectant glow", "Safe for face, lips, heels & hair"], specs: { Volume: "250 ml Flip-Top Bottle", Grade: "USP / IP Cosmetic Pure", Additives: "Zero Parabens or Fragrance" } },
    { id: 60, title: "Handmade Pure Glycerin & Rose Herbal Soap (Pack of 3)", price: 389, category: "Ayurveda & Cow Care", rating: 4.9, reviews: 840, stock: 19, artType: "glycerin_soap", artAccent: "#FB7185", badge: "Moisture Lock", fbtId: 59, description: "Translucent cold-process pure vegetable glycerin bathing bars infused with Kannauj rose petals, aloe vera, and vitamin E for soft, non-drying cleansing.", highlights: ["High natural glycerin locks moisture", "Zero SLS, SLES, or harsh sulfates", "Gentle pH-balanced daily glow"], specs: { Pack: "3 x 100g Handmade Bars", Base: "100% Veg Glycerin + Rose", SkinType: "All & Sensitive Skin" } },
    { id: 61, title: "Bilona A2 Desi Gir Cow Ghee (Vedic Hand-Churned, 500ml)", price: 1299, category: "Ayurveda & Cow Care", rating: 5.0, reviews: 690, stock: 9, artType: "cow_ghee", artAccent: "#F59E0B", badge: "Vedic A2 Pure", fbtId: 64, description: "Authentic small-batch A2 Gir Cow Ghee prepared via traditional wooden Bilona curd-churning method. Rich golden granular texture, nutty aroma, and high nutrition.", highlights: ["100% grass-fed Desi Gir Cow A2 milk", "Traditional curd-churned Bilona method", "Packed in lab-sealed glass jar"], specs: { Volume: "500 ml Glass Jar", Method: "Vedic Wooden Bilona", Purity: "Zero Preservatives / Lab Tested" } },
    { id: 62, title: "Pure Desi Cow Dung Dhoop Cones & Gomaya Sambrani (40 Pc)", price: 329, category: "Ayurveda & Cow Care", rating: 4.9, reviews: 530, stock: 21, artType: "cow_dhoop", artAccent: "#D97706", badge: "Gomaya Pure", fbtId: 58, description: "Handcrafted from sacred Desi Cow Dung (Gomaya), Gir Cow Ghee, Guggal, and temple flowers. Naturally purifies indoor air and repels insects.", highlights: ["Made from pure Desi Cow Gomaya", "100% charcoal & chemical-free", "Creates authentic Vedic havan aura"], specs: { Count: "40 Cones + Clay Burner", Ingredients: "Cow Dung, Ghee, Guggal", BurnTime: "20–25 Mins/Cone" } },
    { id: 63, title: "Panchagavya Ayurvedic Herbal Soap (Cow Ghee, Milk & Neem, 3 Pk)", price: 419, category: "Ayurveda & Cow Care", rating: 4.8, reviews: 465, stock: 16, artType: "panchagavya_soap", artAccent: "#65A30D", badge: "Ayurvedic", fbtId: 60, description: "Traditional Ayurvedic bathing bars formulated with Desi Cow Ghee, Raw Milk, Multani Mitti, Tulsi, and Neem for deeply nourished, blemish-free skin.", highlights: ["Enriched with A2 Cow Ghee & Neem", "Natural skin detox without dryness", "Handcrafted in Gaushala small batches"], specs: { Pack: "3 x 100g Ayurvedic Bars", KeyActives: "Cow Ghee, Milk, Neem, Tulsi", Chemicals: "100% Paraben & SLS Free" } },
    { id: 64, title: "Desi Cow Ghee Diya Batti — Ready-to-Light Wicks (100 Pc)", price: 279, category: "Ayurveda & Cow Care", rating: 4.9, reviews: 980, stock: 26, artType: "ghee_batti", artAccent: "#FBBF24", badge: "Time Saver", fbtId: 53, description: "Pre-soaked pure Desi Cow Ghee cotton wicks with natural camphor & sandalwood essence. Just place in your diya and light — zero messy pouring.", highlights: ["Made with 100% pure cow ghee (zero wax)", "30-minute steady sacred flame", "Zero-mess daily morning & evening aarti"], specs: { Count: "100 Ready-to-Light Battis", BurnTime: "~30 Mins Each", Box: "Hygienic Resealable Tub" } },
    { id: 65, title: "Pure Rose Water + Vegetable Glycerin Hydrating Glow Mist (200ml)", price: 349, category: "Ayurveda & Cow Care", rating: 4.8, reviews: 615, stock: 18, artType: "rose_glycerin", artAccent: "#F43F5E", badge: "Skin Glow", fbtId: 59, description: "Steam-distilled Kannauj Gulab Jal perfectly balanced with 10% USP Vegetable Glycerin for instant glass-skin hydration, makeup setting, and dry-patch relief.", highlights: ["Steam-distilled Kannauj Rose Water", "Balanced with pure Veg Glycerin", "Fine mist spray for instant dewy glow"], specs: { Volume: "200 ml Fine-Mist Spray", Ingredients: "Rosa Damascena + USP Glycerin", Alcohol: "0% Alcohol-Free" } },
    { id: 66, title: "Vedic Desi Cow Dung Havan Cakes (Gobar Upla, 12 Pc)", price: 249, category: "Ayurveda & Cow Care", rating: 4.9, reviews: 420, stock: 20, artType: "cow_upla", artAccent: "#92400E", badge: "Agnihotra Pure", fbtId: 54, description: "Sun-dried, hygienically hand-pressed Desi Cow Dung cakes from ethical Indian Gaushalas. Perfect for Agnihotra, Griha Pravesh, and festive Havan.", highlights: ["100% pure sun-dried Desi Cow dung", "Even, clean burn for daily Agnihotra", "Moisture-proof clean packaging"], specs: { Count: "12 Round Cakes (10cm)", Source: "Ethical Desi Gaushala", Use: "Havan, Agnihotra & Puja" } }
];

function getMergedCatalog() {
    const customList = db.list('products', 500);
    const customMap = new Map();
    customList.forEach(p => customMap.set(Number(p.id), p));
    const merged = DEFAULT_PRODUCTS.map(base => {
        const override = customMap.get(base.id);
        if (override) {
            customMap.delete(base.id);
            return Object.assign({}, base, override);
        }
        return base;
    });
    customMap.forEach(extra => merged.push(extra));
    return merged;
}

// ============================================================================
// 3. REST API ROUTES (PHONE-LAST-4 TRACKING, SCREENSHOT PROOF, SUPPORT TICKETS)
// ============================================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        version: '8.1.0',
        uptimeSeconds: Math.floor(process.uptime()),
        storage: db.getStorageStats()
    });
});

app.get('/api/settings', (req, res) => {
    res.json({ success: true, settings: getLiveSettings() });
});

app.get('/api/products', (req, res) => {
    res.json({ success: true, products: getMergedCatalog(), settings: getLiveSettings() });
});

// Customer Cloud Sync (Addresses + Landmarks + Gate Photos + Cart + Wishlist + SuperCoins)
app.post('/api/customer/sync', (req, res) => {
    const { phone, name, addresses, wishlist, cart, superCoins } = req.body || {};
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (cleanPhone.length < 10) return res.status(400).json({ success: false, message: 'Valid 10-digit phone required' });
    const existing = db.get('customers', cleanPhone) || {
        phone: cleanPhone, createdAt: new Date().toISOString(), totalOrders: 0, totalSpent: 0, superCoins: 50
    };
    const updated = Object.assign({}, existing, {
        phone: cleanPhone,
        phoneLast4: cleanPhone.slice(-4),
        name: name || existing.name || '',
        addresses: Array.isArray(addresses) ? addresses.slice(0, 12) : (existing.addresses || []),
        wishlist: Array.isArray(wishlist) ? wishlist.slice(0, 60) : (existing.wishlist || []),
        cart: Array.isArray(cart) ? cart.slice(0, 40) : (existing.cart || []),
        superCoins: typeof superCoins === 'number' ? Math.max(0, Math.floor(superCoins)) : existing.superCoins,
        updatedAt: new Date().toISOString()
    });
    db.put('customers', cleanPhone, updated);
    res.json({ success: true, customer: updated });
});

app.get('/api/customer/:phone', (req, res) => {
    const cleanPhone = String(req.params.phone || '').replace(/[^0-9]/g, '').slice(-10);
    let customer = db.get('customers', cleanPhone);
    if (!customer && cleanPhone.length === 4) {
        const matches = db.list('customers', 5, c => (c.phone || '').slice(-4) === cleanPhone);
        customer = matches[0] || null;
    }
    if (!customer) return res.status(404).json({ found: false });
    res.json({ found: true, customer: customer });
});

// Product Reviews (Now supports customer review photos stored in 8GB DB!)
app.get('/api/reviews/:productId', (req, res) => {
    const pid = Number(req.params.productId);
    res.json({ success: true, reviews: db.list('reviews', 50, r => Number(r.productId) === pid) });
});

app.post('/api/reviews', (req, res) => {
    const { productId, author, rating, comment, city, photo } = req.body || {};
    if (!productId || !author || !comment) return res.status(400).json({ success: false, message: 'Name and review required' });
    const rev = {
        id: 'REV-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        productId: Number(productId),
        author: String(author).slice(0, 40),
        city: String(city || 'India').slice(0, 30),
        rating: Math.min(5, Math.max(1, Number(rating) || 5)),
        comment: String(comment).slice(0, 500),
        photo: (photo && String(photo).startsWith('data:image/')) ? String(photo).slice(0, 220000) : '',
        verified: true,
        date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    };
    db.put('reviews', rev.id, rev);
    res.json({ success: true, review: rev });
});

// PLACE ORDER API (Order ID uses Phone Last 4 + Payment Screenshot OR Short Ref)
app.post('/api/place-order', (req, res) => {
    const {
        customer, cart, subtotal, discount, volumeDiscount,
        coinsRedeemed, orderBump, freeGiftAdded, total,
        paymentProofPhoto, paymentRefShort, paymentApp, paymentInitiatedAt, estimatedDelivery
    } = req.body || {};

    if (!customer || !customer.name || !customer.phone || !customer.address) {
        return res.status(400).json({ success: false, message: 'Complete name, mobile number, and address are required.' });
    }
    if (!Array.isArray(cart) || cart.length === 0) {
        return res.status(400).json({ success: false, message: 'Cart cannot be empty.' });
    }
    const cleanPhone = String(customer.phone).replace(/[^0-9]/g, '').slice(-10);
    if (cleanPhone.length < 10) {
        return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit mobile number.' });
    }
    const phoneLast4 = cleanPhone.slice(-4);
    const hasPhoto = Boolean(paymentProofPhoto && String(paymentProofPhoto).startsWith('data:image/'));
    const cleanRef = String(paymentRefShort || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!paymentApp) {
        return res.status(400).json({ success: false, message: 'Please select and pay via PhonePe, Google Pay, or Navi first.' });
    }
    if (!hasPhoto && cleanRef.length < 4) {
        return res.status(400).json({ success: false, message: 'Please upload your Payment Screenshot OR enter the last 4 digits of your payment reference.' });
    }

    // Generate memorable Order ID anchored to customer's last 4 phone digits (e.g., PREM-4915-01)
    const prevOrdersForLast4 = db.list('orders', 50, o => o.phoneLast4 === phoneLast4);
    const seqNum = String(prevOrdersForLast4.length + 1).padStart(2, '0');
    const finalOrderId = 'PREM-' + phoneLast4 + '-' + seqNum;

    const nowIso = new Date().toISOString();
    const nowDisplay = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const coinsEarned = Math.max(10, Math.round((Number(total) || 0) * 0.05));

    const newOrder = {
        orderId: finalOrderId,
        phoneLast4: phoneLast4,
        customerPhone: cleanPhone,
        createdAt: nowIso,
        dateDisplay: nowDisplay,
        customer: customer,
        cart: cart,
        financials: {
            subtotal: Number(subtotal) || 0,
            discount: Number(discount) || 0,
            volumeDiscount: Number(volumeDiscount) || 0,
            coinsRedeemed: Number(coinsRedeemed) || 0,
            orderBumpAdded: Boolean(orderBump),
            freeGiftAdded: Boolean(freeGiftAdded),
            total: Number(total) || 0,
            coinsEarned: coinsEarned
        },
        payment: {
            app: String(paymentApp),
            refShort: cleanRef || 'SCREENSHOT',
            proofPhoto: hasPhoto ? String(paymentProofPhoto).slice(0, 350000) : '',
            initiatedAt: paymentInitiatedAt || nowIso,
            verified: false
        },
        utr: cleanRef || 'Screenshot Attached',
        estimatedDelivery: estimatedDelivery || '4-6 Business Days',
        status: 'Payment Verification',
        stage: 2,
        courierPartner: '',
        awbNumber: '',
        courierInfo: '',
        timeline: [
            { stage: 1, title: 'Order Placed & Stock Reserved', time: nowDisplay, note: 'Track anytime using your last 4 phone digits: ' + phoneLast4 },
            { stage: 2, title: 'Payment Proof Received (' + paymentApp + ')', time: nowDisplay, note: hasPhoto ? 'Payment screenshot saved to secure vault for fast approval' : ('Payment Ref #' + cleanRef + ' queued for quick verification') }
        ]
    };

    db.put('orders', finalOrderId, newOrder);

    // Sync Customer CRM record with landmark & address photo
    const cust = db.get('customers', cleanPhone) || {
        phone: cleanPhone, phoneLast4: phoneLast4, name: customer.name, addresses: [], wishlist: [], cart: [], superCoins: 50, totalOrders: 0, totalSpent: 0, createdAt: nowIso
    };
    cust.name = customer.name;
    cust.phoneLast4 = phoneLast4;
    cust.totalOrders = (cust.totalOrders || 0) + 1;
    cust.totalSpent = (cust.totalSpent || 0) + (Number(total) || 0);
    cust.superCoins = Math.max(0, (cust.superCoins || 50) - (Number(coinsRedeemed) || 0) + coinsEarned);
    cust.lastOrderId = finalOrderId;
    cust.updatedAt = nowIso;
    db.put('customers', cleanPhone, cust);

    console.log('[ORDER] ' + finalOrderId + ' (Last4: ' + phoneLast4 + ') | ' + customer.name + ' | ₹' + total + ' | ' + paymentApp);
    res.status(200).json({ success: true, order: newOrder });
});

// IMPROVED TRACKING API: Track by LAST 4 DIGITS OF PHONE (or full phone / Order ID)
app.get('/api/track/:query', (req, res) => {
    const raw = String(req.params.query || '').trim().toUpperCase();
    const digitsOnly = raw.replace(/[^0-9]/g, '');

    // 1. Exact Order ID match
    const exact = db.get('orders', raw);
    if (exact) {
        return res.status(200).json({ found: true, order: exact, orders: [exact] });
    }

    // 2. Last 4 digits of phone number (Primary Fast-Track Lookup!)
    if (digitsOnly.length === 4) {
        const matches = db.list('orders', 20, o => {
            const oPhone = String(o.customerPhone || (o.customer && o.customer.phone) || '').replace(/[^0-9]/g, '');
            return o.phoneLast4 === digitsOnly || oPhone.slice(-4) === digitsOnly;
        });
        if (matches.length > 0) {
            return res.status(200).json({ found: true, order: matches[0], orders: matches });
        }
    }

    // 3. Full 10-digit phone lookup
    if (digitsOnly.length >= 10) {
        const last10 = digitsOnly.slice(-10);
        const matches = db.list('orders', 20, o => {
            const oPhone = String(o.customerPhone || (o.customer && o.customer.phone) || '').replace(/[^0-9]/g, '').slice(-10);
            return oPhone === last10;
        });
        if (matches.length > 0) {
            return res.status(200).json({ found: true, order: matches[0], orders: matches });
        }
    }

    return res.status(404).json({ found: false, message: 'No orders found for "' + raw + '". Try the last 4 digits of your mobile number.' });
});

app.post('/api/track/cancel', (req, res) => {
    const { orderId, reason } = req.body || {};
    const searchId = String(orderId || '').trim().toUpperCase();
    const order = db.get('orders', searchId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.stage >= 4) return res.status(400).json({ success: false, message: 'Already shipped and cannot be canceled online.' });
    const nowDisplay = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    order.status = 'Canceled by Customer';
    order.stage = 0;
    order.timeline = order.timeline || [];
    order.timeline.push({ stage: 0, title: 'Order Canceled', time: nowDisplay, note: reason || 'Customer requested cancellation before dispatch' });
    db.put('orders', searchId, order);
    res.json({ success: true, order: order });
});

// USP #2 API: ZERO-WAIT INSTANT REPLACEMENT / SUPPORT TICKET (WITH PHOTO IN 8GB DB)
app.post('/api/support/ticket', (req, res) => {
    const { orderId, phoneLast4, reason, details, photo } = req.body || {};
    if (!orderId || !reason) return res.status(400).json({ success: false, message: 'Order ID and reason required.' });
    const ticketId = 'RPL-' + String(phoneLast4 || '0000') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const ticket = {
        ticketId: ticketId,
        orderId: String(orderId).toUpperCase(),
        phoneLast4: String(phoneLast4 || ''),
        reason: String(reason).slice(0, 120),
        details: String(details || '').slice(0, 500),
        photo: (photo && String(photo).startsWith('data:image/')) ? String(photo).slice(0, 300000) : '',
        status: 'Priority Open',
        createdAt: new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    };
    db.put('tickets', ticketId, ticket);
    res.json({ success: true, ticket: ticket });
});

// MERCHANT ADMIN APIS (PIN PROTECTED)
function verifyPin(req, res, next) {
    const pin = (req.headers['x-merchant-pin'] || (req.body && req.body.pin) || req.query.pin || '').trim();
    if (pin !== MERCHANT_PIN) return res.status(403).json({ success: false, message: 'Invalid Merchant PIN' });
    next();
}

app.get('/api/admin/dashboard', verifyPin, (req, res) => {
    const orders = db.list('orders', 500);
    const tickets = db.list('tickets', 100);
    const todayStr = new Date().toISOString().slice(0, 10);
    let totalRevenue = 0, todayOrders = 0, pendingCount = 0;

    orders.forEach(o => {
        const amt = (o.financials && o.financials.total) ? Number(o.financials.total) : (Number(o.total) || 0);
        if (o.stage !== 0) totalRevenue += amt;
        if (o.createdAt && o.createdAt.slice(0, 10) === todayStr) todayOrders++;
        if (o.stage === 2) pendingCount++;
    });

    const activeCount = orders.filter(o => o.stage !== 0).length;
    res.json({
        success: true,
        kpis: {
            totalRevenue: totalRevenue,
            totalOrders: orders.length,
            todayOrders: todayOrders,
            pendingCount: pendingCount,
            openTickets: tickets.length,
            aov: activeCount > 0 ? Math.round(totalRevenue / activeCount) : 0
        },
        storage: db.getStorageStats(),
        settings: getLiveSettings(),
        orders: orders,
        tickets: tickets
    });
});

app.post('/api/admin/settings', verifyPin, (req, res) => {
    const body = req.body || {};
    const current = getLiveSettings();
    const updated = {
        storeName: String(body.storeName || current.storeName).trim(),
        upiId: String(body.upiId || current.upiId).trim(),
        payeeName: String(body.payeeName || current.payeeName).trim(),
        whatsapp: String(body.whatsapp || current.whatsapp).replace(/[^0-9]/g, ''),
        promoCode: String(body.promoCode || current.promoCode).trim().toUpperCase(),
        promoPercent: Math.min(50, Math.max(0, Number(body.promoPercent !== undefined ? body.promoPercent : current.promoPercent))),
        freeShipThreshold: Math.max(0, Number(body.freeShipThreshold !== undefined ? body.freeShipThreshold : current.freeShipThreshold)),
        freeGiftThreshold: Math.max(0, Number(body.freeGiftThreshold !== undefined ? body.freeGiftThreshold : current.freeGiftThreshold)),
        deliveryMinDays: current.deliveryMinDays,
        deliveryMaxDays: current.deliveryMaxDays
    };
    db.put('settings', 'store_config', updated);
    res.json({ success: true, settings: updated });
});

app.post('/api/admin/update-order', verifyPin, (req, res) => {
    const { orderId, status, stage, courierPartner, awbNumber, courierInfo, note } = req.body || {};
    const searchId = String(orderId || '').trim().toUpperCase();
    const order = db.get('orders', searchId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const nowDisplay = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (status) order.status = status;
    if (stage !== undefined) order.stage = Number(stage);
    if (courierPartner !== undefined) order.courierPartner = courierPartner;
    if (awbNumber !== undefined) order.awbNumber = awbNumber;
    if (courierInfo !== undefined) order.courierInfo = courierInfo;
    if (Number(stage) >= 3 && order.payment) order.payment.verified = true;

    order.timeline = order.timeline || [];
    order.timeline.push({
        stage: order.stage,
        title: order.status,
        time: nowDisplay,
        note: note || (awbNumber ? ('Dispatched via ' + (courierPartner || 'Courier') + ' (AWB: ' + awbNumber + ')') : 'Updated by Fulfillment Desk')
    });

    db.put('orders', searchId, order);
    res.json({ success: true, order: order });
});

app.post('/api/admin/product', verifyPin, (req, res) => {
    const prod = req.body || {};
    if (!prod.title || !prod.price) return res.status(400).json({ success: false, message: 'Title and price required' });
    const catalog = getMergedCatalog();
    const id = prod.id ? Number(prod.id) : (Math.max.apply(null, [66].concat(catalog.map(p => Number(p.id) || 0))) + 1);
    const existing = catalog.find(p => Number(p.id) === id) || {};
    const saved = Object.assign({
        id: id, category: 'Gear', rating: 4.8, reviews: 45, stock: 15, artType: 'generic_box', artAccent: '#FF3366', badge: 'New Arrival',
        highlights: ['Quality Checked Dispatch', '7-Day Easy Replacement', 'Direct UPI Verified'],
        specs: { Warranty: 'Replacement Guarantee', Dispatch: '24 Hours' }
    }, existing, {
        id: id,
        title: String(prod.title).trim(),
        price: Math.max(1, Number(prod.price)),
        stock: Math.max(0, Number(prod.stock !== undefined ? prod.stock : (existing.stock || 10))),
        category: prod.category || existing.category || 'Gear',
        description: prod.description || existing.description || 'Premium quality utility product.',
        customImage: prod.customImage !== undefined ? String(prod.customImage).trim() : (existing.customImage || '')
    });
    db.put('products', String(id), saved);
    res.json({ success: true, product: saved });
});

app.get('/api/admin/customers', verifyPin, (req, res) => {
    res.json({ success: true, customers: db.list('customers', 300) });
});

app.get('/api/admin/export-csv', verifyPin, (req, res) => {
    const orders = db.list('orders', 5000);
    const esc = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const header = ['OrderID', 'PhoneLast4', 'Date', 'Customer', 'Phone', 'Address', 'Landmark', 'Items', 'Total', 'PaymentApp', 'ProofRef', 'Status', 'Courier', 'AWB'].join(',');
    const rows = orders.map(o => {
        const items = (o.cart || []).map(i => i.qty + 'x ' + i.title).join('; ');
        return [
            o.orderId, o.phoneLast4 || '', o.dateDisplay || o.createdAt, o.customer ? o.customer.name : '', o.customer ? o.customer.phone : '',
            o.customer ? o.customer.address : '', o.customer ? (o.customer.landmark || '') : '', items,
            o.financials ? o.financials.total : o.total, o.payment ? o.payment.app : '', o.utr || '', o.status, o.courierPartner || '', o.awbNumber || ''
        ].map(esc).join(',');
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="prems_store_orders.csv"');
    res.send([header].concat(rows).join('\n'));
});

const frontendHTML = [
    "<!DOCTYPE html>",
    "<html lang=\"en\" class=\"dark\">",
    "<head>",
    "    <meta charset=\"UTF-8\">",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">",
    "    <title>Prem's Store | Smart Utility, Spiritual Puja & Vedic Cow Care</title>",
    "    <meta name=\"description\" content=\"Shop viral utility gadgets, clinical beauty tools, lab-certified Nepali Rudraksha, pure Brass Puja items, USP Vegetable Glycerin & Bilona A2 Gir Cow Ghee. Seamless PhonePe, GPay & Navi UPI Checkout.\">",
    "    <script src=\"https://cdn.tailwindcss.com\"></script>",
    "    <link href=\"https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap\" rel=\"stylesheet\">",
    "    <link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css\">",
    "    <script>",
    "        tailwind.config = {",
    "            darkMode: 'class',",
    "            theme: {",
    "                extend: {",
    "                    colors: {",
    "                        brandPrimary: '#FF3366',",
    "                        brandGold: '#F59E0B',",
    "                        whatsapp: '#25D366',",
    "                        darkBg: '#09090b',",
    "                        darkSurface: '#121216',",
    "                        darkElevated: '#18181f',",
    "                        darkBorder: '#272732'",
    "                    },",
    "                    fontFamily: { sans: ['Outfit', 'sans-serif'] }",
    "                }",
    "            }",
    "        }",
    "    </script>",
    "    <style>",
    "        html { scroll-behavior: smooth; }",
    "        body { background-color: #09090b; color: #f8fafc; overflow-x: hidden; padding-bottom: 72px; }",
    "        @media (min-width: 768px) { body { padding-bottom: 0; } }",
    "        ::-webkit-scrollbar { width: 6px; height: 6px; }",
    "        ::-webkit-scrollbar-track { background: #09090b; }",
    "        ::-webkit-scrollbar-thumb { background: #FF3366; border-radius: 10px; }",
    "        .glass { background: rgba(18, 18, 22, 0.93); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08); }",
    "        .btn-glow { box-shadow: 0 0 22px rgba(255, 51, 102, 0.42); transition: all 0.22s ease; }",
    "        .btn-glow:hover:not(:disabled) { box-shadow: 0 0 32px rgba(255, 51, 102, 0.72); transform: translateY(-1px); }",
    "        .btn-glow-whatsapp { box-shadow: 0 0 22px rgba(37, 211, 102, 0.36); transition: all 0.22s ease; }",
    "        .btn-glow-whatsapp:hover:not(:disabled) { box-shadow: 0 0 32px rgba(37, 211, 102, 0.65); transform: translateY(-1px); }",
    "        .hide-scrollbar::-webkit-scrollbar { display: none; }",
    "        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }",
    "        @keyframes slideIn { from { transform: translateX(-110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }",
    "        .live-popup { animation: slideIn 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }",
    "        @keyframes pulseBeacon { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }",
    "        .live-beacon { animation: pulseBeacon 1.8s infinite; }",
    "    </style>",
    "</head>",
    "<body class=\"font-sans min-h-screen flex flex-col relative selection:bg-brandPrimary selection:text-white\">",
    "",
    "    <!-- TOP RECIPROCITY & AUTO-SAVINGS BAR -->",
    "    <div class=\"bg-gradient-to-r from-brandPrimary via-rose-600 to-amber-600 text-white text-[11px] md:text-xs font-bold py-2 px-3 text-center flex flex-wrap items-center justify-center gap-2 z-50\">",
    "        <span>🎁 WELCOME GIFT: <strong>50 Free SuperCoins (₹50)</strong> + <strong>Auto Best-Deal Engine</strong> active! Code <strong id=\"promo-bar-code\" class=\"underline cursor-pointer bg-black/25 px-1.5 py-0.5 rounded\" onclick=\"applyQuickCoupon(STORE_CONFIG.promoCode)\">PREM10</strong></span>",
    "        <button onclick=\"openKitBuilderModal()\" class=\"bg-black/35 hover:bg-black/55 text-amber-200 px-2.5 py-0.5 rounded-full text-[10px] font-black border border-amber-300/30\">✨ Build 15% Off Custom Kit</button>",
    "        <button onclick=\"openSmartFinderModal()\" class=\"bg-white/20 hover:bg-white/30 text-white px-2.5 py-0.5 rounded-full text-[10px] font-black border border-white/30\">🤖 10-Sec Product Finder</button>",
    "    </div>",
    "",
    "    <!-- TOAST NOTIFICATION -->",
    "    <div id=\"toast-box\" class=\"fixed top-16 right-4 z-[120] hidden bg-white text-black px-4 py-3 rounded-xl shadow-2xl border-l-4 border-brandPrimary text-xs font-bold flex items-center space-x-2 max-w-xs\">",
    "        <i class=\"fa-solid fa-circle-check text-brandPrimary text-base shrink-0\"></i>",
    "        <span id=\"toast-text\">Action completed</span>",
    "    </div>",
    "",
    "    <!-- SOCIAL PROOF POPUP -->",
    "    <div id=\"social-proof-popup\" class=\"fixed bottom-20 md:bottom-5 left-4 z-40 glass p-3 rounded-xl shadow-2xl flex items-center space-x-3 hidden max-w-xs border-l-4 border-l-brandPrimary pointer-events-none\">",
    "        <img id=\"sp-img\" src=\"\" alt=\"Product\" class=\"w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0 bg-black\">",
    "        <div class=\"overflow-hidden\">",
    "            <p class=\"text-[11px] text-slate-300 truncate\"><span id=\"sp-name\" class=\"font-bold text-white\"></span> in <span id=\"sp-city\" class=\"text-white font-semibold\"></span> bought</p>",
    "            <p id=\"sp-product\" class=\"text-xs font-extrabold text-brandPrimary truncate\"></p>",
    "            <p class=\"text-[10px] text-emerald-400 mt-0.5 flex items-center\"><i class=\"fa-solid fa-shield-check mr-1\"></i>Verified UPI Buyer • <span id=\"sp-app\" class=\"ml-1\">PhonePe</span></p>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- STICKY HEADER -->",
    "    <header class=\"sticky top-0 z-40 glass border-b border-white/10 shadow-xl\">",
    "        <div class=\"container mx-auto px-3 sm:px-4 py-3 flex flex-wrap justify-between items-center gap-2.5 max-w-7xl\">",
    "            <div class=\"flex items-center space-x-3\">",
    "                <a href=\"#\" onclick=\"setCategoryFilter('All'); return false;\" class=\"text-xl sm:text-2xl font-black tracking-tighter text-white flex items-center\">",
    "                    <span>PREM<span class=\"text-brandPrimary\">STORE</span></span>",
    "                    <span class=\"ml-2 text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest hidden sm:inline-block\">v8 Pro</span>",
    "                </a>",
    "                <button onclick=\"openAddressBookModal()\" class=\"hidden lg:flex items-center space-x-2 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-xl text-left transition-colors\">",
    "                    <i class=\"fa-solid fa-location-dot text-brandPrimary text-xs\"></i>",
    "                    <div class=\"leading-tight\">",
    "                        <span class=\"text-[9px] text-slate-400 block\">Deliver to (Saved Landmark)</span>",
    "                        <span id=\"header-deliver-to\" class=\"text-[11px] font-bold text-white max-w-[155px] truncate block\">Select Address</span>",
    "                    </div>",
    "                </button>",
    "            </div>",
    "",
    "            <div class=\"relative flex-grow max-w-lg order-3 md:order-2 w-full md:w-auto\">",
    "                <i class=\"fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs\"></i>",
    "                <input type=\"text\" id=\"search-input\" oninput=\"filterAndRenderCatalog()\" placeholder=\"Search Rudraksha, Gir Cow Ghee, Glycerin, LED Mask...\" class=\"w-full pl-9 pr-8 py-2.5 bg-darkSurface border border-darkBorder rounded-full text-xs text-white placeholder-slate-500 outline-none focus:border-brandPrimary transition-colors\">",
    "                <button onclick=\"clearSearch()\" id=\"clear-search-btn\" class=\"hidden absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            </div>",
    "",
    "            <div class=\"flex items-center space-x-1.5 sm:space-x-2 order-2 md:order-3\">",
    "                <button onclick=\"openWalletInfo()\" title=\"SuperCoins Loyalty Wallet\" class=\"hidden sm:flex items-center space-x-1.5 text-xs font-bold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 rounded-full border border-amber-500/30\">",
    "                    <i class=\"fa-solid fa-coins text-amber-400\"></i>",
    "                    <span id=\"header-coins\">50</span>",
    "                </button>",
    "                <button onclick=\"openWishlistModal()\" title=\"Wishlist\" class=\"relative flex items-center justify-center w-9 h-9 bg-white/5 hover:bg-white/10 rounded-full border border-white/10 text-slate-200 hover:text-brandPrimary transition-colors\">",
    "                    <i class=\"fa-regular fa-heart text-sm\"></i>",
    "                    <span id=\"wishlist-count\" class=\"hidden absolute -top-1 -right-1 bg-brandPrimary text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-black\">0</span>",
    "                </button>",
    "                <button onclick=\"openTrackModal()\" class=\"flex items-center space-x-1.5 text-xs font-bold text-white bg-emerald-500/15 hover:bg-emerald-500/25 px-3 py-2 rounded-full border border-emerald-500/35\">",
    "                    <i class=\"fa-solid fa-satellite-dish text-emerald-400\"></i>",
    "                    <span class=\"hidden sm:inline\">Track (Last 4)</span>",
    "                </button>",
    "                <button onclick=\"toggleCart()\" class=\"relative flex items-center space-x-2 bg-brandPrimary/15 hover:bg-brandPrimary/25 px-3.5 py-2 rounded-full transition-all border border-brandPrimary/40\">",
    "                    <i class=\"fa-solid fa-bag-shopping text-brandPrimary\"></i>",
    "                    <span class=\"text-xs font-bold text-white hidden sm:inline\">Cart</span>",
    "                    <span id=\"cart-count\" class=\"bg-brandPrimary text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-black shadow\">0</span>",
    "                </button>",
    "            </div>",
    "        </div>",
    "    </header>",
    "",
    "    <!-- MAIN CONTENT -->",
    "    <main class=\"container mx-auto px-3 sm:px-4 py-6 flex-grow max-w-7xl\">",
    "        <!-- HERO + QUICK SEARCH CHIPS -->",
    "        <section class=\"relative overflow-hidden rounded-3xl bg-gradient-to-br from-darkElevated via-darkSurface to-black border border-white/10 p-5 sm:p-8 mb-6 shadow-2xl\">",
    "            <div class=\"grid md:grid-cols-12 gap-6 items-center\">",
    "                <div class=\"md:col-span-7\">",
    "                    <div class=\"inline-flex items-center space-x-2 bg-brandPrimary/15 text-brandPrimary border border-brandPrimary/30 px-3 py-1 rounded-full text-[11px] font-bold mb-3 uppercase tracking-wider\">",
    "                        <i class=\"fa-solid fa-bolt\"></i>",
    "                        <span>PhonePe • GPay • Navi • Track by Last 4 Phone Digits</span>",
    "                    </div>",
    "                    <h1 class=\"text-2xl sm:text-4xl lg:text-5xl font-black text-white mb-3 tracking-tight leading-tight\">",
    "                        Smart Utility, Sacred Puja &amp; Pure Vedic Care.",
    "                    </h1>",
    "                    <p class=\"text-slate-300 text-xs sm:text-sm max-w-2xl leading-relaxed mb-4\">",
    "                        66 hand-picked essentials with 1-tap UPI checkout, 1-tap payment screenshot proof (no long UTR hunting!), instant last-4-digit live order tracking, and saved landmark + gate photo delivery profiles.",
    "                    </p>",
    "                    <!-- Quick Search Chips (Convenience) -->",
    "                    <div class=\"flex flex-wrap gap-1.5 mb-4\">",
    "                        <button onclick=\"quickSearchTag('Rudraksha')\" class=\"bg-white/5 hover:bg-amber-500/20 text-amber-200 border border-white/10 px-2.5 py-1 rounded-full text-[11px] font-bold\">🕉️ Rudraksha</button>",
    "                        <button onclick=\"quickSearchTag('Cow Ghee')\" class=\"bg-white/5 hover:bg-amber-500/20 text-amber-200 border border-white/10 px-2.5 py-1 rounded-full text-[11px] font-bold\">🍯 A2 Cow Ghee</button>",
    "                        <button onclick=\"quickSearchTag('Glycerin')\" class=\"bg-white/5 hover:bg-sky-500/20 text-sky-200 border border-white/10 px-2.5 py-1 rounded-full text-[11px] font-bold\">💧 USP Glycerin</button>",
    "                        <button onclick=\"quickSearchTag('LED')\" class=\"bg-white/5 hover:bg-pink-500/20 text-pink-200 border border-white/10 px-2.5 py-1 rounded-full text-[11px] font-bold\">✨ LED Beauty</button>",
    "                        <button onclick=\"quickSearchTag('Rain')\" class=\"bg-white/5 hover:bg-indigo-500/20 text-indigo-200 border border-white/10 px-2.5 py-1 rounded-full text-[11px] font-bold\">☔ Monsoon Gear</button>",
    "                    </div>",
    "                    <div class=\"flex flex-wrap gap-2 text-[11px] font-bold\">",
    "                        <button onclick=\"openSmartFinderModal()\" class=\"bg-gradient-to-r from-brandPrimary to-amber-500 text-white px-3.5 py-1.5 rounded-xl font-black shadow hover:opacity-95 transition-opacity\"><i class=\"fa-solid fa-wand-magic-sparkles mr-1.5\"></i>Not Sure? 10-Sec AI Matchmaker</button>",
    "                        <span class=\"bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1.5 rounded-xl\"><i class=\"fa-solid fa-shield-check mr-1.5\"></i>Zero-Wait Replacement</span>",
    "                        <span class=\"bg-blue-500/10 text-blue-300 border border-blue-500/20 px-3 py-1.5 rounded-xl\"><i class=\"fa-solid fa-truck-fast mr-1.5\"></i>Est. Delivery: <strong id=\"hero-delivery-date\" class=\"text-white\">Calculating...</strong></span>",
    "                    </div>",
    "                </div>",
    "",
    "                <!-- TWO NOTICEABLE USP FEATURE CARDS -->",
    "                <div class=\"md:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-3\">",
    "                    <!-- USP #1: 1-Click Routine & Kit Builder -->",
    "                    <button onclick=\"openKitBuilderModal()\" class=\"bg-gradient-to-br from-brandPrimary/25 via-rose-900/20 to-black hover:border-brandPrimary border border-brandPrimary/40 p-4 rounded-2xl text-left transition-all shadow-lg group\">",
    "                        <div class=\"flex items-center justify-between mb-1.5\">",
    "                            <span class=\"text-xl\">🎁</span>",
    "                            <span class=\"text-[9px] bg-brandPrimary text-white font-black px-2 py-0.5 rounded-full uppercase\">USP • Save 15%</span>",
    "                        </div>",
    "                        <span class=\"text-sm font-black text-white block group-hover:text-brandPrimary\">Smart Kit Builder</span>",
    "                        <span class=\"text-[11px] text-slate-300 block mt-1\">1-tap Mandir, Cow Care, Beauty &amp; Monsoon bundles with instant 15% OFF.</span>",
    "                    </button>",
    "",
    "                    <!-- USP #2: Zero-Wait Replacement & Phone-Last-4 Live Tracker -->",
    "                    <button onclick=\"openTrackModal()\" class=\"bg-gradient-to-br from-emerald-500/20 via-teal-900/20 to-black hover:border-emerald-400 border border-emerald-500/35 p-4 rounded-2xl text-left transition-all shadow-lg group\">",
    "                        <div class=\"flex items-center justify-between mb-1.5\">",
    "                            <span class=\"text-xl\">📡</span>",
    "                            <span class=\"text-[9px] bg-emerald-500 text-black font-black px-2 py-0.5 rounded-full uppercase\">USP • 4-Digit Track</span>",
    "                        </div>",
    "                        <span class=\"text-sm font-black text-white block group-hover:text-emerald-300\">Instant 4-Digit Tracker</span>",
    "                        <span class=\"text-[11px] text-slate-300 block mt-1\">Track live with just your last 4 phone digits + 1-tap photo replacement.</span>",
    "                    </button>",
    "",
    "                    <!-- Saved Landmarks & Gate Photos -->",
    "                    <button onclick=\"openAddressBookModal()\" class=\"bg-gradient-to-br from-indigo-500/20 to-black hover:border-indigo-400 border border-indigo-500/30 p-3.5 rounded-2xl text-left transition-all\">",
    "                        <span class=\"text-xs font-black text-indigo-300 block\"><i class=\"fa-solid fa-map-pin mr-1.5\"></i>Address + Gate Photo</span>",
    "                        <span id=\"hero-addr-count\" class=\"text-[10px] text-slate-400 block mt-0.5\">Save landmarks &amp; door photos</span>",
    "                    </button>",
    "",
    "                    <!-- Restore Profile by Phone -->",
    "                    <button onclick=\"openRestoreProfileModal()\" class=\"bg-gradient-to-br from-amber-500/20 to-black hover:border-amber-400 border border-amber-500/30 p-3.5 rounded-2xl text-left transition-all\">",
    "                        <span class=\"text-xs font-black text-amber-300 block\"><i class=\"fa-solid fa-cloud-arrow-down mr-1.5\"></i>Restore My Account</span>",
    "                        <span class=\"text-[10px] text-slate-400 block mt-0.5\">Sync cart &amp; addresses by phone</span>",
    "                    </button>",
    "                </div>",
    "            </div>",
    "        </section>",
    "",
    "        <!-- RECENTLY VIEWED -->",
    "        <section id=\"recently-viewed-section\" class=\"hidden mb-7\">",
    "            <div class=\"flex items-center justify-between mb-3\">",
    "                <h2 class=\"text-sm font-black text-white flex items-center\"><i class=\"fa-solid fa-clock-rotate-left text-brandPrimary mr-2\"></i>Recently Viewed &amp; Quick Reorder</h2>",
    "                <button onclick=\"clearRecentlyViewed()\" class=\"text-[11px] text-slate-400 hover:text-white\">Clear</button>",
    "            </div>",
    "            <div id=\"recently-viewed-list\" class=\"flex space-x-3 overflow-x-auto hide-scrollbar pb-1\"></div>",
    "        </section>",
    "",
    "        <!-- FILTER & SORT BAR -->",
    "        <div class=\"flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 mb-6 pb-3 border-b border-white/10\">",
    "            <div class=\"flex items-center space-x-2 overflow-x-auto hide-scrollbar py-1\">",
    "                <button data-cat=\"All\" onclick=\"setCategoryFilter('All')\" class=\"cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold transition-all whitespace-nowrap\">All Products (66)</button>",
    "                <button data-cat=\"Spiritual & Puja\" onclick=\"setCategoryFilter('Spiritual & Puja')\" class=\"cat-btn bg-amber-500/15 text-amber-300 border border-amber-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-amber-500/25 transition-colors whitespace-nowrap\">🕉️ Spiritual &amp; Puja</button>",
    "                <button data-cat=\"Ayurveda & Cow Care\" onclick=\"setCategoryFilter('Ayurveda & Cow Care')\" class=\"cat-btn bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-emerald-500/25 transition-colors whitespace-nowrap\">🌿 Glycerin &amp; Cow Care</button>",
    "                <button data-cat=\"Beauty & Care\" onclick=\"setCategoryFilter('Beauty & Care')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">✨ Beauty &amp; Care</button>",
    "                <button data-cat=\"Home\" onclick=\"setCategoryFilter('Home')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">🏠 Home</button>",
    "                <button data-cat=\"Gear\" onclick=\"setCategoryFilter('Gear')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">⚡ Utility</button>",
    "                <button data-cat=\"Footwear\" onclick=\"setCategoryFilter('Footwear')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">👟 Footwear</button>",
    "                <button data-cat=\"Apparel\" onclick=\"setCategoryFilter('Apparel')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">🧥 Apparel</button>",
    "                <button data-cat=\"Vehicle\" onclick=\"setCategoryFilter('Vehicle')\" class=\"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\">🚗 Vehicle</button>",
    "            </div>",
    "",
    "            <div class=\"flex items-center justify-between md:justify-end space-x-2 shrink-0\">",
    "                <span id=\"results-counter\" class=\"text-xs text-slate-400 mr-2\">Showing 66 products</span>",
    "                <select id=\"sort-select\" onchange=\"filterAndRenderCatalog()\" class=\"bg-darkSurface border border-darkBorder text-white text-xs rounded-xl px-3 py-2 outline-none focus:border-brandPrimary\">",
    "                    <option value=\"featured\">Featured Winners</option>",
    "                    <option value=\"price-asc\">Price: Low to High</option>",
    "                    <option value=\"price-desc\">Price: High to Low</option>",
    "                    <option value=\"rating\">Highest Rated</option>",
    "                    <option value=\"reviews\">Most Reviewed</option>",
    "                </select>",
    "            </div>",
    "        </div>",
    "",
    "        <div id=\"product-grid\" class=\"grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5\"></div>",
    "    </main>",
    "",
    "    <!-- FLOATING COMPARE TRAY -->",
    "    <div id=\"compare-tray\" class=\"hidden fixed bottom-16 md:bottom-4 right-4 z-40 glass border border-brandPrimary/40 rounded-2xl p-3 shadow-2xl flex items-center space-x-3\">",
    "        <div class=\"text-xs\">",
    "            <span class=\"font-black text-white block\">Compare (<span id=\"compare-count\">0</span>/3)</span>",
    "            <span class=\"text-[10px] text-slate-400\">Side-by-side specs</span>",
    "        </div>",
    "        <button onclick=\"openCompareModal()\" class=\"bg-brandPrimary text-white text-xs font-bold px-3.5 py-2 rounded-xl\">Compare</button>",
    "        <button onclick=\"clearCompare()\" class=\"text-slate-400 hover:text-white text-xs\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "    </div>",
    "",
    "    <!-- FOOTER -->",
    "    <footer class=\"border-t border-white/10 bg-black/70 py-8 px-4 mt-14 text-xs text-slate-400\">",
    "        <div class=\"container mx-auto max-w-7xl flex flex-col sm:flex-row justify-between items-center gap-4\">",
    "            <div>",
    "                <span class=\"font-black text-white text-base\">PREM<span class=\"text-brandPrimary\">STORE</span></span>",
    "                <p class=\"mt-1 text-slate-500\">PhonePe / GPay / Navi UPI + Screenshot Proof • 4-Digit Phone Tracker • 8GB+ Storage</p>",
    "            </div>",
    "            <div class=\"flex flex-wrap items-center gap-4\">",
    "                <button onclick=\"openKitBuilderModal()\" class=\"hover:text-amber-300 transition-colors\">Kit Builder</button>",
    "                <button onclick=\"openAddressBookModal()\" class=\"hover:text-white transition-colors\">Addresses</button>",
    "                <button onclick=\"openTrackModal()\" class=\"hover:text-emerald-400 transition-colors\">Track Order</button>",
    "                <button onclick=\"openAdminModal()\" class=\"hover:text-brandPrimary transition-colors flex items-center space-x-1 font-bold text-slate-300\"><i class=\"fa-solid fa-user-shield text-[11px]\"></i><span>Merchant Portal</span></button>",
    "            </div>",
    "        </div>",
    "    </footer>",
    "",
    "    <!-- MOBILE BOTTOM NAV -->",
    "    <nav class=\"md:hidden fixed bottom-0 inset-x-0 z-40 glass border-t border-white/10 grid grid-cols-5 py-2 text-[10px] font-bold text-slate-300\">",
    "        <button onclick=\"window.scrollTo({top:0,behavior:'smooth'}); setCategoryFilter('All')\" class=\"flex flex-col items-center space-y-1 hover:text-brandPrimary\"><i class=\"fa-solid fa-house text-sm\"></i><span>Home</span></button>",
    "        <button onclick=\"openKitBuilderModal()\" class=\"flex flex-col items-center space-y-1 text-amber-300\"><i class=\"fa-solid fa-wand-magic-sparkles text-sm\"></i><span>Kits 15%</span></button>",
    "        <button onclick=\"openAddressBookModal()\" class=\"flex flex-col items-center space-y-1 hover:text-brandPrimary\"><i class=\"fa-solid fa-location-dot text-sm\"></i><span>Address</span></button>",
    "        <button onclick=\"openTrackModal()\" class=\"flex flex-col items-center space-y-1 text-emerald-400\"><i class=\"fa-solid fa-satellite-dish text-sm\"></i><span>Track 4#</span></button>",
    "        <button onclick=\"toggleCart()\" class=\"flex flex-col items-center space-y-1 text-brandPrimary\"><i class=\"fa-solid fa-bag-shopping text-sm\"></i><span>Cart</span></button>",
    "    </nav>",
    "",
    "    <!-- ================================================================== -->",
    "    <!-- USP #1 MODAL: SMART RITUAL & ROUTINE KIT BUILDER (15% OFF)         -->",
    "    <!-- ================================================================== -->",
    "    <div id=\"kit-modal\" class=\"fixed inset-0 z-[85] bg-black/92 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-3xl p-5 sm:p-6 shadow-2xl relative border border-brandPrimary/40 my-auto max-h-[90vh] overflow-y-auto\">",
    "            <button onclick=\"closeKitBuilderModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <span class=\"text-[10px] bg-brandPrimary/20 text-brandPrimary border border-brandPrimary/30 px-2.5 py-1 rounded-full font-black uppercase\">Exclusive USP • Instant 15% Bundle Savings</span>",
    "            <h3 class=\"text-xl sm:text-2xl font-black text-white mt-2 mb-1\">1-Tap Smart Ritual &amp; Care Kit Builder</h3>",
    "            <p class=\"text-xs text-slate-400 mb-5\">Curated combos designed for maximum value — add an entire kit in 1 tap and automatically unlock 15% off + Free VIP Shipping + Free Mystery Gift.</p>",
    "            <div id=\"kit-cards-grid\" class=\"grid grid-cols-1 sm:grid-cols-2 gap-4\"></div>",
    "        </div>",
    "    </div>",
    "",
    "",
    "    <!-- ================================================================== -->",
    "    <!-- USP #3 MODAL: 10-SEC AI SMART PRODUCT FINDER & GIFT CONCIERGE      -->",
    "    <!-- ================================================================== -->",
    "    <div id=\"finder-modal\" class=\"fixed inset-0 z-[85] bg-black/92 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-2xl p-5 sm:p-6 shadow-2xl relative border border-amber-400/40 my-auto max-h-[92vh] overflow-y-auto\">",
    "            <button onclick=\"closeSmartFinderModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <span class=\"text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full font-black uppercase\">USP #3 • Zero-Guesswork Concierge</span>",
    "            <h3 class=\"text-xl sm:text-2xl font-black text-white mt-2 mb-1\">10-Second Smart Product Matchmaker</h3>",
    "            <p class=\"text-xs text-slate-400 mb-4\">Pick your goal &amp; budget — we instantly score all 66 products and hand-pick your top 3 matches.</p>",
    "",
    "            <div class=\"space-y-3 bg-darkSurface p-4 rounded-2xl border border-white/10 mb-4 text-xs\">",
    "                <div>",
    "                    <label class=\"text-[11px] font-bold text-slate-300 block mb-1.5\">1. Who are you shopping for?</label>",
    "                    <div class=\"grid grid-cols-2 sm:grid-cols-4 gap-2\">",
    "                        <button type=\"button\" onclick=\"setFinderPref('who','self',this)\" class=\"finder-who bg-brandPrimary text-white font-bold py-2 px-2.5 rounded-xl\">🙋 Myself</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('who','home',this)\" class=\"finder-who bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">🏠 Home / Mandir</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('who','gift',this)\" class=\"finder-who bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">🎁 Gift / Parents</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('who','commute',this)\" class=\"finder-who bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">🛵 Commute</button>",
    "                    </div>",
    "                </div>",
    "                <div>",
    "                    <label class=\"text-[11px] font-bold text-slate-300 block mb-1.5\">2. What is your main goal?</label>",
    "                    <div class=\"grid grid-cols-2 sm:grid-cols-4 gap-2\">",
    "                        <button type=\"button\" onclick=\"setFinderPref('goal','puja',this)\" class=\"finder-goal bg-brandPrimary text-white font-bold py-2 px-2.5 rounded-xl\">🕉️ Spiritual Puja</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('goal','cowcare',this)\" class=\"finder-goal bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">🌿 Cow &amp; Glycerin</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('goal','beauty',this)\" class=\"finder-goal bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">✨ Skin &amp; Beauty</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('goal','utility',this)\" class=\"finder-goal bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">⚡ Daily Utility</button>",
    "                    </div>",
    "                </div>",
    "                <div>",
    "                    <label class=\"text-[11px] font-bold text-slate-300 block mb-1.5\">3. Ideal budget per item?</label>",
    "                    <div class=\"grid grid-cols-3 gap-2\">",
    "                        <button type=\"button\" onclick=\"setFinderPref('budget','low',this)\" class=\"finder-budget bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">Under ₹500</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('budget','mid',this)\" class=\"finder-budget bg-brandPrimary text-white font-bold py-2 px-2.5 rounded-xl\">₹500 – ₹1,500</button>",
    "                        <button type=\"button\" onclick=\"setFinderPref('budget','high',this)\" class=\"finder-budget bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl\">Premium ₹1,500+</button>",
    "                    </div>",
    "                </div>",
    "            </div>",
    "",
    "            <div class=\"flex items-center justify-between mb-2\">",
    "                <h4 class=\"text-xs font-black uppercase text-emerald-400\">🎯 Your Top 3 Personalized Matches</h4>",
    "                <button type=\"button\" onclick=\"addAllFinderMatches()\" class=\"bg-brandPrimary hover:bg-pink-600 text-white text-[11px] font-black px-3.5 py-1.5 rounded-xl\">Add All 3 (Save 15%)</button>",
    "            </div>",
    "            <div id=\"finder-results\" class=\"space-y-2.5\"></div>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- RESTORE PROFILE BY PHONE MODAL -->",
    "    <div id=\"restore-modal\" class=\"fixed inset-0 z-[85] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4\">",
    "        <div class=\"glass rounded-2xl w-full max-w-md p-6 shadow-2xl relative border border-amber-500/30\">",
    "            <button onclick=\"closeRestoreProfileModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <h3 class=\"text-lg font-black text-white mb-1\"><i class=\"fa-solid fa-cloud-arrow-down text-amber-400 mr-2\"></i>Restore Your Saved Account</h3>",
    "            <p class=\"text-xs text-slate-400 mb-4\">Enter your 10-digit mobile number (or last 4 digits) to restore your saved addresses, landmarks, gate photos, cart &amp; SuperCoins from our 8 GB cloud vault.</p>",
    "            <form onsubmit=\"restoreCustomerProfile(event)\" class=\"flex space-x-2\">",
    "                <input type=\"tel\" id=\"restore-phone-input\" placeholder=\"10-digit mobile or last 4 digits\" required class=\"flex-grow bg-darkSurface border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-amber-400\">",
    "                <button type=\"submit\" class=\"bg-amber-500 text-black font-black px-4 py-2.5 rounded-xl text-xs shrink-0\">Restore</button>",
    "            </form>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- PRODUCT QUICK VIEW MODAL (WITH PHOTO REVIEWS) -->",
    "    <div id=\"quickview-modal\" class=\"fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm hidden items-center justify-center p-3 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl border border-white/10 relative grid md:grid-cols-12 my-auto max-h-[92vh]\">",
    "            <button onclick=\"closeQuickView()\" class=\"absolute top-3 right-3 z-20 w-8 h-8 rounded-full bg-black/75 text-white hover:bg-brandPrimary flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <div class=\"md:col-span-5 bg-black relative flex flex-col justify-between\">",
    "                <div class=\"relative aspect-square w-full\">",
    "                    <img id=\"qv-img\" src=\"\" alt=\"Product\" class=\"w-full h-full object-cover\">",
    "                    <span id=\"qv-badge\" class=\"absolute top-3 left-3 bg-brandPrimary text-white text-[10px] font-black px-3 py-1 rounded-full uppercase\"></span>",
    "                </div>",
    "                <div class=\"p-3 bg-darkElevated border-t border-white/10 flex items-center justify-between text-xs\">",
    "                    <span class=\"text-slate-300 font-semibold\"><i class=\"fa-brands fa-whatsapp text-whatsapp mr-1.5\"></i>Share or Resell</span>",
    "                    <button id=\"qv-share-btn\" class=\"bg-whatsapp/15 hover:bg-whatsapp/25 text-whatsapp border border-whatsapp/30 px-3 py-1.5 rounded-lg font-bold text-[11px]\">Share on WhatsApp</button>",
    "                </div>",
    "            </div>",
    "            <div class=\"md:col-span-7 p-5 sm:p-6 bg-darkSurface overflow-y-auto max-h-[75vh] md:max-h-[90vh] space-y-4\">",
    "                <div>",
    "                    <div class=\"flex items-center justify-between mb-1.5\">",
    "                        <span id=\"qv-cat\" class=\"text-[10px] font-bold uppercase tracking-wider text-brandPrimary\"></span>",
    "                        <div class=\"flex items-center space-x-1 text-amber-400 text-xs\"><i class=\"fa-solid fa-star\"></i><span id=\"qv-rating\" class=\"font-bold text-white\"></span></div>",
    "                    </div>",
    "                    <h3 id=\"qv-title\" class=\"text-xl font-black text-white mb-2\"></h3>",
    "                    <div class=\"flex items-baseline space-x-2.5 mb-3\">",
    "                        <span id=\"qv-price\" class=\"text-2xl font-black text-brandPrimary\"></span>",
    "                        <span id=\"qv-mrp\" class=\"text-xs text-slate-500 line-through font-mono\"></span>",
    "                        <span id=\"qv-save\" class=\"text-[10px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded font-bold\"></span>",
    "                    </div>",
    "                    <p id=\"qv-desc\" class=\"text-xs text-slate-300 leading-relaxed mb-3\"></p>",
    "                    <ul id=\"qv-highlights\" class=\"space-y-1 text-xs text-slate-200 mb-3\"></ul>",
    "                </div>",
    "                <div class=\"bg-black/40 border border-white/5 rounded-xl p-3\">",
    "                    <h4 class=\"text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2\">Specifications &amp; Quality Assurance</h4>",
    "                    <div id=\"qv-specs\" class=\"grid grid-cols-2 gap-2 text-[11px]\"></div>",
    "                </div>",
    "                <div id=\"qv-fbt-box\" class=\"hidden bg-brandPrimary/10 border border-brandPrimary/25 rounded-xl p-3\">",
    "                    <span class=\"text-[10px] font-black uppercase text-brandPrimary block mb-2\">⚡ Frequently Bought Together (Save Extra ₹100)</span>",
    "                    <div class=\"flex items-center justify-between gap-2\">",
    "                        <div class=\"flex items-center space-x-2 overflow-hidden\">",
    "                            <img id=\"qv-fbt-img\" src=\"\" class=\"w-10 h-10 rounded-lg object-cover border border-white/10 shrink-0\">",
    "                            <div class=\"overflow-hidden\"><p id=\"qv-fbt-title\" class=\"text-xs font-bold text-white truncate\"></p><p id=\"qv-fbt-price\" class=\"text-[11px] text-emerald-400 font-bold\"></p></div>",
    "                        </div>",
    "                        <button id=\"qv-fbt-btn\" class=\"bg-brandPrimary text-white text-[11px] font-bold px-3 py-2 rounded-lg shrink-0\">Add Bundle</button>",
    "                    </div>",
    "                </div>",
    "                <div class=\"bg-black/40 p-3 rounded-xl border border-white/5\">",
    "                    <label class=\"text-[10px] font-bold text-slate-400 uppercase block mb-1.5\">Check Delivery to Your Pincode</label>",
    "                    <div class=\"flex space-x-2\">",
    "                        <input type=\"text\" id=\"qv-pincode\" maxlength=\"6\" placeholder=\"Enter 6-digit Pincode\" class=\"w-full bg-darkSurface border border-darkBorder rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-brandPrimary\">",
    "                        <button onclick=\"checkPincode()\" class=\"bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-3 py-1.5 rounded-lg shrink-0\">Check</button>",
    "                    </div>",
    "                    <p id=\"qv-pin-result\" class=\"text-[11px] font-semibold mt-1.5 hidden\"></p>",
    "                </div>",
    "                <div class=\"grid grid-cols-2 gap-2.5\">",
    "                    <button id=\"qv-add-btn\" class=\"bg-white/10 hover:bg-white/20 text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider\">Add to Cart</button>",
    "                    <button id=\"qv-buy-btn\" class=\"bg-brandPrimary text-white font-black py-3 rounded-xl btn-glow text-xs uppercase tracking-wider\">Buy Now • UPI</button>",
    "                </div>",
    "                <div class=\"border-t border-white/10 pt-4\">",
    "                    <div class=\"flex items-center justify-between mb-2\">",
    "                        <h4 class=\"text-xs font-black text-white\">Verified Customer Reviews &amp; Photos</h4>",
    "                        <button onclick=\"toggleReviewForm()\" class=\"text-[11px] text-brandPrimary hover:underline font-bold\">+ Write a Review</button>",
    "                    </div>",
    "                    <form id=\"qv-review-form\" onsubmit=\"submitProductReview(event)\" class=\"hidden bg-black/50 p-3 rounded-xl border border-white/10 space-y-2 mb-3\">",
    "                        <div class=\"grid grid-cols-2 gap-2\">",
    "                            <input type=\"text\" id=\"rev-author\" placeholder=\"Your Name *\" required class=\"bg-darkSurface border border-darkBorder rounded-lg px-2.5 py-1.5 text-xs text-white\">",
    "                            <select id=\"rev-rating\" class=\"bg-darkSurface border border-darkBorder rounded-lg px-2.5 py-1.5 text-xs text-white\">",
    "                                <option value=\"5\">★★★★★ (5/5 Excellent)</option>",
    "                                <option value=\"4\">★★★★☆ (4/5 Good)</option>",
    "                                <option value=\"3\">★★★☆☆ (3/5 Average)</option>",
    "                            </select>",
    "                        </div>",
    "                        <textarea id=\"rev-comment\" rows=\"2\" placeholder=\"Share your experience...\" required class=\"w-full bg-darkSurface border border-darkBorder rounded-lg px-2.5 py-1.5 text-xs text-white\"></textarea>",
    "                        <div class=\"flex items-center justify-between gap-2\">",
    "                            <label class=\"text-[11px] text-slate-300 bg-white/5 px-2.5 py-1.5 rounded-lg cursor-pointer hover:bg-white/10\"><i class=\"fa-solid fa-camera mr-1 text-brandPrimary\"></i><span id=\"rev-photo-label\">Attach Photo (Optional)</span><input type=\"file\" id=\"rev-photo-input\" accept=\"image/*\" onchange=\"handleReviewPhotoSelect(event)\" class=\"hidden\"></label>",
    "                            <button type=\"submit\" class=\"bg-brandPrimary text-white text-xs font-bold px-4 py-1.5 rounded-lg\">Post Review</button>",
    "                        </div>",
    "                    </form>",
    "                    <div id=\"qv-reviews-list\" class=\"space-y-2 text-xs\"></div>",
    "                </div>",
    "            </div>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- CART SIDEBAR (WITH SMART AUTO BEST-DEAL ENGINE) -->",
    "    <div id=\"cart-sidebar\" class=\"fixed inset-y-0 right-0 z-50 w-full max-w-md glass shadow-2xl transform translate-x-full transition-transform duration-300 flex flex-col border-l border-white/10\">",
    "        <div class=\"p-4 flex justify-between items-center border-b border-white/10 bg-black/60\">",
    "            <h3 class=\"text-base font-black text-white flex items-center\"><i class=\"fa-solid fa-bag-shopping text-brandPrimary mr-2\"></i> Your Saved Cart</h3>",
    "            <button onclick=\"toggleCart()\" class=\"text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "        </div>",
    "        <div class=\"bg-red-500/10 py-2 px-4 border-b border-red-500/20 flex items-center justify-between text-xs\">",
    "            <span class=\"font-bold text-red-400\"><i class=\"fa-solid fa-stopwatch mr-1\"></i>Reserved: <strong id=\"cart-timer\" class=\"font-mono text-white bg-red-500/30 px-1.5 py-0.5 rounded\">10:00</strong></span>",
    "            <span class=\"text-slate-300 text-[11px]\">Est: <strong id=\"auto-delivery-date\" class=\"text-emerald-400\">Calculating...</strong></span>",
    "        </div>",
    "        <div class=\"p-3.5 border-b border-white/5 bg-darkSurface\">",
    "            <div class=\"flex justify-between text-[11px] font-bold mb-1.5 text-slate-200\" id=\"shipping-text\">Add ₹999 for FREE VIP Shipping</div>",
    "            <div class=\"w-full bg-black rounded-full h-2 border border-white/10 overflow-hidden mb-1.5\">",
    "                <div id=\"shipping-progress\" class=\"bg-gradient-to-r from-brandPrimary to-amber-400 h-2 rounded-full transition-all duration-300\" style=\"width: 0%\"></div>",
    "            </div>",
    "            <div class=\"flex justify-between text-[9px] text-slate-400 font-bold uppercase\">",
    "                <span>₹999 Free Ship</span>",
    "                <span>₹1,499 Free Gift 🎁</span>",
    "                <span>₹2,499 Extra 10%</span>",
    "            </div>",
    "        </div>",
    "        <div id=\"cart-items\" class=\"flex-grow p-4 overflow-y-auto space-y-3\"></div>",
    "        <div class=\"p-4 bg-black/95 border-t border-white/10 space-y-2.5\">",
    "            <!-- Auto Best-Deal Banner -->",
    "            <div id=\"auto-savings-pill\" class=\"hidden bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold px-3 py-1.5 rounded-xl text-center\"></div>",
    "",
    "            <div class=\"flex space-x-2\">",
    "                <input type=\"text\" id=\"coupon-input\" placeholder=\"Promo code (Auto-applies PREM10)\" class=\"w-full bg-darkSurface border border-darkBorder rounded-xl px-3 py-2 text-xs text-white uppercase outline-none focus:border-brandPrimary\">",
    "                <button onclick=\"applyCouponInput()\" class=\"bg-white/10 hover:bg-white/20 text-white font-bold px-4 py-2 rounded-xl text-xs shrink-0\">Apply</button>",
    "            </div>",
    "            <label class=\"flex items-center justify-between bg-amber-500/10 border border-amber-500/25 px-3 py-2 rounded-xl cursor-pointer text-xs\">",
    "                <div class=\"flex items-center space-x-2\">",
    "                    <input type=\"checkbox\" id=\"use-coins-cb\" checked onchange=\"updateCartUI()\" class=\"w-4 h-4 accent-amber-400 cursor-pointer\">",
    "                    <span class=\"font-bold text-amber-300\"><i class=\"fa-solid fa-coins mr-1\"></i>Use <span id=\"cart-avail-coins\">50</span> SuperCoins</span>",
    "                </div>",
    "                <span class=\"text-emerald-400 font-black\" id=\"cart-coins-val\">-₹50</span>",
    "            </label>",
    "            <label class=\"flex items-start space-x-2.5 bg-brandPrimary/10 border border-brandPrimary/30 p-2.5 rounded-xl cursor-pointer\">",
    "                <input type=\"checkbox\" id=\"order-bump\" onchange=\"updateCartUI()\" class=\"w-4 h-4 mt-0.5 accent-brandPrimary cursor-pointer\">",
    "                <div class=\"text-xs flex-grow\">",
    "                    <div class=\"font-bold text-white flex justify-between\"><span>VIP Transit Insurance &amp; Priority Dispatch</span><span class=\"text-brandPrimary font-black\">+₹99</span></div>",
    "                    <p class=\"text-[10px] text-slate-400\">Zero-wait instant replacement against transit damage.</p>",
    "                </div>",
    "            </label>",
    "            <div class=\"space-y-1 text-xs pt-1\">",
    "                <div class=\"flex justify-between text-slate-400\"><span>Subtotal:</span><span id=\"cart-subtotal\">₹0</span></div>",
    "                <div id=\"volume-row\" class=\"flex justify-between text-emerald-400 font-bold hidden\"><span>Kit / Bundle Discount:</span><span id=\"cart-volume-disc\">-₹0</span></div>",
    "                <div id=\"discount-row\" class=\"flex justify-between text-emerald-400 font-bold hidden\"><span>Promo Code:</span><span id=\"cart-discount\">-₹0</span></div>",
    "                <div id=\"coins-row\" class=\"flex justify-between text-amber-400 font-bold hidden\"><span>SuperCoins Redeemed:</span><span id=\"cart-coins-disc\">-₹0</span></div>",
    "                <div id=\"gift-row\" class=\"flex justify-between text-pink-400 font-bold hidden\"><span>🎁 Free Mystery Bonus Gift:</span><span>FREE</span></div>",
    "                <div class=\"flex justify-between text-lg font-black text-white border-t border-white/10 pt-2\"><span>Total Payable:</span><span id=\"cart-total\" class=\"text-brandPrimary\">₹0</span></div>",
    "            </div>",
    "            <button onclick=\"openShippingModal()\" class=\"w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow flex items-center justify-center space-x-2 uppercase text-xs tracking-wider\">",
    "                <span>Proceed to Seamless UPI Checkout</span>",
    "                <i class=\"fa-solid fa-arrow-right\"></i>",
    "            </button>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- ================================================================== -->",
    "    <!-- SEAMLESS UPI CHECKOUT (SCREENSHOT PROOF OR 4-DIGIT REF — NO CLUNKY 12-DIGIT UTR!) -->",
    "    <!-- ================================================================== -->",
    "    <div id=\"shipping-modal\" class=\"fixed inset-0 z-[75] bg-black/92 backdrop-blur-md hidden items-center justify-center p-2.5 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-xl p-5 sm:p-6 shadow-2xl relative border border-white/15 my-auto max-h-[94vh] overflow-y-auto\">",
    "            <button onclick=\"closeShippingModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "",
    "            <div class=\"flex items-center space-x-2 text-brandPrimary text-[11px] font-bold uppercase tracking-wider mb-1\">",
    "                <i class=\"fa-solid fa-shield-halved\"></i>",
    "                <span>Zero-Friction UPI Checkout • Track with Last 4 Phone Digits</span>",
    "            </div>",
    "            <h3 class=\"text-xl font-black text-white mb-4\">Delivery Details &amp; Instant UPI Pay</h3>",
    "",
    "            <form id=\"shipping-form\" onsubmit=\"submitOrderAndRedirectToWhatsApp(event)\" class=\"space-y-3.5\">",
    "                <div id=\"checkout-saved-addr-wrap\" class=\"hidden\">",
    "                    <div class=\"flex justify-between items-center mb-1.5\">",
    "                        <span class=\"text-[11px] font-bold text-slate-300\">1-Tap Saved Address (with Landmark):</span>",
    "                        <button type=\"button\" onclick=\"openAddressBookModal()\" class=\"text-[11px] text-brandPrimary font-bold hover:underline\">+ Manage</button>",
    "                    </div>",
    "                    <div id=\"checkout-saved-addr-list\" class=\"flex gap-2 overflow-x-auto hide-scrollbar pb-1\"></div>",
    "                </div>",
    "",
    "                <div class=\"grid grid-cols-1 sm:grid-cols-2 gap-2.5\">",
    "                    <input type=\"text\" id=\"cust-name\" placeholder=\"Full Name *\" required class=\"w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\">",
    "                    <input type=\"tel\" id=\"cust-phone\" placeholder=\"10-Digit Mobile (Last 4 = Track ID) *\" required pattern=\"[0-9+ ]{10,15}\" class=\"w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\">",
    "                </div>",
    "                <div class=\"grid grid-cols-3 gap-2.5\">",
    "                    <input type=\"text\" id=\"cust-pincode\" placeholder=\"6-Digit Pincode *\" required pattern=\"[1-9][0-9]{5}\" maxlength=\"6\" class=\"col-span-1 px-3 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\">",
    "                    <input type=\"text\" id=\"cust-city\" placeholder=\"City & State *\" required class=\"col-span-2 px-3 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\">",
    "                </div>",
    "                <input type=\"text\" id=\"cust-landmark\" placeholder=\"Nearby Landmark (e.g. Opp. Temple / Near Bus Stop) *\" required class=\"w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\">",
    "                <textarea id=\"cust-address\" placeholder=\"House No, Flat, Building, Street *\" required rows=\"2\" class=\"w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary\"></textarea>",
    "",
    "                <label class=\"flex items-center space-x-2 text-[11px] text-slate-300 cursor-pointer\">",
    "                    <input type=\"checkbox\" id=\"save-addr-checkbox\" checked class=\"accent-brandPrimary\">",
    "                    <span>Save address &amp; landmark to my Cloud Address Book</span>",
    "                </label>",
    "",
    "                <!-- STEP 1: MANDATORY UPI APP REDIRECTION -->",
    "                <div class=\"bg-darkElevated border-2 border-brandPrimary/40 rounded-2xl p-4 space-y-3\">",
    "                    <div class=\"flex justify-between items-center border-b border-white/10 pb-2.5\">",
    "                        <div>",
    "                            <span class=\"text-[10px] uppercase tracking-wider text-slate-400 font-bold block\">Step 1: Tap Your UPI App to Pay</span>",
    "                            <span id=\"checkout-total-badge\" class=\"text-2xl font-black text-emerald-400\">₹0</span>",
    "                        </div>",
    "                        <span id=\"upi-redirect-status\" class=\"text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full font-bold\">⏳ Tap App Below</span>",
    "                    </div>",
    "",
    "                    <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-2.5\">",
    "                        <button type=\"button\" onclick=\"launchUpiApp('PhonePe', false)\" class=\"bg-[#5F259F] hover:bg-[#4e1e84] text-white font-extrabold py-3 px-3 rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg transition-all active:scale-95\">",
    "                            <span class=\"w-6 h-6 rounded-full bg-white text-[#5F259F] font-black flex items-center justify-center text-xs\">पे</span><span>PhonePe</span>",
    "                        </button>",
    "                        <button type=\"button\" onclick=\"launchUpiApp('Google Pay', false)\" class=\"bg-[#1A73E8] hover:bg-[#1558b0] text-white font-extrabold py-3 px-3 rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg transition-all active:scale-95\">",
    "                            <span class=\"w-6 h-6 rounded-full bg-white text-[#1A73E8] font-black flex items-center justify-center text-xs\">G</span><span>Google Pay</span>",
    "                        </button>",
    "                        <button type=\"button\" onclick=\"launchUpiApp('Navi', false)\" class=\"bg-[#00B853] hover:bg-[#009644] text-black font-black py-3 px-3 rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg transition-all active:scale-95\">",
    "                            <span class=\"w-6 h-6 rounded-full bg-black text-[#00E676] font-black flex items-center justify-center text-xs\">N</span><span>Navi UPI</span>",
    "                        </button>",
    "                    </div>",
    "",
    "                    <div class=\"grid grid-cols-1 sm:grid-cols-2 gap-2\">",
    "                        <button type=\"button\" onclick=\"launchUpiApp('Other UPI App', false)\" class=\"bg-white/10 hover:bg-white/15 text-white font-bold py-2 px-3 rounded-xl text-[11px] border border-white/10\">Any Other UPI App</button>",
    "                        <button type=\"button\" onclick=\"launchUpiApp(selectedPaymentApp || 'UPI App', true)\" class=\"bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 font-bold py-2 px-3 rounded-xl text-[11px] border border-amber-500/30\"><i class=\"fa-solid fa-unlock-keyhole mr-1\"></i>High-Value / Safe-Open</button>",
    "                    </div>",
    "",
    "                    <div class=\"grid grid-cols-1 sm:grid-cols-12 gap-2 bg-black/60 border border-white/10 rounded-xl p-2.5 text-[11px] items-center\">",
    "                        <div class=\"sm:col-span-7 truncate font-mono text-slate-300\">UPI: <strong class=\"text-white\" id=\"upi-id-display\">premkumarmanthena289@oksbi</strong></div>",
    "                        <div class=\"sm:col-span-5 flex justify-end space-x-2\">",
    "                            <button type=\"button\" onclick=\"copyUpiIdAndUnlock()\" class=\"bg-brandPrimary/20 hover:bg-brandPrimary text-brandPrimary hover:text-white px-2.5 py-1 rounded-lg font-bold\"><i class=\"fa-regular fa-copy mr-1\"></i>Copy UPI</button>",
    "                            <button type=\"button\" onclick=\"copyExactAmount()\" class=\"bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-black px-2.5 py-1 rounded-lg font-bold\">Copy ₹</button>",
    "                        </div>",
    "                    </div>",
    "",
    "                    <!-- STEP 2: EASY PAYMENT PROOF (1-TAP SCREENSHOT OR JUST LAST 4 DIGITS!) -->",
    "                    <div class=\"pt-2 border-t border-white/10 space-y-2.5\">",
    "                        <label class=\"text-[11px] font-black text-white block\">Step 2: Instant Payment Proof (Choose Either — Takes 2 Seconds!)</label>",
    "                        <div class=\"grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-center\">",
    "                            <label class=\"flex items-center justify-center space-x-2 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-bold py-2.5 px-3 rounded-xl text-xs cursor-pointer transition-all\">",
    "                                <i class=\"fa-solid fa-image\"></i>",
    "                                <span id=\"pay-photo-label\">Upload Payment Screenshot</span>",
    "                                <input type=\"file\" id=\"pay-proof-file\" accept=\"image/*\" onchange=\"handlePaymentScreenshotUpload(event)\" class=\"hidden\">",
    "                            </label>",
    "                            <input type=\"text\" id=\"cust-ref-short\" oninput=\"validateCheckoutUnlock()\" placeholder=\"OR type last 4 digits of Ref No.\" maxlength=\"22\" class=\"w-full px-3 py-2.5 bg-black/70 border border-darkBorder rounded-xl text-xs font-mono text-white uppercase outline-none focus:border-emerald-400\">",
    "                        </div>",
    "                        <div id=\"pay-proof-preview-wrap\" class=\"hidden flex items-center space-x-3 bg-black/50 p-2 rounded-xl border border-emerald-500/30\">",
    "                            <img id=\"pay-proof-preview\" src=\"\" class=\"w-12 h-12 rounded-lg object-cover border border-white/10\">",
    "                            <div class=\"text-[11px] text-emerald-300 font-bold flex-grow\">✓ Payment screenshot attached &amp; compressed for instant approval!</div>",
    "                            <button type=\"button\" onclick=\"clearPaymentScreenshot()\" class=\"text-slate-400 hover:text-red-400 text-xs px-2\"><i class=\"fa-solid fa-trash\"></i></button>",
    "                        </div>",
    "                        <p id=\"proof-helper\" class=\"text-[10px] text-amber-300\">Tap PhonePe, GPay, or Navi above, then upload your payment screenshot OR enter the last 4 digits of the transaction ref.</p>",
    "                    </div>",
    "                </div>",
    "",
    "                <button type=\"submit\" id=\"whatsapp-checkout-btn\" disabled class=\"w-full bg-slate-700 text-slate-400 font-black py-4 rounded-xl tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2 cursor-not-allowed transition-all\">",
    "                    <i class=\"fa-solid fa-lock\"></i>",
    "                    <span>Tap PhonePe, GPay, or Navi Above First</span>",
    "                </button>",
    "            </form>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- SUCCESS & INSTANT 4-DIGIT TRACKING CELEBRATION MODAL -->",
    "    <div id=\"success-modal\" class=\"fixed inset-0 z-[95] bg-black/92 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-md p-6 text-center border border-emerald-500/40 shadow-2xl space-y-4 my-auto\">",
    "            <div class=\"w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto text-3xl border border-emerald-500/40\"><i class=\"fa-solid fa-circle-check\"></i></div>",
    "            <div>",
    "                <h3 class=\"text-2xl font-black text-white\">Order Confirmed!</h3>",
    "                <p class=\"text-xs text-slate-300 mt-1\">Track anytime with your Last 4 Phone Digits: <strong id=\"succ-last4\" class=\"font-mono text-lg text-emerald-400 bg-emerald-500/15 px-2.5 py-0.5 rounded-lg\"></strong></p>",
    "                <p class=\"text-[11px] text-slate-400 mt-1\">Ref ID: <span id=\"succ-oid\" class=\"font-mono text-brandPrimary\"></span> • 🎉 +<span id=\"succ-coins\">0</span> SuperCoins earned!</p>",
    "            </div>",
    "            <div class=\"bg-darkSurface border border-white/10 rounded-xl p-3.5 text-left text-xs space-y-1.5\">",
    "                <div class=\"flex justify-between\"><span class=\"text-slate-400\">Payment App:</span><strong id=\"succ-app\" class=\"text-white\"></strong></div>",
    "                <div class=\"flex justify-between\"><span class=\"text-slate-400\">Proof Status:</span><strong id=\"succ-proof\" class=\"text-emerald-400\"></strong></div>",
    "                <div class=\"flex justify-between\"><span class=\"text-slate-400\">Total Paid:</span><strong id=\"succ-total\" class=\"text-white\"></strong></div>",
    "                <div class=\"flex justify-between\"><span class=\"text-slate-400\">Est. Delivery:</span><strong id=\"succ-est\" class=\"text-emerald-400\"></strong></div>",
    "            </div>",
    "            <div class=\"space-y-2\">",
    "                <a id=\"succ-wa-link\" href=\"#\" target=\"_blank\" class=\"w-full bg-whatsapp text-black font-black py-3.5 rounded-xl btn-glow-whatsapp flex items-center justify-center space-x-2 text-xs uppercase\"><i class=\"fa-brands fa-whatsapp text-lg\"></i><span>Send Order Confirmation on WhatsApp</span></a>",
    "                <div class=\"grid grid-cols-2 gap-2\">",
    "                    <button onclick=\"printInvoice()\" class=\"bg-white/10 hover:bg-white/20 text-white font-bold py-2.5 rounded-xl text-xs\"><i class=\"fa-solid fa-print mr-1\"></i>Print Invoice</button>",
    "                    <button onclick=\"closeSuccessAndTrack()\" class=\"bg-brandPrimary/20 hover:bg-brandPrimary/30 text-brandPrimary font-bold py-2.5 rounded-xl text-xs\"><i class=\"fa-solid fa-satellite-dish mr-1\"></i>Track Live</button>",
    "                </div>",
    "            </div>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- ================================================================== -->",
    "    <!-- UPGRADED LAST-4-DIGITS LIVE ORDER TRACKER + INSTANT REPLACEMENT    -->",
    "    <!-- ================================================================== -->",
    "    <div id=\"track-modal\" class=\"fixed inset-0 z-[80] bg-black/92 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-xl p-5 sm:p-6 shadow-2xl relative border border-emerald-500/30 my-auto max-h-[93vh] overflow-y-auto\">",
    "            <button onclick=\"closeTrackModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <div class=\"flex items-center space-x-3 mb-4\">",
    "                <div class=\"w-11 h-11 bg-emerald-500/15 rounded-xl flex items-center justify-center border border-emerald-500/30\"><i class=\"fa-solid fa-satellite-dish text-xl text-emerald-400\"></i></div>",
    "                <div>",
    "                    <h3 class=\"text-xl font-black text-white\">Live 4-Digit Phone Tracker</h3>",
    "                    <p class=\"text-xs text-slate-400\">No long Order ID needed — just enter the <strong>last 4 digits</strong> of your phone!</p>",
    "                </div>",
    "            </div>",
    "",
    "            <div id=\"recent-orders-box\" class=\"mb-3 hidden\">",
    "                <p class=\"text-[10px] font-bold uppercase text-slate-400 mb-1.5\">Your Recent Orders:</p>",
    "                <div id=\"recent-orders-list\" class=\"flex flex-wrap gap-1.5\"></div>",
    "            </div>",
    "",
    "            <form onsubmit=\"lookupOrderStatus(event)\" class=\"flex space-x-2 mb-4\">",
    "                <input type=\"text\" id=\"track-order-id\" placeholder=\"Enter Last 4 Phone Digits (e.g. 4915)\" required class=\"w-full px-4 py-3 bg-darkSurface border-2 border-darkBorder rounded-xl text-sm font-mono font-bold text-white tracking-widest uppercase outline-none focus:border-emerald-400\">",
    "                <button type=\"submit\" class=\"bg-emerald-500 hover:bg-emerald-600 text-black font-black px-5 py-3 rounded-xl text-xs shrink-0 uppercase\">Track</button>",
    "            </form>",
    "",
    "            <!-- Multi-order switcher when customer has >1 order on same last 4 digits -->",
    "            <div id=\"track-multi-switcher\" class=\"hidden mb-3 flex gap-2 overflow-x-auto hide-scrollbar pb-1\"></div>",
    "",
    "            <div id=\"track-result-card\" class=\"hidden bg-darkSurface border border-white/10 rounded-2xl p-4 space-y-4\">",
    "                <div class=\"flex justify-between items-start border-b border-white/10 pb-3\">",
    "                    <div>",
    "                        <div class=\"flex items-center space-x-2\">",
    "                            <span class=\"w-2.5 h-2.5 rounded-full bg-emerald-400 live-beacon\"></span>",
    "                            <span id=\"trk-id\" class=\"font-mono font-black text-base text-white\"></span>",
    "                        </div>",
    "                        <p id=\"trk-meta\" class=\"text-[11px] text-slate-400 mt-0.5\"></p>",
    "                    </div>",
    "                    <span id=\"trk-badge\" class=\"text-[10px] font-black px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30\"></span>",
    "                </div>",
    "",
    "                <!-- Live Visual Progress Bar -->",
    "                <div>",
    "                    <div class=\"flex justify-between text-[10px] font-bold text-slate-400 mb-1.5\">",
    "                        <span id=\"trk-progress-label\">Stage 2 of 6</span>",
    "                        <span class=\"text-emerald-400\">Est: <strong id=\"trk-est\"></strong></span>",
    "                    </div>",
    "                    <div class=\"w-full bg-black h-2.5 rounded-full overflow-hidden border border-white/10\">",
    "                        <div id=\"trk-progress-bar\" class=\"bg-gradient-to-r from-brandPrimary via-amber-400 to-emerald-400 h-2.5 rounded-full transition-all duration-500\" style=\"width: 33%\"></div>",
    "                    </div>",
    "                </div>",
    "",
    "                <!-- 6-Stage Vertical Timeline -->",
    "                <div class=\"space-y-3 text-xs pl-1\" id=\"trk-steps\"></div>",
    "",
    "                <!-- Courier & AWB Card -->",
    "                <div id=\"trk-courier-box\" class=\"hidden bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-xs flex justify-between items-center\">",
    "                    <div><span class=\"text-blue-300 font-bold block\" id=\"trk-courier-name\"></span><span class=\"text-[11px] font-mono text-white\" id=\"trk-awb\"></span></div>",
    "                    <a id=\"trk-courier-link\" href=\"#\" target=\"_blank\" class=\"bg-blue-500 text-white font-bold px-3 py-1.5 rounded-lg text-[11px]\">Live Courier</a>",
    "                </div>",
    "",
    "                <!-- Delivery Address & Landmark -->",
    "                <div id=\"trk-addr-box\" class=\"bg-black/40 p-3 rounded-xl border border-white/5 text-[11px] text-slate-300\"></div>",
    "",
    "                <!-- Items -->",
    "                <div id=\"trk-items-box\" class=\"bg-black/40 p-3 rounded-xl border border-white/5 text-xs space-y-1.5\"></div>",
    "",
    "                <!-- Self-Service Actions (Better than Amazon!) -->",
    "                <div class=\"grid grid-cols-3 gap-2\">",
    "                    <button type=\"button\" onclick=\"reorderTrackedOrder()\" class=\"bg-white/10 hover:bg-white/20 text-white font-bold py-2.5 rounded-xl text-[11px]\"><i class=\"fa-solid fa-rotate-right mr-1\"></i>Buy Again</button>",
    "                    <button type=\"button\" onclick=\"toggleReplacementForm()\" class=\"bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 font-bold py-2.5 rounded-xl text-[11px]\"><i class=\"fa-solid fa-shield-heart mr-1\"></i>Replace</button>",
    "                    <button type=\"button\" id=\"trk-cancel-btn\" onclick=\"cancelTrackedOrder()\" class=\"bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 font-bold py-2.5 rounded-xl text-[11px]\">Cancel</button>",
    "                </div>",
    "",
    "                <!-- USP #2: Zero-Wait Instant Replacement Form -->",
    "                <form id=\"trk-replace-form\" onsubmit=\"submitReplacementTicket(event)\" class=\"hidden bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 space-y-2.5 text-xs\">",
    "                    <h4 class=\"font-black text-amber-300\"><i class=\"fa-solid fa-bolt mr-1\"></i>Zero-Wait Instant Replacement Request</h4>",
    "                    <select id=\"rpl-reason\" class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white\">",
    "                        <option value=\"Damaged in Transit\">Damaged in Transit</option>",
    "                        <option value=\"Wrong Item Received\">Wrong Item Received</option>",
    "                        <option value=\"Defective / Not Working\">Defective / Not Working</option>",
    "                        <option value=\"Missing Item in Box\">Missing Item in Box</option>",
    "                    </select>",
    "                    <textarea id=\"rpl-details\" rows=\"2\" placeholder=\"Describe issue briefly...\" class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white\"></textarea>",
    "                    <div class=\"flex items-center justify-between gap-2\">",
    "                        <label class=\"bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-lg cursor-pointer text-[11px] font-bold\"><i class=\"fa-solid fa-camera mr-1\"></i><span id=\"rpl-photo-lbl\">Attach Photo</span><input type=\"file\" accept=\"image/*\" onchange=\"handleReplacementPhotoSelect(event)\" class=\"hidden\"></label>",
    "                        <button type=\"submit\" class=\"bg-amber-400 text-black font-black px-4 py-1.5 rounded-lg text-xs\">Submit Priority Ticket</button>",
    "                    </div>",
    "                </form>",
    "",
    "                <button type=\"button\" onclick=\"pingWhatsAppForTracking()\" class=\"w-full bg-whatsapp text-black font-black py-3 rounded-xl text-xs flex items-center justify-center space-x-2\"><i class=\"fa-brands fa-whatsapp text-base\"></i><span>Chat with Dispatch Desk on WhatsApp</span></button>",
    "            </div>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- SAVED ADDRESS BOOK MODAL (WITH LANDMARK & GATE PHOTO IN 8GB DB) -->",
    "    <div id=\"address-modal\" class=\"fixed inset-0 z-[85] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-lg p-6 shadow-2xl relative border border-white/15 my-auto max-h-[90vh] overflow-y-auto\">",
    "            <button onclick=\"closeAddressBookModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <h3 class=\"text-lg font-black text-white mb-1\"><i class=\"fa-solid fa-location-dot text-brandPrimary mr-2\"></i>Saved Addresses, Landmarks &amp; Gate Photos</h3>",
    "            <p class=\"text-xs text-slate-400 mb-4\">Saved permanently to your profile &amp; our 8 GB vault so delivery riders find your door effortlessly.</p>",
    "            <div id=\"address-book-list\" class=\"space-y-2.5 mb-5\"></div>",
    "            <form onsubmit=\"saveNewAddress(event)\" class=\"bg-darkSurface border border-white/10 p-4 rounded-xl space-y-2.5\">",
    "                <h4 class=\"text-xs font-bold uppercase text-brandPrimary\">+ Add New Delivery Address</h4>",
    "                <div class=\"flex gap-2\">",
    "                    <select id=\"ab-label\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\"><option value=\"Home\">🏠 Home</option><option value=\"Work\">💼 Work</option><option value=\"Other\">📍 Other</option></select>",
    "                    <input type=\"text\" id=\"ab-name\" placeholder=\"Full Name *\" required class=\"flex-grow bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                </div>",
    "                <div class=\"grid grid-cols-2 gap-2\">",
    "                    <input type=\"tel\" id=\"ab-phone\" placeholder=\"10-Digit Mobile *\" required class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                    <input type=\"text\" id=\"ab-pincode\" placeholder=\"6-Digit Pincode *\" required maxlength=\"6\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                </div>",
    "                <input type=\"text\" id=\"ab-city\" placeholder=\"City & State *\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                <input type=\"text\" id=\"ab-landmark\" placeholder=\"Nearby Landmark (e.g. Near Temple / School) *\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                <textarea id=\"ab-street\" rows=\"2\" placeholder=\"House No, Flat, Building, Street *\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\"></textarea>",
    "                <div class=\"flex items-center justify-between gap-2 bg-black/50 p-2 rounded-lg border border-white/10\">",
    "                    <label class=\"text-[11px] text-indigo-300 font-bold cursor-pointer\"><i class=\"fa-solid fa-camera mr-1.5\"></i><span id=\"ab-photo-lbl\">Add Building / Gate Photo (Optional)</span><input type=\"file\" accept=\"image/*\" onchange=\"handleAddressPhotoSelect(event)\" class=\"hidden\"></label>",
    "                    <img id=\"ab-photo-preview\" src=\"\" class=\"hidden w-9 h-9 rounded object-cover border border-white/20\">",
    "                </div>",
    "                <button type=\"submit\" class=\"w-full bg-brandPrimary text-white font-bold py-2.5 rounded-xl text-xs\">Save Address to Vault</button>",
    "            </form>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- WISHLIST & COMPARE MODALS -->",
    "    <div id=\"wishlist-modal\" class=\"fixed inset-0 z-[85] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-lg p-6 shadow-2xl relative border border-white/15 my-auto max-h-[85vh] flex flex-col\">",
    "            <button onclick=\"closeWishlistModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <h3 class=\"text-lg font-black text-white mb-4\"><i class=\"fa-solid fa-heart text-brandPrimary mr-2\"></i>Your Saved Wishlist</h3>",
    "            <div id=\"wishlist-items\" class=\"space-y-2.5 overflow-y-auto flex-grow\"></div>",
    "        </div>",
    "    </div>",
    "",
    "    <div id=\"compare-modal\" class=\"fixed inset-0 z-[85] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-3xl p-6 shadow-2xl relative border border-white/15 my-auto max-h-[88vh] overflow-y-auto\">",
    "            <button onclick=\"closeCompareModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <h3 class=\"text-lg font-black text-white mb-4\"><i class=\"fa-solid fa-scale-balanced text-brandPrimary mr-2\"></i>Side-by-Side Product Comparison</h3>",
    "            <div id=\"compare-table-wrap\" class=\"overflow-x-auto\"></div>",
    "        </div>",
    "    </div>",
    "",
    "    <!-- 5-TAB HANDS-FREE MERCHANT COMMAND CENTER (PIN: 9014) -->",
    "    <div id=\"admin-modal\" class=\"fixed inset-0 z-[90] bg-black/95 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto\">",
    "        <div class=\"glass rounded-2xl w-full max-w-4xl p-5 sm:p-6 shadow-2xl relative border border-white/15 my-auto max-h-[92vh] flex flex-col\">",
    "            <button onclick=\"closeAdminModal()\" class=\"absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center\"><i class=\"fa-solid fa-xmark\"></i></button>",
    "            <h3 class=\"text-xl font-black text-white mb-1\"><i class=\"fa-solid fa-user-shield text-brandPrimary mr-2\"></i>Prem's Hands-Free Merchant Portal v8.0</h3>",
    "            <p class=\"text-xs text-slate-400 mb-4\">View Payment Screenshots, Replacement Tickets, 8GB Storage Health, Inventory, Customer CRM &amp; Live Store Settings.</p>",
    "",
    "            <div id=\"admin-pin-gate\" class=\"flex space-x-2 mb-4 max-w-md\">",
    "                <input type=\"password\" id=\"admin-pin-input\" placeholder=\"Enter Merchant PIN (Default: 9014)\" class=\"w-full bg-darkSurface border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary\">",
    "                <button onclick=\"unlockAdminPanel()\" class=\"bg-brandPrimary text-white font-bold px-5 py-2.5 rounded-xl text-xs shrink-0\">Unlock</button>",
    "            </div>",
    "",
    "            <div id=\"admin-content\" class=\"hidden flex-col overflow-hidden flex-grow\">",
    "                <div class=\"flex space-x-2 border-b border-white/10 pb-2.5 mb-4 overflow-x-auto hide-scrollbar\">",
    "                    <button onclick=\"switchAdminTab('overview')\" id=\"atab-overview\" class=\"admin-tab-btn bg-brandPrimary text-white px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\">📊 Overview &amp; 8GB DB</button>",
    "                    <button onclick=\"switchAdminTab('orders')\" id=\"atab-orders\" class=\"admin-tab-btn bg-white/5 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\">📦 Orders &amp; Proofs</button>",
    "                    <button onclick=\"switchAdminTab('catalog')\" id=\"atab-catalog\" class=\"admin-tab-btn bg-white/5 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\">🏷️ Inventory</button>",
    "                    <button onclick=\"switchAdminTab('crm')\" id=\"atab-crm\" class=\"admin-tab-btn bg-white/5 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\">👥 CRM &amp; Tickets</button>",
    "                    <button onclick=\"switchAdminTab('settings')\" id=\"atab-settings\" class=\"admin-tab-btn bg-white/5 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\">⚙️ Live Settings</button>",
    "                    <button onclick=\"exportAdminCsv()\" class=\"ml-auto bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap\"><i class=\"fa-solid fa-file-csv mr-1\"></i>CSV</button>",
    "                </div>",
    "",
    "                <!-- TAB 1: OVERVIEW -->",
    "                <div id=\"apanel-overview\" class=\"admin-panel overflow-y-auto space-y-4 pr-1\">",
    "                    <div class=\"grid grid-cols-2 sm:grid-cols-4 gap-3\" id=\"admin-kpis\"></div>",
    "                    <div class=\"bg-darkSurface border border-white/10 rounded-xl p-4 space-y-2\">",
    "                        <div class=\"flex justify-between items-center text-xs\">",
    "                            <span class=\"font-bold text-white\"><i class=\"fa-solid fa-database text-brandPrimary mr-1.5\"></i>8 GB Scalable Storage Engine</span>",
    "                            <span id=\"db-engine-badge\" class=\"text-[10px] bg-emerald-500/15 text-emerald-400 px-2.5 py-0.5 rounded-full font-mono font-bold\"></span>",
    "                        </div>",
    "                        <div class=\"w-full bg-black h-2.5 rounded-full overflow-hidden border border-white/10\"><div id=\"db-usage-bar\" class=\"bg-gradient-to-r from-emerald-400 to-brandPrimary h-2.5 rounded-full\" style=\"width: 1%\"></div></div>",
    "                        <div id=\"db-stats-text\" class=\"text-[11px] text-slate-400 flex flex-wrap justify-between gap-2\"></div>",
    "                    </div>",
    "                    <div class=\"bg-darkSurface p-4 rounded-xl border border-white/10 space-y-3\">",
    "                        <h4 class=\"text-xs font-bold uppercase text-brandPrimary\">1-Tap Customer WhatsApp Notifier</h4>",
    "                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-2\">",
    "                            <input type=\"tel\" id=\"adm-cust-phone\" placeholder=\"Customer Phone (10 digits)\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                            <input type=\"text\" id=\"adm-order-id\" placeholder=\"Order ID (e.g. PREM-4915-01)\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white uppercase\">",
    "                            <input type=\"text\" id=\"adm-courier\" placeholder=\"Courier & AWB Tracking\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                        </div>",
    "                        <div class=\"flex flex-wrap gap-2\">",
    "                            <button onclick=\"sendMerchantWhatsApp('APPROVED')\" class=\"bg-emerald-500 text-black font-bold px-3 py-2 rounded-lg text-xs\">✅ Approved</button>",
    "                            <button onclick=\"sendMerchantWhatsApp('SHIPPED')\" class=\"bg-blue-500 text-white font-bold px-3 py-2 rounded-lg text-xs\">🚚 Shipped + AWB</button>",
    "                            <button onclick=\"sendMerchantWhatsApp('DELIVERED')\" class=\"bg-purple-500 text-white font-bold px-3 py-2 rounded-lg text-xs\">🎉 Delivered</button>",
    "                            <button onclick=\"sendMerchantWhatsApp('CANCELED')\" class=\"bg-red-500 text-white font-bold px-3 py-2 rounded-lg text-xs\">❌ Pending / Cancel</button>",
    "                        </div>",
    "                    </div>",
    "                </div>",
    "",
    "                <!-- TAB 2: ORDERS & PAYMENT SCREENSHOTS -->",
    "                <div id=\"apanel-orders\" class=\"admin-panel hidden overflow-y-auto space-y-3 pr-1\">",
    "                    <div class=\"flex flex-wrap gap-2 items-center\">",
    "                        <input type=\"text\" id=\"admin-order-search\" oninput=\"renderAdminOrdersList()\" placeholder=\"Search Last 4 Digits, Order ID, Phone...\" class=\"flex-grow bg-darkSurface border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                        <select id=\"admin-status-filter\" onchange=\"renderAdminOrdersList()\" class=\"bg-darkSurface border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                            <option value=\"ALL\">All Stages</option><option value=\"2\">Pending Verification</option><option value=\"3\">Approved / Packed</option><option value=\"4\">Shipped</option><option value=\"6\">Delivered</option><option value=\"0\">Canceled</option>",
    "                        </select>",
    "                        <button onclick=\"loadAdminDashboard()\" class=\"bg-white/10 text-white px-3 py-2 rounded-lg text-xs font-bold\"><i class=\"fa-solid fa-rotate\"></i></button>",
    "                    </div>",
    "                    <div id=\"admin-orders-list\" class=\"space-y-2.5 text-xs\"></div>",
    "                </div>",
    "",
    "                <!-- TAB 3: CATALOG -->",
    "                <div id=\"apanel-catalog\" class=\"admin-panel hidden overflow-y-auto space-y-4 pr-1\">",
    "                    <form onsubmit=\"saveAdminProduct(event)\" class=\"bg-darkSurface p-4 rounded-xl border border-white/10 space-y-2.5\">",
    "                        <h4 class=\"text-xs font-bold uppercase text-brandPrimary\">+ Add or Update Product</h4>",
    "                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-2\">",
    "                            <input type=\"number\" id=\"ap-id\" placeholder=\"Product ID (blank = New)\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                            <input type=\"text\" id=\"ap-title\" placeholder=\"Product Title *\" required class=\"sm:col-span-2 bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                        </div>",
    "                        <div class=\"grid grid-cols-1 sm:grid-cols-3 gap-2\">",
    "                            <input type=\"number\" id=\"ap-price\" placeholder=\"Price ₹ *\" required class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                            <input type=\"number\" id=\"ap-stock\" placeholder=\"Stock Qty *\" required value=\"15\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                            <select id=\"ap-cat\" class=\"bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                                <option>Spiritual &amp; Puja</option><option>Ayurveda &amp; Cow Care</option><option>Beauty &amp; Care</option><option>Home</option><option>Gear</option><option>Footwear</option><option>Apparel</option><option>Vehicle</option>",
    "                            </select>",
    "                        </div>",
    "                        <input type=\"url\" id=\"ap-img\" placeholder=\"Optional: Custom Supplier Image URL\" class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white\">",
    "                        <button type=\"submit\" class=\"bg-brandPrimary text-white font-bold px-4 py-2 rounded-lg text-xs\">Save Product</button>",
    "                    </form>",
    "                    <div id=\"admin-catalog-list\" class=\"grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs\"></div>",
    "                </div>",
    "",
    "                <!-- TAB 4: CRM & REPLACEMENT TICKETS -->",
    "                <div id=\"apanel-crm\" class=\"admin-panel hidden overflow-y-auto space-y-4 pr-1\">",
    "                    <div>",
    "                        <h4 class=\"text-xs font-bold uppercase text-amber-300 mb-2\">🎫 Priority Replacement Tickets</h4>",
    "                        <div id=\"admin-tickets-list\" class=\"space-y-2 text-xs\"></div>",
    "                    </div>",
    "                    <div>",
    "                        <h4 class=\"text-xs font-bold uppercase text-slate-400 mb-2\">👥 Customer CRM &amp; Saved Addresses</h4>",
    "                        <div id=\"admin-crm-list\" class=\"space-y-2 text-xs\"></div>",
    "                    </div>",
    "                </div>",
    "",
    "                <!-- TAB 5: LIVE REPLACEABLE SETTINGS -->",
    "                <div id=\"apanel-settings\" class=\"admin-panel hidden overflow-y-auto space-y-4 pr-1\">",
    "                    <form onsubmit=\"saveAdminSettings(event)\" class=\"bg-darkSurface p-4 rounded-xl border border-white/10 space-y-3 text-xs\">",
    "                        <h4 class=\"text-xs font-bold uppercase text-brandPrimary\">Live Store Settings (Zero-Code Updates)</h4>",
    "                        <div class=\"grid grid-cols-1 sm:grid-cols-2 gap-3\">",
    "                            <div><label class=\"text-slate-400 block mb-1\">Store Name</label><input type=\"text\" id=\"set-store-name\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white\"></div>",
    "                            <div><label class=\"text-slate-400 block mb-1\">UPI ID</label><input type=\"text\" id=\"set-upi\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white font-mono\"></div>",
    "                            <div><label class=\"text-slate-400 block mb-1\">UPI Payee Name</label><input type=\"text\" id=\"set-payee\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white\"></div>",
    "                            <div><label class=\"text-slate-400 block mb-1\">WhatsApp Number (with 91)</label><input type=\"text\" id=\"set-wa\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white font-mono\"></div>",
    "                            <div><label class=\"text-slate-400 block mb-1\">Promo Code</label><input type=\"text\" id=\"set-promo\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white uppercase font-mono\"></div>",
    "                            <div><label class=\"text-slate-400 block mb-1\">Promo Discount %</label><input type=\"number\" id=\"set-promo-pct\" min=\"0\" max=\"50\" required class=\"w-full bg-black border border-darkBorder rounded-lg px-3 py-2 text-white\"></div>",
    "                        </div>",
    "                        <button type=\"submit\" class=\"bg-emerald-500 hover:bg-emerald-600 text-black font-black px-5 py-2.5 rounded-xl text-xs\">Save Live Settings</button>",
    "                    </form>",
    "                </div>",
    "            </div>",
    "        </div>",
    "    </div>",
    "",
    "    <script>",
    "        var STORE_CONFIG = { storeName: \"Prem's Store\", upiId: \"premkumarmanthena289@oksbi\", payeeName: \"Prem Store\", whatsapp: \"919014044915\", promoCode: \"PREM10\", promoPercent: 10, freeShipThreshold: 999, freeGiftThreshold: 1499 };",
    "        var storeProducts = [];",
    "        var activeCategory = \"All\";",
    "        var cart = [];",
    "        var wishlist = [];",
    "        var savedAddresses = [];",
    "        var recentlyViewed = [];",
    "        var compareList = [];",
    "        var superCoins = 50;",
    "        var couponApplied = true; // Auto Best-Deal Engine enables promo automatically!",
    "        var orderBumpActive = false;",
    "        var cartTimerInterval = null;",
    "        var currentTrackedOrder = null;",
    "        var currentTrackedOrdersList = [];",
    "        var currentQuickViewId = null;",
    "        var lastConfirmedOrder = null;",
    "        var adminOrdersCache = [];",
    "        var adminTicketsCache = [];",
    "        var unlockedPin = '';",
    "",
    "        // Payment & Media State (Stored in 8GB DB!)",
    "        var selectedPaymentApp = '';",
    "        var paymentRedirectTriggered = false;",
    "        var paymentInitiatedTimestamp = null;",
    "        var paymentProofDataUrl = '';",
    "        var pendingAddressPhoto = '';",
    "        var pendingReviewPhoto = '';",
    "        var pendingReplacementPhoto = '';",
    "",
    "        // Client-Side Image Compressor (shrinks phone photos to ~35-50KB JPEG for fast 8GB DB storage)",
    "        function compressImageFile(file, maxW, quality, cb) {",
    "            if (!file) return cb('');",
    "            var reader = new FileReader();",
    "            reader.onload = function(ev) {",
    "                var img = new Image();",
    "                img.onload = function() {",
    "                    var ratio = Math.min(1, maxW / img.width);",
    "                    var canvas = document.createElement('canvas');",
    "                    canvas.width = Math.round(img.width * ratio);",
    "                    canvas.height = Math.round(img.height * ratio);",
    "                    var ctx = canvas.getContext('2d');",
    "                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);",
    "                    cb(canvas.toDataURL('image/jpeg', quality));",
    "                };",
    "                img.onerror = function() { cb(''); };",
    "                img.src = ev.target.result;",
    "            };",
    "            reader.readAsDataURL(file);",
    "        }",
    "",
    "        function handlePaymentScreenshotUpload(e) {",
    "            var file = e.target.files && e.target.files[0];",
    "            if (!file) return;",
    "            compressImageFile(file, 720, 0.72, function(dataUrl) {",
    "                if (!dataUrl) { showToast('Could not read image.'); return; }",
    "                paymentProofDataUrl = dataUrl;",
    "                document.getElementById('pay-proof-preview').src = dataUrl;",
    "                document.getElementById('pay-proof-preview-wrap').classList.remove('hidden');",
    "                document.getElementById('pay-photo-label').innerText = 'Screenshot Ready ✓';",
    "                if (!paymentRedirectTriggered) {",
    "                    paymentRedirectTriggered = true;",
    "                    selectedPaymentApp = selectedPaymentApp || 'UPI Screenshot';",
    "                    paymentInitiatedTimestamp = new Date().toISOString();",
    "                }",
    "                validateCheckoutUnlock();",
    "                showToast('Payment screenshot attached!');",
    "            });",
    "        }",
    "        function clearPaymentScreenshot() {",
    "            paymentProofDataUrl = '';",
    "            document.getElementById('pay-proof-file').value = '';",
    "            document.getElementById('pay-proof-preview-wrap').classList.add('hidden');",
    "            document.getElementById('pay-photo-label').innerText = 'Upload Payment Screenshot';",
    "            validateCheckoutUnlock();",
    "        }",
    "        function handleAddressPhotoSelect(e) {",
    "            var file = e.target.files && e.target.files[0];",
    "            if (!file) return;",
    "            compressImageFile(file, 480, 0.68, function(dataUrl) {",
    "                pendingAddressPhoto = dataUrl;",
    "                document.getElementById('ab-photo-lbl').innerText = 'Gate Photo Added ✓';",
    "                var p = document.getElementById('ab-photo-preview');",
    "                p.src = dataUrl; p.classList.remove('hidden');",
    "            });",
    "        }",
    "        function handleReviewPhotoSelect(e) {",
    "            var file = e.target.files && e.target.files[0];",
    "            if (!file) return;",
    "            compressImageFile(file, 540, 0.68, function(dataUrl) {",
    "                pendingReviewPhoto = dataUrl;",
    "                document.getElementById('rev-photo-label').innerText = 'Photo Attached ✓';",
    "            });",
    "        }",
    "        function handleReplacementPhotoSelect(e) {",
    "            var file = e.target.files && e.target.files[0];",
    "            if (!file) return;",
    "            compressImageFile(file, 640, 0.70, function(dataUrl) {",
    "                pendingReplacementPhoto = dataUrl;",
    "                document.getElementById('rpl-photo-lbl').innerText = 'Photo Added ✓';",
    "            });",
    "        }",
    "",
    "        function applyStoreConfigToUI() {",
    "            document.getElementById('upi-id-display').innerText = STORE_CONFIG.upiId;",
    "            document.getElementById('promo-bar-code').innerText = STORE_CONFIG.promoCode;",
    "            document.getElementById('coupon-input').value = STORE_CONFIG.promoCode;",
    "        }",
    "",
    "        function loadLocalState() {",
    "            try {",
    "                cart = JSON.parse(localStorage.getItem('prem_cart_v8') || localStorage.getItem('prem_cart_v7') || '[]');",
    "                wishlist = JSON.parse(localStorage.getItem('prem_wishlist_v8') || localStorage.getItem('prem_wishlist_v7') || '[]');",
    "                savedAddresses = JSON.parse(localStorage.getItem('prem_addresses_v8') || localStorage.getItem('prem_addresses_v7') || '[]');",
    "                recentlyViewed = JSON.parse(localStorage.getItem('prem_recent_v8') || localStorage.getItem('prem_recent_v7') || '[]');",
    "                var sc = localStorage.getItem('prem_coins_v8');",
    "                if (sc !== null) superCoins = Math.max(0, parseInt(sc, 10) || 0);",
    "            } catch (e) {}",
    "        }",
    "",
    "        function persistState() {",
    "            try {",
    "                localStorage.setItem('prem_cart_v8', JSON.stringify(cart));",
    "                localStorage.setItem('prem_wishlist_v8', JSON.stringify(wishlist));",
    "                localStorage.setItem('prem_addresses_v8', JSON.stringify(savedAddresses));",
    "                localStorage.setItem('prem_recent_v8', JSON.stringify(recentlyViewed.slice(0, 12)));",
    "                localStorage.setItem('prem_coins_v8', String(superCoins));",
    "            } catch (e) {}",
    "            var defAddr = savedAddresses.find(function(a) { return a.isDefault; }) || savedAddresses[0];",
    "            if (defAddr && defAddr.phone) {",
    "                fetch('/api/customer/sync', {",
    "                    method: 'POST', headers: { 'Content-Type': 'application/json' },",
    "                    body: JSON.stringify({ phone: defAddr.phone, name: defAddr.name, addresses: savedAddresses, wishlist: wishlist, cart: cart, superCoins: superCoins })",
    "                }).catch(function() {});",
    "            }",
    "            updateHeaderIndicators();",
    "        }",
    "",
    "        // RESTORE PROFILE FROM 8GB CLOUD VAULT BY PHONE",
    "        function openRestoreProfileModal() { var m = document.getElementById('restore-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }",
    "        function closeRestoreProfileModal() { var m = document.getElementById('restore-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        async function restoreCustomerProfile(e) {",
    "            e.preventDefault();",
    "            var ph = (document.getElementById('restore-phone-input').value || '').replace(/[^0-9]/g, '');",
    "            if (ph.length < 4) { showToast('Enter at least last 4 digits.'); return; }",
    "            try {",
    "                var res = await fetch('/api/customer/' + encodeURIComponent(ph));",
    "                var data = await res.json();",
    "                if (!res.ok || !data.found) { showToast('No saved cloud profile found for that number yet.'); return; }",
    "                var c = data.customer;",
    "                if (Array.isArray(c.addresses) && c.addresses.length) savedAddresses = c.addresses;",
    "                if (Array.isArray(c.cart) && c.cart.length) cart = c.cart;",
    "                if (Array.isArray(c.wishlist) && c.wishlist.length) wishlist = c.wishlist;",
    "                if (typeof c.superCoins === 'number') superCoins = c.superCoins;",
    "                persistState(); updateCartUI(); filterAndRenderCatalog(); closeRestoreProfileModal();",
    "                showToast('Welcome back, ' + (c.name || 'Friend') + '! Restored addresses, cart & ' + superCoins + ' SuperCoins.');",
    "            } catch (err) { showToast('Could not reach cloud vault.'); }",
    "        }",
    "",
    "",
    "        function escHtml(str) {",
    "            return String(str === undefined || str === null ? '' : str)",
    "                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');",
    "        }",
    "",
    "        // USP #3: 10-SECOND AI SMART PRODUCT FINDER & GIFT CONCIERGE",
    "        var finderPrefs = { who: 'self', goal: 'puja', budget: 'mid' };",
    "        var lastFinderMatchIds = [];",
    "",
    "        function openSmartFinderModal() {",
    "            renderSmartFinderResults();",
    "            var m = document.getElementById('finder-modal');",
    "            m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeSmartFinderModal() {",
    "            var m = document.getElementById('finder-modal');",
    "            m.classList.add('hidden'); m.classList.remove('flex');",
    "        }",
    "        function setFinderPref(key, val, btnEl) {",
    "            finderPrefs[key] = val;",
    "            document.querySelectorAll('.finder-' + key).forEach(function(b) {",
    "                b.className = 'finder-' + key + ' bg-white/5 text-slate-300 border border-white/10 font-bold py-2 px-2.5 rounded-xl';",
    "            });",
    "            if (btnEl) btnEl.className = 'finder-' + key + ' bg-brandPrimary text-white font-bold py-2 px-2.5 rounded-xl';",
    "            renderSmartFinderResults();",
    "        }",
    "        function renderSmartFinderResults() {",
    "            var box = document.getElementById('finder-results');",
    "            if (!storeProducts.length) { box.innerHTML = '<p class=\"text-xs text-slate-400\">Loading catalog...</p>'; return; }",
    "            var scored = storeProducts.map(function(p) {",
    "                var score = (p.rating || 4.7) * 10 + Math.min(20, (p.reviews || 0) / 100);",
    "                if (finderPrefs.goal === 'puja' && p.category === 'Spiritual & Puja') score += 60;",
    "                if (finderPrefs.goal === 'cowcare' && p.category === 'Ayurveda & Cow Care') score += 60;",
    "                if (finderPrefs.goal === 'beauty' && p.category === 'Beauty & Care') score += 60;",
    "                if (finderPrefs.goal === 'utility' && ['Home', 'Gear', 'Vehicle', 'Footwear', 'Apparel'].indexOf(p.category) !== -1) score += 60;",
    "                if (finderPrefs.who === 'home' && (p.category === 'Home' || p.category === 'Spiritual & Puja')) score += 18;",
    "                if (finderPrefs.who === 'gift' && (p.category === 'Spiritual & Puja' || p.category === 'Ayurveda & Cow Care')) score += 18;",
    "                if (finderPrefs.who === 'commute' && (p.category === 'Vehicle' || p.category === 'Gear' || p.category === 'Footwear')) score += 22;",
    "                if (finderPrefs.budget === 'low' && p.price <= 500) score += 35;",
    "                else if (finderPrefs.budget === 'mid' && p.price > 500 && p.price <= 1500) score += 35;",
    "                else if (finderPrefs.budget === 'high' && p.price > 1500) score += 35;",
    "                return { prod: p, score: score };",
    "            });",
    "            scored.sort(function(a, b) { return b.score - a.score; });",
    "            var top3 = scored.slice(0, 3).map(function(x) { return x.prod; });",
    "            lastFinderMatchIds = top3.map(function(p) { return p.id; });",
    "            box.innerHTML = top3.map(function(p, idx) {",
    "                return '<div class=\"bg-darkSurface border border-white/10 rounded-xl p-3 flex items-center justify-between gap-3\">' +",
    "                    '<div class=\"flex items-center space-x-3 overflow-hidden\">' +",
    "                        '<img src=\"' + getProductImage(p) + '\" class=\"w-14 h-14 rounded-lg object-cover shrink-0 bg-black border border-white/10\">' +",
    "                        '<div class=\"overflow-hidden\">' +",
    "                            '<span class=\"text-[9px] bg-emerald-500/20 text-emerald-300 font-black px-2 py-0.5 rounded-full uppercase\">#' + (idx + 1) + ' Best Match • ★ ' + p.rating + '</span>' +",
    "                            '<p class=\"text-xs font-black text-white truncate mt-1\">' + escHtml(p.title) + '</p>' +",
    "                            '<p class=\"text-[11px] text-brandPrimary font-black\">₹' + p.price.toLocaleString('en-IN') + ' <span class=\"text-slate-400 font-normal\">• ' + escHtml(p.category) + '</span></p>' +",
    "                        '</div>' +",
    "                    '</div>' +",
    "                    '<button type=\"button\" onclick=\"addToCart(' + p.id + ', true); closeSmartFinderModal()\" class=\"bg-white/10 hover:bg-brandPrimary text-white text-[11px] font-bold px-3 py-2 rounded-xl shrink-0 transition-colors\">Add</button>' +",
    "                '</div>';",
    "            }).join('');",
    "        }",
    "        function addAllFinderMatches() {",
    "            if (!lastFinderMatchIds.length) return;",
    "            lastFinderMatchIds.forEach(function(id) { addToCart(id, false); });",
    "            closeSmartFinderModal();",
    "            toggleCart();",
    "            showToast('All 3 personalized matches added with 15% Bundle Savings!');",
    "        }",
    "",
    "        // USP #1: SMART KIT BUILDER (15% OFF)",
    "        var CURATED_KITS = [",
    "            { id: 'puja', icon: '🕉️', name: 'Sacred Home Mandir Kit', subtitle: 'Rudraksha Mala + Brass Akhand Diya + Bhimseni Camphor + 100 Cow Ghee Battis', productIds: [51, 53, 54, 64] },",
    "            { id: 'cowcare', icon: '🌿', name: 'Pure Vedic Cow & Glycerin Care Kit', subtitle: 'Bilona A2 Gir Cow Ghee + USP Glycerin + Glycerin Rose Soap + Rose Glow Mist', productIds: [61, 59, 60, 65] },",
    "            { id: 'beauty', icon: '✨', name: 'Glass-Skin Night Beauty Kit', subtitle: '7-Color LED Face Mask + Cryo Ice Roller & Gua Sha + Silicone Eye Patches', productIds: [42, 45, 46] },",
    "            { id: 'monsoon', icon: '☔', name: 'Monsoon Commuter Shield Kit', subtitle: 'Reverse LED Umbrella + Anti-Fog Helmet Film + Waterproof Bag Cover + Shoe Protectors', productIds: [2, 4, 7, 22] }",
    "        ];",
    "        function openKitBuilderModal() {",
    "            var grid = document.getElementById('kit-cards-grid');",
    "            grid.innerHTML = CURATED_KITS.map(function(kit) {",
    "                var items = kit.productIds.map(function(id) { return storeProducts.find(function(p) { return p.id === id; }); }).filter(Boolean);",
    "                var rawSum = items.reduce(function(s, p) { return s + p.price; }, 0);",
    "                var kitPrice = Math.round(rawSum * 0.85);",
    "                var saveAmt = rawSum - kitPrice;",
    "                return '<div class=\"bg-darkSurface border border-white/10 hover:border-brandPrimary/50 rounded-2xl p-4 flex flex-col justify-between space-y-3\">' +",
    "                    '<div><div class=\"flex items-center justify-between mb-1\"><span class=\"text-2xl\">' + kit.icon + '</span><span class=\"text-[10px] bg-emerald-500/20 text-emerald-300 font-black px-2 py-0.5 rounded-full\">Save ₹' + saveAmt + ' (15% OFF)</span></div>' +",
    "                    '<h4 class=\"font-black text-white text-base\">' + kit.name + '</h4><p class=\"text-[11px] text-slate-400 mt-1\">' + kit.subtitle + '</p></div>' +",
    "                    '<div class=\"flex items-center justify-between pt-2 border-t border-white/10\"><div><span class=\"text-[11px] text-slate-500 line-through block\">₹' + rawSum.toLocaleString('en-IN') + '</span><span class=\"text-lg font-black text-brandPrimary\">₹' + kitPrice.toLocaleString('en-IN') + '</span></div>' +",
    "                    '<button onclick=\"addCuratedKit(\\'' + kit.id + '\\')\" class=\"bg-brandPrimary hover:bg-pink-600 text-white font-black px-4 py-2.5 rounded-xl text-xs\">Add Full Kit</button></div></div>';",
    "            }).join('');",
    "            var m = document.getElementById('kit-modal'); m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeKitBuilderModal() { var m = document.getElementById('kit-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        function addCuratedKit(kitId) {",
    "            var kit = CURATED_KITS.find(function(k) { return k.id === kitId; });",
    "            if (!kit) return;",
    "            kit.productIds.forEach(function(id) { addToCart(id, false); });",
    "            closeKitBuilderModal();",
    "            toggleCart();",
    "            showToast(kit.name + ' added! 15% Bundle + Free Gift unlocked!');",
    "        }",
    "",
    "        // BESPOKE 100% MATCHING STUDIO PRODUCT ARTWORK ENGINE",
    "        function getProductImage(prod) {",
    "            if (prod.customImage && prod.customImage.indexOf('http') === 0) return prod.customImage;",
    "            var accent = prod.artAccent || '#FF3366';",
    "            var type = prod.artType || 'generic_box';",
    "            var shapeSvg = '';",
    "            if (type === 'rudraksha_mala') {",
    "                var beads = '';",
    "                for (var i = 0; i < 18; i++) {",
    "                    var ang = (i / 18) * Math.PI * 2;",
    "                    var cx = (200 + Math.cos(ang) * 78).toFixed(1), cy = (132 + Math.sin(ang) * 78).toFixed(1);",
    "                    beads += '<circle cx=\"' + cx + '\" cy=\"' + cy + '\" r=\"11\" fill=\"url(#rudra)\" stroke=\"#451a03\" stroke-width=\"1.5\"/>';",
    "                }",
    "                shapeSvg = '<defs><radialGradient id=\"rudra\" cx=\"35%\" cy=\"35%\"><stop offset=\"0%\" stop-color=\"#d97706\"/><stop offset=\"60%\" stop-color=\"#92400e\"/><stop offset=\"100%\" stop-color=\"#451a03\"/></radialGradient></defs><circle cx=\"200\" cy=\"132\" r=\"78\" fill=\"none\" stroke=\"#b91c1c\" stroke-width=\"3\"/>' + beads + '<circle cx=\"200\" cy=\"216\" r=\"13\" fill=\"url(#rudra)\" stroke=\"#fbbf24\" stroke-width=\"2\"/><path d=\"M194 228 L186 268 L214 268 L206 228 Z\" fill=\"#dc2626\"/>';",
    "            } else if (type === 'rudraksha_pendant') {",
    "                shapeSvg = '<defs><radialGradient id=\"rudraP\" cx=\"35%\" cy=\"35%\"><stop offset=\"0%\" stop-color=\"#f59e0b\"/><stop offset=\"65%\" stop-color=\"#92400e\"/><stop offset=\"100%\" stop-color=\"#451a03\"/></radialGradient></defs><path d=\"M140 30 Q200 130 260 30\" fill=\"none\" stroke=\"#dc2626\" stroke-width=\"5\"/><circle cx=\"200\" cy=\"175\" r=\"46\" fill=\"url(#rudraP)\" stroke=\"#fbbf24\" stroke-width=\"2\"/><path d=\"M180 218 L220 218 L200 236 Z\" fill=\"#cbd5e1\"/>';",
    "            } else if (type === 'brass_diya') {",
    "                shapeSvg = '<defs><linearGradient id=\"brass\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#fde047\"/><stop offset=\"50%\" stop-color=\"#d97706\"/><stop offset=\"100%\" stop-color=\"#78350f\"/></linearGradient></defs><rect x=\"148\" y=\"64\" width=\"104\" height=\"135\" rx=\"14\" fill=\"rgba(255,255,255,0.08)\" stroke=\"rgba(255,255,255,0.35)\" stroke-width=\"2\"/><path d=\"M200 84 Q222 122 200 154 Q178 122 200 84 Z\" fill=\"#fb923c\"/><path d=\"M200 102 Q212 126 200 146 Q188 126 200 102 Z\" fill=\"#fef08a\"/><ellipse cx=\"200\" cy=\"198\" rx=\"68\" ry=\"18\" fill=\"url(#brass)\"/><path d=\"M148 198 L166 236 L234 236 L252 198 Z\" fill=\"url(#brass)\"/>';",
    "            } else if (type === 'camphor_jar') {",
    "                shapeSvg = '<rect x=\"132\" y=\"88\" width=\"136\" height=\"148\" rx=\"18\" fill=\"rgba(255,255,255,0.12)\" stroke=\"#e2e8f0\" stroke-width=\"2.5\"/><rect x=\"144\" y=\"62\" width=\"112\" height=\"28\" rx=\"6\" fill=\"#d97706\"/><rect x=\"148\" y=\"114\" width=\"104\" height=\"44\" rx=\"6\" fill=\"#78350f\"/><text x=\"200\" y=\"135\" fill=\"#fde047\" font-size=\"11\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">BHIMSENI</text><text x=\"200\" y=\"150\" fill=\"#ffffff\" font-size=\"10\" font-weight=\"700\" text-anchor=\"middle\" font-family=\"sans-serif\">PURE CAMPHOR</text>';",
    "            } else if (type === 'chandan_paste') {",
    "                shapeSvg = '<path d=\"M126 146 L136 224 Q200 244 264 224 L274 146 Z\" fill=\"#b45309\" stroke=\"#fbbf24\" stroke-width=\"2\"/><ellipse cx=\"200\" cy=\"146\" rx=\"74\" ry=\"22\" fill=\"#f59e0b\"/><ellipse cx=\"200\" cy=\"146\" rx=\"60\" ry=\"15\" fill=\"#fde68a\"/><text x=\"200\" y=\"198\" fill=\"#fef3c7\" font-size=\"12\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">MYSORE CHANDAN</text>';",
    "            } else if (type === 'brass_idol') {",
    "                shapeSvg = '<defs><linearGradient id=\"goldI\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#fde047\"/><stop offset=\"100%\" stop-color=\"#78350f\"/></linearGradient></defs><ellipse cx=\"200\" cy=\"236\" rx=\"92\" ry=\"16\" fill=\"#78350f\"/><circle cx=\"152\" cy=\"134\" r=\"24\" fill=\"url(#goldI)\"/><path d=\"M122 232 Q128 164 152 164 Q176 164 182 232 Z\" fill=\"url(#goldI)\"/><circle cx=\"248\" cy=\"134\" r=\"22\" fill=\"url(#goldI)\"/><path d=\"M220 232 Q226 164 248 164 Q270 164 276 232 Z\" fill=\"url(#goldI)\"/><text x=\"200\" y=\"72\" fill=\"#fde047\" font-size=\"22\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">ॐ</text>';",
    "            } else if (type === 'copper_kalash') {",
    "                shapeSvg = '<defs><linearGradient id=\"cop\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#fb923c\"/><stop offset=\"100%\" stop-color=\"#7c2d12\"/></linearGradient></defs><ellipse cx=\"200\" cy=\"236\" rx=\"108\" ry=\"18\" fill=\"url(#cop)\"/><circle cx=\"200\" cy=\"176\" r=\"52\" fill=\"url(#cop)\"/><path d=\"M168 128 L178 106 L222 106 L232 128 Z\" fill=\"url(#cop)\"/><path d=\"M174 104 Q158 76 184 90 M226 104 Q242 76 216 90\" stroke=\"#22c55e\" stroke-width=\"5\" stroke-linecap=\"round\"/>';",
    "            } else if (type === 'sambrani_cups' || type === 'cow_dhoop') {",
    "                shapeSvg = '<path d=\"M185 110 Q175 84 192 64 Q205 46 196 30\" stroke=\"rgba(255,255,255,0.45)\" stroke-width=\"4\" fill=\"none\" stroke-linecap=\"round\"/><path d=\"M150 144 L166 226 L234 226 L250 144 Z\" fill=\"#78350f\" stroke=\"#d97706\" stroke-width=\"2\"/><ellipse cx=\"200\" cy=\"142\" rx=\"34\" ry=\"9\" fill=\"#f97316\"/>';",
    "            } else if (type === 'glycerin_bottle' || type === 'rose_glycerin') {",
    "                var liquid = type === 'rose_glycerin' ? '#fb7185' : '#38bdf8';",
    "                var lbl = type === 'rose_glycerin' ? 'ROSE + GLYCERIN' : '100% USP GLYCERIN';",
    "                shapeSvg = '<rect x=\"176\" y=\"48\" width=\"48\" height=\"26\" rx=\"6\" fill=\"#e2e8f0\"/><rect x=\"142\" y=\"90\" width=\"116\" height=\"154\" rx=\"22\" fill=\"rgba(255,255,255,0.12)\" stroke=\"' + liquid + '\" stroke-width=\"2.5\"/><rect x=\"148\" y=\"128\" width=\"104\" height=\"110\" rx=\"16\" fill=\"' + liquid + '\" opacity=\"0.28\"/><rect x=\"150\" y=\"138\" width=\"100\" height=\"58\" rx=\"8\" fill=\"#0f172a\" stroke=\"' + liquid + '\" stroke-width=\"1.5\"/><text x=\"200\" y=\"166\" fill=\"#ffffff\" font-size=\"9.5\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">' + lbl + '</text>';",
    "            } else if (type === 'glycerin_soap' || type === 'panchagavya_soap') {",
    "                var sc1 = type === 'panchagavya_soap' ? '#65a30d' : '#fb7185', sc2 = type === 'panchagavya_soap' ? '#3f6212' : '#be123c';",
    "                var slbl = type === 'panchagavya_soap' ? 'PANCHAGAVYA' : 'PURE GLYCERIN';",
    "                shapeSvg = '<rect x=\"112\" y=\"124\" width=\"144\" height=\"86\" rx=\"18\" fill=\"' + sc2 + '\" transform=\"rotate(-8 184 167)\"/><rect x=\"136\" y=\"136\" width=\"152\" height=\"90\" rx=\"18\" fill=\"' + sc1 + '\" stroke=\"rgba(255,255,255,0.45)\" stroke-width=\"2\"/><text x=\"212\" y=\"184\" fill=\"#ffffff\" font-size=\"11\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">' + slbl + '</text>';",
    "            } else if (type === 'cow_ghee') {",
    "                shapeSvg = '<defs><linearGradient id=\"gheeG\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#fde047\"/><stop offset=\"100%\" stop-color=\"#d97706\"/></linearGradient></defs><rect x=\"148\" y=\"64\" width=\"104\" height=\"26\" rx=\"6\" fill=\"#92400e\"/><rect x=\"128\" y=\"90\" width=\"144\" height=\"150\" rx=\"22\" fill=\"url(#gheeG)\" stroke=\"#fef08a\" stroke-width=\"2.5\"/><rect x=\"138\" y=\"130\" width=\"124\" height=\"72\" rx=\"10\" fill=\"#1c1917\" stroke=\"#fbbf24\" stroke-width=\"1.5\"/><text x=\"200\" y=\"156\" fill=\"#fde047\" font-size=\"11\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">BILONA A2 GIR</text><text x=\"200\" y=\"176\" fill=\"#ffffff\" font-size=\"13\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">DESI COW GHEE</text>';",
    "            } else if (type === 'ghee_batti') {",
    "                shapeSvg = '<rect x=\"124\" y=\"114\" width=\"152\" height=\"114\" rx=\"18\" fill=\"rgba(255,255,255,0.1)\" stroke=\"#fbbf24\" stroke-width=\"2\"/><circle cx=\"164\" cy=\"156\" r=\"16\" fill=\"#fde047\"/><circle cx=\"200\" cy=\"156\" r=\"16\" fill=\"#fde047\"/><circle cx=\"236\" cy=\"156\" r=\"16\" fill=\"#fde047\"/><text x=\"200\" y=\"206\" fill=\"#fef08a\" font-size=\"11\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">100 COW GHEE BATTIS</text>';",
    "            } else if (type === 'cow_upla') {",
    "                shapeSvg = '<ellipse cx=\"200\" cy=\"212\" rx=\"76\" ry=\"26\" fill=\"#78350f\" stroke=\"#b45309\" stroke-width=\"2\"/><ellipse cx=\"200\" cy=\"182\" rx=\"76\" ry=\"26\" fill=\"#92400e\" stroke=\"#d97706\" stroke-width=\"2\"/><ellipse cx=\"200\" cy=\"152\" rx=\"76\" ry=\"26\" fill=\"#78350f\" stroke=\"#f59e0b\" stroke-width=\"2\"/><text x=\"200\" y=\"156\" fill=\"#fef3c7\" font-size=\"11\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">VEDIC HAVAN UPLA</text>';",
    "            } else if (type === 'led_mask') {",
    "                shapeSvg = '<path d=\"M138 96 Q200 58 262 96 L254 196 Q200 248 146 196 Z\" fill=\"#1e1b4b\" stroke=\"#FF3366\" stroke-width=\"3\"/><ellipse cx=\"174\" cy=\"138\" rx=\"16\" ry=\"9\" fill=\"#09090b\" stroke=\"#38bdf8\" stroke-width=\"2\"/><ellipse cx=\"226\" cy=\"138\" rx=\"16\" ry=\"9\" fill=\"#09090b\" stroke=\"#38bdf8\" stroke-width=\"2\"/>';",
    "            } else if (type === 'umbrella') {",
    "                shapeSvg = '<path d=\"M108 152 Q200 54 292 152 Q246 138 200 152 Q154 138 108 152 Z\" fill=\"#4f46e5\" stroke=\"#a5b4fc\" stroke-width=\"2\"/><line x1=\"200\" y1=\"150\" x2=\"200\" y2=\"232\" stroke=\"#e2e8f0\" stroke-width=\"5\"/>';",
    "            } else {",
    "                var iconChar = prod.category === 'Vehicle' ? '🚗' : (prod.category === 'Footwear' ? '👟' : (prod.category === 'Apparel' ? '🧥' : (prod.category === 'Beauty & Care' ? '✨' : (prod.category === 'Home' ? '🏠' : '⚡'))));",
    "                shapeSvg = '<rect x=\"120\" y=\"66\" width=\"160\" height=\"160\" rx=\"34\" fill=\"rgba(255,255,255,0.05)\" stroke=\"' + accent + '\" stroke-width=\"2.5\"/><circle cx=\"200\" cy=\"134\" r=\"44\" fill=\"' + accent + '\" opacity=\"0.22\"/><text x=\"200\" y=\"150\" font-size=\"46\" text-anchor=\"middle\">' + iconChar + '</text><rect x=\"136\" y=\"192\" width=\"128\" height=\"24\" rx=\"8\" fill=\"' + accent + '\" opacity=\"0.9\"/><text x=\"200\" y=\"208\" fill=\"#09090b\" font-size=\"10\" font-weight=\"900\" text-anchor=\"middle\" font-family=\"sans-serif\">' + String(prod.category).toUpperCase().slice(0, 16) + '</text>';",
    "            }",
    "            var shortCap = String(prod.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 32);",
    "            var svg = '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 300\"><defs><radialGradient id=\"bgG\" cx=\"50%\" cy=\"42%\" r=\"65%\"><stop offset=\"0%\" stop-color=\"' + accent + '\" stop-opacity=\"0.26\"/><stop offset=\"100%\" stop-color=\"#09090b\" stop-opacity=\"1\"/></radialGradient></defs><rect width=\"400\" height=\"300\" fill=\"#0c0c10\"/><rect width=\"400\" height=\"300\" fill=\"url(#bgG)\"/><ellipse cx=\"200\" cy=\"252\" rx=\"108\" ry=\"14\" fill=\"rgba(0,0,0,0.65)\"/>' + shapeSvg + '<text x=\"200\" y=\"284\" fill=\"rgba(255,255,255,0.65)\" font-size=\"10.5\" font-weight=\"700\" text-anchor=\"middle\" font-family=\"sans-serif\">' + shortCap + '</text></svg>';",
    "            return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);",
    "        }",
    "",
    "        function showToast(msg) {",
    "            var box = document.getElementById('toast-box');",
    "            document.getElementById('toast-text').innerText = msg;",
    "            box.classList.remove('hidden');",
    "            clearTimeout(window._toastT);",
    "            window._toastT = setTimeout(function() { box.classList.add('hidden'); }, 3500);",
    "        }",
    "        function getDeliveryWindowString() {",
    "            var today = new Date(), minD = new Date(today), maxD = new Date(today);",
    "            minD.setDate(today.getDate() + 4); maxD.setDate(today.getDate() + 6);",
    "            var opts = { month: 'short', day: 'numeric' };",
    "            return minD.toLocaleDateString('en-IN', opts) + ' - ' + maxD.toLocaleDateString('en-IN', opts);",
    "        }",
    "        function updateHeaderIndicators() {",
    "            document.getElementById('header-coins').innerText = superCoins;",
    "            document.getElementById('cart-avail-coins').innerText = superCoins;",
    "            document.getElementById('cart-coins-val').innerText = '-₹' + Math.min(superCoins, 250);",
    "            var wlBadge = document.getElementById('wishlist-count');",
    "            wlBadge.innerText = wishlist.length;",
    "            wlBadge.classList.toggle('hidden', wishlist.length === 0);",
    "            var defAddr = savedAddresses.find(function(a) { return a.isDefault; }) || savedAddresses[0];",
    "            document.getElementById('header-deliver-to').innerText = defAddr ? (defAddr.label + ' • ' + (defAddr.landmark || defAddr.pincode)) : 'Add Address';",
    "            document.getElementById('hero-addr-count').innerText = savedAddresses.length > 0 ? (savedAddresses.length + ' Saved in Vault') : 'Save landmarks & gate photo';",
    "        }",
    "        function quickSearchTag(term) { document.getElementById('search-input').value = term; setCategoryFilter('All'); }",
    "        function setCategoryFilter(category) {",
    "            activeCategory = category;",
    "            document.querySelectorAll('.cat-btn').forEach(function(btn) {",
    "                btn.className = (btn.getAttribute('data-cat') === category)",
    "                    ? \"cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold transition-all whitespace-nowrap shadow\"",
    "                    : \"cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap\";",
    "            });",
    "            filterAndRenderCatalog();",
    "        }",
    "        function clearSearch() { document.getElementById('search-input').value = ''; filterAndRenderCatalog(); }",
    "",
    "        function filterAndRenderCatalog() {",
    "            var grid = document.getElementById('product-grid');",
    "            var searchVal = (document.getElementById('search-input').value || '').trim().toLowerCase();",
    "            var sortVal = document.getElementById('sort-select').value;",
    "            document.getElementById('clear-search-btn').classList.toggle('hidden', searchVal.length === 0);",
    "            var filtered = storeProducts.filter(function(item) {",
    "                return (activeCategory === \"All\" || item.category === activeCategory) &&",
    "                    (!searchVal || item.title.toLowerCase().indexOf(searchVal) !== -1 || item.description.toLowerCase().indexOf(searchVal) !== -1 || item.category.toLowerCase().indexOf(searchVal) !== -1);",
    "            });",
    "            if (sortVal === 'price-asc') filtered.sort(function(a, b) { return a.price - b.price; });",
    "            else if (sortVal === 'price-desc') filtered.sort(function(a, b) { return b.price - a.price; });",
    "            else if (sortVal === 'rating') filtered.sort(function(a, b) { return b.rating - a.rating; });",
    "            else if (sortVal === 'reviews') filtered.sort(function(a, b) { return b.reviews - a.reviews; });",
    "",
    "            document.getElementById('results-counter').innerText = 'Showing ' + filtered.length + ' of ' + storeProducts.length + ' products';",
    "            if (!filtered.length) {",
    "                grid.innerHTML = '<div class=\"col-span-full text-center py-14 glass rounded-2xl\"><p class=\"text-sm text-slate-300 font-bold\">No matching products.</p><button onclick=\"clearSearch(); setCategoryFilter(\\'All\\')\" class=\"mt-3 bg-brandPrimary text-white text-xs font-bold px-4 py-2 rounded-full\">Show All</button></div>';",
    "                return;",
    "            }",
    "            grid.innerHTML = filtered.map(function(prod) {",
    "                var mrp = Math.round(prod.price * 1.35), saveAmt = mrp - prod.price;",
    "                var isWished = wishlist.indexOf(prod.id) !== -1, isCompared = compareList.indexOf(prod.id) !== -1;",
    "                return '<div class=\"bg-darkSurface rounded-2xl border border-darkBorder flex flex-col group relative overflow-hidden hover:border-brandPrimary/50 transition-all duration-300 shadow-lg\">' +",
    "                    '<span class=\"absolute top-2.5 left-2.5 bg-brandPrimary text-white text-[9px] font-black px-2.5 py-1 rounded-full uppercase z-10\">' + prod.badge + '</span>' +",
    "                    '<div class=\"absolute top-2.5 right-2.5 z-10 flex space-x-1\">' +",
    "                        '<button onclick=\"toggleWishlist(' + prod.id + ')\" class=\"w-8 h-8 rounded-full bg-black/70 hover:bg-brandPrimary text-white flex items-center justify-center\"><i class=\"' + (isWished ? 'fa-solid text-brandPrimary' : 'fa-regular') + ' fa-heart text-xs\"></i></button>' +",
    "                        '<button onclick=\"toggleCompare(' + prod.id + ')\" class=\"w-8 h-8 rounded-full ' + (isCompared ? 'bg-brandPrimary text-white' : 'bg-black/70 text-slate-300') + ' flex items-center justify-center\"><i class=\"fa-solid fa-scale-balanced text-[11px]\"></i></button>' +",
    "                    '</div>' +",
    "                    '<div onclick=\"openQuickView(' + prod.id + ')\" class=\"relative bg-black overflow-hidden aspect-[4/3] cursor-pointer\"><img src=\"' + getProductImage(prod) + '\" alt=\"' + prod.title.replace(/\"/g, '') + '\" loading=\"lazy\" class=\"w-full h-full object-cover group-hover:scale-105 transition-transform duration-500\"></div>' +",
    "                    '<div class=\"p-4 flex flex-col flex-grow\">' +",
    "                        '<div class=\"flex items-center justify-between text-[10px] mb-1.5\"><span class=\"text-slate-400 font-bold uppercase\">' + prod.category + '</span><span class=\"text-amber-400 font-bold\">★ ' + prod.rating + ' <span class=\"text-slate-500\">(' + prod.reviews + ')</span></span></div>' +",
    "                        '<h3 onclick=\"openQuickView(' + prod.id + ')\" class=\"font-extrabold text-white text-sm leading-snug mb-1.5 cursor-pointer group-hover:text-brandPrimary line-clamp-2\">' + prod.title + '</h3>' +",
    "                        '<p class=\"text-[11px] text-slate-400 line-clamp-2 mb-3\">' + prod.description + '</p>' +",
    "                        '<div class=\"mt-auto\"><div class=\"flex items-center justify-between text-[10px] mb-2\"><span class=\"text-red-400 font-bold\"><i class=\"fa-solid fa-fire mr-1\"></i>' + (prod.stock > 0 ? ('Only ' + prod.stock + ' left') : 'Out of Stock') + '</span><span class=\"text-emerald-400 font-bold\">Save ₹' + saveAmt + '</span></div>' +",
    "                        '<div class=\"flex justify-between items-center pt-2.5 border-t border-darkBorder gap-2\"><div><span class=\"text-[10px] text-slate-500 line-through block -mb-0.5 font-mono\">₹' + mrp.toLocaleString('en-IN') + '</span><span class=\"text-lg font-black text-white\">₹' + prod.price.toLocaleString('en-IN') + '</span></div>' +",
    "                        '<div class=\"flex items-center space-x-1.5\"><button onclick=\"addToCart(' + prod.id + ', false)\" class=\"bg-white/5 hover:bg-white/15 text-white w-9 h-9 rounded-xl border border-white/10 flex items-center justify-center\"><i class=\"fa-solid fa-cart-plus text-xs\"></i></button><button onclick=\"buyNowDirect(' + prod.id + ')\" class=\"bg-brandPrimary hover:bg-pink-600 text-white text-xs font-extrabold px-3.5 py-2.5 rounded-xl shadow\">Buy Now</button></div></div></div>' +",
    "                    '</div></div>';",
    "            }).join('');",
    "        }",
    "",
    "        function trackRecentlyViewed(id) { recentlyViewed = [id].concat(recentlyViewed.filter(function(x) { return x !== id; })).slice(0, 10); persistState(); renderRecentlyViewed(); }",
    "        function clearRecentlyViewed() { recentlyViewed = []; persistState(); renderRecentlyViewed(); }",
    "        function renderRecentlyViewed() {",
    "            var sec = document.getElementById('recently-viewed-section'), list = document.getElementById('recently-viewed-list');",
    "            if (!recentlyViewed.length || !storeProducts.length) { sec.classList.add('hidden'); return; }",
    "            sec.classList.remove('hidden');",
    "            list.innerHTML = recentlyViewed.map(function(id) {",
    "                var p = storeProducts.find(function(x) { return x.id === id; }); if (!p) return '';",
    "                return '<div onclick=\"openQuickView(' + p.id + ')\" class=\"shrink-0 w-44 bg-darkSurface border border-darkBorder hover:border-brandPrimary/50 rounded-xl p-2 flex items-center space-x-2.5 cursor-pointer\"><img src=\"' + getProductImage(p) + '\" class=\"w-11 h-11 rounded-lg object-cover shrink-0\"><div class=\"overflow-hidden\"><p class=\"text-[11px] font-bold text-white truncate\">' + p.title + '</p><p class=\"text-xs font-black text-brandPrimary\">₹' + p.price + '</p></div></div>';",
    "            }).join('');",
    "        }",
    "",
    "        async function openQuickView(id) {",
    "            var prod = storeProducts.find(function(p) { return p.id === id; }); if (!prod) return;",
    "            currentQuickViewId = id; pendingReviewPhoto = ''; trackRecentlyViewed(id);",
    "            var mrp = Math.round(prod.price * 1.35);",
    "            document.getElementById('qv-img').src = getProductImage(prod);",
    "            document.getElementById('qv-badge').innerText = prod.badge;",
    "            document.getElementById('qv-cat').innerText = prod.category;",
    "            document.getElementById('qv-rating').innerText = prod.rating + ' (' + prod.reviews + ' Verified)';",
    "            document.getElementById('qv-title').innerText = prod.title;",
    "            document.getElementById('qv-price').innerText = '₹' + prod.price.toLocaleString('en-IN');",
    "            document.getElementById('qv-mrp').innerText = '₹' + mrp.toLocaleString('en-IN');",
    "            document.getElementById('qv-save').innerText = 'Save ₹' + (mrp - prod.price);",
    "            document.getElementById('qv-desc').innerText = prod.description;",
    "            document.getElementById('qv-highlights').innerHTML = (prod.highlights || []).map(function(h) { return '<li class=\"flex items-start space-x-1.5\"><i class=\"fa-solid fa-check text-emerald-400 mt-0.5\"></i><span>' + h + '</span></li>'; }).join('');",
    "            var specs = prod.specs || {};",
    "            document.getElementById('qv-specs').innerHTML = Object.keys(specs).map(function(k) { return '<div class=\"bg-darkSurface p-2 rounded-lg border border-white/5\"><span class=\"text-slate-400 block text-[10px]\">' + k + '</span><strong class=\"text-white\">' + specs[k] + '</strong></div>'; }).join('');",
    "            var fbtBox = document.getElementById('qv-fbt-box'), fbtProd = prod.fbtId ? storeProducts.find(function(x) { return x.id === prod.fbtId; }) : null;",
    "            if (fbtProd) {",
    "                fbtBox.classList.remove('hidden');",
    "                document.getElementById('qv-fbt-img').src = getProductImage(fbtProd);",
    "                document.getElementById('qv-fbt-title').innerText = '+ ' + fbtProd.title;",
    "                document.getElementById('qv-fbt-price').innerText = 'Bundle Both: ₹' + Math.max(99, prod.price + fbtProd.price - 100).toLocaleString('en-IN');",
    "                document.getElementById('qv-fbt-btn').onclick = function() { addToCart(prod.id, false); addToCart(fbtProd.id, true); closeQuickView(); showToast('Bundle added!'); };",
    "            } else fbtBox.classList.add('hidden');",
    "            document.getElementById('qv-share-btn').onclick = function() { window.open(\"https://wa.me/?text=\" + encodeURIComponent(\"Check out *\" + prod.title + \"* for ₹\" + prod.price + \" at \" + STORE_CONFIG.storeName + \"! \" + window.location.href), \"_blank\"); };",
    "            document.getElementById('qv-add-btn').onclick = function() { closeQuickView(); addToCart(prod.id, true); };",
    "            document.getElementById('qv-buy-btn').onclick = function() { closeQuickView(); buyNowDirect(prod.id); };",
    "            document.getElementById('qv-pin-result').classList.add('hidden');",
    "            document.getElementById('qv-review-form').classList.add('hidden');",
    "            document.getElementById('rev-photo-label').innerText = 'Attach Photo (Optional)';",
    "            loadProductReviews(prod.id);",
    "            var m = document.getElementById('quickview-modal'); m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeQuickView() { var m = document.getElementById('quickview-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        function toggleReviewForm() { document.getElementById('qv-review-form').classList.toggle('hidden'); }",
    "        async function loadProductReviews(pid) {",
    "            var box = document.getElementById('qv-reviews-list');",
    "            var defaults = [",
    "                { author: 'Suresh R.', rating: 5, comment: 'Genuine quality! Uploaded PhonePe screenshot in 2 seconds and tracked easily with my last 4 phone digits.' },",
    "                { author: 'Meenakshi K.', rating: 5, comment: 'Exactly as described. Packaging was neat and delivery rider found my landmark right away.' }",
    "            ];",
    "            try { var res = await fetch('/api/reviews/' + pid); var d = await res.json(); if (d.reviews && d.reviews.length) defaults = d.reviews.concat(defaults); } catch (e) {}",
    "            box.innerHTML = defaults.slice(0, 6).map(function(r) {",
    "                return '<div class=\"bg-black/40 p-2.5 rounded-xl border border-white/5\"><div class=\"flex justify-between items-center mb-1\"><strong class=\"text-white\">' + r.author + ' <span class=\"text-emerald-400 text-[10px] font-normal\">✓ Verified</span></strong><span class=\"text-amber-400 text-[10px]\">' + '★'.repeat(r.rating) + '</span></div><p class=\"text-slate-300 text-[11px]\">' + r.comment + '</p>' + (r.photo ? ('<img src=\"' + r.photo + '\" class=\"mt-2 w-20 h-20 rounded-lg object-cover border border-white/10\">') : '') + '</div>';",
    "            }).join('');",
    "        }",
    "        async function submitProductReview(e) {",
    "            e.preventDefault();",
    "            try {",
    "                await fetch('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: currentQuickViewId, author: document.getElementById('rev-author').value.trim(), rating: document.getElementById('rev-rating').value, comment: document.getElementById('rev-comment').value.trim(), photo: pendingReviewPhoto }) });",
    "                e.target.reset(); pendingReviewPhoto = ''; document.getElementById('qv-review-form').classList.add('hidden'); loadProductReviews(currentQuickViewId); showToast('Review published!');",
    "            } catch (err) { showToast('Could not save review right now.'); }",
    "        }",
    "        function checkPincode() {",
    "            var pin = (document.getElementById('qv-pincode').value || '').trim(), res = document.getElementById('qv-pin-result');",
    "            if (/^[1-9][0-9]{5}$/.test(pin)) { res.innerText = '✅ Express Delivery serviceable to ' + pin + ' by ' + getDeliveryWindowString(); res.className = 'text-[11px] text-emerald-400 font-semibold mt-1.5 block'; }",
    "            else { res.innerText = '⚠️ Enter a valid 6-digit Indian Pincode.'; res.className = 'text-[11px] text-amber-400 font-semibold mt-1.5 block'; }",
    "        }",
    "",
    "        function toggleWishlist(id) { var idx = wishlist.indexOf(id); if (idx > -1) { wishlist.splice(idx, 1); showToast('Removed from Wishlist'); } else { wishlist.push(id); showToast('Saved to Wishlist ❤️'); } persistState(); filterAndRenderCatalog(); }",
    "        function openWishlistModal() {",
    "            document.getElementById('wishlist-items').innerHTML = !wishlist.length ? '<p class=\"text-xs text-slate-400 text-center py-8\">Wishlist is empty.</p>' : wishlist.map(function(id) {",
    "                var p = storeProducts.find(function(x) { return x.id === id; }); if (!p) return '';",
    "                return '<div class=\"flex items-center justify-between bg-darkSurface p-2.5 rounded-xl border border-darkBorder\"><div class=\"flex items-center space-x-3 overflow-hidden\"><img src=\"' + getProductImage(p) + '\" class=\"w-12 h-12 rounded-lg object-cover shrink-0\"><div class=\"overflow-hidden\"><p class=\"text-xs font-bold text-white truncate\">' + p.title + '</p><p class=\"text-xs font-black text-brandPrimary\">₹' + p.price + '</p></div></div><div class=\"flex space-x-1.5 shrink-0\"><button onclick=\"addToCart(' + p.id + ', true); closeWishlistModal()\" class=\"bg-brandPrimary text-white text-[11px] font-bold px-3 py-1.5 rounded-lg\">Add</button><button onclick=\"toggleWishlist(' + p.id + '); openWishlistModal()\" class=\"bg-white/10 text-slate-300 px-2.5 py-1.5 rounded-lg text-xs\"><i class=\"fa-solid fa-trash\"></i></button></div></div>';",
    "            }).join('');",
    "            var m = document.getElementById('wishlist-modal'); m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeWishlistModal() { var m = document.getElementById('wishlist-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "",
    "        function toggleCompare(id) {",
    "            var idx = compareList.indexOf(id);",
    "            if (idx > -1) compareList.splice(idx, 1);",
    "            else { if (compareList.length >= 3) { showToast('Compare up to 3 products.'); return; } compareList.push(id); }",
    "            document.getElementById('compare-count').innerText = compareList.length;",
    "            document.getElementById('compare-tray').classList.toggle('hidden', compareList.length === 0);",
    "            filterAndRenderCatalog();",
    "        }",
    "        function clearCompare() { compareList = []; document.getElementById('compare-tray').classList.add('hidden'); filterAndRenderCatalog(); }",
    "        function openCompareModal() {",
    "            var items = compareList.map(function(id) { return storeProducts.find(function(p) { return p.id === id; }); }).filter(Boolean);",
    "            var html = '<table class=\"w-full text-xs text-left border-collapse\"><thead><tr><th class=\"p-2 border-b border-white/10 text-slate-400\">Feature</th>' + items.map(function(p) { return '<th class=\"p-2 border-b border-white/10 text-white font-black\">' + p.title + '</th>'; }).join('') + '</tr></thead><tbody>';",
    "            html += '<tr><td class=\"p-2 border-b border-white/5 text-slate-400\">Price</td>' + items.map(function(p) { return '<td class=\"p-2 border-b border-white/5 text-brandPrimary font-black\">₹' + p.price + '</td>'; }).join('') + '</tr>';",
    "            html += '<tr><td class=\"p-2 border-b border-white/5 text-slate-400\">Rating</td>' + items.map(function(p) { return '<td class=\"p-2 border-b border-white/5 text-amber-400 font-bold\">★ ' + p.rating + ' (' + p.reviews + ')</td>'; }).join('') + '</tr>';",
    "            html += '<tr><td class=\"p-2 text-slate-400\">Action</td>' + items.map(function(p) { return '<td class=\"p-2\"><button onclick=\"addToCart(' + p.id + ', true); closeCompareModal()\" class=\"bg-brandPrimary text-white px-3 py-1.5 rounded-lg font-bold text-[11px]\">Add to Cart</button></td>'; }).join('') + '</tr></tbody></table>';",
    "            document.getElementById('compare-table-wrap').innerHTML = html;",
    "            var m = document.getElementById('compare-modal'); m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeCompareModal() { var m = document.getElementById('compare-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "",
    "        // ADDRESS BOOK WITH LANDMARKS & GATE PHOTOS",
    "        function openAddressBookModal() { renderAddressBookList(); var m = document.getElementById('address-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }",
    "        function closeAddressBookModal() { var m = document.getElementById('address-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        function renderAddressBookList() {",
    "            var box = document.getElementById('address-book-list');",
    "            if (!savedAddresses.length) { box.innerHTML = '<p class=\"text-xs text-slate-500 bg-black/40 p-3 rounded-xl text-center\">No saved addresses yet.</p>'; return; }",
    "            box.innerHTML = savedAddresses.map(function(a, idx) {",
    "                return '<div class=\"bg-darkSurface p-3 rounded-xl border ' + (a.isDefault ? 'border-brandPrimary' : 'border-darkBorder') + ' flex justify-between items-start gap-2.5 text-xs\">' +",
    "                    (a.photo ? ('<img src=\"' + a.photo + '\" class=\"w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0\">') : '') +",
    "                    '<div class=\"flex-grow\"><span class=\"text-[10px] font-black uppercase px-2 py-0.5 rounded bg-white/10 text-white mr-1.5\">' + a.label + '</span>' + (a.isDefault ? '<span class=\"text-[10px] text-emerald-400 font-bold\">Default</span>' : '') +",
    "                    '<p class=\"font-bold text-white mt-1\">' + a.name + ' • ' + a.phone + '</p><p class=\"text-slate-300 text-[11px]\">' + a.street + ', ' + a.city + ' - ' + a.pincode + '</p>' +",
    "                    (a.landmark ? ('<p class=\"text-amber-300 text-[10px] mt-0.5\"><i class=\"fa-solid fa-map-pin mr-1\"></i>Landmark: ' + a.landmark + '</p>') : '') + '</div>' +",
    "                    '<div class=\"flex flex-col space-y-1 shrink-0\">' + (!a.isDefault ? '<button onclick=\"setDefaultAddress(' + idx + ')\" class=\"text-[10px] bg-white/10 hover:bg-brandPrimary text-white px-2 py-1 rounded font-bold\">Default</button>' : '') + '<button onclick=\"deleteAddress(' + idx + ')\" class=\"text-[10px] text-red-400 hover:underline\">Delete</button></div></div>';",
    "            }).join('');",
    "        }",
    "        function saveNewAddress(e) {",
    "            e.preventDefault();",
    "            savedAddresses.push({",
    "                id: 'ADDR-' + Date.now(), label: document.getElementById('ab-label').value, name: document.getElementById('ab-name').value.trim(),",
    "                phone: document.getElementById('ab-phone').value.trim(), pincode: document.getElementById('ab-pincode').value.trim(),",
    "                city: document.getElementById('ab-city').value.trim(), landmark: document.getElementById('ab-landmark').value.trim(),",
    "                street: document.getElementById('ab-street').value.trim(), photo: pendingAddressPhoto, isDefault: savedAddresses.length === 0",
    "            });",
    "            pendingAddressPhoto = ''; document.getElementById('ab-photo-lbl').innerText = 'Add Building / Gate Photo (Optional)';",
    "            document.getElementById('ab-photo-preview').classList.add('hidden');",
    "            persistState(); renderAddressBookList(); renderCheckoutSavedAddresses(); e.target.reset(); showToast('Address & landmark saved to 8GB Vault!');",
    "        }",
    "        function setDefaultAddress(idx) { savedAddresses.forEach(function(a, i) { a.isDefault = (i === idx); }); persistState(); renderAddressBookList(); renderCheckoutSavedAddresses(); }",
    "        function deleteAddress(idx) { savedAddresses.splice(idx, 1); if (savedAddresses.length && !savedAddresses.some(function(a) { return a.isDefault; })) savedAddresses[0].isDefault = true; persistState(); renderAddressBookList(); renderCheckoutSavedAddresses(); }",
    "        function fillCheckoutFromAddress(a) {",
    "            if (!a) return;",
    "            document.getElementById('cust-name').value = a.name || '';",
    "            document.getElementById('cust-phone').value = a.phone || '';",
    "            document.getElementById('cust-pincode').value = a.pincode || '';",
    "            document.getElementById('cust-city').value = a.city || '';",
    "            document.getElementById('cust-landmark').value = a.landmark || '';",
    "            document.getElementById('cust-address').value = a.street || '';",
    "        }",
    "        function renderCheckoutSavedAddresses() {",
    "            var wrap = document.getElementById('checkout-saved-addr-wrap'), list = document.getElementById('checkout-saved-addr-list');",
    "            if (!savedAddresses.length) { wrap.classList.add('hidden'); return; }",
    "            wrap.classList.remove('hidden');",
    "            list.innerHTML = savedAddresses.map(function(a, idx) {",
    "                return '<button type=\"button\" onclick=\"selectCheckoutAddress(' + idx + ')\" class=\"shrink-0 text-left bg-darkSurface hover:border-brandPrimary border ' + (a.isDefault ? 'border-brandPrimary' : 'border-darkBorder') + ' rounded-xl px-3 py-2 text-[11px] max-w-[190px]\"><strong class=\"text-white block\">' + a.label + ' • ' + a.pincode + '</strong><span class=\"text-amber-300 truncate block\">' + (a.landmark || a.name) + '</span></button>';",
    "            }).join('');",
    "        }",
    "        function selectCheckoutAddress(idx) { fillCheckoutFromAddress(savedAddresses[idx]); showToast('Filled ' + savedAddresses[idx].label + ' address!'); }",
    "",
    "        // CART & AUTO BEST-DEAL ENGINE",
    "        function toggleCart() { document.getElementById('cart-sidebar').classList.toggle('translate-x-full'); }",
    "        function openWalletInfo() { showToast('You have ' + superCoins + ' SuperCoins (= ₹' + superCoins + '). Auto-applied inside Cart!'); }",
    "        function applyQuickCoupon(code) { couponApplied = true; document.getElementById('coupon-input').value = code; updateCartUI(); showToast('Promo ' + code + ' active!'); }",
    "        function applyCouponInput() {",
    "            var val = (document.getElementById('coupon-input').value || '').trim().toUpperCase();",
    "            if (val === STORE_CONFIG.promoCode || val === 'PREM10' || val === 'VIP10') { couponApplied = true; updateCartUI(); showToast('Promo applied!'); }",
    "            else showToast('Try ' + STORE_CONFIG.promoCode + ' for ' + STORE_CONFIG.promoPercent + '% OFF!');",
    "        }",
    "        function addToCart(id, openDrawer) {",
    "            var product = storeProducts.find(function(p) { return p.id === id; });",
    "            if (!product || product.stock <= 0) { showToast('Out of stock.'); return; }",
    "            var item = cart.find(function(i) { return i.id === id; });",
    "            if (item && item.qty >= product.stock) { showToast('Max stock reached.'); return; }",
    "            if (item) item.qty += 1;",
    "            else { cart.push({ id: product.id, title: product.title, price: product.price, stock: product.stock, qty: 1 }); if (cart.length === 1) startCartTimer(); }",
    "            persistState(); updateCartUI(); showToast('Added \"' + product.title + '\" to cart');",
    "            if (openDrawer !== false && document.getElementById('cart-sidebar').classList.contains('translate-x-full')) toggleCart();",
    "        }",
    "        function buyNowDirect(id) {",
    "            var item = cart.find(function(i) { return i.id === id; });",
    "            if (!item) { var p = storeProducts.find(function(x) { return x.id === id; }); if (!p) return; cart.push({ id: p.id, title: p.title, price: p.price, stock: p.stock, qty: 1 }); persistState(); updateCartUI(); }",
    "            openShippingModal();",
    "        }",
    "        function modifyQty(id, step) {",
    "            var idx = cart.findIndex(function(i) { return i.id === id; });",
    "            if (idx > -1) {",
    "                if (step > 0 && cart[idx].qty >= cart[idx].stock) { showToast('Max stock reached.'); return; }",
    "                cart[idx].qty += step;",
    "                if (cart[idx].qty <= 0) cart.splice(idx, 1);",
    "                if (!cart.length) { clearInterval(cartTimerInterval); document.getElementById('cart-timer').innerText = \"10:00\"; }",
    "            }",
    "            persistState(); updateCartUI();",
    "        }",
    "        function getCartFinancials() {",
    "            var subtotal = cart.reduce(function(sum, i) { return sum + (i.price * i.qty); }, 0);",
    "            var totalQty = cart.reduce(function(sum, i) { return sum + i.qty; }, 0);",
    "            var volumeDiscount = (totalQty >= 3 || subtotal >= 2499) ? Math.round(subtotal * 0.15) : (totalQty >= 2 ? Math.round(subtotal * 0.05) : 0);",
    "            var discount = couponApplied ? Math.round((subtotal - volumeDiscount) * (STORE_CONFIG.promoPercent / 100)) : 0;",
    "            var useCoins = document.getElementById('use-coins-cb') && document.getElementById('use-coins-cb').checked;",
    "            var coinsRedeemed = (cart.length > 0 && useCoins) ? Math.min(superCoins, 250, Math.floor(subtotal * 0.25)) : 0;",
    "            orderBumpActive = document.getElementById('order-bump') && document.getElementById('order-bump').checked;",
    "            var bumpCost = (cart.length > 0 && orderBumpActive) ? 99 : 0;",
    "            var freeGiftAdded = subtotal >= STORE_CONFIG.freeGiftThreshold;",
    "            var finalTotal = !cart.length ? 0 : Math.max(1, subtotal - volumeDiscount - discount - coinsRedeemed + bumpCost);",
    "            return { subtotal: subtotal, volumeDiscount: volumeDiscount, discount: discount, coinsRedeemed: coinsRedeemed, bumpCost: bumpCost, freeGiftAdded: freeGiftAdded, finalTotal: finalTotal, totalSaved: volumeDiscount + discount + coinsRedeemed };",
    "        }",
    "        function updateCartUI() {",
    "            document.getElementById('cart-count').innerText = cart.reduce(function(sum, i) { return sum + i.qty; }, 0);",
    "            var fin = getCartFinancials();",
    "            document.getElementById('cart-subtotal').innerText = '₹' + fin.subtotal.toLocaleString('en-IN');",
    "            document.getElementById('cart-total').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');",
    "            document.getElementById('volume-row').classList.toggle('hidden', fin.volumeDiscount <= 0);",
    "            document.getElementById('cart-volume-disc').innerText = '-₹' + fin.volumeDiscount.toLocaleString('en-IN');",
    "            document.getElementById('discount-row').classList.toggle('hidden', fin.discount <= 0);",
    "            document.getElementById('cart-discount').innerText = '-₹' + fin.discount.toLocaleString('en-IN');",
    "            document.getElementById('coins-row').classList.toggle('hidden', fin.coinsRedeemed <= 0);",
    "            document.getElementById('cart-coins-disc').innerText = '-₹' + fin.coinsRedeemed.toLocaleString('en-IN');",
    "            document.getElementById('gift-row').classList.toggle('hidden', !fin.freeGiftAdded);",
    "",
    "            var savPill = document.getElementById('auto-savings-pill');",
    "            if (fin.totalSaved > 0 && cart.length > 0) {",
    "                savPill.classList.remove('hidden');",
    "                savPill.innerText = '⚡ Auto Best-Deal Applied: You save ₹' + fin.totalSaved.toLocaleString('en-IN') + ' on this order!';",
    "            } else savPill.classList.add('hidden');",
    "",
    "            document.getElementById('shipping-progress').style.width = Math.min(100, Math.round((fin.subtotal / 2499) * 100)) + '%';",
    "            var stxt = document.getElementById('shipping-text');",
    "            if (fin.subtotal >= 2499) stxt.innerHTML = '<span class=\"text-emerald-400\">🎉 ALL 3 REWARDS UNLOCKED: Free Ship + Free Gift + 15% Bundle!</span>';",
    "            else if (fin.subtotal >= STORE_CONFIG.freeGiftThreshold) stxt.innerHTML = '<span class=\"text-amber-300\">🎁 Free Ship &amp; Gift Unlocked! Add ₹' + (2499 - fin.subtotal) + ' for 15% Bundle</span>';",
    "            else if (fin.subtotal >= STORE_CONFIG.freeShipThreshold) stxt.innerHTML = '<span class=\"text-emerald-400\">✅ Free Ship Unlocked! Add ₹' + (STORE_CONFIG.freeGiftThreshold - fin.subtotal) + ' for FREE Gift</span>';",
    "            else stxt.innerHTML = 'Add ₹' + (STORE_CONFIG.freeShipThreshold - fin.subtotal) + ' more for FREE VIP Shipping';",
    "",
    "            var container = document.getElementById('cart-items');",
    "            if (!cart.length) { container.innerHTML = '<div class=\"text-center text-slate-500 py-12 text-xs\">Your cart is empty.</div>'; return; }",
    "            container.innerHTML = cart.map(function(item) {",
    "                var fullP = storeProducts.find(function(x) { return x.id === item.id; }) || item;",
    "                return '<div class=\"flex items-center space-x-3 bg-darkSurface p-2.5 rounded-xl border border-darkBorder\"><img src=\"' + getProductImage(fullP) + '\" class=\"w-14 h-14 object-cover rounded-lg shrink-0 bg-black\"><div class=\"flex-grow overflow-hidden\"><h4 class=\"font-bold text-xs text-white truncate\">' + item.title + '</h4><p class=\"text-brandPrimary text-sm font-black mt-0.5\">₹' + (item.price * item.qty).toLocaleString('en-IN') + '</p></div><div class=\"flex items-center bg-black rounded-lg border border-white/10\"><button onclick=\"modifyQty(' + item.id + ', -1)\" class=\"w-7 h-7 text-slate-400 hover:text-white text-xs\">-</button><span class=\"text-xs font-bold text-white px-2\">' + item.qty + '</span><button onclick=\"modifyQty(' + item.id + ', 1)\" class=\"w-7 h-7 text-slate-400 hover:text-white text-xs\">+</button></div></div>';",
    "            }).join('');",
    "        }",
    "        function startCartTimer() {",
    "            clearInterval(cartTimerInterval);",
    "            var time = 600, display = document.getElementById('cart-timer');",
    "            cartTimerInterval = setInterval(function() { var m = Math.floor(time / 60), s = time % 60; display.innerText = m + ':' + (s < 10 ? '0' + s : s); if (--time < 0) { clearInterval(cartTimerInterval); display.innerText = \"10:00\"; } }, 1000);",
    "        }",
    "",
    "        // SEAMLESS UPI REDIRECTION + SCREENSHOT / 4-DIGIT REF PROOF",
    "        function openShippingModal() {",
    "            if (!cart.length) { showToast('Add at least 1 product first.'); return; }",
    "            if (!document.getElementById('cart-sidebar').classList.contains('translate-x-full')) toggleCart();",
    "            selectedPaymentApp = ''; paymentRedirectTriggered = false; paymentInitiatedTimestamp = null; paymentProofDataUrl = '';",
    "            document.getElementById('cust-ref-short').value = '';",
    "            document.getElementById('pay-proof-file').value = '';",
    "            document.getElementById('pay-proof-preview-wrap').classList.add('hidden');",
    "            document.getElementById('pay-photo-label').innerText = 'Upload Payment Screenshot';",
    "            document.getElementById('upi-redirect-status').innerText = '⏳ Tap App Below';",
    "            document.getElementById('upi-redirect-status').className = 'text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full font-bold';",
    "            validateCheckoutUnlock();",
    "",
    "            var fin = getCartFinancials();",
    "            document.getElementById('checkout-total-badge').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');",
    "            document.getElementById('upi-id-display').innerText = STORE_CONFIG.upiId;",
    "            renderCheckoutSavedAddresses();",
    "            var defAddr = savedAddresses.find(function(a) { return a.isDefault; }) || savedAddresses[0];",
    "            if (defAddr) fillCheckoutFromAddress(defAddr);",
    "            var m = document.getElementById('shipping-modal'); m.classList.remove('hidden'); m.classList.add('flex');",
    "        }",
    "        function closeShippingModal() { var m = document.getElementById('shipping-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "",
    "        function buildCleanP2PUpiLink(appName, amount, noLimitMode) {",
    "            var params = 'pa=' + encodeURIComponent(STORE_CONFIG.upiId) + '&pn=' + encodeURIComponent(STORE_CONFIG.payeeName) + '&cu=INR';",
    "            if (!noLimitMode && Number(amount) > 0) params += '&am=' + encodeURIComponent(Number(amount).toFixed(2));",
    "            params += '&tn=' + encodeURIComponent('Order at ' + STORE_CONFIG.storeName);",
    "            var isAndroid = /Android/i.test(navigator.userAgent), isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);",
    "            if (appName === 'PhonePe') return isAndroid ? ('intent://pay?' + params + '#Intent;scheme=upi;package=com.phonepe.app;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.phonepe.app') + ';end') : (isIOS ? ('phonepe://pay?' + params) : ('upi://pay?' + params));",
    "            if (appName === 'Google Pay') return isAndroid ? ('intent://upi/pay?' + params + '#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.google.android.apps.nbu.paisa.user') + ';end') : (isIOS ? ('tez://upi/pay?' + params) : ('upi://pay?' + params));",
    "            if (appName === 'Navi') return isAndroid ? ('intent://pay?' + params + '#Intent;scheme=upi;package=com.naviapp;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.naviapp') + ';end') : (isIOS ? ('navipay://pay?' + params) : ('upi://pay?' + params));",
    "            return 'upi://pay?' + params;",
    "        }",
    "",
    "        function launchUpiApp(appName, noLimitMode) {",
    "            var fin = getCartFinancials(); if (fin.finalTotal <= 0) return;",
    "            if (navigator.clipboard) navigator.clipboard.writeText(noLimitMode ? String(fin.finalTotal) : STORE_CONFIG.upiId).catch(function() {});",
    "            var deepLink = buildCleanP2PUpiLink(appName, fin.finalTotal, noLimitMode);",
    "            selectedPaymentApp = appName + (noLimitMode ? ' (Safe-Open)' : '');",
    "            paymentRedirectTriggered = true;",
    "            paymentInitiatedTimestamp = new Date().toISOString();",
    "            var statusPill = document.getElementById('upi-redirect-status');",
    "            statusPill.innerText = '🚀 Opened ' + appName;",
    "            statusPill.className = 'text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2.5 py-1 rounded-full font-bold';",
    "            document.getElementById('proof-helper').innerText = '✅ Done paying in ' + appName + '? Just upload your payment screenshot OR type the last 4 digits of the payment ref!';",
    "            document.getElementById('proof-helper').className = 'text-[10px] text-emerald-400 font-semibold';",
    "            validateCheckoutUnlock();",
    "            showToast(noLimitMode ? ('Safe-Open active! ₹' + fin.finalTotal + ' copied.') : ('Opening ' + appName + ' for ₹' + fin.finalTotal + '...'));",
    "",
    "            var a = document.createElement('a'); a.href = deepLink; a.style.display = 'none';",
    "            document.body.appendChild(a); a.click();",
    "            setTimeout(function() { if (a.parentNode) document.body.removeChild(a); }, 500);",
    "        }",
    "",
    "        function copyUpiIdAndUnlock() {",
    "            if (navigator.clipboard) navigator.clipboard.writeText(STORE_CONFIG.upiId).catch(function() {});",
    "            selectedPaymentApp = selectedPaymentApp || 'Direct UPI (Copied ID)';",
    "            paymentRedirectTriggered = true;",
    "            paymentInitiatedTimestamp = paymentInitiatedTimestamp || new Date().toISOString();",
    "            document.getElementById('upi-redirect-status').innerText = '📋 UPI Copied';",
    "            validateCheckoutUnlock();",
    "            showToast('UPI ID Copied: ' + STORE_CONFIG.upiId);",
    "        }",
    "        function copyExactAmount() {",
    "            var fin = getCartFinancials();",
    "            if (navigator.clipboard) navigator.clipboard.writeText(String(fin.finalTotal)).catch(function() {});",
    "            showToast('Amount Copied: ₹' + fin.finalTotal);",
    "        }",
    "",
    "        function validateCheckoutUnlock() {",
    "            var btn = document.getElementById('whatsapp-checkout-btn');",
    "            var refShort = (document.getElementById('cust-ref-short').value || '').trim().replace(/[^A-Za-z0-9]/g, '');",
    "            var hasProof = Boolean(paymentProofDataUrl) || refShort.length >= 4;",
    "            if (paymentRedirectTriggered && hasProof) {",
    "                btn.disabled = false;",
    "                btn.className = 'w-full bg-whatsapp text-black font-black py-4 rounded-xl btn-glow-whatsapp tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2 cursor-pointer transition-all';",
    "                btn.innerHTML = '<i class=\"fa-brands fa-whatsapp text-lg\"></i><span>Confirm Order (' + selectedPaymentApp + ') &amp; Get Track Code</span>';",
    "            } else {",
    "                btn.disabled = true;",
    "                btn.className = 'w-full bg-slate-700 text-slate-400 font-black py-4 rounded-xl tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2 cursor-not-allowed transition-all';",
    "                btn.innerHTML = !paymentRedirectTriggered",
    "                    ? '<i class=\"fa-solid fa-lock\"></i><span>Tap PhonePe, GPay, or Navi Above First</span>'",
    "                    : '<i class=\"fa-solid fa-image\"></i><span>Upload Screenshot OR Type Last 4 Digits to Unlock</span>';",
    "            }",
    "        }",
    "",
    "        async function submitOrderAndRedirectToWhatsApp(event) {",
    "            event.preventDefault();",
    "            var refShort = (document.getElementById('cust-ref-short').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');",
    "            if (!paymentRedirectTriggered || (!paymentProofDataUrl && refShort.length < 4)) {",
    "                showToast('Pay via UPI and attach screenshot or last 4 ref digits first.');",
    "                return;",
    "            }",
    "            var btn = document.getElementById('whatsapp-checkout-btn');",
    "            btn.innerHTML = '<i class=\"fa-solid fa-circle-notch fa-spin\"></i><span>Saving Order to Vault...</span>';",
    "            btn.disabled = true;",
    "",
    "            var name = document.getElementById('cust-name').value.trim();",
    "            var phone = document.getElementById('cust-phone').value.trim();",
    "            var pincode = document.getElementById('cust-pincode').value.trim();",
    "            var city = document.getElementById('cust-city').value.trim();",
    "            var landmark = document.getElementById('cust-landmark').value.trim();",
    "            var street = document.getElementById('cust-address').value.trim();",
    "            var fullAddress = street + ' (Landmark: ' + landmark + '), ' + city + ' - ' + pincode;",
    "",
    "            if (document.getElementById('save-addr-checkbox').checked) {",
    "                if (!savedAddresses.some(function(a) { return a.street === street && a.pincode === pincode; })) {",
    "                    savedAddresses.push({ id: 'ADDR-' + Date.now(), label: 'Home', name: name, phone: phone, pincode: pincode, city: city, landmark: landmark, street: street, photo: '', isDefault: savedAddresses.length === 0 });",
    "                }",
    "            }",
    "",
    "            var fin = getCartFinancials(), estDelivery = getDeliveryWindowString();",
    "            var payload = {",
    "                customer: { name: name, phone: phone, pincode: pincode, city: city, landmark: landmark, street: street, address: fullAddress },",
    "                cart: cart.slice(), subtotal: fin.subtotal, discount: fin.discount, volumeDiscount: fin.volumeDiscount,",
    "                coinsRedeemed: fin.coinsRedeemed, orderBump: orderBumpActive, freeGiftAdded: fin.freeGiftAdded,",
    "                total: fin.finalTotal, paymentProofPhoto: paymentProofDataUrl, paymentRefShort: refShort,",
    "                paymentApp: selectedPaymentApp, paymentInitiatedAt: paymentInitiatedTimestamp, estimatedDelivery: estDelivery",
    "            };",
    "",
    "            try {",
    "                var res = await fetch('/api/place-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });",
    "                var data = await res.json();",
    "                if (!res.ok) { showToast(data.message || 'Order error.'); validateCheckoutUnlock(); return; }",
    "                lastConfirmedOrder = data.order;",
    "            } catch (err) {",
    "                var l4 = phone.replace(/[^0-9]/g, '').slice(-4) || '0000';",
    "                lastConfirmedOrder = Object.assign({ orderId: 'PREM-' + l4 + '-01', phoneLast4: l4, status: 'Payment Verification', stage: 2, financials: { total: fin.finalTotal, coinsEarned: 15 }, payment: { app: selectedPaymentApp, refShort: refShort || 'SCREENSHOT' } }, payload);",
    "            }",
    "",
    "            try {",
    "                var hist = JSON.parse(localStorage.getItem('prem_orders_v8') || '[]');",
    "                hist.unshift(lastConfirmedOrder);",
    "                localStorage.setItem('prem_orders_v8', JSON.stringify(hist.slice(0, 25)));",
    "            } catch (e) {}",
    "",
    "            var earned = (lastConfirmedOrder.financials && lastConfirmedOrder.financials.coinsEarned) || 15;",
    "            superCoins = Math.max(0, superCoins - fin.coinsRedeemed + earned);",
    "",
    "            var nl = \"\\n\";",
    "            var waMsg = \"*🛍️ NEW ORDER - \" + STORE_CONFIG.storeName.toUpperCase() + \"*\" + nl + nl;",
    "            waMsg += \"*🔢 Track Code (Last 4):* \" + lastConfirmedOrder.phoneLast4 + \" (\" + lastConfirmedOrder.orderId + \")\" + nl;",
    "            waMsg += \"*💳 Paid via:* \" + selectedPaymentApp + (refShort ? (\" (Ref #\" + refShort + \")\") : \" (Screenshot Uploaded)\") + nl;",
    "            waMsg += \"*📅 Est. Delivery:* \" + estDelivery + nl + nl;",
    "            waMsg += \"*👤 Delivery Address:*\" + nl + name + \" (\" + phone + \")\" + nl + fullAddress + nl + nl + \"*🛒 Items:*\" + nl;",
    "            cart.forEach(function(item) { waMsg += \"▪️ \" + item.qty + \"x \" + item.title + \" (₹\" + (item.price * item.qty) + \")\" + nl; });",
    "            if (fin.freeGiftAdded) waMsg += \"🎁 1x Free Mystery Bonus Gift (FREE)\" + nl;",
    "            if (orderBumpActive) waMsg += \"🛡️ 1x VIP Transit Insurance (+₹99)\" + nl;",
    "            waMsg += nl + \"*💰 TOTAL PAID:* ₹\" + fin.finalTotal.toLocaleString('en-IN') + nl + \"✅ *Payment proof uploaded on website. Please approve & dispatch!*\";",
    "",
    "            var waUrl = \"https://wa.me/\" + STORE_CONFIG.whatsapp + \"?text=\" + encodeURIComponent(waMsg);",
    "            cart = []; paymentProofDataUrl = ''; persistState(); updateCartUI(); closeShippingModal();",
    "",
    "            document.getElementById('succ-last4').innerText = lastConfirmedOrder.phoneLast4;",
    "            document.getElementById('succ-oid').innerText = lastConfirmedOrder.orderId;",
    "            document.getElementById('succ-coins').innerText = earned;",
    "            document.getElementById('succ-app').innerText = selectedPaymentApp;",
    "            document.getElementById('succ-proof').innerText = refShort ? ('Ref #' + refShort + ' Saved') : 'Screenshot Saved ✓';",
    "            document.getElementById('succ-total').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');",
    "            document.getElementById('succ-est').innerText = estDelivery;",
    "            document.getElementById('succ-wa-link').href = waUrl;",
    "            var sm = document.getElementById('success-modal'); sm.classList.remove('hidden'); sm.classList.add('flex');",
    "        }",
    "",
    "        function closeSuccessAndTrack() {",
    "            var sm = document.getElementById('success-modal'); sm.classList.add('hidden'); sm.classList.remove('flex');",
    "            if (lastConfirmedOrder) { openTrackModal(); quickTrackOrder(lastConfirmedOrder.phoneLast4 || lastConfirmedOrder.orderId); }",
    "        }",
    "",
    "        function printInvoice() {",
    "            if (!lastConfirmedOrder) return;",
    "            var o = lastConfirmedOrder, w = window.open('', '_blank', 'width=680,height=720');",
    "            if (!w) return;",
    "            var rows = (o.cart || []).map(function(i) { return '<tr><td style=\"padding:8px;border-bottom:1px solid #ddd\">' + i.title + '</td><td style=\"padding:8px;border-bottom:1px solid #ddd\">' + i.qty + '</td><td style=\"padding:8px;border-bottom:1px solid #ddd\">₹' + (i.price * i.qty) + '</td></tr>'; }).join('');",
    "            w.document.write('<html><head><title>Invoice ' + o.orderId + '</title></head><body style=\"font-family:sans-serif;padding:24px;color:#111\"><h2>' + STORE_CONFIG.storeName + ' — TAX INVOICE</h2><p><strong>Track Code (Last 4):</strong> ' + (o.phoneLast4 || '') + ' | <strong>Ref:</strong> ' + o.orderId + '</p><p><strong>Customer:</strong> ' + o.customer.name + ' (' + o.customer.phone + ')<br>' + o.customer.address + '</p><table style=\"width:100%;border-collapse:collapse;margin:16px 0\"><thead><tr><th style=\"text-align:left;padding:8px;border-bottom:2px solid #111\">Item</th><th style=\"text-align:left;padding:8px;border-bottom:2px solid #111\">Qty</th><th style=\"text-align:left;padding:8px;border-bottom:2px solid #111\">Amount</th></tr></thead><tbody>' + rows + '</tbody></table><h3>Total Paid: ₹' + (o.financials ? o.financials.total : o.total) + '</h3><script>window.print();<\\/script></body></html>');",
    "            w.document.close();",
    "        }",
    "",
    "        // UPGRADED LAST-4-DIGITS LIVE TRACKER + INSTANT REPLACEMENT",
    "        function openTrackModal() { renderRecentOrdersPills(); var m = document.getElementById('track-modal'); m.classList.remove('hidden'); m.classList.add('flex'); setTimeout(function() { var el = document.getElementById('track-order-id'); if (el) el.focus(); }, 100); }",
    "        function closeTrackModal() { var m = document.getElementById('track-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        function renderRecentOrdersPills() {",
    "            try {",
    "                var list = JSON.parse(localStorage.getItem('prem_orders_v8') || '[]');",
    "                var box = document.getElementById('recent-orders-box');",
    "                if (!list.length) { box.classList.add('hidden'); return; }",
    "                box.classList.remove('hidden');",
    "                document.getElementById('recent-orders-list').innerHTML = list.slice(0, 6).map(function(o) {",
    "                    var label = o.phoneLast4 ? ('Last 4: ' + o.phoneLast4 + ' (' + o.orderId + ')') : o.orderId;",
    "                    return '<button type=\"button\" onclick=\"quickTrackOrder(\\'' + (o.phoneLast4 || o.orderId) + '\\')\" class=\"bg-white/10 hover:bg-emerald-500 hover:text-black text-white text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg transition-colors\">' + label + '</button>';",
    "                }).join('');",
    "            } catch (e) {}",
    "        }",
    "        function quickTrackOrder(q) { document.getElementById('track-order-id').value = q; lookupOrderStatus(); }",
    "",
    "        async function lookupOrderStatus(event) {",
    "            if (event) event.preventDefault();",
    "            var q = (document.getElementById('track-order-id').value || '').trim().toUpperCase();",
    "            if (!q) return;",
    "            var ordersFound = [];",
    "            try {",
    "                var res = await fetch('/api/track/' + encodeURIComponent(q));",
    "                if (res.ok) {",
    "                    var d = await res.json();",
    "                    if (d.found) ordersFound = d.orders && d.orders.length ? d.orders : [d.order];",
    "                }",
    "            } catch (e) {}",
    "            if (!ordersFound.length) {",
    "                try {",
    "                    var localList = JSON.parse(localStorage.getItem('prem_orders_v8') || '[]');",
    "                    ordersFound = localList.filter(function(o) { return (o.phoneLast4 === q) || ((o.orderId || '').toUpperCase() === q); });",
    "                } catch (e) {}",
    "            }",
    "            if (!ordersFound.length) { showToast('No order found for \"' + q + '\". Enter the last 4 digits of your phone.'); return; }",
    "            currentTrackedOrdersList = ordersFound;",
    "            var switcher = document.getElementById('track-multi-switcher');",
    "            if (ordersFound.length > 1) {",
    "                switcher.classList.remove('hidden');",
    "                switcher.innerHTML = ordersFound.map(function(o, idx) {",
    "                    return '<button type=\"button\" onclick=\"selectTrackedOrderIndex(' + idx + ')\" class=\"shrink-0 bg-white/10 hover:bg-emerald-500 hover:text-black text-white text-[11px] font-bold px-3 py-1.5 rounded-lg\">' + o.orderId + ' (₹' + ((o.financials && o.financials.total) || o.total || 0) + ')</button>';",
    "                }).join('');",
    "            } else switcher.classList.add('hidden');",
    "            selectTrackedOrderIndex(0);",
    "        }",
    "        function selectTrackedOrderIndex(idx) {",
    "            currentTrackedOrder = currentTrackedOrdersList[idx];",
    "            if (currentTrackedOrder) renderTrackingTimeline(currentTrackedOrder);",
    "        }",
    "",
    "        function getCourierTrackingUrl(partner, awb) {",
    "            var p = String(partner || '').toLowerCase(), a = encodeURIComponent(awb || '');",
    "            if (p.indexOf('delhivery') !== -1) return 'https://www.delhivery.com/track/package/' + a;",
    "            if (p.indexOf('bluedart') !== -1) return 'https://www.bluedart.com/tracking?trackFor=0&trackNo=' + a;",
    "            if (p.indexOf('dtdc') !== -1) return 'https://www.dtdc.in/tracking.asp';",
    "            return 'https://www.google.com/search?q=' + encodeURIComponent((partner || 'courier') + ' track ' + (awb || ''));",
    "        }",
    "",
    "        function renderTrackingTimeline(order) {",
    "            document.getElementById('track-result-card').classList.remove('hidden');",
    "            document.getElementById('trk-replace-form').classList.add('hidden');",
    "            var total = (order.financials && order.financials.total) ? order.financials.total : (order.total || 0);",
    "            var appUsed = (order.payment && order.payment.app) ? order.payment.app : 'UPI';",
    "            document.getElementById('trk-id').innerText = 'Track #' + (order.phoneLast4 || '0000') + ' • ' + order.orderId;",
    "            document.getElementById('trk-meta').innerText = '₹' + Number(total).toLocaleString('en-IN') + ' • Paid via ' + appUsed + ' • ' + (order.dateDisplay || '');",
    "            document.getElementById('trk-badge').innerText = order.status || 'Processing';",
    "            document.getElementById('trk-est').innerText = order.estimatedDelivery || getDeliveryWindowString();",
    "",
    "            var stage = Number(order.stage !== undefined ? order.stage : 2);",
    "            var pct = stage === 0 ? 0 : Math.min(100, Math.round((stage / 6) * 100));",
    "            document.getElementById('trk-progress-bar').style.width = pct + '%';",
    "            document.getElementById('trk-progress-label').innerText = stage === 0 ? 'Canceled' : ('Stage ' + stage + ' of 6 (' + pct + '% Complete)');",
    "",
    "            var steps = [",
    "                { num: 1, label: 'Order Placed & Stock Reserved' },",
    "                { num: 2, label: 'Payment Proof Verification (' + appUsed + ')' },",
    "                { num: 3, label: 'Approved, Quality Checked & Packed' },",
    "                { num: 4, label: 'Shipped & Handed to Courier' },",
    "                { num: 5, label: 'Out for Delivery to Your Landmark' },",
    "                { num: 6, label: 'Delivered Successfully' }",
    "            ];",
    "            document.getElementById('trk-steps').innerHTML = stage === 0",
    "                ? '<div class=\"p-3 bg-red-500/15 border border-red-500/30 rounded-xl text-red-300 font-bold\">This order was canceled.</div>'",
    "                : steps.map(function(s) {",
    "                    var done = stage >= s.num, isCurrent = stage === s.num;",
    "                    var log = (order.timeline || []).find(function(t) { return Number(t.stage) === s.num; });",
    "                    return '<div class=\"flex items-start space-x-2.5\">' +",
    "                        (done ? ('<i class=\"fa-solid fa-circle-check ' + (isCurrent ? 'text-emerald-400 scale-110' : 'text-emerald-500/70') + ' mt-0.5\"></i>') : '<i class=\"fa-regular fa-circle text-slate-600 mt-0.5\"></i>') +",
    "                        '<div><span class=\"' + (done ? 'text-white font-bold' : 'text-slate-500') + ' block\">' + s.label + '</span>' +",
    "                        (log ? '<span class=\"text-[10px] text-slate-400\">' + log.time + ' — ' + log.note + '</span>' : '') + '</div></div>';",
    "                }).join('');",
    "",
    "            var cBox = document.getElementById('trk-courier-box');",
    "            if (order.awbNumber || order.courierPartner) {",
    "                cBox.classList.remove('hidden');",
    "                document.getElementById('trk-courier-name').innerText = order.courierPartner || 'Courier Partner';",
    "                document.getElementById('trk-awb').innerText = 'AWB: ' + (order.awbNumber || order.courierInfo || 'Assigned');",
    "                document.getElementById('trk-courier-link').href = getCourierTrackingUrl(order.courierPartner, order.awbNumber);",
    "            } else cBox.classList.add('hidden');",
    "",
    "            document.getElementById('trk-addr-box').innerHTML = '<strong class=\"text-white block mb-0.5\"><i class=\"fa-solid fa-location-dot text-brandPrimary mr-1\"></i>Delivering To:</strong>' + (order.customer ? (order.customer.name + ' • ' + order.customer.address) : 'Saved Address');",
    "            document.getElementById('trk-items-box').innerHTML = '<p class=\"text-[10px] font-bold uppercase text-slate-400 mb-1\">Items</p>' + (order.cart || []).map(function(it) { return '<div class=\"flex justify-between text-[11px]\"><span class=\"text-slate-200\">' + it.qty + 'x ' + it.title + '</span><span class=\"font-bold text-white\">₹' + (it.price * it.qty) + '</span></div>'; }).join('');",
    "            document.getElementById('trk-cancel-btn').classList.toggle('hidden', stage === 0 || stage >= 4);",
    "        }",
    "",
    "        function toggleReplacementForm() { document.getElementById('trk-replace-form').classList.toggle('hidden'); }",
    "        async function submitReplacementTicket(e) {",
    "            e.preventDefault();",
    "            if (!currentTrackedOrder) return;",
    "            var res = await fetch('/api/support/ticket', {",
    "                method: 'POST', headers: { 'Content-Type': 'application/json' },",
    "                body: JSON.stringify({ orderId: currentTrackedOrder.orderId, phoneLast4: currentTrackedOrder.phoneLast4, reason: document.getElementById('rpl-reason').value, details: document.getElementById('rpl-details').value.trim(), photo: pendingReplacementPhoto })",
    "            });",
    "            var data = await res.json();",
    "            if (res.ok && data.ticket) {",
    "                pendingReplacementPhoto = ''; e.target.reset(); document.getElementById('trk-replace-form').classList.add('hidden');",
    "                showToast('Priority Replacement Ticket ' + data.ticket.ticketId + ' created!');",
    "            }",
    "        }",
    "        function reorderTrackedOrder() { if (!currentTrackedOrder || !currentTrackedOrder.cart) return; currentTrackedOrder.cart.forEach(function(it) { addToCart(it.id, false); }); closeTrackModal(); toggleCart(); showToast('Items added to cart!'); }",
    "        async function cancelTrackedOrder() {",
    "            if (!currentTrackedOrder || !confirm('Cancel Order ' + currentTrackedOrder.orderId + '?')) return;",
    "            var res = await fetch('/api/track/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: currentTrackedOrder.orderId }) });",
    "            var data = await res.json();",
    "            if (res.ok && data.order) { currentTrackedOrder = data.order; renderTrackingTimeline(data.order); showToast('Order canceled.'); }",
    "            else showToast(data.message || 'Cannot cancel.');",
    "        }",
    "        function pingWhatsAppForTracking() {",
    "            var q = currentTrackedOrder ? (currentTrackedOrder.orderId + ' (Last 4: ' + currentTrackedOrder.phoneLast4 + ')') : document.getElementById('track-order-id').value;",
    "            window.open(\"https://wa.me/\" + STORE_CONFIG.whatsapp + \"?text=\" + encodeURIComponent(\"Hello \" + STORE_CONFIG.storeName + \"! Please share live update for \" + q), \"_blank\");",
    "        }",
    "",
    "        // MERCHANT PORTAL (NOW SHOWS PAYMENT SCREENSHOTS & REPLACEMENT TICKETS!)",
    "        function openAdminModal() { var m = document.getElementById('admin-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }",
    "        function closeAdminModal() { var m = document.getElementById('admin-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }",
    "        async function unlockAdminPanel() {",
    "            var pin = document.getElementById('admin-pin-input').value.trim();",
    "            try {",
    "                var res = await fetch('/api/admin/dashboard', { headers: { 'x-merchant-pin': pin } });",
    "                if (!res.ok) { showToast('Incorrect Merchant PIN (Default: 9014)'); return; }",
    "                unlockedPin = pin; document.getElementById('admin-pin-gate').classList.add('hidden');",
    "                var ac = document.getElementById('admin-content'); ac.classList.remove('hidden'); ac.classList.add('flex');",
    "                renderAdminDashboardData(await res.json());",
    "            } catch (e) { showToast('Server unreachable.'); }",
    "        }",
    "        function switchAdminTab(tab) {",
    "            document.querySelectorAll('.admin-panel').forEach(function(p) { p.classList.add('hidden'); });",
    "            document.getElementById('apanel-' + tab).classList.remove('hidden');",
    "            document.querySelectorAll('.admin-tab-btn').forEach(function(b) { b.className = 'admin-tab-btn bg-white/5 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap'; });",
    "            document.getElementById('atab-' + tab).className = 'admin-tab-btn bg-brandPrimary text-white px-3.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap';",
    "            if (tab === 'catalog') renderAdminCatalogList();",
    "            if (tab === 'crm') { renderAdminTickets(); loadAdminCustomers(); }",
    "            if (tab === 'settings') populateAdminSettingsForm();",
    "        }",
    "        async function loadAdminDashboard() { if (!unlockedPin) return; var res = await fetch('/api/admin/dashboard', { headers: { 'x-merchant-pin': unlockedPin } }); if (res.ok) renderAdminDashboardData(await res.json()); }",
    "        function renderAdminDashboardData(data) {",
    "            var k = data.kpis || {}, s = data.storage || {};",
    "            if (data.settings) { STORE_CONFIG = Object.assign(STORE_CONFIG, data.settings); applyStoreConfigToUI(); }",
    "            adminOrdersCache = data.orders || []; adminTicketsCache = data.tickets || [];",
    "            document.getElementById('admin-kpis').innerHTML =",
    "                '<div class=\"bg-darkSurface p-3.5 rounded-xl border border-white/10\"><span class=\"text-[10px] text-slate-400 uppercase font-bold\">Total Revenue</span><p class=\"text-xl font-black text-emerald-400 mt-1\">₹' + (k.totalRevenue || 0).toLocaleString('en-IN') + '</p></div>' +",
    "                '<div class=\"bg-darkSurface p-3.5 rounded-xl border border-white/10\"><span class=\"text-[10px] text-slate-400 uppercase font-bold\">Orders / Today</span><p class=\"text-xl font-black text-white mt-1\">' + (k.totalOrders || 0) + ' <span class=\"text-xs text-brandPrimary\">(+' + (k.todayOrders || 0) + ')</span></p></div>' +",
    "                '<div class=\"bg-darkSurface p-3.5 rounded-xl border border-white/10\"><span class=\"text-[10px] text-slate-400 uppercase font-bold\">Pending Proofs</span><p class=\"text-xl font-black text-amber-400 mt-1\">' + (k.pendingCount || 0) + '</p></div>' +",
    "                '<div class=\"bg-darkSurface p-3.5 rounded-xl border border-white/10\"><span class=\"text-[10px] text-slate-400 uppercase font-bold\">Support Tickets</span><p class=\"text-xl font-black text-pink-400 mt-1\">' + (k.openTickets || 0) + '</p></div>';",
    "            document.getElementById('db-engine-badge').innerText = s.engine || 'SHARDED_8GB';",
    "            document.getElementById('db-usage-bar').style.width = Math.max(1, Math.min(100, s.percentUsed || 0)) + '%';",
    "            document.getElementById('db-stats-text').innerHTML = '<span>Used: <strong class=\"text-white\">' + (s.usedMB || 0) + ' MB</strong> / ' + (s.capacityGB || 8) + ' GB</span><span>Shards: <strong class=\"text-white\">' + (s.shardCount || 0) + '</strong></span><span>Orders: <strong class=\"text-white\">' + ((s.counts && s.counts.orders) || 0) + '</strong> • Customers: <strong class=\"text-white\">' + ((s.counts && s.counts.customers) || 0) + '</strong></span>';",
    "            renderAdminOrdersList();",
    "        }",
    "        function renderAdminOrdersList() {",
    "            var q = (document.getElementById('admin-order-search').value || '').trim().toLowerCase(), st = document.getElementById('admin-status-filter').value;",
    "            var filtered = adminOrdersCache.filter(function(o) {",
    "                return (st === 'ALL' || String(o.stage) === st) && (!q || (o.phoneLast4 || '').indexOf(q) !== -1 || (o.orderId || '').toLowerCase().indexOf(q) !== -1 || (o.customer && ((o.customer.phone || '').indexOf(q) !== -1 || (o.customer.name || '').toLowerCase().indexOf(q) !== -1)));",
    "            });",
    "            var cont = document.getElementById('admin-orders-list');",
    "            if (!filtered.length) { cont.innerHTML = '<p class=\"text-slate-500 text-center py-6\">No matching orders found.</p>'; return; }",
    "            cont.innerHTML = filtered.map(function(o) {",
    "                var phone = (o.customer && o.customer.phone) || '', name = (o.customer && o.customer.name) || 'Guest';",
    "                var total = (o.financials && o.financials.total) ? o.financials.total : (o.total || 0);",
    "                var app = (o.payment && o.payment.app) || 'UPI', proofImg = (o.payment && o.payment.proofPhoto) || '';",
    "                return '<div class=\"bg-darkSurface p-3.5 rounded-xl border border-darkBorder flex flex-wrap justify-between items-start gap-3\">' +",
    "                    '<div class=\"flex items-start space-x-3\">' +",
    "                    (proofImg ? ('<a href=\"' + proofImg + '\" target=\"_blank\" title=\"View Payment Screenshot\"><img src=\"' + proofImg + '\" class=\"w-14 h-14 rounded-lg object-cover border border-emerald-500/40 shrink-0\"></a>') : '') +",
    "                    '<div><span class=\"bg-emerald-500/20 text-emerald-300 font-mono font-black px-2 py-0.5 rounded mr-1.5\">#' + (o.phoneLast4 || '0000') + '</span><span class=\"font-mono font-bold text-brandPrimary\">' + o.orderId + '</span> • <strong class=\"text-white\">' + name + '</strong> (' + phone + ')' +",
    "                    '<p class=\"text-slate-400 text-[11px] mt-0.5\">₹' + total + ' via <strong class=\"text-white\">' + app + '</strong> • Proof: <span class=\"text-emerald-400\">' + (o.utr || 'Screenshot') + '</span> • <strong class=\"text-amber-300\">' + o.status + '</strong></p></div></div>' +",
    "                    '<div class=\"flex flex-wrap gap-1.5\"><button onclick=\"adminQuickUpdate(\\'' + o.orderId + '\\', \\'' + phone + '\\', \\'Approved & Packed\\', 3)\" class=\"bg-emerald-500 text-black font-bold px-2.5 py-1 rounded text-[11px]\">✓ Verify</button><button onclick=\"adminShipPrompt(\\'' + o.orderId + '\\', \\'' + phone + '\\')\" class=\"bg-blue-500 text-white font-bold px-2.5 py-1 rounded text-[11px]\">🚚 Ship</button><button onclick=\"adminQuickUpdate(\\'' + o.orderId + '\\', \\'' + phone + '\\', \\'Delivered\\', 6)\" class=\"bg-purple-500 text-white font-bold px-2.5 py-1 rounded text-[11px]\">🎉 Delivered</button><button onclick=\"adminQuickUpdate(\\'' + o.orderId + '\\', \\'' + phone + '\\', \\'Canceled\\', 0)\" class=\"bg-red-500 text-white font-bold px-2.5 py-1 rounded text-[11px]\">✕</button></div></div>';",
    "            }).join('');",
    "        }",
    "        function renderAdminTickets() {",
    "            var box = document.getElementById('admin-tickets-list');",
    "            box.innerHTML = !adminTicketsCache.length ? '<p class=\"text-slate-500\">No replacement tickets open.</p>' : adminTicketsCache.map(function(t) {",
    "                return '<div class=\"bg-amber-500/10 border border-amber-500/30 p-3 rounded-xl flex items-start space-x-3\">' +",
    "                    (t.photo ? ('<img src=\"' + t.photo + '\" class=\"w-12 h-12 rounded-lg object-cover shrink-0\">') : '') +",
    "                    '<div><strong class=\"text-amber-300\">' + t.ticketId + '</strong> (' + t.orderId + ') — <strong class=\"text-white\">' + t.reason + '</strong><p class=\"text-slate-300 text-[11px]\">' + (t.details || '') + ' • ' + t.createdAt + '</p></div></div>';",
    "            }).join('');",
    "        }",
    "        async function adminQuickUpdate(orderId, phone, newStatus, newStage, courierPartner, awbNumber) {",
    "            await fetch('/api/admin/update-order', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-merchant-pin': unlockedPin }, body: JSON.stringify({ orderId: orderId, status: newStatus, stage: newStage, courierPartner: courierPartner, awbNumber: awbNumber }) });",
    "            document.getElementById('adm-order-id').value = orderId;",
    "            if (phone) document.getElementById('adm-cust-phone').value = phone;",
    "            if (awbNumber) document.getElementById('adm-courier').value = (courierPartner || '') + ' ' + awbNumber;",
    "            showToast('Updated ' + orderId + ' → ' + newStatus); loadAdminDashboard();",
    "        }",
    "        function adminShipPrompt(orderId, phone) {",
    "            var partner = prompt('Courier Partner (Delhivery / BlueDart / DTDC / Shiprocket):', 'Delhivery'); if (partner === null) return;",
    "            var awb = prompt('AWB / Tracking Number:', ''); if (awb === null) return;",
    "            adminQuickUpdate(orderId, phone, 'Shipped via ' + partner, 4, partner, awb);",
    "        }",
    "        function populateAdminSettingsForm() {",
    "            document.getElementById('set-store-name').value = STORE_CONFIG.storeName || '';",
    "            document.getElementById('set-upi').value = STORE_CONFIG.upiId || '';",
    "            document.getElementById('set-payee').value = STORE_CONFIG.payeeName || '';",
    "            document.getElementById('set-wa').value = STORE_CONFIG.whatsapp || '';",
    "            document.getElementById('set-promo').value = STORE_CONFIG.promoCode || 'PREM10';",
    "            document.getElementById('set-promo-pct').value = STORE_CONFIG.promoPercent || 10;",
    "        }",
    "        async function saveAdminSettings(e) {",
    "            e.preventDefault();",
    "            var res = await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-merchant-pin': unlockedPin }, body: JSON.stringify({ storeName: document.getElementById('set-store-name').value.trim(), upiId: document.getElementById('set-upi').value.trim(), payeeName: document.getElementById('set-payee').value.trim(), whatsapp: document.getElementById('set-wa').value.trim(), promoCode: document.getElementById('set-promo').value.trim().toUpperCase(), promoPercent: Number(document.getElementById('set-promo-pct').value) }) });",
    "            if (res.ok) { STORE_CONFIG = Object.assign(STORE_CONFIG, (await res.json()).settings); applyStoreConfigToUI(); showToast('Live Store Settings updated!'); }",
    "        }",
    "        function renderAdminCatalogList() {",
    "            document.getElementById('admin-catalog-list').innerHTML = storeProducts.slice(0, 80).map(function(p) {",
    "                return '<div class=\"bg-darkSurface p-2.5 rounded-xl border border-darkBorder flex items-center justify-between gap-2\"><div class=\"flex items-center space-x-2 overflow-hidden\"><img src=\"' + getProductImage(p) + '\" class=\"w-9 h-9 rounded-lg object-cover shrink-0\"><div class=\"overflow-hidden\"><p class=\"font-bold text-white truncate\">#' + p.id + ' ' + p.title + '</p><p class=\"text-[10px] text-slate-400\">₹' + p.price + ' • Stock: ' + p.stock + '</p></div></div><button onclick=\"editAdminProduct(' + p.id + ')\" class=\"bg-white/10 hover:bg-brandPrimary text-white px-2.5 py-1 rounded text-[10px] font-bold shrink-0\">Edit</button></div>';",
    "            }).join('');",
    "        }",
    "        function editAdminProduct(id) {",
    "            var p = storeProducts.find(function(x) { return x.id === id; }); if (!p) return;",
    "            document.getElementById('ap-id').value = p.id; document.getElementById('ap-title').value = p.title; document.getElementById('ap-price').value = p.price;",
    "            document.getElementById('ap-stock').value = p.stock; document.getElementById('ap-cat').value = p.category; document.getElementById('ap-img').value = p.customImage || '';",
    "            showToast('Loaded #' + p.id);",
    "        }",
    "        async function saveAdminProduct(e) {",
    "            e.preventDefault();",
    "            var res = await fetch('/api/admin/product', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-merchant-pin': unlockedPin }, body: JSON.stringify({ id: document.getElementById('ap-id').value ? Number(document.getElementById('ap-id').value) : undefined, title: document.getElementById('ap-title').value.trim(), price: Number(document.getElementById('ap-price').value), stock: Number(document.getElementById('ap-stock').value), category: document.getElementById('ap-cat').value, customImage: document.getElementById('ap-img').value.trim() }) });",
    "            if (res.ok) { showToast('Product saved!'); e.target.reset(); await fetchCatalog(); renderAdminCatalogList(); }",
    "        }",
    "        async function loadAdminCustomers() {",
    "            var res = await fetch('/api/admin/customers', { headers: { 'x-merchant-pin': unlockedPin } });",
    "            var list = (await res.json()).customers || [];",
    "            document.getElementById('admin-crm-list').innerHTML = !list.length ? '<p class=\"text-slate-500\">No customers synced yet.</p>' : list.map(function(c) {",
    "                return '<div class=\"bg-darkSurface p-3 rounded-xl border border-darkBorder flex justify-between items-center\"><div><strong class=\"text-white\">' + (c.name || 'Customer') + '</strong> (' + c.phone + ')<p class=\"text-[11px] text-slate-400\">Orders: ' + (c.totalOrders || 0) + ' • Spent: ₹' + (c.totalSpent || 0) + ' • Saved Landmarks: ' + ((c.addresses && c.addresses.length) || 0) + '</p></div><span class=\"text-amber-300 font-bold text-[11px]\"><i class=\"fa-solid fa-coins mr-1\"></i>' + (c.superCoins || 0) + '</span></div>';",
    "            }).join('');",
    "        }",
    "        function exportAdminCsv() { if (unlockedPin) window.open('/api/admin/export-csv?pin=' + encodeURIComponent(unlockedPin), '_blank'); }",
    "        function sendMerchantWhatsApp(type) {",
    "            var rawPhone = (document.getElementById('adm-cust-phone').value || '').replace(/[^0-9]/g, '');",
    "            if (rawPhone.length === 10) rawPhone = '91' + rawPhone;",
    "            var orderId = (document.getElementById('adm-order-id').value || 'your order').trim().toUpperCase();",
    "            var courier = (document.getElementById('adm-courier').value || '').trim();",
    "            if (!rawPhone) { showToast('Enter customer phone first.'); return; }",
    "            var msg = type === 'APPROVED' ? (\"✅ *ORDER APPROVED - \" + STORE_CONFIG.storeName.toUpperCase() + \"*\\n\\nPayment verified for *\" + orderId + \"*! Packed & ready for dispatch.\")",
    "                : type === 'SHIPPED' ? (\"🚚 *ORDER SHIPPED*\\n\\nOrder *\" + orderId + \"* dispatched!\" + (courier ? (\"\\n📍 Tracking: \" + courier) : \"\") + \"\\nTrack live on our website using the last 4 digits of your phone!\")",
    "                : type === 'DELIVERED' ? (\"🎉 *ORDER DELIVERED*\\n\\nOrder *\" + orderId + \"* delivered! Thank you for shopping with \" + STORE_CONFIG.storeName + \".\")",
    "                : (\"⚠️ *ORDER UPDATE*\\n\\nRegarding *\" + orderId + \"*: Please share your payment screenshot to confirm.\");",
    "            window.open(\"https://wa.me/\" + rawPhone + \"?text=\" + encodeURIComponent(msg), \"_blank\");",
    "        }",
    "",
    "        function startSocialProofEngine() {",
    "            var names = [\"Ananya\", \"Priya\", \"Suresh\", \"Kriti\", \"Lakshmi\", \"Neha\", \"Rahul\", \"Vikram\", \"Rohan\", \"Arjun\", \"Pooja\", \"Karthik\"];",
    "            var cities = [\"Hyderabad\", \"Bengaluru\", \"Mumbai\", \"Delhi\", \"Pune\", \"Chennai\", \"Vijayawada\", \"Ahmedabad\", \"Jaipur\"];",
    "            var apps = [\"PhonePe\", \"Google Pay\", \"Navi UPI\"];",
    "            setInterval(function() {",
    "                if (!storeProducts.length) return;",
    "                var rProd = storeProducts[Math.floor(Math.random() * storeProducts.length)];",
    "                document.getElementById('sp-name').innerText = names[Math.floor(Math.random() * names.length)];",
    "                document.getElementById('sp-city').innerText = cities[Math.floor(Math.random() * cities.length)];",
    "                document.getElementById('sp-app').innerText = apps[Math.floor(Math.random() * apps.length)];",
    "                document.getElementById('sp-product').innerText = rProd.title;",
    "                document.getElementById('sp-img').src = getProductImage(rProd);",
    "                var popup = document.getElementById('social-proof-popup');",
    "                popup.classList.remove('hidden'); popup.classList.add('live-popup');",
    "                setTimeout(function() { popup.classList.add('hidden'); popup.classList.remove('live-popup'); }, 4500);",
    "            }, 13000);",
    "        }",
    "",
    "        async function fetchCatalog() {",
    "            try {",
    "                var res = await fetch('/api/products');",
    "                var data = await res.json();",
    "                if (data.settings) { STORE_CONFIG = Object.assign(STORE_CONFIG, data.settings); applyStoreConfigToUI(); }",
    "                if (data.products && data.products.length) storeProducts = data.products;",
    "            } catch (e) {}",
    "            filterAndRenderCatalog(); renderRecentlyViewed(); updateCartUI();",
    "        }",
    "",
    "        loadLocalState();",
    "        document.getElementById('auto-delivery-date').innerText = getDeliveryWindowString();",
    "        document.getElementById('hero-delivery-date').innerText = getDeliveryWindowString();",
    "        applyStoreConfigToUI();",
    "        updateHeaderIndicators();",
    "        fetchCatalog();",
    "        startSocialProofEngine();",
    "    </script>",
    "</body>",
    "</html>",
    ""
].join('\n');

app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.send(frontendHTML); });
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.use((err, req, res, next) => {
    console.error('[SERVER_ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Internal server safeguard triggered.' });
});

process.on('uncaughtException', err => console.error('[UNCAUGHT_EXCEPTION]', err.message));
process.on('unhandledRejection', reason => console.error('[UNHANDLED_REJECTION]', reason));

app.listen(PORT, '0.0.0.0', () => {
    const stats = db.getStorageStats();
    const cfg = getLiveSettings();
    console.log('\n💎 ' + cfg.storeName.toUpperCase() + ' v8.1 (ZERO-GLITCH RENDER PRO EDITION) LIVE ON PORT ' + PORT);
    console.log('🗄️  Storage Engine: ' + stats.engine + ' (Capacity: ' + stats.capacityGB + ' GB | Shards: ' + stats.shardCount + ')');
    console.log('💳 UPI Redirect: PhonePe | Google Pay | Navi | Safe-Open + 1-Tap Screenshot Proof (' + cfg.upiId + ')');
    console.log('📦 Tracking: Last 4 Phone Digits Instant Tracker | 🔐 Merchant PIN: ' + MERCHANT_PIN);
});
