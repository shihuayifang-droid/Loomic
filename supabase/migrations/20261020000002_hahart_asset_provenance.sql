-- GN-11: provenance lives on the asset row itself, so it survives the job row
-- being cleaned up (GN-29). source_job_id is deliberately NOT a foreign key here;
-- the hard link is GN-12.
alter table public.asset_objects
  add column if not exists source text,
  add column if not exists operation text,
  add column if not exists model_id text,
  add column if not exists prompt text,
  add column if not exists credits_charged integer,
  add column if not exists action_id text,
  add column if not exists source_job_id uuid,
  add column if not exists parent_artifact_id uuid;

alter table public.asset_objects
  add constraint asset_objects_source_check
    check (source is null
           or source in ('agent', 'generator', 'user_upload', 'sketch', 'agent:sandbox')
           or source ~ '^tool:[a-z0-9_]+$');

alter table public.asset_objects
  add constraint asset_objects_credits_charged_check
    check (credits_charged is null or credits_charged >= 0);

alter table public.asset_objects
  add constraint asset_objects_parent_artifact_fkey
    foreign key (parent_artifact_id) references public.asset_objects (id) on delete set null;

create index if not exists asset_objects_source_job_id_idx on public.asset_objects (source_job_id);
