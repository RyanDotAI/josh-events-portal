// Proxy: GET /api/events and GET /api/events/:id → Zoho CRM Event_Master
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL (default to US data center)

const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_CRM      = process.env.ZOHO_CRM_URL      || 'https://www.zohoapis.com';

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

function formatDateTime(dt) {
  if (!dt) return '';
  const [datePart, timePart] = dt.split('T');
  if (!datePart) return '';
  const time = timePart ? timePart.substring(0, 5) : '';
  return time ? `${datePart} at ${time}` : datePart;
}

function mapEvent(ev, full = false) {
  const today     = new Date().toISOString().slice(0, 10);
  const closeDate = ev.Registration_Close_Date || '';
  const out = {
    id:            ev.id,
    name:          ev.Name          || '',
    type:          ev.Event_Type    || '',
    delivery:      ev.Delivery_Type || '',
    start_display: formatDateTime(ev.Start_Time),
    end_display:   formatDateTime(ev.End_Time),
    location:      ev.Event_Location_Name              || null,
    city:          ev.Event_Address_City               || null,
    state:         ev.Event_Address_State_Province     || null,
    close_date:    closeDate,
    description:   ev.Event_Description || '',
    capacity:      ev.Capacity          || null,
    audience:      ev.Audience_Type     || '',
    timezone:      TZ_LABEL[ev.Event_Timezone] || '',
  };
  if (full) {
    out.virtual_link = ev.Virtual_Meeting_Link || null;
    out.is_closed    = closeDate ? closeDate < today : false;
  }
  return out;
}

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
      const res = await fetch(`${ZOHO_CRM}/crm/v6/Event_Master/${eventId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const raw = await res.json();
      const ev  = Array.isArray(raw.data) ? raw.data[0] : null;
      if (!ev) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Event not found' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(mapEvent(ev, true)) };
    }

    // Event list — filter by audience if provided
    const qs       = event.queryStringParameters || {};
    const audience = qs.audience || '';
    let criteria   = '(Event_Status:equals:Open for Registration)';
    if (audience) {
      criteria = `((Event_Status:equals:Open for Registration)AND(Audience_Type:equals:${audience}))`;
    }

    const fields = [
      'id', 'Name', 'Event_Type', 'Delivery_Type', 'Start_Time', 'End_Time',
      'Event_Location_Name', 'Event_Address_City', 'Event_Address_State_Province',
      'Registration_Close_Date', 'Event_Description', 'Capacity', 'Audience_Type',
      'Event_Timezone',
    ].join(',');

    const url = `${ZOHO_CRM}/crm/v6/Event_Master/search`
      + `?criteria=${encodeURIComponent(criteria)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&per_page=200`;

    const res     = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const raw     = await res.json();
    const records = raw.data || [];

    return {
      statusCode: 200,
      headers:    CORS,
      body:       JSON.stringify({ events: records.map(ev => mapEvent(ev)) }),
    };
  } catch (err) {
    console.error('events function error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
