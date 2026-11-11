-- Core: workspaces, people who use the app, ledgers (project / company / personal), roles, bot identities, accounts, contacts.
-- Money is always Rial in bigint. Business dates are `date` in Asia/Tehran; events are timestamptz.

create type public.ledger_kind as enum ('project', 'company', 'personal');
create type public.member_role as enum ('owner', 'foreman', 'supervisor', 'accountant');
create type public.account_kind as enum ('bank', 'cash', 'other');
create type public.person_kind as enum ('contractor', 'worker', 'crew', 'supplier', 'supervisor', 'designer', 'office', 'partner', 'other');
create type public.channel as enum ('bale', 'telegram', 'web');

-- One workspace per owner (the owner's company and everything in it).
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  owner_user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text unique check (phone is null or phone ~ '^\+98[0-9]{10}$'),
  created_at timestamptz not null default now()
);

create table public.ledgers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  kind public.ledger_kind not null,
  name text not null check (length(trim(name)) > 0),
  archived_at timestamptz,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index ledgers_workspace_idx on public.ledgers (workspace_id);

create table public.projects (
  ledger_id uuid primary key references public.ledgers (id) on delete cascade,
  city text not null default '',
  address text not null default '',
  area_m2 numeric(10, 2) check (area_m2 is null or area_m2 > 0),
  floors smallint check (floors is null or floors > 0),
  units smallint check (units is null or units > 0),
  permit_no text,
  permit_valid_until date,
  started_on date
);

-- The overall budget is money: kept apart from the project row so only the owner and the accountant see it.
create table public.project_budgets (
  ledger_id uuid primary key references public.projects (ledger_id) on delete cascade,
  budget_rial bigint not null check (budget_rial >= 0),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  primary key (ledger_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- A user's account in Bale or Telegram, linked once with request_contact + a one-time code from the site.
create table public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel public.channel not null check (channel <> 'web'),
  external_user_id text not null,
  phone text not null,
  linked_at timestamptz not null default now(),
  unique (channel, external_user_id)
);

create table public.link_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  kind public.account_kind not null,
  name text not null check (length(trim(name)) > 0),
  bank_name text,
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  opening_balance_rial bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index accounts_ledger_idx on public.accounts (ledger_id);

-- Contacts are shared across the workspace: the same supplier serves several projects.
create table public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind public.person_kind not null,
  full_name text not null check (length(trim(full_name)) > 0),
  role_title text not null default '',
  phone text,
  aliases text[] not null default '{}', -- how people say the name in voice notes ("آقای رضایی")
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index people_workspace_idx on public.people (workspace_id);

-- ---------- access helpers (security definer so policies can call them without recursion) ----------

create function public.member_role_in(p_ledger uuid)
returns public.member_role
language sql stable security definer set search_path = public
as $$
  select m.role from public.memberships m where m.ledger_id = p_ledger and m.user_id = auth.uid();
$$;

create function public.is_member(p_ledger uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.memberships m where m.ledger_id = p_ledger and m.user_id = auth.uid());
$$;

create function public.has_role(p_ledger uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.member_role_in(p_ledger) = any (p_roles), false);
$$;

-- Owner and accountant see money; foreman and supervisor do not.
create function public.can_see_money(p_ledger uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_role(p_ledger, array['owner', 'accountant']::public.member_role[]);
$$;

create function public.in_workspace(p_workspace uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships m join public.ledgers l on l.id = m.ledger_id
    where l.workspace_id = p_workspace and m.user_id = auth.uid()
  ) or exists (select 1 from public.workspaces w where w.id = p_workspace and w.owner_user_id = auth.uid());
$$;

create function public.is_workspace_owner(p_workspace uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.workspaces w where w.id = p_workspace and w.owner_user_id = auth.uid());
$$;

-- The workspace owner owns every ledger in it.
create function public.tg_ledger_owner_membership()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.memberships (ledger_id, user_id, role)
  select new.id, w.owner_user_id, 'owner' from public.workspaces w where w.id = new.workspace_id
  on conflict (ledger_id, user_id) do update set role = 'owner';
  return new;
end;
$$;
create trigger ledger_owner_membership after insert on public.ledgers
for each row execute function public.tg_ledger_owner_membership();

-- A projects row only for a project ledger.
create function public.tg_project_is_project_ledger()
returns trigger
language plpgsql
as $$
begin
  if (select kind from public.ledgers where id = new.ledger_id) <> 'project' then
    raise exception 'ledger % is not a project ledger', new.ledger_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger project_is_project_ledger before insert or update on public.projects
for each row execute function public.tg_project_is_project_ledger();
