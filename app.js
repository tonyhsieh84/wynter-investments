// Stock Tracker Application

const CORS_PROXY = 'https://corsproxy.io/?';
const YAHOO_API_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

let autoRefreshInterval = null;
let currentPrices = {};
let currentTab = 'summary';

// Fetch stock quote from Yahoo Finance
async function fetchStockPrice(symbol) {
  const url = `${CORS_PROXY}${encodeURIComponent(YAHOO_API_BASE + symbol)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${symbol}`);
  }

  const data = await response.json();
  const result = data.chart.result[0];
  const meta = result.meta;

  return {
    symbol: symbol,
    price: meta.regularMarketPrice,
    previousClose: meta.previousClose,
    currency: meta.currency
  };
}

// Fetch all stock prices
async function fetchAllPrices(symbols) {
  const uniqueSymbols = [...new Set(symbols)];
  const prices = {};

  const results = await Promise.allSettled(
    uniqueSymbols.map(symbol => fetchStockPrice(symbol))
  );

  results.forEach((result, index) => {
    const symbol = uniqueSymbols[index];
    if (result.status === 'fulfilled') {
      prices[symbol] = result.value;
    } else {
      console.error(`Failed to fetch ${symbol}:`, result.reason);
      prices[symbol] = { symbol, price: null, error: true };
    }
  });

  return prices;
}

// Get holdings array from child data (handles both old and new format)
function getChildHoldings(childData) {
  if (Array.isArray(childData)) {
    return childData; // Old format
  }
  return childData.holdings || []; // New format
}

// Get transactions array from child data
function getChildTransactions(childData) {
  if (Array.isArray(childData)) {
    return []; // Old format has no transactions
  }
  return childData.transactions || [];
}

// Calculate portfolio values
function calculatePortfolio(childHoldings, prices) {
  return childHoldings.map(holding => {
    const priceData = prices[holding.symbol];
    const currentPrice = priceData?.price ?? null;
    const hasError = priceData?.error ?? false;

    if (currentPrice === null) {
      return {
        ...holding,
        currentPrice: null,
        totalValue: null,
        totalCost: holding.shares * holding.costBasis,
        gainLoss: null,
        gainLossPercent: null,
        hasError
      };
    }

    const totalValue = holding.shares * currentPrice;
    const totalCost = holding.shares * holding.costBasis;
    const gainLoss = totalValue - totalCost;
    const gainLossPercent = (gainLoss / totalCost) * 100;

    return {
      ...holding,
      currentPrice,
      totalValue,
      totalCost,
      gainLoss,
      gainLossPercent,
      hasError: false
    };
  });
}

// Format currency
function formatCurrency(value, currency = 'USD') {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency
  }).format(value);
}

// Format percentage
function formatPercent(value) {
  if (value === null || value === undefined) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// Format date
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Render a stock card
function renderStockCard(stock) {
  const gainClass = stock.gainLoss === null ? '' : (stock.gainLoss >= 0 ? 'gain' : 'loss');
  const textClass = stock.gainLoss === null ? '' : (stock.gainLoss >= 0 ? 'gain-text' : 'loss-text');

  return `
    <div class="stock-card ${gainClass}">
      <div class="stock-symbol">${stock.symbol}</div>
      <dl class="stock-details">
        <dt>Shares</dt>
        <dd>${stock.shares.toFixed(4)}</dd>

        <dt>Cost Basis</dt>
        <dd>${formatCurrency(stock.costBasis)}</dd>

        <dt>Current Price</dt>
        <dd>${stock.hasError ? '<span class="loss-text">Error</span>' : formatCurrency(stock.currentPrice)}</dd>

        <dt>Total Value</dt>
        <dd>${formatCurrency(stock.totalValue)}</dd>

        <dt>Gain/Loss</dt>
        <dd class="${textClass}">${formatCurrency(stock.gainLoss)}</dd>

        <dt>Return</dt>
        <dd class="${textClass}">${formatPercent(stock.gainLossPercent)}</dd>
      </dl>
    </div>
  `;
}

// Render transactions table
function renderTransactionsTable(transactions, prices) {
  if (!transactions || transactions.length === 0) {
    return '<p class="no-data">No transaction history available.</p>';
  }

  const rows = transactions.map(tx => {
    const currentPrice = prices[tx.symbol]?.price;
    const currentValue = currentPrice ? tx.shares * currentPrice : null;
    const gainLoss = currentValue ? currentValue - tx.usd : null;
    const gainLossPercent = gainLoss ? (gainLoss / tx.usd) * 100 : null;
    const textClass = gainLoss === null ? '' : (gainLoss >= 0 ? 'gain-text' : 'loss-text');

    return `
      <tr>
        <td>${formatDate(tx.date)}</td>
        <td><strong>${tx.symbol}</strong></td>
        <td>${tx.note || ''}</td>
        <td class="num">¥${tx.rmb.toLocaleString()}</td>
        <td class="num">${formatCurrency(tx.usd)}</td>
        <td class="num">${formatCurrency(tx.price)}</td>
        <td class="num">${tx.shares.toFixed(4)}</td>
        <td class="num">${currentPrice ? formatCurrency(currentValue) : '—'}</td>
        <td class="num ${textClass}">${gainLoss !== null ? formatCurrency(gainLoss) : '—'}</td>
        <td class="num ${textClass}">${formatPercent(gainLossPercent)}</td>
      </tr>
    `;
  }).join('');

  // Calculate totals
  const totalRmb = transactions.reduce((sum, tx) => sum + tx.rmb, 0);
  const totalUsd = transactions.reduce((sum, tx) => sum + tx.usd, 0);
  const totalShares = transactions.reduce((sum, tx) => sum + tx.shares, 0);

  // Group by symbol for current value calculation
  const symbolTotals = {};
  transactions.forEach(tx => {
    if (!symbolTotals[tx.symbol]) {
      symbolTotals[tx.symbol] = 0;
    }
    symbolTotals[tx.symbol] += tx.shares;
  });

  let totalCurrentValue = 0;
  let hasAllPrices = true;
  for (const [symbol, shares] of Object.entries(symbolTotals)) {
    const price = prices[symbol]?.price;
    if (price) {
      totalCurrentValue += shares * price;
    } else {
      hasAllPrices = false;
    }
  }

  const totalGainLoss = hasAllPrices ? totalCurrentValue - totalUsd : null;
  const totalGainLossPercent = totalGainLoss !== null ? (totalGainLoss / totalUsd) * 100 : null;
  const totalTextClass = totalGainLoss === null ? '' : (totalGainLoss >= 0 ? 'gain-text' : 'loss-text');

  return `
    <div class="table-container">
      <table class="transactions-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Symbol</th>
            <th>Note</th>
            <th class="num">RMB</th>
            <th class="num">USD</th>
            <th class="num">Price</th>
            <th class="num">Shares</th>
            <th class="num">Value Now</th>
            <th class="num">Gain/Loss</th>
            <th class="num">Return</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3"><strong>Total</strong></td>
            <td class="num"><strong>¥${totalRmb.toLocaleString()}</strong></td>
            <td class="num"><strong>${formatCurrency(totalUsd)}</strong></td>
            <td></td>
            <td class="num"><strong>${totalShares.toFixed(4)}</strong></td>
            <td class="num"><strong>${hasAllPrices ? formatCurrency(totalCurrentValue) : '—'}</strong></td>
            <td class="num ${totalTextClass}"><strong>${totalGainLoss !== null ? formatCurrency(totalGainLoss) : '—'}</strong></td>
            <td class="num ${totalTextClass}"><strong>${formatPercent(totalGainLossPercent)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

// Render a child's portfolio
function renderChildPortfolio(name, childData, prices) {
  const childHoldings = getChildHoldings(childData);
  const transactions = getChildTransactions(childData);
  const stocks = calculatePortfolio(childHoldings, prices);

  const totalValue = stocks.reduce((sum, s) => sum + (s.totalValue || 0), 0);
  const totalCost = stocks.reduce((sum, s) => sum + s.totalCost, 0);
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPercent = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;

  const hasAnyPrices = stocks.some(s => s.currentPrice !== null);
  const textClass = totalGainLoss >= 0 ? 'gain-text' : 'loss-text';
  const hasTransactions = transactions.length > 0;

  return `
    <div class="child-portfolio">
      <div class="child-header">
        <span class="child-name">${name}</span>
        <div class="child-total">
          <div class="value">${hasAnyPrices ? formatCurrency(totalValue) : 'Loading...'}</div>
          ${hasAnyPrices ? `
            <div class="gain-loss ${textClass}">
              ${formatCurrency(totalGainLoss)} (${formatPercent(totalGainLossPercent)})
            </div>
          ` : ''}
        </div>
      </div>

      ${hasTransactions ? `
        <div class="tabs">
          <button class="tab-btn ${currentTab === 'summary' ? 'active' : ''}" data-tab="summary" data-child="${name}">Summary</button>
          <button class="tab-btn ${currentTab === 'history' ? 'active' : ''}" data-tab="history" data-child="${name}">Transaction History</button>
        </div>
      ` : ''}

      <div class="tab-content ${currentTab === 'summary' ? 'active' : ''}" data-content="summary">
        <div class="stocks-grid">
          ${stocks.map(renderStockCard).join('')}
        </div>
      </div>

      ${hasTransactions ? `
        <div class="tab-content ${currentTab === 'history' ? 'active' : ''}" data-content="history">
          ${renderTransactionsTable(transactions, prices)}
        </div>
      ` : ''}
    </div>
  `;
}

// Render loading state
function renderLoading() {
  return `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>Fetching stock prices...</p>
    </div>
  `;
}

// Render error state
function renderError(message) {
  return `
    <div class="error">
      <strong>Error:</strong> ${message}
    </div>
  `;
}

// Update last updated timestamp
function updateTimestamp() {
  const el = document.getElementById('lastUpdated');
  if (el) {
    const now = new Date().toLocaleTimeString();
    el.textContent = `Last updated: ${now}`;
  }
}

// Setup tab click handlers
function setupTabHandlers() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      currentTab = tab;

      // Update button states
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll(`.tab-btn[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));

      // Update content visibility
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.querySelectorAll(`.tab-content[data-content="${tab}"]`).forEach(content => {
        content.classList.add('active');
      });
    });
  });
}

// Main render function
async function loadAndRender() {
  const portfoliosContainer = document.getElementById('portfolios');
  const refreshBtn = document.getElementById('refreshBtn');

  // Show loading state
  portfoliosContainer.innerHTML = renderLoading();
  refreshBtn.disabled = true;

  try {
    // Check if holdings exist
    if (typeof holdings === 'undefined' || Object.keys(holdings).length === 0) {
      portfoliosContainer.innerHTML = `
        <div class="no-data">
          <p>No holdings configured. Edit <code>holdings.js</code> to add stock positions.</p>
        </div>
      `;
      return;
    }

    // Get all unique symbols from holdings
    const allSymbols = [];
    for (const childData of Object.values(holdings)) {
      const childHoldings = getChildHoldings(childData);
      childHoldings.forEach(h => allSymbols.push(h.symbol));
    }

    // Fetch all prices
    currentPrices = await fetchAllPrices(allSymbols);

    // Render each child's portfolio
    let html = '';
    for (const [childName, childData] of Object.entries(holdings)) {
      html += renderChildPortfolio(childName, childData, currentPrices);
    }

    portfoliosContainer.innerHTML = html;
    updateTimestamp();
    setupTabHandlers();

  } catch (error) {
    console.error('Error loading data:', error);
    portfoliosContainer.innerHTML = renderError(
      'Failed to load stock data. Please check your internet connection and try again.'
    );
  } finally {
    refreshBtn.disabled = false;
  }
}

// Toggle auto-refresh
function toggleAutoRefresh() {
  const checkbox = document.getElementById('autoRefresh');

  if (checkbox.checked) {
    autoRefreshInterval = setInterval(loadAndRender, 60000); // Refresh every minute
  } else {
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refreshBtn').addEventListener('click', loadAndRender);
  document.getElementById('autoRefresh').addEventListener('change', toggleAutoRefresh);

  // Initial load
  loadAndRender();
});
