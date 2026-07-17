# CRM Setup — Complete Before Building Creator App

## 1. Verify Event_Master API Field Names

Go to CRM > Settings > Modules and Fields > Event Master > each field > check "API Name" column.
Confirm the API names match what the code uses:

| Field Label | Expected API Name | Verify |
|-------------|-------------------|--------|
| Event Name | Event_Name | ☐ |
| Event Status | Event_Status | ☐ |
| Audience Type | Audience_Type | ☐ |
| Event Type | Event_Type | ☐ |
| Delivery Type | Delivery_Type | ☐ |
| Start Time | Start_Time | ☐ |
| End Time | End_Time | ☐ |
| Event URL | Event_URL | ☐ |
| Virtual Meeting Link | Virtual_Meeting_Link | ☐ |
| Event Location Name | Event_Location_Name | ☐ |
| Registration Close Date | Registration_Close_Date | ☐ |
| Capacity | Capacity | ☐ |
| Rep Firm | Rep_Firm | ☐ |
| Event Description | Event_Description | ☐ |
| State / Province | State_Province | ☐ |
| City | City | ☐ |

If any API name differs, update the corresponding line in the Deluge functions.

---

## 2. Add Is_Public Field to Event_Master

This checkbox controls whether an event appears on the unauthenticated public event page.

**Create this field on Event_Master:**
- Label: `Is Public`
- API Name: `Is_Public`
- Field Type: Checkbox
- Default: unchecked (private/gated by default)

When checked, the event is visible to anyone — no portal login required.
When unchecked, the event only appears for logged-in contacts who match the Audience Type.

A public event can also have an Audience Type set — this controls what shows on the *gated*
portal. The Is_Public flag only affects the unauthenticated PublicEvents page.

---

## 3. Add Target Region Field to Event_Master

The existing "Country/Region" field in the location block is for the venue address. You need a
separate field to control which Regional Team can see each event.

**Create this field on Event_Master:**
- Label: `Target Region`
- API Name: `Target_Region`
- Field Type: Multi-Select Picklist
- Values: *(match your exact Regional_Team values in CRM — e.g., East, West, National)*
- Leave blank = visible to all regions

---

## 3. Create Event_Registrations Module

Go to CRM > Settings > Modules and Fields > Create New Module.

**Module Settings:**
- Display Name: `Event Registrations`
- Plural Name: `Event Registrations`
- API Name: `Event_Registrations`

**Fields to create:**

| Label | API Name | Type | Notes |
|-------|----------|------|-------|
| Contact | Contact | Lookup (Contacts) | Optional — filled for known contacts |
| Lead | Lead | Lookup (Leads) | Optional — filled for public registrants not yet in Contacts |
| Event | Event | Lookup (Event_Master) | Required |
| Registration Date | Registration_Date | Date/Time | Default: now |
| Status | Status | Picklist | Values below |
| Check-In Time | Check_In_Time | Date/Time | |
| Registration Source | Registration_Source | Picklist | Values below |
| Notes | Notes | Multi-line Text | |
| Cancellation Reason | Cancellation_Reason | Single Line | |

**Status picklist values:**
- Registered
- Waitlisted
- Attended
- No-Show
- Cancelled

**Registration Source picklist values:**
- Portal
- Manual
- QR Scan
- Zoom Import

**Module Name Field:**
Set the auto-name formula to: `{Contact} — {Event}` (Contact may be blank for guest registrants — Zoho will use the Lead value instead if Contact is empty)

**Validation rule (recommended):**
Add a validation that requires at least one of Contact or Lead to be populated. This prevents orphaned registration records.

---

## 4. Add Related Lists

**On Event_Master record page:**
- Add related list: Event_Registrations (linked via Event field)
- This lets the sales team see all registrants for an event

**On Contacts record page:**
- Add related list: Event_Registrations (linked via Contact field)
- This shows all events a contact has registered for

---

## 5. Set Up Zoho CRM Connection in Creator

When you create the Creator app, you will need to connect it to CRM:
1. In Creator > Settings > Connections > Add Connection
2. Select "Zoho CRM"
3. Authorize with your Zoho admin account
4. Grant scopes: `ZohoCRM.modules.ALL`, `ZohoCRM.settings.ALL`

The Deluge functions use `zoho.crm.*` built-in functions which use this connection automatically.

---

## 6. Notes on CRM Search Limits

`zoho.crm.searchRecords` returns a maximum of 200 records per call. If you ever have more than
200 events in "Open for Registration" status simultaneously, the `fn_getFilteredEvents` function
will need pagination added. For typical event volumes this limit is not a concern.
