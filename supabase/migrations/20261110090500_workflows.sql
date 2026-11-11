-- Workflows: create a workspace / project, confirm an inbox item's drafts into real records, undo, reject,
-- and link a messenger account. All checks happen here so the site, the bots and tests share one path.

-- ---------- workspace and project ----------

create function public.create_workspace(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  ws uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = 'insufficient_privilege'; end if;
  insert into public.workspaces (name, owner_user_id) values (p_name, auth.uid()) returning id into ws;
  insert into public.ledgers (workspace_id, kind, name) values (ws, 'company', 'دفتر شرکت'), (ws, 'personal', 'دفتر شخصی');
  return ws;
end;
$$;

create function public.create_project(p_workspace uuid, p_name text, p_city text default '', p_address text default '')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  l uuid;
begin
  if not public.is_workspace_owner(p_workspace) then
    raise exception 'only the workspace owner can create projects' using errcode = 'insufficient_privilege';
  end if;
  insert into public.ledgers (workspace_id, kind, name) values (p_workspace, 'project', p_name) returning id into l;
  insert into public.projects (ledger_id, city, address) values (l, coalesce(p_city, ''), coalesce(p_address, ''));
  perform public.instantiate_stages(l);
  return l;
end;
$$;

-- ---------- reading draft fields ----------

create function public.f_text(f jsonb, k text) returns text language sql immutable as $$ select nullif(trim(f ->> k), '') $$;
create function public.f_uuid(f jsonb, k text) returns uuid language sql immutable as $$ select nullif(trim(f ->> k), '')::uuid $$;
create function public.f_date(f jsonb, k text) returns date language sql immutable as $$ select nullif(trim(f ->> k), '')::date $$;
create function public.f_bool(f jsonb, k text) returns boolean language sql immutable as $$ select coalesce((f ->> k)::boolean, false) $$;

create function public.f_money(f jsonb, k text)
returns bigint
language plpgsql immutable
as $$
declare
  v bigint := nullif(trim(f ->> k), '')::bigint;
begin
  if v is null or v <= 0 then
    raise exception 'field % must be a positive amount in Rial', k using errcode = 'check_violation';
  end if;
  return v;
end;
$$;

create function public.require(cond boolean, msg text)
returns void
language plpgsql immutable
as $$
begin
  if not coalesce(cond, false) then raise exception '%', msg using errcode = 'check_violation'; end if;
end;
$$;

-- stage and person must belong to this ledger / workspace
create function public.check_refs(p_ledger uuid, p_stage uuid, p_person uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_stage is not null then
    perform public.require(exists (select 1 from public.stages where id = p_stage and ledger_id = p_ledger), 'stage is not in this ledger');
  end if;
  if p_person is not null then
    perform public.require(exists (
      select 1 from public.people p join public.ledgers l on l.workspace_id = p.workspace_id
      where p.id = p_person and l.id = p_ledger), 'person is not in this workspace');
  end if;
end;
$$;

-- ---------- confirm ----------
-- p_accept: the drafts to confirm (the rest are dropped). p_edits: { "<draft id>": { field: value, ... } } merged over the AI's fields.
-- Each accepted draft records what it created in drafts.result so undo can reverse it.

create function public.confirm_inbox(p_inbox uuid, p_accept uuid[], p_edits jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  ib public.inbox_items;
  d public.drafts;
  f jsonb;
  created jsonb;
  prev jsonb;
  new_id uuid;
  tx_id uuid;
  ob_id uuid;
  tr uuid;
  amt bigint;
  m record;
  summary jsonb := '[]'::jsonb;
begin
  select * into ib from public.inbox_items where id = p_inbox for update;
  if not found then raise exception 'inbox item not found' using errcode = 'no_data_found'; end if;
  if not public.has_role(ib.ledger_id, '{owner}') then
    raise exception 'only the owner confirms' using errcode = 'insufficient_privilege';
  end if;
  if ib.status <> 'ready' then raise exception 'item is %, not ready', ib.status using errcode = 'check_violation'; end if;

  perform set_config('app.source', 'draft', true);

  for d in select * from public.drafts where inbox_item_id = p_inbox and status = 'pending' order by ord loop
    perform set_config('app.draft_id', d.id::text, true);
    if not (d.id = any (coalesce(p_accept, '{}'))) then
      update public.drafts set status = 'dropped', resolved_at = now(), resolved_by = auth.uid() where id = d.id;
      continue;
    end if;

    f := d.fields || coalesce(p_edits -> d.id::text, '{}'::jsonb);
    created := '[]'::jsonb;
    prev := null;

    case d.kind
    when 'payment' then
      -- money out; settles = paying a debt already owed (not a new cost)
      amt := public.f_money(f, 'amount_rial');
      perform public.check_refs(ib.ledger_id, public.f_uuid(f, 'stage_id'), public.f_uuid(f, 'person_id'));
      perform public.require(public.f_uuid(f, 'account_id') is not null, 'payment needs an account');
      perform public.require(not public.f_bool(f, 'settles') or public.f_uuid(f, 'person_id') is not null, 'settling a debt needs the person it is owed to');
      insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, is_cost, person_id, stage_id,
                                       description, method, tracking_no, draft_id)
      values (ib.ledger_id, public.f_uuid(f, 'account_id'), coalesce(public.f_date(f, 'occurred_on'), current_date), -amt,
              not public.f_bool(f, 'settles'), public.f_uuid(f, 'person_id'), public.f_uuid(f, 'stage_id'),
              coalesce(public.f_text(f, 'description'), (select 'پرداخت به ' || full_name from public.people where id = public.f_uuid(f, 'person_id')), 'پرداخت'),
              public.f_text(f, 'method'), public.f_text(f, 'tracking_no'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'transactions', 'id', new_id);

    when 'receipt' then
      amt := public.f_money(f, 'amount_rial');
      perform public.check_refs(ib.ledger_id, null, public.f_uuid(f, 'person_id'));
      perform public.require(public.f_uuid(f, 'account_id') is not null, 'receipt needs an account');
      insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, is_cost, person_id, description, method, tracking_no, draft_id)
      values (ib.ledger_id, public.f_uuid(f, 'account_id'), coalesce(public.f_date(f, 'occurred_on'), current_date), amt, false,
              public.f_uuid(f, 'person_id'),
              coalesce(public.f_text(f, 'description'), (select 'دریافت از ' || full_name from public.people where id = public.f_uuid(f, 'person_id')), 'دریافت'),
              public.f_text(f, 'method'), public.f_text(f, 'tracking_no'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'transactions', 'id', new_id);

    when 'transfer' then
      amt := public.f_money(f, 'amount_rial');
      perform public.require(public.f_uuid(f, 'from_account_id') is not null and public.f_uuid(f, 'to_account_id') is not null
                             and public.f_uuid(f, 'from_account_id') <> public.f_uuid(f, 'to_account_id'), 'transfer needs two different accounts');
      tr := gen_random_uuid();
      insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, transfer_id, description, draft_id)
      values (ib.ledger_id, public.f_uuid(f, 'from_account_id'), coalesce(public.f_date(f, 'occurred_on'), current_date), -amt, tr, coalesce(public.f_text(f, 'description'), 'انتقال بین حساب‌ها'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'transactions', 'id', new_id);
      insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, transfer_id, description, draft_id)
      values (ib.ledger_id, public.f_uuid(f, 'to_account_id'), coalesce(public.f_date(f, 'occurred_on'), current_date), amt, tr, coalesce(public.f_text(f, 'description'), 'انتقال بین حساب‌ها'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'transactions', 'id', new_id);

    when 'work_log' then
      perform public.check_refs(ib.ledger_id, public.f_uuid(f, 'stage_id'), public.f_uuid(f, 'crew_person_id'));
      perform public.require((f ->> 'headcount')::int > 0, 'headcount must be positive');
      perform public.require(coalesce((f ->> 'wage_rial')::bigint, -1) >= 0, 'wage must be zero or more');
      amt := (f ->> 'headcount')::bigint * (f ->> 'wage_rial')::bigint;
      tx_id := null; ob_id := null;
      if amt > 0 and public.f_bool(f, 'paid') then
        perform public.require(public.f_uuid(f, 'account_id') is not null, 'paid wages need an account');
        insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, is_cost, person_id, stage_id, description, draft_id)
        values (ib.ledger_id, public.f_uuid(f, 'account_id'), coalesce(public.f_date(f, 'work_date'), current_date), -amt, true,
                public.f_uuid(f, 'crew_person_id'), public.f_uuid(f, 'stage_id'), coalesce(public.f_text(f, 'description'), 'دستمزد کارگران'), d.id)
        returning id into tx_id;
        created := created || jsonb_build_object('table', 'transactions', 'id', tx_id);
      elsif amt > 0 then
        perform public.require(public.f_uuid(f, 'crew_person_id') is not null, 'unpaid wages need the crew or person they are owed to');
        insert into public.obligations (ledger_id, person_id, stage_id, occurred_on, amount_rial, kind, description, draft_id)
        values (ib.ledger_id, public.f_uuid(f, 'crew_person_id'), public.f_uuid(f, 'stage_id'), coalesce(public.f_date(f, 'work_date'), current_date),
                amt, 'work', coalesce(public.f_text(f, 'description'), 'دستمزد کارگران'), d.id)
        returning id into ob_id;
        created := created || jsonb_build_object('table', 'obligations', 'id', ob_id);
      end if;
      insert into public.work_logs (ledger_id, stage_id, work_date, headcount, description, wage_rial, crew_person_id, paid, transaction_id, obligation_id, draft_id)
      values (ib.ledger_id, public.f_uuid(f, 'stage_id'), coalesce(public.f_date(f, 'work_date'), current_date), (f ->> 'headcount')::smallint,
              coalesce(public.f_text(f, 'description'), ''), (f ->> 'wage_rial')::bigint, public.f_uuid(f, 'crew_person_id'),
              tx_id is not null, tx_id, ob_id, d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'work_logs', 'id', new_id);

    when 'stage_progress' then
      perform public.check_refs(ib.ledger_id, public.f_uuid(f, 'stage_id'), null);
      perform public.require(public.f_uuid(f, 'stage_id') is not null, 'which stage?');
      perform public.require(f ->> 'progress_pct' is not null or f ->> 'status' is not null, 'a progress report needs a percent or a status');
      select jsonb_build_object('status', s.status, 'progress_pct', s.progress_pct, 'started_on', s.started_on, 'finished_on', s.finished_on)
        into prev from public.stages s where s.id = public.f_uuid(f, 'stage_id');
      update public.stages set
        progress_pct = coalesce((f ->> 'progress_pct')::smallint, progress_pct),
        status = coalesce((f ->> 'status')::public.stage_status, status),
        started_on = coalesce(started_on, case when coalesce((f ->> 'status'), '') in ('in_progress', 'done') then current_date end),
        finished_on = case when (f ->> 'status') = 'done' then coalesce(finished_on, current_date) else finished_on end
      where id = public.f_uuid(f, 'stage_id');

    when 'daily_note' then
      perform public.check_refs(ib.ledger_id, public.f_uuid(f, 'stage_id'), null);
      insert into public.daily_notes (ledger_id, note_date, body, stage_id, draft_id)
      values (ib.ledger_id, coalesce(public.f_date(f, 'note_date'), current_date), public.f_text(f, 'body'), public.f_uuid(f, 'stage_id'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'daily_notes', 'id', new_id);

    when 'document' then
      perform public.check_refs(ib.ledger_id, public.f_uuid(f, 'stage_id'), public.f_uuid(f, 'issued_by_person_id'));
      perform public.require(public.f_text(f, 'title') is not null, 'document needs a title');
      perform public.require(not exists (
        select 1 from jsonb_array_elements_text(coalesce(f -> 'media_ids', '[]'::jsonb)) x(mid)
        where not exists (select 1 from public.inbox_item_media im where im.inbox_item_id = p_inbox and im.media_id = x.mid::uuid)
      ), 'a document file must come from this item');
      insert into public.documents (ledger_id, category_code, discipline_code, title, status, is_financial, stage_id,
                                    issued_by_person_id, issued_on, valid_until, draft_id)
      values (ib.ledger_id, public.f_text(f, 'category_code'), public.f_text(f, 'discipline_code'), public.f_text(f, 'title'),
              case when jsonb_array_length(coalesce(f -> 'media_ids', '[]'::jsonb)) > 0
                   then coalesce(public.f_text(f, 'status'), 'approved')::public.doc_status else 'awaiting_file' end,
              public.f_bool(f, 'is_financial'), public.f_uuid(f, 'stage_id'), public.f_uuid(f, 'issued_by_person_id'),
              public.f_date(f, 'issued_on'), public.f_date(f, 'valid_until'), d.id)
      returning id into new_id;
      created := created || jsonb_build_object('table', 'documents', 'id', new_id);
      if jsonb_array_length(coalesce(f -> 'media_ids', '[]'::jsonb)) > 0 then
        insert into public.document_versions (document_id, ledger_id, version_no, media_id)
        values (new_id, ib.ledger_id, 1, (f -> 'media_ids' ->> 0)::uuid)
        returning id into tx_id;
        update public.documents set current_version_id = tx_id where id = new_id;
      end if;

    else
      raise exception 'cards of kind % are not supported yet', d.kind using errcode = 'feature_not_supported';
    end case;

    -- link every file of the inbox item to the records this card created
    for m in select media_id from public.inbox_item_media where inbox_item_id = p_inbox loop
      insert into public.media_links (media_id, target_table, target_id)
      select m.media_id, c ->> 'table', (c ->> 'id')::uuid from jsonb_array_elements(created) c
      on conflict do nothing;
    end loop;

    update public.drafts set status = 'accepted', resolved_at = now(), resolved_by = auth.uid(),
      fields = f, result = jsonb_build_object('created', created, 'stage_prev', prev)
    where id = d.id;
    summary := summary || jsonb_build_object('draft_id', d.id, 'kind', d.kind, 'created', created);
  end loop;

  perform set_config('app.draft_id', '', true);
  update public.inbox_items set status = 'confirmed', resolved_at = now(), resolved_by = auth.uid() where id = p_inbox;
  return summary;
end;
$$;

-- ---------- undo (the «برگرداندن» button) ----------
-- Records are voided, never deleted; stage progress goes back to what it was. Allowed for 24 hours.

create function public.undo_inbox(p_inbox uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  ib public.inbox_items;
  d public.drafts;
  c jsonb;
begin
  select * into ib from public.inbox_items where id = p_inbox for update;
  if not found then raise exception 'inbox item not found' using errcode = 'no_data_found'; end if;
  if not public.has_role(ib.ledger_id, '{owner}') then
    raise exception 'only the owner can undo' using errcode = 'insufficient_privilege';
  end if;
  if ib.status = 'rejected' then
    update public.inbox_items set status = 'ready', resolved_at = null, resolved_by = null where id = p_inbox;
    return;
  end if;
  if ib.status <> 'confirmed' then raise exception 'nothing to undo' using errcode = 'check_violation'; end if;
  if ib.resolved_at < now() - interval '24 hours' then
    raise exception 'undo is only possible for 24 hours; edit the records instead' using errcode = 'check_violation';
  end if;

  perform set_config('app.source', 'undo', true);
  -- newest card first: several reports on one stage unwind in order
  for d in select * from public.drafts where inbox_item_id = p_inbox and status = 'accepted' order by ord desc loop
    for c in select * from jsonb_array_elements(coalesce(d.result -> 'created', '[]'::jsonb)) loop
      case c ->> 'table'
        -- only records this very card created in this ledger, whatever drafts.result says
        when 'transactions' then update public.transactions set voided_at = now(), voided_by = auth.uid() where id = (c ->> 'id')::uuid and draft_id = d.id and ledger_id = ib.ledger_id;
        when 'obligations' then update public.obligations set voided_at = now(), voided_by = auth.uid() where id = (c ->> 'id')::uuid and draft_id = d.id and ledger_id = ib.ledger_id;
        when 'work_logs' then update public.work_logs set voided_at = now(), voided_by = auth.uid() where id = (c ->> 'id')::uuid and draft_id = d.id and ledger_id = ib.ledger_id;
        when 'daily_notes' then update public.daily_notes set voided_at = now(), voided_by = auth.uid() where id = (c ->> 'id')::uuid and draft_id = d.id and ledger_id = ib.ledger_id;
        when 'documents' then update public.documents set hidden_at = now() where id = (c ->> 'id')::uuid and draft_id = d.id and ledger_id = ib.ledger_id;
        else null;
      end case;
      -- the files of this item are no longer linked to what was undone
      delete from public.media_links ml
      using public.inbox_item_media im
      where im.inbox_item_id = p_inbox and ml.media_id = im.media_id
        and ml.target_table = c ->> 'table' and ml.target_id = (c ->> 'id')::uuid;
    end loop;
    if d.kind = 'stage_progress' and d.result -> 'stage_prev' is not null then
      -- put the stage back only if nothing changed it since; otherwise a later report would be lost
      perform public.require(exists (
        select 1 from public.stages s where s.id = (d.fields ->> 'stage_id')::uuid and s.ledger_id = ib.ledger_id
          and (d.fields ->> 'progress_pct' is null or s.progress_pct = (d.fields ->> 'progress_pct')::int)
          and (d.fields ->> 'status' is null or s.status::text = d.fields ->> 'status')
      ), 'the stage changed after this item; edit the stage instead of undoing');
      update public.stages set
        status = (d.result -> 'stage_prev' ->> 'status')::public.stage_status,
        progress_pct = (d.result -> 'stage_prev' ->> 'progress_pct')::smallint,
        started_on = (d.result -> 'stage_prev' ->> 'started_on')::date,
        finished_on = (d.result -> 'stage_prev' ->> 'finished_on')::date
      where id = (d.fields ->> 'stage_id')::uuid and ledger_id = ib.ledger_id;
    end if;
  end loop;
  update public.drafts set status = 'pending', resolved_at = null, resolved_by = null, result = null
  where inbox_item_id = p_inbox and status in ('accepted', 'dropped');
  update public.inbox_items set status = 'ready', resolved_at = null, resolved_by = null where id = p_inbox;
end;
$$;

create function public.reject_inbox(p_inbox uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  ib public.inbox_items;
begin
  select * into ib from public.inbox_items where id = p_inbox for update;
  if not found then raise exception 'inbox item not found' using errcode = 'no_data_found'; end if;
  if not public.has_role(ib.ledger_id, '{owner}') then
    raise exception 'only the owner can reject' using errcode = 'insufficient_privilege';
  end if;
  if ib.status not in ('ready', 'failed') then raise exception 'item is %', ib.status using errcode = 'check_violation'; end if;
  update public.inbox_items set status = 'rejected', resolved_at = now(), resolved_by = auth.uid() where id = p_inbox;
  -- the files stay in the archive
end;
$$;

-- ---------- linking a messenger account ----------

create function public.create_link_code()
returns text
language plpgsql security definer set search_path = public
as $$
declare
  c text;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = 'insufficient_privilege'; end if;
  delete from public.link_codes where user_id = auth.uid() or expires_at < now();
  loop
    -- from the cryptographic generator behind gen_random_uuid (its first 32 bits are random), not random()
    c := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.link_codes where code = c);
  end loop;
  insert into public.link_codes (code, user_id, expires_at) values (c, auth.uid(), now() + interval '10 minutes');
  return c;
end;
$$;

-- Called by the bot server only. The bot passes the contact's user id and the sender's id: they must match,
-- so nobody can link someone else's phone number. The phone must be the one on the user's profile.
create function public.link_identity(p_channel public.channel, p_sender_id text, p_contact_user_id text, p_phone text, p_code text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  lc public.link_codes;
  pid uuid;
begin
  if p_sender_id is distinct from p_contact_user_id then
    raise exception 'the shared contact is not the sender''s own number' using errcode = 'insufficient_privilege';
  end if;
  select * into lc from public.link_codes where code = p_code and used_at is null and expires_at > now() for update;
  if not found then raise exception 'the code is wrong or expired' using errcode = 'invalid_authorization_specification'; end if;
  if not exists (select 1 from public.profiles where id = lc.user_id and phone = p_phone) then
    raise exception 'this phone is not the one on the account' using errcode = 'invalid_authorization_specification';
  end if;
  update public.link_codes set used_at = now() where code = p_code;
  insert into public.user_identities (user_id, channel, external_user_id, phone)
  values (lc.user_id, p_channel, p_sender_id, p_phone)
  on conflict (channel, external_user_id) do update set user_id = excluded.user_id, phone = excluded.phone, linked_at = now()
  returning id into pid;
  return pid;
end;
$$;

-- ---------- who may call what ----------

-- Supabase grants every role EXECUTE by default; take it back (now and for functions added later)
-- and grant only what the site may call.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
grant execute on function
  public.create_workspace(text),
  public.create_project(uuid, text, text, text),
  public.confirm_inbox(uuid, uuid[], jsonb),
  public.undo_inbox(uuid),
  public.reject_inbox(uuid),
  public.create_link_code(),
  public.member_role_in(uuid), public.is_member(uuid), public.has_role(uuid, public.member_role[]),
  public.can_see_money(uuid), public.in_workspace(uuid), public.is_workspace_owner(uuid),
  public.doc_visible(uuid, text, public.doc_status, boolean), public.shares_ledger_with(uuid),
  public.can_edit_people(uuid), public.can_read_object(text), public.ledger_owner_ws(uuid),
  public.can_use_account(uuid, uuid), public.media_in_ledger(uuid, uuid)
to authenticated;
-- claim_job, heartbeat_job, finish_job, link_identity, instantiate_stages: server (service role) only.
