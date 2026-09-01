// Shared Zoho OAuth token cache, backed by Netlify Blobs.
//
// Zoho's OAuth token endpoint has its own strict abuse-throttle, separate
// from (and stricter than) normal CRM API rate limits. Each Netlify function
// (checkin, events, register, cancel) used to refresh its own token
// independently, with no sharing across functions or across concurrent
// Lambda instances — so a burst of concurrent requests (e.g. 100 people
// checking in within 30 seconds) could spin up many cold instances that all
// refresh at once and trip Zoho's lockout.
//
// Fix: a scheduled function (zoho-token-refresh.js) proactively refreshes
// the token and writes it to a shared Blobs store well before it expires.
// Request-path functions just read that shared token via getToken() below —
// they only call Zoho's OAuth endpoint directly if the shared cache is
// missing or stale, which should only happen right after first deploy or
// during a Blobs outage.

const { getStore, connectLambda } = require('@netlify/blobs');

const ZOHO_ACCOUNTS    = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const FETCH_TIMEOUT_MS = 7000;
const TOKEN_KEY         = 'access-token';
const TOKEN_TTL_MS      = 55 * 60 * 1000; // Zoho tokens last 60 min; cache 55

// connectLambda() configures Blobs access from the raw Lambda-compat event.
// Wrapped defensively: if the event ever lacks the expected `blobs` field
// (unexpected Netlify runtime change, local invocation, etc.) this must not
// take down check-in — tokenStore() below will simply fail to read/write the
// shared cache and getToken() falls back to refreshing directly, same as
// before this change existed.
function connectBlobs(event) {
  try {
    if (event) connectLambda(event);
  } catch (err) {
    console.error('zoho-auth: connectLambda failed, shared cache unavailable this invocation:', err.message);
  }
}

// Default (eventual) consistency — deliberate, not an oversight. 'strong'
// requires an `uncachedEdgeURL` in the Blobs environment context, which the
// classic Lambda-compat connectLambda() path never populates; requesting it
// here would make every Blobs call throw and silently defeat this whole
// mechanism. Eventual consistency (up to ~60s propagation) is fine anyway:
// the scheduled refresh writes every 15 min into a 55-min cache window.
function tokenStore() {
  return getStore('zoho-auth');
}

async function refreshZohoToken() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
      method:  'POST',
      signal:  controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

// Called only by the scheduled refresh job. `event` is the job's own Lambda event.
async function refreshAndStore(event) {
  connectBlobs(event);
  const token = await refreshZohoToken();
  await tokenStore().setJSON(TOKEN_KEY, { access_token: token, expires_at: Date.now() + TOKEN_TTL_MS });
  return token;
}

// In-memory per-instance cache — fastest path for repeat calls within one warm Lambda.
let memToken  = null;
let memExpiry = 0;

// Called by request-path functions to get a usable access token.
// `event` is that function's own Lambda event, needed to configure Blobs access.
async function getToken(event) {
  const now = Date.now();
  if (memToken && now < memExpiry) return memToken;

  connectBlobs(event);

  try {
    const cached = await tokenStore().get(TOKEN_KEY, { type: 'json' });
    if (cached && now < cached.expires_at) {
      memToken  = cached.access_token;
      memExpiry = cached.expires_at;
      return memToken;
    }
  } catch (err) {
    console.error('zoho-auth: blob read failed, falling back to direct refresh:', err.message);
  }

  // Shared cache missing/stale — refresh directly. Rare path; the scheduled
  // job above is what keeps this from happening during real traffic.
  const token = await refreshZohoToken();
  memToken  = token;
  memExpiry = now + TOKEN_TTL_MS;
  tokenStore().setJSON(TOKEN_KEY, { access_token: token, expires_at: memExpiry }).catch(() => {});
  return token;
}

module.exports = { getToken, refreshAndStore };
