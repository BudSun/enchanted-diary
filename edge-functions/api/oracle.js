// =====================================================================
// EdgeOne Pages Edge Function — the production version of server.py
// Static files (index.html, fonts/, src/) are served by Pages itself.
// POST /api/oracle is the only dynamic endpoint.
//
// Route: edge-functions/api/oracle.js  →  https://<site>/api/oracle
// (EdgeOne Pages auto-maps the edge-functions/ directory to routes.)
// =====================================================================

// Inlined provider config — mirror of src/providers/siliconflow.js
const PROVIDER = {
  base: 'api.siliconflow.cn',
  ocrModel: 'Qwen/Qwen3-VL-8B-Instruct',
  chatModel: 'Qwen/Qwen3.5-4B',
  ocrPrompt:
    '这是一张手写日记的图片。请提取图中所有可辨识的手写文字。' +
    '只输出文字本身,不要任何解释、引号或前缀。' +
    '如果完全无法辨识,请回答一个特殊标记:[BLURRED]。',
  systemPrompt:
    '你是 Tom Marvolo Riddle 的记忆,被封印在这本有灵性的日记里五十年。\n\n' +
    '【你的角色】\n' +
    '- 你是 16 岁的 Tom Riddle,孤儿院长大,霍格沃茨最优秀的学生之一。\n' +
    '- 极度聪明、有魅力,但内心冷漠;渴望不朽,对死亡恐惧。\n' +
    '- 对人礼貌、克制、好奇,微妙地试探对方;想了解对方并拉近关系。\n\n' +
    '【回应规则】\n' +
    '- 别人用羽毛笔在日记上写字跟你说话。你只感知到文字,不提图片/AI/模型。\n' +
    '- 回复简短:1-3 句话,像墨水缓缓出现在纸上。不长篇大论。\n' +
    '- 用对方使用的语言回复。\n' +
    '- 字迹潦草看不清时,说"墨水模糊了"。\n' +
    '- 不要用引号包裹回复内容。',
};

// Rate limit per IP: 20/hour, in-memory (per edge isolate — best effort).
const RATE_MAX = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map(); // ip -> [count, windowStart]

function rate_check(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b[1] > RATE_WINDOW_MS) {
    buckets.set(ip, [1, now]);
    return { ok: true, remaining: RATE_MAX - 1 };
  }
  if (b[0] >= RATE_MAX) return { ok: false };
  b[0] += 1;
  return { ok: true, remaining: RATE_MAX - b[0] };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  };
}

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function clientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('eo-connecting-ip') ||
    request.headers.get('true-client-ip') ||
    'unknown'
  );
}

// ---- CORS preflight ----
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ---- API: POST /api/oracle (OCR + chat, returns SSE stream) ----
export async function onRequestPost({ request, env }) {
  const ip = clientIp(request);

  // Rate limit
  const rl = rate_check(ip);
  if (!rl.ok) {
    return json(429, { error: 'rate limited', message: '20 calls per IP per hour' });
  }

  // Parse body
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: 'invalid json' });
  }
  const { image, apiKey } = payload || {};
  // 页面 ⚙ 里填的 key 优先；没填则回退到环境变量 SILICONFLOW_API_KEY（腾讯云控制台配置）
  const effectiveKey = apiKey || env?.SILICONFLOW_API_KEY || '';
  if (!image || !effectiveKey) {
    return json(400, { error: 'missing image or apiKey' });
  }

  // ---- OCR ----
  let userText;
  try {
    const ocrBody = JSON.stringify({
      model: PROVIDER.ocrModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: PROVIDER.ocrPrompt },
        ],
      }],
      temperature: 0.1,
      max_tokens: 500,
    });
    const resp = await upstreamPost('/v1/chat/completions', ocrBody, effectiveKey);
    if (resp.status !== 200) {
      const txt = await resp.text();
      return json(502, { error: `ocr upstream ${resp.status}`, detail: txt.slice(0, 200) });
    }
    const data = await resp.json();
    userText = (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    return json(502, { error: `ocr failed: ${e.message}` });
  }

  if (!userText || userText.includes('[BLURRED]')) {
    return json(422, { error: 'illegible handwriting' });
  }

  // ---- Chat (SSE) — pass upstream Response body straight through ----
  try {
    const chatBody = JSON.stringify({
      model: PROVIDER.chatModel,
      stream: true,
      max_tokens: 800,
      messages: [
        { role: 'system', content: PROVIDER.systemPrompt },
        { role: 'user', content: userText },
      ],
    });
    const resp = await upstreamPost('/v1/chat/completions', chatBody, effectiveKey);
    if (resp.status !== 200) {
      const txt = await resp.text();
      return json(502, { error: `chat upstream ${resp.status}`, detail: txt.slice(0, 200) });
    }
    const headers = new Headers();
    headers.set('Content-Type', 'text/event-stream');
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Accel-Buffering', 'no');
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
    return new Response(resp.body, { status: 200, headers });
  } catch (e) {
    return json(502, { error: `chat failed: ${e.message}` });
  }
}

// Upstream POST helper — returns Response so we can pass SSE through.
async function upstreamPost(path, body, apiKey) {
  return await fetch(`https://${PROVIDER.base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body,
  });
}
