# Creator App Setup Guide

Complete CRM_Setup.md first before starting here.

---

## Step 1: Create the App

1. Go to creator.zoho.com > Create Application
2. Name: `Josh.ai Event Portal`
3. App Link Name: `joshaievents` *(or your preferred slug — update YOUR_APP_LINK_NAME in all code)*
4. Start from scratch (blank app)
5. Note your Zoho account name from the URL — you'll need it for YOUR_ZOHO_ACCOUNT

---

## Step 2: Create the Portal_Sessions Form

This form is the only data store in Creator. It holds magic link tokens and session tokens.

Go to: App > Add Form > Name it `Portal_Sessions`

Add these fields:

| Field Label | API Name | Type | Settings |
|-------------|----------|------|----------|
| Token | Token | Single Line | Mark as Unique |
| Email | Email | Email | |
| CRM Contact ID | CRM_Contact_ID | Single Line | |
| Expires At | Expires_At | Date-Time | |
| Is Used | Is_Used | Checkbox | Default: unchecked |
| Session Type | Session_Type | Dropdown | Values: magic_link, session |

**Disable the default submit form page** (the form is only written to by Deluge, never by end users).

Set a scheduled cleanup workflow: delete Portal_Sessions records older than 7 days.
(App > Workflow > Scheduled > every day > delete where Created_Time < 7 days ago)

---

## Step 3: Add Custom Functions

Go to: App > Functions > New Function

Create each function in this order (some functions call others, so order matters):

1. `fn_getAudienceTypes` — no dependencies
2. `fn_getContactProfile` — no dependencies
3. `fn_validateSession` — no dependencies
4. `fn_generateMagicLink` — no dependencies
5. `fn_verifyToken` — no dependencies
6. `fn_getFilteredEvents` — calls fn_getAudienceTypes
7. `fn_registerContact` — no dependencies
8. `fn_cancelRegistration` — no dependencies
9. `fn_getMyRegistrations` — no dependencies

Copy the code from each file in the `functions/` folder.
The first line of each file declares the function signature — use that exact signature when creating the function in Creator.

**Before saving each function:** replace the four placeholder values:
- `YOUR_APP_LINK_NAME` → your app link name
- `YOUR_ADMIN_EMAIL` → your Zoho admin email
- `YOUR_PORTAL_BASE_URL` → your portal URL (you'll get this in Step 5)

---

## Step 4: Create Pages

Go to: App > Pages > New Page

Create each page and name it exactly as shown (the name becomes part of the URL):

| Page Name | Source File | Notes |
|-----------|-------------|-------|
| Login | pages/Login.page | Entry point — no session required |
| Verify | pages/Verify.page | Magic link landing page |
| Events | pages/Events.page | Main event listing |
| EventDetail | pages/EventDetail.page | Single event + registration |
| MyRegistrations | pages/MyRegistrations.page | User's registration history |
| MyCertifications | pages/MyCertifications.page | Certifications placeholder |

For each page:
1. Create the page
2. Add a "Script" block — paste the DELUGE SCRIPT section from the .page file
3. Add an HTML component — paste the HTML COMPONENT section from the .page file
4. Save

---

## Step 5: Configure External Portal Access

Go to: App > Settings > Portal

1. Enable external access
2. Note the portal URL — this is YOUR_PORTAL_BASE_URL
3. Set the landing page to: `Login`
4. Customize the portal name: "Josh.ai Event Portal"

Go back and update YOUR_PORTAL_BASE_URL in all functions and pages.

---

## Step 6: Configure Email Sender

The `sendmail` in Deluge sends from the address specified in the `from:` field.
The email `events@josh.ai` must be:
1. A verified email address in your Zoho organization, OR
2. A Zoho Mail alias configured for your domain

Go to: Zoho Mail > Settings > Email Aliases and verify `events@josh.ai` is set up.
If using a different address, find/replace `events@josh.ai` throughout all function files.

---

## Step 7: End-to-End Test

1. Open the portal URL in an incognito window
2. Enter an email address that exists as a Contact in CRM
3. Check that the magic link email arrives within 30 seconds
4. Click the link — verify it redirects to the Events page
5. Confirm only events matching the contact's audience type are shown
6. Click an event and register — verify the registration appears in CRM
7. Visit My Registrations — verify it shows the event just registered for

---

## Step 8: Embed on Your Website

Once the portal is live, you have two options for your website:

**Option A — Direct Link**
Add a nav link "Event Portal" pointing to YOUR_PORTAL_BASE_URL.
Users land directly on the Login page.

**Option B — Iframe Embed**
```html
<iframe 
  src="YOUR_PORTAL_BASE_URL" 
  width="100%" 
  height="800px" 
  frameborder="0"
  style="border-radius:8px;">
</iframe>
```
Note: Zoho Creator portals can be embedded in iframes, but some browser security settings
may block third-party cookies. Direct link (Option A) is more reliable.
