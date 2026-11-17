-- Cheques (چک‌ها): issued and received cheques with due dates. A cheque moves no money until it clears;
-- clearing creates the transaction (set_cheque_status), and any later change of status voids it again.

create type public.cheque_direction as enum ('issued', 'received');
create type public.cheque_status as enum ('pending', 'cleared', 'bounced', 'cancelled');

create table public.cheques (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  direction public.cheque_direction not null,
  amount_rial bigint not null check (amount_rial > 0),
  person_id uuid not null references public.people (id),
  due_date date not null,
  account_id uuid references public.accounts (id), -- the account it is drawn on (issued) or paid into (received)
  bank text,
  sayad_no text check (sayad_no is null or sayad_no ~ '^[0-9]{16}$'),
  stage_id uuid references public.stages (id) on delete set null,
  settles boolean not null default false, -- issued for a debt already owed: not a new cost when it clears
  description text not null default '',
  status public.cheque_status not null default 'pending',
  transaction_id uuid references public.transactions (id),
  draft_id uuid references public.drafts (id),
  source_media_id uuid references public.media (id),
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (direction = 'received' or account_id is not null),
  check ((status = 'cleared') = (transaction_id is not null)) -- money moved exactly when cleared
);
create index cheques_ledger_due_idx on public.cheques (ledger_id, due_date) where voided_at is null;
-- unique within a ledger only: the same cheque is «issued» in one book and «received» in another, and no one
-- may learn or block numbers recorded in someone else's books
create unique index cheques_sayad_uq on public.cheques (ledger_id, sayad_no) where sayad_no is not null and voided_at is null;
create index cheques_transaction_idx on public.cheques (transaction_id) where transaction_id is not null;

-- a transaction made by clearing a cheque keeps a permanent link to it (never cleared, not client-writable)
alter table public.transactions add column cheque_id uuid references public.cheques (id);

alter table public.cheques enable row level security;
create policy cheques_select on public.cheques for select to authenticated using (public.can_see_money(ledger_id));
create policy cheques_insert on public.cheques for insert to authenticated
  with check (public.has_role(ledger_id, '{owner,accountant}') and (account_id is null or public.can_use_account(account_id, ledger_id)));
create policy cheques_update on public.cheques for update to authenticated
  using (public.has_role(ledger_id, '{owner,accountant}'))
  with check (public.has_role(ledger_id, '{owner,accountant}') and (account_id is null or public.can_use_account(account_id, ledger_id)));

-- status and the money it moves change only through set_cheque_status; a new cheque always starts pending
revoke insert, update, delete, truncate on public.cheques from authenticated;
grant insert (ledger_id, direction, amount_rial, person_id, due_date, account_id, bank, sayad_no, stage_id, settles, description, source_media_id) on public.cheques to authenticated;
grant update (amount_rial, person_id, due_date, account_id, bank, sayad_no, stage_id, settles, description, voided_at) on public.cheques to authenticated;

create trigger audit after insert or update or delete on public.cheques for each row execute function public.tg_audit();
create trigger refs_in_ledger before insert or update on public.cheques for each row execute function public.tg_refs_in_ledger();
create trigger created_by before insert on public.cheques for each row execute function public.tg_created_by();
create trigger void_guard before update on public.cheques for each row execute function public.tg_void_guard();

-- A cleared cheque's details cannot be edited: change its status back first. Runs as the caller: inside
-- set_cheque_status (security definer) current_user is the function's owner; a client is always «authenticated»,
-- so no setting a client can change switches this off.
create function public.tg_cheque_frozen()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if old.status = 'cleared' and current_user in ('authenticated', 'anon')
     and (new.amount_rial, new.account_id, new.direction, new.person_id, new.voided_at, new.settles, new.stage_id)
         is distinct from (old.amount_rial, old.account_id, old.direction, old.person_id, old.voided_at, old.settles, old.stage_id) then
    raise exception 'a cleared cheque cannot be edited; set it back to pending first' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger cheque_frozen before update on public.cheques for each row execute function public.tg_cheque_frozen();

-- Clear, bounce, cancel or reopen a cheque. Clearing books the money on the account; leaving «cleared» voids it.
create function public.set_cheque_status(p_cheque uuid, p_status public.cheque_status, p_account uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  c public.cheques;
  acc uuid;
  tx uuid;
  who text;
begin
  select * into c from public.cheques where id = p_cheque and voided_at is null for update;
  if not found then raise exception 'cheque not found' using errcode = 'no_data_found'; end if;
  if not public.has_role(c.ledger_id, '{owner,accountant}') then
    raise exception 'only the owner or the accountant changes a cheque' using errcode = 'insufficient_privilege';
  end if;
  if c.status = p_status then return c.transaction_id; end if;
  if c.transaction_id is not null then
    update public.transactions set voided_at = now() where id = c.transaction_id and ledger_id = c.ledger_id;
    tx := null;
  end if;
  if p_status = 'cleared' then
    acc := coalesce(p_account, c.account_id);
    perform public.require(acc is not null, 'choose the account the cheque cleared on');
    perform public.require(public.can_use_account(acc, c.ledger_id), 'this account cannot be used here');
    select full_name into who from public.people where id = c.person_id;
    insert into public.transactions (ledger_id, account_id, occurred_on, amount_rial, is_cost, person_id, stage_id, description, method, cheque_id)
    values (c.ledger_id, acc, public.today_tehran(),
            case when c.direction = 'issued' then -c.amount_rial else c.amount_rial end,
            c.direction = 'issued' and not c.settles, c.person_id,
            case when c.direction = 'issued' and not c.settles then c.stage_id end,
            case when c.direction = 'issued' then 'پاس شدن چک به ' else 'وصول چک از ' end || coalesce(who, ''), 'چک', c.id)
    returning id into tx;
  end if;
  update public.cheques set status = p_status, transaction_id = tx, account_id = coalesce(acc, account_id) where id = c.id;
  return tx;
end;
$$;

revoke execute on function public.set_cheque_status(uuid, public.cheque_status, uuid) from public, anon;
grant execute on function public.set_cheque_status(uuid, public.cheque_status, uuid) to authenticated;

-- The money a cleared cheque moved changes only with the cheque: no client edits or deletes it on its own.
create function public.tg_cheque_transaction_locked()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') and old.cheque_id is not null
     and (new.amount_rial, new.account_id, new.voided_at, new.is_cost, new.person_id, new.stage_id, new.occurred_on, new.description, new.method)
         is distinct from (old.amount_rial, old.account_id, old.voided_at, old.is_cost, old.person_id, old.stage_id, old.occurred_on, old.description, old.method) then
    raise exception 'this transaction belongs to a cheque; change the cheque instead' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger cheque_transaction_locked before update on public.transactions for each row execute function public.tg_cheque_transaction_locked();

-- A new cheque cannot be drawn on an archived account.
create function public.tg_cheque_account_open()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.account_id is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id)
     and exists (select 1 from public.accounts where id = new.account_id and archived_at is not null) then
    raise exception 'this account is archived' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger cheque_account_open before insert or update on public.cheques for each row execute function public.tg_cheque_account_open();
revoke execute on function public.tg_cheque_account_open() from public, anon, authenticated;

-- The accountant, who clears and bounces cheques, reads their history too.
drop policy audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (ledger_id is not null and (
    public.has_role(ledger_id, '{owner}')
    or (public.has_role(ledger_id, '{accountant}') and (
      table_name in ('accounts', 'transactions', 'obligations', 'work_logs', 'inter_ledger_balances', 'stage_budgets', 'project_budgets', 'cheques')
      or (table_name = 'documents' and public.doc_visible(ledger_id,
            coalesce(new_row, old_row) ->> 'category_code',
            (coalesce(new_row, old_row) ->> 'status')::public.doc_status,
            (coalesce(new_row, old_row) ->> 'is_financial')::boolean))
    ))
  ));

-- a client never sets the link itself
revoke insert on public.transactions from authenticated;
grant insert (ledger_id, account_id, occurred_on, amount_rial, is_cost, transfer_id, person_id, stage_id, description, method, tracking_no, source_media_id) on public.transactions to authenticated;
