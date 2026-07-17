# Josh.ai Event Portal — Zoho Creator App

A gated external portal that allows dealers, reps, specifiers, and other contacts to:
- Browse and register for events filtered to their audience type and region
- View their upcoming and past registrations
- See their certifications on file

## Stack
| Layer | Tool |
|-------|------|
| Portal app | Zoho Creator |
| Event data | Zoho CRM — Event_Master module |
| Registrations | Zoho CRM — Event_Registrations module |
| Contacts | Zoho CRM — Contacts module |
| Auth | Magic link (email → token → 24-hour session) |

## Folder Structure
```
functions/          Deluge custom functions — copy into Creator > Functions
pages/              Creator page code — Deluge + HTML for each portal page
CRM_Setup.md        What to create in CRM before building the Creator app
Creator_App_Setup.md  Step-by-step Creator app setup instructions
```

## Setup Order
1. Read `CRM_Setup.md` and complete all CRM work first
2. Read `Creator_App_Setup.md` and follow the sequence
3. Create the `Portal_Sessions` form in Creator
4. Add all 9 custom functions from the `functions/` folder
5. Create the 6 pages from the `pages/` folder
6. Configure the external portal and test end-to-end

## Key Configuration Values
Find and replace these throughout the code before deploying:

| Placeholder | Replace with |
|-------------|-------------|
| `YOUR_APP_LINK_NAME` | Your Creator app link name (e.g. `joshaievents`) |
| `YOUR_ZOHO_ACCOUNT` | Your Zoho account name (shown in Creator URL) |
| `YOUR_ADMIN_EMAIL` | Zoho admin account email (app owner) |
| `YOUR_PORTAL_BASE_URL` | Full portal URL (from Creator > Portal settings) |

## Audience Mapping Logic
| CRM Organization_Label | Sees events with Audience_Type |
|------------------------|-------------------------------|
| Dealer | Dealer |
| Buying Group | Dealer |
| Partner Showroom | Dealer |
| Rep Firm | Rep |
| Specifier | Specifier, Designer |
| Industry Partner | Designer, Specifier |
| Nimble Dev Partner | Designer, Dealer |
| (any valid contact) | End User |
| Internal (josh.ai email) | Internal |

Review and adjust this mapping in `fn_getAudienceTypes` to match your business rules.
