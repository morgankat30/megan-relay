// Cloudflare Worker AI + research + Binance relay for Megan — v5.
// Root (/): NVIDIA chat completion. /research: Tavily search.
// /api/binance/*: faithful port of binance_relay.py — a stateless
// signer/forwarder. No server-side Binance secrets needed at all: the
// API key/secret travel WITH each request from the bot itself, exactly
// like the Python version did. This is why it's safe to run with zero
// extra Cloudflare setup, unlike the AI/research routes.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleChat(request, env) {
  const endpoint = env.AI_ENDPOINT;
  const model = env.AI_MODEL;
  if (!endpoint || !model || !env.AI_API_KEY) {
    return new Response(JSON.stringify({ error: 'AI_ENDPOINT, AI_API_KEY, or AI_MODEL not configured on this Worker' }), { status: 500, headers: CORS });
  }
  let apiKey;
  try { apiKey = await env.AI_API_KEY.get(); }
  catch (err) { return new Response(JSON.stringify({ error: 'failed to read AI_API_KEY from Secrets Store: ' + err.message }), { status: 500, headers: CORS }); }
  if (!apiKey) return new Response(JSON.stringify({ error: 'AI_API_KEY resolved empty' }), { status: 500, headers: CORS });

  let systemPrompt, userPrompt, history, attachments;
  try {
    const body = await request.json();
    systemPrompt = body.systemPrompt; userPrompt = body.userPrompt; history = body.history; attachments = body.attachments;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400, headers: CORS });
  }
  if (!userPrompt) return new Response(JSON.stringify({ error: 'missing userPrompt' }), { status: 400, headers: CORS });

  try {
    const messages = [{ role: 'system', content: systemPrompt || '' }];
    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
          messages.push({ role: turn.role, content: turn.content });
        }
      }
    }
    const imgs = Array.isArray(attachments) ? attachments.filter(a => typeof a === 'string' && a.startsWith('data:image')) : [];
    if (imgs.length) {
      const content = [{ type: 'text', text: userPrompt }];
      for (const url of imgs.slice(0, 4)) content.push({ type: 'image_url', image_url: { url } });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: userPrompt });
    }
    const res = await fetch(endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages }),
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'relay fetch failed: ' + err.message }), { status: 502, headers: CORS });
  }
}

async function handleResearch(request, env) {
  if (!env.TAVILY_API_KEY) {
    return new Response(JSON.stringify({ error: 'TAVILY_API_KEY not configured on this Worker' }), { status: 500, headers: CORS });
  }
  let tavilyKey;
  try { tavilyKey = await env.TAVILY_API_KEY.get(); }
  catch (err) { return new Response(JSON.stringify({ error: 'failed to read TAVILY_API_KEY from Secrets Store: ' + err.message }), { status: 500, headers: CORS }); }
  if (!tavilyKey) return new Response(JSON.stringify({ error: 'TAVILY_API_KEY resolved empty' }), { status: 500, headers: CORS });
  let query, domains, recencyDays, maxSources;
  try {
    const body = await request.json();
    query = body.query; domains = body.domains; recencyDays = body.recencyDays; maxSources = body.maxSources;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400, headers: CORS });
  }
  if (!query) return new Response(JSON.stringify({ error: 'missing query' }), { status: 400, headers: CORS });

  const tavilyBody = {
    query: String(query), search_depth: 'advanced',
    max_results: Math.min(10, Math.max(1, maxSources || 8)),
    include_answer: true, topic: 'general',
  };
  if (Array.isArray(domains) && domains.length) tavilyBody.include_domains = domains;
  if (typeof recencyDays === 'number' && recencyDays > 0) {
    if (recencyDays <= 1) tavilyBody.time_range = 'day';
    else if (recencyDays <= 7) tavilyBody.time_range = 'week';
    else if (recencyDays <= 31) tavilyBody.time_range = 'month';
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tavilyKey },
      body: JSON.stringify(tavilyBody),
    });
    const raw = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: raw.detail || raw.error || ('Tavily HTTP ' + res.status) }), { status: res.status, headers: CORS });
    }
    const packet = {
      answer: raw.answer || null,
      results: (raw.results || []).map(r => ({ title: r.title, url: r.url, content: r.content, score: r.score })),
    };
    return new Response(JSON.stringify(packet), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Tavily fetch failed: ' + err.message }), { status: 502, headers: CORS });
  }
}

// ---- Binance relay (faithful port of binance_relay.py) ----

const BN_SPOT_LIVE = 'https://api.binance.com', BN_SPOT_TEST = 'https://testnet.binance.vision';
const BN_FUT_LIVE = 'https://fapi.binance.com', BN_FUT_TEST = 'https://testnet.binancefuture.com';

function bnBase(testnet, market) {
  if (market === 'futures') return testnet ? BN_FUT_TEST : BN_FUT_LIVE;
  return testnet ? BN_SPOT_TEST : BN_SPOT_LIVE;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function bnReq(method, base, path, key, secret, params, signed) {
  params = params || {};
  signed = signed !== false;
  const p = new URLSearchParams();
  for (const k in params) if (params[k] !== undefined && params[k] !== null) p.append(k, params[k]);
  if (signed) { p.append('timestamp', Date.now().toString()); p.append('recvWindow', '5000'); }
  let qs = p.toString();
  if (signed) qs += '&signature=' + (await hmacSha256Hex(secret, qs));
  const url = base + path + (qs ? '?' + qs : '');
  const headers = {};
  if (key) headers['X-MBX-APIKEY'] = key;
  try {
    const res = await fetch(url, { method, headers });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: 'non-JSON response: ' + text.slice(0, 200) }; }
  } catch (err) {
    return { error: String(err) };
  }
}

async function handleBinance(request, env, path) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const key = body.apiKey || '', secret = body.apiSecret || '';
  const market = body.market || 'spot';
  const testnet = !!body.testnet;
  const base = bnBase(testnet, market);
  let result;

  if (market === 'futures') {
    if (path === '/api/binance/account') result = await bnReq('GET', base, '/fapi/v2/account', key, secret);
    else if (path === '/api/binance/exchangeInfo') result = await bnReq('GET', base, '/fapi/v1/exchangeInfo', key, secret, {}, false);
    else if (path === '/api/binance/klines') result = await bnReq('GET', base, '/fapi/v1/klines', key, secret, { symbol: body.symbol || '', interval: body.interval || '1m', limit: Math.min(parseInt(body.limit || 120, 10), 1500) }, false);
    else if (path === '/api/binance/leverage') result = await bnReq('POST', base, '/fapi/v1/leverage', key, secret, { symbol: body.symbol, leverage: parseInt(body.leverage || 3, 10) });
    else if (path === '/api/binance/order') {
      const params = { symbol: body.symbol, side: body.side, type: body.type || 'MARKET', newOrderRespType: body.newOrderRespType || 'RESULT' };
      for (const k of ['quantity', 'positionSide', 'reduceOnly', 'stopPrice', 'closePosition', 'workingType']) {
        if (body[k] !== undefined && body[k] !== null) params[k] = body[k];
      }
      result = await bnReq('POST', base, '/fapi/v1/order', key, secret, params);
    } else if (path === '/api/binance/protection') {
      const sym = body.symbol, side = body.side, closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const out = [];
      const pairs = [['STOP_MARKET', body.stopPrice], ['TAKE_PROFIT_MARKET', body.takeProfitPrice]];
      for (const [typ, price] of pairs) {
        if (!price) continue;
        out.push(await bnReq('POST', base, '/fapi/v1/order', key, secret, { symbol: sym, side: closeSide, positionSide: 'BOTH', type: typ, stopPrice: price, closePosition: 'true', workingType: 'MARK_PRICE' }));
      }
      result = { orders: out };
    } else if (path === '/api/binance/positionRisk') result = await bnReq('GET', base, '/fapi/v2/positionRisk', key, secret, { symbol: body.symbol || '' });
    else result = { error: 'unknown futures endpoint' };
  } else {
    if (path === '/api/binance/account') result = await bnReq('GET', base, '/api/v3/account', key, secret);
    else if (path === '/api/binance/order') result = await bnReq('POST', base, '/api/v3/order', key, secret, { symbol: body.symbol, side: body.side, type: 'MARKET', quantity: body.quantity, newOrderRespType: body.newOrderRespType || 'RESULT' });
    else if (path === '/api/binance/exchangeInfo') result = await bnReq('GET', base, '/api/v3/exchangeInfo', key, secret, { symbol: body.symbol || '' }, false);
    else if (path === '/api/binance/klines') result = await bnReq('GET', base, '/api/v3/klines', key, secret, { symbol: body.symbol || '', interval: body.interval || '1m', limit: Math.min(parseInt(body.limit || 120, 10), 1000) }, false);
    else result = { error: 'unknown spot endpoint' };
  }
  return new Response(JSON.stringify(result), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/binance/')) return handleBinance(request, env, url.pathname);
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS });
    if (url.pathname === '/research') return handleResearch(request, env);
    return handleChat(request, env);
  },
};
