// GET  /api/cancel?reg_id=XXX  — return event name + status for a registration
// POST /api/cancel             — verify email, mark Cancelled, send confirmation email
//
// Required env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//                    GMAIL_USER, GMAIL_APP_PASSWORD
// Optional env vars: ZOHO_ACCOUNTS_URL, ZOHO_CRM_URL, SITE_URL

const nodemailer = require('nodemailer');

const ZOHO_ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_CRM      = process.env.ZOHO_CRM_URL      || 'https://www.zohoapis.com';
const SITE_URL      = process.env.SITE_URL           || 'https://okjosh.netlify.app';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  if (res.status === 204) return { data: [] };
  const text = await res.text();
  if (!text || !text.trim()) throw new Error(`Empty Zoho response (HTTP ${res.status})`);
  return JSON.parse(text);
}

async function crmGet(path, token) {
  const res = await fetch(`${ZOHO_CRM}/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return safeJson(res);
}

async function sendCancellationEmail(ev_name, registrant_name, reg_email) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) return;

  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,
    auth:   { user: gmailUser, pass: gmailPass },
  });

  const first_name = registrant_name.split(' ')[0] || '';
  const greeting   = first_name ? `Hi ${first_name},` : 'Hello,';

  const html = [
    "<!DOCTYPE html><html><body style='margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif'>",
    "<div style='max-width:600px;margin:0 auto;background:#ffffff'>",
    "<div style='background:#000000;padding:20px 32px'>",
    "<p style='color:#ffffff;font-size:18px;font-weight:bold;margin:0'>Josh.ai</p>",
    "</div>",
    "<div style='background:#111111;padding:32px'>",
    "<h1 style='color:#ffffff;font-size:24px;margin:0 0 8px'>Registration Cancelled</h1>",
    `<p style='color:#aaaaaa;font-size:15px;margin:0'>${ev_name}</p>`,
    "</div>",
    "<div style='padding:32px'>",
    `<p style='color:#333333;font-size:15px;line-height:1.6;margin:0 0 24px'>${greeting}<br><br>Your registration for <strong>${ev_name}</strong> has been cancelled.</p>`,
    `<p style='color:#555555;font-size:14px;line-height:1.6;margin:0'>If you cancelled by mistake or would like to register for another event, visit our <a href='${SITE_URL}/events.html' style='color:#000000'>events page</a>.</p>`,
    "</div>",
    "<div style='border-top:1px solid #eeeeee;padding:20px 32px;text-align:center'>",
    "<p style='color:#aaaaaa;font-size:12px;margin:0'>Questions? Email <a href='mailto:sales@josh.ai' style='color:#aaaaaa'>sales@josh.ai</a></p>",
    "</div>",
    "</div></body></html>",
  ].join('');

  await transporter.sendMail({
    from:    `"Josh.ai Events" <${gmailUser}>`,
    to:      reg_email,
    replyTo: 'sales@josh.ai',
    subject: `Registration Cancelled: ${ev_name}`,
    html,
  });
  console.log('CANCEL — cancellation email sent to', reg_email);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const token = await getToken();

    // ── GET: return event name + status ───────────────────────
    if (event.httpMethod === 'GET') {
      const reg_id = (event.queryStringParameters || {}).reg_id;
      if (!reg_id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing reg_id' }) };
      }

      const data = await crmGet(`Event_Registrations/${reg_id}`, token);
      const reg  = data.data?.[0];
      if (!reg) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Registration not found' }) };
      }

      return {
        statusCode: 200,
        headers:    CORS,
        body:       JSON.stringify({
          reg_id:     reg.id,
          event_name: reg.Event?.name || reg.Name || '',
          status:     reg.Status || '',
        }),
      };
    }

    // ── POST: verify email + cancel ───────────────────────────
    if (event.httpMethod === 'POST') {
      const body   = JSON.parse(event.body || '{}');
      const { reg_id, email } = body;
      if (!reg_id || !email) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing reg_id or email' }) };
      }

      const regData = await crmGet(`Event_Registrations/${reg_id}`, token);
      const reg     = regData.data?.[0];
      if (!reg) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'NOT_FOUND' }) };
      }

      if (reg.Status === 'Cancelled') {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ALREADY_CANCELLED' }) };
      }

      // Verify email against linked Contact or Lead
      const contactId = reg.Contact?.id;
      const leadId    = reg.Lead?.id;
      let registrant_email = '';
      let registrant_name  = '';

      if (contactId) {
        const cData = await crmGet(`Contacts/${contactId}?fields=id,First_Name,Last_Name,Email`, token);
        const c     = cData.data?.[0];
        if (c) {
          registrant_email = c.Email || '';
          registrant_name  = `${c.First_Name || ''} ${c.Last_Name || ''}`.trim();
        }
      } else if (leadId) {
        const lData = await crmGet(`Leads/${leadId}?fields=id,First_Name,Last_Name,Email`, token);
        const l     = lData.data?.[0];
        if (l) {
          registrant_email = l.Email || '';
          registrant_name  = `${l.First_Name || ''} ${l.Last_Name || ''}`.trim();
        }
      }

      if (!registrant_email || registrant_email.toLowerCase() !== email.toLowerCase()) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'EMAIL_MISMATCH' }) };
      }

      // Update status to Cancelled
      await fetch(`${ZOHO_CRM}/crm/v6/Event_Registrations/${reg_id}`, {
        method:  'PUT',
        headers: {
          Authorization:  `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: [{ Status: 'Cancelled' }] }),
      });
      console.log('CANCEL — registration', reg_id, 'cancelled for', registrant_email);

      const ev_name = reg.Event?.name || '';

      try {
        await sendCancellationEmail(ev_name, registrant_name, registrant_email);
      } catch (emailErr) {
        console.error('CANCEL — email failed:', emailErr.message);
      }

      return {
        statusCode: 200,
        headers:    CORS,
        body:       JSON.stringify({ status: 'SUCCESS', event_name: ev_name }),
      };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('CANCEL error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
