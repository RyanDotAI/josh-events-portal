// Proxy: GET /api/events and GET /api/events/:id → Zoho CRM Event_Master
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL (default to US data center)

const ZOHO_ACCOUNTS    = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_CRM         = process.env.ZOHO_CRM_URL      || 'https://www.zohoapis.com';
const FETCH_TIMEOUT_MS = 7000; // fail fast before Netlify's 10s function limit

const TZ_LABEL = {
  'Pacific Time (PT) - (US & Canada)':  'PT',
  'Mountain Time (MT) - (US & Canada)': 'MT',
  'Central Time (CT) - (US & Canada)':  'CT',
  'Eastern Time (ET) - (US & Canada)':  'ET',
  'Alaska Time (AKT)':                  'AKT',
  'Hawaii-Aleutian Time (HST): UTC-10': 'HST',
  'Atlantic Time (AT) - (Canada)':      'AT',
  'Newfoundland (NT) - (Canada)':       'NT',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Token cache ───────────────────────────────────────────────────────────────
// tokenInflight deduplicates concurrent refresh attempts within the same
// Lambda instance so only one HTTP call goes out even under burst traffic.
let cachedToken   = null;
let tokenExpiry   = 0;
let tokenInflight = null;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;
  if (tokenInflight) return tokenInflight;

  tokenInflight = (async () => {
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
      cachedToken = d.access_token;
      tokenExpiry = Date.now() + (55 * 60 * 1000); // cache 55 min; tokens last 60
      return cachedToken;
    } finally {
      clearTimeout(timer);
      tokenInflight = null;
    }
  })();

  return tokenInflight;
}

// ── Fetch wrapper: timeout + single retry on 429 ──────────────────────────────
async function zohoFetch(url, options = {}) {
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt();
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 1000));
    res = await attempt();
  }
  return res;
}

// ── Reg count: paginated bulk fetch ──────────────────────────────────────────
// Fetches ALL active registrations across all events in as many pages as needed,
// returns a map of { eventId: count }. One call replaces N per-event calls.
async function fetchAllRegCounts(token) {
  try {
    const counts = {};
    let page = 1;
    let more = true;
    while (more) {
      const url = `${ZOHO_CRM}/crm/v6/Event_Registrations/search`
        + `?criteria=${encodeURIComponent('(Status:not_equal:Cancelled)')}`
        + `&fields=Event,Status&per_page=200&page=${page}`;
      const res = await zohoFetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      const d   = await res.json();
      if (Array.isArray(d.data)) {
        d.data.forEach(reg => {
          const eventId = reg.Event && reg.Event.id;
          if (eventId) counts[eventId] = (counts[eventId] || 0) + 1;
        });
      }
      more = !!(d.info && d.info.more_records);
      page++;
    }
    return counts;
  } catch (_) {
    return {};
  }
}

// ── Field mapping ─────────────────────────────────────────────────────────────
function formatEventDateTime(dateFld, localTimeFld) {
  if (!dateFld) return '';
  const [y, m, d] = (dateFld || '').split('-');
  if (!y || !m || !d) return '';
  const dateStr  = `${m}-${d}-${y}`;
  const timePart = (localTimeFld || '').trim().substring(0, 5);
  return timePart ? `${dateStr} at ${timePart}` : dateStr;
}

function mapEvent(ev, full = false) {
  const today     = new Date().toISOString().slice(0, 10);
  const closeDate = ev.Registration_Close_Date || '';
  const capacity  = ev.Capacity ? parseInt(ev.Capacity, 10) : null;
  const out = {
    id:              ev.id,
    name:            ev.Name          || '',
    type:            ev.Event_Type    || '',
    delivery:        ev.Delivery_Type || '',
    start_display:   formatEventDateTime(ev.Start_Date, ev.Start_Time_Local),
    end_display:     formatEventDateTime(ev.End_Date,   ev.End_Time_Local),
    location:        ev.Event_Location_Name          || null,
    city:            ev.Event_Address_City           || null,
    state:           ev.Event_Address_State_Province || null,
    close_date:      closeDate,
    description:     ev.Event_Description || '',
    capacity,
    audience:        ev.Audience_Type || '',
    timezone:        TZ_LABEL[ev.Event_Timezone] || '',
    seats_remaining: null,
    region:          ev.Target_Region            ? ev.Target_Region.trim()            : null,
    rep_firm:        ev.Rep_Firm                 ? ev.Rep_Firm.trim()                 : null,
    external_url:    ev.External_Registration_URL ? ev.External_Registration_URL.trim() : null,
  };
  if (full) {
    out.virtual_link = ev.Virtual_Meeting_Link || null;
    out.is_closed    = closeDate ? closeDate < today : false;
  }
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const token = await getToken();

    // Detect single-event vs list: path is /api/events or /api/events/{id}
    const suffix  = event.path.replace(/^\/api\/events\/?/, '');
    const eventId = suffix && suffix !== '' ? suffix : null;

    if (eventId) {
      const res = await zohoFetch(`${ZOHO_CRM}/crm/v6/Event_Master/${eventId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const raw = await res.json();
      const ev  = Array.isArray(raw.data) ? raw.data[0] : null;
      if (!ev) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Event not found' }) };
      }
      const mapped = mapEvent(ev, true);
      if (mapped.capacity) {
        const regCounts       = await fetchAllRegCounts(token);
        const count           = regCounts[eventId] || 0;
        const remaining       = mapped.capacity - count;
        mapped.seats_remaining = remaining > 0 ? remaining : 0;
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(mapped) };
    }

    // Event list
    const qs       = event.queryStringParameters || {};
    const audience = qs.audience || '';
    let criteria   = '(Event_Status:equals:Open for Registration)';
    if (audience) {
      criteria = `((Event_Status:equals:Open for Registration)AND(Audience_Type:equals:${audience}))`;
    }

    const fields = [
      'id', 'Name', 'Event_Type', 'Delivery_Type',
      'Start_Date', 'Start_Time_Local', 'End_Date', 'End_Time_Local',
      'Event_Location_Name', 'Event_Address_City', 'Event_Address_State_Province',
      'Registration_Close_Date', 'Event_Description', 'Capacity', 'Audience_Type',
      'Event_Timezone', 'Target_Region', 'Rep_Firm', 'External_Registration_URL',
    ].join(',');

    const url = `${ZOHO_CRM}/crm/v6/Event_Master/search`
      + `?criteria=${encodeURIComponent(criteria)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&per_page=200`;

    const res     = await zohoFetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const raw     = await res.json();
    const records = raw.data || [];
    const mapped  = records.map(ev => mapEvent(ev));

    const withCap = mapped.filter(m => m.capacity);
    if (withCap.length > 0) {
      const regCounts = await fetchAllRegCounts(token);
      withCap.forEach(m => {
        const count        = regCounts[m.id] || 0;
        const remaining    = m.capacity - count;
        m.seats_remaining  = remaining > 0 ? remaining : 0;
      });
    }

    return {
      statusCode: 200,
      headers:    CORS,
      body:       JSON.stringify({ events: mapped }),
    };
  } catch (err) {
    console.error('events function error:', err.name, err.message, err.stack);
    return {
      statusCode: 500,
      headers:    CORS,
      body:       JSON.stringify({ error: err.message || 'Internal error' }),
    };
  }
};
