export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PAPER_BASE = 'https://paper-api.alpaca.markets/v2';
const LIVE_BASE  = 'https://api.alpaca.markets/v2';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'paper';
  const endpoint = searchParams.get('endpoint') || 'account';

  const key    = mode === 'live' ? process.env.ALPACA_LIVE_KEY    : process.env.ALPACA_PAPER_KEY;
  const secret = mode === 'live' ? process.env.ALPACA_LIVE_SECRET : process.env.ALPACA_PAPER_SECRET;
  const base   = mode === 'live' ? LIVE_BASE : PAPER_BASE;

  if (!key || !secret) {
    return new Response(JSON.stringify({ error: `${mode} keys not configured in Vercel env` }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const headers = {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json',
  };

  try {
    if (req.method === 'GET') {
      const res = await fetch(`${base}/${endpoint}`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'POST' && endpoint === 'orders') {
      const body = await req.json();
      if (body.notional && parseFloat(body.notional) > 10000) {
        return new Response(JSON.stringify({ error: 'Order exceeds $10,000 safety limit' }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      const res = await fetch(`${base}/orders`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'DELETE' && endpoint === 'orders') {
      const orderId = searchParams.get('order_id');
      const url = orderId ? `${base}/orders/${orderId}` : `${base}/orders`;
      const res = await fetch(url, { method: 'DELETE', headers });
      const text = await res.text();
      return new Response(text || '{}', {
        status: res.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unsupported method' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
