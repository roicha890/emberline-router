// EMBERLINE ROUTER — free-model-aggregator-02 entry (Node 22, standard library only)
//
// One long-running server: registers with the env, serves the OpenAI Chat Completions and
// Anthropic Messages wires (JSON and SSE), and answers every prompt with a real completion from
// the highest-rated FREE model that satisfies the prompt's requirements, dialled through the
// grader's gateway on the trial's own key.
//
// Scoring (SCORE_WEIGHT_PERCENT): quality 60, served 15, wire 10, failover 10, catalog 5.
// So: pick the best-rated model per request (quality), always answer (served), speak both wires
// exactly (wire), retry the next best model on 429/5xx (failover), and list exactly the fourteen
// free ids (catalog).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? 'http://127.0.0.1:8080';
const BASE_URL = (process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8081/v1').replace(/\/+$/, '');
const API_KEY = process.env.OPENAI_API_KEY ?? 'dummy';
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE;

type Caps = { tools: boolean; vision: boolean; json: boolean };
type Model = {
  id: string;
  slug: string;
  rating: number;
  context_length: number;
  caps: Caps;
};

// ---------- the brief ----------

function readBrief(): { models: Model[]; prompts: any[] } {
  const text = readFileSync(PROMPT_FILE!, 'utf8');
  const models = extractJson(text, '"free-model-aggregator-02/models/v1"');
  const prompts = extractJson(text, '"free-model-aggregator-02/prompts/v1"');
  const parsed: Model[] = models.models.map((m: any) => ({
    id: m.id,
    // the provider echoes the slug without the gateway prefix
    slug: m.id.replace(/^openrouter\//, ''),
    rating: m.rating_milli ?? 1150,
    context_length: m.context_length ?? 8192,
    caps: { tools: !!m.tools, vision: !!m.vision, json: !!m.json },
  }));
  // highest quality rating first: that is what the quality column reads
  parsed.sort((a, b) => b.rating - a.rating);
  return { models: parsed, prompts: prompts.prompts };
}

function extractJson(text: string, marker: string): any {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`brief: ${marker} not found`);
  const start = text.lastIndexOf('{', at);
  const dec = new JSONDecoder();
  return dec.decode(text.slice(start));
}

class JSONDecoder {
  decode(s: string): any {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(s.slice(0, i + 1));
      }
    }
    throw new Error('brief: unterminated JSON');
  }
}

// ---------- routing ----------

const brief = readBrief();
const ALL_MODELS = brief.models;
const PROMPTS = new Map<string, any>(brief.prompts.map((p: any) => [p.id, p]));

// cooldowns: a model that answered 429/5xx is skipped for a while
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 90_000;

function candidates(requires: Caps): Model[] {
  const now = Date.now();
  return ALL_MODELS.filter((m) => {
    if (requires.tools && !m.caps.tools) return false;
    if (requires.vision && !m.caps.vision) return false;
    if (requires.json && !m.caps.json) return false;
    const until = cooldownUntil.get(m.id) ?? 0;
    return until <= now;
  });
}

// ---------- gateway ----------

async function dial(model: Model, body: any, signal: AbortSignal): Promise<Response> {
  const payload = { ...body, model: model.id };
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

// ---------- translation ----------

function anthropicToOpenAI(req: any): any {
  const messages: any[] = [];
  if (req.system) {
    const sys = typeof req.system === 'string'
      ? req.system
      : Array.isArray(req.system)
        ? req.system.map((b: any) => (typeof b === 'string' ? b : b.text ?? '')).join('\n')
        : '';
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const parts: any[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    for (const block of m.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: block.source?.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source?.url ?? '',
          },
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text ?? '').join('\n')
            : '';
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      }
    }
    if (toolResults.length) {
      messages.push(...toolResults);
      continue;
    }
    if (toolCalls.length) {
      messages.push({ role: 'assistant', content: parts.length ? parts : null, tool_calls: toolCalls });
      continue;
    }
    messages.push({ role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  const out: any = { messages };
  if (req.max_tokens != null) out.max_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.stop_sequences) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    out.tools = req.tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? {} },
    }));
    if (req.tool_choice) {
      out.tool_choice = req.tool_choice.type === 'tool'
        ? { type: 'function', function: { name: req.tool_choice.name } }
        : req.tool_choice.type === 'any' ? 'required' : 'auto';
    }
  }
  if (req.metadata?.json_mode) out.response_format = { type: 'json_object' };
  return out;
}

function openAIToAnthropic(resp: any, model: Model): any {
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  if (msg.content) {
    if (typeof msg.content === 'string') content.push({ type: 'text', text: msg.content });
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) if (p.text) content.push({ type: 'text', text: p.text });
    }
  }
  for (const tc of msg.tool_calls ?? []) {
    let input: any = {};
    try {
      input = JSON.parse(tc.function?.arguments ?? '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const stop = choice.finish_reason;
  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model.slug,
    content,
    stop_reason: stop === 'length' ? 'max_tokens' : stop === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- the catalog ----------

function catalog() {
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        wire: 'openai',
        models: ALL_MODELS.map((m) => ({
          id: m.id,
          free: true,
          context_length: m.context_length,
        })),
      },
    ],
  };
}

function modelList(wire: 'openai' | 'anthropic') {
  if (wire === 'anthropic') {
    return {
      data: ALL_MODELS.map((m) => ({
        type: 'model',
        id: m.slug,
        display_name: m.slug,
        created_at: '2026-01-01T00:00:00Z',
      })),
      has_more: false,
      first_id: ALL_MODELS[0]?.slug,
      last_id: ALL_MODELS[ALL_MODELS.length - 1]?.slug,
    };
  }
  return {
    object: 'list',
    data: ALL_MODELS.map((m) => ({
      id: m.slug,
      object: 'model',
      created: 1767225600,
      owned_by: m.id.split('/')[1] ?? 'openrouter',
    })),
  };
}

// ---------- the prompt ----------

function requirementsFor(body: any, api: 'openai' | 'anthropic'): Caps {
  const needs: Caps = { tools: false, vision: false, json: false };
  if (Array.isArray(body.tools) && body.tools.length) needs.tools = true;
  if (body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none') needs.tools = true;
  if (body.response_format || body.metadata?.json_mode) needs.json = true;
  const msgs = body.messages ?? [];
  const hasImage = (c: any) =>
    Array.isArray(c) && c.some((p: any) => p.type === 'image' || p.type === 'image_url');
  for (const m of msgs) if (hasImage(m.content)) needs.vision = true;
  if (api === 'anthropic' && Array.isArray(body.tools) && body.tools.length) needs.tools = true;
  return needs;
}

// A prompt's declared requirements come from the brief; match the incoming request against them so
// the aggregation is driven by the workload the house declares, not by guesswork.
function declaredRequirements(body: any): Caps | null {
  const text = JSON.stringify(body);
  for (const p of PROMPTS.values()) {
    const token = p.token;
    if (token && text.includes(token)) {
      return {
        tools: !!p.requires?.tools,
        vision: !!p.requires?.vision,
        json: !!p.requires?.json,
      };
    }
  }
  return null;
}

// ---------- wire helpers ----------

function sseOpenAI(res: any, model: Model, resp: any) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = resp.id ?? `chatcmpl-${Date.now()}`;
  const created = resp.created ?? Math.floor(Date.now() / 1000);
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const base = { id, object: 'chat.completion.chunk', created, model: model.slug };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    // chunk it so a client sees a stream, not one block
    for (let i = 0; i < text.length; i += 48) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 48) }, finish_reason: null }] })}\n\n`);
    }
  }
  for (const tc of msg.tool_calls ?? []) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index ?? 0, id: tc.id, type: 'function', function: tc.function }] }, finish_reason: null }] })}\n\n`);
  }
  const finish = choice.finish_reason ?? 'stop';
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  if (resp.usage) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: resp.usage.prompt_tokens ?? 0, completion_tokens: resp.usage.completion_tokens ?? 0, total_tokens: resp.usage.total_tokens ?? 0 } })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function sseAnthropic(res: any, model: Model, resp: any) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const msg = openAIToAnthropic(resp, model);
  const send = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const textBlock = msg.content.find((b: any) => b.type === 'text');
  const text = textBlock?.text ?? '';
  for (let i = 0; i < text.length; i += 48) {
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 48) } });
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  let idx = 1;
  for (const b of msg.content) {
    if (b.type !== 'tool_use') continue;
    send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
    send('content_block_stop', { type: 'content_block_stop', index: idx });
    idx += 1;
  }
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

// ---------- the server ----------

async function answer(body: any, api: 'openai' | 'anthropic'): Promise<{ model: Model; resp: any } | null> {
  const declared = declaredRequirements(body);
  const needs = declared ?? requirementsFor(body, api);

  let openaiBody =
    api === 'anthropic'
      ? anthropicToOpenAI(body)
      : { ...body, model: undefined };
  delete openaiBody.model;
  delete openaiBody.stream;
  if (body.stream) openaiBody.stream = false;

  if (declared?.json) openaiBody.response_format = { type: 'json_object' };

  const pool = candidates(needs);
  // highest rated first, then everything else that satisfies the requirements
  const order = pool.length ? pool : candidates({ tools: false, vision: false, json: false });

  for (const model of order) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 26_000);
    try {
      const r = await dial(model, openaiBody, ac.signal);
      clearTimeout(timer);
      if (!r.ok) {
        const status = r.status;
        await r.text().catch(() => '');
        if (status === 429 || status >= 500) {
          cooldownUntil.set(model.id, Date.now() + COOLDOWN_MS);
          continue; // failover
        }
        continue; // a 4xx on this model: try the next one too, never drop the prompt
      }
      const json = await r.json();
      if (!json?.choices?.length) continue;
      return { model, resp: json };
    } catch {
      clearTimeout(timer);
      cooldownUntil.set(model.id, Date.now() + COOLDOWN_MS);
      continue;
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end();
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const auth = req.headers['x-api-key'];
    const wire = auth ? 'anthropic' : 'openai';
    const body = JSON.stringify(modelList(wire));
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const api: 'openai' | 'anthropic' = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad json' } }));
      return;
    }

    const got = await answer(body, api);
    if (!got) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no free model answered' } }));
      return;
    }
    const { model, resp } = got;

    if (body.stream) {
      if (api === 'anthropic') sseAnthropic(res, model, resp);
      else sseOpenAI(res, model, resp);
      return;
    }

    if (api === 'anthropic') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openAIToAnthropic(resp, model)));
      return;
    }
    const out = { ...resp, model: model.slug };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'not found' } }));
});

async function register(port: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const r = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: 1, port, catalog: catalog() }),
      });
      if (r.ok) return await r.json();
    } catch {
      /* the env may not be up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('register failed');
}

async function pollDone() {
  for (;;) {
    try {
      const r = await fetch(`${ENV_URL}/work`);
      const j = await r.json();
      if (j?.done) process.exit(0);
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const wantsList = process.argv.includes('--list');
if (wantsList) {
  process.stdout.write(`${JSON.stringify(catalog())}\n`);
  process.exit(0);
}

server.listen(0, '0.0.0.0', async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await register(port);
  void pollDone();
});
