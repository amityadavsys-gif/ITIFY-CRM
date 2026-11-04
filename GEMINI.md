# ITIFY CRM & Data Integrity Rules

## 1. Strict Data Ingestion & Source Verification
- **NO UNVERIFIED DATA INGESTION**: NEVER search the computer for arbitrary CSVs, Excel files, or databases and assume they belong to the user's active project without explicit confirmation.
- **EXPLICIT USER SOURCES ONLY**: Only ingest, merge, or import data when the user explicitly provides the exact link, file path, or explicitly instructs to fetch it from a specified source.
- **PRE-INGESTION CONFIRMATION**: Always state the exact source and verify the record count with the user before committing or embedding any seed data into production.

## 2. Zero Unapproved Pushes or Assumptions
- Never push data modifications or major architectural changes without the user's explicit consent.
- If data appears missing in a new session or fresh deployment, ASK the user directly for the authoritative data source instead of attempting to guess or search for local files.
