create extension if not exists pgcrypto;

create or replace function public.set_current_timestamp_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.procedure_groups (
  group_id text primary key,
  name text not null,
  codes text[] not null default '{}',
  checked_codes text[] not null default '{}',
  cutoff_percentage numeric(6,2) not null default 50,
  is_locked boolean not null default false,
  locked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.group_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  group_id text not null references public.procedure_groups(group_id) on delete cascade,
  group_name text not null,
  competency_month date not null,
  source_file_name text not null,
  imported_at timestamptz not null,
  cutoff_percentage numeric(6,2) not null default 50,
  checked_codes text[] not null default '{}',
  group_total integer not null default 0,
  codes_payload jsonb not null default '[]'::jsonb,
  dentists_payload jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint group_report_snapshots_unique_month unique (group_id, competency_month)
);

create index if not exists group_report_snapshots_group_month_idx
  on public.group_report_snapshots (group_id, competency_month);

drop trigger if exists set_procedure_groups_updated_at on public.procedure_groups;
create trigger set_procedure_groups_updated_at
before update on public.procedure_groups
for each row execute function public.set_current_timestamp_updated_at();

drop trigger if exists set_group_report_snapshots_updated_at on public.group_report_snapshots;
create trigger set_group_report_snapshots_updated_at
before update on public.group_report_snapshots
for each row execute function public.set_current_timestamp_updated_at();

alter table public.procedure_groups enable row level security;
alter table public.group_report_snapshots enable row level security;

drop policy if exists procedure_groups_select_all on public.procedure_groups;
create policy procedure_groups_select_all
on public.procedure_groups
for select
to anon, authenticated
using (true);

drop policy if exists procedure_groups_insert_all on public.procedure_groups;
create policy procedure_groups_insert_all
on public.procedure_groups
for insert
to anon, authenticated
with check (true);

drop policy if exists procedure_groups_update_all on public.procedure_groups;
create policy procedure_groups_update_all
on public.procedure_groups
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists procedure_groups_delete_all on public.procedure_groups;
create policy procedure_groups_delete_all
on public.procedure_groups
for delete
to anon, authenticated
using (true);

drop policy if exists group_report_snapshots_select_all on public.group_report_snapshots;
create policy group_report_snapshots_select_all
on public.group_report_snapshots
for select
to anon, authenticated
using (true);

drop policy if exists group_report_snapshots_insert_all on public.group_report_snapshots;
create policy group_report_snapshots_insert_all
on public.group_report_snapshots
for insert
to anon, authenticated
with check (true);

drop policy if exists group_report_snapshots_update_all on public.group_report_snapshots;
create policy group_report_snapshots_update_all
on public.group_report_snapshots
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists group_report_snapshots_delete_all on public.group_report_snapshots;
create policy group_report_snapshots_delete_all
on public.group_report_snapshots
for delete
to anon, authenticated
using (true);
