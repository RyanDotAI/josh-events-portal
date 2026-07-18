// POST /api/register — full registration via direct Zoho CRM API calls.
// Sends confirmation email + calendar invite via Gmail SMTP after registration.
//
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//                    GMAIL_USER, GMAIL_APP_PASSWORD
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL

const nodemailer = require('nodemailer');

const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_CRM      = process.env.ZOHO_CRM_URL      || 'https://www.zohoapis.com';
const SITE_URL      = process.env.SITE_URL           || 'https://okjosh.netlify.app';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Event_Timezone picklist value → IANA timezone name
const TZ_IANA = {
  'Pacific Time (PT) - (US & Canada)':  'America/Los_Angeles',
  'Mountain Time (MT) - (US & Canada)': 'America/Denver',
  'Central Time (CT) - (US & Canada)':  'America/Chicago',
  'Eastern Time (ET) - (US & Canada)':  'America/New_York',
  'Alaska Time (AKT)':                  'America/Anchorage',
  'Hawaii-Aleutian Time (HST): UTC-10': 'Pacific/Honolulu',
  'Atlantic Time (AT) - (Canada)':      'America/Halifax',
  'Newfoundland (NT) - (Canada)':       'America/St_Johns',
};

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

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Zoho API helpers ──────────────────────────────────────────────────────────

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

// ── Date/time helpers ─────────────────────────────────────────────────────────

// Parse Zoho DateTime ("YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS") into parts.
function parseDt(raw) {
  if (!raw) return null;
  const clean = raw.replace('T', ' ').substring(0, 19);
  if (clean.length < 16) return null;
  return {
    year:  clean.substring(0, 4),
    month: clean.substring(5, 7),
    day:   clean.substring(8, 10),
    hour:  clean.substring(11, 13),
    min:   clean.substring(14, 16),
    sec:   clean.length >= 19 ? clean.substring(17, 19) : '00',
  };
}

function to12h(hourStr) {
  const h = parseInt(hourStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { h12, ampm };
}

// Convert a local event time (in a named IANA timezone) to a UTC Date object.
// Uses Node's built-in Intl API — no timezone library needed.
function localToUtcDate(year, month, day, hour, min, sec, tzIana) {
  // Treat the local time as if it were UTC to get a reference point
  const fakeUtc = new Date(Date.UTC(
    parseInt(year), parseInt(month) - 1, parseInt(day),
    parseInt(hour), parseInt(min), parseInt(sec)
  ));
  // Format that reference point in the target timezone to see the local offset
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzIana,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  fmt.formatToParts(fakeUtc).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  const tzHour = parseInt(parts.hour, 10) % 24;
  const offsetMs = fakeUtc.getTime() - Date.UTC(
    parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
    tzHour, parseInt(parts.minute), parseInt(parts.second)
  );
  return new Date(fakeUtc.getTime() + offsetMs);
}

// Format a UTC Date as "YYYYMMDDTHHmmssZ" for Google Calendar URLs.
function toGcalUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

// Format a UTC Date as "YYYY-MM-DDTHH:MM:SSZ" for Outlook URLs.
function toOlUtc(date) {
  return date.toISOString().slice(0, 19) + 'Z';
}

// Build compact time string for calendar title, e.g. "4-6pm MT" or "11am-1pm MT".
// Omits ":00" minutes, collapses shared AM/PM to end only.
function buildCompactTime(start, end, tzLabel) {
  const sh = parseInt(start.hour, 10);
  const eh = parseInt(end.hour, 10);
  const s_ampm = sh >= 12 ? 'pm' : 'am';
  const e_ampm = eh >= 12 ? 'pm' : 'am';
  const s_h12  = sh === 0 ? 12 : sh > 12 ? sh - 12 : sh;
  const e_h12  = eh === 0 ? 12 : eh > 12 ? eh - 12 : eh;
  const s_time = start.min === '00' ? `${s_h12}` : `${s_h12}:${start.min}`;
  const e_time = end.min   === '00' ? `${e_h12}` : `${e_h12}:${end.min}`;
  const time   = s_ampm === e_ampm
    ? `${s_time}-${e_time}${e_ampm}`
    : `${s_time}${s_ampm}-${e_time}${e_ampm}`;
  return `${time} ${tzLabel}`;
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmailContent(ev, registrant_name, reg_email, cancel_url) {
  const ev_name     = ev.Name || '';
  const ev_delivery = ev.Delivery_Type || '';
  const ev_vlink    = ev.Virtual_Meeting_Link || '';
  const tz_raw      = ev.Event_Timezone || '';
  const tz_label    = TZ_LABEL[tz_raw] || 'MT';
  const tz_iana     = TZ_IANA[tz_raw]  || 'America/Denver';

  // Address parts
  const loc_name    = ev.Event_Location_Name || '';
  const loc_bldg    = ev.Event_Address_Flat_House_No_Building_Apartment_Nam || '';
  const loc_street  = ev.Event_Address_Street_Address || '';
  const loc_city    = ev.Event_Address_City || '';
  const loc_state   = ev.Event_Address_State_Province || '';
  const loc_zip     = ev.Event_Address_Zip_Postal_Code || '';
  const loc_country = ev.Event_Address_Country_Region || '';

  const cityStateZip = [loc_city, loc_state ? (loc_state + (loc_zip ? ' ' + loc_zip : '')) : loc_zip]
    .filter(Boolean).join(', ');
  const addrParts = [loc_name, loc_bldg, loc_street, cityStateZip, loc_country].filter(Boolean);
  const addr_full = addrParts.join(', ');

  // Display date/time
  const start = parseDt(ev.Start_Time);
  const end   = parseDt(ev.End_Time);

  let display_date = '';
  let display_time = '';
  let cal_title    = ev_name;
  let gcal_start = '', gcal_end = '', ol_start = '', ol_end = '';

  if (start) {
    const { h12: sh, ampm: sa } = to12h(start.hour);
    const monthName = MONTH_NAMES[parseInt(start.month, 10)] || start.month;
    display_date = `${monthName} ${start.day}, ${start.year}`;

    // For display: keep local time as-is
    const endParts = end || { ...start, hour: String(parseInt(start.hour, 10) + 1).padStart(2, '0') };
    const { h12: eh, ampm: ea } = to12h(endParts.hour);
    display_time = `${sh}:${start.min} ${sa} – ${eh}:${endParts.min} ${ea} ${tz_label}`;
    cal_title    = `${ev_name} - ${buildCompactTime(start, endParts, tz_label)}`;

    // For calendar links: convert to UTC so the time is correct for any viewer's timezone
    const startUtc = localToUtcDate(start.year, start.month, start.day, start.hour, start.min, start.sec, tz_iana);
    const endUtc   = localToUtcDate(endParts.year, endParts.month, endParts.day, endParts.hour, endParts.min, endParts.sec, tz_iana);
    gcal_start = toGcalUtc(startUtc);
    gcal_end   = toGcalUtc(endUtc);
    ol_start   = toOlUtc(startUtc);
    ol_end     = toOlUtc(endUtc);
  }

  // Description for calendar links
  const cal_desc_parts = [`You are registered for ${ev_name}.`];
  if (ev.Event_Description) cal_desc_parts.push(ev.Event_Description);
  if (cancel_url) cal_desc_parts.push(`Cancel registration: ${cancel_url}`);
  const cal_desc = cal_desc_parts.join('\n\n');

  // Location for calendar URLs
  const cal_location = ev_delivery === 'Virtual' ? ev_vlink : addr_full;
  const gcal_url = `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(cal_title)}`
    + `&dates=${gcal_start}/${gcal_end}`
    + `&details=${encodeURIComponent(cal_desc)}`
    + `&location=${encodeURIComponent(cal_location)}`;
  const ol_url = `https://outlook.live.com/calendar/0/deeplink/compose?rru=addevent`
    + `&startdt=${ol_start}&enddt=${ol_end}`
    + `&subject=${encodeURIComponent(cal_title)}`
    + `&body=${encodeURIComponent(cal_desc)}`
    + `&location=${encodeURIComponent(cal_location)}`;

  // Location block for email body
  let location_html = '';
  let loc_label = 'Location';
  if (ev_delivery === 'Virtual') {
    loc_label = 'Join Link';
    location_html = `<strong>Virtual Event</strong>`;
    if (ev_vlink) location_html += `<br><a href="${ev_vlink}" style="color:#0066cc">${ev_vlink}</a>`;
  } else {
    location_html = `<strong>${loc_name}</strong>`;
    if (loc_bldg)       location_html += `<br>${loc_bldg}`;
    if (loc_street)     location_html += `<br>${loc_street}`;
    if (cityStateZip)   location_html += `<br>${cityStateZip}`;
    if (loc_country)    location_html += `<br>${loc_country}`;
    if (ev_delivery === 'Hybrid' && ev_vlink) {
      location_html += `<br><br><strong>Virtual Link:</strong> <a href="${ev_vlink}" style="color:#0066cc">${ev_vlink}</a>`;
      loc_label = 'Location & Join';
    }
  }

  const first_name = registrant_name.split(' ')[0] || '';
  const greeting   = first_name ? `Hi ${first_name},` : 'Hello,';

  const html = [
    "<!DOCTYPE html><html><body style='margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif'>",
    "<div style='max-width:600px;margin:0 auto;background:#ffffff'>",
    "<div style='background:#000000;padding:20px 32px'>",
    "<p style='color:#ffffff;font-size:18px;font-weight:bold;margin:0'>Josh.ai</p>",
    "</div>",
    "<div style='background:#111111;padding:32px'>",
    "<h1 style='color:#ffffff;font-size:24px;margin:0 0 8px'>You're Registered!</h1>",
    `<p style='color:#aaaaaa;font-size:15px;margin:0'>${ev_name}</p>`,
    "</div>",
    "<div style='padding:32px'>",
    `<p style='color:#333333;font-size:15px;line-height:1.6;margin:0 0 24px'>${greeting}<br><br>Your spot is confirmed. Here are your event details:</p>`,
    "<table style='width:100%;border-collapse:collapse;margin-bottom:28px'>",
    "<tr style='border-top:1px solid #eeeeee'>",
    "<td style='padding:12px 0;color:#888888;font-size:12px;font-weight:bold;width:90px;vertical-align:top'>EVENT</td>",
    `<td style='padding:12px 0;color:#111111;font-size:15px;font-weight:bold'>${ev_name}</td>`,
    "</tr>",
    "<tr style='border-top:1px solid #eeeeee'>",
    "<td style='padding:12px 0;color:#888888;font-size:12px;font-weight:bold;vertical-align:top'>DATE</td>",
    `<td style='padding:12px 0;color:#111111;font-size:15px'>${display_date}</td>`,
    "</tr>",
    "<tr style='border-top:1px solid #eeeeee'>",
    "<td style='padding:12px 0;color:#888888;font-size:12px;font-weight:bold;vertical-align:top'>TIME</td>",
    `<td style='padding:12px 0;color:#111111;font-size:15px'>${display_time}</td>`,
    "</tr>",
    "<tr style='border-top:1px solid #eeeeee;border-bottom:1px solid #eeeeee'>",
    `<td style='padding:12px 0;color:#888888;font-size:12px;font-weight:bold;vertical-align:top'>${loc_label}</td>`,
    `<td style='padding:12px 0;color:#111111;font-size:15px;line-height:1.6'>${location_html}</td>`,
    "</tr>",
    "</table>",
    "<p style='color:#555555;font-size:14px;font-weight:bold;margin:0 0 12px'>Add to your calendar:</p>",
    `<a href="${gcal_url}" style='display:inline-block;background:#000000;color:#ffffff;padding:10px 20px;text-decoration:none;border-radius:4px;font-size:13px;font-weight:bold;margin-right:10px'>Google Calendar</a>`,
    `<a href="${ol_url}" style='display:inline-block;background:#0078d4;color:#ffffff;padding:10px 20px;text-decoration:none;border-radius:4px;font-size:13px;font-weight:bold'>Outlook Calendar</a>`,
    "</div>",
    "<div style='border-top:1px solid #eeeeee;padding:20px 32px;text-align:center'>",
    "<p style='color:#aaaaaa;font-size:12px;margin:0'>Questions? Email <a href='mailto:sales@josh.ai' style='color:#aaaaaa'>sales@josh.ai</a></p>",
    ...(cancel_url ? [`<p style='color:#aaaaaa;font-size:12px;margin:8px 0 0'>Need to cancel? <a href='${cancel_url}' style='color:#aaaaaa'>Cancel your registration</a></p>`] : []),
    "</div>",
    "</div></body></html>",
  ].join('');

  return { html, subject: `Registration Confirmed: ${ev_name}`, cal_location };
}

// ── ICS builder ───────────────────────────────────────────────────────────────

function icsEscape(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildICS({ ev, reg_email, registrant_name, reg_id, cancel_url }) {
  const start  = parseDt(ev.Start_Time);
  const end    = parseDt(ev.End_Time);
  if (!start) return null;

  const endParts = end || { ...start, hour: String(parseInt(start.hour, 10) + 1).padStart(2, '0') };
  const tz_raw   = ev.Event_Timezone || '';
  const tzIana   = TZ_IANA[tz_raw]  || 'America/Denver';
  const tz_label = TZ_LABEL[tz_raw] || 'MT';

  const ev_delivery = ev.Delivery_Type || '';
  const ev_vlink    = ev.Virtual_Meeting_Link || '';
  const loc_name    = ev.Event_Location_Name || '';
  const loc_bldg    = ev.Event_Address_Flat_House_No_Building_Apartment_Nam || '';
  const loc_street  = ev.Event_Address_Street_Address || '';
  const loc_city    = ev.Event_Address_City || '';
  const loc_state   = ev.Event_Address_State_Province || '';
  const loc_zip     = ev.Event_Address_Zip_Postal_Code || '';
  const loc_country = ev.Event_Address_Country_Region || '';
  const cityStateZip = [loc_city, loc_state ? (loc_state + (loc_zip ? ' ' + loc_zip : '')) : loc_zip]
    .filter(Boolean).join(', ');
  const addrParts = [loc_name, loc_bldg, loc_street, cityStateZip, loc_country].filter(Boolean);
  const location = ev_delivery === 'Virtual' ? ev_vlink : addrParts.join(', ');

  const startUtc = localToUtcDate(start.year, start.month, start.day, start.hour, start.min, start.sec, tzIana);
  const endUtc   = localToUtcDate(endParts.year, endParts.month, endParts.day, endParts.hour, endParts.min, endParts.sec || '00', tzIana);
  const dtStart  = toGcalUtc(startUtc);
  const dtEnd    = toGcalUtc(endUtc);
  const now      = new Date();
  const dtstamp  = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ev_name       = (ev.Name || '').replace(/[\\;,]/g, ' ');
  const compact_time  = buildCompactTime(start, endParts, tz_label);
  const summary_title = `${ev_name} - ${compact_time}`;
  const safe_loc      = location.replace(/[\\;,]/g, ' ');

  const desc_parts = [`You are registered for ${ev_name}.`];
  if (ev.Event_Description) desc_parts.push(icsEscape(ev.Event_Description));
  if (cancel_url) desc_parts.push(`To cancel your registration: ${cancel_url}`);
  const description = desc_parts.join('\\n\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Josh.ai//Events//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `DTSTAMP:${dtstamp}`,
    `UID:${reg_id}@josh.ai`,
    'ORGANIZER;CN=Josh.ai Events:mailto:sales@josh.ai',
    `ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;CN=${registrant_name}:mailto:${reg_email}`,
    `SUMMARY:${summary_title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${safe_loc}`,
    ...(cancel_url ? [`URL:${cancel_url}`] : []),
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// ── Email sender ──────────────────────────────────────────────────────────────

async function sendConfirmationEmail(ev, registrant_name, reg_email, reg_id) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.log('REGISTER — GMAIL_USER/GMAIL_APP_PASSWORD not set, skipping email');
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth:   { user: gmailUser, pass: gmailPass },
  });

  const cancel_url = reg_id ? `${SITE_URL}/cancel.html?reg_id=${reg_id}` : '';
  const { html, subject } = buildEmailContent(ev, registrant_name, reg_email, cancel_url);
  const ics = buildICS({ ev, reg_email, registrant_name, reg_id, cancel_url });

  const mailOptions = {
    from:    `"Josh.ai Events" <${gmailUser}>`,
    to:      reg_email,
    replyTo: 'sales@josh.ai',
    subject,
    html,
    ...(ics ? { icalEvent: { filename: 'invite.ics', method: 'REQUEST', content: ics } } : {}),
  };

  await transporter.sendMail(mailOptions);
  console.log('REGISTER — confirmation email sent to', reg_email);
}

// ── Handler ───────────────────────────────────────────────────────────────────

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
    const regData = {
      Name:                `${registrant_name} - ${ev.Name || ''}`,
      Event:               { id: event_id },
      Registration_Date:   new Date().toISOString(),
      Status:              'Registered',
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
    console.log('Registration created:', newRegId, 'for', email);

    // ── 7. Send confirmation email + calendar invite ───────────
    try {
      await sendConfirmationEmail(ev, registrant_name, email, newRegId);
    } catch (emailErr) {
      console.error('REGISTER — email send failed:', emailErr.message);
      // Registration succeeded — don't fail the response over email
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'SUCCESS' }) };

  } catch (err) {
    console.error('Registration error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'ERROR' }) };
  }
};
