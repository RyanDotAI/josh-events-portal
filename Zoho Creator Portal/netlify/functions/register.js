// POST /api/register — full registration via direct Zoho CRM API calls.
// No dependency on Zoho Creator Functions API.
//
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL

const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_CRM      = process.env.ZOHO_CRM_URL      || 'https://www.zohoapis.com';

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

async function safeJson(res) {
  // Zoho CRM returns 204 No Content (empty body) when a search finds no records.
  if (res.status === 204) return { data: [] };
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error(`Empty response from Zoho (HTTP ${res.status}) — check OAuth scopes`);
  }
  return JSON.parse(text);
}

async function crmGet(path, token) {
  const res = await fetch(`${ZOHO_CRM}/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return safeJson(res);
}

async function crmSearch(module, criteria, token) {
  const d = await crmGet(`${module}/search?criteria=${encodeURIComponent(criteria)}&per_page=10`, token);
  return d.data || [];
}

async function crmCreate(module, record, token) {
  const res = await fetch(`${ZOHO_CRM}/crm/v6/${module}`, {
    method:  'POST',
    headers: {
      Authorization:  `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [record] }),
  });
  const d = await safeJson(res);
  return d.data?.[0];
}

function formatDateTime(dt) {
  if (!dt) return '';
  const [datePart, timePart] = dt.split('T');
  if (!datePart) return '';
  const time = timePart ? timePart.substring(0, 5) : '';
  return time ? `${datePart} at ${time}` : datePart;
}

function buildEmail(ev, registrant_name, p_email) {
  const ev_name     = ev.Name || '';
  const ev_delivery = ev.Delivery_Type || '';
  const ev_start    = ev.Start_Time || '';
  const ev_end      = ev.End_Time || '';
  const ev_loc      = ev.Event_Location_Name || '';
  const ev_building = ev.Event_Address_Flat_House_No_Building_Apartment_Nam || '';
  const ev_street   = ev.Event_Address_Street_Address || '';
  const ev_city     = ev.Event_Address_City || '';
  const ev_state    = ev.Event_Address_State_Province || '';
  const ev_zip      = ev.Event_Address_Zip_Postal_Code || '';
  const ev_country  = ev.Event_Address_Country_Region || '';
  const ev_vlink    = ev.Virtual_Meeting_Link || '';

  // Build display date
  const display_start = formatDateTime(ev_start);

  // Build calendar URLs
  let gcal_start = '', gcal_end = '', ol_start = '', ol_end = '';
  if (ev_start) {
    const [sd, st] = ev_start.split('T');
    const s_time   = (st || '').substring(0, 8);
    const s_hh     = (st || '').substring(0, 5);
    gcal_start     = sd.replace(/-/g, '') + 'T' + s_time.replace(/:/g, '');
    ol_start       = sd + 'T' + s_time;
    if (ev_end) {
      const [ed, et] = ev_end.split('T');
      const e_time   = (et || '').substring(0, 8);
      gcal_end       = ed.replace(/-/g, '') + 'T' + e_time.replace(/:/g, '');
      ol_end         = ed + 'T' + e_time;
    }
  }

  // Build address strings
  const cityStateZip = [ev_city, ev_state ? (ev_state + (ev_zip ? ' ' + ev_zip : '')) : ev_zip].filter(Boolean).join(', ');
  const addrParts    = [ev_loc, ev_building, ev_street, cityStateZip, ev_country].filter(Boolean);
  const addr_full    = ev_delivery === 'Virtual' ? ev_vlink : addrParts.join(', ');

  const name_enc = encodeURIComponent(ev_name);
  const loc_enc  = encodeURIComponent(addr_full);

  const gcal_url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${name_enc}&dates=${gcal_start}/${gcal_end}&location=${loc_enc}`;
  const ol_url   = `https://outlook.live.com/calendar/0/deeplink/compose?rru=addevent&startdt=${ol_start}&enddt=${ol_end}&subject=${name_enc}&location=${loc_enc}`;

  // Build location block for email body
  let loc_line = '';
  if (ev_delivery === 'Virtual') {
    loc_line = `<p>Virtual event. Join link: ${ev_vlink}</p>`;
  } else {
    loc_line = `<p><strong>${ev_loc}</strong>`;
    if (ev_building) loc_line += `<br>${ev_building}`;
    if (ev_street)   loc_line += `<br>${ev_street}`;
    if (cityStateZip) loc_line += `<br>${cityStateZip}`;
    if (ev_country)  loc_line += `<br>${ev_country}`;
    loc_line += '</p>';
    if (ev_delivery === 'Hybrid' && ev_vlink) {
      loc_line += `<p>Virtual link: ${ev_vlink}</p>`;
    }
  }

  const html = [
    "<html><body style='font-family:Arial,sans-serif;padding:20px'>",
    '<h2>Registration Confirmed</h2>',
    `<h3>${ev_name}</h3>`,
    `<p>Hi ${registrant_name},</p>`,
    '<p>You are registered for this event.</p>',
    `<p><strong>Date and Time:</strong> ${display_start}</p>`,
    loc_line,
    `<p><a href="${gcal_url}">Add to Google Calendar</a> &nbsp; <a href="${ol_url}">Add to Outlook</a></p>`,
    "<p style='color:#999;font-size:12px'>Questions? Email ryan@josh.ai</p>",
    '</body></html>',
  ].join('');

  return { to: p_email, subject: `Registration confirmed: ${ev_name}`, html };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { event_id, first_name, last_name, email, company, phone, audience } = body;

    if (!event_id || !email || !last_name) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
    }

    console.log('REGISTER START — event_id:', event_id, 'email:', email);
    const token = await getToken();
    console.log('REGISTER — token obtained');

    // ── 1. Fetch event ────────────────────────────────────────
    const evData = await crmGet(`Event_Master/${event_id}`, token);
    const ev     = evData.data?.[0];
    if (!ev) {
      console.error('REGISTER — event not found:', event_id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
    }
    console.log('REGISTER — event found:', ev.Name);

    const ev_close = ev.Registration_Close_Date || '';
    const ev_cap   = ev.Capacity ? parseInt(ev.Capacity, 10) : 0;

    // ── 2. Check registration close date ──────────────────────
    const today = new Date().toISOString().slice(0, 10);
    if (ev_close && ev_close < today) {
      console.log('REGISTER — closed:', ev_close);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'CLOSED' }) };
    }

    // ── 3. Find or create Contact / Lead ──────────────────────
    let registrant_type = '';
    let registrant_id   = '';
    let registrant_name = `${first_name || ''} ${last_name}`.trim();

    const contacts = await crmSearch('Contacts', `(Email:equals:${email})`, token);
    if (contacts.length > 0) {
      registrant_type = 'contact';
      registrant_id   = contacts[0].id;
      const fn = contacts[0].First_Name || '';
      const ln = contacts[0].Last_Name  || '';
      if (fn || ln) registrant_name = `${fn} ${ln}`.trim();
      console.log('REGISTER — found Contact:', registrant_id);
    } else {
      const leads = await crmSearch('Leads', `(Email:equals:${email})`, token);
      if (leads.length > 0) {
        registrant_type = 'lead';
        registrant_id   = leads[0].id;
        console.log('REGISTER — found Lead:', registrant_id);
      } else {
        console.log('REGISTER — creating new Lead for:', email);
        const newLeadResult = await crmCreate('Leads', {
          First_Name:   first_name || '',
          Last_Name:    last_name,
          Email:        email,
          Company:      company   || '',
          Phone:        phone     || '',
          Lead_Source:  'Event Registration',
          Lead_Status:  'Not Contacted',
          Lead_Type:    audience  || '',
          Description:  `Registered for: ${ev.Name || ''}`,
        }, token);

        console.log('REGISTER — Lead create result:', JSON.stringify(newLeadResult));
        const newId = newLeadResult?.details?.id;
        if (!newId) {
          console.error('REGISTER — Lead creation failed:', JSON.stringify(newLeadResult));
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
        }
        registrant_type = 'lead';
        registrant_id   = newId;
        console.log('REGISTER — new Lead id:', registrant_id);
      }
    }

    // ── 4. Duplicate check ────────────────────────────────────
    const dupField = registrant_type === 'contact' ? 'Contact' : 'Lead';
    const dupRegs  = await crmSearch(
      'Event_Registrations',
      `((${dupField}:equals:${registrant_id})AND(Event:equals:${event_id}))`,
      token
    );
    if (dupRegs.some(r => r.Status !== 'Cancelled')) {
      console.log('REGISTER — already registered');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ALREADY_REGISTERED' }) };
    }

    // ── 5. Capacity check ─────────────────────────────────────
    if (ev_cap > 0) {
      const allRegs = await crmSearch(
        'Event_Registrations',
        `((Event:equals:${event_id})AND(Status:not_equal:Cancelled))`,
        token
      );
      if (allRegs.length >= ev_cap) {
        console.log('REGISTER — event full:', allRegs.length, '/', ev_cap);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'FULL' }) };
      }
    }

    // ── 6. Create Event_Registration ──────────────────────────
    // Lookup fields MUST be passed as {id: "..."} objects, not plain strings.
    const regData = {
      Name:              `${registrant_name} - ${ev.Name || ''}`,
      Event:             { id: event_id },
      Registration_Date: new Date().toISOString(),
      Status:            'Registered',
      Registration_Source: 'Portal',
    };
    if (registrant_type === 'contact') regData.Contact = { id: registrant_id };
    else                                regData.Lead    = { id: registrant_id };

    const newReg   = await crmCreate('Event_Registrations', regData, token);
    const newRegId = newReg?.details?.id;
    if (!newRegId) {
      console.error('Registration creation failed:', JSON.stringify(newReg));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
    }

    // Email confirmation is handled by a Zoho CRM Workflow Rule
    // (Setup → Automation → Workflow Rules → Event_Registrations → On Create → Send Email)
    console.log('Registration created:', newRegId, 'for', email);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS' }) };

  } catch (err) {
    console.error('Registration error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
  }
};
