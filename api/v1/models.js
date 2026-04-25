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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: { message: 'Method not allowed' } });
  }

  try {
    const upstreamBase = (process.env.UPSTREAM_BASE_URL || '').replace(/\/+$/, '');
    if (!upstreamBase) {
      return sendJson(res, 500, {
        error: { message: 'Missing UPSTREAM_BASE_URL' }
      });
    }

    const auth = getAuthHeader(req);
    if (!auth) {
      return sendJson(res, 401, {
        error: { message: 'Missing Authorization header' }
      });
    }

    const upstreamResp = await fetch(`${upstreamBase}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': auth,
      },
    });

    const text = await upstreamResp.text();

    res.status(upstreamResp.status);
    res.setHeader(
      'Content-Type',
      upstreamResp.headers.get('content-type') || 'application/json; charset=utf-8'
    );
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
