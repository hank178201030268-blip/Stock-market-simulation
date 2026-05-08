const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const STARTING_CASH = 1000000;

const state = {
  cash: STARTING_CASH,
  reservedCash: 0,
  positions: {},
  reservedPositions: {},
  trades: [],
  orders: [],
};

const MARKET_SYMBOLS = {
  tw: ["2330.TW", "2317.TW", "2454.TW", "2303.TW", "2882.TW"],
  us: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"],
  crypto: ["bitcoin", "ethereum", "solana", "dogecoin", "ripple"],
};
const MARKET_RULES = {
  tw: { feeRate: 0.001425, sellTaxRate: 0.003, marketSlippage: 0.0008 },
  us: { feeRate: 0.001, sellTaxRate: 0, marketSlippage: 0.0006 },
  crypto: { feeRate: 0.001, sellTaxRate: 0, marketSlippage: 0.0012 },
};
const quoteCache = new Map();
const QUOTE_TTL_MS = 8000;

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function holdingKey(market, symbol) {
  return `${market}:${symbol}`;
}
function getPosition(market, symbol) {
  const key = holdingKey(market, symbol);
  return state.positions[key] || { market, symbol, quantity: 0, avgCost: 0 };
}
function getReservedQty(key) {
  return +(state.reservedPositions[key] || 0);
}
function availableCash() {
  return +(state.cash - state.reservedCash).toFixed(2);
}
function availableQty(market, symbol) {
  const key = holdingKey(market, symbol);
  const p = getPosition(market, symbol);
  return +(p.quantity - getReservedQty(key)).toFixed(8);
}
function calcCharges({ market, side, qty, price }) {
  const rules = MARKET_RULES[market];
  const gross = +(qty * price).toFixed(2);
  const fee = +(gross * rules.feeRate).toFixed(2);
  const tax = side === "sell" ? +(gross * rules.sellTaxRate).toFixed(2) : 0;
  return {
    gross,
    fee,
    tax,
    totalDebit: +(gross + fee + tax).toFixed(2),
    netCredit: +(gross - fee - tax).toFixed(2),
  };
}
function applyFill({ market, symbol, side, qty, price, orderId, orderType }) {
  const key = holdingKey(market, symbol);
  const position = getPosition(market, symbol);
  const charges = calcCharges({ market, side, qty, price });
  if (side === "buy") {
    if (state.cash < charges.totalDebit) throw new Error("Not enough cash.");
    const newQty = position.quantity + qty;
    position.avgCost = +(
      (position.avgCost * position.quantity + charges.totalDebit) /
      (newQty || 1)
    ).toFixed(6);
    position.quantity = +newQty.toFixed(8);
    state.positions[key] = position;
    state.cash = +(state.cash - charges.totalDebit).toFixed(2);
  } else {
    if (position.quantity < qty) throw new Error("Not enough position.");
    position.quantity = +(position.quantity - qty).toFixed(8);
    state.cash = +(state.cash + charges.netCredit).toFixed(2);
    if (position.quantity <= 0) delete state.positions[key];
    else state.positions[key] = position;
  }
  state.trades.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    orderId,
    orderType,
    timestamp: new Date().toISOString(),
    market,
    symbol,
    side,
    quantity: qty,
    price,
    gross: charges.gross,
    fee: charges.fee,
    tax: charges.tax,
    cashEffect: side === "buy" ? -charges.totalDebit : charges.netCredit,
  });
  state.trades = state.trades.slice(0, 300);
}
function releaseReservation(order) {
  if (order.side === "buy") {
    state.reservedCash = +(state.reservedCash - (order.reservedCash || 0)).toFixed(2);
    if (state.reservedCash < 0) state.reservedCash = 0;
  } else {
    const key = holdingKey(order.market, order.symbol);
    const next = +(getReservedQty(key) - (order.reservedQty || 0)).toFixed(8);
    if (next <= 0) delete state.reservedPositions[key];
    else state.reservedPositions[key] = next;
  }
}
function seedPrice(symbol, market) {
  const base = { tw: 600, us: 200, crypto: 100 }[market] || 100;
  const hash = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return +(base + (hash % 200) + Math.random() * 10).toFixed(market === "crypto" ? 6 : 2);
}
async function fetchTwPrice(symbol) {
  const url = `https://stooq.com/q/l/?s=${symbol.toLowerCase()}&f=sd2t2ohlcv&h&e=csv`;
  const txt = await (await fetch(url)).text();
  const cols = txt.trim().split("\n")[1]?.split(",") || [];
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) throw new Error("TW no data");
  return +close.toFixed(2);
}
async function fetchUsPrice(symbol) {
  const url = `https://stooq.com/q/l/?s=${symbol.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
  const txt = await (await fetch(url)).text();
  const cols = txt.trim().split("\n")[1]?.split(",") || [];
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) throw new Error("US no data");
  return +close.toFixed(2);
}
async function fetchCryptoPrice(symbol) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`;
  const payload = await (await fetch(url)).json();
  const p = payload?.[symbol]?.usd;
  if (!Number.isFinite(p) || p <= 0) throw new Error("Crypto no data");
  return +Number(p).toFixed(6);
}
async function getMarketQuote(market, symbol) {
  try {
    if (market === "tw") return await fetchTwPrice(symbol);
    if (market === "us") return await fetchUsPrice(symbol);
    if (market === "crypto") return await fetchCryptoPrice(symbol);
  } catch {}
  return seedPrice(symbol, market);
}
async function getQuoteCached(market, symbol) {
  const key = `${market}:${symbol}`;
  const c = quoteCache.get(key);
  if (c && Date.now() - c.ts <= QUOTE_TTL_MS) return c.price;
  const price = await getMarketQuote(market, symbol);
  quoteCache.set(key, { ts: Date.now(), price });
  return price;
}
async function processPendingOrders() {
  for (const order of state.orders.filter((o) => o.status === "open" && o.type === "limit")) {
    const quote = await getQuoteCached(order.market, order.symbol);
    const canFill = (order.side === "buy" && quote <= order.limitPrice) || (order.side === "sell" && quote >= order.limitPrice);
    if (!canFill) continue;
    const fillPrice = +(order.side === "buy" ? Math.min(quote, order.limitPrice) : Math.max(quote, order.limitPrice)).toFixed(order.market === "crypto" ? 6 : 2);
    try {
      applyFill({ market: order.market, symbol: order.symbol, side: order.side, qty: order.quantity, price: fillPrice, orderId: order.id, orderType: order.type });
      releaseReservation(order);
      order.status = "filled";
      order.filledAt = new Date().toISOString();
      order.fillPrice = fillPrice;
    } catch (e) {
      releaseReservation(order);
      order.status = "rejected";
      order.rejectReason = e.message;
    }
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function serveStatic(req, res, pathname) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(target).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, "public", normalized);
  const mime =
    filePath.endsWith(".html") ? "text/html; charset=utf-8" :
    filePath.endsWith(".js") ? "application/javascript; charset=utf-8" :
    filePath.endsWith(".css") ? "text/css; charset=utf-8" : "text/plain; charset=utf-8";
  fs.readFile(filePath, (err, data) => {
    if (!err) {
      res.writeHead(200, { "Content-Type": mime });
      return res.end(data);
    }
    fs.readFile(path.join(__dirname, "public", "index.html"), (e2, html) => {
      if (e2) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  try {
    if (pathname === "/api/markets" && req.method === "GET") {
      await processPendingOrders();
      const result = {};
      for (const market of Object.keys(MARKET_SYMBOLS)) {
        result[market] = [];
        for (const symbol of MARKET_SYMBOLS[market]) {
          result[market].push({ symbol, price: await getQuoteCached(market, symbol) });
        }
      }
      return sendJson(res, 200, result);
    }
    if (pathname === "/api/order" && req.method === "POST") {
      const body = await readBody(req);
      const { market, symbol, side, quantity, type = "market", limitPrice } = body;
      const qty = Number(quantity);
      const limit = Number(limitPrice);
      if (!MARKET_SYMBOLS[market]?.includes(symbol)) return sendJson(res, 400, { error: "Invalid market or symbol." });
      if (!["buy", "sell"].includes(side)) return sendJson(res, 400, { error: "Side must be buy or sell." });
      if (!Number.isFinite(qty) || qty <= 0) return sendJson(res, 400, { error: "Quantity must be positive." });
      if (!["market", "limit"].includes(type)) return sendJson(res, 400, { error: "Type must be market or limit." });
      if (type === "limit" && (!Number.isFinite(limit) || limit <= 0)) return sendJson(res, 400, { error: "Limit price must be positive for limit order." });
      const order = { id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), market, symbol, side, type, quantity: +qty.toFixed(8), limitPrice: type === "limit" ? +limit.toFixed(market === "crypto" ? 6 : 2) : null, status: "open", reservedCash: 0, reservedQty: 0 };
      if (type === "market") {
        const quote = await getQuoteCached(market, symbol);
        const slip = MARKET_RULES[market].marketSlippage;
        const fill = +(side === "buy" ? quote * (1 + slip) : quote * (1 - slip)).toFixed(market === "crypto" ? 6 : 2);
        if (side === "buy") {
          if (availableCash() < calcCharges({ market, side, qty, price: fill }).totalDebit) return sendJson(res, 400, { error: "Not enough available cash." });
        } else if (availableQty(market, symbol) < qty) return sendJson(res, 400, { error: "Not enough available position to sell." });
        applyFill({ market, symbol, side, qty, price: fill, orderId: order.id, orderType: type });
        order.status = "filled"; order.filledAt = new Date().toISOString(); order.fillPrice = fill;
        state.orders.unshift(order); state.orders = state.orders.slice(0, 600);
        return sendJson(res, 200, { ok: true, order });
      }
      if (side === "buy") {
        const reserve = calcCharges({ market, side, qty, price: order.limitPrice }).totalDebit;
        if (availableCash() < reserve) return sendJson(res, 400, { error: "Not enough available cash to place limit order." });
        order.reservedCash = reserve; state.reservedCash = +(state.reservedCash + reserve).toFixed(2);
      } else {
        const key = holdingKey(market, symbol);
        if (availableQty(market, symbol) < qty) return sendJson(res, 400, { error: "Not enough available position to place limit sell." });
        order.reservedQty = +qty.toFixed(8); state.reservedPositions[key] = +(getReservedQty(key) + qty).toFixed(8);
      }
      state.orders.unshift(order); state.orders = state.orders.slice(0, 600);
      await processPendingOrders();
      return sendJson(res, 200, { ok: true, order });
    }
    if (pathname.startsWith("/api/orders/") && pathname.endsWith("/cancel") && req.method === "POST") {
      const id = pathname.split("/")[3];
      const order = state.orders.find((o) => o.id === id);
      if (!order) return sendJson(res, 404, { error: "Order not found." });
      if (order.status !== "open") return sendJson(res, 400, { error: "Only open orders can be cancelled." });
      releaseReservation(order); order.status = "cancelled"; order.cancelledAt = new Date().toISOString();
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/orders" && req.method === "GET") return sendJson(res, 200, { orders: state.orders.slice(0, 100) });
    if (pathname === "/api/rules" && req.method === "GET") return sendJson(res, 200, MARKET_RULES);
    if (pathname === "/api/portfolio" && req.method === "GET") {
      await processPendingOrders();
      const positions = Object.values(state.positions);
      const enriched = []; let marketValue = 0;
      for (const p of positions) {
        const currentPrice = await getQuoteCached(p.market, p.symbol);
        const key = holdingKey(p.market, p.symbol);
        const reservedQty = getReservedQty(key);
        const freeQty = +(p.quantity - reservedQty).toFixed(8);
        const value = +(currentPrice * p.quantity).toFixed(2);
        const costBasis = +(p.avgCost * p.quantity).toFixed(2);
        const unrealizedPnl = +(value - costBasis).toFixed(2);
        marketValue += value;
        enriched.push({ ...p, reservedQty, freeQty, currentPrice, value, costBasis, unrealizedPnl });
      }
      return sendJson(res, 200, { cash: state.cash, availableCash: availableCash(), reservedCash: state.reservedCash, marketValue: +marketValue.toFixed(2), totalAsset: +(state.cash + marketValue).toFixed(2), totalPnl: +(state.cash + marketValue - STARTING_CASH).toFixed(2), positions: enriched, orders: state.orders.filter((o) => o.status === "open").slice(0, 100), trades: state.trades });
    }
    if (pathname === "/api/reset" && req.method === "POST") {
      state.cash = STARTING_CASH; state.reservedCash = 0; state.positions = {}; state.reservedPositions = {}; state.trades = []; state.orders = []; quoteCache.clear();
      return sendJson(res, 200, { ok: true });
    }
    if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "API not found" });
    serveStatic(req, res, pathname);
  } catch (e) {
    sendJson(res, 500, { error: e.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Stock simulation running on http://localhost:${PORT}`);
});
