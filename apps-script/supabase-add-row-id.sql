-- ===========================================================================
-- Vista Tracker — add row_id
-- ---------------------------------------------------------------------------
-- Run ONCE in Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- Why it is needed: the sync now includes properties that have no Property ID
-- (delisted and paused villas). Without a key of its own, the script cannot
-- clear those rows before reloading, and they would pile up on every run.
--
-- row_id holds the actual spreadsheet row number, so row_id 22 is row 22 of
-- Acq Master. Safe to run more than once.
-- ===========================================================================

alter table "agreement track"
  add column if not exists "row_id" bigint;

create index if not exists "agreement track_row_id_idx"
  on "agreement track" ("row_id");

-- check: row_id should appear in this list
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agreement track'
order by ordinal_position;
