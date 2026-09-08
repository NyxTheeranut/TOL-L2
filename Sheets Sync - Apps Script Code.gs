/**
 * L2 Discount Map -- Google Sheets backend (sign-in gate + live data).
 *
 * What this is: the API the hosted L2 Discount Map page calls. It runs inside
 * a Google Sheet, as that Sheet's owner -- there is no separate server to
 * host or pay for, and the Sheet itself is the database. Modeled on the
 * Route Planner project's Apps Script backend, with the per-person store
 * scoping (ae/cm/admin roles) dropped: every signed-in, allow-listed viewer
 * of this map sees the same full dataset, there's no "my own records"
 * concept here the way Route Planner's visits/routes have.
 *
 * ── Data layout ────────────────────────────────────────────────────────────
 * "L2 Points" -- one row per L2 splitter that currently has an active
 *   discount. Populated (fully overwritten each run, never appended) by
 *   running update_l2_sheet.py locally whenever the source Project Atlas
 *   xlsx changes. This is what myL2Data reads from.
 * "Condition" -- the discount lookup table, flattened to one row per
 *   (Archetype x ARPA-band x Port-group x NAD-flag x MKT-package)
 *   combination -- 36 conditions x 9 packages = 324 rows normally. Kept flat
 *   like this (rather than one JSON blob per condition) so a price or
 *   discount can be hand-edited directly in the Sheet if needed; myL2Data
 *   reassembles the nested shape the page's findCondition() expects.
 * "Users" -- who's allowed to view the map: just an email allow-list (no
 *   roles -- an allow-listed email gets the full dataset). Created
 *   automatically (with a sample row) the first time anyone signs in, if it
 *   doesn't exist yet -- fill in real rows for your team, delete the sample.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * The page signs the user in with Google Identity Services and sends the
 * resulting ID token on every request. This script verifies that token
 * against Google directly (no session/cookie trust needed) and checks the
 * token's audience against OAUTH_CLIENT_ID, so it only accepts tokens issued
 * for THIS app -- not a token from some other Google sign-in.
 *
 * A verified token proves WHO is calling, not that they're allowed to. Every
 * action enforces that separately:
 *   myL2Data   -> requires the email to be a row in Users. An email that
 *                 isn't gets an explicit "not set up" response, not a
 *                 filtered-to-empty dataset.
 *   syncL2Data -> not a person signing in at all (it's update_l2_sheet.py on
 *                 your own machine), so it can't go through the Users tab --
 *                 gated by a shared SYNC_SECRET instead.
 *
 * ── SETUP (one-time) -- see this repo's README.md for the full walkthrough ─
 *  1. Create a new Google Sheet (or open one dedicated to this app).
 *  2. Extensions -> Apps Script. Delete any starter code, paste this whole file in.
 *  3. Project Settings (gear icon, left sidebar) -> Script Properties -> Add:
 *       OAUTH_CLIENT_ID = <the Client ID from Google Cloud Console>
 *       SYNC_SECRET = <any random string -- e.g. `openssl rand -hex 24` in a
 *       terminal. Also put this exact value into Config/l2_sync_secret.txt
 *       (see update_l2_sheet.py). Without this, anyone who found the
 *       deployment URL could overwrite the entire dataset with one request.
 *  4. Deploy -> New deployment -> Type: Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     ("Anyone" is fine here -- real access control happens via the ID token +
 *     Users tab check above, not via this deployment setting.)
 *  5. Deploy, authorize when prompted, copy the Web app URL into index.html's
 *     DEFAULT_SYNC_URL and update_l2_sheet.py's SYNC_URL.
 *  6. Sign in once from the page with any Google account -- this creates the
 *     Users tab (with a sample row). Edit it (or add rows) for your team,
 *     delete the sample row.
 *  7. Run update_l2_sheet.py to populate "L2 Points" / "Condition".
 */

var CONDITION_HEADER = [
  "arch", "arpaGroup", "port", "nad", "discPct",
  "mktNo", "code", "desc", "disc", "normal", "special",
];
var L2_POINTS_HEADER = [
  "id", "hpb", "lat", "lon", "arch", "port", "arpa", "arpaGroup", "nad", "adm2", "adm3", "village",
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === "myL2Data") {
      return jsonResponse_(myL2Data_(body.idToken));
    }

    if (body.action === "syncL2Data") {
      // Only ever called from your own machine via update_l2_sheet.py, but
      // unlike myL2Data it can't go through the ID-token/Users-tab check --
      // it's not a person signing in, it's a script. This deployment's URL
      // sits in plain text in the public index.html, so without SOME check,
      // anyone who found it could wipe and replace the entire dataset with a
      // single unauthenticated request.
      requireSyncSecret_(body.secret);
      var result = syncL2Data_(body.points || [], body.conditions || []);
      return jsonResponse_({ ok: true, pointCount: result.pointCount, conditionRowCount: result.conditionRowCount });
    }

    return jsonResponse_({ ok: false, error: "unknown action" });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return jsonResponse_({ ok: true });
}

// ---------- auth ----------

function requireSyncSecret_(secret) {
  var expected = PropertiesService.getScriptProperties().getProperty("SYNC_SECRET");
  if (!expected) throw new Error("SYNC_SECRET script property is not set -- see setup notes at the top of this file");
  if (secret !== expected) throw new Error("forbidden: bad sync secret");
}

// Verifies the ID token directly against Google (not just trusting the client) and
// checks it was issued for THIS app specifically, via the audience claim.
function verifyIdToken_(idToken) {
  if (!idToken) return null;
  var resp = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var expectedClientId = PropertiesService.getScriptProperties().getProperty("OAUTH_CLIENT_ID");
  if (!expectedClientId) throw new Error("OAUTH_CLIENT_ID script property is not set -- see setup notes at the top of this file");
  if (data.aud !== expectedClientId) return null;
  if (!data.email || data.email_verified !== "true") return null;
  return data.email;
}

// Looks up whether a verified email is allow-listed. Creates the Users tab
// (with a sample row) on first use if it doesn't exist yet, so there's
// something to edit.
function isAllowedUser_(email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Users");
  if (!sheet) {
    sheet = ss.insertSheet("Users");
    sheet.appendRow(["email", "note"]);
    sheet.appendRow(["example@gmail.com", "sample row -- replace with your team, then delete this"]);
    sheet.setFrozenRows(1);
    return false; // just created -- nothing real to match against yet
  }
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var emailCol = header.indexOf("email");
  if (emailCol === -1) return false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emailCol]).trim().toLowerCase() === email.toLowerCase()) return true;
  }
  return false;
}

// ---------- myL2Data: the whole point of the auth layer ----------
// A signed-in, allow-listed viewer gets the full dataset -- there's no
// per-person scoping to apply here (unlike Route Planner's stores), every
// viewer of this map is meant to see the same discount targeting data.
function myL2Data_(idToken) {
  var email = verifyIdToken_(idToken);
  if (!email) return { ok: false, error: "not_signed_in" };
  if (!isAllowedUser_(email)) {
    return {
      ok: false,
      error: "no_access",
      message: "This Google account (" + email + ") isn't set up yet. Ask an admin to add it to the Users tab.",
    };
  }
  return {
    ok: true,
    email: email,
    points: readL2Points_(),
    conditions: readConditions_(),
  };
}

function readL2Points_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("L2 Points");
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  var points = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[idx.id]) continue;
    points.push({
      id: String(row[idx.id]),
      hpb: String(row[idx.hpb]),
      lat: Number(row[idx.lat]),
      lon: Number(row[idx.lon]),
      arch: String(row[idx.arch]),
      port: String(row[idx.port]),
      arpa: Number(row[idx.arpa]),
      arpaGroup: String(row[idx.arpaGroup]),
      nad: String(row[idx.nad]),
      adm2: String(row[idx.adm2]),
      adm3: String(row[idx.adm3]),
      village: row[idx.village] ? String(row[idx.village]) : null,
    });
  }
  return points;
}

// Reassembles the flat "Condition" tab (one row per condition x MKT-package)
// back into the nested {arch, arpaGroup, port, nad, discPct, mkts:[...]}
// shape index.html's findCondition() expects -- same shape it already had
// when this data was embedded directly in the page.
function readConditions_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Condition");
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });

  var byKey = {}; // "arch|arpaGroup|port|nad" -> condition object
  var order = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[idx.arch]) continue;
    var key = [row[idx.arch], row[idx.arpaGroup], row[idx.port], row[idx.nad]].join("|");
    if (!byKey[key]) {
      byKey[key] = {
        arch: String(row[idx.arch]),
        arpaGroup: String(row[idx.arpaGroup]),
        port: String(row[idx.port]),
        nad: String(row[idx.nad]),
        discPct: Number(row[idx.discPct]),
        mkts: [],
      };
      order.push(key);
    }
    byKey[key].mkts.push({
      code: String(row[idx.code]),
      desc: String(row[idx.desc]),
      disc: Number(row[idx.disc]),
      normal: Number(row[idx.normal]),
      special: Number(row[idx.special]),
    });
  }
  return order.map(function (key) { return byKey[key]; });
}

// ---------- syncL2Data: update_l2_sheet.py's write path ----------

function syncL2Data_(points, conditions) {
  writePointsSheet_(points);
  var conditionRowCount = writeConditionSheet_(conditions);
  return { pointCount: points.length, conditionRowCount: conditionRowCount };
}

function writePointsSheet_(points) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("L2 Points");
  if (!sheet) sheet = ss.insertSheet("L2 Points");
  sheet.clearContents();
  var rows = [L2_POINTS_HEADER];
  points.forEach(function (p) {
    rows.push([
      p.id || "", p.hpb || "", p.lat != null ? p.lat : "", p.lon != null ? p.lon : "",
      p.arch || "", p.port || "", p.arpa != null ? p.arpa : "", p.arpaGroup || "",
      p.nad || "", p.adm2 || "", p.adm3 || "", p.village || "",
    ]);
  });
  var range = sheet.getRange(1, 1, rows.length, L2_POINTS_HEADER.length);
  // Plain-text format BEFORE writing, not after -- Sheets "helpfully"
  // auto-detects some ID-like strings as numbers/dates otherwise (same issue
  // Route Planner hit with "7-11" being read as a date).
  range.setNumberFormat("@");
  range.setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, L2_POINTS_HEADER.length);
}

function writeConditionSheet_(conditions) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Condition");
  if (!sheet) sheet = ss.insertSheet("Condition");
  sheet.clearContents();
  var rows = [CONDITION_HEADER];
  conditions.forEach(function (c) {
    (c.mkts || []).forEach(function (m, i) {
      rows.push([
        c.arch || "", c.arpaGroup || "", c.port || "", c.nad || "", c.discPct != null ? c.discPct : "",
        i + 1, m.code || "", m.desc || "", m.disc != null ? m.disc : "",
        m.normal != null ? m.normal : "", m.special != null ? m.special : "",
      ]);
    });
  });
  var range = sheet.getRange(1, 1, rows.length, CONDITION_HEADER.length);
  range.setNumberFormat("@");
  range.setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, CONDITION_HEADER.length);
  return rows.length - 1;
}

// ---------- shared ----------

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
