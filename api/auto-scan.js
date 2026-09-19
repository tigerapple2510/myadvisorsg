// Vercel Serverless Function — /api/auto-scan
// Runs on a daily cron (see vercel.json). Evaluates the same
// backtested Top-3 + Momentum gate logic used in the Engine tab,
// and sends a Telegram alert if a candidate clears gates 1-4.
//
// This function NEVER executes trades — paper trade state lives in
// the browser only. It just tells you when to open the app and
// review/approve a proposal.

export const config = { runtime: 'edge' };

const INSTRUMENTS = [
  { symbol:'NVDA',  name:'NVIDIA',           group:'stocks' },
  { symbol:'AAPL',  name:'Apple',            group:'stocks' },
  { symbol:'MSFT',  name:'Microsoft',        group:'stocks' },
  { symbol:'GOOGL', name:'Alphabet',         group:'stocks' },
  { symbol:'AMZN',  name:'Amazon',           group:'stocks' },
  { symbol:'META',  name:'Meta',             group:'stocks' },
  { symbol:'TSLA',  name:'Tesla',            group:'stocks' },
  { symbol:'JPM',   name:'JPMorgan',         group:'stocks' },
  { symbol:'BRK-B', name:'Berkshire',        group:'stocks' },
  { symbol:'LLY',   name:'Eli Lilly',        group:'stocks' },
  { symbol:'TSM',   name:'TSMC',             group:'stocks' },
  { symbol:'BABA',  name:'Alibaba',          group:'stocks' },
  { symbol:'D05.SI',name:'DBS Bank',         group:'stocks' },
  { symbol:'O39.SI',name:'OCBC',             group:'stocks' },
  { symbol:'Z74.SI',name:'SingTel',          group:'stocks' },
  { symbol:'JEPQ',  name:'JPM Nasdaq ETF',   group:'etfs'   },
  { symbol:'JEPI',  name:'JPM Premium ETF',  group:'etfs'   },
  { symbol:'SCHD',  name:'Schwab Div ETF',   group:'etfs'   },
  { symbol:'SDIV',  name:'Global Div ETF',   group:'etfs'   },
  { symbol:'O',     name:'Realty Income',    group:'etfs'   },
  { symbol:'QQQ',   name:'Nasdaq 100',       group:'etfs'   },
  { symbol:'TQQQ',  name:'3x Nasdaq',        group:'etfs'   },
  { symbol:'XLK',   name:'Tech Sector',      group:'etfs'   },
  { symbol:'ARKK',  name:'ARK Innovation',   group:'etfs'   },
  { symbol:'IBIT',  name:'iShares Bitcoin',  group:'etfs'   },
  { symbol:'VOO',   name:'S&P 500 ETF',      group:'etfs'   },
  { symbol:'AGG',   name:'US Bonds',         group:'etfs'   },
  { symbol:'GLD',   name:'Gold ETF',         group:'other', liveTicker:'GC=F' },
  { symbol:'IAU',   name:'iShares Gold',     group:'other', liveTicker:'GC=F' },
  { symbol:'VNQ',   name:'Real Estate ETF',  group:'etfs'   },
  { symbol:'SLV',   name:'Silver ETF',       group:'other', liveTicker:'SI=F' },
  { symbol:'USO',   name:'Oil Fund',         group:'other', liveTicker:'CL=F' },
  { symbol:'C38U.SI',name:'CapitaLand REIT', group:'etfs'   },
  { symbol:'SPY',   name:'S&P 500 ETF',      group:'etfs'   },
  { symbol:'DJP',   name:'Commodities Index',group:'other'  },
];

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a,b)=>a+b, 0) / period;
}
function calcRSI(closes, period=14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains/period, avgLoss = losses/period;
  if (avgLoss === 0) return 100;
  return 100 - 100/(1 + avgGain/avgLoss);
}
function calcMomentum(closes, period=20) {
  if (closes.length < period + 1) return null;
  const cur = closes[closes.length-1], past = closes[closes.length-1-period];
  return ((cur - past)/past) * 100;
}
function round(n, dp=2) { if (n==null || isNaN(n)) return null; return Math.round(n*10**dp)/10**dp; }

async function fetchOne(inst) {
  const ticker = inst.liveTicker || inst.symbol;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta   = result.meta;
    const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    const price  = meta.regularMarketPrice || closes[closes.length-1];
    return {
      price, sma50: calcSMA(closes,50), sma200: calcSMA(closes,200),
      rsi: calcRSI(closes,14), momentum: calcMomentum(closes,20),
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    };
  } catch (e) { return null; }
}

async function fetchFearGreed() {
  try {
    const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const json = await res.json();
    const val = json?.fear_and_greed?.score;
    return val ? Math.round(val) : 50;
  } catch (e) { return 50; }
}

function computeScore(data, fg) {
  const { price=0, sma50=price, sma200=price, rsi=50, momentum=0,
          fiftyTwoWeekHigh=price, fiftyTwoWeekLow=price } = data;
  const reasons = [];
  let score = 0;

  let rsiScore = 0;
  if      (rsi < 25) { rsiScore = 20; reasons.push(`RSI ${Math.round(rsi)} - deeply oversold`); }
  else if (rsi < 35) { rsiScore = 16; reasons.push(`RSI ${Math.round(rsi)} - oversold`); }
  else if (rsi < 50) { rsiScore = 12; }
  else if (rsi < 65) { rsiScore = 8; }
  else if (rsi < 75) { rsiScore = 4; }
  else               { rsiScore = 1; reasons.push(`RSI ${Math.round(rsi)} - overbought`); }
  score += rsiScore;

  let trendScore = 10;
  if (sma50 && sma200) {
    if (sma50 > sma200 && price > sma50) { trendScore = 19; reasons.push('Golden cross - all SMAs bullishly aligned'); }
    else if (sma50 > sma200)             { trendScore = 14; }
    else if (sma50 < sma200 && price < sma50) { trendScore = 2; reasons.push('Death cross - bearish trend'); }
    else { trendScore = 6; }
  }
  score += trendScore;

  let momScore = 10;
  if      (momentum > 20)  { momScore = 19; reasons.push(`Momentum +${momentum.toFixed(1)}% - strong uptrend`); }
  else if (momentum > 10)  { momScore = 15; }
  else if (momentum > 0)   { momScore = 12; }
  else if (momentum > -10) { momScore = 8; }
  else if (momentum > -20) { momScore = 5; }
  else                     { momScore = 1; reasons.push(`Momentum ${momentum.toFixed(1)}% - downtrend`); }
  score += momScore;

  let sentScore = 10;
  if      (fg < 20) sentScore = 20;
  else if (fg < 35) sentScore = 16;
  else if (fg < 50) sentScore = 12;
  else if (fg < 65) sentScore = 8;
  else if (fg < 80) sentScore = 4;
  else              sentScore = 2;
  score += sentScore;

  let posScore = 10;
  if (fiftyTwoWeekHigh && fiftyTwoWeekLow) {
    const range = fiftyTwoWeekHigh - fiftyTwoWeekLow;
    const pos   = range > 0 ? (price - fiftyTwoWeekLow) / range : 0.5;
    if      (pos < 0.2) posScore = 19;
    else if (pos < 0.4) posScore = 15;
    else if (pos < 0.6) posScore = 10;
    else if (pos < 0.8) posScore = 6;
    else                posScore = 2;
  }
  score += posScore;

  score = Math.round(Math.min(100, Math.max(0, score)));
  let signal;
  if      (score >= 80) signal = 'strong-buy';
  else if (score >= 65) signal = 'buy';
  else if (score >= 42) signal = 'hold';
  else                  signal = 'sell';

  return { score, signal, reasons: reasons.slice(0,3) };
}

export default async function handler(req) {
  // Optional protection: if CRON_SECRET is set in Vercel env, require it.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
  }

  const fg = await fetchFearGreed();

  // Fetch all instruments (sequential-ish batches to be gentle on Yahoo)
  const results = [];
  for (let i = 0; i < INSTRUMENTS.length; i += 6) {
    const batch = INSTRUMENTS.slice(i, i+6);
    const batchResults = await Promise.all(batch.map(async (inst) => {
      const data = await fetchOne(inst);
      if (!data || !data.price) return null;
      const { score, signal, reasons } = computeScore(data, fg);
      return { ...inst, ...data, score, signal, reasons };
    }));
    results.push(...batchResults.filter(Boolean));
  }

  // Gate 1: score >= 65 AND positive momentum, top 3
  const candidates = results
    .filter(s => s.score >= 65 && (s.momentum || 0) > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 3);

  const gate1 = candidates.length > 0;
  const best  = gate1 ? candidates[0] : null;

  // Gate 2: market regime via VOO/SPY
  const spySig = results.find(s => s.symbol === 'VOO') || results.find(s => s.symbol === 'SPY');
  let regimePassed = false, regime = 'No market data';
  if (spySig) {
    if      (spySig.score >= 65) { regime = 'Bull market'; regimePassed = true; }
    else if (spySig.score >= 42) { regime = 'Sideways';    regimePassed = gate1 && best.score >= 80; }
    else                         { regime = 'Bear market'; regimePassed = false; }
  }
  if (fg > 80) regimePassed = false;

  // Gate 3: smart money proxy
  let smCount = 0;
  if (fg < 40) smCount++;
  if (best && best.score >= 85) smCount++;
  if (best && best.rsi && best.rsi < 40) smCount++;
  const gate3 = smCount >= 2;

  // Gate 4: R:R >= 2.5:1
  const entry = best ? best.price : 0;
  const stopPct = best && best.group === 'crypto' ? 0.08 : 0.05;
  const stopPrice = entry ? +(entry * (1-stopPct)).toFixed(2) : 0;
  const risk = entry - stopPrice;
  const tpPrice = entry ? +(entry + risk*2.5).toFixed(2) : 0;
  const rr = risk > 0 ? +((tpPrice-entry)/(entry-stopPrice)).toFixed(2) : 0;
  const gate4 = rr >= 2.5;

  const allPassed = gate1 && regimePassed && gate3 && gate4;

  let alertSent = false;
  if (allPassed && best) {
    try {
      const origin = new URL(req.url).origin;
      const alertRes = await fetch(`${origin}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'engine_candidate',
          data: {
            symbol: best.symbol, name: best.name, score: best.score,
            price: entry, stop: stopPrice, tp: tpPrice, rr,
            reasons: best.reasons, regime, fg
          }
        })
      });
      alertSent = alertRes.ok;
    } catch (e) {}
  }

  return new Response(JSON.stringify({
    ok: true,
    scannedAt: new Date().toISOString(),
    instrumentsScanned: results.length,
    gate1, regimePassed, gate3, gate4, allPassed,
    best: best ? { symbol: best.symbol, score: best.score, momentum: best.momentum } : null,
    alertSent
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
