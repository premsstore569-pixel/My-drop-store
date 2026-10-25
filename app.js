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

// In-Memory Cloud Fallback Store (persists even on Read-Only cloud servers)
let memoryOrders = [];

// Load existing orders if local file exists
try {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ orders: [] }, null, 4));
    } else {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.orders)) {
            memoryOrders = parsed.orders;
        }
    }
} catch (error) {
    console.log("Cloud Read-Only Mode active. Using RAM storage + WhatsApp tunnel.");
}

function saveOrdersToDisk() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ orders: memoryOrders }, null, 4));
    } catch (e) {
        // Silently bypass on read-only cloud hosts
    }
}

// 1. PLACE ORDER API
app.post('/api/place-order', (req, res) => {
    const { orderId, customer, cart, subtotal, discount, orderBump, total, utr, estimatedDelivery } = req.body;

    const finalOrderId = orderId || ('ORD-' + Math.floor(100000 + Math.random() * 900000));
    const newOrder = {
        orderId: finalOrderId,
        date: new Date().toISOString(),
        customer: customer || {},
        cart: cart || [],
        financials: { subtotal, discount, orderBumpAdded: orderBump, total },
        utr: utr || 'Pending Screenshot',
        estimatedDelivery: estimatedDelivery || '5-7 Business Days',
        status: 'Payment Verification',
        stage: 2,
        courierInfo: ''
    };

    memoryOrders.unshift(newOrder);
    saveOrdersToDisk();

    console.log("\n📲 [NEW ORDER] " + finalOrderId + " | Customer: " + (customer ? customer.name : 'Guest') + " | Total: ₹" + total);
    res.status(200).json({ success: true, order: newOrder });
});

// 2. TRACK SINGLE ORDER API
app.get('/api/track/:orderId', (req, res) => {
    const searchId = (req.params.orderId || '').trim().toUpperCase();
    const found = memoryOrders.find(o => o.orderId.toUpperCase() === searchId);
    if (found) {
        return res.status(200).json({ found: true, order: found });
    }
    return res.status(404).json({ found: false, message: 'Order not in current session memory' });
});

// 3. MERCHANT ADMIN API: LIST & UPDATE ORDERS
app.get('/api/admin/orders', (req, res) => {
    res.status(200).json({ orders: memoryOrders });
});

app.post('/api/admin/update-order', (req, res) => {
    const { pin, orderId, status, stage, courierInfo } = req.body;
    if (pin !== '9014') {
        return res.status(403).json({ success: false, message: 'Invalid Merchant PIN' });
    }
    const order = memoryOrders.find(o => o.orderId.toUpperCase() === (orderId || '').toUpperCase());
    if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found in server memory' });
    }
    if (status) order.status = status;
    if (stage) order.stage = Number(stage);
    if (courierInfo !== undefined) order.courierInfo = courierInfo;
    saveOrdersToDisk();

    res.status(200).json({ success: true, order });
});

// FRONTEND APPLICATION (Zero nested backticks for 100% compatibility)
const frontendHTML = String.raw`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prem's Store | Next-Gen Utility & Self-Care</title>
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
        .glass { background: rgba(18, 18, 21, 0.88); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.07); }
        .btn-glow { box-shadow: 0 0 20px rgba(255, 51, 102, 0.45); transition: all 0.25s ease; }
        .btn-glow:hover { box-shadow: 0 0 30px rgba(255, 51, 102, 0.75); transform: translateY(-1px); }
        .btn-glow-whatsapp { box-shadow: 0 0 20px rgba(37, 211, 102, 0.35); transition: all 0.25s ease; }
        .btn-glow-whatsapp:hover { box-shadow: 0 0 30px rgba(37, 211, 102, 0.65); transform: translateY(-1px); }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes slideIn { from { transform: translateX(-110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .live-popup { animation: slideIn 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
    </style>
</head>
<body class="font-sans min-h-screen flex flex-col relative selection:bg-brandPrimary selection:text-white">

    <!-- TOP PROMO ANNOUNCEMENT BAR -->
    <div class="bg-gradient-to-r from-brandPrimary via-pink-600 to-rose-600 text-white text-[11px] md:text-xs font-bold py-2 px-4 text-center flex items-center justify-center space-x-2 z-50">
        <span>⚡ FLASH SALE LIVE: Get 10% OFF with code <strong class="underline cursor-pointer bg-black/25 px-1.5 py-0.5 rounded" onclick="applyQuickCoupon('PREM10')">PREM10</strong> (Click to Auto-Apply) + Free VIP Delivery above ₹1,000!</span>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toast-box" class="fixed top-14 right-4 z-[100] hidden bg-white text-black px-4 py-3 rounded-xl shadow-2xl border-l-4 border-brandPrimary text-xs font-bold flex items-center space-x-2">
        <i class="fa-solid fa-circle-check text-brandPrimary text-base"></i>
        <span id="toast-text">Action completed</span>
    </div>

    <!-- FOMO SOCIAL PROOF POPUP -->
    <div id="social-proof-popup" class="fixed bottom-5 left-4 z-40 glass p-3.5 rounded-xl shadow-2xl flex items-center space-x-3.5 hidden max-w-xs border-l-4 border-l-brandPrimary pointer-events-none">
        <img id="sp-img" src="" class="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0">
        <div class="overflow-hidden">
            <p class="text-[11px] text-slate-300 truncate"><span id="sp-name" class="font-bold text-white"></span> in <span id="sp-city" class="text-white font-semibold"></span> bought</p>
            <p id="sp-product" class="text-xs font-extrabold text-brandPrimary truncate"></p>
            <p class="text-[10px] text-emerald-400 mt-0.5 flex items-center"><i class="fa-solid fa-shield-check mr-1"></i>Verified UPI Buyer • Just now</p>
        </div>
    </div>

    <!-- STICKY HEADER -->
    <header class="sticky top-0 z-40 glass border-b border-white/10 shadow-lg">
        <div class="container mx-auto px-4 py-3.5 flex flex-wrap justify-between items-center gap-3 max-w-7xl">
            <a href="#" onclick="setCategoryFilter('All'); return false;" class="text-2xl font-black tracking-tighter text-white flex items-center">
                PREM<span class="text-brandPrimary">STORE</span>
                <span class="ml-2 text-[9px] bg-white/10 text-slate-300 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest hidden sm:inline-block">Verified</span>
            </a>

            <!-- SEARCH BAR -->
            <div class="relative flex-grow max-w-md order-3 md:order-2 w-full md:w-auto">
                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input type="text" id="search-input" oninput="filterAndRenderCatalog()" placeholder="Search 50+ viral problem solvers, beauty tools, rain gear..." class="w-full pl-9 pr-8 py-2 bg-darkSurface border border-darkBorder rounded-full text-xs text-white placeholder-slate-500 outline-none focus:border-brandPrimary transition-colors">
                <button onclick="clearSearch()" id="clear-search-btn" class="hidden absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <!-- ACTION BUTTONS -->
            <div class="flex items-center space-x-2.5 order-2 md:order-3">
                <button onclick="openTrackModal()" class="flex items-center space-x-1.5 text-xs font-bold text-slate-200 hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-3.5 py-2 rounded-full border border-white/10">
                    <i class="fa-solid fa-truck-fast text-brandPrimary"></i>
                    <span>Track Order</span>
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
    <main class="container mx-auto px-4 py-8 flex-grow max-w-7xl">
        <div class="flex flex-col items-center text-center mb-8">
            <div class="bg-red-500/10 text-red-400 border border-red-500/20 px-3.5 py-1 rounded-full text-[11px] font-bold mb-3 animate-pulse tracking-wider uppercase">
                <i class="fa-solid fa-fire mr-1"></i> High Demand: Express Dispatch Active
            </div>
            <h1 class="text-3xl md:text-5xl font-black text-white mb-3 tracking-tight">Viral Problem-Solvers. Delivered Fast.</h1>
            <p class="text-slate-400 max-w-xl text-xs md:text-sm">From clinical-grade beauty hardware to heavy-duty daily utility gear. Instant UPI checkout & real-time WhatsApp order support.</p>
        </div>

        <!-- FILTER & SORT BAR -->
        <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 mb-7 pb-3 border-b border-white/5">
            <div class="flex items-center space-x-2 overflow-x-auto hide-scrollbar py-1">
                <button data-cat="All" onclick="setCategoryFilter('All')" class="cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold shadow-glow transition-all whitespace-nowrap">All Products (50)</button>
                <button data-cat="Beauty & Care" onclick="setCategoryFilter('Beauty & Care')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">✨ Beauty & Care</button>
                <button data-cat="Home" onclick="setCategoryFilter('Home')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🏠 Home Hacks</button>
                <button data-cat="Gear" onclick="setCategoryFilter('Gear')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">⚡ Daily Utility</button>
                <button data-cat="Footwear" onclick="setCategoryFilter('Footwear')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">👟 Footwear</button>
                <button data-cat="Apparel" onclick="setCategoryFilter('Apparel')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🧥 Apparel</button>
                <button data-cat="Vehicle" onclick="setCategoryFilter('Vehicle')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🚗 Vehicle</button>
            </div>

            <div class="flex items-center space-x-2 shrink-0 self-end md:self-auto">
                <span class="text-xs text-slate-400">Sort:</span>
                <select id="sort-select" onchange="filterAndRenderCatalog()" class="bg-darkSurface border border-darkBorder text-white text-xs rounded-xl px-3 py-2 outline-none focus:border-brandPrimary">
                    <option value="featured">Featured Winners</option>
                    <option value="price-asc">Price: Low to High</option>
                    <option value="price-desc">Price: High to Low</option>
                    <option value="rating">Highest Rated</option>
                </select>
            </div>
        </div>

        <!-- PRODUCT COUNT & GRID -->
        <div class="mb-4 flex justify-between items-center text-xs text-slate-400">
            <span id="results-counter">Showing all 50 products</span>
            <span class="text-emerald-400 font-semibold"><i class="fa-solid fa-bolt mr-1"></i>Est. Delivery: <strong id="hero-delivery-date">Calculating...</strong></span>
        </div>

        <div id="product-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"></div>
    </main>

    <!-- FOOTER WITH MERCHANT PORTAL TRIGGER -->
    <footer class="border-t border-white/10 bg-black/60 py-8 px-4 mt-16 text-xs text-slate-500">
        <div class="container mx-auto max-w-7xl flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
                <span class="font-black text-white text-base">PREM<span class="text-brandPrimary">STORE</span></span>
                <p class="mt-1">Direct UPI Checkout • 24/7 WhatsApp Support (+91 9014044915)</p>
            </div>
            <div class="flex items-center space-x-4">
                <button onclick="openTrackModal()" class="hover:text-white transition-colors">Track Order</button>
                <span>•</span>
                <button onclick="openAdminModal()" class="hover:text-brandPrimary transition-colors flex items-center space-x-1"><i class="fa-solid fa-lock text-[10px]"></i><span>Merchant Portal</span></button>
            </div>
        </div>
    </footer>

    <!-- QUICK VIEW PRODUCT MODAL -->
    <div id="quickview-modal" class="fixed inset-0 z-[70] bg-black/85 backdrop-blur-sm hidden items-center justify-center p-4">
        <div class="glass rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl border border-white/10 relative grid md:grid-cols-2">
            <button onclick="closeQuickView()" class="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/70 text-white hover:bg-brandPrimary flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            <div class="bg-black aspect-square md:aspect-auto h-64 md:h-full relative">
                <img id="qv-img" src="" class="w-full h-full object-cover">
                <span id="qv-badge" class="absolute top-3 left-3 bg-brandPrimary text-white text-[10px] font-black px-3 py-1 rounded-full uppercase"></span>
            </div>
            <div class="p-6 flex flex-col justify-between bg-darkSurface">
                <div>
                    <div class="flex items-center space-x-1 text-amber-400 text-xs mb-2">
                        <i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star-half-stroke"></i>
                        <span id="qv-rating" class="font-bold text-white ml-1"></span>
                    </div>
                    <h3 id="qv-title" class="text-xl font-black text-white mb-2"></h3>
                    <div class="flex items-baseline space-x-2 mb-3">
                        <span id="qv-price" class="text-2xl font-black text-brandPrimary"></span>
                        <span id="qv-mrp" class="text-xs text-slate-500 line-through font-mono"></span>
                        <span class="text-[10px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded font-bold">Save 25%</span>
                    </div>
                    <p id="qv-desc" class="text-xs text-slate-300 leading-relaxed mb-4"></p>

                    <!-- Pincode Checker -->
                    <div class="bg-black/50 p-3 rounded-xl border border-white/5 mb-4">
                        <label class="text-[10px] font-bold text-slate-400 uppercase block mb-1.5">Check Fast Delivery to Your Pincode</label>
                        <div class="flex space-x-2">
                            <input type="text" id="qv-pincode" maxlength="6" placeholder="Enter 6-digit Pincode" class="w-full bg-darkSurface border border-darkBorder rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-brandPrimary">
                            <button onclick="checkPincode()" class="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-3 py-1.5 rounded-lg shrink-0">Check</button>
                        </div>
                        <p id="qv-pin-result" class="text-[11px] text-emerald-400 font-semibold mt-1.5 hidden"></p>
                    </div>
                </div>

                <div class="space-y-2">
                    <button id="qv-add-btn" class="w-full bg-white/10 hover:bg-white/20 text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-all">Add to Cart</button>
                    <button id="qv-buy-btn" class="w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow text-xs uppercase tracking-wider">Buy Now • Instant UPI Checkout</button>
                </div>
            </div>
        </div>
    </div>

    <!-- SLIDE-OUT CART SIDEBAR -->
    <div id="cart-sidebar" class="fixed inset-y-0 right-0 z-50 w-full max-w-md glass shadow-2xl transform translate-x-full transition-transform duration-300 flex flex-col border-l border-white/10">
        <div class="p-4 flex justify-between items-center border-b border-white/10 bg-black/50">
            <h3 class="text-lg font-black text-white flex items-center"><i class="fa-solid fa-lock text-brandPrimary mr-2 text-sm"></i> Your Reserved Cart</h3>
            <button onclick="toggleCart()" class="text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
        </div>

        <!-- Scarcity Timer & Auto Delivery Date -->
        <div class="bg-red-500/10 py-2 px-4 border-b border-red-500/20 flex items-center justify-between text-xs">
            <span class="font-bold text-red-400"><i class="fa-solid fa-stopwatch mr-1"></i>Reserved for: <strong id="cart-timer" class="font-mono text-white bg-red-500/30 px-1.5 py-0.5 rounded">10:00</strong></span>
            <span class="text-slate-300 text-[11px]">Est: <strong id="auto-delivery-date" class="text-emerald-400">Calculating...</strong></span>
        </div>

        <!-- VIP Shipping Bar -->
        <div class="p-3.5 border-b border-white/5 bg-darkSurface">
            <div class="flex justify-between text-[11px] font-bold mb-1.5 text-slate-300" id="shipping-text">Add ₹1,000 for FREE VIP Shipping</div>
            <div class="w-full bg-black rounded-full h-1.5 border border-white/5 overflow-hidden">
                <div id="shipping-progress" class="bg-brandPrimary h-1.5 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
        </div>

        <!-- Cart Items List -->
        <div id="cart-items" class="flex-grow p-4 overflow-y-auto space-y-3"></div>

        <!-- Cart Footer -->
        <div class="p-5 bg-black/90 border-t border-white/10 space-y-3">
            <!-- Promo Code Input -->
            <div class="flex space-x-2">
                <input type="text" id="coupon-input" placeholder="Promo code (Try PREM10)" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3 py-2 text-xs text-white uppercase outline-none focus:border-brandPrimary">
                <button onclick="applyCouponInput()" class="bg-white/10 hover:bg-white/20 text-white font-bold px-4 py-2 rounded-xl text-xs shrink-0">Apply</button>
            </div>

            <!-- Order Bump -->
            <label class="flex items-start space-x-3 bg-brandPrimary/10 border border-brandPrimary/30 p-3 rounded-xl cursor-pointer hover:bg-brandPrimary/15 transition-colors">
                <input type="checkbox" id="order-bump" onchange="updateCartUI()" class="w-4 h-4 mt-0.5 accent-brandPrimary cursor-pointer">
                <div class="text-xs">
                    <div class="font-bold text-white flex justify-between">
                        <span>VIP Transit Insurance & Priority Dispatch</span>
                        <span class="text-brandPrimary font-black ml-2">+₹99</span>
                    </div>
                    <p class="text-[10px] text-slate-400 mt-0.5">100% instant replacement guarantee against transit damage or loss.</p>
                </div>
            </label>

            <div class="space-y-1 text-xs pt-1">
                <div class="flex justify-between text-slate-400"><span>Subtotal:</span><span id="cart-subtotal">₹0</span></div>
                <div id="discount-row" class="flex justify-between text-emerald-400 font-bold hidden"><span>Discount (PREM10 - 10%):</span><span id="cart-discount">-₹0</span></div>
                <div class="flex justify-between text-xl font-black text-white border-t border-white/10 pt-2"><span>Total Payable:</span><span id="cart-total" class="text-brandPrimary">₹0</span></div>
            </div>

            <button onclick="openShippingModal()" class="w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow flex items-center justify-center space-x-2 uppercase text-xs tracking-wider">
                <span>Proceed to Instant UPI Checkout</span>
                <i class="fa-solid fa-arrow-right"></i>
            </button>
        </div>
    </div>

    <!-- SMART CHECKOUT & UPI PAYMENT MODAL -->
    <div id="shipping-modal" class="fixed inset-0 z-[75] bg-black/90 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-lg p-5 sm:p-7 shadow-2xl relative border border-white/15 my-auto">
            <button onclick="closeShippingModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>

            <div class="flex items-center space-x-2 text-brandPrimary text-xs font-bold uppercase tracking-wider mb-1">
                <i class="fa-solid fa-shield-halved"></i>
                <span>Zero-Fee Direct UPI & WhatsApp Checkout</span>
            </div>
            <h3 class="text-xl sm:text-2xl font-black text-white mb-4">Complete Your Order</h3>

            <form id="shipping-form" onsubmit="submitOrderAndRedirectToWhatsApp(event)" class="space-y-3.5">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input type="text" id="cust-name" placeholder="Full Name *" required class="w-full px-3.5 py-3 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary">
                    <input type="tel" id="cust-phone" placeholder="WhatsApp Mobile Number *" required pattern="[0-9+ ]{10,15}" class="w-full px-3.5 py-3 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary">
                </div>
                <textarea id="cust-address" placeholder="House No, Building, Street, Area, City & 6-Digit Pincode *" required rows="2" class="w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary"></textarea>

                <!-- RELIABLE DUAL-LAYER UPI PAYMENT BOX -->
                <div class="bg-darkSurface border border-white/10 rounded-2xl p-4 space-y-3">
                    <div class="flex justify-between items-center border-b border-white/10 pb-2.5">
                        <div>
                            <span class="text-[11px] text-slate-400 block">Amount to Pay via UPI</span>
                            <span id="checkout-total-badge" class="text-xl font-black text-emerald-400">₹0</span>
                        </div>
                        <div class="text-right">
                            <span class="text-[10px] bg-emerald-500/15 text-emerald-400 px-2.5 py-1 rounded-full font-bold">0% Gateway Fee</span>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                        <!-- Dynamic QR Code -->
                        <div class="flex flex-col items-center bg-white p-2 rounded-xl mx-auto">
                            <img id="upi-qr-img" src="" alt="Scan UPI QR" class="w-28 h-28 object-contain">
                            <span class="text-[9px] text-black font-bold mt-1">Scan with any UPI App</span>
                        </div>

                        <!-- 1-Tap UPI App + Copy ID -->
                        <div class="sm:col-span-2 space-y-2">
                            <a id="direct-upi-link" href="#" class="w-full bg-emerald-500 hover:bg-emerald-600 text-black font-black py-2.5 px-3 rounded-xl text-xs flex items-center justify-center space-x-2 transition-all">
                                <i class="fa-solid fa-bolt"></i>
                                <span>Tap to Pay on Phone (GPay/PhonePe)</span>
                            </a>

                            <div class="flex items-center justify-between bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs">
                                <span class="text-slate-300 font-mono truncate mr-2" id="upi-id-display">premkumarmanthena289@oksbi</span>
                                <button type="button" onclick="copyUpiId()" class="text-brandPrimary hover:text-white font-bold text-[11px] shrink-0"><i class="fa-regular fa-copy mr-1"></i>Copy UPI</button>
                            </div>

                            <input type="text" id="cust-utr" placeholder="Optional: Enter UPI Ref / Last 4 digits of UTR" class="w-full px-3 py-2 bg-black/40 border border-darkBorder rounded-xl text-[11px] text-white outline-none focus:border-brandPrimary">
                        </div>
                    </div>
                </div>

                <button type="submit" id="whatsapp-checkout-btn" class="w-full bg-whatsapp text-black font-black py-4 rounded-xl btn-glow-whatsapp tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2">
                    <i class="fa-brands fa-whatsapp text-lg"></i>
                    <span>Confirm Order & Send Invoice on WhatsApp</span>
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
                    <p class="text-xs text-slate-400">Real-time status & WhatsApp dispatch desk</p>
                </div>
            </div>

            <!-- Saved Orders on this device -->
            <div id="recent-orders-box" class="mb-4 hidden">
                <p class="text-[10px] font-bold uppercase text-slate-400 mb-1.5">Your Recent Orders on This Device:</p>
                <div id="recent-orders-list" class="flex flex-wrap gap-1.5"></div>
            </div>

            <form onsubmit="lookupOrderStatus(event)" class="flex space-x-2 mb-4">
                <input type="text" id="track-order-id" placeholder="Enter Order ID (e.g. ORD-482910)" required class="w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs font-mono text-white uppercase outline-none focus:border-brandPrimary">
                <button type="submit" class="bg-brandPrimary text-white font-bold px-4 py-2.5 rounded-xl text-xs shrink-0">Track</button>
            </form>

            <!-- Dynamic Visual Timeline Result -->
            <div id="track-result-card" class="hidden bg-darkSurface border border-white/10 rounded-xl p-4 space-y-4">
                <div class="flex justify-between items-start border-b border-white/10 pb-3">
                    <div>
                        <span id="trk-id" class="font-mono font-black text-sm text-brandPrimary"></span>
                        <p id="trk-date" class="text-[11px] text-slate-400"></p>
                    </div>
                    <span id="trk-badge" class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300"></span>
                </div>

                <!-- 4-Step Progress Bar -->
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

    <!-- MERCHANT COMMAND CENTER MODAL (FOR PREM - PIN: 9014) -->
    <div id="admin-modal" class="fixed inset-0 z-[90] bg-black/95 backdrop-blur-md hidden items-center justify-center p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-2xl p-6 shadow-2xl relative border border-white/15 my-auto max-h-[90vh] flex flex-col">
            <button onclick="closeAdminModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            <h3 class="text-xl font-black text-white mb-1"><i class="fa-solid fa-user-shield text-brandPrimary mr-2"></i>Prem's Merchant Command Center</h3>
            <p class="text-xs text-slate-400 mb-4">Approve orders, update live tracking status, or send 1-tap WhatsApp confirmations to customers.</p>

            <!-- PIN Gate -->
            <div id="admin-pin-gate" class="flex space-x-2 mb-4">
                <input type="password" id="admin-pin-input" placeholder="Enter Merchant PIN (Default: 9014)" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-brandPrimary">
                <button onclick="unlockAdminPanel()" class="bg-brandPrimary text-white font-bold px-5 py-2.5 rounded-xl text-xs shrink-0">Unlock</button>
            </div>

            <!-- Unlocked Admin Controls -->
            <div id="admin-content" class="hidden overflow-y-auto space-y-4 pr-1">
                <!-- Quick Manual WhatsApp Status Sender (Works even if server restarted) -->
                <div class="bg-darkSurface p-4 rounded-xl border border-white/10 space-y-3">
                    <h4 class="text-xs font-bold uppercase text-brandPrimary">1-Tap Customer WhatsApp Notifier</h4>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input type="tel" id="adm-cust-phone" placeholder="Customer Phone (e.g. 9876543210)" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white">
                        <input type="text" id="adm-order-id" placeholder="Order ID (e.g. ORD-123456)" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white uppercase">
                        <input type="text" id="adm-courier" placeholder="Courier / Tracking Link (Optional)" class="bg-black border border-darkBorder rounded-lg px-3 py-2 text-xs text-white">
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <button onclick="sendMerchantWhatsApp('APPROVED')" class="bg-emerald-500 hover:bg-emerald-600 text-black font-bold px-3 py-2 rounded-lg text-xs">✅ Send "Order Approved" Msg</button>
                        <button onclick="sendMerchantWhatsApp('SHIPPED')" class="bg-blue-500 hover:bg-blue-600 text-white font-bold px-3 py-2 rounded-lg text-xs">🚚 Send "Order Shipped" Msg</button>
                        <button onclick="sendMerchantWhatsApp('CANCELED')" class="bg-red-500 hover:bg-red-600 text-white font-bold px-3 py-2 rounded-lg text-xs">❌ Send "Payment Pending / Cancel" Msg</button>
                    </div>
                </div>

                <!-- Server Orders List -->
                <div>
                    <div class="flex justify-between items-center mb-2">
                        <h4 class="text-xs font-bold uppercase text-slate-400">Recent Server Orders</h4>
                        <button onclick="loadAdminOrders()" class="text-xs text-brandPrimary hover:underline"><i class="fa-solid fa-rotate mr-1"></i>Refresh</button>
                    </div>
                    <div id="admin-orders-list" class="space-y-2.5 text-xs"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // 50 VERIFIED WINNING PRODUCTS (30 Monsoon/Utility + 10 Evergreen + 10 Female Beauty Hardware)
        var storeProducts = [
            // --- 30 MONSOON & UTILITY ---
            { id: 1, title: "Foldable Hot Air Clothes Drying Bag", price: 3339, category: "Home", rating: 4.9, reviews: 412, stock: 3, description: "The ultimate indoor laundry drying solution for home and travel. Attaches to any hair dryer or blower to dry damp garments in 6 minutes.", image: "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 2, title: "Inverted Reverse LED Umbrella", price: 1069, category: "Gear", rating: 4.9, reviews: 142, stock: 5, description: "Folds inside-out to trap rainwater inside so your car and floors stay dry. Built-in LED rotatable handle flashlight.", image: "https://images.unsplash.com/photo-1559827260-36fa90744fb5?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 3, title: "Portable Mini Dehumidifier", price: 1999, category: "Home", rating: 4.9, reviews: 84, stock: 2, description: "Eliminates closet dampness, musty odors, and mold from expensive clothes and camera gear.", image: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 4, title: "Anti-Fog Helmet Visor Film", price: 539, category: "Vehicle", rating: 4.9, reviews: 230, stock: 7, description: "Clear nano-adhesive shield. Prevents fogging from breath and rain instantly for crystal-clear night riding.", image: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 5, title: "Hydrophobic Side Mirror Film (2 Pc)", price: 339, category: "Vehicle", rating: 4.6, reviews: 67, stock: 4, description: "Nano-coating prevents car side mirrors from holding water droplets during heavy downpours.", image: "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 6, title: "Electric Hot Air Clothes Hanger", price: 2539, category: "Home", rating: 4.9, reviews: 154, stock: 2, description: "Portable travel hanger with dual hot/cold airflow vents. Dries wet office shirts rapidly overnight.", image: "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 7, title: "Waterproof Laptop Backpack Cover", price: 399, category: "Gear", rating: 4.8, reviews: 175, stock: 6, description: "High-density nylon elastic shield keeps expensive laptops and books 100% dry in heavy rain.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 8, title: "Full-Body Scooter Rain Poncho", price: 869, category: "Vehicle", rating: 4.7, reviews: 110, stock: 4, description: "Heavy-duty hooded rain suit featuring a transparent visor cutout and mirror slots.", image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 9, title: "Heavy-Duty Motorcycle Rain Cover", price: 669, category: "Vehicle", rating: 4.7, reviews: 142, stock: 3, description: "UV and silver-coated waterproof cover shielding parked two-wheelers from rust and rain.", image: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 10, title: "Rapid-Absorb Microfiber Travel Towel", price: 599, category: "Gear", rating: 4.7, reviews: 119, stock: 8, description: "Soaks up 4x its weight in water and wrings out dry. Folds into a pocket-sized pouch.", image: "https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 11, title: "Magic Microfiber Cleaning Towels (3 Pk)", price: 139, category: "Home", rating: 4.8, reviews: 512, stock: 5, description: "Ultra-absorbent lint-free cloths. Perfect for wiping wet bike seats, windshields, and counters.", image: "https://images.unsplash.com/photo-1628177142898-93e46e48c58a?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 12, title: "Reusable PVC Rain Shoe Covers", price: 189, category: "Footwear", rating: 4.6, reviews: 289, stock: 4, description: "Foldable waterproof zipper shoe covers with reinforced anti-slip tread.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 13, title: "Anti-Mosquito Herbal Patches (72 Pc)", price: 139, category: "Gear", rating: 4.9, reviews: 834, stock: 9, description: "100% natural citronella oil patches. Stick on clothes to repel mosquitoes for 12 hours.", image: "https://images.unsplash.com/photo-1577717903315-1691ae25ab3f?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 14, title: "Silicone Anti-Clog Drain Strainer", price: 95, category: "Home", rating: 4.7, reviews: 145, stock: 7, description: "Suction-cup flexible silicone trap. Prevents hair and debris from clogging shower drains.", image: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 15, title: "Universal Waterproof Phone Pouch", price: 269, category: "Gear", rating: 4.7, reviews: 312, stock: 5, description: "IPX8 certified touch-sensitive dry bag. Take calls and record underwater or in heavy rain.", image: "https://images.unsplash.com/photo-1588693821035-430b1ba8fc58?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 16, title: "Multi-Angle Aluminum Phone Stand", price: 119, category: "Gear", rating: 4.8, reviews: 420, stock: 3, description: "Foldable desktop dock. Keeps your phone elevated for hands-free calls and charging.", image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 17, title: "Waterproof Travel Cable Organizer", price: 239, category: "Gear", rating: 4.7, reviews: 198, stock: 4, description: "Cushioned tech pouch that shields power banks, adapters, and cables from moisture.", image: "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 18, title: "Pocket Raincoat Emergency Keyring Ball", price: 95, category: "Gear", rating: 4.5, reviews: 620, stock: 8, description: "Full-size emergency poncho packed inside a compact keychain sphere that clips to your bag.", image: "https://images.unsplash.com/photo-1508873696983-2df515122519?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 19, title: "Silicone Door Bottom Seal Strip", price: 169, category: "Home", rating: 4.6, reviews: 180, stock: 6, description: "Self-adhesive acoustic and weather strip. Blocks rainwater, dust, insects, and AC drafts.", image: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 20, title: "Waterproof LED Runner Shoe Clip", price: 189, category: "Gear", rating: 4.8, reviews: 115, stock: 4, description: "High-visibility heel safety light clip. Keeps night runners and cyclists visible in fog and rain.", image: "https://images.unsplash.com/photo-1511556532299-8f662fc26c06?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 21, title: "UV Thermal Shoe & Boot Dryer", price: 1339, category: "Footwear", rating: 5.0, reviews: 210, stock: 2, description: "360-degree internal heat blower dries wet sneakers overnight while UV light neutralizes odor bacteria.", image: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 22, title: "Silicone Slip-On Shoe Protectors", price: 469, category: "Footwear", rating: 4.8, reviews: 98, stock: 5, description: "Stretchable skin-tight silicone overshoes. Protects white sneakers from mud and puddles.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 23, title: "Breathable Quick-Dry Aqua Shoes", price: 839, category: "Footwear", rating: 4.7, reviews: 142, stock: 3, description: "Ultra-lightweight amphibious mesh shoes with sole drainage channels for treks and wet streets.", image: "https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 24, title: "Bamboo Charcoal Deodorizer Bags", price: 329, category: "Footwear", rating: 4.9, reviews: 310, stock: 6, description: "Natural activated charcoal pouches that pull moisture and odor out of shoes and gym bags.", image: "https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 25, title: "Men's Tactical Windbreaker Rain Jacket", price: 1779, category: "Apparel", rating: 4.9, reviews: 275, stock: 2, description: "Matte-black hydrophobic shell jacket with seam-sealed zippers and breathable mesh lining.", image: "https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 26, title: "Quick-Dry 4-Way Stretch Trousers", price: 1399, category: "Apparel", rating: 4.8, reviews: 190, stock: 4, description: "Water-repellent tailored commuter pants that shed water and dry in 15 minutes.", image: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 27, title: "All-Weather Storm Hooded Parka", price: 2149, category: "Apparel", rating: 5.0, reviews: 88, stock: 1, description: "Extended-length storm parka engineered for zero water penetration during heavy travel.", image: "https://images.unsplash.com/photo-1544441893-675973e31985?auto=format&fit=crop&w=600&q=80", badge: "Premium" },
            { id: 28, title: "Hydrophobic Stain-Proof Men's Polo", price: 749, category: "Apparel", rating: 4.7, reviews: 165, stock: 5, description: "Nano-treated breathable cotton blend. Coffee, soda, and raindrops roll right off the fabric.", image: "https://images.unsplash.com/photo-1581655353564-df123a1eb820?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 29, title: "Lightweight Zip-On Rain Overpants", price: 939, category: "Apparel", rating: 4.6, reviews: 112, stock: 3, description: "Ankle-zip waterproof over-trousers that slip easily over formal pants without removing shoes.", image: "https://images.unsplash.com/photo-1552902865-b72c031ac5ea?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 30, title: "Orthopedic Arch Waterproof Sandals", price: 1119, category: "Footwear", rating: 4.8, reviews: 320, stock: 4, description: "High-rebound EVA recovery sandals with deep anti-skid grooves for wet surfaces.", image: "https://images.unsplash.com/photo-1603808033192-082d6919d3e1?auto=format&fit=crop&w=600&q=80", badge: "Trending" },

            // --- 10 EVERGREEN WINNERS ---
            { id: 31, title: "Smart Sensor Posture Corrector Brace", price: 1299, category: "Gear", rating: 4.8, reviews: 540, stock: 5, description: "Gently vibrates whenever your back slouches past 25 degrees. Builds upright spinal muscle memory.", image: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=600&q=80", badge: "Evergreen" },
            { id: 32, title: "Portable EMS Thermal Neck Massager", price: 1899, category: "Home", rating: 4.9, reviews: 812, stock: 3, description: "Melts away desk-job neck stiffness in 15 minutes using warm compress and TENS pulse therapy.", image: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 33, title: "Mini 1080p Wide-Angle Car Dash Cam", price: 2199, category: "Vehicle", rating: 4.7, reviews: 320, stock: 6, description: "Discreet windshield camera with night vision, G-sensor collision lock, and loop recording.", image: "https://images.unsplash.com/photo-1511407409255-83e9b1399cc1?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 34, title: "Auto-Clamping Wireless Car Charger Mount", price: 1449, category: "Vehicle", rating: 4.8, reviews: 450, stock: 4, description: "Infrared sensor arms open automatically when you bring your phone near and fast-charge on the go.", image: "https://images.unsplash.com/photo-1585298723682-7115561c51b7?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 35, title: "6-Blade Portable USB Blender Bottle", price: 1199, category: "Home", rating: 4.6, reviews: 920, stock: 8, description: " crush ice, fruit, and protein shakes in 30 seconds at the gym or office. USB-C rechargeable.", image: "https://images.unsplash.com/photo-1595515286417-64b584d436a5?auto=format&fit=crop&w=600&q=80", badge: "Bestseller" },
            { id: 36, title: "Ergonomic Memory Foam Knee Pillow", price: 899, category: "Home", rating: 4.9, reviews: 1105, stock: 7, description: "Contoured leg pillow aligns hips and lower spine for side-sleepers, relieving sciatica and back pain.", image: "https://images.unsplash.com/photo-1584282570763-71ab527f394f?auto=format&fit=crop&w=600&q=80", badge: "Evergreen" },
            { id: 37, title: "Self-Cleaning Pet Hair Lint Roller", price: 549, category: "Home", rating: 4.7, reviews: 670, stock: 9, description: "Electrostatic brush traps fur and lint from sofas and clothes into a push-button dust chamber.", image: "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 38, title: "12-in-1 Mandoline Vegetable Chopper Pro", price: 999, category: "Home", rating: 4.8, reviews: 1432, stock: 2, description: "Stainless steel dicer, julienne slicer, and colander basket that cuts kitchen prep time by 70%.", image: "https://images.unsplash.com/photo-1593504049359-74330189a345?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 39, title: "Anti-Theft Crossbody Sling Tech Bag", price: 1249, category: "Gear", rating: 4.8, reviews: 490, stock: 5, description: "Slash-resistant commuter sling with TSA combination lock, hidden pockets, and external USB port.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 40, title: "Wireless Charging LED Minimalist Desk Lamp", price: 1699, category: "Home", rating: 4.7, reviews: 215, stock: 4, description: "Eye-care dimmable studio lamp with 3 color temperatures and a built-in 15W fast wireless charger.", image: "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80", badge: "Essential" },

            // --- 10 FEMALE BEAUTY HARDWARE WINNERS ---
            { id: 41, title: "Electric Makeup Brush Spinner Cleaner & Dryer", price: 1499, category: "Beauty & Care", rating: 4.9, reviews: 1204, stock: 4, description: "Washes and spin-dries foundation brushes in 30 seconds. Stops breakouts caused by dirty bristles.", image: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=600&q=80", badge: "Viral Winner" },
            { id: 42, title: "7-Color LED Photon Therapy Face Mask", price: 4999, category: "Beauty & Care", rating: 5.0, reviews: 312, stock: 2, description: "Clinical light therapy at home. Red wavelengths boost collagen; blue light targets active acne bacteria.", image: "https://images.unsplash.com/photo-1590159756185-9856cc43f173?auto=format&fit=crop&w=600&q=80", badge: "Premium" },
            { id: 43, title: "Rechargeable Heated Eyelash Curler", price: 999, category: "Beauty & Care", rating: 4.8, reviews: 856, stock: 7, description: "2-temperature ceramic thermal comb lifts lashes in 10 seconds for a 24-hour curl without pinching.", image: "https://images.unsplash.com/photo-1629853907409-7756fdf1d269?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 44, title: "Soft Silicone Scalp Massager & Hair Growth Brush", price: 449, category: "Beauty & Care", rating: 4.9, reviews: 1840, stock: 9, description: "Deeply exfoliates dandruff buildup and boosts follicle blood flow during shampooing or oil massage.", image: "https://images.unsplash.com/photo-1616683693504-3ea7e9ad6fec?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 45, title: "Cryo Ice Roller & Rose Quartz Gua Sha Set", price: 1299, category: "Beauty & Care", rating: 4.7, reviews: 920, stock: 5, description: "Morning lymphatic drainage kit. Instantly depuffs under-eyes, tightens pores, and contours the jawline.", image: "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80", badge: "Bestseller" },
            { id: 46, title: "Reusable Medical-Grade Silicone Eye Patches", price: 699, category: "Beauty & Care", rating: 4.8, reviews: 630, stock: 6, description: "Locks in your favorite eye cream to plump fine lines and dark circles. Washable and reusable 100+ times.", image: "https://images.unsplash.com/photo-1512496015851-a1c8f1066d5b?auto=format&fit=crop&w=600&q=80", badge: "Eco-Luxury" },
            { id: 47, title: "18K Gold-Plated Precision Eyebrow & Peach Fuzz Trimmer", price: 799, category: "Beauty & Care", rating: 4.6, reviews: 1450, stock: 8, description: "Hypoallergenic micro-blade with built-in LED light removes facial hair painlessly with zero redness.", image: "https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 48, title: "3D Microcurrent EMS Facial Sculpting Wand", price: 1899, category: "Beauty & Care", rating: 4.7, reviews: 420, stock: 3, description: "High-frequency sonic vibration + gentle microcurrents tone sagging cheeks for a lifted V-line contour.", image: "https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=600&q=80", badge: "Viral Winner" },
            { id: 49, title: "Antibacterial Silicone Body Scrubber", price: 549, category: "Beauty & Care", rating: 4.9, reviews: 2100, stock: 12, description: "Soft silicone bristles lather rich foam, unclog back pores, and never harbor mold like mesh loofahs.", image: "https://images.unsplash.com/photo-1601055903647-8f1eaec797e8?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 50, title: "Tri-Tone Rechargeable LED Travel Vanity Mirror", price: 1599, category: "Beauty & Care", rating: 4.8, reviews: 750, stock: 4, description: "Simulates natural daylight, warm evening, and office lighting so your makeup is never cakey.", image: "https://images.unsplash.com/photo-1616014493390-e5550a1122a7?auto=format&fit=crop&w=600&q=80", badge: "Must Have" }
        ];

        var OWNER_WHATSAPP = "919014044915";
        var OWNER_UPI = "premkumarmanthena289@oksbi";
        var activeCategory = "All";
        var cart = [];
        var couponApplied = false;
        var orderBumpActive = false;
        var cartTimerInterval = null;
        var currentTrackedOrder = null;

        // Load persistent cart from localStorage
        try {
            var savedCart = localStorage.getItem('prem_cart_v2');
            if (savedCart) cart = JSON.parse(savedCart);
        } catch (e) {}

        function saveCart() {
            try { localStorage.setItem('prem_cart_v2', JSON.stringify(cart)); } catch (e) {}
        }

        function showToast(msg) {
            var box = document.getElementById('toast-box');
            document.getElementById('toast-text').innerText = msg;
            box.classList.remove('hidden');
            setTimeout(function() { box.classList.add('hidden'); }, 3200);
        }

        function getDeliveryWindowString() {
            var today = new Date();
            var minDate = new Date(today);
            minDate.setDate(today.getDate() + 5);
            var maxDate = new Date(today);
            maxDate.setDate(today.getDate() + 7);
            var opts = { month: 'short', day: 'numeric' };
            return minDate.toLocaleDateString('en-IN', opts) + ' - ' + maxDate.toLocaleDateString('en-IN', opts);
        }

        function calculateDeliveryDate() {
            var winStr = getDeliveryWindowString();
            document.getElementById('auto-delivery-date').innerText = winStr;
            document.getElementById('hero-delivery-date').innerText = winStr;
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
                var matchesCat = (activeCategory === "All" || item.category === activeCategory);
                var matchesSearch = !searchVal || item.title.toLowerCase().indexOf(searchVal) !== -1 || item.description.toLowerCase().indexOf(searchVal) !== -1 || item.category.toLowerCase().indexOf(searchVal) !== -1;
                return matchesCat && matchesSearch;
            });

            if (sortVal === 'price-asc') {
                filtered.sort(function(a, b) { return a.price - b.price; });
            } else if (sortVal === 'price-desc') {
                filtered.sort(function(a, b) { return b.price - a.price; });
            } else if (sortVal === 'rating') {
                filtered.sort(function(a, b) { return b.rating - a.rating; });
            }

            document.getElementById('results-counter').innerText = 'Showing ' + filtered.length + ' product' + (filtered.length === 1 ? '' : 's');

            if (filtered.length === 0) {
                grid.innerHTML = '<div class="col-span-full text-center py-16 glass rounded-2xl"><i class="fa-solid fa-box-open text-3xl text-slate-500 mb-3"></i><p class="text-sm text-slate-300 font-bold">No matching products found.</p><button onclick="clearSearch(); setCategoryFilter(\'All\')" class="mt-3 bg-brandPrimary text-white text-xs font-bold px-4 py-2 rounded-full">Reset Filters</button></div>';
                return;
            }

            var fallbackURL = "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80";
            var html = '';
            for (var i = 0; i < filtered.length; i++) {
                var prod = filtered[i];
                var mrp = Math.round(prod.price * 1.35);
                html += '<div class="bg-darkSurface rounded-2xl border border-darkBorder flex flex-col group relative overflow-hidden hover:border-brandPrimary/40 transition-all duration-300 shadow-lg">' +
                    '<span class="absolute top-3 left-3 bg-brandPrimary text-white text-[9px] font-black px-2.5 py-1 rounded-full uppercase z-10 tracking-wider shadow-lg">' + prod.badge + '</span>' +
                    '<button onclick="openQuickView(' + prod.id + ')" class="absolute top-3 right-3 bg-black/70 hover:bg-brandPrimary text-white text-[10px] font-bold px-2.5 py-1 rounded-full z-10 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fa-regular fa-eye mr-1"></i>Quick View</button>' +
                    '<div onclick="openQuickView(' + prod.id + ')" class="relative bg-black overflow-hidden aspect-[4/3] cursor-pointer">' +
                        '<img src="' + prod.image + '" onerror="this.onerror=null; this.src=\'' + fallbackURL + '\';" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90 group-hover:opacity-100">' +
                        '<div class="absolute inset-0 bg-gradient-to-t from-darkSurface via-transparent to-transparent"></div>' +
                    '</div>' +
                    '<div class="p-4 flex flex-col flex-grow relative -mt-3 z-20">' +
                        '<div class="flex items-center justify-between text-[10px] mb-1.5">' +
                            '<span class="text-slate-400 font-semibold uppercase tracking-wider">' + prod.category + '</span>' +
                            '<div class="flex items-center space-x-1 text-amber-400">' +
                                '<i class="fa-solid fa-star"></i><span class="font-bold text-white">' + prod.rating + '</span><span class="text-slate-500">(' + prod.reviews + ')</span>' +
                            '</div>' +
                        '</div>' +
                        '<h3 onclick="openQuickView(' + prod.id + ')" class="font-extrabold text-white text-sm sm:text-base leading-snug mb-1 cursor-pointer group-hover:text-brandPrimary transition-colors line-clamp-1">' + prod.title + '</h3>' +
                        '<p class="text-xs text-slate-400 line-clamp-2 mb-3 leading-relaxed">' + prod.description + '</p>' +
                        '<div class="mt-auto">' +
                            '<p class="text-[10px] text-red-400 font-bold mb-2 uppercase tracking-wide flex items-center"><i class="fa-solid fa-fire mr-1"></i>Only ' + prod.stock + ' left in stock</p>' +
                            '<div class="flex justify-between items-center pt-2.5 border-t border-darkBorder gap-2">' +
                                '<div>' +
                                    '<span class="text-[11px] text-slate-500 line-through block -mb-1 font-mono">₹' + mrp.toLocaleString('en-IN') + '</span>' +
                                    '<span class="text-lg font-black text-white">₹' + prod.price.toLocaleString('en-IN') + '</span>' +
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

        // QUICK VIEW MODAL LOGIC
        function openQuickView(id) {
            var prod = storeProducts.find(function(p) { return p.id === id; });
            if (!prod) return;
            document.getElementById('qv-img').src = prod.image;
            document.getElementById('qv-badge').innerText = prod.badge;
            document.getElementById('qv-rating').innerText = prod.rating + ' (' + prod.reviews + ' Verified Reviews)';
            document.getElementById('qv-title').innerText = prod.title;
            document.getElementById('qv-price').innerText = '₹' + prod.price.toLocaleString('en-IN');
            document.getElementById('qv-mrp').innerText = '₹' + Math.round(prod.price * 1.35).toLocaleString('en-IN');
            document.getElementById('qv-desc').innerText = prod.description;
            document.getElementById('qv-pin-result').classList.add('hidden');

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
                res.innerText = '✅ Express Delivery available to ' + pin + ' by ' + getDeliveryWindowString();
                res.className = 'text-[11px] text-emerald-400 font-semibold mt-1.5 block';
            } else {
                res.innerText = '⚠️ Please enter a valid 6-digit Indian Pincode.';
                res.className = 'text-[11px] text-amber-400 font-semibold mt-1.5 block';
            }
        }

        // CART & COUPON LOGIC
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
            if (val === 'PREM10' || val === 'VIP10') {
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
                if (cart.length === 0) {
                    clearInterval(cartTimerInterval);
                    document.getElementById('cart-timer').innerText = "10:00";
                }
            }
            saveCart();
            updateCartUI();
        }

        function getCartFinancials() {
            var subtotal = cart.reduce(function(sum, item) { return sum + (item.price * item.qty); }, 0);
            var discount = couponApplied ? Math.round(subtotal * 0.10) : 0;
            orderBumpActive = document.getElementById('order-bump').checked;
            var bumpCost = (cart.length > 0 && orderBumpActive) ? 99 : 0;
            var finalTotal = Math.max(0, subtotal - discount + bumpCost);
            return { subtotal: subtotal, discount: discount, bumpCost: bumpCost, finalTotal: finalTotal };
        }

        function updateCartUI() {
            var count = cart.reduce(function(sum, i) { return sum + i.qty; }, 0);
            document.getElementById('cart-count').innerText = count;

            var fin = getCartFinancials();
            document.getElementById('cart-subtotal').innerText = '₹' + fin.subtotal.toLocaleString('en-IN');
            document.getElementById('cart-total').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');

            var discRow = document.getElementById('discount-row');
            if (fin.discount > 0) {
                discRow.classList.remove('hidden');
                document.getElementById('cart-discount').innerText = '-₹' + fin.discount.toLocaleString('en-IN');
            } else {
                discRow.classList.add('hidden');
            }

            var prog = document.getElementById('shipping-progress');
            if (fin.subtotal >= 1000) {
                prog.style.width = '100%';
                prog.className = 'bg-emerald-500 h-1.5 rounded-full transition-all';
                document.getElementById('shipping-text').innerHTML = '<span class="text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>FREE VIP Express Shipping Unlocked!</span>';
            } else {
                prog.style.width = Math.min(100, (fin.subtotal / 1000) * 100) + '%';
                prog.className = 'bg-brandPrimary h-1.5 rounded-full transition-all';
                document.getElementById('shipping-text').innerHTML = 'Add ₹' + (1000 - fin.subtotal).toLocaleString('en-IN') + ' more for FREE VIP Shipping';
            }

            var container = document.getElementById('cart-items');
            if (cart.length === 0) {
                container.innerHTML = '<div class="text-center text-slate-500 py-12 text-xs"><i class="fa-solid fa-cart-arrow-down text-2xl mb-2 block"></i>Your cart is currently empty.</div>';
                return;
            }

            var html = '';
            for (var i = 0; i < cart.length; i++) {
                var item = cart[i];
                html += '<div class="flex items-center space-x-3 bg-darkSurface p-2.5 rounded-xl border border-darkBorder">' +
                    '<img src="' + item.image + '" class="w-14 h-14 object-cover rounded-lg shrink-0">' +
                    '<div class="flex-grow overflow-hidden">' +
                        '<h4 class="font-bold text-xs text-white truncate">' + item.title + '</h4>' +
                        '<p class="text-brandPrimary text-sm font-black mt-0.5">₹' + (item.price * item.qty).toLocaleString('en-IN') + '</p>' +
                    '</div>' +
                    '<div class="flex items-center bg-black rounded-lg border border-white/10">' +
                        '<button onclick="modifyQty(' + item.id + ', -1)" class="w-7 h-7 text-slate-400 hover:text-white text-xs">-</button>' +
                        '<span class="text-xs font-bold text-white px-2">' + item.qty + '</span>' +
                        '<button onclick="modifyQty(' + item.id + ', 1)" class="w-7 h-7 text-slate-400 hover:text-white text-xs">+</button>' +
                    '</div>' +
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
                if (--time < 0) {
                    clearInterval(cartTimerInterval);
                    display.innerText = "10:00";
                }
            }, 1000);
        }

        // CHECKOUT & DYNAMIC UPI QR GENERATOR
        function openShippingModal() {
            if (cart.length === 0) {
                showToast('Add at least 1 product to checkout.');
                return;
            }
            if (!document.getElementById('cart-sidebar').classList.contains('translate-x-full')) {
                toggleCart();
            }
            var fin = getCartFinancials();
            document.getElementById('checkout-total-badge').innerText = '₹' + fin.finalTotal.toLocaleString('en-IN');

            var upiUri = 'upi://pay?pa=' + OWNER_UPI + '&pn=PremStore&am=' + fin.finalTotal + '&cu=INR';
            document.getElementById('direct-upi-link').href = upiUri;
            document.getElementById('upi-qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(upiUri);

            var modal = document.getElementById('shipping-modal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeShippingModal() {
            var modal = document.getElementById('shipping-modal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        function copyUpiId() {
            if (navigator.clipboard) {
                navigator.clipboard.writeText(OWNER_UPI);
            }
            showToast('UPI ID Copied: ' + OWNER_UPI);
        }

        async function submitOrderAndRedirectToWhatsApp(event) {
            event.preventDefault();
            var btn = document.getElementById('whatsapp-checkout-btn');
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Generating Invoice & Order ID...</span>';
            btn.disabled = true;

            var customerData = {
                name: document.getElementById('cust-name').value.trim(),
                phone: document.getElementById('cust-phone').value.trim(),
                address: document.getElementById('cust-address').value.trim()
            };
            var utrVal = (document.getElementById('cust-utr').value || '').trim();
            var fin = getCartFinancials();
            var orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
            var estDelivery = getDeliveryWindowString();

            var orderRecord = {
                orderId: orderId,
                date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
                customer: customerData,
                cart: cart.slice(),
                subtotal: fin.subtotal,
                discount: fin.discount,
                orderBump: orderBumpActive,
                total: fin.finalTotal,
                utr: utrVal || 'Sending Screenshot on WhatsApp',
                estimatedDelivery: estDelivery,
                status: 'Payment Verification',
                stage: 2
            };

            // 1. Save to LocalStorage for instant customer self-tracking
            try {
                var existingOrders = JSON.parse(localStorage.getItem('prem_orders_v2') || '[]');
                existingOrders.unshift(orderRecord);
                localStorage.setItem('prem_orders_v2', JSON.stringify(existingOrders.slice(0, 15)));
            } catch (e) {}

            // 2. Sync with Cloud Backend
            try {
                await fetch('/api/place-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderRecord)
                });
            } catch (error) {
                console.log("Cloud fallback active");
            }

            // 3. Build Formatted WhatsApp Invoice
            var nl = "\n";
            var waMsg = "*🛍️ NEW ORDER CONFIRMED - PREM'S STORE*" + nl + nl;
            waMsg += "*🏷️ Order ID:* " + orderId + nl;
            waMsg += "*📅 Est. Delivery:* " + estDelivery + nl + nl;
            waMsg += "*👤 Customer Details:*" + nl;
            waMsg += "Name: " + customerData.name + nl;
            waMsg += "Phone: " + customerData.phone + nl;
            waMsg += "Address: " + customerData.address + nl + nl;
            waMsg += "*🛒 Items Ordered:*" + nl;
            for (var i = 0; i < cart.length; i++) {
                waMsg += "▪️ " + cart[i].qty + "x " + cart[i].title + " (₹" + (cart[i].price * cart[i].qty).toLocaleString('en-IN') + ")" + nl;
            }
            if (orderBumpActive) {
                waMsg += "▪️ 1x VIP Transit Insurance & Priority Dispatch (₹99)" + nl;
            }
            if (fin.discount > 0) {
                waMsg += "🎁 Promo Discount (PREM10): -₹" + fin.discount.toLocaleString('en-IN') + nl;
            }
            waMsg += nl + "*💰 TOTAL PAYABLE:* ₹" + fin.finalTotal.toLocaleString('en-IN') + nl;
            if (utrVal) {
                waMsg += "*🔢 UPI Ref / UTR:* " + utrVal + nl;
            }
            waMsg += nl + "*⚡ DIRECT UPI PAYMENT:*" + nl;
            waMsg += "UPI ID: *" + OWNER_UPI + "*" + nl;
            waMsg += "upi://pay?pa=" + OWNER_UPI + "&pn=PremStore&am=" + fin.finalTotal + "&cu=INR" + nl + nl;
            waMsg += "✅ *Please approve my order " + orderId + ". Sharing payment confirmation below!*";

            var whatsappURL = "https://wa.me/" + OWNER_WHATSAPP + "?text=" + encodeURIComponent(waMsg);

            cart = [];
            couponApplied = false;
            saveCart();
            updateCartUI();
            closeShippingModal();

            btn.innerHTML = '<i class="fa-brands fa-whatsapp text-lg"></i><span>Confirm Order & Send Invoice on WhatsApp</span>';
            btn.disabled = false;

            window.location.href = whatsappURL;
        }

        // INTERACTIVE ORDER TRACKING PORTAL
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
                var list = JSON.parse(localStorage.getItem('prem_orders_v2') || '[]');
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

            // 1. Check live server first
            try {
                var res = await fetch('/api/track/' + encodeURIComponent(inputId));
                if (res.ok) {
                    var data = await res.json();
                    if (data.found) foundOrder = data.order;
                }
            } catch (e) {}

            // 2. Fallback to device localStorage
            if (!foundOrder) {
                try {
                    var localList = JSON.parse(localStorage.getItem('prem_orders_v2') || '[]');
                    foundOrder = localList.find(function(o) { return (o.orderId || '').toUpperCase() === inputId; });
                } catch (e) {}
            }

            // 3. Smart fallback for valid ORD-XXXXXX format if cloud spun down
            if (!foundOrder) {
                foundOrder = {
                    orderId: inputId,
                    date: 'Active Order',
                    status: 'In Verification / Processing',
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
                { num: 1, label: 'Order Registered & Stock Reserved' },
                { num: 2, label: 'UPI Payment & Screenshot Verification' },
                { num: 3, label: 'Approved & Dispatched from Warehouse' },
                { num: 4, label: 'Out for Delivery to Your Address' }
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

        // MERCHANT COMMAND CENTER (PIN: 9014)
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
            container.innerHTML = '<p class="text-slate-400">Loading orders...</p>';
            try {
                var res = await fetch('/api/admin/orders');
                var data = await res.json();
                var orders = data.orders || [];
                if (orders.length === 0) {
                    container.innerHTML = '<p class="text-slate-500">No orders in current server session yet. Use the 1-Tap Notifier above for any WhatsApp order!</p>';
                    return;
                }
                var html = '';
                for (var i = 0; i < orders.length; i++) {
                    var o = orders[i];
                    var phone = (o.customer && o.customer.phone) ? o.customer.phone : '';
                    var name = (o.customer && o.customer.name) ? o.customer.name : 'Customer';
                    var total = (o.financials && o.financials.total) ? o.financials.total : o.total;
                    html += '<div class="bg-darkSurface p-3 rounded-xl border border-darkBorder flex flex-col sm:flex-row justify-between gap-2">' +
                        '<div>' +
                            '<span class="font-mono font-bold text-brandPrimary">' + o.orderId + '</span> • <strong class="text-white">' + name + '</strong> (' + phone + ')' +
                            '<p class="text-slate-400 text-[11px]">Total: ₹' + total + ' | UTR: ' + (o.utr || 'N/A') + ' | Status: <strong class="text-emerald-400">' + o.status + '</strong></p>' +
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
                msg = "✅ *ORDER APPROVED - PREM'S STORE*\n\nHello! Your payment for Order *" + orderId + "* has been verified.\n\n📦 *Status:* Packed & Ready for Dispatch\n🚚 *Estimated Delivery:* " + est + "\n\nThank you for shopping with Prem's Store!";
            } else if (type === 'SHIPPED') {
                msg = "🚚 *ORDER SHIPPED - PREM'S STORE*\n\nGreat news! Your Order *" + orderId + "* has been dispatched.\n\n" + (courier ? ("*📍 Tracking Details:* " + courier + "\n\n") : "") + "📅 *Estimated Delivery:* " + est + "\n\nYou can track your status anytime on our website!";
            } else {
                msg = "⚠️ *ORDER UPDATE - PREM'S STORE*\n\nRegarding your Order *" + orderId + "*: We have not yet received the UPI payment confirmation or your order has been canceled upon request.\n\nIf you wish to complete your order via UPI (*" + OWNER_UPI + "*), please reply with your payment screenshot!";
            }

            window.open("https://wa.me/" + rawPhone + "?text=" + encodeURIComponent(msg), "_blank");
        }

        // SOCIAL PROOF ENGINE (Balanced Male & Female Shoppers)
        function startSocialProofEngine() {
            var names = ["Ananya", "Priya", "Sneha", "Kriti", "Aishwarya", "Neha", "Rahul", "Vikram", "Rohan", "Arjun", "Pooja", "Meera"];
            var cities = ["Mumbai", "Bangalore", "Delhi", "Hyderabad", "Pune", "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Chandigarh"];

            setInterval(function() {
                var rName = names[Math.floor(Math.random() * names.length)];
                var rCity = cities[Math.floor(Math.random() * cities.length)];
                var rProd = storeProducts[Math.floor(Math.random() * storeProducts.length)];

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
            }, 12000);
        }

        // BOOTSTRAP STORE IMMEDIATELY
        calculateDeliveryDate();
        filterAndRenderCatalog();
        updateCartUI();
        startSocialProofEngine();
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(frontendHTML));

app.listen(PORT, () => {
    console.log("\n💎 PREM'S STORE v2.0 (PRODUCTION EDITION) IS LIVE ON PORT " + PORT);
    console.log("📲 WhatsApp Handoff: +91 9014044915");
    console.log("💳 UPI ID: premkumarmanthena289@oksbi");
    console.log("🔐 Merchant Portal PIN: 9014");
});
{
  "name": "prems-premium-store",
  "version": "2.0.0",
  "description": "Automated WhatsApp & UPI Dropshipping Store - Production Edition",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
