// Cloudflare Worker AI relay for Megan — v3, adds a /research route backed
// by Tavily (built specifically for AI/agent use — clean, LLM-ready
// results, not raw search-engine links). Root path (/) is unchanged: the
// NVIDIA chat completion relay from before. AI_API_KEY (NVIDIA) is a
// Secrets Store binding needing .get() — confirmed from Cloudflare's docs,
// a plain-string read here silently sends "Bearer [object Object]".
// TAVILY_API_KEY is ALSO a Secrets Store binding (Cloudflare no longer
// offers plain classic Secrets in this UI) — needs the same .get() as
// AI_API_KEY above, confirmed by this exact route failing with
// "Unauthorized: missing or invalid API key" until this was added.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    query: String(query),
    search_depth: 'advanced',
    max_results: Math.min(10, Math.max(1, maxSources || 8)),
    include_answer: true,
    topic: 'general',
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
    // Trim to what's actually useful in a prompt — full raw_content per
    // result would bloat every single request for no real benefit here.
    const packet = {
      answer: raw.answer || null,
      results: (raw.results || []).map(r => ({ title: r.title, url: r.url, content: r.content, score: r.score })),
    };
    return new Response(JSON.stringify(packet), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Tavily fetch failed: ' + err.message }), { status: 502, headers: CORS });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/research') return handleResearch(request, env);
    return handleChat(request, env);
  },
};
