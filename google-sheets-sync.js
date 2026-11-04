/**
 * ============================================================================
 * ITIFY CRM — Google Sheets 2-Way Sync Backend (Apps Script) — v2
 * ============================================================================
 * Changes vs v1 (details in ANTIGRAVITY_HANDOFF.md):
 *  - PIN is verified on EVERY request (v1 never checked it).
 *  - PINs live in Script Properties, not in source code.
 *  - Role + ownership enforced server-side for reads AND writes.
 *  - batch_sync no longer wipes the sheet: admin-only, merges by id.
 *  - Phones/dates stored as plain text (no lost "+"/leading zeros, no date shifts).
 *  - Server-side duplicate check that works across reps without leaking leads.
 *  - Optional conflict detection via baseUpdatedAt.
 *
 * ONE-TIME SETUP:
 *  1. Extensions > Apps Script. Replace Code.gs with this file. Save.
 *  2. Put real PINs in setupTeam() (bottom), select setupTeam, click Run.
 *  3. Set the PINs back to 'CHANGE_ME' in setupTeam() and Save.
 *  4. Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.
 *     Execute as: Me | Who has access: Anyone. (Same /exec URL is kept.)
 * ============================================================================
 */

var SHEET_NAME = '';              // '' = first tab. Or set e.g. 'Leads'.
var DEFAULT_OWNER = 'Amit Yadav';

var TEAM = {
  'Amit Yadav':    { role: 'admin' },
  'Burhan Ali':    { role: 'sales' },
  'Shaharyar Ali': { role: 'sales' }
};

var HEADERS = [
  'id', 'name', 'company', 'phone', 'alternatePhone',
  'email', 'website', 'industry', 'product', 'status',
  'totalAmount', 'revenueType', 'followUp', 'wonDate', 'owner',
  'planProduct', 'planName', 'planValidity', 'planActivationDate', 'planExpiryDate',
  'notes', 'noteEntries', 'updatedAt'
];

var NUMERIC_COLUMNS = ['totalAmount'];   // every other known column is stored as plain text
var MAX_FAILED_ATTEMPTS = 5;
var LOCKOUT_SECONDS = 15 * 60;
var MAX_CELL_CHARS = 49000;              // Google Sheets hard limit is 50,000 per cell

/* ============================== ENTRY POINTS ============================== */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var auth = authenticate_(p.user, p.pin);
    if (!auth.ok) return fail_(auth.error, 401);

    var sheet = getSheet_();
    var headers = getHeaders_(sheet);
    var leads = readLeads_(sheet, headers).leads;
    return ok_({ user: auth.user, leads: visibleLeads_(leads, auth.user) });
  } catch (err) {
    return fail_(String(err), 500);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return fail_('Server busy. Please retry in a moment.', 503);

  try {
    if (!e || !e.postData || !e.postData.contents) return fail_('Empty request body', 400);

    var payload;
    try { payload = JSON.parse(e.postData.contents); }
    catch (x) { return fail_('Request body is not valid JSON', 400); }

    var auth = authenticate_(payload.user, payload.pin);
    if (!auth.ok) return fail_(auth.error, 401);
    var me = auth.user;

    var sheet = getSheet_();
    var headers = ensureHeaders_(sheet);

    switch (payload.action) {
      case 'login':           return ok_({ user: me });
      case 'get_leads':       return ok_({ user: me, leads: visibleLeads_(readLeads_(sheet, headers).leads, me) });
      case 'check_duplicate': return checkDuplicate_(sheet, headers, payload, me);
      case 'save_lead':       return saveLead_(sheet, headers, payload, me);
      case 'delete_lead':     return deleteLead_(sheet, headers, payload, me);
      case 'batch_sync':      return batchSync_(sheet, headers, payload, me);
      default:                return fail_('Unknown action: ' + payload.action, 400);
    }
  } catch (err) {
    return fail_(String(err), 500);
  } finally {
    lock.releaseLock();
  }
}

/* ================================ ACTIONS ================================= */

function checkDuplicate_(sheet, headers, payload, me) {
  var leads = readLeads_(sheet, headers).leads;
  var dup = findDuplicate_(leads, payload, payload.excludeId);
  if (!dup) return ok_({ duplicate: false });

  // Reps learn WHO owns the duplicate, but not another rep's lead details.
  var canSeeDetails = me.isAdmin || dup.lead.owner === me.name;
  return ok_({
    duplicate: true,
    owner: dup.lead.owner,
    reason: dup.reason,
    company: canSeeDetails ? (dup.lead.company || dup.lead.name || '') : '',
    phone: canSeeDetails ? (dup.lead.phone || '') : ''
  });
}

function saveLead_(sheet, headers, payload, me) {
  var lead = payload.lead;
  if (!lead || !lead.id) return fail_('lead.id is required', 400);

  var table = readLeads_(sheet, headers);
  var idx = indexOfId_(table.leads, lead.id);
  var existing = idx >= 0 ? table.leads[idx] : null;

  if (existing) {
    if (!me.isAdmin && existing.owner !== me.name) {
      return fail_('You can only edit leads assigned to you.', 403);
    }
    if (!me.isAdmin) lead.owner = existing.owner;            // reps cannot reassign
    if (isStale_(payload.baseUpdatedAt, existing.updatedAt)) {
      return fail_('This lead was changed by someone else. Reload it and re-apply your edit.', 409,
        { conflict: true, current: existing });
    }
  } else {
    if (!me.isAdmin) lead.owner = me.name;                   // reps create leads for themselves
    var dup = findDuplicate_(table.leads, lead, lead.id);
    if (dup && !me.isAdmin) {
      return fail_('A lead with this number already exists with ' + dup.lead.owner + '.', 409,
        { duplicate: true, owner: dup.lead.owner, reason: dup.reason });
    }
  }

  lead.owner = lead.owner || DEFAULT_OWNER;
  if (!TEAM.hasOwnProperty(lead.owner)) return fail_('Unknown owner: ' + lead.owner, 400);

  var row = leadToRow_(headers, lead, existing ? table.values[idx] : null, false);
  var sheetRow = existing ? idx + 2 : sheet.getLastRow() + 1;
  writeRows_(sheet, headers, sheetRow, [row]);

  return ok_({ message: 'Saved', updatedAt: row[headers.indexOf('updatedAt')] });
}

function deleteLead_(sheet, headers, payload, me) {
  var table = readLeads_(sheet, headers);
  var idx = indexOfId_(table.leads, payload.id);
  if (idx < 0) return ok_({ message: 'Already deleted' });
  if (!me.isAdmin && table.leads[idx].owner !== me.name) {
    return fail_('You can only delete leads assigned to you.', 403);
  }
  sheet.deleteRow(idx + 2);
  return ok_({ message: 'Deleted' });
}

/**
 * Admin-only. MERGES by id; never clears the sheet and never deletes rows
 * (use delete_lead for deletions). Rows newer in the sheet than in the
 * payload are skipped, so a stale browser tab cannot overwrite fresh edits.
 */
function batchSync_(sheet, headers, payload, me) {
  if (!me.isAdmin) return fail_('Only admin can run a batch sync.', 403);

  var incoming = Array.isArray(payload.leads) ? payload.leads : [];
  var table = readLeads_(sheet, headers);
  var rows = table.values.slice();
  var pos = {};
  table.leads.forEach(function (l, i) { if (l.id !== '') pos[String(l.id)] = i; });

  var written = 0, skippedStale = [], invalid = [];
  incoming.forEach(function (lead) {
    if (!lead || !lead.id) return;
    lead.owner = lead.owner || DEFAULT_OWNER;
    if (!TEAM.hasOwnProperty(lead.owner)) { invalid.push(lead.id); return; }

    var i = pos[String(lead.id)];
    if (i !== undefined) {
      if (isStale_(lead.updatedAt, table.leads[i].updatedAt)) { skippedStale.push(lead.id); return; }
      rows[i] = leadToRow_(headers, lead, rows[i], true);
    } else {
      pos[String(lead.id)] = rows.length;
      rows.push(leadToRow_(headers, lead, null, true));
    }
    written++;
  });

  if (rows.length) writeRows_(sheet, headers, 2, rows);
  return ok_({ count: written, skippedStale: skippedStale, invalidOwner: invalid });
}

/* ================================== AUTH ================================== */

function authenticate_(user, pin) {
  user = String(user || '').trim();
  if (!TEAM.hasOwnProperty(user)) return { ok: false, error: 'Invalid user or PIN' };

  var cache = CacheService.getScriptCache();
  var failKey = 'pinfail_' + user;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  var pins = getPins_();
  if (!pins[user] || String(pin || '').trim() !== String(pins[user])) {
    cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
    return { ok: false, error: 'Invalid user or PIN' };
  }

  cache.remove(failKey);
  var isAdmin = TEAM[user].role === 'admin';
  return { ok: true, user: { name: user, role: TEAM[user].role, isAdmin: isAdmin } };
}

function getPins_() {
  var raw = PropertiesService.getScriptProperties().getProperty('TEAM_PINS');
  if (!raw) throw new Error('PINs not configured. Run setupTeam() once from the Apps Script editor.');
  return JSON.parse(raw);
}

/* ============================== SHEET HELPERS ============================= */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) throw new Error('Sheet tab "' + SHEET_NAME + '" not found');
  return sheet;
}

function getHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() === 0 || lastCol === 0) return HEADERS.slice();
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** Writes the header row if missing and appends any missing known columns. */
function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }
  var headers = getHeaders_(sheet);
  var missing = HEADERS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  return headers;
}

function readLeads_(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { values: [], leads: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return { values: values, leads: values.map(function (r) { return rowToLead_(headers, r, tz); }) };
}

function rowToLead_(headers, row, tz) {
  var lead = {};
  for (var j = 0; j < headers.length; j++) {
    var key = headers[j];
    if (!key) continue;
    var v = row[j];
    if (v instanceof Date) {
      v = key === 'updatedAt' ? v.toISOString() : formatDate_(v, tz);
    } else if ((key === 'phone' || key === 'alternatePhone') && typeof v === 'number') {
      v = String(v);                                   // legacy rows stored phones as numbers
    }
    lead[key] = v;
  }

  if (!lead.owner || lead.owner === 'ME' || lead.owner === 'AM') lead.owner = DEFAULT_OWNER;

  var ne = lead.noteEntries;
  if (typeof ne === 'string') {
    try { ne = ne ? JSON.parse(ne) : []; } catch (x) { ne = []; }
  }
  lead.noteEntries = Array.isArray(ne) ? ne : [];
  return lead;
}

/** keepUpdatedAt=true keeps the payload's timestamp (batch); false stamps now. */
function leadToRow_(headers, lead, existingRow, keepUpdatedAt) {
  return headers.map(function (h, j) {
    if (HEADERS.indexOf(h) === -1) return existingRow ? existingRow[j] : '';   // preserve custom columns

    switch (h) {
      case 'updatedAt':
        return (keepUpdatedAt && lead.updatedAt) ? String(lead.updatedAt) : new Date().toISOString();
      case 'owner':
        return lead.owner || DEFAULT_OWNER;
      case 'revenueType':
        return lead.revenueType ||
          ((lead.planExpiryDate || lead.planActivationDate) ? 'Renewal Amount' : 'New Revenue');
      case 'noteEntries':
        var s = JSON.stringify(Array.isArray(lead.noteEntries) ? lead.noteEntries : []);
        if (s.length > MAX_CELL_CHARS) {
          throw new Error('Note history for lead ' + lead.id + ' exceeds the Sheets cell limit.');
        }
        return s;
    }

    var v = lead[h];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;                                           // keeps 0 (v1 turned 0 into '')
  });
}

function writeRows_(sheet, headers, startRow, rows) {
  var needed = startRow + rows.length - 1;
  var max = sheet.getMaxRows();
  if (needed > max) sheet.insertRowsAfter(max, needed - max);
  applyTextFormat_(sheet, headers, startRow, rows.length);   // must happen BEFORE setValues
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
}

/** Plain-text format stops Sheets turning "+91…" into numbers and "2026-11-04" into Dates. */
function applyTextFormat_(sheet, headers, startRow, numRows) {
  if (numRows < 1) return;
  var a1 = [];
  headers.forEach(function (h, j) {
    if (HEADERS.indexOf(h) !== -1 && NUMERIC_COLUMNS.indexOf(h) === -1) {
      a1.push(sheet.getRange(startRow, j + 1, numRows, 1).getA1Notation());
    }
  });
  if (a1.length) sheet.getRangeList(a1).setNumberFormat('@');
}

/* ============================== MISC HELPERS ============================== */

function normPhone_(p) {
  var digits = String(p == null ? '' : p).replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

function findDuplicate_(leads, data, excludeId) {
  var p1 = normPhone_(data.phone), p2 = normPhone_(data.alternatePhone);
  if (!p1 && !p2) return null;
  for (var i = 0; i < leads.length; i++) {
    var l = leads[i];
    if (excludeId && String(l.id) === String(excludeId)) continue;
    var lp1 = normPhone_(l.phone), lp2 = normPhone_(l.alternatePhone);
    if (p1 && (p1 === lp1 || p1 === lp2)) return { lead: l, reason: 'Phone Number' };
    if (p2 && (p2 === lp1 || p2 === lp2)) return { lead: l, reason: 'Alternate Phone' };
  }
  return null;
}

function indexOfId_(leads, id) {
  if (id === undefined || id === null || id === '') return -1;
  for (var i = 0; i < leads.length; i++) {
    if (String(leads[i].id) === String(id)) return i;
  }
  return -1;
}

/** True when the sheet copy is newer than the version the client edited. */
function isStale_(clientTs, sheetTs) {
  if (!clientTs || !sheetTs) return false;
  var c = Date.parse(clientTs), s = Date.parse(sheetTs);
  if (isNaN(c) || isNaN(s)) return false;
  return s > c;
}

function visibleLeads_(leads, me) {
  return leads.filter(function (l) {
    if (!l.id && !l.name && !l.phone) return false;           // skip blank rows
    return me.isAdmin || l.owner === me.name;
  });
}

function formatDate_(d, tz) {
  var hasTime = Utilities.formatDate(d, tz, 'HH:mm') !== '00:00';
  return Utilities.formatDate(d, tz, hasTime ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd');
}

function ok_(obj) { obj = obj || {}; obj.success = true; return json_(obj); }

// Apps Script always returns HTTP 200, so the real status is in `code`.
function fail_(msg, code, extra) {
  var o = extra || {};
  o.success = false;
  o.error = msg;
  o.code = code || 400;
  return json_(o);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ ONE-TIME SETUP ============================== */

/**
 * Run once from the editor after entering PINs, then reset them to 'CHANGE_ME'.
 * To add a teammate: add them to TEAM above and here, then run again.
 */
function setupTeam() {
  var pins = {
    'Amit Yadav':    'CHANGE_ME',
    'Burhan Ali':    'CHANGE_ME',
    'Shaharyar Ali': 'CHANGE_ME'
  };
  Object.keys(TEAM).forEach(function (name) {
    if (!/^\d{4,8}$/.test(String(pins[name] || ''))) {
      throw new Error('Set a 4–8 digit PIN for ' + name + ' before running setupTeam().');
    }
  });
  PropertiesService.getScriptProperties().setProperty('TEAM_PINS', JSON.stringify(pins));

  var sheet = getSheet_();
  var headers = ensureHeaders_(sheet);
  applyTextFormat_(sheet, headers, 2, sheet.getMaxRows() - 1);
  Logger.log('PINs saved and columns formatted. Now set the PINs above back to CHANGE_ME and Save.');
}
