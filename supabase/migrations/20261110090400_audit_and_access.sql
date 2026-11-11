-- Append-only change history, row-level access for every table, archive file access, and grants.

-- ---------- audit log ----------

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  source text not null default coalesce(nullif(current_setting('app.source', true), ''), 'site'), -- site, bot, draft, system
  draft_id uuid default nullif(current_setting('app.draft_id', true), '')::uuid,
  ledger_id uuid,
  table_name text not null,
  row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_row jsonb,
  new_row jsonb
);
create index audit_log_ledger_idx on public.audit_log (ledger_id, at desc);
create index audit_log_row_idx on public.audit_log (table_name, row_id);

create function public.tg_audit_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'the change history is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger audit_log_append_only before update or delete on public.audit_log
for each row execute function public.tg_audit_append_only();

create function public.tg_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  o jsonb; n jsonb; l uuid; rid text;
begin
  if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and o = n then return null; end if;
  if tg_table_name = 'ledgers' then
    l := coalesce(n ->> 'id', o ->> 'id')::uuid;
  else
    l := coalesce(n ->> 'ledger_id', o ->> 'ledger_id', n ->> 'debtor_ledger_id', o ->> 'debtor_ledger_id')::uuid;
  end if;
  if l is null and coalesce(n ->> 'media_id', o ->> 'media_id') is not null then
    select ledger_id into l from public.media where id = coalesce(n ->> 'media_id', o ->> 'media_id')::uuid;
  end if;
  -- rows with no ledger (workspaces, profiles, linked messenger accounts) are kept with ledger_id null: only the server reads them
  rid := coalesce(n ->> 'id', o ->> 'id', n ->> 'stage_id', o ->> 'stage_id',
                  nullif(concat_ws(':', coalesce(n ->> 'ledger_id', o ->> 'ledger_id'), coalesce(n ->> 'user_id', o ->> 'user_id')), ''),
                  concat_ws(':', coalesce(n ->> 'inbox_item_id', o ->> 'inbox_item_id', n ->> 'target_table', o ->> 'target_table'),
                            coalesce(n ->> 'media_id', o ->> 'media_id'), coalesce(n ->> 'target_id', o ->> 'target_id')));
  insert into public.audit_log (ledger_id, table_name, row_id, action, old_row, new_row)
  values (l, tg_table_name, rid, lower(tg_op), o, n);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'workspaces', 'profiles', 'user_identities',
    'ledgers', 'projects', 'project_budgets', 'memberships', 'accounts', 'people', 'stages', 'stage_budgets', 'stage_steps', 'stage_docs',
    'documents', 'document_versions', 'document_permissions', 'media', 'media_links', 'inbox_items', 'inbox_item_media', 'drafts',
    'transactions', 'obligations', 'work_logs', 'inter_ledger_balances', 'daily_notes'
  ] loop
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
  end loop;
end;
$$;

-- ---------- more access helpers ----------

create function public.shares_ledger_with(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships a join public.memberships b on a.ledger_id = b.ledger_id
    where a.user_id = auth.uid() and b.user_id = p_user
  );
$$;

-- Owner, accountant or foreman in any ledger of the workspace may add or edit contacts.
create function public.can_edit_people(p_workspace uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_workspace_owner(p_workspace) or exists (
    select 1 from public.memberships m join public.ledgers l on l.id = m.ledger_id
    where l.workspace_id = p_workspace and m.user_id = auth.uid() and m.role in ('owner', 'accountant', 'foreman')
  );
$$;

-- Is this archive file visible? Runs as the caller, so the media table's own row rules decide;
-- the path must also start with the file's own ledger.
create function public.can_read_object(p_name text)
returns boolean
language sql stable security invoker set search_path = public
as $$
  select exists (
    select 1 from public.media m
    where (m.storage_path = p_name or m.preview_path = p_name) and split_part(p_name, '/', 1) = m.ledger_id::text
  );
$$;

create function public.ledger_owner_ws(p_ledger uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_workspace_owner((select workspace_id from public.ledgers where id = p_ledger));
$$;

-- The account is in this ledger, or the user owns the account's own ledger (only the owner moves personal money).
create function public.can_use_account(p_account uuid, p_ledger uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.accounts a
    where a.id = p_account and (a.ledger_id = p_ledger or public.has_role(a.ledger_id, '{owner}'))
  );
$$;

create function public.media_in_ledger(p_media uuid, p_ledger uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.media where id = p_media and ledger_id = p_ledger);
$$;

-- Steps: whoever ticks a step is recorded; supervisor checkpoints are closed only by the supervisor or the owner.
create function public.tg_stage_step_done()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.done_at is distinct from old.done_at then
    if old.is_checkpoint and public.member_role_in(old.ledger_id) not in ('owner', 'supervisor') then
      raise exception 'only the supervisor or the owner closes a supervisor checkpoint' using errcode = 'insufficient_privilege';
    end if;
    new.done_by := case when new.done_at is null then null else auth.uid() end;
  end if;
  return new;
end;
$$;
create trigger stage_step_done before update on public.stage_steps
for each row execute function public.tg_stage_step_done();

-- ---------- row level security ----------

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.ledgers enable row level security;
alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.user_identities enable row level security;
alter table public.link_codes enable row level security;
alter table public.accounts enable row level security;
alter table public.people enable row level security;
alter table public.doc_categories enable row level security;
alter table public.doc_disciplines enable row level security;
alter table public.document_permissions enable row level security;
alter table public.stage_templates enable row level security;
alter table public.stage_template_steps enable row level security;
alter table public.stage_template_docs enable row level security;
alter table public.stages enable row level security;
alter table public.stage_budgets enable row level security;
alter table public.project_budgets enable row level security;
alter table public.stage_docs enable row level security;
alter table public.stage_steps enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.media enable row level security;
alter table public.media_links enable row level security;
alter table public.inbox_items enable row level security;
alter table public.inbox_item_media enable row level security;
alter table public.drafts enable row level security;
alter table public.jobs enable row level security;
alter table public.transactions enable row level security;
alter table public.obligations enable row level security;
alter table public.work_logs enable row level security;
alter table public.inter_ledger_balances enable row level security;
alter table public.daily_notes enable row level security;
alter table public.audit_log enable row level security;

create policy workspaces_select on public.workspaces for select to authenticated using (public.in_workspace(id));
create policy workspaces_insert on public.workspaces for insert to authenticated with check (owner_user_id = auth.uid());
create policy workspaces_update on public.workspaces for update to authenticated using (owner_user_id = auth.uid());

create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.shares_ledger_with(id));
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid());

create policy ledgers_select on public.ledgers for select to authenticated using (public.is_member(id));
create policy ledgers_insert on public.ledgers for insert to authenticated with check (public.is_workspace_owner(workspace_id));
create policy ledgers_update on public.ledgers for update to authenticated using (public.has_role(id, '{owner}'));

create policy projects_select on public.projects for select to authenticated using (public.is_member(ledger_id));
create policy projects_write on public.projects for all to authenticated
  using (public.has_role(ledger_id, '{owner}')) with check (public.has_role(ledger_id, '{owner}'));

create policy project_budgets_select on public.project_budgets for select to authenticated using (public.can_see_money(ledger_id));
create policy project_budgets_write on public.project_budgets for all to authenticated
  using (public.has_role(ledger_id, '{owner}')) with check (public.has_role(ledger_id, '{owner}'));

create policy memberships_select on public.memberships for select to authenticated using (public.is_member(ledger_id));
-- Only the workspace owner adds or removes people, and the owner role itself is never granted or taken here.
create policy memberships_write on public.memberships for all to authenticated
  using (public.ledger_owner_ws(ledger_id) and role <> 'owner') with check (public.ledger_owner_ws(ledger_id) and role <> 'owner');

create policy user_identities_select on public.user_identities for select to authenticated using (user_id = auth.uid());
create policy user_identities_delete on public.user_identities for delete to authenticated using (user_id = auth.uid());
-- link_codes: no policies; only the server functions touch it.

create policy accounts_select on public.accounts for select to authenticated using (public.can_see_money(ledger_id));
create policy accounts_write on public.accounts for all to authenticated
  using (public.has_role(ledger_id, '{owner,accountant}')) with check (public.has_role(ledger_id, '{owner,accountant}'));

create policy people_select on public.people for select to authenticated using (public.in_workspace(workspace_id));
create policy people_insert on public.people for insert to authenticated with check (public.can_edit_people(workspace_id));
create policy people_update on public.people for update to authenticated using (public.can_edit_people(workspace_id));

create policy doc_categories_read on public.doc_categories for select to authenticated using (true);
create policy doc_disciplines_read on public.doc_disciplines for select to authenticated using (true);
create policy stage_templates_read on public.stage_templates for select to authenticated using (true);
create policy stage_template_steps_read on public.stage_template_steps for select to authenticated using (true);
create policy stage_template_docs_read on public.stage_template_docs for select to authenticated using (true);

create policy document_permissions_select on public.document_permissions for select to authenticated
  using (ledger_id is null or public.is_member(ledger_id));
create policy document_permissions_write on public.document_permissions for all to authenticated
  using (ledger_id is not null and public.has_role(ledger_id, '{owner}'))
  with check (ledger_id is not null and public.has_role(ledger_id, '{owner}'));

create policy stages_select on public.stages for select to authenticated using (public.is_member(ledger_id));
create policy stages_insert on public.stages for insert to authenticated with check (public.has_role(ledger_id, '{owner}'));
-- progress reported by the foreman reaches a stage only through a card the owner confirms
create policy stages_update on public.stages for update to authenticated using (public.has_role(ledger_id, '{owner}'));

-- the checklist shows titles to the team; financial ones (fee receipts, contracts) only to roles that see money
create policy stage_docs_select on public.stage_docs for select to authenticated
  using (public.is_member(ledger_id) and (not is_financial or public.can_see_money(ledger_id)));
create policy stage_docs_write on public.stage_docs for all to authenticated
  using (public.has_role(ledger_id, '{owner}')) with check (public.has_role(ledger_id, '{owner}'));
create policy stages_delete on public.stages for delete to authenticated using (public.has_role(ledger_id, '{owner}'));

create policy stage_budgets_select on public.stage_budgets for select to authenticated using (public.can_see_money(ledger_id));
create policy stage_budgets_write on public.stage_budgets for all to authenticated
  using (public.has_role(ledger_id, '{owner,accountant}')) with check (public.has_role(ledger_id, '{owner,accountant}'));

create policy stage_steps_select on public.stage_steps for select to authenticated using (public.is_member(ledger_id));
create policy stage_steps_update on public.stage_steps for update to authenticated using (public.has_role(ledger_id, '{owner,foreman,supervisor}'));
create policy stage_steps_insert on public.stage_steps for insert to authenticated with check (public.has_role(ledger_id, '{owner}'));
create policy stage_steps_delete on public.stage_steps for delete to authenticated using (public.has_role(ledger_id, '{owner}'));

create policy documents_select on public.documents for select to authenticated
  using (public.doc_visible(ledger_id, category_code, status, is_financial) and (hidden_at is null or public.has_role(ledger_id, '{owner}')));
create policy documents_insert on public.documents for insert to authenticated with check (public.has_role(ledger_id, '{owner,accountant}'));
create policy documents_update on public.documents for update to authenticated using (public.has_role(ledger_id, '{owner,accountant}'));

create policy document_versions_select on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));
create policy document_versions_insert on public.document_versions for insert to authenticated
  with check (public.has_role(ledger_id, '{owner,accountant}') and (media_id is null or public.media_in_ledger(media_id, ledger_id))
    and exists (select 1 from public.documents d where d.id = document_id and d.ledger_id = document_versions.ledger_id));

-- Archive: owner and accountant see the whole ledger's archive; anyone sees what they sent themselves,
-- and files that back a document they are allowed to see.
create policy media_select on public.media for select to authenticated using (
  public.can_see_money(ledger_id)
  or sender_user_id = auth.uid()
  or exists (
    select 1 from public.document_versions dv join public.documents d on d.id = dv.document_id
    where dv.media_id = media.id and dv.ledger_id = media.ledger_id
  )
);
create policy media_hide on public.media for update to authenticated using (public.has_role(ledger_id, '{owner}'));

create policy media_links_select on public.media_links for select to authenticated
  using (exists (select 1 from public.media m where m.id = media_id));

create policy inbox_items_select on public.inbox_items for select to authenticated
  using (public.can_see_money(ledger_id) or sender_user_id = auth.uid());
create policy inbox_item_media_select on public.inbox_item_media for select to authenticated
  using (exists (select 1 from public.inbox_items i where i.id = inbox_item_id));
create policy drafts_select on public.drafts for select to authenticated
  using (exists (select 1 from public.inbox_items i where i.id = inbox_item_id));
-- drafts are changed only through confirm_inbox / undo_inbox (edits travel as p_edits), never directly.
-- jobs: no policies; server only.

create policy transactions_select on public.transactions for select to authenticated using (public.can_see_money(ledger_id));
create policy transactions_insert on public.transactions for insert to authenticated
  with check (public.has_role(ledger_id, '{owner,accountant}') and public.can_use_account(account_id, ledger_id));
create policy transactions_update on public.transactions for update to authenticated
  using (public.has_role(ledger_id, '{owner,accountant}'))
  with check (public.has_role(ledger_id, '{owner,accountant}') and public.can_use_account(account_id, ledger_id));

create policy obligations_select on public.obligations for select to authenticated using (public.can_see_money(ledger_id));
create policy obligations_insert on public.obligations for insert to authenticated with check (public.has_role(ledger_id, '{owner,accountant}'));
create policy obligations_update on public.obligations for update to authenticated using (public.has_role(ledger_id, '{owner,accountant}'));

create policy work_logs_select on public.work_logs for select to authenticated using (public.has_role(ledger_id, '{owner,accountant,foreman}'));
create policy work_logs_insert on public.work_logs for insert to authenticated with check (public.has_role(ledger_id, '{owner,accountant}'));
create policy work_logs_update on public.work_logs for update to authenticated using (public.has_role(ledger_id, '{owner,accountant}'));

create policy inter_ledger_select on public.inter_ledger_balances for select to authenticated
  using (public.can_see_money(debtor_ledger_id) or public.can_see_money(creditor_ledger_id));

create policy daily_notes_select on public.daily_notes for select to authenticated using (public.is_member(ledger_id));
create policy daily_notes_insert on public.daily_notes for insert to authenticated with check (public.has_role(ledger_id, '{owner,foreman}'));
create policy daily_notes_update on public.daily_notes for update to authenticated using (public.has_role(ledger_id, '{owner,foreman}'));

-- The owner reads the whole history of a ledger; the accountant only the money in it and the documents they may see.
create policy audit_log_select on public.audit_log for select to authenticated
  using (ledger_id is not null and (
    public.has_role(ledger_id, '{owner}')
    or (public.has_role(ledger_id, '{accountant}') and (
      table_name in ('accounts', 'transactions', 'obligations', 'work_logs', 'inter_ledger_balances', 'stage_budgets', 'project_budgets')
      or (table_name = 'documents' and public.doc_visible(ledger_id,
            coalesce(new_row, old_row) ->> 'category_code',
            (coalesce(new_row, old_row) ->> 'status')::public.doc_status,
            (coalesce(new_row, old_row) ->> 'is_financial')::boolean))
    ))
  ));

-- ---------- archive bucket ----------
-- Files live at {ledger_id}/{category|inbox}/{media_id}.{ext}. Reading is allowed exactly when the media row is visible.
-- There is no insert / update / delete policy: only the server writes files, and originals are never replaced.

insert into storage.buckets (id, name, public) values ('archive', 'archive', false) on conflict (id) do nothing;
create policy archive_read on storage.objects for select to authenticated
  using (bucket_id = 'archive' and public.can_read_object(name));

-- ---------- grants ----------

revoke all on all tables in schema public from anon;
revoke truncate on all tables in schema public from authenticated;
revoke all on public.jobs, public.link_codes from authenticated;
-- column-level limits on top of the row rules
revoke update on public.media from authenticated;
grant update (hidden_at, hidden_by) on public.media to authenticated;
revoke update on public.ledgers from authenticated;
grant update (name, archived_at) on public.ledgers to authenticated;
revoke update on public.stage_steps from authenticated;
grant update (done_at, note) on public.stage_steps to authenticated;
revoke update on public.drafts from authenticated;
revoke update, delete on public.audit_log from authenticated;
revoke delete on public.media, public.transactions, public.obligations, public.work_logs, public.daily_notes,
  public.documents, public.document_versions, public.inbox_items, public.drafts from authenticated;
