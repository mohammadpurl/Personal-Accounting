-- Hardening after the second security review: what each role may change, column by column; references that
-- must stay inside one ledger on every write (not only through confirm_inbox); who voided a record; transfers that
-- stay whole; a phone number nobody can claim for someone else.

-- ---------- transfers stay whole ----------
-- Runs as its owner so it counts both legs even when the caller cannot see one of them; on update it checks the
-- group the row left as well as the one it joined. transfer_id itself is not updatable (column grants below).
create or replace function public.tg_transfer_balanced()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  g uuid; n integer; s bigint;
begin
  foreach g in array array_remove(array[new.transfer_id, case when tg_op = 'UPDATE' then old.transfer_id end], null) loop
    select count(*), coalesce(sum(amount_rial), 0) into n, s
    from public.transactions where transfer_id = g and voided_at is null;
    if n not in (0, 2) or s <> 0 then
      raise exception 'transfer % must have two legs that sum to zero', g using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end;
$$;

-- ---------- references stay inside the ledger on every write ----------
create function public.tg_refs_in_ledger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb := to_jsonb(new);
  l uuid := (r ->> 'ledger_id')::uuid;
  pid uuid := coalesce(r ->> 'person_id', r ->> 'crew_person_id', r ->> 'issued_by_person_id')::uuid;
begin
  perform public.check_refs(l, (r ->> 'stage_id')::uuid, pid);
  if r ->> 'source_media_id' is not null and not public.media_in_ledger((r ->> 'source_media_id')::uuid, l) then
    raise exception 'the source file is not in this ledger' using errcode = 'check_violation';
  end if;
  if tg_table_name = 'transactions' and (tg_op = 'INSERT' or (r ->> 'account_id') is distinct from (to_jsonb(old) ->> 'account_id'))
     and exists (select 1 from public.accounts where id = (r ->> 'account_id')::uuid and archived_at is not null) then
    raise exception 'this account is archived' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------- voiding: recorded by the database; only the owner brings a voided record back ----------
create function public.tg_void_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.voided_at is distinct from old.voided_at then
    if old.voided_at is not null and new.voided_at is null and not public.has_role(old.ledger_id, '{owner}') then
      raise exception 'only the owner restores a deleted record' using errcode = 'insufficient_privilege';
    end if;
    if old.voided_at is not null and new.voided_at is not null then
      new.voided_at := old.voided_at; new.voided_by := old.voided_by; -- who deleted it, and when, is never rewritten
    else
      new.voided_by := case when new.voided_at is null then null else auth.uid() end;
      if new.voided_at is not null then new.voided_at := now(); end if; -- the real time, not back-dated
    end if;
  end if;
  return new;
end;
$$;

-- ---------- who created a row is the signed-in user, not what the client says ----------
create function public.tg_created_by()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  return new;
end;
$$;

-- ---------- documents: what decides who may see one is the owner's call ----------
create function public.tg_document_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (new.category_code is distinct from old.category_code or new.is_financial is distinct from old.is_financial)
     and not public.has_role(old.ledger_id, '{owner}') then
    raise exception 'only the owner changes the category or the financial flag of a document' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- ---------- hiding a file is recorded by the database ----------
create function public.tg_media_hidden_by()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.hidden_at is distinct from old.hidden_at then
    new.hidden_by := case when new.hidden_at is null then null else auth.uid() end;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['transactions', 'obligations', 'work_logs', 'daily_notes', 'documents'] loop
    execute format('create trigger refs_in_ledger before insert or update on public.%I for each row execute function public.tg_refs_in_ledger()', t);
    execute format('create trigger created_by before insert on public.%I for each row execute function public.tg_created_by()', t);
  end loop;
  foreach t in array array['transactions', 'obligations', 'work_logs', 'daily_notes'] loop
    execute format('create trigger void_guard before update on public.%I for each row execute function public.tg_void_guard()', t);
  end loop;
end;
$$;
create trigger document_guard before update on public.documents for each row execute function public.tg_document_guard();
create trigger media_hidden_by before update on public.media for each row execute function public.tg_media_hidden_by();

-- ---------- column by column: what can be edited after a record exists ----------
-- ledger, draft, transfer group, creator and voider are never edited by a client.
revoke update on public.accounts, public.transactions, public.obligations, public.work_logs, public.daily_notes, public.documents from authenticated;
grant update (kind, name, bank_name, card_last4, archived_at) on public.accounts to authenticated;
grant update (account_id, occurred_on, amount_rial, is_cost, person_id, stage_id, description, method, tracking_no, voided_at) on public.transactions to authenticated;
grant update (person_id, stage_id, occurred_on, amount_rial, kind, description, voided_at) on public.obligations to authenticated;
grant update (stage_id, work_date, headcount, description, wage_rial, crew_person_id, voided_at) on public.work_logs to authenticated;
grant update (note_date, body, stage_id, voided_at) on public.daily_notes to authenticated;
grant update (category_code, discipline_code, title, status, is_financial, stage_id, issued_by_person_id, issued_on, valid_until, hidden_at) on public.documents to authenticated;

-- ---------- phone numbers come only from the verified sign-in ----------
-- The server copies auth.users.phone (checked by the SMS code) into profiles; a user edits only their name.
drop policy profiles_insert on public.profiles;
revoke insert, update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- ---------- AI drafts carry amounts and accounts: only roles that see money read them ----------
drop policy drafts_select on public.drafts;
create policy drafts_select on public.drafts for select to authenticated using (public.can_see_money(ledger_id));

-- ---------- tables and functions added later start closed ----------
alter default privileges in schema public revoke all on tables from anon;

revoke execute on function public.tg_transfer_balanced(), public.tg_refs_in_ledger(), public.tg_void_guard(),
  public.tg_created_by(), public.tg_document_guard(), public.tg_media_hidden_by() from public, anon, authenticated;

-- ---------- documents: an update reaches only documents the user may see ----------
drop policy documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using (public.has_role(ledger_id, '{owner,accountant}') and public.doc_visible(ledger_id, category_code, status, is_financial))
  with check (public.has_role(ledger_id, '{owner,accountant}') and public.doc_visible(ledger_id, category_code, status, is_financial));

-- ---------- a day's crew fits the column ----------
alter table public.work_logs add constraint work_logs_headcount_max check (headcount <= 500);

-- ---------- the verified phone (auth.users, set by the SMS code) is copied into the profile ----------
create function public.tg_auth_user_phone()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v text;
begin
  v := '+' || ltrim(coalesce(new.phone, ''), '+');
  if v !~ '^\+98[0-9]{10}$' then v := null; end if; -- no phone, or not an Iranian mobile: the profile keeps none
  if v is null then
    update public.profiles set phone = null where id = new.id; -- a cleared phone frees the number
  else
    insert into public.profiles (id, phone) values (new.id, v)
    on conflict (id) do update set phone = excluded.phone;
  end if;
  return new;
end;
$$;
create trigger auth_user_phone after insert or update of phone on auth.users
for each row execute function public.tg_auth_user_phone();
revoke execute on function public.tg_auth_user_phone() from public, anon, authenticated;

-- ---------- history of workspace-wide rows (people) is readable by the workspace owner ----------
alter table public.audit_log add column workspace_id uuid;
create or replace function public.tg_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  o jsonb; n jsonb; l uuid; rid text; w uuid;
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
  w := coalesce(n ->> 'workspace_id', o ->> 'workspace_id')::uuid;
  rid := coalesce(n ->> 'id', o ->> 'id', n ->> 'stage_id', o ->> 'stage_id',
                  nullif(concat_ws(':', coalesce(n ->> 'ledger_id', o ->> 'ledger_id'), coalesce(n ->> 'user_id', o ->> 'user_id')), ''),
                  concat_ws(':', coalesce(n ->> 'inbox_item_id', o ->> 'inbox_item_id', n ->> 'target_table', o ->> 'target_table'),
                            coalesce(n ->> 'media_id', o ->> 'media_id'), coalesce(n ->> 'target_id', o ->> 'target_id')));
  insert into public.audit_log (ledger_id, workspace_id, table_name, row_id, action, old_row, new_row)
  values (l, w, tg_table_name, rid, lower(tg_op), o, n);
  return null;
end;
$$;
create policy audit_log_workspace on public.audit_log for select to authenticated
  using (ledger_id is null and workspace_id is not null and table_name = 'people' and public.is_workspace_owner(workspace_id));

-- who hid a file is written by the database only
revoke update on public.media from authenticated;
grant update (hidden_at) on public.media to authenticated;
