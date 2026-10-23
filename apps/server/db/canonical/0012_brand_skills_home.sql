-- HaHart migration 0012 (ticket 43X, ADR-0001, OP-04).
--
-- Brand kits, the skills registry and the home page content tables. Ported from
-- the final form of the retired `supabase/migrations` chain (brand kits, skills
-- management, skills toggle fix, skill files, home example library, home
-- discovery library, discovery seed prompt, example input mentions).
-- Differences by design:
--   * no row level policies and no role privilege statements: the server is the
--     only client;
--   * user references point at `hahart_auth.users` (created in 0001);
--   * no data is inserted: the system skills and the home page content come from
--     a later seed import, so all nine tables start empty;
--   * `projects.brand_kit_id` gets its foreign key here: 0004 created the plain
--     uuid column because `brand_kits` did not exist yet.
--
-- Create-only migration, runs on an empty database after 0001 .. 0011.
-- `public.set_updated_at` comes from 0003, `public.workspaces` from 0003.

-- ---------------------------------------------------------------------------
-- 1. Brand kits
-- ---------------------------------------------------------------------------
create type public.brand_kit_asset_type as enum ('color', 'font', 'logo', 'image');

create table public.brand_kits (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid not null references hahart_auth.users(id) on delete cascade,
  name          text not null default '未命名',
  is_default    boolean not null default false,
  guidance_text text,
  cover_url     text,
  created_at    timestamptz not null default timezone('utc', now()),
  updated_at    timestamptz not null default timezone('utc', now())
);

create table public.brand_kit_assets (
  id            uuid default gen_random_uuid() primary key,
  kit_id        uuid not null references public.brand_kits(id) on delete cascade,
  asset_type    public.brand_kit_asset_type not null,
  display_name  text not null default '',
  role          text,
  sort_order    int not null default 0,
  text_content  text,
  file_url      text,
  metadata      jsonb default '{}',
  created_at    timestamptz not null default timezone('utc', now()),
  updated_at    timestamptz not null default timezone('utc', now())
);

-- The foreign key 0004 could not add yet (same name and action as the old schema).
alter table public.projects
  add constraint projects_brand_kit_id_fkey
  foreign key (brand_kit_id) references public.brand_kits(id) on delete set null;

create trigger brand_kits_updated_at
  before update on public.brand_kits
  for each row execute function public.set_updated_at();

create trigger brand_kit_assets_updated_at
  before update on public.brand_kit_assets
  for each row execute function public.set_updated_at();

create index idx_brand_kits_user on public.brand_kits(user_id);
create index idx_brand_kit_assets_kit on public.brand_kit_assets(kit_id);
create index idx_brand_kit_assets_type on public.brand_kit_assets(kit_id, asset_type);

-- At most one default kit per user.
create unique index idx_brand_kits_default
  on public.brand_kits(user_id) where is_default = true;

-- ---------------------------------------------------------------------------
-- 2. Skills registry
-- ---------------------------------------------------------------------------
create table public.skills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null default '',
  author text not null default 'system',
  version text not null default '1.0',
  license text,
  category text not null default 'custom'
    check (category in ('design', 'generation', 'code', 'data', 'writing', 'custom')),
  icon_name text,
  source text not null default 'system'
    check (source in ('system', 'community', 'user')),
  skill_content text not null,
  metadata jsonb default '{}'::jsonb,
  is_featured boolean not null default false,
  created_by uuid references hahart_auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_url text,
  package_name text
);

comment on column public.skills.source_url is 'Original URL the skill was imported from';
comment on column public.skills.package_name is 'npm-style package name from the skills.sh registry';

create index skills_category_idx on public.skills (category);
create index skills_source_idx on public.skills (source);
create index skills_created_by_idx on public.skills (created_by);

create table public.workspace_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete cascade,
  enabled boolean not null default true,
  config jsonb default '{}'::jsonb,
  installed_at timestamptz not null default now(),
  installed_by uuid references hahart_auth.users(id) on delete set null,

  unique (workspace_id, skill_id)
);

create index workspace_skills_workspace_idx on public.workspace_skills (workspace_id);

create table public.skill_files (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.skills(id) on delete cascade,
  file_path text not null,
  content text not null,
  mime_type text not null default 'text/plain',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Each skill can only have one file at a given path.
  unique (skill_id, file_path),

  -- Only allow files under known directories.
  check (file_path ~ '^(scripts|references|assets)/')
);

comment on table public.skill_files is 'Stores multi-file skill content (scripts, references, assets)';

create index skill_files_skill_id_idx on public.skill_files (skill_id);

create function public.update_skills_updated_at()
returns trigger as $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language plpgsql;

create trigger skills_updated_at
  before update on public.skills
  for each row execute function public.update_skills_updated_at();

create trigger skill_files_updated_at
  before update on public.skill_files
  for each row execute function public.update_skills_updated_at();

-- Every new workspace gets all system skills installed and enabled.
create function public.init_workspace_skills()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
BEGIN
  INSERT INTO public.workspace_skills (workspace_id, skill_id, enabled)
  SELECT NEW.id, s.id, true
  FROM public.skills s
  WHERE s.source = 'system'
  ON CONFLICT (workspace_id, skill_id) DO NOTHING;
  RETURN NEW;
END;
$$;

create trigger trg_init_workspace_skills
  after insert on public.workspaces
  for each row
  execute function public.init_workspace_skills();

-- ---------------------------------------------------------------------------
-- 3. Home page example library
-- ---------------------------------------------------------------------------
create table public.home_example_categories (
  key text primary key,
  label text not null,
  data_type text not null,
  accent text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint home_example_categories_accent_check
    check (accent is null or accent in ('special'))
);

create table public.home_example_examples (
  id uuid primary key default gen_random_uuid(),
  category_key text not null references public.home_example_categories(key) on delete cascade,
  title text not null,
  prompt text not null,
  image_urls text[] not null default '{}'::text[],
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  input_mentions jsonb not null default '[]'::jsonb
);

comment on column public.home_example_examples.input_mentions is
  'JSON array of {type, name, imgSrc} objects representing @mention capsules in the prompt input';

create unique index home_example_categories_sort_order_key
  on public.home_example_categories(sort_order);

create unique index home_example_examples_category_sort_order_key
  on public.home_example_examples(category_key, sort_order);

create index home_example_examples_active_category_idx
  on public.home_example_examples(category_key, is_active, sort_order);

create trigger home_example_categories_updated_at
  before update on public.home_example_categories
  for each row execute function public.set_updated_at();

create trigger home_example_examples_updated_at
  before update on public.home_example_examples
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Home page discovery library
-- ---------------------------------------------------------------------------
create table public.home_discovery_categories (
  key text primary key,
  label text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.home_discovery_cases (
  id text primary key,
  category_key text not null references public.home_discovery_categories(key) on delete cascade,
  title text not null,
  cover_image_url text not null,
  author_name text not null,
  author_avatar_url text not null,
  view_count integer not null default 0 check (view_count >= 0),
  like_count integer not null default 0 check (like_count >= 0),
  case_url text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  seed_prompt text not null default ''
);

create unique index home_discovery_categories_sort_order_key
  on public.home_discovery_categories(sort_order);

create unique index home_discovery_cases_category_sort_order_key
  on public.home_discovery_cases(category_key, sort_order);

create index home_discovery_cases_active_category_idx
  on public.home_discovery_cases(category_key, is_active, sort_order);

create trigger home_discovery_categories_updated_at
  before update on public.home_discovery_categories
  for each row execute function public.set_updated_at();

create trigger home_discovery_cases_updated_at
  before update on public.home_discovery_cases
  for each row execute function public.set_updated_at();
