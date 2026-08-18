/**
 * AVSEC REPORTS -> Google Sheets one-way mirror.
 *
 * Receives a batched POST from the avsec-ops "sheets-sync" Supabase Edge Function and
 * appends each row into the matching sheet (creating it with a header row on first use).
 * Idempotent: before appending, it checks whether the row's Report No is already present
 * in column A of that sheet, so a retried/duplicate delivery never double-writes a row.
 *
 * Setup — see docs/GOOGLE_SHEETS_SETUP.md for the full walkthrough:
 *   1. Open (or create) the target Google Sheet.
 *   2. Extensions > Apps Script. Delete any starter code and paste this whole file in.
 *   3. Set SYNC_SECRET below to a long random string.
 *   4. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone.
 *   5. Copy the deployment's Web App URL.
 *   6. In the AVSEC REPORTS app: Profile > Google Sheets Sync (Admin only) — paste the Web
 *      App URL into "Apps Script Web App URL" and the SAME string from step 3 into
 *      "Shared Secret". Tick "Sync enabled" and save.
 */

// Must exactly match the "Shared Secret" saved in /admin/sheet-sync.
const SYNC_SECRET = "REPLACE_WITH_A_LONG_RANDOM_SECRET";

// One tab per report type, created automatically on first delivery.
const SHEET_NAMES = {
  sec016: "SEC016",
  sec014: "SEC014",
  sec029: "SEC029",
  sec018: "SEC018",
  sec033: "SEC033",
  sec013: "SEC013",
  offload: "OFFLOAD",
};

// Column order per sheet — mirrors the app's own Excel export columns. "report_no" is
// always column A, since that's what the idempotency check looks up.
const COLUMNS = {
  sec016: [
    "report_no", "submitted_at", "station", "team", "staff_name", "staff_no",
    "duty_date", "duty_hour", "flight", "origin_arr_dep", "aircraft_type", "reg_no",
    "bay_no", "sta_std", "ata_atd", "do_infmd", "cargo_hold_checked", "staff_frisked",
    "discrepancies",
  ],
  sec014: ["report_no", "submitted_at", "station", "team", "staff_name", "staff_id", "date_time_in", "date_time_out", "remark"],
  sec029: ["report_no", "submitted_at", "station", "team", "staff_name", "staff_id", "flight_no", "aircraft_registration", "parking_bay", "declaration"],
  sec018: ["report_no", "submitted_at", "station", "team", "staff_name", "date_time"],
  sec033: ["report_no", "submitted_at", "station", "team", "staff_name", "staff_id", "report_date", "report_time"],
  sec013: ["report_no", "submitted_at", "station", "team", "staff_name", "staff_id", "date_time_in", "date_time_out", "remark", "corrective_action"],
  offload: ["report_no", "submitted_at", "station", "team", "staff_name", "staff_id", "flight_no", "destination", "aircraft_registration", "flight_date", "std", "total_bags", "remark"],
};

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.secret !== SYNC_SECRET) {
      return jsonOut({ ok: false, error: "Unauthorized" });
    }

    var rows = payload.rows || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var written = 0;

    rows.forEach(function (row) {
      var type = row.report_type;
      var sheetName = SHEET_NAMES[type];
      var columns = COLUMNS[type];
      if (!sheetName || !columns) return;

      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        sheet.appendRow(columns);
      }

      var reportNo = row.report_no || row.id;
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        var existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });
        if (existing.indexOf(reportNo) !== -1) return; // already synced — skip
      }

      sheet.appendRow(columns.map(function (c) {
        var v = row[c];
        return v === undefined || v === null ? "" : v;
      }));
      written++;
    });

    return jsonOut({ ok: true, written: written, received: rows.length });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
