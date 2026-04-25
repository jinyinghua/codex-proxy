export const config = {
  runtime: 'nodejs',
};

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function getAuthHeader(req) {
  return req.headers.authorization || '';
}

function parseDrawAlias(model) {
  const m = String(model || '').match(/^gpt-draw-(\d+x\d+)$/i);
  if (!m) return null;
  return { alias: model, size: m[1] };
}

function buildImageTool(size) {
  const mode = (process.env.IMAGE_TOOL_FORMAT || 'plain').trim().toLowerCase();
  if (mode === 'with_size') return { type: 'image_generation', size };
  return { type: 'image_generation' };
}

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data || ''));
    req.on('error', reject);
  });
}

function tryParseJson(str) {
  try {
    return str ? JSON.parse(str) : null;
  } catch {
    return null;
  }
}

function copyHeaders(upstreamResp, res) {
  for (const [name, value] of upstreamResp.headers.entries()) {
    if (value) res.setHeader(name, value);
  }
}

async function pipeWebStreamToNodeResponse(stream, res) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

function getOriginalPathAndQuery(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rewrittenPath = url.searchParams.get('__path');
  const path = rewrittenPath || url.pathname || '/';

  const qs = new URLSearchParams(url.searchParams);
  qs.delete('__path');
  const query = qs.toString();

  return {
    path,
    query: query ? `?${query}` : '',
  };
}

export default async function handler(req, res) {
  try {
    const upstreamOrigin = (process.env.UPSTREAM_ORIGIN || '').replace(/\/+$/, '');
    if (!upstreamOrigin) {
      return sendJson(res, 500, { error: { message: 'Missing UPSTREAM_ORIGIN' } });
    }

    const auth = getAuthHeader(req);
    if (!auth) {
      return sendJson(res, 401, { error: { message: 'Missing Authorization header' } });
    }

    const { path, query } = getOriginalPathAndQuery(req);
    const upstreamUrl = `${upstreamOrigin}${path}${query}`;

    const rawBody = ['GET', 'HEAD'].includes(req.method) ? '' : await readRawBody(req);
    const jsonBody = tryParseJson(rawBody);

    let outgoingBody = rawBody;

    if (jsonBody && typeof jsonBody === 'object') {
      const out = { ...jsonBody };
      const drawInfo = parseDrawAlias(jsonBody?.model);

      if (drawInfo) {
        const realModel = process.env.DRAW_REAL_MODEL || 'gpt-5.2';
        out.model = realModel;

        const tools = Array.isArray(out.tools) ? out.tools : [];
        const hasImageTool = tools.some(t => t && t.type === 'image_generation');
        if (!hasImageTool) {
          out.tools = [...tools, buildImageTool(drawInfo.size)];
        }

        const forceToolChoice = (process.env.FORCE_TOOL_CHOICE || '').trim().toLowerCase();
        if (forceToolChoice === 'required') {
          out.tool_choice = 'required';
        } else if (forceToolChoice === 'image_generation') {
          out.tool_choice = { type: 'image_generation' };
        }

        if ((process.env.PUT_SIZE_IN_BODY || '').trim().toLowerCase() === 'true') {
          out.size = drawInfo.size;
        }
      }

      outgoingBody = JSON.stringify(out);

      console.log('incoming path:', path);
      console.log('method:', req.method);
      console.log('incoming model:', jsonBody?.model);
      console.log('forward model:', out?.model);
      console.log('forward tools:', JSON.stringify(out?.tools || null));
      console.log('forward tool_choice:', JSON.stringify(out?.tool_choice || null));
      console.log('stream:', Boolean(out?.stream));
      console.log('upstream url:', upstreamUrl);
    } else {
      console.log('incoming path:', path);
      console.log('method:', req.method);
      console.log('non-json body');
      console.log('upstream url:', upstreamUrl);
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (['host', 'content-length', 'x-forwarded-host'].includes(lower)) continue;
      headers[key] = value;
    }
    headers['authorization'] = auth;
    if (outgoingBody && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outgoingBody,
      redirect: 'manual',
    });

    res.status(upstreamResp.status);
    copyHeaders(upstreamResp, res);

    if (req.method === 'HEAD') {
      return res.end();
    }

    if (upstreamResp.body) {
      return await pipeWebStreamToNodeResponse(upstreamResp.body, res);
    }

    const text = await upstreamResp.text();
    res.end(text);
  } catch (err) {
    return sendJson(res, 500, {
      error: {
        message: err?.message || String(err),
        type: 'proxy_error',
      }
    });
  }
}
