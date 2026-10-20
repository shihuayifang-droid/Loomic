-- GN-12: the hard link from an artifact to the job that produced it.
-- ON DELETE SET NULL: GN-29 cleans old job rows; provenance (model, prompt, cost) lives on the
-- asset row (GN-11) and must survive, only the link goes.
--
-- Guarded on pg_constraint so re-applying this file to a database that already carries the
-- constraint is a no-op instead of a duplicate_object error.
--
-- Backfill: a database that already holds a non-null source_job_id naming a job row that no
-- longer exists would fail this add. There is nothing to null out here: a fresh database is
-- built from the migrations themselves (ADR-0003) and the test database starts empty. On a
-- database carrying old job data, those dangling ids have to be set to null before this runs.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
     where n.nspname = 'public'
       and r.relname = 'asset_objects'
       and c.contype = 'f'
       and c.conname = 'asset_objects_source_job_fkey'
  ) then
    alter table public.asset_objects
      add constraint asset_objects_source_job_fkey
        foreign key (source_job_id) references public.background_jobs (id) on delete set null;
  end if;
end
$$;
