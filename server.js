const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STARTING_CASH = 1000000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const state = {
  cash: STARTING_CASH,
  positions: {},
  trades: [],
};

const MARKET_SYMBOLS = {
  tw: ["2330.TW", "2317.TW", "2454.TW", "2303.TW", "2882.TW"],
  us: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"],
  crypto: ["bitcoin", "ethereum", "solana", "dogecoin", "ripple"],
};

function seedPrice(symbol, market) {
  const baseMap = { tw: 600, us: 200, crypto: 100 };
  const hash = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return +(baseMap[market] + (hash % 200) + Math.random() * 10).toFixed(2);
}

async function fetchTwPrice(symbol) {
  const stooqSymbol = symbol.replace(".TW", ".TW").toLowerCase();
  const url = `https://stooq.com/q/l/?s=${stooqSymbol}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("TW source unavailable");
  const text = (await response.text()).trim();
  const lines = text.split("\n");
  if (lines.length < 2) throw new Error("TW no data");
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) throw new Error("TW invalid price");
  return +close.toFixed(2);
}

async function fetchUsPrice(symbol) {
  const stooqSymbol = `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/l/?s=${stooqSymbol}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("US source unavailable");
  const text = (await response.text()).trim();
  const lines = text.split("\n");
  if (lines.length < 2) throw new Error("US no data");
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) throw new Error("US invalid price");
  return +close.toFixed(2);
}

async function fetchCryptoPrice(symbol) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Crypto source unavailable");
  const payload = await response.json();
  const price = payload?.[symbol]?.usd;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Crypto invalid price");
  return +Number(price).toFixed(6);
}

async function getMarketQuote(market, symbol) {
  try {
    if (market === "tw") return await fetchTwPrice(symbol);
    if (market === "us") return await fetchUsPrice(symbol);
    if (market === "crypto") return await fetchCryptoPrice(symbol);
    throw new Error("Unknown market");
  } catch (error) {
    return seedPrice(symbol, market);
  }
}

function holdingKey(market, symbol) {
  return `${market}:${symbol}`;
}

app.get("/api/markets", async (req, res) => {
  const result = {};
  for (const market of Object.keys(MARKET_SYMBOLS)) {
    result[market] = [];
    for (const symbol of MARKET_SYMBOLS[market]) {
      const price = await getMarketQuote(market, symbol);
      result[market].push({ symbol, price });
    }
  }
  res.json(result);
});

app.post("/api/trade", async (req, res) => {
  const { market, symbol, side, quantity } = req.body || {};
  const qty = Number(quantity);

  if (!MARKET_SYMBOLS[market] || !MARKET_SYMBOLS[market].includes(symbol)) {
    return res.status(400).json({ error: "Invalid market or symbol." });
  }
  if (!["buy", "sell"].includes(side)) {
    return res.status(400).json({ error: "Side must be buy or sell." });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "Quantity must be positive." });
  }

  const price = await getMarketQuote(market, symbol);
  const key = holdingKey(market, symbol);
  const position = state.positions[key] || {
    market,
    symbol,
    quantity: 0,
    avgCost: 0,
  };
  const cost = +(price * qty).toFixed(2);

  if (side === "buy") {
    if (state.cash < cost) {
      return res.status(400).json({ error: "Not enough cash." });
    }
    const newQty = position.quantity + qty;
    const weightedCost =
      (position.avgCost * position.quantity + cost) / (newQty || 1);
    state.cash = +(state.cash - cost).toFixed(2);
    position.quantity = +newQty.toFixed(8);
    position.avgCost = +weightedCost.toFixed(6);
    state.positions[key] = position;
  } else {
    if (position.quantity < qty) {
      return res.status(400).json({ error: "Not enough position to sell." });
    }
    position.quantity = +(position.quantity - qty).toFixed(8);
    state.cash = +(state.cash + cost).toFixed(2);
    if (position.quantity <= 0) {
      delete state.positions[key];
    } else {
      state.positions[key] = position;
    }
  }

  state.trades.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    market,
    symbol,
    side,
    quantity: qty,
    price,
    amount: cost,
  });
  state.trades = state.trades.slice(0, 200);

  res.json({ ok: true });
});

app.get("/api/portfolio", async (req, res) => {
  const positions = Object.values(state.positions);
  const enriched = [];
  let marketValue = 0;

  for (const p of positions) {
    const currentPrice = await getMarketQuote(p.market, p.symbol);
    const value = +(currentPrice * p.quantity).toFixed(2);
    const costBasis = +(p.avgCost * p.quantity).toFixed(2);
    const unrealizedPnl = +(value - costBasis).toFixed(2);
    marketValue += value;
    enriched.push({
      ...p,
      currentPrice,
      value,
      costBasis,
      unrealizedPnl,
    });
  }

  const totalAsset = +(state.cash + marketValue).toFixed(2);
  const totalPnl = +(totalAsset - STARTING_CASH).toFixed(2);

  res.json({
    cash: state.cash,
    marketValue: +marketValue.toFixed(2),
    totalAsset,
    totalPnl,
    positions: enriched,
    trades: state.trades,
  });
});

app.post("/api/reset", (req, res) => {
  state.cash = STARTING_CASH;
  state.positions = {};
  state.trades = [];
  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Stock simulation running on http://localhost:${PORT}`);
});
