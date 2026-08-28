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
    const apiKey = env.AI_API_KEY;
    const model = env.AI_MODEL;
    if (!endpoint || !apiKey || !model) {
      return new Response(JSON.stringify({ error: 'AI_ENDPOINT, AI_API_KEY, or AI_MODEL not configured on this Worker' }), { status: 500, headers: CORS });
    }

    let systemPrompt, userPrompt, history;
    try {
      const body = await request.json();
      systemPrompt = body.systemPrompt;
      userPrompt = body.userPrompt;
      history = body.history;
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
      messages.push({ role: 'user', content: userPrompt });

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
