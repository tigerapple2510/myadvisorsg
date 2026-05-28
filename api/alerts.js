// Vercel Serverless Function — /api/alerts
// Sends Telegram alerts for Iconium Trade signals
// Set in Vercel env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return new Response(JSON.stringify({ error: 'Telegram env vars not configured' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { type, data } = body;

    let message = '';

    if (type === 'signal_alert') {
      const { symbol, score, signal, price, rsi, momentum, reason } = data;
      const emoji = score >= 80 ? '🚨' : '⚡';
      const signalLabel = signal === 'strong-buy' ? '⚡ STRONG BUY' : '✓ BUY';
      message = `${emoji} *ICONIUM ALERT*\n\n` +
        `*${symbol}* — ${signalLabel}\n` +
        `Score: *${score}/100*\n` +
        `Price: $${price}\n` +
        `RSI: ${rsi} | Momentum: ${momentum}%\n\n` +
        `📌 ${reason || 'Signal threshold crossed'}\n\n` +
        `_Iconium Trade · Paper Mode_`;
    }

    else if (type === 'bulk_alert') {
      const { signals, mode } = data;
      const topSignals = signals.slice(0, 5);
      const lines = topSignals.map(s =>
        `• *${s.symbol}* — Score ${s.score}/100 — $${s.price}`
      ).join('\n');
      message = `⚡ *ICONIUM SIGNAL SUMMARY*\n\n` +
        `*${signals.length} Buy Signals Active*\n\n` +
        `${lines}\n\n` +
        `Mode: ${mode === 'live' ? '🔴 LIVE' : '📝 Paper'}\n` +
        `_Iconium Trade · ${new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })} SGT_`;
    }

    else if (type === 'earnings_alert') {
      const { symbol, date, time, expectedMove, score, price, epsEstimate } = data;
      const timeLabel = time === 'bmo' ? 'Before Market Open 🌅' : 'After Market Close 🌆';
      message = `📅 *EARNINGS ALERT*\n\n` +
        `*${symbol}* reports ${date}\n` +
        `${timeLabel}\n\n` +
        `Expected Move: *±${expectedMove}%*\n` +
        `Current Price: $${price}\n` +
        `Implied Range: $${(price*(1-expectedMove/100)).toFixed(2)} – $${(price*(1+expectedMove/100)).toFixed(2)}\n` +
        `EPS Estimate: $${epsEstimate}\n` +
        `Iconium Score: *${score}/100*\n\n` +
        `⚠️ Consider position sizing before earnings\n` +
        `_Iconium Trade · Earnings Calendar_`;
    }

    else if (type === 'morning_brief') {
      const { strongBuys, buys, topSignal, fearGreed, date } = data;
      message = `☀️ *ICONIUM MORNING BRIEF*\n` +
        `_${date} · Singapore_\n\n` +
        `📊 Fear & Greed: *${fearGreed}*\n\n` +
        `🟢 Strong Buy: *${strongBuys}* signals\n` +
        `🔵 Buy: *${buys}* signals\n\n` +
        `🏆 Top Signal: *${topSignal.symbol}* (${topSignal.score}/100)\n` +
        `   Price: $${topSignal.price} | RSI: ${topSignal.rsi}\n\n` +
        `_Open Iconium Trade to execute →_\n` +
        `https://myadvisorsg.vercel.app`;
    }

    else if (type === 'test') {
      message = `✅ *Iconium Trade Connected!*\n\n` +
        `Your Telegram alerts are working.\n\n` +
        `You'll receive:\n` +
        `• 🚨 Strong Buy alerts (score 80+)\n` +
        `• 📅 Earnings reminders\n` +
        `• ☀️ Morning briefings (9am SGT)\n` +
        `• 🔴 Live trade confirmations\n\n` +
        `_Iconium Trade v2.0_`;
    }

    else {
      return new Response(JSON.stringify({ error: 'Unknown alert type' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) throw new Error(tgData.description || 'Telegram error');

    return new Response(JSON.stringify({ ok: true, message_id: tgData.result?.message_id }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
