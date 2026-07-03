-- 002_add_media_status.sql
-- ----------------------------------------------------------------------------
-- The weekly_posts.media_status column is defined in schema.sql but was missing
-- from the live table (likely an older schema was applied before the column was
-- added to the source-of-truth schema file). mav-bridge writes to it on every
-- FB post via mediaStatusFor(type, media), but PostgREST silently drops unknown
-- columns, so the value vanished — leaving the dashboard with no way to tell a
-- real video post from a video→text fallback.
--
-- This restores the column so mav-bridge's existing write populates it.
-- Idempotent: safe to re-run.

alter table weekly_posts
  add column if not exists media_status text;

comment on column weekly_posts.media_status is
  'Actual media that went out: video | photo | text | video→text | video→photo | photo→text. Written by mav-bridge from facebook-poster per-post results. NULL for GBP.';
