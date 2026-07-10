# Weekly dashboard data update

The dashboard (`dashboard/index.html`) has no live connection to Google Sheets —
Google's Workspace policy blocks anonymous browser access to the sheet, so the
data is baked into the file as a static snapshot instead.

## Process

1. Each week, export the "Chekin Dashboard Data (Public)" Google Sheet as
   `.xlsx` (File > Download > Microsoft Excel (.xlsx)) and send the file over.
2. Run:
   ```
   python3 scripts/update_dashboard_data.py <path-to-export.xlsx>
   ```
   This regenerates the `STATIC_ROWS` block in `dashboard/index.html` and
   updates the "Week of ..." / "Data snapshot: ..." date labels.
3. Check the script's printed sanity-check lines — if any tab says
   `CHECK OFFSETS`, the sheet's column layout has drifted (this has happened
   before: `REMOTE ACCESS` and `SECURITY DEPOSIT` shifted between exports) and
   `scripts/update_dashboard_data.py`'s `SHEETS`/`BASE_OFFSETS` need a manual
   fix before trusting the output.
4. Commit `dashboard/index.html` and republish the artifact.

## Why not live?

Both the original master sheet and a PII-scrubbed public copy were tested
with "anyone with the link" sharing enabled, but an anonymous (logged-out)
fetch still returns HTTP 403 on both — a Google Workspace admin policy
blocking external/anonymous Drive access, not a per-file setting. Until that's
lifted (or `File > Share > Publish to web` is used and confirmed to work),
manual weekly updates via this script are the reliable path.
