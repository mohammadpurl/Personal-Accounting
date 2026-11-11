-- Intake: the archive of every voice / photo / file (kept forever, original never changed),
-- the inbox of items waiting for confirmation, the AI drafts, and the processing queue.

create type public.media_kind as enum ('voice', 'image', 'document', 'video', 'other');
create type public.inbox_status as enum ('queued', 'processing', 'ready', 'confirmed', 'rejected', 'failed');
create type public.job_status as enum ('pending', 'running', 'done', 'failed');
create type public.draft_kind as enum (
  'payment', 'receipt', 'transfer', 'work_log', 'stage_progress', 'daily_note', 'document',
  'invoice', 'reminder', 'admin_step', 'inspection'
);
create type public.draft_status as enum ('pending', 'accepted', 'dropped');

-- ---------- archive ----------

create table public.media (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  kind public.media_kind not null,
  channel public.channel not null,
  sender_user_id uuid references auth.users (id),
  external_chat_id text, -- Bale / Telegram chat
  external_message_id text,
  upload_id text, -- web uploads
  album_id text, -- several photos sent together
  caption text,
  storage_path text not null unique, -- {ledger_id}/{category|inbox}/{id}.{ext}
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  phash text, -- perceptual hash for photos sent again at another quality
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  preview_path text, -- MP3 for voices, small image for photos; made beside the original
  received_at timestamptz not null default now(),
  file_date date, -- date printed on the receipt / document, if read
  transcript text,
  ocr_text text,
  hidden_at timestamptz,
  hidden_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index media_ledger_idx on public.media (ledger_id, received_at desc);
create index media_sha_idx on public.media (sha256);
create index media_album_idx on public.media (album_id) where album_id is not null;
-- the same message or upload is stored once, even if the bot or the site sends it twice
create unique index media_message_uq on public.media (channel, external_chat_id, external_message_id) where external_message_id is not null;
create unique index media_upload_uq on public.media (upload_id) where upload_id is not null;

alter table public.document_versions
  add constraint document_versions_media_fk foreign key (media_id) references public.media (id);

-- The original file is immutable: path, hash, size, type, channel and sender never change, and rows are never deleted.
create function public.tg_media_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'archive files are never deleted; hide them instead' using errcode = 'insufficient_privilege';
  end if;
  if new.storage_path is distinct from old.storage_path
     or new.sha256 is distinct from old.sha256
     or new.size_bytes is distinct from old.size_bytes
     or new.mime is distinct from old.mime
     or new.kind is distinct from old.kind
     or new.channel is distinct from old.channel
     or new.sender_user_id is distinct from old.sender_user_id
     or new.ledger_id is distinct from old.ledger_id
     or new.received_at is distinct from old.received_at
     or new.caption is distinct from old.caption
     or new.external_chat_id is distinct from old.external_chat_id
     or new.external_message_id is distinct from old.external_message_id
     or new.upload_id is distinct from old.upload_id
     or new.album_id is distinct from old.album_id then
    raise exception 'the original file and where it came from cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger media_immutable before update or delete on public.media
for each row execute function public.tg_media_immutable();

-- Which records each file is linked to (transaction, document version, work log, ...).
create table public.media_links (
  media_id uuid not null references public.media (id),
  target_table text not null check (target_table in ('transactions', 'work_logs', 'documents', 'document_versions', 'obligations', 'daily_notes', 'stages')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (media_id, target_table, target_id)
);
create index media_links_target_idx on public.media_links (target_table, target_id);

-- ---------- inbox ----------

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers (id),
  channel public.channel not null,
  sender_user_id uuid references auth.users (id),
  status public.inbox_status not null default 'queued',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),
  error text
);
create index inbox_items_ledger_idx on public.inbox_items (ledger_id, status, received_at desc);

create table public.inbox_item_media (
  inbox_item_id uuid not null references public.inbox_items (id) on delete cascade,
  media_id uuid not null references public.media (id),
  ord smallint not null default 0,
  primary key (inbox_item_id, media_id)
);

-- One card the AI proposed. `fields` holds the proposal, `confidence` per field (0..1),
-- `guess_reason` per field when the value was guessed («مطمئن نیستم»).
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid not null references public.inbox_items (id) on delete cascade,
  ledger_id uuid not null references public.ledgers (id),
  ord smallint not null default 0,
  kind public.draft_kind not null,
  fields jsonb not null default '{}'::jsonb,
  confidence jsonb not null default '{}'::jsonb,
  guess_reason jsonb not null default '{}'::jsonb,
  status public.draft_status not null default 'pending',
  model text, -- AI model and prompt version that produced it, to review mistakes later
  prompt_version text,
  result jsonb, -- what confirming created / changed, used by undo
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index drafts_inbox_idx on public.drafts (inbox_item_id, ord);

-- ---------- processing queue (server only) ----------
-- dedupe_key = '{channel}:{chat_id}:{message_id}' for bots, 'web:{upload_id}' for the site,
-- so the same incoming message is never stored or processed twice.

create table public.jobs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('fetch_file', 'transcode', 'transcribe', 'ocr', 'extract', 'notify')),
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'pending',
  attempts smallint not null default 0,
  max_attempts smallint not null default 8,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (kind, dedupe_key)
);
create index jobs_ready_idx on public.jobs (next_run_at) where status = 'pending';

-- Take the next ready job; concurrent workers never get the same one.
create function public.claim_job(p_kinds text[])
returns public.jobs
language plpgsql security definer set search_path = public
as $$
declare
  j public.jobs;
begin
  select * into j from public.jobs
  where kind = any (p_kinds)
    and ((status = 'pending' and next_run_at <= now())
         or (status = 'running' and locked_at < now() - interval '10 minutes')) -- a worker died mid-job
  order by next_run_at
  for update skip locked
  limit 1;
  if not found then return null; end if;
  update public.jobs set status = 'running', locked_at = now(), attempts = attempts + 1 where id = j.id returning * into j;
  return j;
end;
$$;

-- A worker on a long job (a long voice) says it is still alive, so the job is not taken again after 10 minutes.
create function public.heartbeat_job(p_id bigint)
returns void
language sql security definer set search_path = public
as $$
  update public.jobs set locked_at = now() where id = p_id and status = 'running';
$$;

-- Finish a job; on failure retry with growing delay (30 s, 1 min, 2 min ... up to 1 h), then mark failed.
create function public.finish_job(p_id bigint, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_ok then
    update public.jobs set status = 'done', locked_at = null, last_error = null where id = p_id;
  else
    update public.jobs set
      status = case when attempts >= max_attempts then 'failed'::public.job_status else 'pending'::public.job_status end,
      locked_at = null,
      last_error = p_error,
      next_run_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, greatest(attempts - 1, 0)))
    where id = p_id;
  end if;
end;
$$;
