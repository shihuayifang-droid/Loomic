-- ED-05: the object key stays ASCII; the name a person gave the file is kept
-- here so a download can offer it back (Content-Disposition filename*).
alter table public.asset_objects
  add column if not exists display_name text;

alter table public.asset_objects
  add constraint asset_objects_display_name_check
    check (display_name is null or char_length(btrim(display_name)) between 1 and 255);
