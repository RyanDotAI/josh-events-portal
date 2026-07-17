// Proxy: POST /api/register → Zoho Creator fn_registerGuest
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CREATOR_ACCOUNT, ZOHO_CREATOR_APP

const ZOHO_ACCOUNTS      = process.env.ZOHO_ACCOUNTS_URL   || 'https://accounts.zoho.com';
const ZOHO_CREATOR_ACCT  = process.env.ZOHO_CREATOR_ACCOUNT || 'joshai839';
const ZOHO_CREATOR_APP   = process.env.ZOHO_CREATOR_APP     || 'josh-ai-event-portal';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getToken() {
  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(d));
  return d.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { event_id, first_name, last_name, email, company, phone, audience } = body;

    if (!event_id || !email || !last_name) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
    }

    const token = await getToken();

    const args = JSON.stringify({
      p_event_id:   event_id,
      p_first_name: first_name || '',
      p_last_name:  last_name,
      p_email:      email,
      p_company:    company  || '',
      p_phone:      phone    || '',
      p_audience:   audience || '',
    });

    const fnUrl = `https://creator.zoho.com/api/v2/${ZOHO_CREATOR_ACCT}/${ZOHO_CREATOR_APP}`
      + `/functions/fn_registerGuest/execute?environment=production`;

    const fnRes = await fetch(fnUrl, {
      method:  'POST',
      headers: {
        Authorization:  `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `arguments=${encodeURIComponent(args)}`,
    });

    const fnData = await fnRes.json();

    // Zoho wraps the result: { code: 3000, data: { output: '{"status":"SUCCESS",...}' } }
    let status = 'ERROR';
    try {
      const output = JSON.parse(fnData?.data?.output || '{}');
      status = output.status || 'ERROR';
    } catch (_) {}

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status }) };
  } catch (err) {
    console.error('register function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
  }
};
