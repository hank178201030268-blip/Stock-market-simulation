const els = {
  account: document.getElementById("account"),
  markets: document.getElementById("markets"),
  marketSelect: document.getElementById("marketSelect"),
  symbolSelect: document.getElementById("symbolSelect"),
  sideSelect: document.getElementById("sideSelect"),
  typeSelect: document.getElementById("typeSelect"),
  limitPriceWrap: document.getElementById("limitPriceWrap"),
  limitPriceInput: document.getElementById("limitPriceInput"),
  qtyInput: document.getElementById("qtyInput"),
  tradeForm: document.getElementById("tradeForm"),
  tradeMsg: document.getElementById("tradeMsg"),
  positions: document.getElementById("positions"),
  orders: document.getElementById("orders"),
  trades: document.getElementById("trades"),
  resetBtn: document.getElementById("resetBtn"),
};

let marketData = {};

function fmt(value, digits = 2) {
  return Number(value || 0).toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pnlClass(v) {
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function renderMarkets() {
  const blocks = Object.entries(marketData).map(([market, rows]) => {
    const title = market === "tw" ? "台股" : market === "us" ? "美股" : "虛擬貨幣";
    const tableRows = rows
      .map(
        (r) =>
          `<tr><td>${r.symbol}</td><td>${fmt(r.price, market === "crypto" ? 6 : 2)}</td></tr>`
      )
      .join("");
    return `
      <h3>${title}</h3>
      <table>
        <thead><tr><th>代號</th><th>價格</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `;
  });
  els.markets.innerHTML = blocks.join("");
}

function renderMarketSelect() {
  const entries = Object.entries(marketData);
  els.marketSelect.innerHTML = entries
    .map(([m]) => {
      const text = m === "tw" ? "台股" : m === "us" ? "美股" : "虛擬貨幣";
      return `<option value="${m}">${text}</option>`;
    })
    .join("");
  syncSymbolSelect();
}

function syncSymbolSelect() {
  const market = els.marketSelect.value;
  const symbols = marketData[market] || [];
  els.symbolSelect.innerHTML = symbols
    .map((s) => `<option value="${s.symbol}">${s.symbol}</option>`)
    .join("");
}

function renderPortfolio(p) {
  els.account.innerHTML = `
    <div class="inline-grid">
      <div>現金：${fmt(p.cash)}</div>
      <div>可用現金：${fmt(p.availableCash)}</div>
      <div>凍結現金：${fmt(p.reservedCash)}</div>
      <div>市值：${fmt(p.marketValue)}</div>
      <div>總資產：${fmt(p.totalAsset)}</div>
      <div class="${pnlClass(p.totalPnl)}">總損益：${fmt(p.totalPnl)}</div>
    </div>
  `;

  const orderRows = (p.orders || [])
    .map(
      (o) => `<tr>
      <td>${new Date(o.createdAt).toLocaleString("zh-TW")}</td>
      <td>${o.market.toUpperCase()}</td>
      <td>${o.symbol}</td>
      <td>${o.side === "buy" ? "買進" : "賣出"}</td>
      <td>${o.type === "market" ? "市價" : "限價"}</td>
      <td>${o.limitPrice ? fmt(o.limitPrice, o.market === "crypto" ? 6 : 2) : "-"}</td>
      <td>${fmt(o.quantity, 8)}</td>
      <td><button data-cancel-order="${o.id}">取消</button></td>
    </tr>`
    )
    .join("");
  els.orders.innerHTML = p.orders?.length
    ? `<table>
      <thead>
        <tr><th>時間</th><th>市場</th><th>商品</th><th>方向</th><th>類型</th><th>限價</th><th>數量</th><th>操作</th></tr>
      </thead>
      <tbody>${orderRows}</tbody>
    </table>`
    : "目前沒有未成交委託。";

  const positionsRows = (p.positions || [])
    .map(
      (row) => `<tr>
        <td>${row.market.toUpperCase()}</td>
        <td>${row.symbol}</td>
        <td>${fmt(row.quantity, 8)}</td>
        <td>${fmt(row.freeQty, 8)}</td>
        <td>${fmt(row.reservedQty, 8)}</td>
        <td>${fmt(row.avgCost, row.market === "crypto" ? 6 : 2)}</td>
        <td>${fmt(row.currentPrice, row.market === "crypto" ? 6 : 2)}</td>
        <td>${fmt(row.value)}</td>
        <td class="${pnlClass(row.unrealizedPnl)}">${fmt(row.unrealizedPnl)}</td>
      </tr>`
    )
    .join("");

  els.positions.innerHTML = p.positions?.length
    ? `<table>
      <thead>
        <tr>
          <th>市場</th><th>商品</th><th>總數量</th><th>可賣</th><th>凍結</th><th>均價</th><th>現價</th><th>市值</th><th>未實現損益</th>
        </tr>
      </thead>
      <tbody>${positionsRows}</tbody>
    </table>`
    : "目前沒有持倉。";

  const tradeRows = (p.trades || [])
    .map(
      (t) => `<tr>
        <td>${new Date(t.timestamp).toLocaleString("zh-TW")}</td>
        <td>${t.market.toUpperCase()}</td>
        <td>${t.symbol}</td>
        <td>${t.side === "buy" ? "買進" : "賣出"}</td>
        <td>${t.orderType === "market" ? "市價" : "限價"}</td>
        <td>${fmt(t.quantity, 8)}</td>
        <td>${fmt(t.price, t.market === "crypto" ? 6 : 2)}</td>
        <td>${fmt(t.gross)}</td>
        <td>${fmt(t.fee)}</td>
        <td>${fmt(t.tax)}</td>
        <td class="${pnlClass(t.cashEffect)}">${fmt(t.cashEffect)}</td>
      </tr>`
    )
    .join("");

  els.trades.innerHTML = p.trades?.length
    ? `<table>
      <thead><tr><th>時間</th><th>市場</th><th>商品</th><th>方向</th><th>類型</th><th>數量</th><th>價格</th><th>成交額</th><th>手續費</th><th>交易稅</th><th>現金影響</th></tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>`
    : "尚無交易紀錄。";
}

async function refreshMarkets() {
  marketData = await api("/api/markets");
  renderMarkets();
  renderMarketSelect();
}

async function refreshPortfolio() {
  const p = await api("/api/portfolio");
  renderPortfolio(p);
}

async function boot() {
  await refreshMarkets();
  await refreshPortfolio();

  els.marketSelect.addEventListener("change", syncSymbolSelect);
  els.tradeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.tradeMsg.textContent = "";
    try {
      const type = els.typeSelect.value;
      const payload = {
        market: els.marketSelect.value,
        symbol: els.symbolSelect.value,
        side: els.sideSelect.value,
        type,
        quantity: Number(els.qtyInput.value),
      };
      if (type === "limit") {
        payload.limitPrice = Number(els.limitPriceInput.value);
      }
      await api("/api/order", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      els.tradeMsg.textContent = type === "limit" ? "限價單已送出" : "市價單已成交";
      await refreshMarkets();
      await refreshPortfolio();
    } catch (error) {
      els.tradeMsg.textContent = error.message;
    }
  });

  els.resetBtn.addEventListener("click", async () => {
    await api("/api/reset", { method: "POST" });
    await refreshMarkets();
    await refreshPortfolio();
    els.tradeMsg.textContent = "帳戶已重設";
  });

  els.typeSelect.addEventListener("change", () => {
    const isLimit = els.typeSelect.value === "limit";
    els.limitPriceWrap.style.display = isLimit ? "grid" : "none";
    els.limitPriceInput.required = isLimit;
  });

  document.addEventListener("click", async (e) => {
    const id = e.target?.dataset?.cancelOrder;
    if (!id) return;
    try {
      await api(`/api/orders/${id}/cancel`, { method: "POST" });
      els.tradeMsg.textContent = "委託已取消";
      await refreshPortfolio();
    } catch (error) {
      els.tradeMsg.textContent = error.message;
    }
  });

  setInterval(async () => {
    await refreshMarkets();
    await refreshPortfolio();
  }, 15000);
}

boot().catch((err) => {
  els.tradeMsg.textContent = err.message || "初始化失敗";
});
