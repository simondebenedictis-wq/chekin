#!/usr/bin/env python3
"""
Tourist-tax creation report, by country, straight from production-core.

Usage:
    python3 scripts/tax_report.py --month 2026-07 --countries ES,IT

Connection is read from the standard libpq environment variables (PGHOST,
PGPORT, PGUSER, PGDATABASE, PGPASSWORD) or from --dsn. Everything it runs is
read-only: SELECTs against information_schema and one aggregate query.

Why this script exists: the Claude Code web sandbox can only egress over
HTTPS/443, so port 5432 is unreachable from there (CONNECT to the RDS
endpoint is reset by the egress proxy). Run this from a machine that can
reach the read replica.

Schema is discovered rather than assumed. The script finds candidate tax
tables, picks the date and country columns by name, and prints what it chose
so the numbers can be checked against the query that produced them. Override
any guess with --table / --date-col / --country-col, or use --sql-only to
print the SQL and run it yourself.
"""
import argparse
import calendar
import datetime
import os
import subprocess
import sys

# Column-name candidates, most specific first. The first match in a table's
# column list wins, so keep these ordered by how confident the name makes us.
DATE_CANDIDATES = [
    'created_at', 'created', 'date_created', 'created_on',
    'inserted_at', 'created_date', 'timestamp',
]
COUNTRY_CANDIDATES = [
    'country_code', 'country', 'countrycode', 'iso_country',
    'country_iso', 'tax_country',
]
AMOUNT_CANDIDATES = [
    'amount', 'total_amount', 'total', 'tax_amount', 'gross_amount',
    'value', 'price', 'net_amount',
]

# Tables whose names match %tax% but which are not per-record tax rows.
# Excluded from auto-pick; still listed in the discovery output.
CONFIG_TABLE_HINTS = ('rule', 'config', 'setting', 'type', 'rate', 'band',
                      'template', 'migration', 'schema')


def psql(dsn, sql, timeout=120):
    """Run one SQL statement, return rows as lists of strings."""
    cmd = ['psql', dsn, '-X', '-A', '-t', '-F', '\x1f',
           '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-c', sql]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f'psql failed (exit {proc.returncode})')
    rows = []
    for line in proc.stdout.splitlines():
        if line.strip():
            rows.append(line.split('\x1f'))
    return rows


def find_tax_tables(dsn):
    """Base tables whose name looks tax-related, with live row estimates."""
    sql = """
        SELECT c.table_schema, c.table_name,
               COALESCE(s.n_live_tup, -1) AS est_rows
        FROM information_schema.tables c
        LEFT JOIN pg_stat_user_tables s
               ON s.schemaname = c.table_schema
              AND s.relname    = c.table_name
        WHERE c.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND c.table_name ILIKE '%tax%'
        ORDER BY est_rows DESC, c.table_schema, c.table_name;
    """
    return [(r[0], r[1], int(r[2])) for r in psql(dsn, sql)]


def columns_of(dsn, schema, table):
    sql = f"""
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = '{schema}' AND table_name = '{table}'
        ORDER BY ordinal_position;
    """
    return [(r[0], r[1]) for r in psql(dsn, sql)]


def pick(candidates, present):
    """First candidate that exists in `present` (case-insensitive)."""
    lower = {c.lower(): c for c in present}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    return None


def looks_like_config(table):
    return any(h in table.lower() for h in CONFIG_TABLE_HINTS)


def month_bounds(month):
    """'2026-07' -> (date(2026,7,1), date(2026,8,1)) as a half-open range."""
    try:
        year, mon = (int(p) for p in month.split('-'))
        datetime.date(year, mon, 1)
    except (ValueError, TypeError):
        raise SystemExit(f'--month must look like 2026-07, got {month!r}')
    last = calendar.monthrange(year, mon)[1]
    start = datetime.date(year, mon, 1)
    return start, start + datetime.timedelta(days=last)


def build_sql(schema, table, date_col, country_col, amount_col,
              start, end, countries):
    in_list = ', '.join(f"'{c}'" for c in countries)
    amount_sel = (f',\n               SUM({amount_col}) AS total_amount'
                  if amount_col else '')
    return f"""
        SELECT UPPER({country_col}::text) AS country,
               COUNT(*) AS taxes_created{amount_sel}
        FROM {schema}.{table}
        WHERE {date_col} >= '{start}'
          AND {date_col} <  '{end}'
          AND UPPER({country_col}::text) IN ({in_list})
        GROUP BY 1
        ORDER BY 1;
    """


def render(rows, countries, has_amount, month):
    """Print the report, including explicit zero rows for absent countries."""
    found = {r[0]: r for r in rows}
    width = max([len('COUNTRY')] + [len(c) for c in countries])

    header = f'{"COUNTRY".ljust(width)}  {"CREATED":>12}'
    if has_amount:
        header += f'  {"TOTAL AMOUNT":>16}'
    print(header)
    print('-' * len(header))

    total_count = 0
    total_amount = 0.0
    amount_known = has_amount
    for country in countries:
        row = found.get(country)
        count = int(row[1]) if row else 0
        total_count += count
        line = f'{country.ljust(width)}  {count:>12,}'
        if has_amount:
            raw = row[2] if row and len(row) > 2 else ''
            if raw in ('', None):
                line += f'  {"0.00" if row is None else "n/a":>16}'
                if row is not None:
                    amount_known = False
            else:
                total_amount += float(raw)
                line += f'  {float(raw):>16,.2f}'
        print(line)

    print('-' * len(header))
    total_line = f'{"TOTAL".ljust(width)}  {total_count:>12,}'
    if has_amount:
        total_line += (f'  {total_amount:>16,.2f}' if amount_known
                       else f'  {"n/a":>16}')
    print(total_line)

    extra = sorted(set(found) - set(countries))
    if extra:
        print(f'\nNote: query also returned unrequested countries: '
              f'{", ".join(extra)}')
    print(f'\nMonth: {month}. Rows are counted by creation timestamp, so a '
          'current month is partial.')


def main():
    ap = argparse.ArgumentParser(
        description='Tax records created in a month, broken down by country.')
    ap.add_argument('--month', default='2026-07', help='YYYY-MM (default 2026-07)')
    ap.add_argument('--countries', default='ES,IT',
                    help='comma-separated ISO codes (default ES,IT)')
    ap.add_argument('--dsn', default=None,
                    help='libpq DSN; defaults to PG* environment variables')
    ap.add_argument('--table', default=None,
                    help='schema.table to query, skipping auto-discovery')
    ap.add_argument('--date-col', default=None)
    ap.add_argument('--country-col', default=None)
    ap.add_argument('--amount-col', default=None)
    ap.add_argument('--no-amount', action='store_true',
                    help='count rows only, skip the SUM')
    ap.add_argument('--sql-only', action='store_true',
                    help='print the SQL without running the aggregate')
    args = ap.parse_args()

    dsn = args.dsn or os.environ.get('DATABASE_URL') or ''
    needs_db = not (args.sql_only and args.table and args.date_col
                    and args.country_col)
    if needs_db and not dsn and not os.environ.get('PGHOST'):
        raise SystemExit('No connection info: pass --dsn or set PGHOST/PGUSER/'
                         'PGDATABASE/PGPASSWORD.')

    countries = [c.strip().upper() for c in args.countries.split(',') if c.strip()]
    if not countries:
        raise SystemExit('--countries produced an empty list')
    start, end = month_bounds(args.month)

    if args.table:
        schema, _, table = args.table.rpartition('.')
        schema = schema or 'public'
    else:
        print('Discovering tax tables...')
        candidates = find_tax_tables(dsn)
        if not candidates:
            raise SystemExit('No table name matches %tax%. Pass --table.')
        for sch, tbl, est in candidates:
            flag = '  (looks like config/lookup)' if looks_like_config(tbl) else ''
            shown = f'{est:,}' if est >= 0 else 'unknown'
            print(f'  {sch}.{tbl}  ~{shown} rows{flag}')
        facts = [c for c in candidates if not looks_like_config(c[1])]
        if not facts:
            raise SystemExit('Only config-looking tables matched. Pass --table.')
        schema, table, _ = facts[0]
        print(f'\nUsing {schema}.{table} (largest non-config match). '
              'Override with --table.')

    # With table and both key columns pinned there is nothing left to look
    # up, so --sql-only can emit the query without touching the database.
    fully_pinned = bool(args.table and args.date_col and args.country_col)
    if fully_pinned:
        names = []
        date_col, country_col = args.date_col, args.country_col
        amount_col = None if args.no_amount else args.amount_col
    else:
        cols = columns_of(dsn, schema, table)
        if not cols:
            raise SystemExit(f'{schema}.{table} has no columns — does it exist?')
        names = [c[0] for c in cols]
        date_col = args.date_col or pick(DATE_CANDIDATES, names)
        country_col = args.country_col or pick(COUNTRY_CANDIDATES, names)
        amount_col = (None if args.no_amount
                      else args.amount_col or pick(AMOUNT_CANDIDATES, names))

    if not date_col:
        raise SystemExit(f'No creation-date column found in {schema}.{table}.\n'
                         f'Columns: {", ".join(names)}\nPass --date-col.')
    if not country_col:
        raise SystemExit(
            f'No country column on {schema}.{table} — it is probably reached '
            f'by joining through a housing/property table.\n'
            f'Columns: {", ".join(names)}\n'
            f'Pass --country-col, or use --sql-only as a starting point.')

    print(f'\nColumns: date={date_col}  country={country_col}  '
          f'amount={amount_col or "(none)"}')
    sql = build_sql(schema, table, date_col, country_col, amount_col,
                    start, end, countries)

    if args.sql_only:
        print(sql)
        return

    print(f'Range: {start} <= {date_col} < {end}\n')
    rows = psql(dsn, sql)
    render(rows, countries, amount_col is not None, args.month)


if __name__ == '__main__':
    main()
