# Events Portal — Backend API Specification

Your frontend (`events.html`, `event-detail.html`) calls three endpoints on your own backend.  
Your backend holds the Zoho credentials and proxies to Zoho CRM + Zoho Creator Functions.

---

## Authentication with Zoho

All Zoho API calls require an OAuth 2.0 access token. Use the **Client Credentials** flow (server-to-server, no user login required).

### 1. Create a Zoho Server-based Application

1. Go to **api-console.zoho.com** → **Add Client** → **Server-based Applications**
2. Note your **Client ID** and **Client Secret**
3. Grant these scopes:
   - `ZohoCRM.modules.READ` — read Event_Master records
   - `ZohoCreator.form.CREATE` — invoke Creator custom functions

### 2. Get a Refresh Token (one-time)

```
POST https://accounts.zoho.com/oauth/v2/token
  ?grant_type=authorization_code
  &client_id=YOUR_CLIENT_ID
  &client_secret=YOUR_CLIENT_SECRET
  &redirect_uri=YOUR_REDIRECT_URI
  &code=AUTHORIZATION_CODE
```

Store the `refresh_token` permanently in your backend secrets.

### 3. Exchange Refresh Token for Access Token (each request cycle)

```
POST https://accounts.zoho.com/oauth/v2/token
  ?grant_type=refresh_token
  &client_id=YOUR_CLIENT_ID
  &client_secret=YOUR_CLIENT_SECRET
  &refresh_token=YOUR_REFRESH_TOKEN
```

Response: `{ "access_token": "...", "expires_in": 3600 }`

Cache the access token for up to 55 minutes.

---

## Endpoint 1 — GET /api/events

Returns upcoming open events, optionally filtered by audience.

### Request

```
GET /api/events?audience=Dealer&status=Open+for+Registration
```

| Param      | Required | Description                                  |
|------------|----------|----------------------------------------------|
| `audience` | No       | Filter by `Audience_Type` CRM field value    |
| `status`   | No       | Default: `Open for Registration`             |

### Backend Action

Call the Zoho CRM Search Records API:

```
GET https://www.zohoapis.com/crm/v6/Event_Master/search
  ?criteria=((Event_Status:equals:Open for Registration)AND(Audience_Type:equals:Dealer))
  &fields=id,Name,Event_Type,Delivery_Type,Start_Time,End_Time,Event_Location_Name,
           Event_Address_City,Event_Address_State_Province,Registration_Close_Date,
           Event_Description,Capacity,Audience_Type
  &per_page=200
Authorization: Zoho-oauthtoken ACCESS_TOKEN
```

Omit the `Audience_Type` clause if `audience` param was not provided.

### Response Shape

```json
{
  "events": [
    {
      "id":            "123456789",
      "name":          "Dealer Certification Training",
      "type":          "Training",
      "delivery":      "In-Person",
      "start_display": "2026-07-15 at 09:00",
      "end_display":   "2026-07-15 at 17:00",
      "location":      "Josh.ai HQ",
      "city":          "Denver",
      "state":         "CO",
      "close_date":    "2026-07-10",
      "description":   "Full-day certification course...",
      "capacity":      30,
      "audience":      "Dealer"
    }
  ]
}
```

### Field Mapping (CRM → API)

| API field       | CRM field                          |
|-----------------|------------------------------------|
| `id`            | `id`                               |
| `name`          | `Name`                             |
| `type`          | `Event_Type`                       |
| `delivery`      | `Delivery_Type`                    |
| `start_display` | `Start_Time` formatted as "YYYY-MM-DD at HH:MM" |
| `end_display`   | `End_Time` formatted the same way  |
| `location`      | `Event_Location_Name`              |
| `city`          | `Event_Address_City`               |
| `state`         | `Event_Address_State_Province`     |
| `close_date`    | `Registration_Close_Date` (YYYY-MM-DD) |
| `description`   | `Event_Description`                |
| `capacity`      | `Capacity`                         |
| `audience`      | `Audience_Type`                    |

---

## Endpoint 2 — GET /api/events/:id

Returns full details for a single event.

### Request

```
GET /api/events/123456789
```

### Backend Action

```
GET https://www.zohoapis.com/crm/v6/Event_Master/123456789
Authorization: Zoho-oauthtoken ACCESS_TOKEN
```

### Response Shape

Same fields as the list endpoint, plus:

```json
{
  "id":           "123456789",
  "name":         "...",
  "virtual_link": "https://zoom.us/j/...",
  "is_closed":    false
}
```

| API field      | CRM field                   | Notes                                    |
|----------------|-----------------------------|------------------------------------------|
| `virtual_link` | `Virtual_Meeting_Link`      |                                          |
| `is_closed`    | computed                    | `true` if `Registration_Close_Date` < today |

---

## Endpoint 3 — POST /api/register

Registers a person for an event. Calls the existing `fn_registerGuest` Deluge function in Zoho Creator, which handles: CRM Contact/Lead lookup → Lead creation → duplicate check → capacity check → `Event_Registration` creation → confirmation email.

### Request

```
POST /api/register
Content-Type: application/json

{
  "event_id":   "123456789",
  "first_name": "Jane",
  "last_name":  "Doe",
  "email":      "jane.doe@acme.com",
  "company":    "Acme AV",
  "phone":      "303-555-0100",
  "audience":   "Dealer"
}
```

### Backend Action

Call the Zoho Creator Functions API:

```
POST https://creator.zoho.com/api/v2/joshai839/josh-ai-event-portal/functions/fn_registerGuest/execute
     ?environment=production
Authorization: Zoho-oauthtoken ACCESS_TOKEN
Content-Type: application/x-www-form-urlencoded

arguments={"p_event_id":"123456789","p_first_name":"Jane","p_last_name":"Doe","p_email":"jane.doe@acme.com","p_company":"Acme AV","p_phone":"303-555-0100","p_audience":"Dealer"}
```

**Important:** The `arguments` field is sent as `application/x-www-form-urlencoded`, not JSON body. The value is a URL-encoded JSON string.

The function returns a map. The Zoho API wraps it:

```json
{
  "code": 3000,
  "data": {
    "output": "{\"status\":\"SUCCESS\",\"type\":\"lead\"}"
  }
}
```

Parse `data.output` as JSON to get the status.

### Response Shape

```json
{ "status": "SUCCESS" }
```

| `status` value       | Meaning                                           |
|----------------------|---------------------------------------------------|
| `SUCCESS`            | Registered; confirmation email sent               |
| `ALREADY_REGISTERED` | This email is already registered for this event   |
| `FULL`               | Event has reached capacity                        |
| `CLOSED`             | Registration deadline has passed                  |
| `ERROR`              | Unexpected error; log on backend, show generic msg|

---

## Error Handling

- If the Zoho API returns `401`, refresh the access token and retry once.
- If the CRM search returns an empty array, return `{ "events": [] }`.
- Never expose Zoho credentials or raw Zoho error messages to the browser.
- Log all `ERROR` status registrations server-side for manual follow-up.

---

## CORS

The frontend pages will be hosted on `*.josh.ai`. Your backend should allow:

```
Access-Control-Allow-Origin: https://josh.ai
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## Environment Notes

- **Zoho CRM module name:** `Event_Master` (custom module)
- **Zoho CRM registrations module:** `Event_Registrations` (custom module)
- **Creator app:** `josh-ai-event-portal`
- **Creator account:** `joshai839`
- **Creator function:** `fn_registerGuest`
- **Creator environment:** `production`
- Zoho API base: `https://www.zohoapis.com` (US data center — confirm with your Zoho account region)
