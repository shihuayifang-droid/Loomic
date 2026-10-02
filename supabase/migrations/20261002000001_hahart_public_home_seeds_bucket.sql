-- X-52 prep: give the PUBLIC home-seed assets their own bucket.
--
-- WHY THIS HAS TO HAPPEN BEFORE ANY PRIVACY SWITCH
-- `project-assets` holds two very different things: user project objects, and the
-- home page's example/discovery seed images. Every anonymous visitor loads the
-- seeds (home page, example library, discovery library), so turning that bucket
-- private would 403 all of them at once. Splitting the public half out first is
-- what makes the later cutover possible at all.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * it never updates or deletes `project-assets` — that bucket stays public and
--     remains the only copy of every seed until the real migration is verified;
--   * it deletes nothing;
--   * it grants NO write access. Only a public SELECT policy is created; uploads
--     keep requiring service_role, which bypasses RLS.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'home-seeds',
  'home-seeds',
  true,
  52428800, -- 50 MiB
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- World-readable, exactly like the public seed URLs the home page already serves.
drop policy if exists "home_seeds_select_public" on storage.objects;
create policy "home_seeds_select_public"
  on storage.objects for select
  to public
  using (bucket_id = 'home-seeds');

-- No insert/update/delete policy is created for anon or authenticated, on
-- purpose: seeds are published by the operator, never by a client. RLS denies by
-- default, so the table-level grant in the platform's default privileges does not
-- open a write path.
