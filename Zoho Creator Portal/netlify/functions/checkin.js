// GET  /api/checkin             → events happening on a given date (defaults to today)
// GET  /api/checkin?event_id=X  → registration roster for an event (staff tool)
// POST /api/checkin             → check-in or walk-in registration
//
// POST body variants:
//   { event_id, email }                                  — attendee QR check-in by email
//   { reg_id }                                            — staff direct check-in by reg ID
//   { event_id, first_name, last_name, email, company }  — walk-in (creates reg + checks in)
//
// Required env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional env: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL

const { getToken } = require('./lib/zoho-auth');

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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Zoho helpers ──────────────────────────────────────────────────────────────

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

async function safeJson(res) {
  if (res.status === 204) return { data: [] };
  const text = await res.text();
  if (!text || !text.trim()) throw new Error(`Empty Zoho response (HTTP ${res.status})`);
  return JSON.parse(text);
}

async function crmGet(path, token) {
  const res = await zohoFetch(`${ZOHO_CRM}/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return safeJson(res);
}

async function crmSearch(module, criteria, token, perPage = 200) {
  const d = await crmGet(
    `${module}/search?criteria=${encodeURIComponent(criteria)}&per_page=${perPage}`,
    token
  );
  return d.data || [];
}

async function crmCreate(module, record, token) {
  const res = await zohoFetch(`${ZOHO_CRM}/crm/v6/${module}`, {
    method:  'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data: [record] }),
  });
  const d = await safeJson(res);
  return d.data?.[0];
}

async function crmUpdate(module, id, data, token) {
  const res = await zohoFetch(`${ZOHO_CRM}/crm/v6/${module}/${id}`, {
    method:  'PUT',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data: [data] }),
  });
  const d = await safeJson(res);
  return d.data?.[0];
}

// ── Date helper ───────────────────────────────────────────────────────────────

function formatEventDisplay(dateFld, localTimeFld) {
  if (!dateFld) return '';
  const [y, m, d] = (dateFld || '').split('-');
  if (!y || !m || !d) return '';
  const dateStr  = `${m}-${d}-${y}`;
  const timePart = (localTimeFld || '').trim().substring(0, 5);
  return timePart ? `${dateStr} at ${timePart}` : dateStr;
}

// Extract registrant name from "First Last - Event Name" registration Name field.
// Splits on first " - " since registrant names rarely contain that sequence.
function extractRegistrantName(regName) {
  const idx = regName ? regName.indexOf(' - ') : -1;
  return idx > -1 ? regName.substring(0, idx) : (regName || '');
}

// ── GET: events for a date ────────────────────────────────────────────────────

async function getEventsForDate(dateStr, token) {
  // Events where Start_Date <= dateStr <= End_Date
  const criteria = `((Start_Date:less_equal:${dateStr})AND(End_Date:greater_equal:${dateStr})AND(Event_Status:not_equal:Cancelled))`;

  const fields = [
    'id', 'Name', 'Event_Type', 'Delivery_Type',
    'Start_Date', 'Start_Time_Local', 'End_Date', 'End_Time_Local',
    'Event_Location_Name', 'Event_Address_City', 'Event_Address_State_Province',
    'Event_Timezone',
  ].join(',');

  const url = `${ZOHO_CRM}/crm/v6/Event_Master/search`
    + `?criteria=${encodeURIComponent(criteria)}`
    + `&fields=${encodeURIComponent(fields)}`
    + `&per_page=50`;

  const res  = await zohoFetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const raw  = await safeJson(res);
  const recs = raw.data || [];

  return recs.map(ev => ({
    id:            ev.id,
    name:          ev.Name || '',
    type:          ev.Event_Type || '',
    delivery:      ev.Delivery_Type || '',
    start_display: formatEventDisplay(ev.Start_Date, ev.Start_Time_Local),
    end_display:   formatEventDisplay(ev.End_Date,   ev.End_Time_Local),
    location:      ev.Event_Location_Name                          || null,
    city:          ev.Event_Address_City                           || null,
    state:         ev.Event_Address_State_Province                 || null,
    timezone:      TZ_LABEL[ev.Event_Timezone] || '',
  }));
}

// ── GET: roster for an event ──────────────────────────────────────────────────

async function getRoster(eventId, token) {
  const regs = await crmSearch(
    'Event_Registrations',
    `((Event:equals:${eventId})AND(Status:not_equal:Cancelled))`,
    token
  );

  const roster = regs.map(r => ({
    reg_id:         r.id,
    name:           extractRegistrantName(r.Name),
    status:         r.Status || '',
    check_in_time:  r.Check_in_Time || null,
  }));

  // Sort: unchecked-in first, then alphabetical by name
  roster.sort((a, b) => {
    const aIn = a.status === 'Attended';
    const bIn = b.status === 'Attended';
    if (aIn !== bIn) return aIn ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ registrations: roster }) };
}

// ── POST: mark a registration as attended ─────────────────────────────────────

async function markAttended(regId, token) {
  const result = await crmUpdate('Event_Registrations', regId, {
    Status:        'Attended',
    Check_in_Time: new Date().toISOString(),
  }, token);

  if (!result || result.status !== 'success') {
    throw new Error('CRM update failed: ' + JSON.stringify(result));
  }
}

// ── POST: staff direct check-in by reg_id ────────────────────────────────────

async function doDirectCheckIn(regId, token) {
  const data = await crmGet(`Event_Registrations/${regId}`, token);
  const reg  = data.data?.[0];

  if (!reg) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'NOT_FOUND' }) };
  }

  const name = extractRegistrantName(reg.Name);

  if (reg.Status === 'Attended') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ALREADY_CHECKED_IN', name }) };
  }

  await markAttended(regId, token);
  console.log('CHECKIN — direct check-in reg_id:', regId, 'name:', name);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS', name }) };
}

// ── POST: attendee check-in by email ─────────────────────────────────────────

async function doEmailCheckIn(eventId, email, token) {
  const emailLower = email.toLowerCase().trim();

  // Look up Contact first, then Lead
  let registrantId   = null;
  let registrantType = null;
  let registrantName = '';

  const contacts = await crmSearch('Contacts', `(Email:equals:${emailLower})`, token, 5);
  if (contacts.length > 0) {
    registrantId   = contacts[0].id;
    registrantType = 'contact';
    const fn = contacts[0].First_Name || '';
    const ln = contacts[0].Last_Name  || '';
    registrantName = `${fn} ${ln}`.trim();
  } else {
    const leads = await crmSearch('Leads', `(Email:equals:${emailLower})`, token, 5);
    if (leads.length > 0) {
      registrantId   = leads[0].id;
      registrantType = 'lead';
      const fn = leads[0].First_Name || '';
      const ln = leads[0].Last_Name  || '';
      registrantName = `${fn} ${ln}`.trim();
    }
  }

  if (!registrantId) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'NOT_REGISTERED' }) };
  }

  // Find registration for this event + contact/lead
  const field   = registrantType === 'contact' ? 'Contact' : 'Lead';
  const regs    = await crmSearch(
    'Event_Registrations',
    `((Event:equals:${eventId})AND(${field}:equals:${registrantId})AND(Status:not_equal:Cancelled))`,
    token,
    5
  );

  if (regs.length === 0) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'NOT_REGISTERED' }) };
  }

  const reg  = regs[0];
  const name = registrantName || extractRegistrantName(reg.Name);

  if (reg.Status === 'Attended') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ALREADY_CHECKED_IN', name }) };
  }

  await markAttended(reg.id, token);
  console.log('CHECKIN — email check-in for:', emailLower, 'name:', name);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS', name }) };
}

// ── POST: walk-in (create registration + check in immediately) ────────────────

async function doWalkIn(body, token) {
  const { event_id, first_name, last_name, email, company } = body;

  if (!event_id || !email || !last_name) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ status: 'ERROR', message: 'Missing required fields' }) };
  }

  const emailLower    = email.toLowerCase().trim();
  const registrantName = `${first_name || ''} ${last_name}`.trim();

  // Find or create Contact / Lead
  let registrantType = '';
  let registrantId   = '';
  let nameFromCRM    = registrantName;

  const contacts = await crmSearch('Contacts', `(Email:equals:${emailLower})`, token, 5);
  if (contacts.length > 0) {
    registrantType = 'contact';
    registrantId   = contacts[0].id;
    const fn = contacts[0].First_Name || '';
    const ln = contacts[0].Last_Name  || '';
    if (fn || ln) nameFromCRM = `${fn} ${ln}`.trim();
  } else {
    const leads = await crmSearch('Leads', `(Email:equals:${emailLower})`, token, 5);
    if (leads.length > 0) {
      registrantType = 'lead';
      registrantId   = leads[0].id;
      const fn = leads[0].First_Name || '';
      const ln = leads[0].Last_Name  || '';
      if (fn || ln) nameFromCRM = `${fn} ${ln}`.trim();
    } else {
      // Create new Lead
      const evData = await crmGet(`Event_Master/${event_id}?fields=id,Name`, token);
      const evName = evData.data?.[0]?.Name || '';

      const newLead = await crmCreate('Leads', {
        First_Name:  first_name || '',
        Last_Name:   last_name,
        Email:       emailLower,
        Company:     company    || '',
        Lead_Source: 'Event Walk-In',
        Lead_Status: 'Not Contacted',
        Description: `Walk-in at: ${evName}`,
      }, token);

      const newId = newLead?.details?.id;
      if (!newId) {
        console.error('WALKIN — Lead creation failed:', JSON.stringify(newLead));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ERROR', debug: newLead }) };
      }
      registrantType = 'lead';
      registrantId   = newId;
      console.log('WALKIN — created Lead:', registrantId);
    }
  }

  // Check for existing non-cancelled registration
  const field  = registrantType === 'contact' ? 'Contact' : 'Lead';
  const dupRegs = await crmSearch(
    'Event_Registrations',
    `((Event:equals:${event_id})AND(${field}:equals:${registrantId})AND(Status:not_equal:Cancelled))`,
    token,
    5
  );

  if (dupRegs.length > 0) {
    const existing = dupRegs[0];
    if (existing.Status === 'Attended') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ALREADY_CHECKED_IN', name: nameFromCRM }) };
    }
    // Already registered but not checked in — just check them in
    await markAttended(existing.id, token);
    console.log('WALKIN — existing registration checked in for:', emailLower);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS', name: nameFromCRM }) };
  }

  // Fetch event name for registration Name field
  const evData = await crmGet(`Event_Master/${event_id}?fields=id,Name`, token);
  const evName = evData.data?.[0]?.Name || '';

  // Create registration directly as Attended + check-in time
  const regRecord = {
    Name:                `${nameFromCRM} - ${evName}`,
    Event:               { id: event_id },
    Registration_Date:   new Date().toISOString(),
    Check_in_Time:       new Date().toISOString(),
    Status:              'Attended',
    Registration_Source: 'Walk-In',
  };
  if (registrantType === 'contact') regRecord.Contact = { id: registrantId };
  else                               regRecord.Lead    = { id: registrantId };

  const newReg = await crmCreate('Event_Registrations', regRecord, token);
  const newId  = newReg?.details?.id;

  if (!newId) {
    console.error('WALKIN — registration creation failed:', JSON.stringify(newReg));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ERROR', debug: newReg }) };
  }

  console.log('WALKIN — walk-in registered and checked in:', emailLower, 'reg_id:', newId);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS', name: nameFromCRM }) };
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const token = await getToken(event);
    const qs    = event.queryStringParameters || {};

    // ── GET ──────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      if (qs.event_id) {
        return getRoster(qs.event_id, token);
      }
      const dateStr = qs.date || new Date().toISOString().slice(0, 10);
      const events  = await getEventsForDate(dateStr, token);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ events, date: dateStr }) };
    }

    // ── POST ─────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // Walk-in: has name fields
      if (body.first_name || body.last_name) {
        return doWalkIn(body, token);
      }
      // Staff direct check-in: only reg_id
      if (body.reg_id && !body.event_id) {
        return doDirectCheckIn(body.reg_id, token);
      }
      // Attendee email check-in
      if (body.event_id && body.email) {
        return doEmailCheckIn(body.event_id, body.email, token);
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('checkin function error:', err.name, err.message, err.stack);
    return {
      statusCode: 500,
      headers:    CORS,
      body:       JSON.stringify({ error: err.message || 'Internal error' }),
    };
  }
};
