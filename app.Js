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

// In-Memory Cloud Fallback Store 
let memoryOrders = [];

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
    console.log("Cloud Read-Only Mode active. Using RAM storage.");
}

function saveOrdersToDisk() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ orders: memoryOrders }, null, 4));
    } catch (e) {}
}

// 1. PLACE ORDER API
app.post('/api/place-order', (req, res) => {
    try {
        const { orderId, customer, cart, subtotal, discount, orderBump, total, estimatedDelivery } = req.body;
        const finalOrderId = orderId || ('ORD-' + Math.floor(100000 + Math.random() * 900000));
        
        const newOrder = {
            orderId: finalOrderId,
            date: new Date().toISOString(),
            customer: customer || {},
            cart: cart || [],
            financials: { subtotal, discount, orderBumpAdded: orderBump, total },
            estimatedDelivery: estimatedDelivery || '5-7 Business Days',
            status: 'Payment Verification',
            stage: 2,
            courierInfo: ''
        };

        memoryOrders.unshift(newOrder);
        saveOrdersToDisk();
        console.log("\n📲 [NEW ORDER] " + finalOrderId + " | Total: ₹" + total);
        res.status(200).json({ success: true, order: newOrder });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// 2. TRACK ORDER API
app.get('/api/track/:orderId', (req, res) => {
    try {
        const searchId = (req.params.orderId || '').trim().toUpperCase();
        const found = memoryOrders.find(o => o.orderId.toUpperCase() === searchId);
        if (found) return res.status(200).json({ found: true, order: found });
        return res.status(404).json({ found: false });
    } catch (err) {
        res.status(500).json({ found: false });
    }
});

// 3. ADMIN API
app.get('/api/admin/orders', (req, res) => res.status(200).json({ orders: memoryOrders }));

app.post('/api/admin/update-order', (req, res) => {
    try {
        const { pin, orderId, status, stage, courierInfo } = req.body;
        if (pin !== '9014') return res.status(403).json({ success: false, message: 'Invalid PIN' });
        
        const order = memoryOrders.find(o => o.orderId.toUpperCase() === (orderId || '').toUpperCase());
        if (!order) return res.status(404).json({ success: false, message: 'Not found' });
        
        if (status) order.status = status;
        if (stage) order.stage = Number(stage);
        if (courierInfo !== undefined) order.courierInfo = courierInfo;
        
        saveOrdersToDisk();
        res.status(200).json({ success: true, order });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// FRONTEND APPLICATION 
const frontendHTML = String.raw`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prem's Store | Problem-Solving Gadgets & Beauty Tools in India</title>
    <meta name="description" content="Shop viral problem-solvers, premium beauty hardware, and monsoon utility gear. Fast delivery across India with secure 0-fee UPI checkout.">
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
        .glass { background: rgba(18, 18, 21, 0.95); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.07); }
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

    <!-- ANNOUNCEMENT BAR -->
    <div class="bg-gradient-to-r from-brandPrimary via-pink-600 to-rose-600 text-white text-[11px] md:text-xs font-bold py-2 px-4 text-center z-50">
        ⚡ FLASH SALE: 10% OFF with code <strong class="underline cursor-pointer bg-black/25 px-1.5 py-0.5 rounded" onclick="applyQuickCoupon('PREM10')">PREM10</strong> + Free VIP Delivery above ₹1,000!
    </div>

    <!-- TOAST -->
    <div id="toast-box" class="fixed top-14 right-4 z-[100] hidden bg-white text-black px-4 py-3 rounded-xl shadow-2xl border-l-4 border-brandPrimary text-xs font-bold items-center space-x-2 transition-all">
        <i class="fa-solid fa-circle-check text-brandPrimary text-base"></i>
        <span id="toast-text">Action completed</span>
    </div>

    <!-- HEADER -->
    <header class="sticky top-0 z-40 glass border-b border-white/10 shadow-lg">
        <div class="container mx-auto px-4 py-3.5 flex flex-wrap justify-between items-center gap-3 max-w-7xl">
            <a href="#" onclick="setCategoryFilter('All'); return false;" class="text-2xl font-black tracking-tighter text-white flex items-center">
                PREM<span class="text-brandPrimary">STORE</span>
                <span class="ml-2 text-[9px] bg-white/10 text-slate-300 px-2 py-0.5 rounded-full font-bold uppercase tracking-widest hidden sm:inline-block">Verified</span>
            </a>

            <div class="relative flex-grow max-w-md order-3 md:order-2 w-full md:w-auto">
                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input type="text" id="search-input" oninput="filterAndRenderCatalog()" placeholder="Search viral problem solvers..." class="w-full pl-9 pr-8 py-2 bg-darkSurface border border-darkBorder rounded-full text-xs text-white outline-none focus:border-brandPrimary transition-colors">
            </div>

            <div class="flex items-center space-x-2.5 order-2 md:order-3">
                <button onclick="openTrackModal()" class="flex items-center space-x-1.5 text-xs font-bold text-slate-200 hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-3.5 py-2 rounded-full border border-white/10">
                    <i class="fa-solid fa-truck-fast text-brandPrimary"></i><span>Track Order</span>
                </button>
                <button onclick="toggleCart()" class="relative flex items-center space-x-2 bg-brandPrimary/15 hover:bg-brandPrimary/25 px-4 py-2 rounded-full transition-all border border-brandPrimary/40">
                    <i class="fa-solid fa-bag-shopping text-brandPrimary"></i>
                    <span class="text-xs font-bold text-white hidden sm:inline">Cart</span>
                    <span id="cart-count" class="bg-brandPrimary text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-black shadow">0</span>
                </button>
            </div>
        </div>
    </header>

    <!-- HERO & FILTERS -->
    <main class="container mx-auto px-4 py-8 flex-grow max-w-7xl">
        <div class="flex flex-col items-center text-center mb-8">
            <h1 class="text-3xl md:text-5xl font-black text-white mb-3 tracking-tight">Viral Problem-Solvers. Delivered Fast.</h1>
            <p class="text-slate-400 max-w-xl text-xs md:text-sm">Secure 0-fee UPI checkout & live WhatsApp support.</p>
        </div>

        <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 mb-7 pb-3 border-b border-white/5">
            <div class="flex items-center space-x-2 overflow-x-auto hide-scrollbar py-1" id="category-buttons">
                <button data-cat="All" onclick="setCategoryFilter('All')" class="cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold shadow-glow transition-all whitespace-nowrap">All Products</button>
                <button data-cat="Beauty & Care" onclick="setCategoryFilter('Beauty & Care')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">✨ Beauty</button>
                <button data-cat="Home" onclick="setCategoryFilter('Home')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🏠 Home Hacks</button>
                <button data-cat="Gear" onclick="setCategoryFilter('Gear')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">⚡ Utility</button>
                <button data-cat="Vehicle" onclick="setCategoryFilter('Vehicle')" class="cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap">🚗 Vehicle</button>
            </div>
        </div>

        <div id="product-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"></div>
    </main>

    <!-- QUICK VIEW MODAL (WITH GALLERY) -->
    <div id="quickview-modal" class="fixed inset-0 z-[70] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4">
        <div class="glass rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl border border-white/10 relative grid md:grid-cols-2 max-h-[95vh] overflow-y-auto hide-scrollbar">
            <button onclick="closeQuickView()" class="absolute top-3 right-3 z-30 w-8 h-8 rounded-full bg-black/70 border border-white/10 text-white hover:bg-brandPrimary flex items-center justify-center transition-colors"><i class="fa-solid fa-xmark"></i></button>
            
            <div class="bg-black aspect-square md:aspect-auto md:h-full relative group flex flex-col">
                <div class="flex-grow relative overflow-hidden">
                    <img id="qv-img" src="" class="w-full h-full object-cover transition-opacity duration-300">
                    <span id="qv-badge" class="absolute top-4 left-4 bg-brandPrimary text-white text-[10px] font-black px-3 py-1 rounded-full uppercase z-20 shadow-lg"></span>
                    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none"></div>
                </div>
                <!-- Thumbnails Container -->
                <div id="qv-thumbnails" class="absolute bottom-4 left-0 right-0 flex justify-center space-x-2 px-4 z-20 overflow-x-auto hide-scrollbar"></div>
            </div>

            <div class="p-6 md:p-8 flex flex-col justify-between bg-darkSurface">
                <div>
                    <div class="flex items-center space-x-1 text-amber-400 text-[11px] mb-3">
                        <i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star"></i><i class="fa-solid fa-star-half-stroke"></i>
                        <span id="qv-rating" class="font-bold text-white ml-1"></span>
                    </div>
                    <h3 id="qv-title" class="text-2xl font-black text-white mb-2 leading-tight"></h3>
                    <div class="flex items-baseline space-x-2 mb-4">
                        <span id="qv-price" class="text-3xl font-black text-brandPrimary drop-shadow-[0_0_8px_rgba(255,51,102,0.3)]"></span>
                        <span id="qv-mrp" class="text-sm text-slate-500 line-through font-mono"></span>
                    </div>
                    <p id="qv-desc" class="text-sm text-slate-300 leading-relaxed mb-6"></p>

                    <div class="bg-black/40 p-4 rounded-xl border border-white/5 mb-6">
                        <label class="text-[10px] font-bold text-slate-400 uppercase block mb-2">Check Fast Delivery</label>
                        <div class="flex space-x-2">
                            <input type="text" id="qv-pincode" maxlength="6" placeholder="Enter Pincode" class="w-full bg-darkSurface border border-darkBorder rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-brandPrimary">
                            <button onclick="checkPincode()" class="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2 rounded-lg shrink-0 transition-colors">Check</button>
                        </div>
                        <p id="qv-pin-result" class="text-[11px] text-emerald-400 font-semibold mt-2 hidden"></p>
                    </div>
                </div>

                <div class="space-y-3 mt-4">
                    <button id="qv-add-btn" class="w-full bg-white/5 hover:bg-white/15 border border-white/10 text-white font-bold py-3.5 rounded-xl text-xs uppercase tracking-wider transition-all">Add to Cart</button>
                    <button id="qv-buy-btn" class="w-full bg-brandPrimary text-white font-black py-4 rounded-xl btn-glow text-sm uppercase tracking-wider shadow-lg">Buy Now • Secure Checkout</button>
                </div>
            </div>
        </div>
    </div>

    <!-- CART SIDEBAR -->
    <div id="cart-sidebar" class="fixed inset-y-0 right-0 z-50 w-full max-w-md glass shadow-2xl transform translate-x-full transition-transform duration-300 flex flex-col border-l border-white/10">
        <div class="p-4 flex justify-between items-center border-b border-white/10 bg-black/50">
            <h3 class="text-lg font-black text-white flex items-center"><i class="fa-solid fa-lock text-brandPrimary mr-2 text-sm"></i> Reserved Cart</h3>
            <button onclick="toggleCart()" class="text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
        </div>
        
        <div class="p-3.5 border-b border-white/5 bg-darkSurface">
            <div class="flex justify-between text-[11px] font-bold mb-1.5 text-slate-300" id="shipping-text">Add ₹1,000 for FREE VIP Shipping</div>
            <div class="w-full bg-black rounded-full h-1.5 border border-white/5 overflow-hidden">
                <div id="shipping-progress" class="bg-brandPrimary h-1.5 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
        </div>

        <div id="cart-items" class="flex-grow p-4 overflow-y-auto space-y-3"></div>

        <div class="p-5 bg-black/90 border-t border-white/10 space-y-3">
            <div class="flex space-x-2">
                <input type="text" id="coupon-input" placeholder="Promo code" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3 py-2 text-xs text-white uppercase outline-none focus:border-brandPrimary">
                <button onclick="applyCouponInput()" class="bg-white/10 hover:bg-white/20 text-white font-bold px-4 py-2 rounded-xl text-xs shrink-0">Apply</button>
            </div>
            
            <label class="flex items-start space-x-3 bg-brandPrimary/10 border border-brandPrimary/30 p-3 rounded-xl cursor-pointer hover:bg-brandPrimary/15 transition-colors">
                <input type="checkbox" id="order-bump" onchange="updateCartUI()" class="w-4 h-4 mt-0.5 accent-brandPrimary cursor-pointer">
                <div class="text-xs">
                    <div class="font-bold text-white flex justify-between">
                        <span>VIP Transit Insurance & Dispatch</span>
                        <span class="text-brandPrimary font-black ml-2">+₹99</span>
                    </div>
                </div>
            </label>
            
            <div class="space-y-1 text-xs pt-1">
                <div class="flex justify-between text-slate-400"><span>Subtotal:</span><span id="cart-subtotal">₹0</span></div>
                <div id="discount-row" class="flex justify-between text-emerald-400 font-bold hidden"><span>Discount (10%):</span><span id="cart-discount">-₹0</span></div>
                <div class="flex justify-between text-xl font-black text-white border-t border-white/10 pt-2"><span>Total Payable:</span><span id="cart-total" class="text-brandPrimary">₹0</span></div>
            </div>
            <button onclick="openShippingModal()" class="w-full bg-brandPrimary text-white font-black py-3.5 rounded-xl btn-glow flex items-center justify-center space-x-2 uppercase text-xs tracking-wider mt-2">
                <span>Proceed to Secure Checkout</span><i class="fa-solid fa-arrow-right"></i>
            </button>
        </div>
    </div>

    <!-- SHIPPING MODAL (BULLETPROOF P2P FIX) -->
    <div id="shipping-modal" class="fixed inset-0 z-[75] bg-black/90 backdrop-blur-md hidden items-center justify-center p-3 sm:p-4 overflow-y-auto">
        <div class="glass rounded-2xl w-full max-w-lg p-5 sm:p-7 shadow-2xl relative border border-white/15 my-auto">
            <button onclick="closeShippingModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>

            <div class="flex items-center space-x-2 text-brandPrimary text-xs font-bold uppercase tracking-wider mb-1">
                <i class="fa-solid fa-shield-halved"></i><span>Step 1: Delivery Details</span>
            </div>
            <h3 class="text-xl sm:text-2xl font-black text-white mb-4">Complete Your Order</h3>

            <form id="shipping-form" onsubmit="submitOrderAndRedirectToWhatsApp(event)" class="space-y-3.5">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input type="text" id="cust-name" placeholder="Full Name *" required class="w-full px-3.5 py-3 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary">
                    <input type="tel" id="cust-phone" placeholder="WhatsApp Number *" required pattern="[0-9+ ]{10,15}" class="w-full px-3.5 py-3 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary">
                </div>
                <textarea id="cust-address" placeholder="Full Address & 6-Digit Pincode *" required rows="3" class="w-full px-3.5 py-2.5 bg-darkSurface border border-darkBorder rounded-xl text-xs text-white outline-none focus:border-brandPrimary"></textarea>

                <div class="bg-darkSurface border border-white/10 rounded-2xl p-4 space-y-3 shadow-inner">
                    <div class="flex justify-between items-center border-b border-white/10 pb-2.5">
                        <div>
                            <span class="text-[11px] text-slate-400 block">Total Amount to Pay</span>
                            <span id="checkout-total-badge" class="text-2xl font-black text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,0.3)]">₹0</span>
                        </div>
                        <div class="text-right">
                            <span class="text-[10px] bg-emerald-500/15 text-emerald-400 px-2.5 py-1 rounded-full font-bold border border-emerald-500/30">0% Gateway Fee</span>
                        </div>
                    </div>

                    <div class="space-y-3 pt-1">
                        <p class="text-[11px] text-slate-300 leading-relaxed"><strong class="text-white">Secure Zero-Fee Payment:</strong> Copy our verified UPI ID and pay via GPay, PhonePe, or Paytm. Tap the green button below to send your invoice and payment screenshot!</p>
                        
                        <div class="flex items-center justify-between bg-black/80 border border-white/20 rounded-xl px-3 py-3 text-xs">
                            <span class="text-emerald-400 font-mono font-bold truncate mr-2 text-sm tracking-wide" id="upi-id-display">premkumarmanthena289@oksbi</span>
                            <button type="button" id="copy-upi-btn" onclick="copyUpiIdAnim()" class="bg-white/10 hover:bg-white/20 text-white font-bold px-3 py-2 rounded-lg text-[11px] shrink-0 transition-all border border-white/10 flex items-center shadow-lg">
                                <i class="fa-regular fa-copy mr-1"></i>Copy ID
                            </button>
                        </div>
                    </div>
                </div>

                <button type="submit" id="whatsapp-checkout-btn" class="w-full bg-whatsapp hover:bg-[#20bd5a] text-black font-black py-4 rounded-xl btn-glow-whatsapp tracking-wide uppercase text-xs sm:text-sm flex justify-center items-center space-x-2 mt-2 transition-all">
                    <i class="fa-brands fa-whatsapp text-xl"></i>
                    <span>Step 2: Send Invoice on WhatsApp</span>
                </button>
            </form>
        </div>
    </div>
    
    <!-- TRACKING MODAL -->
    <div id="track-modal" class="fixed inset-0 z-[80] bg-black/90 backdrop-blur-md hidden items-center justify-center p-4">
         <div class="glass rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
            <button onclick="closeTrackModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
            <h3 class="text-xl font-black text-white mb-4">Track Order</h3>
            
            <div id="recent-orders-box" class="mb-4 hidden">
                <p class="text-[10px] font-bold uppercase text-slate-400 mb-1.5">Recent Orders on This Device:</p>
                <div id="recent-orders-list" class="flex flex-wrap gap-1.5"></div>
            </div>

            <form onsubmit="lookupOrderStatus(event)" class="flex space-x-2 mb-4">
                <input type="text" id="track-order-id" placeholder="Enter Order ID" required class="w-full px-3 py-2 bg-darkSurface border border-darkBorder rounded-xl text-xs font-mono text-white outline-none">
                <button type="submit" class="bg-brandPrimary text-white font-bold px-4 py-2 rounded-xl text-xs">Track</button>
            </form>
            
            <div id="track-result-card" class="hidden bg-darkSurface rounded-xl p-4 border border-white/10 text-xs">
                <div class="flex justify-between items-start border-b border-white/10 pb-3 mb-3">
                    <div>
                        <span id="trk-id" class="font-mono font-black text-sm text-brandPrimary"></span>
                    </div>
                    <span id="trk-badge" class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300"></span>
                </div>
                <div class="space-y-2.5 text-xs" id="trk-steps"></div>
                <button type="button" onclick="pingWhatsAppForTracking()" class="w-full bg-whatsapp text-black font-bold py-2 rounded-lg mt-4 flex items-center justify-center"><i class="fa-brands fa-whatsapp mr-2"></i> Get Live Courier Link</button>
            </div>
         </div>
    </div>

    <!-- FOOTER & ADMIN PORTAL -->
    <footer class="border-t border-white/10 bg-black/60 py-8 px-4 mt-16 text-xs text-slate-500">
        <div class="container mx-auto max-w-7xl flex justify-between items-center">
            <span class="font-black text-white text-base">PREM<span class="text-brandPrimary">STORE</span></span>
            <button onclick="document.getElementById('admin-modal').style.display='flex'" class="hover:text-brandPrimary transition-colors flex items-center space-x-1"><i class="fa-solid fa-lock text-[10px]"></i><span>Merchant Panel</span></button>
        </div>
    </footer>
    <div id="admin-modal" style="display:none" class="fixed inset-0 z-[90] bg-black/95 backdrop-blur-md items-center justify-center p-4">
        <div class="glass rounded-2xl w-full max-w-2xl p-6 shadow-2xl relative">
             <button onclick="document.getElementById('admin-modal').style.display='none'" class="absolute top-4 right-4 text-white w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
             <h3 class="text-xl font-black text-white mb-4">Merchant Command Center</h3>
             <input type="password" id="admin-pin-input" placeholder="PIN (Default 9014)" class="w-full bg-darkSurface border border-darkBorder rounded-xl px-3 py-2 text-white mb-4">
             <button onclick="unlockAdminPanel()" id="admin-unlock-btn" class="bg-brandPrimary text-white font-bold px-4 py-2 rounded-xl text-xs w-full">Unlock</button>
             
             <div id="admin-content" style="display:none;" class="mt-4">
                 <div class="flex justify-between items-center mb-2">
                     <h4 class="text-xs font-bold uppercase text-slate-400">Live Orders</h4>
                     <button onclick="loadAdminOrders()" class="text-xs text-brandPrimary"><i class="fa-solid fa-rotate mr-1"></i>Refresh</button>
                 </div>
                 <div id="admin-orders-list" class="space-y-2 text-xs overflow-y-auto max-h-64"></div>
             </div>
        </div>
    </div>

    <script>
        // FULL CATALOG WITH GALLERIES
        var storeProducts = [
            { id: 1, title: "Foldable Hot Air Clothes Drying Bag", price: 3339, category: "Home", rating: 4.9, reviews: 412, stock: 3, description: "The ultimate indoor laundry drying solution for home and travel. Attaches to any hair dryer.", image: "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80", gallery: ["https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80", "https://images.unsplash.com/photo-1584473457409-ae5c91d7d8b1?auto=format&fit=crop&w=600&q=80"], badge: "Top Seller" },
            { id: 2, title: "Inverted Reverse LED Umbrella", price: 1069, category: "Gear", rating: 4.9, reviews: 142, stock: 5, description: "Folds inside-out to trap rainwater inside so your car stays dry. Built-in LED flashlight.", image: "https://images.unsplash.com/photo-1559827260-36fa90744fb5?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 3, title: "Portable Mini Dehumidifier", price: 1999, category: "Home", rating: 4.9, reviews: 84, stock: 2, description: "Eliminates closet dampness, musty odors, and mold.", image: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 4, title: "Anti-Fog Helmet Visor Film", price: 539, category: "Vehicle", rating: 4.9, reviews: 230, stock: 7, description: "Clear nano-adhesive shield. Prevents fogging from breath and rain.", image: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 5, title: "Hydrophobic Side Mirror Film", price: 339, category: "Vehicle", rating: 4.6, reviews: 67, stock: 4, description: "Nano-coating prevents car mirrors from holding water droplets.", image: "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 6, title: "Electric Hot Air Clothes Hanger", price: 2539, category: "Home", rating: 4.9, reviews: 154, stock: 2, description: "Portable travel hanger with dual hot/cold airflow vents.", image: "https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=600&q=80", gallery: ["https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=600&q=80"], badge: "Top Seller" },
            { id: 7, title: "Waterproof Laptop Backpack Cover", price: 399, category: "Gear", rating: 4.8, reviews: 175, stock: 6, description: "High-density nylon elastic shield keeps laptops 100% dry.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 8, title: "Full-Body Scooter Rain Poncho", price: 869, category: "Vehicle", rating: 4.7, reviews: 110, stock: 4, description: "Heavy-duty hooded rain suit featuring a transparent visor cutout.", image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 9, title: "Heavy-Duty Motorcycle Rain Cover", price: 669, category: "Vehicle", rating: 4.7, reviews: 142, stock: 3, description: "UV and silver-coated waterproof cover shielding parked two-wheelers.", image: "https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 10, title: "Rapid-Absorb Travel Towel", price: 599, category: "Gear", rating: 4.7, reviews: 119, stock: 8, description: "Soaks up 4x its weight in water and wrings out dry.", image: "https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 11, title: "Magic Microfiber Cleaning Towels (3 Pk)", price: 139, category: "Home", rating: 4.8, reviews: 512, stock: 5, description: "Ultra-absorbent lint-free cloths.", image: "https://images.unsplash.com/photo-1628177142898-93e46e48c58a?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 12, title: "Reusable PVC Rain Shoe Covers", price: 189, category: "Footwear", rating: 4.6, reviews: 289, stock: 4, description: "Foldable waterproof zipper shoe covers with reinforced anti-slip tread.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 13, title: "Anti-Mosquito Herbal Patches (72 Pc)", price: 139, category: "Gear", rating: 4.9, reviews: 834, stock: 9, description: "100% natural citronella oil patches. Stick on clothes to repel mosquitoes.", image: "https://images.unsplash.com/photo-1577717903315-1691ae25ab3f?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 14, title: "Silicone Anti-Clog Drain Strainer", price: 95, category: "Home", rating: 4.7, reviews: 145, stock: 7, description: "Suction-cup flexible silicone trap. Prevents hair and debris from clogging.", image: "https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 15, title: "Universal Waterproof Phone Pouch", price: 269, category: "Gear", rating: 4.7, reviews: 312, stock: 5, description: "IPX8 certified touch-sensitive dry bag.", image: "https://images.unsplash.com/photo-1588693821035-430b1ba8fc58?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 16, title: "Multi-Angle Aluminum Phone Stand", price: 119, category: "Gear", rating: 4.8, reviews: 420, stock: 3, description: "Foldable desktop dock.", image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 17, title: "Waterproof Travel Cable Organizer", price: 239, category: "Gear", rating: 4.7, reviews: 198, stock: 4, description: "Cushioned tech pouch that shields electronics.", image: "https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 18, title: "Pocket Raincoat Keyring Ball", price: 95, category: "Gear", rating: 4.5, reviews: 620, stock: 8, description: "Emergency poncho packed inside a compact keychain sphere.", image: "https://images.unsplash.com/photo-1508873696983-2df515122519?auto=format&fit=crop&w=600&q=80", badge: "Steal Deal" },
            { id: 19, title: "Silicone Door Bottom Seal Strip", price: 169, category: "Home", rating: 4.6, reviews: 180, stock: 6, description: "Blocks rainwater, dust, insects, and AC drafts.", image: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 20, title: "Waterproof LED Runner Shoe Clip", price: 189, category: "Gear", rating: 4.8, reviews: 115, stock: 4, description: "High-visibility heel safety light clip.", image: "https://images.unsplash.com/photo-1511556532299-8f662fc26c06?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 21, title: "UV Thermal Shoe & Boot Dryer", price: 1339, category: "Footwear", rating: 5.0, reviews: 210, stock: 2, description: "Dries wet sneakers overnight while UV light neutralizes odor.", image: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 22, title: "Silicone Slip-On Shoe Protectors", price: 469, category: "Footwear", rating: 4.8, reviews: 98, stock: 5, description: "Protects white sneakers from mud and puddles.", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 23, title: "Breathable Quick-Dry Aqua Shoes", price: 839, category: "Footwear", rating: 4.7, reviews: 142, stock: 3, description: "Ultra-lightweight amphibious mesh shoes.", image: "https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 24, title: "Bamboo Charcoal Deodorizer Bags", price: 329, category: "Footwear", rating: 4.9, reviews: 310, stock: 6, description: "Pulls moisture and odor out of shoes and gym bags.", image: "https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 25, title: "Tactical Windbreaker Rain Jacket", price: 1779, category: "Apparel", rating: 4.9, reviews: 275, stock: 2, description: "Matte-black hydrophobic shell jacket.", image: "https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 26, title: "Quick-Dry 4-Way Stretch Trousers", price: 1399, category: "Apparel", rating: 4.8, reviews: 190, stock: 4, description: "Water-repellent tailored commuter pants.", image: "https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 27, title: "All-Weather Storm Hooded Parka", price: 2149, category: "Apparel", rating: 5.0, reviews: 88, stock: 1, description: "Extended-length storm parka engineered for heavy travel.", image: "https://images.unsplash.com/photo-1544441893-675973e31985?auto=format&fit=crop&w=600&q=80", badge: "Premium" },
            { id: 28, title: "Stain-Proof Men's Polo", price: 749, category: "Apparel", rating: 4.7, reviews: 165, stock: 5, description: "Coffee, soda, and raindrops roll right off.", image: "https://images.unsplash.com/photo-1581655353564-df123a1eb820?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 29, title: "Zip-On Rain Overpants", price: 939, category: "Apparel", rating: 4.6, reviews: 112, stock: 3, description: "Slips easily over formal pants.", image: "https://images.unsplash.com/photo-1552902865-b72c031ac5ea?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 30, title: "Orthopedic Arch Sandals", price: 1119, category: "Footwear", rating: 4.8, reviews: 320, stock: 4, description: "EVA recovery sandals with deep anti-skid grooves.", image: "https://images.unsplash.com/photo-1603808033192-082d6919d3e1?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 31, title: "Smart Sensor Posture Corrector Brace", price: 1299, category: "Gear", rating: 4.8, reviews: 540, stock: 5, description: "Gently vibrates whenever your back slouches past 25 degrees.", image: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=600&q=80", gallery: ["https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80"], badge: "Evergreen" },
            { id: 32, title: "Portable EMS Thermal Neck Massager", price: 1899, category: "Home", rating: 4.9, reviews: 812, stock: 3, description: "Melts away desk-job neck stiffness in 15 minutes.", image: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 33, title: "Mini 1080p Car Dash Cam", price: 2199, category: "Vehicle", rating: 4.7, reviews: 320, stock: 6, description: "Windshield camera with night vision and G-sensor collision lock.", image: "https://images.unsplash.com/photo-1511407409255-83e9b1399cc1?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 34, title: "Auto-Clamping Wireless Car Charger", price: 1449, category: "Vehicle", rating: 4.8, reviews: 450, stock: 4, description: "Infrared sensor arms open automatically.", image: "https://images.unsplash.com/photo-1585298723682-7115561c51b7?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 35, title: "6-Blade USB Blender", price: 1199, category: "Home", rating: 4.6, reviews: 920, stock: 8, description: "Crushes ice, fruit, and protein shakes.", image: "https://images.unsplash.com/photo-1595515286417-64b584d436a5?auto=format&fit=crop&w=600&q=80", badge: "Bestseller" },
            { id: 36, title: "Memory Foam Knee Pillow", price: 899, category: "Home", rating: 4.9, reviews: 1105, stock: 7, description: "Aligns hips and lower spine for side-sleepers.", image: "https://images.unsplash.com/photo-1584282570763-71ab527f394f?auto=format&fit=crop&w=600&q=80", badge: "Evergreen" },
            { id: 37, title: "Self-Cleaning Pet Lint Roller", price: 549, category: "Home", rating: 4.7, reviews: 670, stock: 9, description: "Traps fur and lint into a push-button chamber.", image: "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=600&q=80", badge: "Popular" },
            { id: 38, title: "12-in-1 Mandoline Chopper Pro", price: 999, category: "Home", rating: 4.8, reviews: 1432, stock: 2, description: "Stainless steel dicer that cuts kitchen prep time by 70%.", image: "https://images.unsplash.com/photo-1593504049359-74330189a345?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 39, title: "Anti-Theft Crossbody Tech Bag", price: 1249, category: "Gear", rating: 4.8, reviews: 490, stock: 5, description: "Slash-resistant commuter sling with lock.", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 40, title: "Wireless Charging LED Lamp", price: 1699, category: "Home", rating: 4.7, reviews: 215, stock: 4, description: "Dimmable studio lamp with built-in fast charger.", image: "https://images.unsplash.com/photo-1517705008128-361805f42e86?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 41, title: "Electric Makeup Brush Spinner Cleaner", price: 1499, category: "Beauty & Care", rating: 4.9, reviews: 1204, stock: 4, description: "Washes and spin-dries foundation brushes in 30 seconds. Stops breakouts.", image: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=600&q=80", badge: "Viral Winner" },
            { id: 42, title: "7-Color LED Photon Face Mask", price: 4999, category: "Beauty & Care", rating: 5.0, reviews: 312, stock: 2, description: "Clinical light therapy at home. Red boosts collagen; blue targets acne.", image: "https://images.unsplash.com/photo-1590159756185-9856cc43f173?auto=format&fit=crop&w=600&q=80", gallery: ["https://images.unsplash.com/photo-1616683693504-3ea7e9ad6fec?auto=format&fit=crop&w=600&q=80", "https://images.unsplash.com/photo-1512496015851-a1c8f1066d5b?auto=format&fit=crop&w=600&q=80"], badge: "Premium" },
            { id: 43, title: "Rechargeable Heated Eyelash Curler", price: 999, category: "Beauty & Care", rating: 4.8, reviews: 856, stock: 7, description: "Lifts lashes in 10 seconds for a 24-hour curl without pinching.", image: "https://images.unsplash.com/photo-1629853907409-7756fdf1d269?auto=format&fit=crop&w=600&q=80", badge: "Trending" },
            { id: 44, title: "Silicone Scalp Massager", price: 449, category: "Beauty & Care", rating: 4.9, reviews: 1840, stock: 9, description: "Deeply exfoliates dandruff buildup.", image: "https://images.unsplash.com/photo-1616683693504-3ea7e9ad6fec?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 45, title: "Cryo Ice Roller & Gua Sha Set", price: 1299, category: "Beauty & Care", rating: 4.7, reviews: 920, stock: 5, description: "Instantly depuffs under-eyes and contours jawline.", image: "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80", badge: "Bestseller" },
            { id: 46, title: "Silicone Eye Patches", price: 699, category: "Beauty & Care", rating: 4.8, reviews: 630, stock: 6, description: "Locks in your favorite eye cream.", image: "https://images.unsplash.com/photo-1512496015851-a1c8f1066d5b?auto=format&fit=crop&w=600&q=80", badge: "Eco-Luxury" },
            { id: 47, title: "Precision Eyebrow Trimmer", price: 799, category: "Beauty & Care", rating: 4.6, reviews: 1450, stock: 8, description: "Hypoallergenic micro-blade with built-in LED light.", image: "https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80", badge: "Top Seller" },
            { id: 48, title: "3D Microcurrent EMS Sculpting Wand", price: 1899, category: "Beauty & Care", rating: 4.7, reviews: 420, stock: 3, description: "High-frequency sonic vibration tones sagging cheeks for a lifted V-line contour.", image: "https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=600&q=80", gallery: ["https://images.unsplash.com/photo-1599305090598-fe179d501227?auto=format&fit=crop&w=600&q=80", "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=600&q=80"], badge: "Viral Winner" },
            { id: 49, title: "Antibacterial Body Scrubber", price: 549, category: "Beauty & Care", rating: 4.9, reviews: 2100, stock: 12, description: "Soft silicone bristles lather rich foam.", image: "https://images.unsplash.com/photo-1601055903647-8f1eaec797e8?auto=format&fit=crop&w=600&q=80", badge: "Essential" },
            { id: 50, title: "Tri-Tone LED Vanity Mirror", price: 1599, category: "Beauty & Care", rating: 4.8, reviews: 750, stock: 4, description: "Simulates natural daylight and warm evening light.", image: "https://images.unsplash.com/photo-1616014493390-e5550a1122a7?auto=format&fit=crop&w=600&q=80", badge: "Must Have" }
        ];

        var OWNER_WHATSAPP = "919014044915";
        var OWNER_UPI = "premkumarmanthena289@oksbi";
        var activeCategory = "All";
        var cart = [];
        var couponApplied = false;
        var orderBumpActive = false;

        function safeGetLocal(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
        function safeSetLocal(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

        try { var savedCart = safeGetLocal('prem_cart_v3'); if (savedCart) cart = JSON.parse(savedCart); } catch (e) {}
        function saveCart() { safeSetLocal('prem_cart_v3', JSON.stringify(cart)); }

        function showToast(msg) {
            var box = document.getElementById('toast-box');
            document.getElementById('toast-text').innerText = msg;
            box.classList.remove('hidden'); box.classList.add('flex');
            setTimeout(function() { box.classList.add('hidden'); box.classList.remove('flex'); }, 3000);
        }

        // ANIMATED UPI COPY
        function copyUpiIdAnim() {
            var btn = document.getElementById('copy-upi-btn');
            if (navigator.clipboard) navigator.clipboard.writeText(OWNER_UPI);
            var origHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>Copied!';
            btn.classList.add('bg-emerald-500', 'text-black', 'border-emerald-500');
            btn.classList.remove('bg-white/10', 'text-white', 'border-white/10');
            setTimeout(function() {
                btn.innerHTML = origHTML;
                btn.classList.remove('bg-emerald-500', 'text-black', 'border-emerald-500');
                btn.classList.add('bg-white/10', 'text-white', 'border-white/10');
            }, 2500);
        }

        // CATALOG LOGIC
        function setCategoryFilter(category) {
            activeCategory = category;
            var buttons = document.querySelectorAll('.cat-btn');
            for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].getAttribute('data-cat') === category) {
                    buttons[i].className = "cat-btn bg-brandPrimary text-white px-4 py-2 rounded-full text-xs font-bold shadow-glow transition-all whitespace-nowrap";
                } else {
                    buttons[i].className = "cat-btn bg-white/5 text-slate-300 border border-white/10 px-4 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap";
                }
            }
            filterAndRenderCatalog();
        }

        function filterAndRenderCatalog() {
            var grid = document.getElementById('product-grid');
            var searchVal = (document.getElementById('search-input').value || '').trim().toLowerCase();
            var filtered = storeProducts.filter(function(item) {
                var matchesCat = (activeCategory === "All" || item.category === activeCategory);
                var matchesSearch = !searchVal || item.title.toLowerCase().indexOf(searchVal) !== -1 || item.description.toLowerCase().indexOf(searchVal) !== -1;
                return matchesCat && matchesSearch;
            });

            var html = '';
            for (var i = 0; i < filtered.length; i++) {
                var prod = filtered[i];
                var mrp = Math.round(prod.price * 1.35);
                html += '<div class="bg-darkSurface rounded-2xl border border-darkBorder flex flex-col group relative overflow-hidden transition-all shadow-lg hover:border-brandPrimary/50">' +
                    '<span class="absolute top-3 left-3 bg-brandPrimary text-white text-[9px] font-black px-2.5 py-1 rounded-full uppercase z-10">' + prod.badge + '</span>' +
                    '<div onclick="openQuickView(' + prod.id + ')" class="relative bg-black overflow-hidden aspect-[4/3] cursor-pointer">' +
                        '<img src="' + prod.image + '" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90">' +
                    '</div>' +
                    '<div class="p-4 flex flex-col flex-grow relative z-20 bg-darkSurface">' +
                        '<h3 onclick="openQuickView(' + prod.id + ')" class="font-extrabold text-white text-sm cursor-pointer hover:text-brandPrimary line-clamp-1 mb-2">' + prod.title + '</h3>' +
                        '<div class="mt-auto flex justify-between items-center border-t border-darkBorder pt-2 gap-2">' +
                            '<div>' +
                                '<span class="text-[11px] text-slate-500 line-through block font-mono">₹' + mrp.toLocaleString('en-IN') + '</span>' +
                                '<span class="text-lg font-black text-white">₹' + prod.price.toLocaleString('en-IN') + '</span>' +
                            '</div>' +
                            '<button onclick="buyNowDirect(' + prod.id + ')" class="bg-brandPrimary hover:bg-pink-600 text-white text-xs font-extrabold px-4 py-2 rounded-xl transition-all">Buy Now</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }
            grid.innerHTML = html;
        }

        // QUICK VIEW GALLERY LOGIC
        function changeQuickViewImage(url) { document.getElementById('qv-img').src = url; }

        function openQuickView(id) {
            var prod = storeProducts.find(function(p) { return p.id === id; });
            if (!prod) return;
            document.getElementById('qv-img').src = prod.image;
            document.getElementById('qv-badge').innerText = prod.badge;
            document.getElementById('qv-rating').innerText = prod.rating + ' (' + prod.reviews + ')';
            document.getElementById('qv-title').innerText = prod.title;
            document.getElementById('qv-price').innerText = '₹' + prod.price.toLocaleString('en-IN');
            document.getElementById('qv-mrp').innerText = '₹' + Math.round(prod.price * 1.35).toLocaleString('en-IN');
            document.getElementById('qv-desc').innerText = prod.description;
            document.getElementById('qv-pin-result').classList.add('hidden');

            var thumbsContainer = document.getElementById('qv-thumbnails');
            if (prod.gallery && prod.gallery.length > 0) {
                var allImages = [prod.image].concat(prod.gallery);
                var thumbsHtml = '';
                for (var i = 0; i < allImages.length; i++) {
                    thumbsHtml += '<img src="' + allImages[i] + '" onclick="changeQuickViewImage(\'' + allImages[i] + '\')" class="w-12 h-12 rounded-lg border-2 border-transparent hover:border-brandPrimary cursor-pointer object-cover shadow-lg transition-colors bg-darkBg shrink-0">';
                }
                thumbsContainer.innerHTML = thumbsHtml;
            } else { thumbsContainer.innerHTML = ''; }

            document.getElementById('qv-add-btn').onclick = function() { closeQuickView(); addToCart(prod.id); };
            document.getElementById('qv-buy-btn').onclick = function() { closeQuickView(); buyNowDirect(prod.id); };
            var modal = document.getElementById('quickview-modal');
            modal.classList.remove('hidden'); modal.classList.add('flex');
        }

        function closeQuickView() {
            var modal = document.getElementById('quickview-modal');
            modal.classList.add('hidden'); modal.classList.remove('flex');
        }

        function checkPincode() {
            var pin = (document.getElementById('qv-pincode').value || '').trim();
            var res = document.getElementById('qv-pin-result');
            if (/^[1-9][0-9]{5}$/.test(pin)) {
                res.innerText = '✅ Express Delivery available to ' + pin;
                res.className = 'text-[11px] text-emerald-400 font-semibold mt-2 block';
            } else {
                res.innerText = '⚠️ Please enter a valid 6-digit Pincode.';
                res.className = 'text-[11px] text-amber-400 font-semibold mt-2 block';
            }
        }

        // CART LOGIC
        function toggleCart() { document.getElementById('cart-sidebar').classList.toggle('translate-x-full'); }
        
        function applyQuickCoupon(code) {
            couponApplied = true;
            document.getElementById('coupon-input').value = code;
            updateCartUI(); showToast('Coupon ' + code + ' applied!');
        }
        function applyCouponInput() {
            var val = (document.getElementById('coupon-input').value || '').trim().toUpperCase();
            if (val === 'PREM10' || val === 'VIP10') { couponApplied = true; updateCartUI(); showToast('Discount Applied!'); } 
            else { showToast('Invalid code. Try PREM10'); }
        }

        function addToCart(id) {
            var prod = storeProducts.find(p => p.id === id);
            var item = cart.find(i => i.id === id);
            if (item && item.qty >= prod.stock) { showToast('Stock limit reached.'); return; }
            if (item) item.qty += 1;
            else cart.push({ id: prod.id, title: prod.title, price: prod.price, image: prod.image, stock: prod.stock, qty: 1 });
            saveCart(); updateCartUI(); showToast('Added to cart');
            if (document.getElementById('cart-sidebar').classList.contains('translate-x-full')) toggleCart();
        }

        function buyNowDirect(id) {
            var prod = storeProducts.find(p => p.id === id);
            var item = cart.find(i => i.id === id);
            if (!item) {
                cart.push({ id: prod.id, title: prod.title, price: prod.price, image: prod.image, stock: prod.stock, qty: 1 });
                saveCart(); updateCartUI();
            }
            openShippingModal();
        }

        function modifyQty(id, step) {
            var index = cart.findIndex(i => i.id === id);
            if (index > -1) {
                if (step > 0 && cart[index].qty >= cart[index].stock) { showToast('Stock limit reached.'); return; }
                cart[index].qty += step;
                if (cart[index].qty <= 0) cart.splice(index, 1);
            }
            saveCart(); updateCartUI();
        }

        function updateCartUI() {
            var count = cart.reduce((sum, i) => sum + i.qty, 0);
            document.getElementById('cart-count').innerText = count;
            var subtotal = cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
            var discount = couponApplied ? Math.round(subtotal * 0.10) : 0;
            orderBumpActive = document.getElementById('order-bump').checked;
            var bumpCost = (cart.length > 0 && orderBumpActive) ? 99 : 0;
            var finalTotal = Math.max(0, subtotal - discount + bumpCost);

            document.getElementById('cart-subtotal').innerText = '₹' + subtotal.toLocaleString('en-IN');
            document.getElementById('cart-total').innerText = '₹' + finalTotal.toLocaleString('en-IN');
            
            var discRow = document.getElementById('discount-row');
            if (discount > 0) {
                discRow.classList.remove('hidden');
                document.getElementById('cart-discount').innerText = '-₹' + discount.toLocaleString('en-IN');
            } else { discRow.classList.add('hidden'); }

            var prog = document.getElementById('shipping-progress');
            if (subtotal >= 1000) {
                prog.style.width = '100%'; prog.className = 'bg-emerald-500 h-1.5 rounded-full transition-all';
                document.getElementById('shipping-text').innerHTML = '<span class="text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>FREE VIP Express Shipping Unlocked!</span>';
            } else {
                prog.style.width = Math.min(100, (subtotal / 1000) * 100) + '%'; prog.className = 'bg-brandPrimary h-1.5 rounded-full transition-all';
                document.getElementById('shipping-text').innerHTML = 'Add ₹' + (1000 - subtotal).toLocaleString('en-IN') + ' for FREE VIP Shipping';
            }

            var container = document.getElementById('cart-items');
            if (cart.length === 0) {
                container.innerHTML = '<div class="text-center text-slate-500 py-12 text-xs"><i class="fa-solid fa-cart-arrow-down text-2xl mb-2 block"></i>Your cart is empty.</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < cart.length; i++) {
                var item = cart[i];
                html += '<div class="flex items-center space-x-3 bg-darkSurface p-2.5 rounded-xl border border-darkBorder">' +
                    '<img src="' + item.image + '" class="w-14 h-14 object-cover rounded-lg shrink-0">' +
                    '<div class="flex-grow overflow-hidden"><h4 class="font-bold text-xs text-white truncate">' + item.title + '</h4>' +
                    '<p class="text-brandPrimary text-sm font-black mt-0.5">₹' + (item.price * item.qty).toLocaleString('en-IN') + '</p></div>' +
                    '<div class="flex items-center bg-black rounded-lg border border-white/10">' +
                        '<button onclick="modifyQty(' + item.id + ', -1)" class="w-7 h-7 text-slate-400 hover:text-white">-</button>' +
                        '<span class="text-xs font-bold text-white px-2">' + item.qty + '</span>' +
                        '<button onclick="modifyQty(' + item.id + ', 1)" class="w-7 h-7 text-slate-400 hover:text-white">+</button>' +
                    '</div></div>';
            }
            container.innerHTML = html;
        }

        // CHECKOUT LOGIC
        function openShippingModal() {
            if (cart.length === 0) { showToast('Cart is empty'); return; }
            if (!document.getElementById('cart-sidebar').classList.contains('translate-x-full')) toggleCart();
            document.getElementById('checkout-total-badge').innerText = document.getElementById('cart-total').innerText;
            document.getElementById('shipping-modal').classList.remove('hidden'); document.getElementById('shipping-modal').classList.add('flex');
        }
        function closeShippingModal() { document.getElementById('shipping-modal').classList.add('hidden'); document.getElementById('shipping-modal').classList.remove('flex'); }

        async function submitOrderAndRedirectToWhatsApp(event) {
            event.preventDefault();
            var btn = document.getElementById('whatsapp-checkout-btn');
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Generating Invoice...</span>'; btn.disabled = true;
            
            var cName = document.getElementById('cust-name').value.trim();
            var cPhone = document.getElementById('cust-phone').value.trim();
            var cAddress = document.getElementById('cust-address').value.trim();
            
            var subtotal = cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
            var discount = couponApplied ? Math.round(subtotal * 0.10) : 0;
            var bump = orderBumpActive ? 99 : 0;
            var total = Math.max(0, subtotal - discount + bump);
            var orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);

            var record = { orderId: orderId, customer: { name: cName, phone: cPhone, address: cAddress }, cart: cart, total: total };

            var existing = JSON.parse(safeGetLocal('prem_orders_v3') || '[]');
            existing.unshift(record);
            safeSetLocal('prem_orders_v3', JSON.stringify(existing.slice(0, 10)));

            try {
                await fetch('/api/place-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
            } catch (error) {}

            var waMsg = "*🛍️ NEW ORDER - PREM'S STORE*\n\n*🏷️ ID:* " + orderId + "\n*👤 Name:* " + cName + "\n*📞 Phone:* " + cPhone + "\n*📍 Address:* " + cAddress + "\n\n*💰 TOTAL:* ₹" + total.toLocaleString('en-IN') + "\n\n--- \n*⚡ INSTRUCTIONS:*\n1. Send ₹" + total + " to UPI ID: *" + OWNER_UPI + "*\n2. Attach screenshot here.\n---\n✅ *I am ready!*";
            cart = []; saveCart(); updateCartUI(); closeShippingModal();
            btn.innerHTML = '<i class="fa-brands fa-whatsapp text-xl"></i><span>Step 2: Send Invoice</span>'; btn.disabled = false;
            window.location.href = "https://wa.me/" + OWNER_WHATSAPP + "?text=" + encodeURIComponent(waMsg);
        }

        // TRACKING LOGIC
        function openTrackModal() {
            var list = JSON.parse(safeGetLocal('prem_orders_v3') || '[]');
            var box = document.getElementById('recent-orders-box');
            var container = document.getElementById('recent-orders-list');
            if (list.length > 0) {
                box.classList.remove('hidden');
                container.innerHTML = list.map(o => '<button type="button" onclick="document.getElementById(\'track-order-id\').value=\'' + o.orderId + '\'; lookupOrderStatus();" class="bg-white/10 hover:bg-brandPrimary text-white text-[11px] font-mono px-2.5 py-1 rounded-lg transition-colors">' + o.orderId + '</button>').join('');
            } else { box.classList.add('hidden'); }
            
            document.getElementById('track-modal').classList.remove('hidden'); document.getElementById('track-modal').classList.add('flex');
        }
        function closeTrackModal() { document.getElementById('track-modal').classList.add('hidden'); document.getElementById('track-modal').classList.remove('flex'); }
        
        async function lookupOrderStatus(event) {
            if (event) event.preventDefault();
            var id = (document.getElementById('track-order-id').value || '').trim().toUpperCase();
            if (!id) return;
            
            var found = null;
            try {
                var res = await fetch('/api/track/' + encodeURIComponent(id));
                if (res.ok) { var data = await res.json(); if (data.found) found = data.order; }
            } catch (e) {}

            if (!found) {
                var local = JSON.parse(safeGetLocal('prem_orders_v3') || '[]');
                found = local.find(o => (o.orderId || '').toUpperCase() === id);
            }
            if (!found) found = { orderId: id, status: 'Verification', stage: 2 };
            
            document.getElementById('track-result-card').classList.remove('hidden');
            document.getElementById('trk-id').innerText = found.orderId;
            document.getElementById('trk-badge').innerText = found.status;
            
            var stages = ['Registered', 'UPI Verified', 'Dispatched', 'Out for Delivery'];
            var html = '';
            for(var i=0; i<4; i++) {
                var done = (found.stage || 2) >= (i+1);
                var icon = done ? '<i class="fa-solid fa-circle-check text-emerald-400"></i>' : '<i class="fa-regular fa-circle text-slate-600"></i>';
                html += '<div class="flex items-center space-x-2.5">' + icon + '<span class="' + (done ? 'text-white font-bold' : 'text-slate-500') + '">' + stages[i] + '</span></div>';
            }
            if(found.courierInfo) html += '<div class="mt-2 text-emerald-300">Courier: ' + found.courierInfo + '</div>';
            document.getElementById('trk-steps').innerHTML = html;
        }

        function pingWhatsAppForTracking() {
            var id = document.getElementById('track-order-id').value || '';
            window.location.href = "https://wa.me/" + OWNER_WHATSAPP + "?text=" + encodeURIComponent("Hello! Tracking update for order: *" + id + "*");
        }

        // ADMIN LOGIC
        function unlockAdminPanel() {
            if (document.getElementById('admin-pin-input').value === '9014') {
                document.getElementById('admin-pin-input').classList.add('hidden');
                document.getElementById('admin-unlock-btn').classList.add('hidden');
                document.getElementById('admin-content').style.display = 'block';
                loadAdminOrders();
            } else { showToast('Incorrect PIN'); }
        }
        
        async function loadAdminOrders() {
            var c = document.getElementById('admin-orders-list');
            try {
                var res = await fetch('/api/admin/orders'); var data = await res.json();
                if(!data.orders || data.orders.length===0) { c.innerHTML = '<p class="text-slate-500">No orders in memory</p>'; return; }
                c.innerHTML = data.orders.map(o => '<div class="bg-darkSurface p-3 rounded-xl border border-darkBorder flex justify-between">' +
                    '<div><span class="font-mono text-brandPrimary font-bold">' + o.orderId + '</span><br>' + o.customer.name + ' (' + o.customer.phone + ')<br><span class="text-emerald-400">' + o.status + '</span></div>' +
                    '<div class="space-x-1"><button onclick="adminQuickUpdate(\'' + o.orderId + '\', \'Shipped\', 3)" class="bg-blue-500 text-white px-2 py-1 rounded">Ship</button></div></div>').join('');
            } catch(e) { c.innerHTML = '<p>Error loading.</p>'; }
        }

        async function adminQuickUpdate(id, status, stage) {
            try {
                await fetch('/api/admin/update-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '9014', orderId: id, status: status, stage: stage }) });
                showToast('Updated ' + id); loadAdminOrders();
            } catch(e) {}
        }

        // BOOTSTRAP
        filterAndRenderCatalog();
        updateCartUI();
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(frontendHTML));
app.listen(PORT, () => console.log("\n💎 PREM'S STORE V3.1 IS LIVE ON PORT " + PORT));
