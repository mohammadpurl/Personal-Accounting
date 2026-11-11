-- Money: transactions, obligations (cost recognised but not yet paid), daily worker logs,
-- money owed between ledgers (personal money spent on a project), daily notes, and balance views.
--
-- Cost model:
--   * transactions.is_cost = true   -> an expense recognised now (cash purchase, wages paid on the day)
--   * transactions.is_cost = false  -> settling a debt, a prepayment, income, or one leg of a transfer
--   * obligations                   -> cost recognised now, paid later (unpaid wages, unpaid invoice, contractor progress)
--   stage cost  = Σ cost transactions + Σ obligations
--   what we owe a person = Σ obligations to them + Σ their non-cost transactions (payments are negative)

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id), -- whose money matter this is
  account_id uuid not null references public.accounts (id), -- where the money moved (may belong to another ledger)
  occurred_on date not null,
  amount_rial bigint not null check (amount_rial <> 0), -- + in, - out
  is_cost boolean not null default false,
  transfer_id uuid,
  person_id uuid references public.people (id),
  stage_id uuid references public.stages (id) on delete set null,
  description text not null default '',
  method text,
  tracking_no text,
  draft_id uuid references public.drafts (id),
  source_media_id uuid references public.media (id),
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (not (is_cost and amount_rial > 0)),
  check (transfer_id is null or not is_cost)
);
create index transactions_ledger_idx on public.transactions (ledger_id, occurred_on desc);
create index transactions_account_idx on public.transactions (account_id);
create index transactions_person_idx on public.transactions (person_id) where person_id is not null;
create index transactions_transfer_idx on public.transactions (transfer_id) where transfer_id is not null;

create table public.obligations (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  person_id uuid not null references public.people (id),
  stage_id uuid references public.stages (id) on delete set null,
  occurred_on date not null,
  amount_rial bigint not null check (amount_rial > 0),
  kind text not null check (kind in ('work', 'invoice', 'contract', 'opening', 'other')),
  description text not null default '',
  draft_id uuid references public.drafts (id),
  source_media_id uuid references public.media (id),
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index obligations_ledger_idx on public.obligations (ledger_id, occurred_on desc);
create index obligations_person_idx on public.obligations (person_id);

create table public.work_logs (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  stage_id uuid references public.stages (id) on delete set null,
  work_date date not null,
  headcount smallint not null check (headcount > 0),
  description text not null default '',
  wage_rial bigint not null check (wage_rial >= 0), -- per person per day
  total_rial bigint generated always as (headcount * wage_rial) stored,
  crew_person_id uuid references public.people (id),
  paid boolean not null default false,
  transaction_id uuid references public.transactions (id),
  obligation_id uuid references public.obligations (id),
  draft_id uuid references public.drafts (id),
  source_media_id uuid references public.media (id),
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index work_logs_ledger_idx on public.work_logs (ledger_id, work_date desc);

create table public.inter_ledger_balances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  debtor_ledger_id uuid not null references public.ledgers (id), -- e.g. the project
  creditor_ledger_id uuid not null references public.ledgers (id), -- e.g. the owner's personal ledger
  amount_rial bigint not null check (amount_rial > 0),
  kind text not null default 'owner_loan' check (kind in ('owner_loan', 'owner_contribution')),
  transaction_id uuid not null unique references public.transactions (id),
  settled_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  check (debtor_ledger_id <> creditor_ledger_id)
);

create table public.daily_notes (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  note_date date not null,
  body text not null check (length(trim(body)) > 0),
  stage_id uuid references public.stages (id) on delete set null,
  draft_id uuid references public.drafts (id),
  source_media_id uuid references public.media (id),
  voided_at timestamptz,
  voided_by uuid references auth.users (id),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- integrity ----------

-- The account must be in the same workspace. When a matter of this ledger moves money in an account of another
-- ledger, the two ledgers owe each other:
--   money out of the other ledger's account (personal money spent on the project, or moved into it) -> this ledger owes it;
--   money into the other ledger's account (project money kept in a personal account)                 -> it owes this ledger.
-- Kept in step on every change (account, amount, ledger, void / restore); what is owed between two ledgers is the net.
create function public.tg_transaction_inter_ledger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  a_ledger uuid; a_ws uuid; t_ws uuid;
begin
  select l.id, l.workspace_id into a_ledger, a_ws from public.accounts a join public.ledgers l on l.id = a.ledger_id where a.id = new.account_id;
  select workspace_id into t_ws from public.ledgers where id = new.ledger_id;
  if a_ws is distinct from t_ws then
    raise exception 'account and ledger are in different workspaces' using errcode = 'check_violation';
  end if;
  if a_ledger <> new.ledger_id and new.voided_at is null then
    insert into public.inter_ledger_balances (workspace_id, debtor_ledger_id, creditor_ledger_id, amount_rial, transaction_id)
    values (t_ws,
            case when new.amount_rial < 0 then new.ledger_id else a_ledger end,
            case when new.amount_rial < 0 then a_ledger else new.ledger_id end,
            abs(new.amount_rial), new.id)
    on conflict (transaction_id) do update
      set workspace_id = excluded.workspace_id, debtor_ledger_id = excluded.debtor_ledger_id,
          creditor_ledger_id = excluded.creditor_ledger_id, amount_rial = excluded.amount_rial, voided_at = null,
          settled_at = case when inter_ledger_balances.amount_rial = excluded.amount_rial
                              and inter_ledger_balances.debtor_ledger_id = excluded.debtor_ledger_id
                              and inter_ledger_balances.creditor_ledger_id = excluded.creditor_ledger_id
                              and inter_ledger_balances.voided_at is null
                            then inter_ledger_balances.settled_at end; -- owed again only if amount or direction changed
  else
    update public.inter_ledger_balances set voided_at = now() where transaction_id = new.id and voided_at is null;
  end if;
  return new;
end;
$$;
create trigger transaction_inter_ledger after insert or update of account_id, ledger_id, amount_rial, voided_at on public.transactions
for each row execute function public.tg_transaction_inter_ledger();

-- Both legs of a transfer exist and sum to zero (checked at commit).
create function public.tg_transfer_balanced()
returns trigger
language plpgsql
as $$
declare
  n integer; s bigint;
begin
  if new.transfer_id is null then return null; end if;
  select count(*), coalesce(sum(amount_rial), 0) into n, s
  from public.transactions where transfer_id = new.transfer_id and voided_at is null;
  if n not in (0, 2) or s <> 0 then
    raise exception 'transfer % must have two legs that sum to zero', new.transfer_id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger transfer_balanced after insert or update on public.transactions
deferrable initially deferred
for each row execute function public.tg_transfer_balanced();

-- ---------- balance views (security_invoker: the reader's row access applies) ----------

-- Runs as its owner so the balance counts every transaction on the account (even ones booked to another ledger),
-- and shows only accounts whose ledger the reader may see money for.
create view public.account_balances as
select a.id as account_id, a.ledger_id, a.name, a.kind,
       a.opening_balance_rial + coalesce(sum(t.amount_rial) filter (where t.voided_at is null), 0) as balance_rial
from public.accounts a
left join public.transactions t on t.account_id = a.id
where public.can_see_money(a.ledger_id)
group by a.id;

create view public.cost_entries with (security_invoker = true) as
select t.ledger_id, t.stage_id, t.occurred_on, -t.amount_rial as amount_rial, 'transaction'::text as source, t.id
from public.transactions t where t.is_cost and t.voided_at is null
union all
select o.ledger_id, o.stage_id, o.occurred_on, o.amount_rial, 'obligation', o.id
from public.obligations o where o.voided_at is null;

create view public.stage_spend with (security_invoker = true) as
select s.id as stage_id, s.ledger_id, coalesce(sum(c.amount_rial), 0)::bigint as spent_rial
from public.stages s left join public.cost_entries c on c.stage_id = s.id
group by s.id;

create view public.person_balances with (security_invoker = true) as
select x.ledger_id, x.person_id, sum(x.amount_rial)::bigint as owed_rial -- > 0 we owe them, < 0 we prepaid
from (
  select o.ledger_id, o.person_id, o.amount_rial from public.obligations o where o.voided_at is null
  union all
  select t.ledger_id, t.person_id, t.amount_rial from public.transactions t
  where t.person_id is not null and not t.is_cost and t.transfer_id is null and t.voided_at is null
) x
group by x.ledger_id, x.person_id;
