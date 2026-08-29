// Cloudflare Worker AI relay for Megan — v2, adds vision/image support.
// AI_ENDPOINT / AI_MODEL are plain vars (wrangler.toml). AI_API_KEY is a
// Secrets Store binding — needs .get(), confirmed from Cloudflare's docs
// (a plain string read here silently sent "Bearer [object Object]" to
// NVIDIA, which is exactly what a bare 401 with no detail looks like).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS });
    }

    const endpoint = env.AI_ENDPOINT;
    const model = env.AI_MODEL;
    if (!endpoint || !model || !env.AI_API_KEY) {
      return new Response(JSON.stringify({ error: 'AI_ENDPOINT, AI_API_KEY, or AI_MODEL not configured on this Worker' }), { status: 500, headers: CORS });
    }

    let apiKey;
    try {
      apiKey = await env.AI_API_KEY.get();
    } catch (err) {
      return new Response(JSON.stringify({ error: 'failed to read AI_API_KEY from Secrets Store: ' + err.message }), { status: 500, headers: CORS });
    }
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'AI_API_KEY resolved empty' }), { status: 500, headers: CORS });
    }

    let systemPrompt, userPrompt, history, attachments;
    try {
      const body = await request.json();
      systemPrompt = body.systemPrompt;
      userPrompt = body.userPrompt;
      history = body.history;
      attachments = body.attachments;
    } catch {
      return new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400, headers: CORS });
    }
    if (!userPrompt) {
      return new Response(JSON.stringify({ error: 'missing userPrompt' }), { status: 400, headers: CORS });
    }

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
        for (const url of imgs.slice(0, 4)) {
          content.push({ type: 'image_url', image_url: { url } });
        }
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: userPrompt });
      }

      const res = await fetch(endpoint.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ model, messages }),
      });

      const text = await res.text();
      return new Response(text, { status: res.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'relay fetch failed: ' + err.message }), { status: 502, headers: CORS });
    }
  },
};
