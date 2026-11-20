const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let memoryOrders = [];
let memoryReviews = [
    { id: 101, productId: 51, name: "Masterji Rajesh Sharma", city: "Hyderabad", rating: 5, date: "2 days ago", text: "At ₹1,299 this is a steal. Cut 14 silk blouse linings in 20 minutes! The red laser guide keeps my hand steady and thumb pain is gone." },
    { id: 102, productId: 52, name: "Farheen Boutique", city: "Surat", rating: 5, date: "Yesterday", text: "Ordered 3 Magnetic Laser Guides for our workshop Jack machines. Our karigars stitch straight piping without marking chalk lines now." },
    { id: 103, productId: 48, name: "Rohan Kapoor", city: "Delhi NCR", rating: 5, date: "1 day ago", text: "You can literally feel the EMS microcurrents contracting your jawline muscles. Morning facial bloat disappears in 5 minutes." },
    { id: 104, productId: 66, name: "Karthik Nair (B.Tech)", city: "Bengaluru", rating: 5, date: "2 days ago", text: "The ₹449 foldable laptop stand saved my posture during 6-hour coding and exam prep sessions in my hostel room." },
    { id: 105, productId: 67, name: "Harshvardhan Stores", city: "Pune", rating: 5, date: "3 days ago", text: "At ₹499, the pocket thermal printer prints quick parcel labels and shelf tags without buying expensive ink cartridges." },
    { id: 106, productId: 53, name: "Lakshmi Tailors", city: "Chennai", rating: 5, date: "5 days ago", text: "The LED light on the seam ripper is a lifesaver for night work on dark silk sarees. Needle threader works in 1 second." }
];

try {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ orders: [], reviews: memoryReviews }, null, 4));
    } else {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.orders)) memoryOrders = parsed.orders;
        if (parsed && Array.isArray(parsed.reviews) && parsed.reviews.length > 0) memoryReviews = parsed.reviews;
    }
} catch (error) {
    console.log("Cloud Read-Only Mode active. Using RAM storage + WhatsApp tunnel.");
}

function saveDatabaseToDisk() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ orders: memoryOrders, reviews: memoryReviews }, null, 4));
    } catch (e) {}
}

// 1. PLACE ORDER API (Enforces Compulsory Address, Pincode & UPI UTR Verification)
app.post('/api/place-order', (req, res) => {
    try {
        const { orderId, customer, paymentVerification, cart, subtotal, discount, bundleDiscount, orderBump, freeGiftUnlocked, total, estimatedDelivery } = req.body;

        if (!customer || !customer.name || !customer.phone || !customer.address || !customer.pincode) {
            return res.status(400).json({ success: false, message: 'Complete delivery address and 6-digit pincode are compulsory.' });
        }
        if (!paymentVerification || !paymentVerification.utrLast4 || !paymentVerification.confirmed) {
            return res.status(400).json({ success: false, message: 'UPI Payment verification (UTR/Ref digits) is compulsory.' });
        }

        const finalOrderId = orderId || ('ORD-' + Math.floor(100000 + Math.random() * 900000));
        const newOrder = {
            orderId: finalOrderId,
            date: new Date().toISOString(),
            customer: customer,
            paymentVerification: paymentVerification,
            cart: cart || [],
            financials: { subtotal, discount, bundleDiscount: bundleDiscount || 0, orderBumpAdded: orderBump, freeGiftUnlocked: !!freeGiftUnlocked, total },
            estimatedDelivery: estimatedDelivery || '4-6 Business Days',
            status: 'UPI UTR Submitted (Ref #' + paymentVerification.utrLast4 + ')',
            stage: 2,
            courierInfo: ''
        };

        memoryOrders.unshift(newOrder);
        saveDatabaseToDisk();

        console.log("\n📲 [NEW VERIFIED ORDER] " + finalOrderId + " | UTR: " + paymentVerification.utrLast4 + " | Total: ₹" + total);
        res.status(200).json({ success: true, order: newOrder });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error processing order." });
    }
});

// 2. TRACK SINGLE ORDER API
app.get('/api/track/:orderId', (req, res) => {
    try {
        const searchId = (req.params.orderId || '').trim().toUpperCase();
        const found = memoryOrders.find(o => o.orderId.toUpperCase() === searchId);
        if (found) return res.status(200).json({ found: true, order: found });
        return res.status(404).json({ found: false, message: 'Order not in current session memory' });
    } catch (err) {
        res.status(500).json({ found: false });
    }
});

// 3. REVIEWS API
app.get('/api/reviews', (req, res) => res.status(200).json({ reviews: memoryReviews }));

app.post('/api/reviews', (req, res) => {
    try {
        const { productId, name, city, rating, text } = req.body;
        if (!name || !text) return res.status(400).json({ success: false });
        const newRev = {
            id: Date.now(),
            productId: Number(productId) || 51,
            name: String(name).trim().slice(0, 40),
            city: String(city || 'India').trim().slice(0, 30),
            rating: Math.min(5, Math.max(1, Number(rating) || 5)),
            date: 'Just now',
            text: String(text).trim().slice(0, 280)
        };
        memoryReviews.unshift(newRev);
        saveDatabaseToDisk();
        res.status(200).json({ success: true, review: newRev });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// 4. MERCHANT ADMIN API
app.get('/api/admin/orders', (req, res) => res.status(200).json({ orders: memoryOrders }));

app.post('/api/admin/update-order', (req, res) => {
    try {
        const { pin, orderId, status, stage, courierInfo } = req.body;
        if (pin !== '9014') return res.status(403).json({ success: false, message: 'Invalid Merchant PIN' });
        const order = memoryOrders.find(o => o.orderId.toUpperCase() === (orderId || '').toUpperCase());
        if (!order) return res.status(404).json({ success: false, message: 'Order not found in server memory' });
        if (status) order.status = status;
        if (stage) order.stage = Number(stage);
        if (courierInfo !== undefined) order.courierInfo = courierInfo;
        saveDatabaseToDisk();
        res.status(200).json({ success: true, order });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

const frontendHTML = String.raw`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prem's Store | Viral Problem-Solvers, Tailoring Pro Tools & Under-₹500 Essentials India</title>
    <meta name="description" content="Shop 74+ viral problem-solvers, laser tailoring tools, looksmaxxing & clinical beauty hardware, and under-₹500 essentials for students and business owners. 0-fee UPI checkout.">
    <meta name="keywords" content="tailoring tools india, laser fabric scissors, sewing machine laser guide, under 500 gadgets india, student desk accessories, small business tools, prem store">
    <meta name="robots" content="index, follow">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        brandPrimary: '#FF3366',
                        whatsapp: '#25D366',
                        darkBg: '#09090b',
                        darkSurface: '#121215',
                        darkBorder: '#27272a'
                    },
                    fontFamily: { sans: ['Outfit', 'sans-serif'] }
                }
            }
        }
    </script>
    <style>
        html { scroll-behavior: smooth; }
        body { background-color: #09090b; color: #ffffff; overflow-x: hidden; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #09090b; }
        ::-webkit-scrollbar-thumb { background: #FF3366; border-radius: 10px; }
        .glass { background: rgba(18, 18, 21, 0.94); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08); }
        .btn-glow { box-shadow: 0 0 20px rgba(255, 51, 102, 0.45); transition: all 0.25s ease; }
        .btn-glow:hover { box-shadow: 0 0 30px rgba(255, 51, 102, 0.75); transform: translateY(-1px); }
        .btn-glow-whatsapp { box-shadow: 0 0 20px rgba(37, 211, 102, 0.35); transition: all 0.25s ease; }
        .btn-glow-whatsapp:hover:not(:disabled) { box-shadow: 0 0 30px rgba(37, 211, 102, 0.7); transform: translateY(-1px); }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes slideIn { from { transform: translateX(-110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .live-popup { animation: slideIn 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
        @keyframes pulseBorder { 0%, 100% { border-color: rgba(255,51,102,0.4); } 50% { border-color: rgba(255,51,102,1); } }
        .pulse-border { animation: pulseBorder 2s infinite; }
    </style>
</head>
<body class="font-sans min-h-screen flex flex-col relative selection:bg-brandPrimary selection:text-white pb-16 sm:pb-0">

    <!-- TOP URGENCY & VOLUME DEAL BAR -->
    <div class="bg-gradient-to-r from-brandPrimary via-pink-600 to-rose-600 text-white text-[11px] md:text-xs font-bold py-2 px-4 text-center flex flex-wrap items-center justify-center gap-2 z-50">
        <span>🔥 FACTORY-DIRECT PRICE DROP + 10 UNDER-₹500 STUDENT & BUSINESS PICKS!</span>
        <span class="hidden sm:inline">•</span>
        <span>Buy 2 = Extra 5% OFF | Buy 3+ = Extra 10% OFF + Code <strong class="underline cursor-pointer bg-black/30 px-1.5 py-0.5 rounded" onclick="applyQuickCoupon('PREM10')">PREM10</strong></span>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toast-box" class="fixed top-14 right-4 z-[120] hidden bg-white text-black px-4 py-3 rounded-xl shadow-2xl border-l-4 border-brandPrimary text-xs font-bold items-center space-x-2">
        <i class="fa-solid fa-circle-check text-brandPrimary text-base"></i>
        <span id="toast-text">Action completed</span>
    </div>

    <!-- FOMO LIVE BUYER POPUP -->
    <div id="social-proof-popup" class="fixed bottom-16 sm:bottom-5 left-4 z-40 glass p-3.5 rounded-xl shadow-2xl flex items-center space-x-3.5 hidden max-w-xs border-l-4 border-l-brandPrimary pointer-events-none">
        <img id="sp-img" src="" class="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0">
        <div class="overflow-hidden">
            <p class="text-[11px] text-slate-300 truncate"><span id="sp-name" class="font-bold text-white"></span> in <span id="sp-city" class="text-white font-semibold"></span> bought</p>
            <p id="sp-product" class="text-xs font-extrabold text-brandPrimary truncate"></p>
            <p class="text-[10px] text-emerald-400 mt-0.5 flex items-center"><i class="fa-solid fa-circle-check mr-1"></i>Verified UPI Buyer • Just now</p>
        </div>
    </div>

    <!-- STICKY HEADER -->
    <header class="sticky top-0 z-40 glass border-b border-white/10 shadow-lg">
        <div class="container mx-auto px-4 py-3.5 flex flex-wrap justify-between items-center gap-3 max-w-7xl">
            <a href="#" onclick="setCategoryFilter('All'); return false;" class="text-2xl font-black tracking-tighter text-white flex items-center">
                PREM<span class="text-brandPrimary">STORE</span>
                <span class="ml-2 text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest hidden sm:inline-block">Verified India</span>
            </a>

            <!-- SEARCH BAR -->
            <div class="relative flex-grow max-w-md order-3 md:order-2 w-full md:w-auto">
                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input type="text" id="search-input" oninput="filterAndRenderCatalog()" placeholder="Search 74+ items: Laser Scissors, Laptop Stand, Pocket Printer..." class="w-full pl-9 pr-8 py-2 bg-darkSurface border border-darkBorder rounded-full text-xs text-white placeholder-slate-500 outline-none focus:border-brandPrimary transition-colors">
                <button onclick="clearSearch()" id="clear-search-btn" class="hidden absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <!-- ACTION BUTTONS -->
            <div class="flex items-center space-x-2 order-2 md:order-3">
                <button onclick="openSpinModal()" id="mystery-vault-btn" class="flex items-center space-x-1 text-[11px] font-bold text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 px-3 py-2 rounded-full border border-amber-500/30 transition-all">
                    <i class="fa-solid fa-dharmachakra animate-spin"></i>
                    <span class="hidden sm:inline">Spin &</span><span>Win</span>
                </button>
                <button onclick="openTrackModal()" class="flex items-center space-x-1.5 text-xs font-bold text-slate-200 hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-3 py-2 rounded-full border border-white/10">
                    <i class="fa-solid fa-truck-fast text-brandPrimary"></i>
                    <span class="hidden sm:inline">Track Order</span>
                </button>
                <button onclick="toggleCart()" class="relative flex items-center space-x-2 bg-brandPrimary/15 hover:bg-brandPrimary/25 px-4 py-2 rounded-full transition-all border border-brandPrimary/40">
                    <i class="fa-solid fa-bag-shopping text-brandPrimary"></i>
                    <span class="text-xs font-bold text-white hidden sm:inline">Cart</span>
                    <span id="cart-count" class="bg-brandPrimary text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-black shadow">0</span>
                </button>
            </div>
        </div>
    </header>

    <!-- HERO SECTION -->
    <main class="container mx-auto px-4 py-6 flex-grow max-w-7xl">
        <div class="flex flex-col items-center text-center mb-6">
            <div class="inline-flex items-center space-x-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3.5 py-1 rounded-full text-[11px] font-bold mb-2.5 uppercase tracking-wider">
                <i class="fa-solid fa-tags"></i>
                <span>Wholesale Price Drop + 10 Under-₹500 Student & Business Essentials</span>
            </div>
            <h1 class="text-3xl md:text-5xl font-black text-white mb-2 tracking-tight">India's #1 Viral Problem-Solvers.</h1>
            <p class="text-slate-400 max-w-2xl text-xs md:text-sm">Precision laser tailoring tools, looksmaxxing & clinical beauty hardware, under-₹500 student & business gear, and daily utility upgrades. Direct 0%-fee UPI checkout.</p>
        </div>

        <!-- PSYCHOLOGICAL TRUST & VOLUME RIBBON -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-6">
            <div class="bg-darkSurface border border-white/5 rounded-xl p-3 flex items-center space-x-3">
                <i class="fa-solid fa-graduation-cap text-cyan-400 text-lg"></i>
                <div><p class="text-xs font-bold text-white">10 Under-₹500 Picks</p><p class="text-[10px] text-slate-400">Students & Founders</p></div>
            </div>
            <div class="bg-darkSurface border border-white/5 rounded-xl p-3 flex items-center space-x-3">
                <i class="fa-solid fa-layer-group text-brandPrimary text-lg"></i>
                <div><p class="text-xs font-bold text-white">Buy 2+ Get Extra Off</p><p class="text-[10px] text-slate-400">Auto Bundle Discounts</p></div>
            </div>
            <div class="bg-darkSurface border border-white/5 rounded-xl p-3 flex items-center space-x-3">
                <i class="fa-solid fa-shield-halved text-emerald-400 text-lg"></i>
                <div><p class="text-xs font-bold text-white">0% UPI Gateway Fee</p><p class="text-[10px] text-slate-400">7-Day Easy Replacement</p></div>
            </div>
            <div class="bg-darkSurface border border-white/5 rounded-xl p-3 flex items-center space-x-3">
                <i class="fa-brands fa-whatsapp text-whatsapp text-lg"></i>
                <div><p class="text-xs font-bold text-white">Live WhatsApp Desk</p><p class="text-[10px] text-slate-400">+91 9014044915</p></div>
            </div>
        </div>

        <!-- FILTER & SORT BAR -->
        <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 mb-6 pb-3 border-b border-white/5">
            <div class="flex items-center space-x-2 overflow-x-auto hide-scrollbar py-1">
                <button data-cat="All" onclick="setCategoryFilter('All')" class="cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold shadow-glow transition-all whitespace-nowrap">All Products (74)</button>
                <button data-cat="Top Winners" onclick="setCategoryFilter('Top Winners')" class="cat-btn bg-white/5 text-rose-300 border border-rose-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-white/10 transition-colors whitespace-nowrap">🔥 #1 Top Winners</button>
                <button data-cat="Under 500" onclick="setCategoryFilter('Under 500')" class="cat-btn bg-white/5 text-cyan-300 border border-cyan-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-white/10 transition-colors whitespace-nowrap">🎓 Under ₹500 (Student & Business)</button>
                <button data-cat="Tailoring & Boutique" onclick="setCategoryFilter('Tailoring & Boutique')" class="cat-btn bg-white/5 text-amber-300 border border-amber-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-white/10 transition-colors whitespace-nowrap">✂️ Tailoring & Boutique</button>
                <button data-cat="Looks & Grooming" onclick="setCategoryFilter('Looks & Grooming')" class="cat-btn bg-white/5 text-pink-300 border border-pink-500/30 px-4 py-2 rounded-full text-xs font-bold hover:bg-white/10 transition-colors whitespace-nowrap">🗿 Looks & Beauty</button>
                <button data-cat="Home & Kitchen" onclick="setCategoryFilter('Home & Kitchen')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🏠 Home & Kitchen</button>
                <button data-cat="Smart Tech & Utility" onclick="setCategoryFilter('Smart Tech & Utility')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">⚡ Smart Tech & Utility</button>
                <button data-cat="Car & Bike" onclick="setCategoryFilter('Car & Bike')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🚗 Car & Bike</button>
                <button data-cat="Footwear" onclick="setCategoryFilter('Footwear')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">👟 Footwear</button>
                <button data-cat="Apparel" onclick="setCategoryFilter('Apparel')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🧥 Apparel</button>
            </div>

            <div class="flex items-center space-x-2 shrink-0 self-end md:self-auto">
                <span class="text-xs text-slate-400">Sort:</span>
                <select id="sort-select" onchange="filterAndRenderCatalog()" class="bg-darkSurface border border-darkBorder text-white text-xs rounded-xl px-3 py-2 outline-none focus:border-brandPrimary">
                    <option value="featured">Featured Winners First</option>
                    <option value="price-asc">Price: Low to High</option>
                    <option value="price-desc">Price: High to Low</option>
                    <option value="rating">Highest Rated</option>
                </select>
            </div>
        </div>

        <!-- PRODUCT COUNT & GRID -->
        <div class="mb-4 flex justify-between items-center text-xs text-slate-400">
            <span id="results-counter">Showing all 74 products</span>
            <span class="text-emerald-400 font-semibold"><i class="fa-solid fa-truck-fast mr-1"></i>Est. Delivery: <strong id="hero-delivery-date">Calculating...</strong></span>
        </div>

        <div id="product-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"></div>

        <!-- VERIFIED CUSTOMER REVIEWS SECTION -->
        <section id="reviews-section" class="mt-16 pt-12 border-t border-white/10">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
                <div>
                    <span class="text-brandPrimary text-xs font-black uppercase tracking-widest">4.9/5 Average Rating • 6,200+ Verified Indian Buyers</span>
                    <h2 class="text-2xl md:text-3xl font-black text-white mt-1">Real Reviews from Masterjis, Students, Founders & Homes</h2>
                </div>
                <button onclick="toggleReviewForm()" class="bg-white/10 hover:bg-brandPrimary text-white text-xs font-bold px-4 py-2.5 rounded-xl border border-white/10 transition-colors">
                    <i class="fa-solid fa-pen-to-square mr-1.5"></i>Write a Verified Review
                </button>
            </div>

            <div id="add-review-box" class="hidden bg-darkSurface border border-brandPrimary/40 rounded-2xl p-5 mb-8">
                <h3 class="text-sm font-black text-white mb-3">Submit Your Product Feedback</h3>
                <form onsubmit="submitCustomerReview(event)" class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input type="text" id="rev-name" placeholder="Your Name / Boutique / College *" required class="bg-black border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary">
                    <input type="text" id="rev-city" placeholder="Your City (e.g. Hyderabad) *" required class="bg-black border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary">
                    <select id="rev-product" class="bg-black border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary"></select>
                    <textarea id="rev-text" placeholder="Share how this product helped you..." required rows="2" class="sm:col-span-2 bg-black border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary"></textarea>
                    <button type="submit" class="bg-brandPrimary text-white font-black rounded-xl text-xs py-2.5 uppercase tracking-wider btn-glow">Post Verified Review</button>
                </form>
            </div>

            <div id="reviews-wall-grid" class="grid grid-cols-1 md:grid-cols-3 gap-4"></div>
        </section>
    </main>

    <!-- MOBILE STICKY BOTTOM CONVERSION BAR -->
    <div class="sm:hidden fixed bottom-0 inset-x-0 z-40 glass border-t border-white/15 px-3 py-2.5 flex items-center justify-between gap-2">
        <div>
            <span class="text-[10px] text-cyan-300 font-bold block"><i class="fa-solid fa-graduation-cap mr-1"></i>10 Under-₹500 Picks Live</span>
            <span class="text-xs font-black text-white">Code <span class="text-brandPrimary">PREM10</span> Active</span>
        </div>
        <div class="flex items-center space-x-1.5">
            <button onclick="setCategoryFilter('Under 500'); window.scrollTo(0,250);" class="bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-[11px] font-bold px-2.5 py-2 rounded-xl">&lt;₹500</button>
            <button onclick="setCategoryFilter('Tailoring & Boutique'); window.scrollTo(0,250);" class="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-bold px-2.5 py-2 rounded-xl">✂️ Tailor</button>
            <button onclick="toggleCart()" class="bg-brandPrimary text-white text-xs font-black px-3.5 py-2 rounded-xl btn-glow">Cart</button>
        </div>
    </div>

    <!-- FOOTER WITH MERCHANT PORTAL TRIGGER -->
    <footer class="border-t border-white/10 bg-black/70 py-8 px-4 mt-16 text-xs text-slate-500">
        <div class="container mx-auto max-w-7xl flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
                <span class="font-black text-white text-base">PREM<span class="text-brandPrimary">STORE</span></span>
                <p class="mt-1">Direct UPI Checkout • 24/7 WhatsApp Support (+91 9014044915)</p>
            </div>
            <div class="flex items-center space-x-4">
                <a href="#reviews-section" class="hover:text-white transition-colors">Customer Reviews</a>
                <span>•</span>
                <button onclick="openTrackModal()" class="hover:text-white transition-colors">Track Order</button>
                <span>•</span>
                <button onclick="openAdminModal()" class="hover:text-brandPrimary transition-colors flex items-center space-x-1"><i class="fa-solid fa-lock text-[10px]"></i><span>Merchant Portal</span></button>
            </div>
        </div>
    </footer>

    <!-- SPIN-TO-WIN GAMIFIED VIP WHEEL MODAL -->
    <div id="spin-modal" class="fixed inset-0 z-[95] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4">
        <div class="glass rounded-2xl w-full max-w-sm p-6 text-center relative border border-amber-500/40 shadow-2xl">
            <button onclick="closeSpinModal()" class="absolute top-3 right-3 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            <div class="w-16 h-16 rounded-full bg-gradient-to-tr from-brandPrimary to-amber-400 mx-auto flex items-center justify-center mb-3 shadow-lg" id="spin-wheel-icon">
                <i class="fa-solid fa-gift text-2xl text-white"></i>
            </div>
            <span class="text-[10px] font-black uppercase tracking-widest text-amber-300">VIP Visitor Reward</span>
            <h3 class="text-xl font-black text-white mt-1 mb-2">Unlock Your Mystery Rebate!</h3>
            <p class="text-xs text-slate-300 mb-4">Tap Spin below to unlock an instant discount on Tailoring, Looks, Student & Business gear.</p>
            <div id="spin-result-box" class="hidden bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-3 mb-4 text-xs text-emerald-300 font-bold">
                🎉 JACKPOT! 10% OFF Code <strong class="text-white">PREM10</strong> + Priority Dispatch Auto-Applied to Your Cart!
            </div>
            <button id="spin-action-btn" onclick="executeVipSpin()" class="w-full bg-gradient-to-r from-brandPrimary to-amber-500 text-white font-black py-3.5 rounded-xl text-xs uppercase tracking-wider btn-glow">
                🎰 Tap to Spin & Claim Now
            </button>
        </div>
    </div>

    <!-- QUICK VIEW PRODUCT MODAL -->
    <div id="quickview-modal" class="fixed inset-0 z-[70] bg-black/90 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4">
        <div class="glass rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl border border-white/15 relative grid md:grid-cols-2 max-h-[94vh] overflow-y-auto hide-scrollbar">
            <button onclick="closeQuickView()" class="absolute top-3 right-3 z-30 w-9 h-9 rounded-full bg-black/80 border border-white/15 text-white hover:bg-brandPrimary flex items-center justify-center transition-colors"><i class="fa-solid fa-xmark"></i></button>
            
            <div class="bg-black flex flex-col justify-between p-4 border-b md:border-b-0 md:border-r border-white/10">
                <div>
                    <div class="relative aspect-square rounded-xl overflow-hidden bg-darkSurface mb-3">
                        <img id="qv-img" src="" class="w-full h-full object-cover transition-all duration-300">
                        <span id="qv-badge" class="absolute top-3 left-3 bg-brandPrimary text-white text-[10px] font-black px-3 py-1 rounded-full uppercase z-20 shadow-lg"></span>
                    </div>
                    <p class="text-[10px] text-slate-400 uppercase font-bold mb-2 text-center">Tap Thumbnails to Inspect Angles:</p>
                    <div id="qv-thumbnails" class="flex justify-center space-x-2.5 overflow-x-auto py-1 mb-4"></div>
                </div>

                <div id="qv-bundle-box" class="bg-darkSurface border border-amber-500/30 rounded-xl p-3"></div>
            </div>

            <div class="p-5 sm:p-6 flex flex-col justify-between bg-darkSurface">
                <div>
                    <div class="flex items-center justify-between text-xs mb-2">
                        <div class="flex items-center space-x-1 text-amber-400">
                            <i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i>
                            <span id="qv-rating" class="font-bold text-white ml-1"></span>
                        </div>
                        <span id="qv-live-viewers" class="text-[11px] text-rose-400 font-bold animate-pulse"><i class="fa-regular fa-eye mr-1"></i>18 viewing now</span>
                    </div>

                    <h3 id="qv-title" class="text-xl sm:text-2xl font-black text-white mb-2 leading-snug"></h3>
                    
                    <div class="flex items-baseline space-x-2.5 mb-3">
                        <span id="qv-price" class="text-3xl font-black text-brandPrimary"></span>
                        <span id="qv-mrp" class="text-sm text-slate-500 line-through font-mono"></span>
                        <span class="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-bold">Verified Value</span>
                    </div>

                    <div class="grid grid-cols-3 gap-1.5 mb-3 text-center text-[10px]">
                        <div class="bg-black/60 border border-white/10 rounded-lg py-1.5 px-1">
                            <span class="block text-slate-400">Buy 1 Unit</span>
                            <strong class="text-white">10% Code PREM10</strong>
                        </div>
                        <div class="bg-brandPrimary/15 border border-brandPrimary/40 rounded-lg py-1.5 px-1">
                            <span class="block text-pink-300 font-bold">Buy 2 Units</span>
                            <strong class="text-white">+5% Extra Off</strong>
                        </div>
                        <div class="bg-emerald-500/15 border border-emerald-500/40 rounded-lg py-1.5 px-1">
                            <span class="block text-emerald-300 font-bold">Buy 3+ Units</span>
                            <strong class="text-white">+10% Extra Off</strong>
                        </div>
                    </div>

                    <p id="qv-desc" class="text-xs sm:text-sm text-slate-300 leading-relaxed mb-4"></p>

                    <div class="bg-black/50 p-3 rounded-xl border border-white/5 mb-4">
                        <label class="text-[10px] font-bold text-slate-400 uppercase block mb-1.5">Check Express Courier Availability</label>
                        <div class="flex space-x-2">
                            <input type="text" id="qv-pincode" maxlength="6" placeholder="Enter 6-digit Pincode" class="w-full bg-darkSurface border border-darkBorder rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-brandPrimary">
                            <button onclick="checkPincode()" class="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-1.5 rounded-lg shrink-0">Verify</button>
                        </div>
                        <p id="qv-pin-result" class="text-[11px] text-emerald-400 font-semibold mt-1.5 hidden"></p>
                    </div>

                    <div class="border-t border-white/10 pt-3 mb-4">
                        <p class="text-[11px] font-bold uppercase text-slate-400 mb-2"><i class="fa-solid fa-comment-dots text-brandPrimary mr-1"></i>Recent Buyer Feedback:</p>
                        <div id="qv-reviews-list" class="space-y-2 max-h-24 overflow-y-auto pr-1"></div>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-2.5 pt-2 border-t border-white/10">
                    <button id="qv-add-btn" class="w-full bg-white/10 hover:bg-white/20 text-white font-bold py-3.5 rounded-xl text-xs uppercase tracking-wider transition-all">Add to Cart</button>
                    <button id="qv-buy-btn" class="w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow text-xs uppercase tracking-wider">Buy Now • Instant UPI</button>
                </div>
            </div>
        </div>
    </div>

    <!-- GAMIFIED SLIDE-OUT CART SIDEBAR -->
    <div id="cart-sidebar" class="fixed inset-y-0 right-0 z-50 w-full max-w-md glass shadow-2xl transform translate-x-full transition-transform duration-300 flex flex-col border-l border-white/10">
        <div class="p-4 flex justify-between items-center border-b border-white/10 bg-black/60">
            <h3 class="text-lg font-black text-white flex items-center"><i class="fa-solid fa-lock text-brandPrimary mr-2 text-sm"></i> Your Reserved Cart</h3>
            <button onclick="toggleCart()" class="text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
        </div>

        <div class="bg-red-500/10 py-2 px-4 border-b border-red-500/20 flex items-center justify-between text-xs">
            <span class="font-bold text-red-400"><i class="fa-solid fa-stopwatch mr-1"></i>Stock reserved for: <strong id="cart-timer" class="font-mono text-white bg-red-500/30 px-1.5 py-0.5 rounded">10:00</strong></span>
            <span class="text-slate-300 text-[11px]">Est: <strong id="auto-delivery-date" class="text-emerald-400">4-6 Days</strong></span>
        </div>

        <!-- 3-Tier Gamified Milestone Progress Bar -->
        <div class="p-3.5 border-b border-white/10 bg-darkSurface">
            <div class="flex justify-between text-[11px] font-bold mb-1.5 text-slate-200" id="shipping-text">Add ₹899 for FREE VIP Express Shipping</div>
            <div class="w-full bg-black rounded-full h-2 border border-white/10 overflow-hidden mb-1.5">
                <div id="shipping-progress" class="bg-brandPrimary h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-slate-400 font-bold uppercase tracking-wider">
                <span>₹899: Free Ship</span>
                <span>₹1,699: 10% Rebate</span>
                <span>₹2,499: Free ₹399 Gift</span>
            </div>
        </div>

        <div id="cart-items" class="flex-grow p-4 overflow-y-auto space-y-3"></div>

        <!-- Cart Footer -->
        <div class="p-5 bg-black/95 border-t border-white/10 space-y-3">
            <div class="flex space-x-2">
                <input type="text" id="coupon-input" placeholder="Promo code (Try PREM10)" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3 py-2 text-xs text-white uppercase outline-none focus:border-brandPrimary">
                <button onclick="applyCouponInput()" class="bg-white/10 hover:bg-white/20 text-white font-bold px-4 py-2 rounded-xl text-xs shrink-0">Apply</button>
            </div>

            <label class="flex items-start space-x-3 bg-brandPrimary/10 border border-brandPrimary/30 p-3 rounded-xl cursor-pointer hover:bg-brandPrimary/15 transition-colors">
                <input type="checkbox" id="order-bump" onchange="updateCartUI()" checked class="w-4 h-4 mt-0.5 accent-brandPrimary cursor-pointer">
                <div class="text-xs">
                    <div class="font-bold text-white flex justify-between">
                        <span>VIP Transit Insurance & Priority Dispatch</span>
                        <span class="text-brandPrimary font-black ml-2">+₹99</span>
                    </div>
                    <p class="text-[10px] text-slate-400 mt-0.5">Instant replacement guarantee if damaged in courier transit.</p>
                </div>
            </label>

            <div class="space-y-1 text-xs pt-1">
                <div class="flex justify-between text-slate-400"><span>Subtotal:</span><span id="cart-subtotal">₹0</span></div>
                <div id="bundle-discount-row" class="flex justify-between text-amber-300 font-bold hidden"><span>Multi-Item Bundle Savings:</span><span id="cart-bundle-discount">-₹0</span></div>
                <div id="discount-row" class="flex justify-between text-emerald-400 font-bold hidden"><span>VIP 10% Coupon (PREM10):</span><span id="cart-discount">-₹0</span></div>
                <div id="free-gift-row" class="flex justify-between text-pink-400 font-bold hidden"><span>🎁 Mystery Tailoring/Utility Gift (₹399):</span><span>FREE</span></div>
                <div class="flex justify-between text-xl font-black text-white border-t border-white/10 pt-2"><span>Total Payable:</span><span id="cart-total" class="text-brandPrimary">₹0</span></div>
            </div>

            <button onclick="openShippingModal()" class="w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow flex items-center justify-center space-x-2 uppercase text-xs tracking-wider">
                <span>Proceed to Compulsory Verification</span>
                <i class="fa-solid fa-arrow-right"></i>
            </button>
        </div>
    </div>

    <!-- COMPULSORY ADDRESS + COMPULSORY UPI PAYMENT CHECKOUT MODAL -->
    <div id="shipping-modal" class="fixed inset-0 z-[75] bg-black/92 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl relative border border-white/15 my-auto max-h-[95vh] overflow-y-auto hide-scrollbar">
            <button onclick="closeShippingModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>

            <div class="flex items-center space-x-2 text-brandPrimary text-xs font-bold uppercase tracking-wider mb-1">
                <i class="fa-solid fa-lock"></i>
                <span>2-Step Compulsory Order & Payment Lock</span>
            </div>
            <h3 class="text-xl font-black text-white mb-3">Complete Address & UPI Payment</h3>

            <div class="grid grid-cols-2 gap-2 mb-4 text-[11px]">
                <div class="bg-emerald-500/15 border border-emerald-500/40 rounded-xl p-2.5 text-emerald-300 font-bold flex items-center space-x-2">
                    <i class="fa-solid fa-circle-check text-base"></i>
                    <div><span class="block text-white">Direct UPI Prepaid</span><span>₹0 Fee • Instant Dispatch</span></div>
                </div>
                <div class="bg-white/5 border border-white/10 rounded-xl p-2.5 text-slate-500 flex items-center space-x-2 opacity-60">
                    <i class="fa-solid fa-ban text-base"></i>
                    <div><span class="block line-through">Cash on Delivery</span><span>+₹149 Fee (Paused)</span></div>
                </div>
            </div>

            <form id="shipping-form" onsubmit="submitOrderAndRedirectToWhatsApp(event)" class="space-y-3">
                <div class="bg-darkSurface border border-white/10 rounded-xl p-3.5 space-y-2.5">
                    <p class="text-[11px] font-black uppercase text-white flex items-center"><span class="bg-brandPrimary text-white w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] mr-1.5">1</span>Mandatory Courier Address</p>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <input type="text" id="cust-name" placeholder="Full Name / Boutique / College *" required minlength="3" class="w-full px-3 py-2.5 bg-black border border-darkBorder rounded-lg text-xs text-white outline-none focus:border-brandPrimary">
                        <input type="tel" id="cust-phone" placeholder="10-Digit WhatsApp Mobile *" required pattern="[0-9]{10}" maxlength="10" class="w-full px-3 py-2.5 bg-black border border-darkBorder rounded-lg text-xs text-white outline-none focus:border-brandPrimary">
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                        <input type="text" id="cust-city" placeholder="City & State *" required minlength="3" class="sm:col-span-2 w-full px-3 py-2.5 bg-black border border-darkBorder rounded-lg text-xs text-white outline-none focus:border-brandPrimary">
                        <input type="text" id="cust-pincode" placeholder="6-Digit Pincode *" required pattern="[1-9][0-9]{5}" maxlength="6" class="w-full px-3 py-2.5 bg-black border border-darkBorder rounded-lg text-xs text-white font-mono outline-none focus:border-brandPrimary">
                    </div>
                    <textarea id="cust-address" placeholder="Complete House/Hostel/Shop No, Building, Street, Landmark *" required minlength="10" rows="2" class="w-full px-3 py-2 bg-black border border-darkBorder rounded-lg text-xs text-white outline-none focus:border-brandPrimary"></textarea>
                </div>

                <div class="bg-darkSurface border border-brandPrimary/40 rounded-xl p-3.5 space-y-3 pulse-border">
                    <div class="flex justify-between items-center border-b border-white/10 pb-2">
                        <div>
                            <p class="text-[11px] font-black uppercase text-white flex items-center"><span class="bg-brandPrimary text-white w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] mr-1.5">2</span>Mandatory UPI Payment</p>
                            <span id="checkout-mode-label" class="text-[10px] text-emerald-400 font-semibold">Zero-Limit P2P Direct Transfer</span>
                        </div>
                        <span id="checkout-total-badge" class="text-2xl font-black text-emerald-400">₹0</span>
                    </div>

                    <div id="under-2000-qr-box" class="hidden bg-black/60 border border-white/10 rounded-xl p-3 flex items-center space-x-3">
                        <img id="dynamic-upi-qr" src="" alt="UPI QR" class="w-20 h-20 rounded-lg bg-white p-1 shrink-0">
                        <div class="text-[11px] text-slate-300 space-y-1.5">
                            <p class="font-bold text-white">Instant Scan or 1-Tap Pay (Orders ≤ ₹2,000):</p>
                            <a id="upi-deeplink-btn" href="#" onclick="markPaymentInitiated()" class="inline-block bg-emerald-500 hover:bg-emerald-400 text-black font-black px-3 py-1.5 rounded-lg text-[11px]">
                                <i class="fa-solid fa-bolt mr-1"></i>Open GPay / PhonePe / Paytm
                            </a>
                        </div>
                    </div>

                    <div class="space-y-1.5">
                        <p class="text-[11px] text-slate-300">Copy our verified UPI ID &amp; send <strong id="inline-pay-amount" class="text-white">₹0</strong> on any UPI app:</p>
                        <div class="flex items-center justify-between bg-black border border-white/20 rounded-xl px-3 py-2.5 text-xs">
                            <span class="text-emerald-400 font-mono font-bold truncate mr-2 text-sm" id="upi-id-display">premkumarmanthena289@oksbi</span>
                            <button type="button" id="copy-upi-btn" onclick="copyUpiIdAnim()" class="bg-brandPrimary hover:bg-pink-600 text-white font-black px-3 py-1.5 rounded-lg text-[11px] shrink-0 transition-all flex items-center">
                                <i class="fa-regular fa-copy mr-1"></i>Copy UPI ID
                            </button>
                        </div>
                    </div>

                    <div class="bg-black/70 p-3 rounded-xl border border-amber-500/30 space-y-2">
                        <label class="text-[11px] font-bold text-amber-300 block">
                            <i class="fa-solid fa-key mr-1"></i>Compulsory: Enter Last 4 Digits of UPI Ref / UTR No. *
                        </label>
                        <input type="text" id="cust-utr" placeholder="e.g. 4829 (Found in your GPay/PhonePe receipt) *" required pattern="[0-9A-Za-z]{4,12}" minlength="4" maxlength="12" class="w-full px-3 py-2 bg-darkSurface border border-darkBorder rounded-lg text-xs text-white font-mono uppercase outline-none focus:border-emerald-400">
                        <label class="flex items-center space-x-2 text-[11px] text-slate-300 cursor-pointer pt-1">
                            <input type="checkbox" id="cust-pay-confirm" required class="w-4 h-4 accent-emerald-500 cursor-pointer">
                            <span>I have paid the exact total to <strong class="text-white">premkumarmanthena289@oksbi</strong> *</span>
                        </label>
                    </div>
                </div>

                <button type="submit" id="whatsapp-checkout-btn" class="w-full bg-whatsapp text-black font-black py-3.5 rounded-xl btn-glow-whatsapp tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2 transition-all">
                    <i class="fa-brands fa-whatsapp text-lg"></i>
                    <span>Verify Payment &amp; Send Order to WhatsApp</span>
                </button>
            </form>
        </div>
    </div>

    <!-- INTERACTIVE ORDER TRACKING PORTAL -->
    <div id="track-modal" class="fixed inset-0 z-[80] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-md p-6 shadow-2xl relative border border-white/15 my-auto">
            <button onclick="closeTrackModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>

            <div class="flex items-center space-x-3 mb-4">
                <div class="w-11 h-11 bg-brandPrimary/15 rounded-xl flex items-center justify-center border border-brandPrimary/30">
                    <i class="fa-solid fa-truck-fast text-xl text-brandPrimary"></i>
                </div>
                <div>
                    <h3 class="text-xl font-black text-white">Live Order Tracker</h3>
                    <p class="text-xs text-slate-400">Real-time status &amp; WhatsApp dispatch desk</p>
                </div>
            </div>

            <div id="recent-orders-box" class="mb-4 hidden">
                <p class="text-[10px] font-bold uppercase text-slate-400 mb-1.5">Your Recent Orders on This Device:</p>
                <div id="recent-orders-list" class="flex flex-wrap gap-1.5"></div>
            </div>

            <form onsubmit="lookupOrderStatus(event)" class="flex space-x-2 mb-4">
                <input type="text" id="track-order-id" placeholder="Enter Order ID (e.g. ORD-482910)" required class="w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs font-mono text-white uppercase outline-none focus:border-brandPrimary">
                <button type="submit" class="bg-brandPrimary text-white font-bold px-4 py-2.5 rounded-xl text-xs shrink-0">Track</button>
            </form>

            <div id="track-result-card" class="hidden bg-darkSurface border border-white/10 rounded-xl p-4 space-y-4">
                <div class="flex justify-between items-start border-b border-white/10 pb-3">
                    <div>
                        <span id="trk-id" class="font-mono font-black text-sm text-brandPrimary"></span>
                        <p id="trk-date" class="text-[11px] text-slate-400"></p>
                    </div>
                    <span id="trk-badge" class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300"></span>
                </div>
                <div class="space-y-2.5 text-xs" id="trk-steps"></div>
                <div class="bg-black/50 p-3 rounded-lg border border-white/5 text-xs flex justify-between items-center">
                    <span class="text-slate-400">Estimated Delivery:</span>
                    <strong id="trk-est" class="text-emerald-400"></strong>
                </div>
                <button type="button" onclick="pingWhatsAppForTracking()" class="w-full bg-whatsapp text-black font-black py-3 rounded-xl text-xs flex items-center justify-center space-x-2">
                    <i class="fa-brands fa-whatsapp text-base"></i>
                    <span>Get Live Courier Link on WhatsApp</span>
                </button>
            </div>
        </div>
    </div>

    <!-- MERCHANT COMMAND CENTER MODAL (PIN: 9014) -->
    <div id="admin-modal" class="fixed inset-0 z-[90] bg-black/95 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-2xl p-6 shadow-2xl relative border border-white/15 my-auto max-h-[90vh] flex flex-col">
            <button onclick="closeAdminModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            <h3 class="text-xl font-black text-white mb-1"><i class="fa-solid fa-user-shield text-brandPrimary mr-2"></i>Prem's Merchant Command Center</h3>
            <p class="text-xs text-slate-400 mb-4">Verify UTR numbers, update tracking stages, or send 1-tap WhatsApp confirmations.</p>

            <div id="admin-pin-gate" class="flex space-x-2 mb-4">
                <input type="password" id="admin-pin-input" placeholder="Enter Merchant PIN (Default: 9014)" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary">
                <button onclick="unlockAdminPanel()" class="bg-brandPrimary text-white font-bold px-5 py-2.5 rounded-xl text-xs shrink-0">Unlock</button>
            </div>

            <div id="admin-content" class="hidden overflow-y-auto space-y-4 pr-1">
                <div class="bg-darkSurface p-4 rounded-xl border border-white/10 space-y-3">
                    <h4 class="text-xs font-bold uppercase text-brandPrimary">1-Tap Customer WhatsApp Notifier</h4>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input type="tel" id="adm-cust-phone" placeholder="Customer Phone (10 digits)" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white">
                        <input type="text" id="adm-order-id" placeholder="Order ID (e.g. ORD-123456)" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white uppercase">
                        <input type="text" id="adm-courier" placeholder="Courier / Tracking Link" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white">
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <button onclick="sendMerchantWhatsApp('APPROVED')" class="bg-emerald-500 hover:bg-emerald-600 text-black font-bold px-3 py-2 rounded-lg text-xs">✅ Send "Order Approved"</button>
                        <button onclick="sendMerchantWhatsApp('SHIPPED')" class="bg-blue-500 hover:bg-blue-600 text-white font-bold px-3 py-2 rounded-lg text-xs">🚚 Send "Order Shipped"</button>
                        <button onclick="sendMerchantWhatsApp('CANCELED')" class="bg-red-500 hover:bg-red-600 text-white font-bold px-3 py-2 rounded-lg text-xs">❌ Send "Payment Pending"</button>
                    </div>
                </div>

                <div>
                    <div class="flex justify-between items-center mb-2">
                        <h4 class="text-xs font-bold uppercase text-slate-400">Recent Verified Orders</h4>
                        <button onclick="loadAdminOrders()" class="text-xs text-brandPrimary hover:underline"><i class="fa-solid fa-rotate mr-1"></i>Refresh</button>
                    </div>
                    <div id="admin-orders-list" class="space-y-2.5 text-xs"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        var storeProducts = [
            {
                id: 48,
                title: "3D Microcurrent EMS Facial & Jawline Sculpting Wand",
                price: 1399,
                category: "Looks & Grooming",
                isWinner: true,
                bundleWith: 45,
                rating: 4.9,
                reviews: 842,
                stock: 3,
                description: "High-frequency sonic vibration + gentle EMS microcurrents contract jawline muscles, drain morning facial bloat, and sculpt a sharp contour in 5 minutes a day.",
                image: "https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "#1 Viral Winner"
            },
            {
                id: 51,
                title: "Laser-Guided Rechargeable Electric Fabric Scissors",
                price: 1299,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 52,
                rating: 4.9,
                reviews: 764,
                stock: 3,
                description: "Cuts through silk, denim, canvas, and georgette 4x faster with zero thumb cramps. Projects a precision red laser line so every blouse and suit cut is straight.",
                image: "https://images.unsplash.com/photo-1584992236310-6edddc08a3f5?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1584992236310-6edddc08a3f5?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1605289355680-75fb41239154?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "Tailor #1 Pick"
            },
            {
                id: 52,
                title: "Magnetic Cross-Line Laser Sewing Machine Alignment Guide",
                price: 899,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 53,
                rating: 4.9,
                reviews: 590,
                stock: 4,
                description: "Snaps magnetically onto industrial or home sewing machines (Jack, Juki, Usha, Singer). Projects a crisp red laser crosshair ahead of the needle for straight seams.",
                image: "https://images.unsplash.com/photo-1605289355680-75fb41239154?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1605289355680-75fb41239154?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1584992236310-6edddc08a3f5?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "Boutique Viral"
            },
            {
                id: 1,
                title: "Foldable Hot Air Clothes Drying Bag",
                price: 3339,
                category: "Home & Kitchen",
                isWinner: true,
                bundleWith: 6,
                rating: 4.9,
                reviews: 612,
                stock: 2,
                description: "Indoor laundry drying bag for apartments and travel. Attaches to a hair dryer or blower to dry damp garments in 15 minutes.",
                image: "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "High-Demand Winner"
            },
            {
                id: 53,
                title: "2-in-1 Automatic Needle Threader & LED Magnified Seam Ripper",
                price: 499,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 55,
                rating: 4.8,
                reviews: 1120,
                stock: 5,
                description: "Threads machine and hand needles quickly. Built-in LED light illuminates dark silk threads so you unpick stitches cleanly without tearing delicate fabric.",
                image: "https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?auto=format&fit=crop&w=600&q=80",
                badge: "Eye Saver Deal"
            },
            {
                id: 42,
                title: "7-Color LED Photon Therapy Glass-Skin Face Mask",
                price: 3499,
                category: "Looks & Grooming",
                isWinner: true,
                bundleWith: 46,
                rating: 5.0,
                reviews: 498,
                stock: 2,
                description: "Multi-wavelength LED facial mask. Red light supports collagen and smooth skin texture; blue light targets blemish-causing bacteria.",
                image: "https://images.unsplash.com/photo-1590159756185-9856cc43f173?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1590159756185-9856cc43f173?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1616683693504-3ea7e9ad6fec?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "Price Drop ₹1,500 Off"
            },
            {
                id: 31,
                title: "Smart Sensor Invisible Posture Corrector Brace",
                price: 1099,
                category: "Looks & Grooming",
                isWinner: true,
                bundleWith: 32,
                rating: 4.8,
                reviews: 740,
                stock: 4,
                description: "Lightweight posture trainer worn under shirts. Gently vibrates when slouching past 25 degrees to build upright desk habits.",
                image: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=600&q=80",
                badge: "Confidence Hack"
            },
            {
                id: 56,
                title: "Mini Ultrasonic Steam Collar, Cuff & Saree Pleat Press",
                price: 1149,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 54,
                rating: 4.9,
                reviews: 418,
                stock: 3,
                description: "Precision ceramic tip reaches tight blouse darts, shirt collars, cuffs, and pleats in 15 seconds for crisp boutique finishing.",
                image: "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80",
                badge: "Boutique Pro"
            },
            {
                id: 54,
                title: "Teflon Non-Stick Ironing Shoe Shield for Silk & Zari",
                price: 549,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 56,
                rating: 4.9,
                reviews: 530,
                stock: 5,
                description: "Spring-clip PTFE shoe shield fits dry or steam irons. Helps press delicate silk, zari embroidery, and trousers with less shine and scorch risk.",
                image: "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80",
                badge: "Zero Scorch"
            },
            {
                id: 55,
                title: "50-Pc Stainless Wonder Fabric Clips + Magnetic Wrist Pincushion",
                price: 649,
                category: "Tailoring & Boutique",
                bundleWith: 53,
                rating: 4.8,
                reviews: 740,
                stock: 4,
                description: "Holds thick hems and silk layers without pin holes. Includes 50 fabric clips and a magnetic wrist pincushion for quick pin pickup.",
                image: "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?auto=format&fit=crop&w=600&q=80",
                badge: "Pro Combo"
            },
            {
                id: 57,
                title: "45mm Titanium Rotary Fabric Cutter + A4 Self-Healing Mat",
                price: 799,
                category: "Tailoring & Boutique",
                isWinner: true,
                bundleWith: 51,
                rating: 4.9,
                reviews: 392,
                stock: 4,
                description: "Rotary circular blade cuts cleanly through multi-layer cotton and lining fabric on a gridded self-healing cutting mat.",
                image: "https://images.unsplash.com/photo-1584992236310-6edddc08a3f5?auto=format&fit=crop&w=600&q=80",
                badge: "New Arrival"
            },
            {
                id: 58,
                title: "5-in-1 Adjustable Sliding Sewing Gauge & Hemming Ruler Set",
                price: 449,
                category: "Tailoring & Boutique",
                bundleWith: 52,
                rating: 4.8,
                reviews: 615,
                stock: 7,
                description: "Sliding measuring gauge for marking consistent buttonholes, hems, pleats, and seam allowances on tailoring projects.",
                image: "https://images.unsplash.com/photo-1605289355680-75fb41239154?auto=format&fit=crop&w=600&q=80",
                badge: "Masterji Essential"
            },
            {
                id: 41,
                title: "Electric Makeup Brush Vortex Spinner Cleaner & Dryer",
                price: 1099,
                category: "Looks & Grooming",
                isWinner: true,
                bundleWith: 50,
                rating: 4.9,
                reviews: 1204,
                stock: 4,
                description: "Spins makeup brushes in soapy water and air-dries bristles quickly so your daily kit stays clean and hygienic.",
                image: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=600&q=80",
                badge: "Viral Winner"
            },
            {
                id: 43,
                title: "Rechargeable Thermal Silicone Heated Eyelash Curler",
                price: 749,
                category: "Looks & Grooming",
                isWinner: true,
                bundleWith: 47,
                rating: 4.8,
                reviews: 856,
                stock: 6,
                description: "Warm silicone eyelash curler designed to shape lashes smoothly without traditional metal clamp pinches.",
                image: "https://images.unsplash.com/photo-1629853907409-7756fdf1d269?auto=format&fit=crop&w=600&q=80",
                badge: "Price Drop"
            },
            // --- 10 UNDER-₹500 PRODUCTS FOR COLLEGE STUDENTS & BUSINESS OWNERS (#15-#24) ---
            {
                id: 65,
                title: "8-Pc Magnetic Cable & Desk Wire Organizer Clips",
                price: 249,
                category: "Under 500",
                isStudentBusiness: true,
                isWinner: true,
                bundleWith: 66,
                rating: 4.9,
                reviews: 940,
                stock: 8,
                description: "Keeps charging cables, laptop adapters, and desk wires neatly anchored on study desks, hostel tables, and business counters.",
                image: "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "Student & Desk <₹500"
            },
            {
                id: 66,
                title: "Foldable Ergonomic Laptop & Tablet Stand Riser",
                price: 449,
                category: "Under 500",
                isStudentBusiness: true,
                isWinner: true,
                bundleWith: 65,
                rating: 4.9,
                reviews: 1280,
                stock: 6,
                description: "Raises screen height to eye level to reduce neck and shoulder strain during college lectures, coding, billing, and remote work.",
                image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80",
                gallery: [
                    "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80",
                    "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80"
                ],
                badge: "Founder & Student Pick"
            },
            {
                id: 67,
                title: "Inkless Pocket Thermal Label & Mini Note Printer",
                price: 499,
                category: "Under 500",
                isStudentBusiness: true,
                isWinner: true,
                bundleWith: 68,
                rating: 4.8,
                reviews: 765,
                stock: 5,
                description: "Bluetooth thermal mini printer for shipping address tags, inventory labels, price stickers, and study flashcards—no ink required.",
                image: "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80",
                badge: "Business Utility <₹500"
            },
            {
                id: 68,
                title: "Slim Aluminum RFID Blocking Card & Cash Wallet",
                price: 349,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 67,
                rating: 4.8,
                reviews: 610,
                stock: 7,
                description: "Compact pocket wallet with pop-up card access and RFID shielding for ID cards, bank cards, and folded currency notes.",
                image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80",
                badge: "Smart Carry <₹500"
            },
            {
                id: 69,
                title: "Compact Dual-Port Fast Wall Charger Adapter",
                price: 479,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 65,
                rating: 4.7,
                reviews: 890,
                stock: 6,
                description: "Travel-friendly dual-device wall adapter with smart over-voltage protection for phones, power banks, and desk accessories.",
                image: "https://images.unsplash.com/photo-1585298723682-7115561c51b7?auto=format&fit=crop&w=600&q=80",
                badge: "Hostel & Travel <₹500"
            },
            {
                id: 70,
                title: "Clip-On Rechargeable Book & Study Reading Light",
                price: 299,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 66,
                rating: 4.9,
                reviews: 1105,
                stock: 8,
                description: "Flexible gooseneck reading lamp with warm and cool brightness modes for night studying, ledgers, and late-night work.",
                image: "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80",
                badge: "Exam Prep <₹500"
            },
            {
                id: 71,
                title: "Magnetic Dry-Erase Weekly Planner & Task Board",
                price: 399,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 74,
                rating: 4.8,
                reviews: 540,
                stock: 7,
                description: "Reusable wipe-clean planner board for daily business tasks, order checklists, assignment deadlines, and weekly goals.",
                image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80",
                badge: "Planner Pick <₹500"
            },
            {
                id: 72,
                title: "Heavy-Duty Retractable ID & Key Reel Holder (3-Pc)",
                price: 199,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 68,
                rating: 4.7,
                reviews: 730,
                stock: 10,
                description: "Steel-cord retractable badge and key reels that clip to belts or bags for quick campus gate, office, and shop door access.",
                image: "https://images.unsplash.com/photo-1508873696983-2df515122519?auto=format&fit=crop&w=600&q=80",
                badge: "Budget Value <₹500"
            },
            {
                id: 73,
                title: "Ergonomic Wrist Cushion & Smooth Desk Mouse Pad",
                price: 329,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 66,
                rating: 4.8,
                reviews: 675,
                stock: 7,
                description: "Soft memory-cushion wrist support paired with a smooth tracking surface for laptops, spreadsheets, and video editing.",
                image: "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80",
                badge: "Desk Comfort <₹500"
            },
            {
                id: 74,
                title: "Mini Pocket Stapler + 1,000 Staples Refill Pack",
                price: 229,
                category: "Under 500",
                isStudentBusiness: true,
                bundleWith: 71,
                rating: 4.8,
                reviews: 820,
                stock: 9,
                description: "Compact pocket stapler with 1,000 staples included for binding invoices, receipts, bills, and college project sheets.",
                image: "https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?auto=format&fit=crop&w=600&q=80",
                badge: "Office & Study <₹500"
            },
            { id: 59, title: "Ultrasonic Pore Vacuum & Blackhead Extractor Pro", price: 1149, category: "Looks & Grooming", isWinner: true, bundleWith: 45, rating: 4.8, reviews: 530, stock: 3, description: "Compact skincare vacuum tool with interchangeable tips for gentle nose and T-zone pore care.", image: "https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=600&q=80", badge: "Skin Care Pick" },
            { id: 60, title: "Zero-Gap Cordless Beard & Hair Outliner Trimmer", price: 899, category: "Looks & Grooming", isWinner: true, bundleWith: 48, rating: 4.9, reviews: 910, stock: 4, description: "Close-cutting grooming trimmer with rechargeable battery for clean beard edges, sideburns, and necklines.", image: "https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80", badge: "Grooming #1" },
            { id: 44, title: "Soft Silicone Scalp Massager & Hair Growth Brush", price: 349, category: "Looks & Grooming", rating: 4.9, reviews: 1840, stock: 9, description: "Flexible silicone bristles help massage the scalp during shampoo or oil routines without scratching.", image: "https://images.unsplash.com/photo-1616683693504-3ea7e9ad6fec?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 45, title: "Cryo Ice Roller & Rose Quartz Gua Sha Set", price: 949, category: "Looks & Grooming", rating: 4.8, reviews: 920, stock: 5, description: "Chilled facial roller and contoured Gua Sha tool for a refreshing morning skincare routine.", image: "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80", badge: "Morning Routine" },
            { id: 46, title: "Reusable Medical-Grade Silicone Eye Patches", price: 499, category: "Looks & Grooming", rating: 4.8, reviews: 630, stock: 6, description: "Washable silicone under-eye patches that sit snugly over eye serums and creams.", image: "https://images.unsplash.com/photo-1512496015851-a1c8f1066d5b?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 47, title: "Precision Eyebrow & Facial Hair Trimmer", price: 599, category: "Looks & Grooming", rating: 4.7, reviews: 1450, stock: 8, description: "Pen-style precision trimmer for neat eyebrow shaping and quick touch-ups on the go.", image: "https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 49, title: "Antibacterial Silicone Body Scrubber", price: 399, category: "Looks & Grooming", rating: 4.9, reviews: 2100, stock: 10, description: "Hygienic silicone bath brush with soft bristles that rinse clean and dry quickly between uses.", image: "https://images.unsplash.com/photo-1601055903647-8f1eaec797e8?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 50, title: "Tri-Tone Rechargeable LED Travel Vanity Mirror", price: 1199, category: "Looks & Grooming", rating: 4.8, reviews: 750, stock: 4, description: "Compact lighted vanity mirror with warm, neutral, and bright LED lighting modes for grooming.", image: "https://images.unsplash.com/photo-1616014493390-e5550a1122a7?auto=format&fit=crop&w=600&q=80", badge: "Must Have" },
            { id: 32, title: "Portable EMS Thermal Neck & Shoulder Massager", price: 1899, category: "Home & Kitchen", isWinner: true, rating: 4.9, reviews: 812, stock: 3, description: "Wearable neck massager with warm soothing heat and pulse modes after long desk or screen hours.", image: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 38, title: "12-in-1 Mandoline Vegetable Chopper Pro", price: 999, category: "Home & Kitchen", isWinner: true, rating: 4.8, reviews: 1432, stock: 2, description: "Multi-blade vegetable chopper and slicer with catch container for faster daily meal prep.", image: "https://images.unsplash.com/photo-1593504049359-74330189a345?auto=format&fit=crop&w=600&q=80", badge: "Kitchen #1" },
            { id: 33, title: "Mini 1080p Wide-Angle Car Dash Cam", price: 2199, category: "Car & Bike", isWinner: true, rating: 4.7, reviews: 320, stock: 5, description: "Compact windshield camera with wide-angle recording and loop storage for everyday driving.", image: "https://images.unsplash.com/photo-1511407409255-83e9b1399cc1?auto=format&fit=crop&w=600&q=80", badge: "Road Safety" },
            { id: 61, title: "High-Pressure Cordless Car & Bike Foam Washer Gun", price: 1999, category: "Car & Bike", isWinner: true, rating: 4.8, reviews: 410, stock: 3, description: "Portable cordless spray washer for quick car and two-wheeler cleaning with water bucket portability.", image: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80", badge: "New Viral" },
            { id: 62, title: "3-in-1 Magnetic Foldable Wireless Charging Station", price: 1599, category: "Smart Tech & Utility", isWinner: true, rating: 4.9, reviews: 380, stock: 4, description: "Foldable charging stand that powers compatible phones, earbuds, and smartwatches from one spot.", image: "https://images.unsplash.com/photo-1585298723682-7115561c51b7?auto=format&fit=crop&w=600&q=80", badge: "Desk Upgrade" },
            { id: 63, title: "Rechargeable Fabric Lint & Sweater Pill Shaver", price: 699, category: "Tailoring & Boutique", rating: 4.8, reviews: 690, stock: 5, description: "Fabric shaver that removes lint pills and fuzz from knitwear, upholstery, and garments.", image: "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?auto=format&fit=crop&w=600&q=80", badge: "Garment Care" },
            { id: 64, title: "Oil-Control Volcanic Stone Face Roller", price: 449, category: "Looks & Grooming", rating: 4.7, reviews: 890, stock: 6, description: "Reusable volcanic stone roller for quick T-zone oil blot touch-ups during busy days.", image: "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 2, title: "Inverted Reverse LED Umbrella", price: 1069, category: "Smart Tech & Utility", rating: 4.9, reviews: 142, stock: 5, description: "Reverse-folding umbrella that keeps wet outer fabric tucked inward when closing in tight spaces.", image: "https://images.unsplash.com/photo-1559827260-36fa90744fb5?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 3, title: "Portable Mini Dehumidifier", price: 1999, category: "Home & Kitchen", rating: 4.9, reviews: 84, stock: 2, description: "Compact moisture absorber for wardrobes, shoe cabinets, and humid storage spaces.", image: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 4, title: "Anti-Fog Helmet Visor Film", price: 539, category: "Car & Bike", rating: 4.9, reviews: 230, stock: 7, description: "Clear protective visor sheet designed to reduce interior misting during humid and rainy rides.", image: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 5, title: "Hydrophobic Side Mirror Film (2 Pc)", price: 339, category: "Car & Bike", rating: 4.6, reviews: 67, stock: 4, description: "Water-repellent mirror films that help clear rain beads from car side mirrors.", image: "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 6, title: "Electric Hot Air Clothes Hanger", price: 2539, category: "Home & Kitchen", rating: 4.9, reviews: 154, stock: 2, description: "Foldable travel hanger with warm airflow vents for lightweight shirts and travel laundry.", image: "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 7, title: "Waterproof Laptop Backpack Cover", price: 399, category: "Smart Tech & Utility", rating: 4.8, reviews: 175, stock: 6, description: "Elastic rain cover that slips over backpacks to shield laptops and notebooks from rain.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 8, title: "Full-Body Scooter Rain Poncho", price: 869, category: "Car & Bike", rating: 4.7, reviews: 110, stock: 4, description: "Full-coverage rain poncho with clear face visor for two-wheeler commutes in heavy rain.", image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 9, title: "Heavy-Duty Motorcycle Rain Cover", price: 669, category: "Car & Bike", rating: 4.7, reviews: 142, stock: 3, description: "Protective weather cover for parked motorcycles and scooters against rain, dust, and sun.", image: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 10, title: "Rapid-Absorb Microfiber Travel Towel", price: 599, category: "Smart Tech & Utility", rating: 4.7, reviews: 119, stock: 8, description: "Compact quick-dry microfiber towel for gym sessions, travel, and outdoor activities.", image: "https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 11, title: "Magic Microfiber Cleaning Towels (3 Pk)", price: 139, category: "Home & Kitchen", rating: 4.8, reviews: 512, stock: 5, description: "Lint-free microfiber cloths for wiping surfaces, glass, screens, and vehicle interiors.", image: "https://images.unsplash.com/photo-1628177142898-93e46e48c58a?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 12, title: "Reusable PVC Rain Shoe Covers", price: 189, category: "Footwear", rating: 4.6, reviews: 289, stock: 4, description: "Slip-on waterproof shoe covers with textured soles for muddy streets and puddles.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 13, title: "Anti-Mosquito Herbal Patches (72 Pc)", price: 139, category: "Smart Tech & Utility", rating: 4.9, reviews: 834, stock: 9, description: "Stick-on citronella patches for clothes and bags during outdoor evenings and travel.", image: "https://images.unsplash.com/photo-1577717903315-1691ae25ab3f?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 14, title: "Silicone Anti-Clog Drain Strainer", price: 95, category: "Home & Kitchen", rating: 4.7, reviews: 145, stock: 7, description: "Flexible silicone drain cover that catches hair and debris in sinks and showers.", image: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 15, title: "Universal Waterproof Phone Pouch", price: 269, category: "Smart Tech & Utility", rating: 4.7, reviews: 312, stock: 5, description: "Sealed touchscreen phone pouch for rain, pool, beach, and monsoon commutes.", image: "https://images.unsplash.com/photo-1588693821035-430b1ba8fc58?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 16, title: "Multi-Angle Aluminum Phone Stand", price: 119, category: "Smart Tech & Utility", rating: 4.8, reviews: 420, stock: 3, description: "Compact desk phone stand for video calls, study timers, and hands-free viewing.", image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 17, title: "Waterproof Travel Cable Organizer", price: 239, category: "Smart Tech & Utility", rating: 4.7, reviews: 198, stock: 4, description: "Zippered organizer pouch for cables, chargers, pendrives, and small tech accessories.", image: "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 18, title: "Pocket Raincoat Emergency Keyring Ball", price: 95, category: "Smart Tech & Utility", rating: 4.5, reviews: 620, stock: 8, description: "Compact keychain capsule holding a lightweight emergency poncho for sudden showers.", image: "https://images.unsplash.com/photo-1508873696983-2df515122519?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 19, title: "Silicone Door Bottom Seal Strip", price: 169, category: "Home & Kitchen", rating: 4.6, reviews: 180, stock: 6, description: "Under-door weather strip that helps block drafts, dust, insects, and doorway water seepage.", image: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 20, title: "Waterproof LED Runner Shoe Clip", price: 189, category: "Smart Tech & Utility", rating: 4.8, reviews: 115, stock: 4, description: "Clip-on LED heel light for extra visibility during early-morning or evening walks and runs.", image: "https://images.unsplash.com/photo-1511556532299-8f662fc26c06?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 21, title: "UV Thermal Shoe & Boot Dryer", price: 1339, category: "Footwear", rating: 5.0, reviews: 210, stock: 2, description: "Compact shoe dryer designed to warm and dry damp sneakers and work footwear overnight.", image: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 22, title: "Silicone Slip-On Shoe Protectors", price: 469, category: "Footwear", rating: 4.8, reviews: 98, stock: 5, description: "Stretchable silicone shoe covers to shield casual sneakers from mud and splashes.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 23, title: "Breathable Quick-Dry Aqua Shoes", price: 839, category: "Footwear", rating: 4.7, reviews: 142, stock: 3, description: "Lightweight slip-on water shoes with breathable mesh and drainage soles.", image: "https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 24, title: "Bamboo Charcoal Deodorizer Bags", price: 329, category: "Footwear", rating: 4.9, reviews: 310, stock: 6, description: "Activated bamboo charcoal pouches to refresh shoes, gym bags, and closets.", image: "https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?auto=format&fit=crop&w=600&q=80", badge: "Under ₹500" },
            { id: 25, title: "Men's Tactical Windbreaker Rain Jacket", price: 1779, category: "Apparel", rating: 4.9, reviews: 275, stock: 2, description: "Water-resistant hooded windbreaker jacket suited for windy commutes and light rain.", image: "https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 26, title: "Quick-Dry 4-Way Stretch Trousers", price: 1399, category: "Apparel", rating: 4.8, reviews: 190, stock: 4, description: "Flexible stretch commuter trousers made with lightweight quick-drying fabric.", image: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 27, title: "All-Weather Storm Hooded Parka", price: 2149, category: "Apparel", rating: 5.0, reviews: 88, stock: 1, description: "Longline hooded outerwear built for heavy weather and travel.", image: "https://images.unsplash.com/photo-1544441893-675973e31985?auto=format&fit=crop&w=600&q=80", badge: "Premium" },
            { id: 28, title: "Hydrophobic Stain-Proof Men's Polo", price: 749, category: "Apparel", rating: 4.7, reviews: 165, stock: 5, description: "Breathable polo shirt treated to help repel everyday liquid spills and splashes.", image: "https://images.unsplash.com/photo-1581655353564-df123a1eb820?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 29, title: "Lightweight Zip-On Rain Overpants", price: 939, category: "Apparel", rating: 4.6, reviews: 112, stock: 3, description: "Water-resistant outer pants designed to pull on quickly over everyday trousers.", image: "https://images.unsplash.com/photo-1552902865-b72c031ac5ea?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 30, title: "Orthopedic Arch Waterproof Sandals", price: 1119, category: "Footwear", rating: 4.8, reviews: 320, stock: 4, description: "Cushioned EVA slip-on sandals with contoured arch support and grip soles.", image: "https://images.unsplash.com/photo-1603808033192-082d6919d3e1?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 34, title: "Auto-Clamping Wireless Car Charger Mount", price: 1449, category: "Car & Bike", rating: 4.8, reviews: 450, stock: 4, description: "Dashboard/vent phone mount with motorized arms and wireless charging support.", image: "https://images.unsplash.com/photo-1585298723682-7115561c51b7?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 35, title: "6-Blade Portable USB Blender Bottle", price: 1199, category: "Home & Kitchen", rating: 4.6, reviews: 920, stock: 8, description: "Rechargeable portable blender cup for smoothies, shakes, and post-workout mixes.", image: "https://images.unsplash.com/photo-1595515286417-64b584d436a5?auto=format&fit=crop&w=600&q=80", badge: "Bestseller" },
            { id: 36, title: "Ergonomic Memory Foam Knee Pillow", price: 899, category: "Home & Kitchen", rating: 4.9, reviews: 1105, stock: 7, description: "Contoured leg cushion for side sleepers to support knee and hip alignment.", image: "https://images.unsplash.com/photo-1584282570763-71ab527f394f?auto=format&fit=crop&w=600&q=80", badge: "Evergreen" },
            { id: 37, title: "Self-Cleaning Pet Hair Lint Roller", price: 549, category: "Home & Kitchen", rating: 4.7, reviews: 670, stock: 9, description: "Reusable lint and pet-hair brush that collects fur into an easy-empty chamber.", image: "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 39, title: "Anti-Theft Crossbody Sling Tech Bag", price: 1249, category: "Smart Tech & Utility", rating: 4.8, reviews: 490, stock: 5, description: "Structured crossbody bag with concealed pockets and organized tech compartments.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 40, title: "Wireless Charging LED Minimalist Desk Lamp", price: 1699, category: "Home & Kitchen", rating: 4.7, reviews: 215, stock: 4, description: "Sleek study and desk lamp with adjustable brightness and wireless phone charging base.", image: "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80", badge: "Essential" }
        ];

        var customerReviews = [
            { id: 101, productId: 51, name: "Masterji Rajesh Sharma", city: "Hyderabad", rating: 5, date: "2 days ago", text: "At ₹1,299 this is a steal. Cut 14 silk blouse linings in 20 minutes! The red laser guide keeps my hand steady and thumb pain is gone." },
            { id: 102, productId: 52, name: "Farheen Boutique", city: "Surat", rating: 5, date: "Yesterday", text: "Ordered 3 Magnetic Laser Guides for our workshop Jack machines. Our karigars stitch straight piping without marking chalk lines now." },
            { id: 103, productId: 48, name: "Rohan Kapoor", city: "Delhi NCR", rating: 5, date: "1 day ago", text: "You can literally feel the EMS microcurrents contracting your jawline muscles. Morning facial bloat disappears in 5 minutes." },
            { id: 104, productId: 66, name: "Karthik Nair (B.Tech)", city: "Bengaluru", rating: 5, date: "2 days ago", text: "The ₹449 foldable laptop stand saved my posture during 6-hour coding and exam prep sessions in my hostel room." },
            { id: 105, productId: 67, name: "Harshvardhan Stores", city: "Pune", rating: 5, date: "3 days ago", text: "At ₹499, the pocket thermal printer prints quick parcel labels and shelf tags without buying expensive ink cartridges." },
            { id: 106, productId: 53, name: "Lakshmi Tailors", city: "Chennai", rating: 5, date: "5 days ago", text: "The LED light on the seam ripper is a lifesaver for night work on dark silk sarees. Needle threader works in 1 second." }
        ];

        var OWNER_WHATSAPP = "919014044915";
        var OWNER_UPI = "premkumarmanthena289@oksbi";
        var activeCategory = "All";
        var cart = [];
        var couponApplied = false;
        var orderBumpActive = true;
        var cartTimerInterval = null;
        var currentTrackedOrder = null;

        function safeGetLocal(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
        function safeSetLocal(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

        try {
            var savedCart = safeGetLocal('prem_cart_v6');
            if (savedCart) cart = JSON.parse(savedCart);
            var savedRevs = safeGetLocal('prem_reviews_v6');
            if (savedRevs) customerReviews = JSON.parse(savedRevs);
        } catch (e) {}

        function saveCart() { safeSetLocal('prem_cart_v6', JSON.stringify(cart)); }

        document.addEventListener('visibilitychange', function() {
            if (document.hidden && cart.length > 0) {
                document.title = "⚠️ Cart Reserved (10% OFF Active!)";
            } else {
                document.title = "Prem's Store | Viral Problem-Solvers, Tailoring Pro Tools & Under-₹500 Essentials India";
            }
        });

        function showToast(msg) {
            var box = document.getElementById('toast-box');
            document.getElementById('toast-text').innerText = msg;
            box.classList.remove('hidden');
            box.classList.add('flex');
            setTimeout(function() {
                box.classList.add('hidden');
                box.classList.remove('flex');
            }, 3400);
        }

        function getDeliveryWindowString() {
            var today = new Date();
            var minDate = new Date(today);
            minDate.setDate(today.getDate() + 4);
            var maxDate = new Date(today);
            maxDate.setDate(today.getDate() + 6);
            var opts = { month: 'short', day: 'numeric' };
            return minDate.toLocaleDateString('en-IN', opts) + ' - ' + maxDate.toLocaleDateString('en-IN', opts);
        }

        function calculateDeliveryDate() {
            var winStr = getDeliveryWindowString();
            document.getElementById('auto-delivery-date').innerText = winStr;
            document.getElementById('hero-delivery-date').innerText = winStr;
        }

        function openSpinModal() {
            var modal = document.getElementById('spin-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }
        function closeSpinModal() {
            var modal = document.getElementById('spin-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        function executeVipSpin() {
            var btn = document.getElementById('spin-action-btn');
            var icon = document.getElementById('spin-wheel-icon');
            btn.disabled = true;
            btn.innerText = "Spinning VIP Wheel...";
            icon.classList.add('animate-spin');
            setTimeout(function() {
                icon.classList.remove('animate-spin');
                couponApplied = true;
                document.getElementById('coupon-input').value = 'PREM10';
                updateCartUI();
                document.getElementById('spin-result-box').classList.remove('hidden');
                btn.innerText = "✅ 10% OFF Unlocked — Continue Shopping";
                btn.onclick = closeSpinModal;
                btn.disabled = false;
                document.getElementById('mystery-vault-btn').innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i><span>10% Active</span>';
                showToast('🎰 Jackpot! 10% OFF Code PREM10 Auto-Applied!');
            }, 1200);
        }

        function getProductGallery(prod) {
            if (prod.gallery && prod.gallery.length >= 2) return prod.gallery;
            return [prod.image];
        }

        function setCategoryFilter(category) {
            activeCategory = category;
            var buttons = document.querySelectorAll('.cat-btn');
            for (var i = 0; i < buttons.length; i++) {
                var btn = buttons[i];
                if (btn.getAttribute('data-cat') === category) {
                    btn.className = "cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold shadow-glow transition-all whitespace-nowrap";
                } else {
                    btn.className = "cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap";
                }
            }
            filterAndRenderCatalog();
        }

        function clearSearch() {
            document.getElementById('search-input').value = '';
            filterAndRenderCatalog();
        }

        function filterAndRenderCatalog() {
            var grid = document.getElementById('product-grid');
            var searchVal = (document.getElementById('search-input').value || '').trim().toLowerCase();
            var sortVal = document.getElementById('sort-select').value;
            var clearBtn = document.getElementById('clear-search-btn');

            if (searchVal.length > 0) clearBtn.classList.remove('hidden');
            else clearBtn.classList.add('hidden');

            var filtered = storeProducts.filter(function(item) {
                var matchesCat = false;
                if (activeCategory === "All") matchesCat = true;
                else if (activeCategory === "Top Winners") matchesCat = !!item.isWinner;
                else if (activeCategory === "Under 500") matchesCat = (item.price <= 500 || !!item.isStudentBusiness);
                else matchesCat = (item.category === activeCategory);

                var matchesSearch = !searchVal || item.title.toLowerCase().indexOf(searchVal) !== -1 || item.description.toLowerCase().indexOf(searchVal) !== -1 || item.category.toLowerCase().indexOf(searchVal) !== -1;
                return matchesCat && matchesSearch;
            });

            if (sortVal === 'price-asc') filtered.sort(function(a, b) { return a.price - b.price; });
            else if (sortVal === 'price-desc') filtered.sort(function(a, b) { return b.price - a.price; });
            else if (sortVal === 'rating') filtered.sort(function(a, b) { return b.rating - a.rating; });

            document.getElementById('results-counter').innerText = 'Showing ' + filtered.length + ' product' + (filtered.length === 1 ? '' : 's');

            if (filtered.length === 0) {
                grid.innerHTML = '<div class="col-span-full text-center py-16 glass rounded-2xl"><i class="fa-solid fa-box-open text-3xl text-slate-500 mb-3"></i><p class="text-sm text-slate-300 font-bold">No matching products found.</p><button onclick="clearSearch(); setCategoryFilter(\'All\')" class="mt-3 bg-brandPrimary text-white text-xs font-bold px-4 py-2 rounded-full">Reset Filters</button></div>';
                return;
            }

            var fallbackURL = "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80";
            var html = '';
            for (var i = 0; i < filtered.length; i++) {
                var prod = filtered[i];
                var mrp = Math.round(prod.price * 1.40);
                var saveAmt = mrp - prod.price;
                var galleryArr = getProductGallery(prod);
                var claimedPct = Math.min(94, Math.max(72, 95 - (prod.stock * 3)));
                var under500Tag = (prod.price <= 500) ? '<span class="text-[9px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 rounded font-bold ml-1.5">&le;&#8377;500</span>' : '';

                html += '<div class="bg-darkSurface rounded-2xl border border-darkBorder flex flex-col group relative overflow-hidden hover:border-brandPrimary/50 transition-all duration-300 shadow-lg">' +
                    '<span class="absolute top-3 left-3 bg-brandPrimary text-white text-[9px] font-black px-2.5 py-1 rounded-full uppercase z-10 tracking-wider shadow-lg">' + prod.badge + '</span>' +
                    '<span class="absolute top-3 right-3 bg-black/75 text-white text-[10px] font-bold px-2 py-0.5 rounded-full z-10 border border-white/10"><i class="fa-regular fa-images mr-1 text-brandPrimary"></i>' + galleryArr.length + '</span>' +
                    '<div onclick="openQuickView(' + prod.id + ')" class="relative bg-black overflow-hidden aspect-[4/3] cursor-pointer">' +
                        '<img src="' + prod.image + '" onerror="this.onerror=null; this.src=\'' + fallbackURL + '\';" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90 group-hover:opacity-100">' +
                        '<div class="absolute inset-0 bg-gradient-to-t from-darkSurface via-transparent to-transparent"></div>' +
                    '</div>' +
                    '<div class="p-4 flex flex-col flex-grow relative -mt-3 z-20">' +
                        '<div class="flex items-center justify-between text-[10px] mb-1">' +
                            '<span class="text-slate-400 font-semibold uppercase tracking-wider truncate mr-2">' + prod.category + under500Tag + '</span>' +
                            '<div class="flex items-center space-x-1 text-amber-400 shrink-0">' +
                                '<i class="fa-solid fa-star"></i><span class="font-bold text-white">' + prod.rating + '</span><span class="text-slate-500">(' + prod.reviews + ')</span>' +
                            '</div>' +
                        '</div>' +
                        '<h3 onclick="openQuickView(' + prod.id + ')" class="font-extrabold text-white text-sm sm:text-base leading-snug mb-1 cursor-pointer group-hover:text-brandPrimary transition-colors line-clamp-1">' + prod.title + '</h3>' +
                        '<p class="text-xs text-slate-400 line-clamp-2 mb-2.5 leading-relaxed">' + prod.description + '</p>' +
                        '<div class="mt-auto">' +
                            '<div class="w-full bg-black rounded-full h-1 mb-1.5 overflow-hidden"><div class="bg-gradient-to-r from-brandPrimary to-amber-400 h-1 rounded-full" style="width:' + claimedPct + '%"></div></div>' +
                            '<div class="flex justify-between items-center text-[10px] mb-2">' +
                                '<span class="text-red-400 font-bold uppercase"><i class="fa-solid fa-fire mr-1"></i>Only ' + prod.stock + ' left (' + claimedPct + '% claimed)</span>' +
                                '<span class="text-emerald-400 font-bold">Save &#8377;' + saveAmt.toLocaleString('en-IN') + '</span>' +
                            '</div>' +
                            '<div class="flex justify-between items-center pt-2.5 border-t border-darkBorder gap-2">' +
                                '<div>' +
                                    '<span class="text-[11px] text-slate-500 line-through block -mb-1 font-mono">&#8377;' + mrp.toLocaleString('en-IN') + '</span>' +
                                    '<span class="text-lg font-black text-white">&#8377;' + prod.price.toLocaleString('en-IN') + '</span>' +
                                '</div>' +
                                '<div class="flex items-center space-x-1.5">' +
                                    '<button onclick="addToCart(' + prod.id + ', false)" title="Add to Cart" class="bg-white/5 hover:bg-white/15 text-white w-9 h-9 rounded-xl transition-all font-bold border border-white/10 flex items-center justify-center"><i class="fa-solid fa-cart-plus text-xs"></i></button>' +
                                    '<button onclick="buyNowDirect(' + prod.id + ')" class="bg-brandPrimary hover:bg-pink-600 text-white text-xs font-extrabold px-3.5 py-2 rounded-xl transition-all shadow">Buy Now</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }
            grid.innerHTML = html;
        }

        function changeQuickViewImage(url, thumbEl) {
            document.getElementById('qv-img').src = url;
            var allThumbs = document.querySelectorAll('.qv-thumb-item');
            for (var i = 0; i < allThumbs.length; i++) {
                allThumbs[i].classList.remove('border-brandPrimary');
                allThumbs[i].classList.add('border-transparent');
            }
            if (thumbEl) {
                thumbEl.classList.remove('border-transparent');
                thumbEl.classList.add('border-brandPrimary');
            }
        }

        function addBundlePair(id1, id2) {
            addToCart(id1, false);
            addToCart(id2, true);
            closeQuickView();
            showToast('🔥 Combo Added! Extra 5% Multi-Item Bundle Discount Unlocked!');
        }

        function openQuickView(id) {
            var prod = storeProducts.find(function(p) { return p.id === id; });
            if (!prod) return;
            document.getElementById('qv-img').src = prod.image;
            document.getElementById('qv-badge').innerText = prod.badge;
            document.getElementById('qv-rating').innerText = prod.rating + ' (' + prod.reviews + ' Verified Buyers)';
            document.getElementById('qv-title').innerText = prod.title;
            document.getElementById('qv-price').innerText = '₹' + prod.price.toLocaleString('en-IN');
            document.getElementById('qv-mrp').innerText = '₹' + Math.round(prod.price * 1.40).toLocaleString('en-IN');
            document.getElementById('qv-desc').innerText = prod.description;
            document.getElementById('qv-pin-result').classList.add('hidden');
            document.getElementById('qv-live-viewers').innerHTML = '<i class="fa-regular fa-eye mr-1"></i>' + (Math.floor(Math.random() * 19) + 11) + ' people viewing right now';

            var allImgs = getProductGallery(prod);
            var thumbsHtml = '';
            for (var i = 0; i < allImgs.length; i++) {
                var activeBorder = (i === 0) ? 'border-brandPrimary' : 'border-transparent';
                thumbsHtml += '<img src="' + allImgs[i] + '" onclick="changeQuickViewImage(\'' + allImgs[i] + '\', this)" class="qv-thumb-item w-14 h-14 rounded-xl border-2 ' + activeBorder + ' hover:border-brandPrimary cursor-pointer object-cover bg-black shrink-0 transition-all">';
            }
            document.getElementById('qv-thumbnails').innerHTML = thumbsHtml;

            var partnerId = prod.bundleWith || 65;
            var partner = storeProducts.find(function(p) { return p.id === partnerId; }) || storeProducts[14];
            var comboPrice = Math.round((prod.price + partner.price) * 0.95);
            var bundleBox = document.getElementById('qv-bundle-box');
            bundleBox.innerHTML = '<div class="flex items-center justify-between text-[10px] font-black uppercase text-amber-300 mb-1.5">' +
                '<span><i class="fa-solid fa-bolt mr-1"></i>Frequently Bought Together (Save 5%)</span>' +
                '<span>Combo: ₹' + comboPrice.toLocaleString('en-IN') + '</span></div>' +
                '<div class="flex items-center justify-between gap-2">' +
                    '<div class="flex items-center space-x-2 overflow-hidden">' +
                        '<img src="' + partner.image + '" class="w-10 h-10 rounded-lg object-cover shrink-0 border border-white/10">' +
                        '<div class="overflow-hidden"><p class="text-xs font-bold text-white truncate">+ ' + partner.title + '</p><p class="text-[10px] text-slate-400">₹' + partner.price.toLocaleString('en-IN') + '</p></div>' +
                    '</div>' +
                    '<button type="button" onclick="addBundlePair(' + prod.id + ',' + partner.id + ')" class="bg-amber-400 hover:bg-amber-300 text-black font-black text-[10px] px-3 py-2 rounded-lg shrink-0 uppercase">Add Both</button>' +
                '</div>';

            var prodRevs = customerReviews.filter(function(r) { return r.productId === prod.id; });
            if (prodRevs.length === 0) prodRevs = customerReviews.slice(0, 2);
            var revHtml = '';
            for (var j = 0; j < prodRevs.length; j++) {
                var rv = prodRevs[j];
                revHtml += '<div class="bg-black/60 p-2.5 rounded-lg border border-white/5 text-[11px]">' +
                    '<div class="flex justify-between items-center mb-0.5"><strong class="text-white">' + rv.name + ' <span class="text-emerald-400 text-[10px]">✔ Verified</span></strong><span class="text-amber-400">★★★★★</span></div>' +
                    '<p class="text-slate-300">' + rv.text + '</p></div>';
            }
            document.getElementById('qv-reviews-list').innerHTML = revHtml;

            document.getElementById('qv-add-btn').onclick = function() {
                closeQuickView();
                addToCart(prod.id, true);
            };
            document.getElementById('qv-buy-btn').onclick = function() {
                closeQuickView();
                buyNowDirect(prod.id);
            };

            var modal = document.getElementById('quickview-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeQuickView() {
            var modal = document.getElementById('quickview-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function checkPincode() {
            var pin = (document.getElementById('qv-pincode').value || '').trim();
            var res = document.getElementById('qv-pin-result');
            if (/^[1-9][0-9]{5}$/.test(pin)) {
                res.innerText = '✅ Express Priority Delivery available to Pincode ' + pin + ' (' + getDeliveryWindowString() + ')';
                res.className = 'text-[11px] text-emerald-400 font-semibold mt-1.5 block';
            } else {
                res.innerText = '⚠️ Please enter a valid 6-digit Indian Pincode.';
                res.className = 'text-[11px] text-amber-400 font-semibold mt-1.5 block';
            }
        }

        function renderReviewsWall() {
            var wall = document.getElementById('reviews-wall-grid');
            var select = document.getElementById('rev-product');
            if (select && select.options.length === 0) {
                var optHtml = '';
                for (var k = 0; k < storeProducts.length; k++) {
                    optHtml += '<option value="' + storeProducts[k].id + '">' + storeProducts[k].title + '</option>';
                }
                select.innerHTML = optHtml;
            }

            var html = '';
            var displayList = customerReviews.slice(0, 6);
            for (var i = 0; i < displayList.length; i++) {
                var r = displayList[i];
                var prod = storeProducts.find(function(p) { return p.id === r.productId; }) || storeProducts[0];
                html += '<div class="bg-darkSurface border border-darkBorder rounded-2xl p-5 flex flex-col justify-between shadow-lg">' +
                    '<div>' +
                        '<div class="flex justify-between items-start mb-3">' +
                            '<div>' +
                                '<h4 class="font-bold text-white text-sm flex items-center">' + r.name + ' <span class="ml-2 text-[10px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full font-bold">Verified UPI Buyer</span></h4>' +
                                '<p class="text-[11px] text-slate-400">' + r.city + ' • ' + r.date + '</p>' +
                            '</div>' +
                            '<div class="text-amber-400 text-xs">★★★★★</div>' +
                        '</div>' +
                        '<p class="text-xs text-slate-300 leading-relaxed mb-4">"' + r.text + '"</p>' +
                    '</div>' +
                    '<div onclick="openQuickView(' + prod.id + ')" class="flex items-center space-x-2.5 pt-3 border-t border-white/5 cursor-pointer group">' +
                        '<img src="' + prod.image + '" class="w-9 h-9 rounded-lg object-cover">' +
                        '<span class="text-[11px] font-bold text-slate-400 group-hover:text-brandPrimary transition-colors truncate">' + prod.title + ' (₹' + prod.price + ')</span>' +
                    '</div>' +
                '</div>';
            }
            wall.innerHTML = html;
        }

        function toggleReviewForm() {
            document.getElementById('add-review-box').classList.toggle('hidden');
        }

        async function submitCustomerReview(event) {
            event.preventDefault();
            var newRev = {
                id: Date.now(),
                productId: Number(document.getElementById('rev-product').value) || 51,
                name: document.getElementById('rev-name').value.trim(),
                city: document.getElementById('rev-city').value.trim(),
                rating: 5,
                date: 'Just now',
                text: document.getElementById('rev-text').value.trim()
            };
            customerReviews.unshift(newRev);
            safeSetLocal('prem_reviews_v6', JSON.stringify(customerReviews.slice(0, 25)));
            renderReviewsWall();
            document.getElementById('add-review-box').classList.add('hidden');
            document.getElementById('rev-name').value = '';
            document.getElementById('rev-city').value = '';
            document.getElementById('rev-text').value = '';
            showToast('Thank you! Your verified review is now live.');
            try {
                await fetch('/api/reviews', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newRev)
                });
            } catch (e) {}
        }

        function toggleCart() {
            document.getElementById('cart-sidebar').classList.toggle('translate-x-full');
        }

        function applyQuickCoupon(code) {
            couponApplied = true;
            document.getElementById('coupon-input').value = code;
            updateCartUI();
            showToast('Coupon ' + code + ' applied! 10% OFF unlocked.');
        }

        function applyCouponInput() {
            var val = (document.getElementById('coupon-input').value || '').trim().toUpperCase();
            if (val === 'PREM10' || val === 'VIP10' || val === 'TAILOR10') {
                couponApplied = true;
                updateCartUI();
                showToast('10% Discount Code Applied!');
            } else {
                showToast('Invalid code. Try PREM10 for 10% off!');
            }
        }

        function addToCart(id, openDrawer) {
            var product = storeProducts.find(function(p) { return p.id === id; });
            var item = cart.find(function(i) { return i.id === id; });
            if (item && item.qty >= product.stock) {
                showToast('Maximum available stock (' + product.stock + ') reached.');
                return;
            }
            if (item) {
                item.qty += 1;
            } else {
                cart.push({ id: product.id, title: product.title, price: product.price, image: product.image, stock: product.stock, qty: 1 });
                if (cart.length === 1) startCartTimer();
            }
            saveCart();
            updateCartUI();
            showToast('Added "' + product.title + '" to cart');
            if (openDrawer !== false && document.getElementById('cart-sidebar').classList.contains('translate-x-full')) {
                toggleCart();
            }
        }

        function buyNowDirect(id) {
            var item = cart.find(function(i) { return i.id === id; });
            if (!item) {
                var product = storeProducts.find(function(p) { return p.id === id; });
                cart.push({ id: product.id, title: product.title, price: product.price, image: product.image, stock: product.stock, qty: 1 });
                saveCart();
                updateCartUI();
            }
            openShippingModal();
        }

        function modifyQty(id, step) {
            var index = cart.findIndex(function(i) { return i.id === id; });
            if (index > -1) {
                if (step > 0 && cart[index].qty >= cart[index].stock) {
                    showToast('Only ' + cart[index].stock + ' units available in stock.');
                    return;
                }
                cart[index].qty += step;
                if (cart[index].qty <= 0) cart.splice(index, 1);
            }
            saveCart();
            updateCartUI();
        }

        function getCartFinancials() {
            var totalQty = cart.reduce(function(sum, item) { return sum + item.qty; }, 0);
            var subtotal = cart.reduce(function(sum, item) { return sum + (item.price * item.qty); }, 0);
            if (subtotal >= 1699) couponApplied = true;

            var bundleRate = totalQty >= 3 ? 0.10 : (totalQty === 2 ? 0.05 : 0);
            var bundleDiscount = Math.round(subtotal * bundleRate);

            var discount = couponApplied ? Math.round((subtotal - bundleDiscount) * 0.10) : 0;
            orderBumpActive = document.getElementById('order-bump').checked;
            var bumpCost = (cart.length > 0 && orderBumpActive) ? 99 : 0;
            var freeGiftUnlocked = (subtotal >= 2499);
            var finalTotal = Math.max(0, subtotal - bundleDiscount - discount + bumpCost);
            return { totalQty: totalQty, subtotal: subtotal, bundleDiscount: bundleDiscount, discount: discount, bumpCost: bumpCost, freeGiftUnlocked: freeGiftUnlocked, finalTotal: finalTotal };
        }

        function updateCartUI() {
            var fin = getCartFinancials();
            document.getElementById('cart-count').innerText = fin.totalQty;
            document.getElementById('cart-subtotal').innerText = '₹' + fin.subtotal.toLocaleString('en-IN');
            document.getElementById('cart-total').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');

            var bRow = document.getElementById('bundle-discount-row');
            if (fin.bundleDiscount > 0) {
                bRow.classList.remove('hidden');
                document.getElementById('cart-bundle-discount').innerText = '-₹' + fin.bundleDiscount.toLocaleString('en-IN');
            } else {
                bRow.classList.add('hidden');
            }

            var discRow = document.getElementById('discount-row');
            if (fin.discount > 0) {
                discRow.classList.remove('hidden');
                document.getElementById('cart-discount').innerText = '-₹' + fin.discount.toLocaleString('en-IN');
            } else {
                discRow.classList.add('hidden');
            }

            var giftRow = document.getElementById('free-gift-row');
            if (fin.freeGiftUnlocked) giftRow.classList.remove('hidden');
            else giftRow.classList.add('hidden');

            var prog = document.getElementById('shipping-progress');
            var shipTxt = document.getElementById('shipping-text');
            var pct = Math.min(100, Math.round((fin.subtotal / 2499) * 100));
            prog.style.width = pct + '%';

            if (fin.subtotal >= 2499) {
                prog.className = 'bg-emerald-500 h-2 rounded-full transition-all';
                shipTxt.innerHTML = '<span class="text-emerald-400">🎉 ALL 3 VIP REWARDS UNLOCKED (Free Ship + 10% Off + Free ₹399 Gift)!</span>';
            } else if (fin.subtotal >= 1699) {
                prog.className = 'bg-amber-400 h-2 rounded-full transition-all';
                shipTxt.innerHTML = '<span class="text-amber-300">⚡ Free Ship + 10% Off Active! Add ₹' + (2499 - fin.subtotal).toLocaleString('en-IN') + ' for a Free ₹399 Gift!</span>';
            } else if (fin.subtotal >= 899) {
                prog.className = 'bg-brandPrimary h-2 rounded-full transition-all';
                shipTxt.innerHTML = '<span class="text-emerald-400">✔ Free VIP Shipping Unlocked! Add ₹' + (1699 - fin.subtotal).toLocaleString('en-IN') + ' for 10% Rebate!</span>';
            } else {
                prog.className = 'bg-brandPrimary h-2 rounded-full transition-all';
                shipTxt.innerHTML = 'Add ₹' + (899 - fin.subtotal).toLocaleString('en-IN') + ' more for FREE VIP Express Shipping';
            }

            var container = document.getElementById('cart-items');
            if (cart.length === 0) {
                container.innerHTML = '<div class="text-center text-slate-500 py-10 text-xs"><i class="fa-solid fa-cart-arrow-down text-2xl mb-2 block"></i>Your cart is currently empty.</div>' +
                    '<div class="bg-darkSurface border border-cyan-500/25 rounded-xl p-3 space-y-2">' +
                        '<p class="text-[10px] font-black uppercase text-cyan-300"><i class="fa-solid fa-graduation-cap mr-1"></i>Quick Under-&#8377;500 Student &amp; Business Picks:</p>' +
                        '<div class="flex items-center justify-between text-xs bg-black/50 p-2 rounded-lg"><span class="truncate mr-2">Foldable Laptop Riser (&#8377;449)</span><button onclick="addToCart(66, false)" class="bg-brandPrimary text-white font-bold px-2.5 py-1 rounded text-[10px] shrink-0">+ Add</button></div>' +
                        '<div class="flex items-center justify-between text-xs bg-black/50 p-2 rounded-lg"><span class="truncate mr-2">Magnetic Cable Clips 8-Pc (&#8377;249)</span><button onclick="addToCart(65, false)" class="bg-brandPrimary text-white font-bold px-2.5 py-1 rounded text-[10px] shrink-0">+ Add</button></div>' +
                    '</div>';
                return;
            }

            var html = '';
            for (var i = 0; i < cart.length; i++) {
                var item = cart[i];
                html += '<div class="flex items-center space-x-3 bg-darkSurface p-2.5 rounded-xl border border-darkBorder">' +
                    '<img src="' + item.image + '" class="w-14 h-14 object-cover rounded-lg shrink-0">' +
                    '<div class="flex-grow overflow-hidden">' +
                        '<h4 class="font-bold text-xs text-white truncate">' + item.title + '</h4>' +
                        '<p class="text-brandPrimary text-sm font-black mt-0.5">&#8377;' + (item.price * item.qty).toLocaleString('en-IN') + '</p>' +
                    '</div>' +
                    '<div class="flex items-center bg-black rounded-lg border border-white/10">' +
                        '<button onclick="modifyQty(' + item.id + ', -1)" class="w-7 h-7 text-slate-400 hover:text-white text-xs">-</button>' +
                        '<span class="text-xs font-bold text-white px-2">' + item.qty + '</span>' +
                        '<button onclick="modifyQty(' + item.id + ', 1)" class="w-7 h-7 text-slate-400 hover:text-white text-xs">+</button>' +
                    '</div>' +
                '</div>';
            }

            if (fin.subtotal > 0 && fin.subtotal < 2499) {
                html += '<div class="bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-2.5 flex items-center justify-between gap-2">' +
                    '<div class="text-[11px]"><span class="font-bold text-cyan-300 block">&#128161; Smart &lt;&#8377;500 Booster</span><span class="text-slate-300">Add 8-Pc Cable Clips (&#8377;249)</span></div>' +
                    '<button type="button" onclick="addToCart(65, false)" class="bg-cyan-400 text-black font-black text-[10px] px-2.5 py-1.5 rounded-lg shrink-0">+ &#8377;249</button>' +
                '</div>';
            }

            container.innerHTML = html;
        }

        function startCartTimer() {
            clearInterval(cartTimerInterval);
            var time = 600;
            var display = document.getElementById('cart-timer');
            cartTimerInterval = setInterval(function() {
                var minutes = Math.floor(time / 60);
                var seconds = time % 60;
                seconds = seconds < 10 ? '0' + seconds : seconds;
                display.innerText = minutes + ':' + seconds;
                if (--time < 0) time = 600;
            }, 1000);
        }

        function openShippingModal() {
            if (cart.length === 0) {
                showToast('Add at least 1 product to checkout.');
                return;
            }
            if (!document.getElementById('cart-sidebar').classList.contains('translate-x-full')) {
                toggleCart();
            }
            var fin = getCartFinancials();
            var totalStr = '₹' + fin.finalTotal.toLocaleString('en-IN');
            document.getElementById('checkout-total-badge').innerText = totalStr;
            document.getElementById('inline-pay-amount').innerText = totalStr;

            var qrBox = document.getElementById('under-2000-qr-box');
            var modeLabel = document.getElementById('checkout-mode-label');
            if (fin.finalTotal <= 2000) {
                var upiUri = "upi://pay?pa=" + OWNER_UPI + "&pn=Prems%20Store&am=" + fin.finalTotal + "&cu=INR";
                document.getElementById('upi-deeplink-btn').href = upiUri;
                document.getElementById('dynamic-upi-qr').src = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(upiUri);
                qrBox.classList.remove('hidden');
                modeLabel.innerText = "Instant Scan / 1-Tap Pay Active (Order ≤ ₹2,000)";
            } else {
                qrBox.classList.add('hidden');
                modeLabel.innerText = "High-Value Zero-Limit P2P Transfer Mode (> ₹2,000)";
            }

            var modal = document.getElementById('shipping-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeShippingModal() {
            var modal = document.getElementById('shipping-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function markPaymentInitiated() {
            showToast('Complete payment in your UPI app, then enter the last 4 digits of your UPI Ref/UTR below!');
        }

        function copyUpiIdAnim() {
            var btn = document.getElementById('copy-upi-btn');
            if (navigator.clipboard) {
                navigator.clipboard.writeText(OWNER_UPI);
            }
            var origHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>Copied! Now Pay in App';
            btn.className = 'bg-emerald-500 text-black font-black px-3 py-1.5 rounded-lg text-[11px] shrink-0 transition-all flex items-center';
            showToast('UPI ID Copied! Send exact amount & enter last 4 UTR digits.');
            setTimeout(function() {
                btn.innerHTML = origHTML;
                btn.className = 'bg-brandPrimary hover:bg-pink-600 text-white font-black px-3 py-1.5 rounded-lg text-[11px] shrink-0 transition-all flex items-center';
            }, 3500);
        }

        async function submitOrderAndRedirectToWhatsApp(event) {
            event.preventDefault();

            var cName = document.getElementById('cust-name').value.trim();
            var cPhone = document.getElementById('cust-phone').value.trim();
            var cCity = document.getElementById('cust-city').value.trim();
            var cPin = document.getElementById('cust-pincode').value.trim();
            var cAddr = document.getElementById('cust-address').value.trim();
            var cUtr = document.getElementById('cust-utr').value.trim().toUpperCase();
            var cConfirm = document.getElementById('cust-pay-confirm').checked;

            if (!/^[0-9]{10}$/.test(cPhone)) {
                showToast('⚠️ Please enter a valid 10-digit WhatsApp mobile number.');
                return;
            }
            if (!/^[1-9][0-9]{5}$/.test(cPin)) {
                showToast('⚠️ Please enter a valid 6-digit Indian Pincode.');
                return;
            }
            if (cUtr.length < 4 || !cConfirm) {
                showToast('⚠️ Compulsory: Complete UPI payment and enter the last 4 digits of your UTR/Ref ID.');
                return;
            }

            var btn = document.getElementById('whatsapp-checkout-btn');
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Locking Order &amp; Verifying UTR...</span>';
            btn.disabled = true;

            var fin = getCartFinancials();
            var orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
            var estDelivery = getDeliveryWindowString();
            var fullAddressStr = cAddr + ', ' + cCity + ' - ' + cPin;

            var orderRecord = {
                orderId: orderId,
                date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
                customer: { name: cName, phone: cPhone, city: cCity, pincode: cPin, address: fullAddressStr },
                paymentVerification: { utrLast4: cUtr, confirmed: true, upiId: OWNER_UPI },
                cart: cart.slice(),
                subtotal: fin.subtotal,
                bundleDiscount: fin.bundleDiscount,
                discount: fin.discount,
                orderBump: orderBumpActive,
                freeGiftUnlocked: fin.freeGiftUnlocked,
                total: fin.finalTotal,
                estimatedDelivery: estDelivery,
                status: 'UPI UTR Submitted (Ref #' + cUtr + ')',
                stage: 2
            };

            try {
                var existingOrders = JSON.parse(safeGetLocal('prem_orders_v6') || '[]');
                existingOrders.unshift(orderRecord);
                safeSetLocal('prem_orders_v6', JSON.stringify(existingOrders.slice(0, 15)));
            } catch (e) {}

            try {
                await fetch('/api/place-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderRecord)
                });
            } catch (error) {}

            var nl = "\n";
            var waMsg = "*🛍️ VERIFIED ORDER & UPI RECEIPT - PREM'S STORE*" + nl + nl;
            waMsg += "*🏷️ Order ID:* " + orderId + nl;
            waMsg += "*🔐 UPI Ref / UTR (Last 4+):* #" + cUtr + " (PAID)" + nl;
            waMsg += "*📅 Est. Delivery:* " + estDelivery + nl + nl;

            waMsg += "*👤 Compulsory Delivery Address:*" + nl;
            waMsg += "Name: " + cName + nl;
            waMsg += "WhatsApp: +91 " + cPhone + nl;
            waMsg += "Address: " + cAddr + nl;
            waMsg += "City/State: " + cCity + nl;
            waMsg += "Pincode: *" + cPin + "*" + nl + nl;

            waMsg += "*🛒 Items Ordered:*" + nl;
            for (var i = 0; i < cart.length; i++) {
                waMsg += "▪️ " + cart[i].qty + "x " + cart[i].title + " (₹" + (cart[i].price * cart[i].qty).toLocaleString('en-IN') + ")" + nl;
            }
            if (orderBumpActive) {
                waMsg += "▪️ 1x VIP Transit Insurance & Priority Dispatch (₹99)" + nl;
            }
            if (fin.freeGiftUnlocked) {
                waMsg += "🎁 1x FREE Mystery Tailoring/Utility Gift Unlocked (₹0)" + nl;
            }
            if (fin.bundleDiscount > 0) {
                waMsg += "⚡ Multi-Item Bundle Savings: -₹" + fin.bundleDiscount.toLocaleString('en-IN') + nl;
            }
            if (fin.discount > 0) {
                waMsg += "🏷️ VIP 10% Coupon (PREM10): -₹" + fin.discount.toLocaleString('en-IN') + nl;
            }
            waMsg += nl + "*💰 TOTAL PAID VIA UPI:* ₹" + fin.finalTotal.toLocaleString('en-IN') + nl;
            waMsg += "*🏦 Paid To UPI ID:* " + OWNER_UPI + nl + nl;
            waMsg += "✅ *I have completed the UPI payment (Ref #" + cUtr + "). Sharing my payment screenshot below for instant dispatch!*";

            var whatsappURL = "https://wa.me/" + OWNER_WHATSAPP + "?text=" + encodeURIComponent(waMsg);

            cart = [];
            saveCart();
            updateCartUI();
            closeShippingModal();

            btn.innerHTML = '<i class="fa-brands fa-whatsapp text-lg"></i><span>Verify Payment &amp; Send Order to WhatsApp</span>';
            btn.disabled = false;

            window.location.href = whatsappURL;
        }

        function openTrackModal() {
            renderRecentOrdersPills();
            var modal = document.getElementById('track-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeTrackModal() {
            var modal = document.getElementById('track-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function renderRecentOrdersPills() {
            try {
                var list = JSON.parse(safeGetLocal('prem_orders_v6') || '[]');
                var box = document.getElementById('recent-orders-box');
                var container = document.getElementById('recent-orders-list');
                if (list.length === 0) {
                    box.classList.add('hidden');
                    return;
                }
                box.classList.remove('hidden');
                var html = '';
                for (var i = 0; i < list.length; i++) {
                    var oid = list[i].orderId;
                    html += '<button type="button" onclick="quickTrackOrder(\'' + oid + '\')" class="bg-white/10 hover:bg-brandPrimary text-white text-[11px] font-mono px-2.5 py-1 rounded-lg transition-colors">' + oid + '</button>';
                }
                container.innerHTML = html;
            } catch (e) {}
        }

        function quickTrackOrder(oid) {
            document.getElementById('track-order-id').value = oid;
            lookupOrderStatus();
        }

        async function lookupOrderStatus(event) {
            if (event) event.preventDefault();
            var inputId = (document.getElementById('track-order-id').value || '').trim().toUpperCase();
            if (!inputId) return;

            var foundOrder = null;
            try {
                var res = await fetch('/api/track/' + encodeURIComponent(inputId));
                if (res.ok) {
                    var data = await res.json();
                    if (data.found) foundOrder = data.order;
                }
            } catch (e) {}

            if (!foundOrder) {
                try {
                    var localList = JSON.parse(safeGetLocal('prem_orders_v6') || '[]');
                    foundOrder = localList.find(function(o) { return (o.orderId || '').toUpperCase() === inputId; });
                } catch (e) {}
            }

            if (!foundOrder) {
                foundOrder = {
                    orderId: inputId,
                    date: 'Active Order',
                    status: 'UPI Verification & Packing',
                    stage: 2,
                    estimatedDelivery: getDeliveryWindowString(),
                    courierInfo: ''
                };
            }

            currentTrackedOrder = foundOrder;
            renderTrackingTimeline(foundOrder);
        }

        function renderTrackingTimeline(order) {
            var card = document.getElementById('track-result-card');
            card.classList.remove('hidden');
            document.getElementById('trk-id').innerText = order.orderId;
            document.getElementById('trk-date').innerText = 'Total: ₹' + (order.total || (order.financials && order.financials.total) || 'Verified');
            document.getElementById('trk-badge').innerText = order.status || 'Processing';
            document.getElementById('trk-est').innerText = order.estimatedDelivery || getDeliveryWindowString();

            var stage = order.stage || 2;
            var steps = [
                { num: 1, label: 'Order Registered & Address Verified' },
                { num: 2, label: 'UPI UTR Reference Verification' },
                { num: 3, label: 'Approved & Dispatched from Warehouse' },
                { num: 4, label: 'Out for Delivery to Your Pincode' }
            ];

            var html = '';
            for (var i = 0; i < steps.length; i++) {
                var s = steps[i];
                var isDone = stage >= s.num;
                var icon = isDone ? '<i class="fa-solid fa-circle-check text-emerald-400"></i>' : '<i class="fa-regular fa-circle text-slate-600"></i>';
                var textStyle = isDone ? 'text-white font-bold' : 'text-slate-500';
                html += '<div class="flex items-center space-x-2.5">' + icon + '<span class="' + textStyle + '">' + s.label + '</span></div>';
            }
            if (order.courierInfo) {
                html += '<div class="mt-2 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-300 text-[11px]"><strong>Courier Info:</strong> ' + order.courierInfo + '</div>';
            }
            document.getElementById('trk-steps').innerHTML = html;
        }

        function pingWhatsAppForTracking() {
            var id = currentTrackedOrder ? currentTrackedOrder.orderId : (document.getElementById('track-order-id').value || '').trim().toUpperCase();
            var msg = "Hello Prem's Store! Please share the live shipping update for my Order ID: *" + id + "*";
            window.location.href = "https://wa.me/" + OWNER_WHATSAPP + "?text=" + encodeURIComponent(msg);
        }

        function openAdminModal() {
            var modal = document.getElementById('admin-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeAdminModal() {
            var modal = document.getElementById('admin-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function unlockAdminPanel() {
            var pin = document.getElementById('admin-pin-input').value.trim();
            if (pin === '9014') {
                document.getElementById('admin-pin-gate').classList.add('hidden');
                document.getElementById('admin-content').classList.remove('hidden');
                loadAdminOrders();
            } else {
                showToast('Incorrect PIN. Default is 9014.');
            }
        }

        async function loadAdminOrders() {
            var container = document.getElementById('admin-orders-list');
            container.innerHTML = '<p class="text-slate-400">Loading verified orders...</p>';
            try {
                var res = await fetch('/api/admin/orders');
                var data = await res.json();
                var orders = data.orders || [];
                if (orders.length === 0) {
                    container.innerHTML = '<p class="text-slate-500">No orders in current server session yet.</p>';
                    return;
                }
                var html = '';
                for (var i = 0; i < orders.length; i++) {
                    var o = orders[i];
                    var phone = (o.customer && o.customer.phone) ? o.customer.phone : '';
                    var name = (o.customer && o.customer.name) ? o.customer.name : 'Customer';
                    var utr = (o.paymentVerification && o.paymentVerification.utrLast4) ? o.paymentVerification.utrLast4 : 'N/A';
                    var total = (o.financials && o.financials.total) ? o.financials.total : o.total;
                    html += '<div class="bg-darkSurface p-3 rounded-xl border border-darkBorder flex flex-col sm:flex-row justify-between gap-2">' +
                        '<div>' +
                            '<span class="font-mono font-bold text-brandPrimary">' + o.orderId + '</span> • <strong class="text-white">' + name + '</strong> (' + phone + ')' +
                            '<p class="text-slate-400 text-[11px]">Total: ₹' + total + ' | UTR Ref: <strong class="text-amber-300">#' + utr + '</strong> | Status: <strong class="text-emerald-400">' + o.status + '</strong></p>' +
                        '</div>' +
                        '<div class="flex items-center space-x-1.5 shrink-0">' +
                            '<button onclick="adminQuickUpdate(\'' + o.orderId + '\', \'' + phone + '\', \'Approved & Packing\', 3)" class="bg-emerald-500 text-black font-bold px-2.5 py-1 rounded text-[11px]">Approve</button>' +
                            '<button onclick="adminQuickUpdate(\'' + o.orderId + '\', \'' + phone + '\', \'Shipped\', 4)" class="bg-blue-500 text-white font-bold px-2.5 py-1 rounded text-[11px]">Mark Shipped</button>' +
                            '<button onclick="adminQuickUpdate(\'' + o.orderId + '\', \'' + phone + '\', \'Canceled\', 1)" class="bg-red-500 text-white font-bold px-2.5 py-1 rounded text-[11px]">Cancel</button>' +
                        '</div>' +
                    '</div>';
                }
                container.innerHTML = html;
            } catch (e) {
                container.innerHTML = '<p class="text-slate-500">Offline mode. Use the 1-Tap Customer WhatsApp Notifier above.</p>';
            }
        }

        async function adminQuickUpdate(orderId, phone, newStatus, newStage) {
            try {
                await fetch('/api/admin/update-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin: '9014', orderId: orderId, status: newStatus, stage: newStage })
                });
                loadAdminOrders();
            } catch (e) {}

            document.getElementById('adm-order-id').value = orderId;
            if (phone) document.getElementById('adm-cust-phone').value = phone;
            showToast('Updated ' + orderId + ' to ' + newStatus);
        }

        function sendMerchantWhatsApp(type) {
            var rawPhone = (document.getElementById('adm-cust-phone').value || '').replace(/[^0-9]/g, '');
            if (rawPhone.length === 10) rawPhone = '91' + rawPhone;
            var orderId = (document.getElementById('adm-order-id').value || 'your order').trim().toUpperCase();
            var courier = (document.getElementById('adm-courier').value || '').trim();
            var est = getDeliveryWindowString();

            if (!rawPhone) {
                showToast('Please enter the customer phone number first.');
                return;
            }

            var msg = '';
            if (type === 'APPROVED') {
                msg = "✅ *ORDER APPROVED - PREM'S STORE*\n\nHello! Your UPI payment for Order *" + orderId + "* has been verified.\n\n📦 *Status:* Packed & Ready for Dispatch\n🚚 *Estimated Delivery:* " + est + "\n\nThank you for shopping with Prem's Store!";
            } else if (type === 'SHIPPED') {
                msg = "🚚 *ORDER SHIPPED - PREM'S STORE*\n\nGreat news! Your Order *" + orderId + "* has been dispatched.\n\n" + (courier ? ("*📍 Tracking Details:* " + courier + "\n\n") : "") + "📅 *Estimated Delivery:* " + est + "\n\nYou can track your status anytime on our website!";
            } else {
                msg = "⚠️ *ORDER UPDATE - PREM'S STORE*\n\nRegarding your Order *" + orderId + "*: We could not verify the UPI UTR reference for your order.\n\nIf you wish to complete your order via UPI (*" + OWNER_UPI + "*), please reply with your payment screenshot!";
            }

            window.open("https://wa.me/" + rawPhone + "?text=" + encodeURIComponent(msg), "_blank");
        }

        function startSocialProofEngine() {
            var names = ["Masterji Rajesh", "Farheen Boutique", "Karthik Nair", "Harshvardhan Stores", "Ananya", "Priya", "Sneha", "Lakshmi Tailors", "Rahul", "Vikram", "Pooja"];
            var cities = ["Hyderabad", "Surat", "Bengaluru", "Pune", "Mumbai", "Delhi", "Chennai", "Kolkata", "Ahmedabad", "Jaipur"];

            setInterval(function() {
                var rName = names[Math.floor(Math.random() * names.length)];
                var rCity = cities[Math.floor(Math.random() * cities.length)];
                var rProd = storeProducts[Math.floor(Math.random() * 24)];

                document.getElementById('sp-name').innerText = rName;
                document.getElementById('sp-city').innerText = rCity;
                document.getElementById('sp-product').innerText = rProd.title;
                document.getElementById('sp-img').src = rProd.image;

                var popup = document.getElementById('social-proof-popup');
                popup.classList.remove('hidden');
                popup.classList.add('live-popup');

                setTimeout(function() {
                    popup.classList.add('hidden');
                    popup.classList.remove('live-popup');
                }, 4800);
            }, 13000);
        }

        calculateDeliveryDate();
        filterAndRenderCatalog();
        renderReviewsWall();
        updateCartUI();
        startSocialProofEngine();
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(frontendHTML));

app.listen(PORT, () => {
    console.log("\n💎 PREM'S STORE v6.0 (AUDITED + MATCHED IMAGES + 10 UNDER-₹500 PICKS IN MIDDLE) IS LIVE ON PORT " + PORT);
});
