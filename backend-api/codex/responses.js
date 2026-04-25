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
  return {
    alias: model,
    size: m[1],
  };
}

function buildImageTool(size) {
  const mode = (process.env.IMAGE_TOOL_FORMAT || 'plain').trim().toLowerCase();

  if (mode === 'with_size') {
    return { type: 'image_generation', size };
  }

  return { type: 'image_generation' };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function copyHeaders(upstreamResp, res) {
  const passthroughHeaders = [
    'content-type',
    'cache-control',
    'x-request-id',
    'openai-processing-ms',
    'openai-version',
    'transfer-encoding',
    'connection',
  ];

  for (const name of passthroughHeaders) {
    const value = upstreamResp.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
}

async function pipeWebStreamToNodeResponse(stream, res) {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'Method not allowed' } });
  }

  try {
    const upstreamUrl = (process.env.UPSTREAM_URL || '').trim();
    if (!upstreamUrl) {
      return sendJson(res, 500, {
        error: { message: 'Missing UPSTREAM_URL' }
      });
    }

    const auth = getAuthHeader(req);
    if (!auth) {
      return sendJson(res, 401, {
        error: { message: 'Missing Authorization header' }
      });
    }

    const body = await readJsonBody(req);
    const out = { ...body };

    const drawInfo = parseDrawAlias(body?.model);

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

    console.log('incoming model:', body?.model);
    console.log('forward model:', out?.model);
    console.log('forward tools:', JSON.stringify(out?.tools || null));
    console.log('forward tool_choice:', JSON.stringify(out?.tool_choice || null));
    console.log('stream:', Boolean(out?.stream));
    console.log('upstream url:', upstreamUrl);

    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify(out),
    });

    res.status(upstreamResp.status);
    copyHeaders(upstreamResp, res);

    if (upstreamResp.body) {
      return await pipeWebStreamToNodeResponse(upstreamResp.body, res);
    }

    const text = await upstreamResp.text();
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
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
