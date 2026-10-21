-- SDK Forecast Bench — Housing ID refresh, housings created up to 30 Sep 2026
--
-- Run locally through the tunnel:
--   psql -h localhost -p 5433 -U readonly_user -d production-core -f sql/sdk_housings_2026-09-30.sql
--
-- Output: sdk_housings_2026-09-30.csv in the current directory, same 32 columns
-- (same names, same order) as the Housing ID tab, so the artifact can take it as-is.
--
-- STEP 1 is schema discovery. The table/column names in STEP 2 are educated guesses
-- from the column headers of the previous export — if STEP 2 errors on a name, the
-- STEP 1 output shows the real one. Send me the STEP 1 output and I'll fix STEP 2.
--
-- Note on "as of 30/09": this reads the CURRENT state of each housing (ACTIVE, features
-- on/off, subscription status). Only created_at is cut at 30 Sep. If the backend has no
-- state history, housings deactivated between 1 Oct and today will drop out.

\echo '=== STEP 1: candidate tables ==='
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_name ILIKE '%housing%' OR table_name ILIKE '%police%' OR table_name ILIKE '%subscription%'
ORDER BY 1, 2;

\echo '=== STEP 1: housing columns ==='
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name ILIKE '%housing%'
ORDER BY table_name, ordinal_position;

\echo '=== STEP 2: export ==='
\copy ( \
  SELECT \
    h.id                                   AS "ID", \
    h.name                                 AS "Name", \
    u.email                                AS "Manager", \
    h.external_id                          AS "External ID", \
    h.state                                AS "State", \
    h.country                              AS "Country", \
    h.timezone                             AS "Time zone", \
    h.type                                 AS "Type", \
    h.subtype                              AS "Subtype", \
    h.origin                               AS "Origin", \
    pa.type                                AS "Police account type", \
    pa.username                            AS "Police account username", \
    sa.type                                AS "Stat account type", \
    sa.username                            AS "Stat account username", \
    u.should_have_subscription             AS "Manager should have subscription", \
    sub.status                             AS "Manager subscription status", \
    to_char(h.created_at, 'YYYY-MM-DD HH24:MI:SS') AS "created_at", \
    h.spaces_count                         AS "Spaces", \
    h.rooms_quantity                       AS "Rooms quantity", \
    h.is_contracts_enabled::int            AS "Is contracts enabled", \
    h.payments_enabled::int                AS "Payments enabled", \
    h.deposits_enabled::int                AS "Deposits enabled", \
    h.taxes_enabled::int                   AS "Taxes enabled", \
    h.remote_access_enabled::int           AS "Remote access enabled", \
    h.identity_verification_enabled::int   AS "Identity verification enabled", \
    h.upselling_enabled::int               AS "Upselling enabled", \
    NULL                                   AS "Number of deals created", \
    h.paid_by_transfer_count               AS "Paid by transfer", \
    h.police_connection_count              AS "Police connection", \
    h.liveness_enabled::int                AS "Liveness enabled", \
    h.einvoicing_enabled::int              AS "E-invoicing enabled", \
    h.guidebook_enabled::int               AS "Guidebook enabled" \
  FROM housings_housing h \
  JOIN users_user u               ON u.id = h.manager_id \
  LEFT JOIN police_account pa     ON pa.id = h.police_account_id \
  LEFT JOIN stat_account sa       ON sa.id = h.stat_account_id \
  LEFT JOIN subscriptions_subscription sub ON sub.user_id = u.id \
  WHERE h.state = 'ACTIVE' \
    AND h.created_at < '2026-10-01 00:00:00' \
    AND h.origin IS NOT NULL AND h.origin <> '' \
  ORDER BY u.email, h.id \
) TO 'sdk_housings_2026-09-30.csv' WITH (FORMAT csv, HEADER true)

\echo '=== Sanity check — compare with the export currently in the artifact ==='
\echo 'Expected from the 7 Oct export: 34,945 rows; HOLIDU 8,850 / LODGIFY 7,432 / INTERHOME 5,828 / GUESTY_API 3,390 / ENSO 2,446 / AVANTIO_API 1,916'
