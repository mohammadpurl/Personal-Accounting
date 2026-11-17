-- The pipeline from a message to draft cards: a bot (Bale on the Iranian server, Telegram through the relay abroad)
-- or the site hands in a message; it is archived and queued; the relay abroad takes the job, transcribes / reads it,
-- asks the AI, and hands back draft cards; the sender is told what was understood. All of these functions are for
-- the server (service role) only: clients never call them.
--
-- Every job taken carries a lease (jobs.lease, new at each claim). A result is accepted only with the lease of the
-- claim that is still running — so a late answer from a claim that timed out, or a retry after the answer was in
-- fact saved, can never record the cards twice or reopen an item the owner already confirmed.

-- ---------- what an inbox item carries ----------
alter table public.inbox_items
  add column source_key text unique,              -- 'bale:{chat}:{message}', 'telegram:…': the same message is taken once
  add column chat_id text,                        -- where to reply (Bale / Telegram chat)
  add column text text check (text is null or length(text) <= 8000), -- a typed message (no file)
  add column chips text[] not null default '{}',  -- short labels per card, shown in the list
  add column highlights text[] not null default '{}'; -- phrases the cards came from (shown marked in the transcript)

-- which ledger a messenger account sends to by default (set when linking, changeable later)
alter table public.user_identities add column default_ledger_id uuid references public.ledgers (id);

-- replies go back through the channel they came from: Bale replies are sent from Iran, Telegram ones by the relay
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('fetch_file', 'transcode', 'transcribe', 'ocr', 'extract', 'notify_bale', 'notify_telegram'));

-- ---------- receiving ----------
create function public.is_linked(p_channel public.channel, p_external_user text)
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_identities where channel = p_channel and external_user_id = p_external_user); $$;

-- The project a linked messenger account sends to: its chosen default, or its first open project.
create function public.sender_ledger(p_channel public.channel, p_external_user text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare ident public.user_identities; led uuid;
begin
  select * into ident from public.user_identities where channel = p_channel and external_user_id = p_external_user;
  if not found then raise exception 'this messenger account is not linked' using errcode = 'insufficient_privilege'; end if;
  led := ident.default_ledger_id;
  if led is null or not exists (
    select 1 from public.memberships ms join public.ledgers l on l.id = ms.ledger_id
    where ms.ledger_id = led and ms.user_id = ident.user_id and l.archived_at is null) then
    select ms.ledger_id into led from public.memberships ms join public.ledgers l on l.id = ms.ledger_id
    where ms.user_id = ident.user_id and l.kind = 'project' and l.archived_at is null order by l.created_at limit 1;
  end if;
  if led is null then raise exception 'no project to send to' using errcode = 'check_violation'; end if;
  return led;
end;
$$;

-- Already taken? (asked before the files are uploaded, so a repeated message leaves no orphan files)
create function public.inbox_by_source(p_channel public.channel, p_chat text, p_message text)
returns uuid
language sql stable security definer set search_path = public
as $$ select id from public.inbox_items where source_key = p_channel::text || ':' || p_chat || ':' || p_message; $$;

-- p_files: [{ "storage_path", "mime", "size_bytes", "sha256", "kind", "duration_ms"?, "caption"? }] — the bytes are
-- already in storage under {ledger}/inbox/. Returns the inbox item; the same message twice returns the first one.
create function public.ingest_message(
  p_channel public.channel, p_external_user text, p_chat text, p_message text,
  p_text text default null, p_files jsonb default '[]'::jsonb, p_album text default null, p_sent_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  ident public.user_identities;
  led uuid;
  key text;
  ib uuid;
  f jsonb;
  m uuid;
  has_voice boolean := false;
  readable boolean := nullif(trim(p_text), '') is not null; -- anything the AI can read: text, a caption, voice, photo, document
begin
  -- chat and message ids are numbers in Bale and Telegram; anything else could collide inside the key
  perform public.require(p_chat ~ '^-?\d{1,20}$' and p_message ~ '^\d{1,20}$', 'bad chat or message id');
  perform public.require(p_album is null or p_album ~ '^[\w-]{1,64}$', 'bad album id');
  perform public.require(jsonb_typeof(p_files) = 'array' and jsonb_array_length(p_files) <= 10, 'at most 10 files in one message');
  perform public.require(p_text is null or length(p_text) <= 8000, 'the text is too long');
  key := p_channel::text || ':' || p_chat || ':' || p_message;
  select id into ib from public.inbox_items where source_key = key;
  if found then return ib; end if;

  select * into ident from public.user_identities where channel = p_channel and external_user_id = p_external_user;
  led := public.sender_ledger(p_channel, p_external_user);
  perform public.require(nullif(trim(p_text), '') is not null or jsonb_array_length(p_files) > 0, 'an empty message');

  -- the moment it was sent (from the messenger), so a message that reached the site late keeps its own day;
  -- a time from far away is not believed
  insert into public.inbox_items (ledger_id, channel, sender_user_id, status, source_key, chat_id, text, received_at)
  values (led, p_channel, ident.user_id, 'queued', key, p_chat, nullif(trim(p_text), ''),
          case when p_sent_at between now() - interval '3 days' and now() + interval '1 minute' then p_sent_at else now() end)
  returning id into ib;

  for f in select * from jsonb_array_elements(p_files) loop
    perform public.require(split_part(f ->> 'storage_path', '/', 1) = led::text, 'a file must be stored under its own ledger');
    insert into public.media (ledger_id, kind, channel, sender_user_id, external_chat_id, external_message_id, album_id, caption,
                              storage_path, mime, size_bytes, sha256, duration_ms)
    values (led, (f ->> 'kind')::public.media_kind, p_channel, ident.user_id, p_chat,
            case when jsonb_array_length(p_files) = 1 then p_message else p_message || '#' || (f ->> 'storage_path') end,
            p_album, left(f ->> 'caption', 1000), f ->> 'storage_path', f ->> 'mime', (f ->> 'size_bytes')::bigint, f ->> 'sha256', (f ->> 'duration_ms')::int)
    returning id into m;
    insert into public.inbox_item_media (inbox_item_id, media_id) values (ib, m);
    has_voice := has_voice or (f ->> 'kind') = 'voice';
    readable := readable or (f ->> 'kind') in ('voice', 'image', 'document') or nullif(trim(f ->> 'caption'), '') is not null;
  end loop;

  -- nothing to read (a video with no words written, an unknown file): archived as it is, with no cards and no failure
  if not readable then
    update public.inbox_items set status = 'ready', processed_at = now() where id = ib;
    return ib;
  end if;
  -- a voice is transcribed first; text and photos go straight to reading
  insert into public.jobs (kind, dedupe_key, payload)
  values (case when has_voice then 'transcribe' else 'extract' end, 'inbox:' || ib, jsonb_build_object('inbox_item_id', ib));
  return ib;
end;
$$;

-- ---------- what the relay needs for a job ----------
-- Personal accounts are sent only when the sender owns that personal ledger (a foreman's voice never carries them).
create function public.job_context(p_job bigint)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'kind', j.kind, 'attempts', j.attempts, 'status', j.status, 'lease', j.lease),
    'inbox', jsonb_build_object('id', ib.id, 'ledger_id', ib.ledger_id, 'channel', ib.channel, 'text', ib.text),
    -- the day the message was sent, not the day it is read: a late bot or relay never shifts a date
    'today', (ib.received_at at time zone 'Asia/Tehran')::date,
    'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'mime', m.mime, 'storage_path', m.storage_path, 'transcript', m.transcript, 'caption', m.caption) order by im.ord)
                       from public.inbox_item_media im join public.media m on m.id = im.media_id where im.inbox_item_id = ib.id), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role_title, 'aliases', p.aliases))
                        from public.people p join public.ledgers l on l.workspace_id = p.workspace_id where l.id = ib.ledger_id and p.archived_at is null), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'ledgerKind', l2.kind))
                          from public.accounts a join public.ledgers l2 on l2.id = a.ledger_id
                          where a.archived_at is null and (a.ledger_id = ib.ledger_id
                            or (l2.workspace_id = (select workspace_id from public.ledgers where id = ib.ledger_id) and l2.kind = 'personal'
                                and exists (select 1 from public.memberships ms where ms.ledger_id = l2.id and ms.user_id = ib.sender_user_id and ms.role = 'owner')))), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'inProgress', s.status = 'in_progress') order by s.ord)
                        from public.stages s where s.ledger_id = ib.ledger_id), '[]'::jsonb)
  )
  from public.jobs j join public.inbox_items ib on ib.id = (j.payload ->> 'inbox_item_id')::uuid
  where j.id = p_job and j.kind in ('transcribe', 'extract');
$$;

-- The running claim of a job, by its lease; anything else is refused.
create function public.leased_job(p_job bigint, p_lease uuid, p_kind text)
returns public.jobs
language plpgsql security definer set search_path = public
as $$
declare j public.jobs;
begin
  select * into j from public.jobs where id = p_job and kind = p_kind and status = 'running' and lease = p_lease for update;
  if not found then raise exception 'this claim is no longer running' using errcode = 'no_data_found'; end if;
  return j;
end;
$$;

-- A long job says it is still alive, so it is not handed to a second worker after 10 minutes.
create function public.job_heartbeat(p_job bigint, p_lease uuid)
returns void
language sql security definer set search_path = public
as $$ update public.jobs set locked_at = now() where id = p_job and status = 'running' and lease = p_lease; $$;

-- ---------- results ----------
-- Transcripts arrive (one per voice of the item, p_items: [{ "media", "text" }]): kept on each voice file, and the
-- item moves on to reading.
create function public.save_transcript(p_job bigint, p_lease uuid, p_items jsonb, p_model text)
returns void
language plpgsql security definer set search_path = public
as $$
declare j public.jobs; ib uuid; it jsonb; st public.inbox_status;
begin
  j := public.leased_job(p_job, p_lease, 'transcribe');
  ib := (j.payload ->> 'inbox_item_id')::uuid;
  select status into st from public.inbox_items where id = ib for update;
  if st not in ('queued', 'processing') then perform public.finish_job(p_job, true); return; end if; -- already moved on
  perform public.require(jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) between 1 and 10, 'no transcript');
  for it in select * from jsonb_array_elements(p_items) loop
    perform public.require(exists (select 1 from public.inbox_item_media where inbox_item_id = ib and media_id = (it ->> 'media')::uuid), 'this file is not part of the item');
    update public.media set transcript = left(it ->> 'text', 20000) where id = (it ->> 'media')::uuid;
  end loop;
  update public.inbox_items set status = 'processing' where id = ib;
  perform public.finish_job(p_job, true);
  insert into public.jobs (kind, dedupe_key, payload) values ('extract', 'inbox:' || ib, jsonb_build_object('inbox_item_id', ib, 'stt_model', left(p_model, 100)))
  on conflict (kind, dedupe_key) do nothing;
end;
$$;

-- The AI's cards arrive: they become drafts, the item waits for the owner, and the sender is told.
-- p_cards: [{ "kind", "fields", "guess" }] already checked by the relay (lib/ai/extract.toDrafts).
create function public.save_extraction(p_job bigint, p_lease uuid, p_cards jsonb, p_chips text[], p_highlights text[], p_ocr text, p_model text, p_prompt_version text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  j public.jobs;
  ib public.inbox_items;
  c jsonb;
  n int := 0;
  labels text[];
  summary text;
  project text;
begin
  j := public.leased_job(p_job, p_lease, 'extract');
  select * into ib from public.inbox_items where id = (j.payload ->> 'inbox_item_id')::uuid for update;
  -- only an item still being processed takes cards: never one that is ready, confirmed or rejected
  if ib.status not in ('queued', 'processing') then perform public.finish_job(p_job, true); return; end if;
  perform public.require(jsonb_typeof(p_cards) = 'array' and jsonb_array_length(p_cards) <= 20, 'cards must be a list of at most 20');

  delete from public.drafts where inbox_item_id = ib.id and status = 'pending'; -- a retried reading replaces, never adds
  for c in select * from jsonb_array_elements(p_cards) loop
    perform public.require((c ->> 'kind') in ('payment', 'receipt', 'transfer', 'work_log', 'stage_progress', 'daily_note', 'document', 'cheque'), 'unknown card kind');
    perform public.require(jsonb_typeof(coalesce(c -> 'fields', '{}')) = 'object' and jsonb_typeof(coalesce(c -> 'guess', '{}')) = 'object', 'fields must be an object');
    insert into public.drafts (inbox_item_id, ledger_id, ord, kind, fields, guess_reason, model, prompt_version)
    values (ib.id, ib.ledger_id, n, (c ->> 'kind')::public.draft_kind, coalesce(c -> 'fields', '{}'), coalesce(c -> 'guess', '{}'), left(p_model, 100), left(p_prompt_version, 50));
    n := n + 1;
  end loop;
  select coalesce(array_agg(left(x, 60)), '{}') into labels from (select unnest(coalesce(p_chips, '{}')) x limit 20) s;
  if p_ocr is not null then
    update public.media set ocr_text = left(p_ocr, 20000)
    where id in (select media_id from public.inbox_item_media where inbox_item_id = ib.id) and kind in ('image', 'document') and ocr_text is null;
  end if;
  update public.inbox_items set status = 'ready', processed_at = now(), chips = labels,
    highlights = (select coalesce(array_agg(left(x, 200)), '{}') from (select unnest(coalesce(p_highlights, '{}')) x limit 40) s), error = null
  where id = ib.id;
  perform public.finish_job(p_job, true);

  -- tell the sender, in the channel it came from
  -- someone in more than one project is told which one the message went to
  select l.name into project from public.ledgers l where l.id = ib.ledger_id
    and (select count(*) from public.memberships ms join public.ledgers l2 on l2.id = ms.ledger_id
         where ms.user_id = ib.sender_user_id and l2.kind = 'project' and l2.archived_at is null) > 1;
  summary := case
    when n = 0 then 'چیزی برای ثبت پیدا نکردم؛ پیامتان بایگانی شد. اگر باید ثبت می‌شد، دوباره بفرستید و مبلغ، طرف حساب و تاریخ را هم بگویید.'
    when cardinality(labels) = 0 then 'فهمیدم: ' || translate(n::text, '0123456789', '۰۱۲۳۴۵۶۷۸۹') || ' مورد.'
    when cardinality(labels) = 1 then 'فهمیدم: ' || labels[1]
    else E'فهمیدم:\n• ' || array_to_string(labels, E'\n• ') end
    || case when n = 0 then ''
            when n = 1 then E'\nاین مورد به «منتظر تأیید» سایت رفت و بعد از تأیید صاحب‌کار ثبت می‌شود.'
            else E'\nاین‌ها به «منتظر تأیید» سایت رفتند و بعد از تأیید صاحب‌کار ثبت می‌شوند.' end;
  if project is not null then summary := 'پروژهٔ «' || project || E'»\n' || summary; end if;
  if ib.channel in ('bale', 'telegram') and ib.chat_id is not null then
    insert into public.jobs (kind, dedupe_key, payload)
    values ('notify_' || ib.channel::text, 'understood:' || ib.id,
            jsonb_build_object('chat_id', ib.chat_id, 'reply_to', split_part(ib.source_key, ':', 3), 'text', left(summary, 4000)))
    on conflict (kind, dedupe_key) do nothing;
  end if;
end;
$$;

-- A failed attempt of the running claim: retried later (unless p_permanent: retrying cannot help, e.g. a file the AI
-- cannot read); when it fails for good the item shows as failed, with the reason, and the sender is told — nothing is
-- lost silently.
create function public.item_gave_up(p_job bigint, p_error text)
returns void
language plpgsql security definer set search_path = public
as $$
declare j public.jobs; item public.inbox_items;
begin
  select * into j from public.jobs where id = p_job and kind in ('transcribe', 'extract');
  if not found then return; end if;
  update public.inbox_items set status = 'failed', error = left(p_error, 500)
  where id = (j.payload ->> 'inbox_item_id')::uuid and status in ('queued', 'processing') returning * into item;
  if item.id is not null and item.channel in ('bale', 'telegram') and item.chat_id is not null then
    insert into public.jobs (kind, dedupe_key, payload)
    values ('notify_' || item.channel::text, 'failed:' || item.id, jsonb_build_object('chat_id', item.chat_id,
      'reply_to', split_part(item.source_key, ':', 3), 'text', 'این پیام را نتوانستم بفهمم، ولی بایگانی شد. اگر ویس بود، در جای کم‌سروصداتر دوباره بگویید؛ اگر عکس بود، واضح‌تر و از نزدیک بگیرید.'))
    on conflict (kind, dedupe_key) do nothing;
  end if;
end;
$$;

create function public.fail_job(p_job bigint, p_lease uuid, p_error text, p_permanent boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare j public.jobs;
begin
  select * into j from public.jobs where id = p_job and kind in ('transcribe', 'extract') and status = 'running' and lease = p_lease for update;
  if not found then return; end if; -- already finished or handed to another worker: nothing to undo
  if p_permanent then update public.jobs set attempts = max_attempts where id = p_job; end if;
  perform public.finish_job(p_job, false, left(p_error, 500));
  if (select status from public.jobs where id = p_job) = 'failed' then perform public.item_gave_up(p_job, p_error); end if;
end;
$$;

-- Taking the next job, as in the intake migration — but a job whose worker died every time (it never got to report a
-- failure, e.g. a file that crashes it) is not taken again once its attempts are used up: it fails, and the sender is told.
create or replace function public.claim_job(p_kinds text[])
returns public.jobs
language plpgsql security definer set search_path = public
as $$
declare j public.jobs;
begin
  loop
    select * into j from public.jobs
    where kind = any (p_kinds)
      and ((status = 'pending' and next_run_at <= now())
           or (status = 'running' and locked_at < now() - interval '10 minutes'))
    order by next_run_at
    for update skip locked
    limit 1;
    if not found then return null; end if;
    if j.status = 'running' and j.attempts >= j.max_attempts then
      update public.jobs set status = 'failed', locked_at = null, lease = null,
        last_error = coalesce(last_error, 'the worker stopped during this job every time') where id = j.id;
      perform public.item_gave_up(j.id, 'the worker stopped during this job every time');
      continue;
    end if;
    update public.jobs set status = 'running', locked_at = now(), attempts = attempts + 1, lease = gen_random_uuid()
    where id = j.id returning * into j;
    return j;
  end loop;
end;
$$;

-- A bot reports a reply as sent (or not): only replies of its own channel.
-- With the lease of its claim: a late report of an earlier claim never closes the reply that is being sent now.
create function public.finish_notify(p_job bigint, p_lease uuid, p_channel public.channel, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.jobs where id = p_job and kind = 'notify_' || p_channel::text and status = 'running' and lease = p_lease) then
    raise exception 'not a running reply of this channel' using errcode = 'insufficient_privilege';
  end if;
  perform public.finish_job(p_job, p_ok, left(p_error, 500));
end;
$$;

-- ---------- linking a messenger account to a project ----------
create function public.set_default_ledger(p_channel public.channel, p_external_user text, p_ledger uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.user_identities ui set default_ledger_id = p_ledger
  where channel = p_channel and external_user_id = p_external_user
    and exists (select 1 from public.memberships ms join public.ledgers l on l.id = ms.ledger_id
                where ms.ledger_id = p_ledger and ms.user_id = ui.user_id and l.archived_at is null);
  if not found then raise exception 'not a member of that ledger' using errcode = 'insufficient_privilege'; end if;
end;
$$;

revoke execute on function public.is_linked(public.channel, text), public.sender_ledger(public.channel, text),
  public.inbox_by_source(public.channel, text, text), public.ingest_message(public.channel, text, text, text, text, jsonb, text, timestamptz), public.item_gave_up(bigint, text),
  public.job_context(bigint), public.leased_job(bigint, uuid, text), public.job_heartbeat(bigint, uuid),
  public.save_transcript(bigint, uuid, jsonb, text), public.save_extraction(bigint, uuid, jsonb, text[], text[], text, text, text),
  public.fail_job(bigint, uuid, text, boolean), public.finish_notify(bigint, uuid, public.channel, boolean, text),
  public.set_default_ledger(public.channel, text, uuid)
  from public, anon, authenticated;
