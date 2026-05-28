// Vercel Serverless Function — /api/market-data
// Also handles AI proxy when ?type=ai is passed

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');

  // ── AI Proxy ──────────────────────────────────────────────────────────────
  if (type === 'ai') {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    try {
      const body = await req.json();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: body.max_tokens || 1000,
          messages: body.messages,
        }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  // ── Market Data ───────────────────────────────────────────────────────────
  const symbol = (searchParams.get('symbol') || '').toUpperCase().trim();
  const source = searchParams.get('source') || 'yahoo';

  if (!symbol) {
    return new Response(JSON.stringify({ error: 'symbol required' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    if (source === 'alpaca') {
      return await handleAlpaca(symbol, CORS);
    }
    return await handleYahoo(symbol, CORS);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleYahoo(symbol, CORS) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const validCloses = closes.filter(c => c != null);
  const price = meta.regularMarketPrice || validCloses[validCloses.length - 1];
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const change = price - prevClose;
  const changePct = (change / prevClose) * 100;
  return new Response(JSON.stringify({
    symbol,
    price: round(price),
    change: round(change),
    changePct: round(changePct),
    sma50: round(calcSMA(validCloses, 50)),
    sma200: round(calcSMA(validCloses, 200)),
    rsi: round(calcRSI(validCloses, 14)),
    momentum: round(calcMomentum(validCloses, 20)),
    volume: meta.regularMarketVolume,
    marketCap: meta.marketCap,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    currency: meta.currency,
    exchangeName: meta.exchangeName,
    marketState: meta.marketState,
    source: 'yahoo',
    fetchedAt: Date.now(),
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleAlpaca(symbol, CORS) {
  const key = process.env.ALPACA_LIVE_KEY;
  const secret = process.env.ALPACA_LIVE_SECRET;
  if (!key || !secret) throw new Error('Alpaca keys not configured');
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 365 * 86400000).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&limit=250&feed=iex`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
  if (!res.ok) throw new Error(`Alpaca returned ${res.status}`);
  const json = await res.json();
  const bars = json.bars || [];
  const closes = bars.map(b => b.c);
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  return new Response(JSON.stringify({
    symbol,
    price: round(price),
    change: round(price - prevClose),
    changePct: round(((price - prevClose) / prevClose) * 100),
    sma50: round(calcSMA(closes, 50)),
    sma200: round(calcSMA(closes, 200)),
    rsi: round(calcRSI(closes, 14)),
    momentum: round(calcMomentum(closes, 20)),
    volume: bars[bars.length - 1]?.v,
    source: 'alpaca',
    fetchedAt: Date.now(),
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMomentum(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

function round(n, dp = 2) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
