-- Construction: stage templates (the process the app already knows), project stages and steps,
-- the building document library (kept apart from invoices and receipts), and who sees which document category.

create type public.stage_phase as enum ('pre', 'build', 'finish');
create type public.stage_status as enum ('todo', 'in_progress', 'done', 'skipped');
create type public.doc_status as enum ('awaiting_file', 'draft', 'approved', 'executive', 'as_built', 'expired');

-- ---------- reference data: document categories and disciplines ----------

create table public.doc_categories (
  code text primary key,
  ord smallint not null unique,
  name text not null
);

create table public.doc_disciplines (
  code text primary key,
  category_code text not null references public.doc_categories (code),
  ord smallint not null,
  name text not null
);

-- Default visibility of each document category per role; a row with user_id overrides for one person.
-- `statuses` limits to some statuses (e.g. foreman: executive drawings only); null means all.
-- `include_financial` = false hides documents flagged as financial (contracts, fee receipts) inside the category.
create table public.document_permissions (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid references public.ledgers (id) on delete cascade, -- null = default for every ledger
  role public.member_role,
  user_id uuid references auth.users (id) on delete cascade,
  category_code text not null references public.doc_categories (code),
  can_view boolean not null default true,
  statuses public.doc_status[],
  include_financial boolean not null default true,
  only_financial boolean not null default false, -- e.g. the accountant sees only the fee receipts of the municipality file
  check (not (only_financial and not include_financial)),
  check ((role is null) <> (user_id is null)),
  check (user_id is null or ledger_id is not null)
);
create unique index document_permissions_role_uq on public.document_permissions (coalesce(ledger_id, '00000000-0000-0000-0000-000000000000'::uuid), role, category_code) where role is not null;
create unique index document_permissions_user_uq on public.document_permissions (ledger_id, user_id, category_code) where user_id is not null;

-- ---------- reference data: stage templates ----------

create table public.stage_templates (
  code text primary key,
  ord smallint not null unique,
  phase public.stage_phase not null,
  name text not null,
  note text not null default '' -- e.g. "varies by city"
);

create table public.stage_template_steps (
  template_code text not null references public.stage_templates (code) on delete cascade,
  ord smallint not null,
  title text not null,
  is_checkpoint boolean not null default false, -- supervisor must approve before work goes on
  primary key (template_code, ord)
);

create table public.stage_template_docs (
  template_code text not null references public.stage_templates (code) on delete cascade,
  ord smallint not null,
  title text not null,
  category_code text not null references public.doc_categories (code),
  discipline_code text references public.doc_disciplines (code),
  is_financial boolean not null default false,
  primary key (template_code, ord)
);

-- ---------- project stages ----------

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  template_code text references public.stage_templates (code),
  ord smallint not null,
  phase public.stage_phase not null,
  name text not null check (length(trim(name)) > 0),
  status public.stage_status not null default 'todo',
  progress_pct smallint not null default 0 check (progress_pct between 0 and 100),
  started_on date,
  finished_on date,
  created_at timestamptz not null default now()
);
create index stages_ledger_idx on public.stages (ledger_id, ord);

-- Budget is money, so it lives apart from stages: foremen and supervisors see stages but not budgets.
create table public.stage_budgets (
  stage_id uuid primary key references public.stages (id) on delete cascade,
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  budget_rial bigint not null check (budget_rial >= 0)
);

create table public.stage_steps (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.stages (id) on delete cascade,
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  ord smallint not null,
  title text not null,
  is_checkpoint boolean not null default false,
  done_at timestamptz,
  done_by uuid references auth.users (id),
  note text not null default ''
);
create index stage_steps_stage_idx on public.stage_steps (stage_id, ord);

-- ---------- document library ----------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  category_code text not null references public.doc_categories (code),
  discipline_code text references public.doc_disciplines (code),
  title text not null check (length(trim(title)) > 0),
  status public.doc_status not null default 'awaiting_file',
  is_financial boolean not null default false,
  stage_id uuid references public.stages (id) on delete set null,
  issued_by_person_id uuid references public.people (id),
  issued_on date,
  valid_until date,
  current_version_id uuid, -- set when a version with a file exists
  draft_id uuid, -- the confirmed draft that created it, if any
  hidden_at timestamptz,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index documents_ledger_idx on public.documents (ledger_id, category_code);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  media_id uuid, -- FK added once the archive table exists
  note text not null default '',
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (document_id, version_no)
);
alter table public.documents
  add constraint documents_current_version_fk foreign key (current_version_id) references public.document_versions (id) deferrable initially deferred;

-- Can the current user see a document of this category / status / financial flag in this ledger?
create function public.doc_visible(p_ledger uuid, p_category text, p_status public.doc_status, p_financial boolean)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role public.member_role := public.member_role_in(p_ledger);
  p record;
begin
  if v_role is null then return false; end if;
  if v_role = 'owner' then return true; end if;
  -- a personal override wins over the role default; a ledger default wins over the global default
  select dp.can_view, dp.statuses, dp.include_financial, dp.only_financial into p
  from public.document_permissions dp
  where dp.category_code = p_category
    and (
      (dp.user_id = auth.uid() and dp.ledger_id = p_ledger)
      or (dp.role = v_role and (dp.ledger_id = p_ledger or dp.ledger_id is null))
    )
  order by (dp.user_id is not null) desc, (dp.ledger_id is not null) desc
  limit 1;
  if not found or not p.can_view then return false; end if;
  if p.statuses is not null and not (p_status = any (p.statuses)) then return false; end if;
  if p_financial and not p.include_financial then return false; end if;
  if not p_financial and p.only_financial then return false; end if;
  return true;
end;
$$;

-- The documents a stage of this project needs: a checklist that points at the document once it is in the library.
create table public.stage_docs (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.stages (id) on delete cascade,
  ledger_id uuid not null references public.ledgers (id) on delete cascade,
  ord smallint not null,
  title text not null,
  category_code text not null references public.doc_categories (code),
  discipline_code text references public.doc_disciplines (code),
  is_financial boolean not null default false,
  document_id uuid references public.documents (id) on delete set null,
  not_needed boolean not null default false -- e.g. no demolition on an empty plot
);
create index stage_docs_stage_idx on public.stage_docs (stage_id, ord);

-- New project: its stages and steps come from the templates.
create function public.instantiate_stages(p_ledger uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  if exists (select 1 from public.stages where ledger_id = p_ledger) then
    return 0; -- already set up; running it again never doubles the stages
  end if;
  insert into public.stages (ledger_id, template_code, ord, phase, name)
  select p_ledger, t.code, t.ord, t.phase, t.name from public.stage_templates t order by t.ord;
  get diagnostics n = row_count;
  insert into public.stage_steps (stage_id, ledger_id, ord, title, is_checkpoint)
  select s.id, p_ledger, ts.ord, ts.title, ts.is_checkpoint
  from public.stages s join public.stage_template_steps ts on ts.template_code = s.template_code
  where s.ledger_id = p_ledger;
  insert into public.stage_docs (stage_id, ledger_id, ord, title, category_code, discipline_code, is_financial)
  select s.id, p_ledger, td.ord, td.title, td.category_code, td.discipline_code, td.is_financial
  from public.stages s join public.stage_template_docs td on td.template_code = s.template_code
  where s.ledger_id = p_ledger;
  return n;
end;
$$;
