-- X-52: signed reads for project assets.
--
-- WHY THIS REPLACES A PATH-BASED POLICY
-- The previous policy granted SELECT on `project-assets` objects to anyone who was
-- a member of the workspace named by the object path's FIRST SEGMENT. Two things
-- are wrong with that now:
--
--   * Generated objects live under the PERSONAL billing workspace (Q1 keeps
--     credits per person), so the first segment says nothing about which project
--     owns the object.
--   * It let an ordinary team member read any teammate's project object — exactly
--     what the project RLS forbids (a member may read their own projects; an
--     admin/owner may read all; a member may NOT read someone else's).
--
-- THE AUTHORIZATION SOURCE OF TRUTH IS `public.asset_objects`
-- That table's own RLS already encodes the whole decision: project author, team
-- admin/owner, non-project rows via their creator. Clause (2) below only asks "is
-- there a metadata row for this exact object that the CALLER can see?" — the
-- subquery is evaluated as the caller, so `asset_objects` RLS applies to it.
--
-- WHY THERE ARE TWO MORE CLAUSES
-- A SELECT policy does not only govern reads: PostgreSQL evaluates it for the rows
-- an INSERT ... RETURNING hands back and for the rows UPDATE/DELETE are allowed to
-- match (measured in PGlite — see the notes on each clause). A metadata-only
-- policy therefore breaks the write paths. Both extra clauses mirror rules that
-- ALREADY exist elsewhere; neither re-derives a PROJECT from the path:
--
--   (1) the object's own creator, i.e. the storage API's `insert ... returning *`;
--   (3) the admin branch of the existing UPDATE/DELETE policies, for rows that have
--       no owner — the cleanup path for orphans this X-52 work is about.
--
-- WHAT THIS DOES NOT DO
-- It does not touch `storage.buckets.public`: `project-assets` stays public until
-- the real-environment cutover (工单15) flips it after the read path is verified.
-- Existing INSERT/UPDATE/DELETE policies are untouched.

drop policy if exists "project_assets_select_member" on storage.objects;
drop policy if exists "project_assets_select_metadata_reader" on storage.objects;

create policy "project_assets_select_metadata_reader"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'project-assets'
    and (
      -- (1) THE UPLOADER MAY READ WHAT THEY JUST UPLOADED.
      -- Not a convenience: PostgreSQL validates the RETURNING row of an INSERT
      -- against the SELECT policies, so a policy that cannot see the new row makes
      -- the storage API's own upload fail with 42501 — at the exact moment when the
      -- metadata row cannot exist yet, because it is written after the upload.
      -- Measured: INSERT ... RETURNING = 42501 without this clause, OK with it.
      owner = (select auth.uid())
      or exists (
        -- (2) THE AUTHORIZATION SOURCE OF TRUTH. Evaluated as the caller, so this
        -- is exactly `asset_objects` RLS — project author, team admin/owner,
        -- non-project rows via their creator. Nothing is re-derived from the path.
        select 1
          from public.asset_objects a
         where a.bucket = storage.objects.bucket_id
           and a.object_path = storage.objects.name
      )
      or (
        -- (3) MIRROR OF THE EXISTING UPDATE/DELETE POLICIES for rows with no owner:
        -- `owner is null and is_workspace_admin_or_owner(foldername(name)[1])`.
        -- DELETE and UPDATE need the SELECT policies to see the rows they act on,
        -- so without this the admin cleanup of owner-less objects matches nothing
        -- (measured: affectedRows 0 with the metadata-only policy, 1 with this).
        -- This mirrors what the write policies already allow; it does not decide
        -- which project an object belongs to.
        owner is null
        and (select private.is_workspace_admin_or_owner(
               private.try_parse_uuid((storage.foldername(name))[1])))
      )
    )
  );
