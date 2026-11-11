import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, freshDb, one, rows, sha } from './harness';

const OWNER = '00000000-0000-4000-8000-000000000001';
const FOREMAN = '00000000-0000-4000-8000-000000000002';
const SUPERVISOR = '00000000-0000-4000-8000-000000000003';
const ACCOUNTANT = '00000000-0000-4000-8000-000000000004';
const STRANGER = '00000000-0000-4000-8000-000000000005';

const M = 1_000_000n * 10n; // one million Toman in Rial

let db: PGlite;
let ws: string;
let project: string;
let personal: string;
let bank: string;
let cash: string;
let personalBank: string;
let rezaei: string;
let crew: string;
let omid: string;
let frame: string;

async function inboxWithDrafts(drafts: { kind: string; fields: Record<string, unknown> }[], sender = OWNER) {
  return asService(db, async () => {
    const media = await one<{ id: string }>(db,
      `insert into media (ledger_id, kind, channel, sender_user_id, external_chat_id, external_message_id, storage_path, mime, size_bytes, sha256)
       values ($1::uuid, 'voice', 'bale', $2, 'c1', gen_random_uuid()::text, $1::text || '/inbox/' || gen_random_uuid() || '.ogg', 'audio/ogg', 4096, $3) returning id`,
      [project, sender, sha(Math.floor(Math.random() * 1e9))]);
    const ib = await one<{ id: string }>(db,
      `insert into inbox_items (ledger_id, channel, sender_user_id, status) values ($1, 'bale', $2, 'ready') returning id`, [project, sender]);
    await db.query(`insert into inbox_item_media (inbox_item_id, media_id) values ($1, $2)`, [ib.id, media.id]);
    const ids: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const r = await one<{ id: string }>(db,
        `insert into drafts (inbox_item_id, ledger_id, ord, kind, fields) values ($1, $2, $3, $4, $5) returning id`,
        [ib.id, project, i, d.kind, JSON.stringify(d.fields)]);
      ids.push(r.id);
    }
    return { inbox: ib.id, drafts: ids, media: media.id };
  });
}

const balance = (account: string) =>
  asUser(db, OWNER, async () => BigInt((await one<{ b: string }>(db, `select balance_rial::text b from account_balances where account_id = $1`, [account])).b));
const owed = (person: string) =>
  asUser(db, OWNER, async () => BigInt((await rows<{ o: string }>(db, `select owed_rial::text o from person_balances where ledger_id = $1 and person_id = $2`, [project, person]))[0]?.o ?? '0'));
const stageSpent = (stage: string) =>
  asUser(db, OWNER, async () => BigInt((await one<{ s: string }>(db, `select spent_rial::text s from stage_spend where stage_id = $1`, [stage])).s));

beforeAll(async () => {
  db = await freshDb();
  for (const [id, email] of [[OWNER, 'o'], [FOREMAN, 'f'], [SUPERVISOR, 's'], [ACCOUNTANT, 'a'], [STRANGER, 'x']]) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  }
  await asUser(db, OWNER, async () => {
    ws = (await one<{ id: string }>(db, `select create_workspace('شرکت نمونه') id`)).id;
    project = (await one<{ id: string }>(db, `select create_project($1, 'ساختمان بهار', 'تهران') id`, [ws])).id;
    personal = (await one<{ id: string }>(db, `select id from ledgers where workspace_id = $1 and kind = 'personal'`, [ws])).id;
    for (const [u, r] of [[FOREMAN, 'foreman'], [SUPERVISOR, 'supervisor'], [ACCOUNTANT, 'accountant']]) {
      await db.query(`insert into memberships (ledger_id, user_id, role) values ($1, $2, $3)`, [project, u, r]);
    }
    bank = (await one<{ id: string }>(db, `insert into accounts (ledger_id, kind, name) values ($1, 'bank', 'بانک ملت') returning id`, [project])).id;
    cash = (await one<{ id: string }>(db, `insert into accounts (ledger_id, kind, name) values ($1, 'cash', 'تنخواه کارگاه') returning id`, [project])).id;
    personalBank = (await one<{ id: string }>(db, `insert into accounts (ledger_id, kind, name) values ($1, 'bank', 'پاسارگاد') returning id`, [personal])).id;
    rezaei = (await one<{ id: string }>(db, `insert into people (workspace_id, kind, full_name, role_title, aliases) values ($1, 'contractor', 'حسین رضایی', 'آرماتوربند', '{آقای رضایی}') returning id`, [ws])).id;
    crew = (await one<{ id: string }>(db, `insert into people (workspace_id, kind, full_name) values ($1, 'crew', 'کارگران روزمزد') returning id`, [ws])).id;
    omid = (await one<{ id: string }>(db, `insert into people (workspace_id, kind, full_name) values ($1, 'supplier', 'مصالح‌فروشی امید') returning id`, [ws])).id;
    frame = (await one<{ id: string }>(db, `select id from stages where ledger_id = $1 and template_code = 'frame'`, [project])).id;
    // Rezaei is already owed 18 million for earlier work
    await db.query(`insert into obligations (ledger_id, person_id, stage_id, occurred_on, amount_rial, kind) values ($1, $2, $3, '2026-11-01', $4, 'work')`,
      [project, rezaei, frame, (18n * M).toString()]);
  });
}, 60_000);

describe('setting up', () => {
  it('a new project gets all 25 stages with their steps and checkpoints', async () => {
    await asUser(db, OWNER, async () => {
      expect((await one<{ n: number }>(db, `select count(*)::int n from stages where ledger_id = $1`, [project])).n).toBe(25);
      expect((await one<{ n: number }>(db, `select count(*)::int n from stage_steps where ledger_id = $1`, [project])).n).toBe(102);
      expect((await one<{ n: number }>(db, `select count(*)::int n from stage_steps where ledger_id = $1 and is_checkpoint`, [project])).n).toBeGreaterThan(10);
    });
  });

  it('the workspace owner owns the company, personal and project ledgers', async () => {
    const r = await rows<{ kind: string; role: string }>(db,
      `select l.kind::text, m.role::text from ledgers l join memberships m on m.ledger_id = l.id and m.user_id = $1 where l.workspace_id = $2 order by l.kind`, [OWNER, ws]);
    expect(r.map((x) => `${x.kind}:${x.role}`).sort()).toEqual(['company:owner', 'personal:owner', 'project:owner']);
  });
});

describe('who sees what', () => {
  it('foreman and supervisor cannot see accounts, transactions or budgets; the accountant can', async () => {
    for (const u of [FOREMAN, SUPERVISOR]) {
      await asUser(db, u, async () => {
        expect(await rows(db, `select * from accounts`)).toHaveLength(0);
        expect(await rows(db, `select * from transactions`)).toHaveLength(0);
        expect(await rows(db, `select * from stage_budgets`)).toHaveLength(0);
        expect((await rows(db, `select * from stages`)).length).toBe(25);
      });
    }
    await asUser(db, ACCOUNTANT, async () => {
      expect((await rows(db, `select * from accounts`)).length).toBe(2); // project accounts, not the personal one
    });
  });

  it('nobody outside sees anything', async () => {
    await asUser(db, STRANGER, async () => {
      expect(await rows(db, `select * from ledgers`)).toHaveLength(0);
      expect(await rows(db, `select * from stages`)).toHaveLength(0);
      expect(await rows(db, `select * from people`)).toHaveLength(0);
    });
  });

  it('document categories follow the role defaults', async () => {
    await asUser(db, OWNER, async () => {
      await db.query(
        `insert into documents (ledger_id, category_code, discipline_code, title, status, is_financial) values
          ($1, 'property', null, 'سند مالکیت', 'approved', false),
          ($1, 'drawings', 'structural', 'نقشهٔ سازه (پیش‌نویس)', 'draft', false),
          ($1, 'drawings', 'structural', 'نقشهٔ سازه (اجرایی)', 'executive', false),
          ($1, 'supervision', null, 'قرارداد ناظر', 'approved', true),
          ($1, 'supervision', null, 'صورت‌جلسهٔ ناظر', 'approved', false),
          ($1, 'insurance', null, 'فیش بیمه', 'approved', true)`, [project]);
    });
    const seen = (u: string) => asUser(db, u, async () => (await rows<{ title: string }>(db, `select title from documents order by title`)).map((r) => r.title));
    expect(await seen(OWNER)).toHaveLength(6);
    expect(await seen(FOREMAN)).toEqual(['نقشهٔ سازه (اجرایی)']);
    expect((await seen(SUPERVISOR)).sort()).toEqual(['صورت‌جلسهٔ ناظر', 'نقشهٔ سازه (اجرایی)', 'نقشهٔ سازه (پیش‌نویس)'].sort());
    expect(await seen(ACCOUNTANT)).toEqual(['فیش بیمه']);
  });
});

describe('confirming a voice note', () => {
  it('unpaid wages become an obligation, paying an old debt is not a new cost, a document waits for its file', async () => {
    const { inbox, drafts, media } = await inboxWithDrafts([
      { kind: 'work_log', fields: { headcount: 5, wage_rial: (12n * M / 10n).toString(), stage_id: frame, crew_person_id: crew, work_date: '2026-11-10', paid: false } },
      { kind: 'payment', fields: { amount_rial: (12n * M).toString(), account_id: bank, person_id: rezaei, settles: true, method: 'کارت به کارت' } },
      { kind: 'document', fields: { title: 'نامهٔ تمدید پروانه', category_code: 'municipality' } },
      { kind: 'daily_note', fields: { body: 'آرماتورهای سقف طبقهٔ دوم تأیید شد', stage_id: frame } },
    ]);
    const bankBefore = await balance(bank);

    await asUser(db, FOREMAN, async () => {
      await expect(db.query(`select confirm_inbox($1, $2)`, [inbox, drafts])).rejects.toThrow(/only the owner/);
    });
    await asUser(db, OWNER, async () => {
      await db.query(`select confirm_inbox($1, $2)`, [inbox, drafts]);
    });

    expect(await balance(bank)).toBe(bankBefore - 12n * M);
    await asUser(db, OWNER, async () => {
      expect((await one<{ d: string }>(db, `select description d from transactions where draft_id = $1`, [drafts[1]])).d).toBe('پرداخت به حسین رضایی');
    });
    expect(await owed(crew)).toBe(6n * M);
    expect(await owed(rezaei)).toBe(6n * M); // 18 owed − 12 paid
    expect(await stageSpent(frame)).toBe(18n * M + 6n * M); // the old 18 + today's wages; the payment adds nothing
    await asUser(db, OWNER, async () => {
      expect((await one<{ status: string }>(db, `select status::text from documents where title = 'نامهٔ تمدید پروانه'`)).status).toBe('awaiting_file');
      expect((await one<{ n: number }>(db, `select count(*)::int n from media_links where media_id = $1`, [media])).n).toBe(5);
      const audit = await rows<{ source: string; draft_id: string | null; table_name: string }>(db,
        `select source, draft_id::text, table_name from audit_log where draft_id = any($1::uuid[])`, [drafts]);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((a) => a.source === 'draft')).toBe(true);
    });
  });

  it('undo puts everything back', async () => {
    const { inbox, drafts } = await inboxWithDrafts([
      { kind: 'payment', fields: { amount_rial: (3n * M).toString(), account_id: cash, person_id: omid, stage_id: frame, description: '۲۰ کیسه سیمان' } },
      { kind: 'stage_progress', fields: { stage_id: frame, progress_pct: 70, status: 'in_progress' } },
    ]);
    const before = { cash: await balance(cash), spent: await stageSpent(frame) };
    await asUser(db, OWNER, async () => { await db.query(`select confirm_inbox($1, $2)`, [inbox, drafts]); });
    expect(await balance(cash)).toBe(before.cash - 3n * M);
    expect(await stageSpent(frame)).toBe(before.spent + 3n * M); // a cash purchase is a cost
    await asUser(db, OWNER, async () => {
      expect((await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p).toBe(70);
      await db.query(`select undo_inbox($1)`, [inbox]);
      expect((await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p).toBe(0);
      expect((await one<{ s: string }>(db, `select status::text s from inbox_items where id = $1`, [inbox])).s).toBe('ready');
      expect((await rows(db, `select * from drafts where inbox_item_id = $1 and status = 'pending'`, [inbox])).length).toBe(2);
    });
    expect(await balance(cash)).toBe(before.cash);
    expect(await stageSpent(frame)).toBe(before.spent);
  });

  it('only the chosen cards are recorded; edits made on the review sheet win over the AI', async () => {
    const { inbox, drafts } = await inboxWithDrafts([
      { kind: 'payment', fields: { amount_rial: (4n * M).toString(), account_id: bank, person_id: omid } },
      { kind: 'daily_note', fields: { body: 'یادداشت اضافه' } },
    ]);
    const before = await balance(bank);
    await asUser(db, OWNER, async () => {
      await db.query(`select confirm_inbox($1, $2, $3)`, [inbox, [drafts[0]], JSON.stringify({ [drafts[0]]: { amount_rial: (5n * M).toString() } })]);
      expect((await one<{ s: string }>(db, `select status::text s from drafts where id = $1`, [drafts[1]])).s).toBe('dropped');
    });
    expect(await balance(bank)).toBe(before - 5n * M);
  });

  it('personal money spent on the project is recorded as the project owing the personal ledger', async () => {
    const { inbox, drafts } = await inboxWithDrafts([
      { kind: 'payment', fields: { amount_rial: (124n * M / 100n).toString(), account_id: personalBank, description: 'قبض برق کارگاه' } },
    ]);
    await asUser(db, OWNER, async () => { await db.query(`select confirm_inbox($1, $2)`, [inbox, drafts]); });
    await asUser(db, ACCOUNTANT, async () => {
      const r = await rows<{ amount_rial: string }>(db, `select amount_rial::text from inter_ledger_balances where debtor_ledger_id = $1 and creditor_ledger_id = $2`, [project, personal]);
      expect(r.map((x) => BigInt(x.amount_rial))).toEqual([124n * M / 100n]);
      expect(await rows(db, `select * from accounts where id = $1`, [personalBank])).toHaveLength(0); // still can't see the personal account
    });
  });

  it('a transfer is two legs that sum to zero; a single leg is refused', async () => {
    const { inbox, drafts } = await inboxWithDrafts([
      { kind: 'transfer', fields: { amount_rial: (30n * M).toString(), from_account_id: bank, to_account_id: cash } },
    ]);
    const b = await balance(bank), c = await balance(cash);
    await asUser(db, OWNER, async () => { await db.query(`select confirm_inbox($1, $2)`, [inbox, drafts]); });
    expect(await balance(bank)).toBe(b - 30n * M);
    expect(await balance(cash)).toBe(c + 30n * M);
    await asUser(db, OWNER, async () => {
      await expect(db.query(
        `insert into transactions (ledger_id, account_id, occurred_on, amount_rial, transfer_id) values ($1, $2, current_date, -1000, gen_random_uuid())`,
        [project, bank])).rejects.toThrow(/two legs/);
    });
  });

  it('bad cards are refused with a clear reason', async () => {
    const { inbox, drafts } = await inboxWithDrafts([{ kind: 'payment', fields: { amount_rial: '0', account_id: bank } }]);
    await asUser(db, OWNER, async () => {
      await expect(db.query(`select confirm_inbox($1, $2)`, [inbox, drafts])).rejects.toThrow(/positive amount/);
    });
  });
});

describe('the archive and the history cannot be rewritten', () => {
  it('an original file cannot be changed or deleted, only hidden', async () => {
    const { media } = await inboxWithDrafts([]);
    await asService(db, async () => {
      await expect(db.query(`update media set sha256 = $2 where id = $1`, [media, sha(1)])).rejects.toThrow(/cannot be changed/);
      await expect(db.query(`delete from media where id = $1`, [media])).rejects.toThrow(/never deleted/);
      await db.query(`update media set transcript = 'متن ویس' where id = $1`, [media]);
    });
    await asUser(db, OWNER, async () => {
      await db.query(`update media set hidden_at = now() where id = $1`, [media]);
      expect((await one<{ by: string }>(db, `select hidden_by::text by from media where id = $1`, [media])).by).toBe(OWNER);
    });
  });

  it('the change history is append-only, even for the server', async () => {
    await asService(db, async () => {
      await expect(db.query(`update audit_log set source = 'x'`)).rejects.toThrow(/append-only/);
      await expect(db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
    });
  });

  it('the same incoming message cannot be queued twice; failures retry later, then stop', async () => {
    await asService(db, async () => {
      await db.query(`insert into jobs (kind, dedupe_key) values ('transcribe', 'bale:c1:42')`);
      await expect(db.query(`insert into jobs (kind, dedupe_key) values ('transcribe', 'bale:c1:42')`)).rejects.toThrow(/duplicate/);
      const j = await one<{ id: number; attempts: number }>(db, `select * from claim_job(array['transcribe'])`);
      expect(j.attempts).toBe(1);
      await db.query(`select finish_job($1, false, 'network down')`, [j.id]);
      const after = await one<{ status: string; later: boolean }>(db, `select status::text, next_run_at > now() later from jobs where id = $1`, [j.id]);
      expect(after).toEqual({ status: 'pending', later: true });
    });
    await asUser(db, OWNER, async () => {
      await expect(db.query(`select * from jobs`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('archive files in storage', () => {
  it('a file can be read exactly when its archive row is visible', async () => {
    const { media } = await inboxWithDrafts([], FOREMAN);
    const path = (await one<{ p: string }>(db, `select storage_path p from media where id = $1`, [media])).p;
    await db.query(`insert into storage.objects (bucket_id, name) values ('archive', $1)`, [path]);
    const canRead = (u: string) => asUser(db, u, async () => (await rows(db, `select 1 from storage.objects where name = $1`, [path])).length === 1);
    expect(await canRead(OWNER)).toBe(true);
    expect(await canRead(FOREMAN)).toBe(true); // they sent it
    expect(await canRead(SUPERVISOR)).toBe(false);
    expect(await canRead(STRANGER)).toBe(false);
  });
});

describe('linking a messenger account', () => {
  it('needs the sender\'s own contact, the right phone and a fresh code', async () => {
    await db.query(`insert into profiles (id, full_name, phone) values ($1, 'سرکارگر', '+989121234567')`, [FOREMAN]);
    const code = await asUser(db, FOREMAN, async () => (await one<{ c: string }>(db, `select create_link_code() c`)).c);
    await asService(db, async () => {
      await expect(db.query(`select link_identity('bale', '111', '222', '+989121234567', $1)`, [code])).rejects.toThrow(/own number/);
      await expect(db.query(`select link_identity('bale', '111', '111', '+989120000000', $1)`, [code])).rejects.toThrow(/not the one/);
      await db.query(`select link_identity('bale', '111', '111', '+989121234567', $1)`, [code]);
      await expect(db.query(`select link_identity('bale', '111', '111', '+989121234567', $1)`, [code])).rejects.toThrow(/wrong or expired/);
    });
    await asUser(db, FOREMAN, async () => {
      expect(await rows(db, `select * from user_identities`)).toHaveLength(1);
      await expect(db.query(`select link_identity('bale', '9', '9', '+989121234567', '000000')`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe('attacks found in review are refused', () => {
  const ATTACKER = '00000000-0000-4000-8000-000000000006';
  let aws: string; let aproject: string; let victimTx: string;

  beforeAll(async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'evil')`, [ATTACKER]);
    await asUser(db, ATTACKER, async () => {
      aws = (await one<{ id: string }>(db, `select create_workspace('شرکت دیگر') id`)).id;
      aproject = (await one<{ id: string }>(db, `select create_project($1, 'پروژهٔ دیگر', 'کرج') id`, [aws])).id;
    });
    await asUser(db, OWNER, async () => {
      victimTx = (await one<{ id: string }>(db,
        `insert into transactions (ledger_id, account_id, occurred_on, amount_rial, is_cost, description) values ($1, $2, current_date, -7000, true, 'هدف') returning id`,
        [project, bank])).id;
    });
  });

  it('undo voids only what that item created in its own ledger, and drafts cannot be edited directly', async () => {
    const ib = await asService(db, async () => {
      const i = await one<{ id: string }>(db,
        `insert into inbox_items (ledger_id, channel, status, resolved_at) values ($1, 'web', 'confirmed', now()) returning id`, [aproject]);
      await db.query(`insert into drafts (inbox_item_id, ledger_id, kind, status, result) values ($1, $2, 'payment', 'accepted', $3)`,
        [i.id, aproject, JSON.stringify({ created: [{ table: 'transactions', id: victimTx }] })]);
      return i.id;
    });
    await asUser(db, ATTACKER, async () => {
      await expect(db.query(`update drafts set result = '{}' where inbox_item_id = $1`, [ib])).rejects.toThrow(/permission denied/);
      await db.query(`select undo_inbox($1)`, [ib]);
    });
    await asService(db, async () => {
      expect((await one<{ v: string | null }>(db, `select voided_at::text v from transactions where id = $1`, [victimTx])).v).toBeNull();
    });
  });

  it('a file of another ledger cannot be reached through preview_path or a document version', async () => {
    const victim = await inboxWithDrafts([]);
    const victimPath = (await one<{ p: string }>(db, `select storage_path p from media where id = $1`, [victim.media])).p;
    await db.query(`insert into storage.objects (bucket_id, name) values ('archive', $1)`, [victimPath]);
    const own = await asService(db, async () => (await one<{ id: string }>(db,
      `insert into media (ledger_id, kind, channel, sender_user_id, storage_path, mime, size_bytes, sha256)
       values ($1::uuid, 'image', 'web', $2, $1::text || '/inbox/own.jpg', 'image/jpeg', 10, $3) returning id`, [aproject, ATTACKER, sha(77)])).id);
    await asUser(db, ATTACKER, async () => {
      await expect(db.query(`update media set preview_path = $2 where id = $1`, [own, victimPath])).rejects.toThrow(/permission denied/);
    });
    // even if such a path were ever stored, the file stays closed: the path must start with the file's own ledger
    await asService(db, async () => { await db.query(`update media set preview_path = $2 where id = $1`, [own, victimPath]); });
    await asUser(db, ATTACKER, async () => {
      expect(await rows(db, `select 1 from storage.objects where name = $1`, [victimPath])).toHaveLength(0);
      const doc = await one<{ id: string }>(db, `insert into documents (ledger_id, category_code, title) values ($1, 'property', 'سند') returning id`, [aproject]);
      await expect(db.query(`insert into document_versions (document_id, ledger_id, version_no, media_id) values ($1, $2, 1, $3)`, [doc.id, aproject, victim.media]))
        .rejects.toThrow(/row-level security/);
    });
    const other = await inboxWithDrafts([{ kind: 'document', fields: { title: 'نقشه', category_code: 'drawings', media_ids: [victim.media] } }]);
    await asUser(db, OWNER, async () => {
      await expect(db.query(`select confirm_inbox($1, $2)`, [other.inbox, other.drafts])).rejects.toThrow(/must come from this item/);
    });
  });

  it('the owner role is never granted or taken through memberships, and a ledger cannot move to another workspace', async () => {
    await asUser(db, OWNER, async () => {
      await expect(db.query(`insert into memberships (ledger_id, user_id, role) values ($1, $2, 'owner')`, [project, ATTACKER])).rejects.toThrow(/row-level security/);
      await db.query(`delete from memberships where ledger_id = $1 and user_id = $2`, [project, OWNER]);
      await expect(db.query(`update ledgers set workspace_id = $2 where id = $1`, [project, aws])).rejects.toThrow(/permission denied/);
    });
    expect((await one<{ n: number }>(db, `select count(*)::int n from memberships where ledger_id = $1 and user_id = $2 and role = 'owner'`, [project, OWNER])).n).toBe(1);
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`insert into memberships (ledger_id, user_id, role) values ($1, $2, 'foreman')`, [project, ATTACKER])).rejects.toThrow(/row-level security/);
    });
  });

  it('the foreman cannot delete stages or fake a step; supervisor checkpoints are closed by the supervisor', async () => {
    const step = (checkpoint: boolean) => one<{ id: string }>(db,
      `select id from stage_steps where ledger_id = $1 and is_checkpoint = $2 and done_at is null order by ord limit 1`, [project, checkpoint]);
    const plain = (await step(false)).id, check = (await step(true)).id;
    await asUser(db, FOREMAN, async () => {
      await db.query(`delete from stages where ledger_id = $1`, [project]);
      await expect(db.query(`insert into stages (ledger_id, ord, name, phase) values ($1, 99, 'x', 'build')`, [project])).rejects.toThrow();
      await expect(db.query(`update stage_steps set done_by = $2 where id = $1`, [plain, SUPERVISOR])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update stage_steps set is_checkpoint = false where id = $1`, [check])).rejects.toThrow(/permission denied/);
      await db.query(`update stage_steps set done_at = now() where id = $1`, [plain]);
      await expect(db.query(`update stage_steps set done_at = now() where id = $1`, [check])).rejects.toThrow(/supervisor/);
    });
    await asUser(db, SUPERVISOR, async () => { await db.query(`update stage_steps set done_at = now() where id = $1`, [check]); });
    const r = await rows<{ id: string; by: string }>(db, `select id, done_by::text by from stage_steps where id = any($1::uuid[])`, [[plain, check]]);
    expect(Object.fromEntries(r.map((x) => [x.id, x.by]))).toEqual({ [plain]: FOREMAN, [check]: SUPERVISOR });
    expect((await one<{ n: number }>(db, `select count(*)::int n from stages where ledger_id = $1`, [project])).n).toBe(25);
  });

  it('the accountant cannot move money in the personal account of the owner', async () => {
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`insert into transactions (ledger_id, account_id, occurred_on, amount_rial) values ($1, $2, current_date, -1000)`, [project, personalBank]))
        .rejects.toThrow(/row-level security/);
      await expect(db.query(`update transactions set account_id = $2 where id = $1`, [victimTx, personalBank])).rejects.toThrow(/row-level security/);
    });
  });

  it('inter-ledger debt follows account changes, voids and transfers in both directions; balances count every ledger', async () => {
    const net = () => asUser(db, OWNER, async () => BigInt((await one<{ n: string }>(db,
      `select (coalesce(sum(amount_rial) filter (where debtor_ledger_id = $1), 0) - coalesce(sum(amount_rial) filter (where creditor_ledger_id = $1), 0))::text n
       from inter_ledger_balances where voided_at is null and $2 in (debtor_ledger_id, creditor_ledger_id)`, [project, personal])).n));
    const start = await net();
    await asUser(db, OWNER, async () => {
      await db.query(`update transactions set account_id = $2 where id = $1`, [victimTx, personalBank]); // paid from personal after all
    });
    expect(await net()).toBe(start + 7000n);
    await asUser(db, OWNER, async () => { await db.query(`update transactions set voided_at = now() where id = $1`, [victimTx]); });
    expect(await net()).toBe(start);
    const t = await inboxWithDrafts([
      { kind: 'transfer', fields: { amount_rial: '50000', from_account_id: personalBank, to_account_id: bank } },
      { kind: 'transfer', fields: { amount_rial: '20000', from_account_id: bank, to_account_id: personalBank } },
    ]);
    await asUser(db, OWNER, async () => { await db.query(`select confirm_inbox($1, $2)`, [t.inbox, t.drafts]); });
    expect(await net()).toBe(start + 30000n); // 50 000 lent to the project, 20 000 paid back
    // a personal matter paid from the project bank: owner and accountant see the same bank balance
    await asUser(db, OWNER, async () => {
      await db.query(`insert into transactions (ledger_id, account_id, occurred_on, amount_rial) values ($1, $2, current_date, -1500)`, [personal, bank]);
    });
    const ownerSees = await balance(bank);
    const accountantSees = await asUser(db, ACCOUNTANT, async () => BigInt((await one<{ b: string }>(db, `select balance_rial::text b from account_balances where account_id = $1`, [bank])).b));
    expect(accountantSees).toBe(ownerSees);
    await asUser(db, ACCOUNTANT, async () => {
      expect(await rows(db, `select * from account_balances where account_id = $1`, [personalBank])).toHaveLength(0);
    });
    await asUser(db, FOREMAN, async () => { expect(await rows(db, `select * from account_balances`)).toHaveLength(0); });
  });

  it('settling a debt needs the person; a job whose worker died is picked up again', async () => {
    const s = await inboxWithDrafts([{ kind: 'payment', fields: { amount_rial: '1000', account_id: bank, settles: true } }]);
    await asUser(db, OWNER, async () => {
      await expect(db.query(`select confirm_inbox($1, $2)`, [s.inbox, s.drafts])).rejects.toThrow(/needs the person/);
    });
    await asService(db, async () => {
      await db.query(`insert into jobs (kind, dedupe_key, status, locked_at) values ('ocr', 'web:stale', 'running', now() - interval '11 minutes')`);
      await db.query(`insert into jobs (kind, dedupe_key, status, locked_at) values ('ocr', 'web:busy', 'running', now() - interval '1 minute')`);
      const j = await one<{ dedupe_key: string; attempts: number }>(db, `select * from claim_job(array['ocr'])`);
      expect(j.dedupe_key).toBe('web:stale');
      expect((await one<{ k: string | null }>(db, `select (claim_job(array['ocr'])).dedupe_key k`)).k).toBeNull();
    });
  });
});

describe('leaks found in QA are closed', () => {
  it('the accountant does not read hidden documents through the history, nor the project budget', async () => {
    await asUser(db, OWNER, async () => {
      await db.query(`insert into documents (ledger_id, category_code, title, status, is_financial) values ($1, 'property', 'سند ملکی محرمانه', 'approved', false)`, [project]);
      await db.query(`insert into documents (ledger_id, category_code, title, status, is_financial) values ($1, 'municipality', 'فیش عوارض نوسازی', 'approved', true)`, [project]);
      await db.query(`insert into documents (ledger_id, category_code, title, status, is_financial) values ($1, 'municipality', 'نامهٔ شهرداری', 'approved', false)`, [project]);
      await db.query(`insert into project_budgets (ledger_id, budget_rial) values ($1, 50000000000)`, [project]);
    });
    await asUser(db, ACCOUNTANT, async () => {
      const titles = (await rows<{ t: string }>(db, `select new_row ->> 'title' t from audit_log where table_name = 'documents'`)).map((r) => r.t);
      expect(titles).not.toContain('سند ملکی محرمانه');
      expect(titles).toContain('فیش عوارض نوسازی');
      expect(titles).not.toContain('نامهٔ شهرداری'); // from the municipality file the accountant sees only the fee receipts
      expect((await rows<{ title: string }>(db, `select title from documents where category_code = 'municipality'`)).map((r) => r.title)).toEqual(['فیش عوارض نوسازی']);
      expect(await rows(db, `select * from audit_log where table_name in ('memberships', 'people', 'stages')`)).toHaveLength(0);
      expect(await rows(db, `select * from project_budgets`)).toHaveLength(1);
    });
    for (const u of [FOREMAN, SUPERVISOR]) {
      await asUser(db, u, async () => {
        expect(await rows(db, `select * from project_budgets`)).toHaveLength(0);
        expect(Object.keys((await rows<Record<string, unknown>>(db, `select * from projects`))[0])).not.toContain('budget_rial');
      });
    }
  });

  it('the foreman reports progress through the owner; stage changes need the owner', async () => {
    await asUser(db, FOREMAN, async () => {
      await db.query(`update stages set progress_pct = 99 where id = $1`, [frame]);
    });
    expect((await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p).not.toBe(99);
  });

  it('each stage of a project gets its document checklist once; financial items only for money roles', async () => {
    await asService(db, async () => {
      expect((await one<{ n: number }>(db, `select instantiate_stages($1) n`, [project])).n).toBe(0);
    });
    const count = (u: string) => asUser(db, u, async () => (await one<{ n: number }>(db, `select count(*)::int n from stage_docs where ledger_id = $1`, [project])).n);
    const all = await count(OWNER);
    expect(all).toBeGreaterThan(40);
    expect(await count(ACCOUNTANT)).toBe(all);
    expect(await count(FOREMAN)).toBeLessThan(all);
    expect((await one<{ n: number }>(db, `select count(*)::int n from stages where ledger_id = $1`, [project])).n).toBe(25);
  });

  it('the same message is archived once and its origin cannot be rewritten', async () => {
    await asService(db, async () => {
      const ins = `insert into media (ledger_id, kind, channel, external_chat_id, external_message_id, storage_path, mime, size_bytes, sha256)
                   values ($1, 'image', 'telegram', 'c9', 'm9', $2, 'image/jpeg', 5, $3) returning id`;
      const m = await one<{ id: string }>(db, ins, [project, `${project}/inbox/a.jpg`, sha(91)]);
      await expect(db.query(ins, [project, `${project}/inbox/b.jpg`, sha(92)])).rejects.toThrow(/duplicate/);
      await expect(db.query(`update media set caption = 'دست‌کاری' where id = $1`, [m.id])).rejects.toThrow(/cannot be changed/);
      await expect(db.query(`update media set external_message_id = 'x' where id = $1`, [m.id])).rejects.toThrow(/cannot be changed/);
    });
  });

  it('linking a messenger account is kept in the history; link codes come from the secure generator', async () => {
    const n = await asService(db, async () => (await one<{ n: number }>(db, `select count(*)::int n from audit_log where table_name = 'user_identities'`)).n);
    expect(n).toBeGreaterThan(0);
    const codes = await asUser(db, SUPERVISOR, async () => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) out.push((await one<{ c: string }>(db, `select create_link_code() c`)).c);
      return out;
    });
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
  });
});

describe('round-2 review attacks are refused', () => {
  it('a transfer cannot be split by clearing one leg; legs the caller cannot see still count', async () => {
    const t = await inboxWithDrafts([{ kind: 'transfer', fields: { amount_rial: '40000', from_account_id: bank, to_account_id: cash } }]);
    await asUser(db, OWNER, async () => { await db.query(`select confirm_inbox($1, $2)`, [t.inbox, t.drafts]); });
    const leg = (await one<{ id: string }>(db, `select id from transactions where draft_id = $1 limit 1`, [t.drafts[0]])).id;
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`update transactions set transfer_id = null where id = $1`, [leg])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update transactions set amount_rial = -1 where id = $1`, [leg])).rejects.toThrow(/two legs/);
    });
  });

  it('ledger, draft and creator are not editable; an account cannot move ledgers', async () => {
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`update accounts set ledger_id = $2 where id = $1`, [bank, personal])).rejects.toThrow(/permission denied/);
      const tx = (await one<{ id: string }>(db, `select id from transactions where ledger_id = $1 and transfer_id is null and voided_at is null limit 1`, [project])).id;
      for (const col of ['ledger_id', 'draft_id', 'created_by', 'voided_by']) {
        await expect(db.query(`update transactions set ${col} = null where id = $1`, [tx])).rejects.toThrow(/permission denied/);
      }
      const o = await one<{ created_by: string }>(db,
        `insert into obligations (ledger_id, person_id, occurred_on, amount_rial, kind, created_by) values ($1, $2, current_date, 1000, 'other', $3) returning created_by::text`,
        [project, omid, OWNER]);
      expect(o.created_by).toBe(ACCOUNTANT);
    });
  });

  it('a voided record is restored only by the owner, and the database records who voided it', async () => {
    const id = await asUser(db, FOREMAN, async () =>
      (await one<{ id: string }>(db, `insert into daily_notes (ledger_id, note_date, body) values ($1, current_date, 'یادداشت') returning id`, [project])).id);
    await asUser(db, OWNER, async () => { await db.query(`update daily_notes set voided_at = now() where id = $1`, [id]); });
    expect((await one<{ by: string }>(db, `select voided_by::text by from daily_notes where id = $1`, [id])).by).toBe(OWNER);
    await asUser(db, FOREMAN, async () => {
      await expect(db.query(`update daily_notes set voided_at = null where id = $1`, [id])).rejects.toThrow(/only the owner/);
    });
  });

  it('writes cannot point at another project\'s stage, a stranger, or another ledger\'s file', async () => {
    const other = await asUser(db, OWNER, async () => (await one<{ id: string }>(db, `select create_project($1, 'پروژهٔ دوم', 'تهران') id`, [ws])).id);
    const otherStage = (await one<{ id: string }>(db, `select id from stages where ledger_id = $1 limit 1`, [other])).id;
    await db.query(`insert into memberships (ledger_id, user_id, role) values ($1, $2, 'accountant') on conflict do nothing`, [other, ACCOUNTANT]);
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`insert into obligations (ledger_id, person_id, stage_id, occurred_on, amount_rial, kind) values ($1, $2, $3, current_date, 1000, 'other')`,
        [project, omid, otherStage])).rejects.toThrow(/stage is not in this ledger/);
    });
    const strangerPerson = await asUser(db, STRANGER, async () => {
      const w = (await one<{ id: string }>(db, `select create_workspace('دیگری') id`)).id;
      return (await one<{ id: string }>(db, `insert into people (workspace_id, kind, full_name) values ($1, 'other', 'غریبه') returning id`, [w])).id;
    });
    await asUser(db, OWNER, async () => {
      await expect(db.query(`insert into transactions (ledger_id, account_id, occurred_on, amount_rial, person_id) values ($1, $2, current_date, -10, $3)`,
        [project, bank, strangerPerson])).rejects.toThrow(/not in this workspace/);
    });
  });

  it('only the owner changes what makes a document visible; the foreman does not read AI drafts', async () => {
    const doc = await asUser(db, OWNER, async () => (await one<{ id: string }>(db,
      `insert into documents (ledger_id, category_code, title, status, is_financial) values ($1, 'insurance', 'فیش بیمهٔ مهر', 'approved', true) returning id`, [project])).id);
    await asUser(db, ACCOUNTANT, async () => {
      await expect(db.query(`update documents set is_financial = false where id = $1`, [doc])).rejects.toThrow(/only the owner/);
      await expect(db.query(`update documents set ledger_id = $2 where id = $1`, [doc, personal])).rejects.toThrow(/permission denied/);
      await db.query(`update documents set title = 'فیش بیمهٔ مهر ۱۴۰۵' where id = $1`, [doc]);
    });
    await inboxWithDrafts([{ kind: 'payment', fields: { amount_rial: '5000', account_id: bank } }], FOREMAN);
    await asUser(db, FOREMAN, async () => { expect(await rows(db, `select * from drafts`)).toHaveLength(0); });
  });

  it('nobody claims a phone number: profiles get it from the verified sign-in only', async () => {
    await asUser(db, STRANGER, async () => {
      await expect(db.query(`insert into profiles (id, full_name, phone) values ($1, 'x', '+989129999999')`, [STRANGER])).rejects.toThrow(/permission denied/);
    });
    await asUser(db, FOREMAN, async () => {
      await expect(db.query(`update profiles set phone = '+989120000001' where id = $1`, [FOREMAN])).rejects.toThrow(/permission denied/);
      await db.query(`update profiles set full_name = 'رحیم' where id = $1`, [FOREMAN]);
    });
  });

  it('undoing an older progress report never wipes a newer one', async () => {
    const a = await inboxWithDrafts([{ kind: 'stage_progress', fields: { stage_id: frame, progress_pct: 30 } }]);
    const b = await inboxWithDrafts([{ kind: 'stage_progress', fields: { stage_id: frame, progress_pct: 60 } }]);
    await asUser(db, OWNER, async () => {
      await db.query(`select confirm_inbox($1, $2)`, [a.inbox, a.drafts]);
      await db.query(`select confirm_inbox($1, $2)`, [b.inbox, b.drafts]);
      await expect(db.query(`select undo_inbox($1)`, [a.inbox])).rejects.toThrow(/stage changed/);
      await db.query(`select undo_inbox($1)`, [b.inbox]);
      expect((await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p).toBe(30);
    });
  });
});

describe('round-2 QA findings', () => {
  it('the accountant cannot touch documents they cannot see, even without a WHERE', async () => {
    const id = await asUser(db, OWNER, async () => (await one<{ id: string }>(db,
      `insert into documents (ledger_id, category_code, title, status) values ($1, 'property', 'سند سری', 'approved') returning id`, [project])).id);
    await asUser(db, ACCOUNTANT, async () => { await db.query(`update documents set title = 'hacked'`); });
    expect((await one<{ t: string }>(db, `select title t from documents where id = $1`, [id])).t).toBe('سند سری');
  });
  it('a verified phone reaches the profile; the owner reads the history of people', async () => {
    const u = '00000000-0000-4000-8000-000000000009';
    await db.query(`insert into auth.users (id, email, phone) values ($1, 'p', '989121112233')`, [u]);
    expect((await one<{ p: string }>(db, `select phone p from profiles where id = $1`, [u])).p).toBe('+989121112233');
    await asUser(db, OWNER, async () => {
      expect((await rows(db, `select * from audit_log where table_name = 'people'`)).length).toBeGreaterThan(0);
    });
    await asUser(db, ACCOUNTANT, async () => { expect(await rows(db, `select * from audit_log where table_name = 'people'`)).toHaveLength(0); });
  });
});

describe('round-3 findings', () => {
  it('one item with two progress reports on a stage undoes back to where it started', async () => {
    const start = (await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p;
    const x = await inboxWithDrafts([
      { kind: 'stage_progress', fields: { stage_id: frame, progress_pct: 40 } },
      { kind: 'stage_progress', fields: { stage_id: frame, progress_pct: 50 } },
    ]);
    await asUser(db, OWNER, async () => {
      await db.query(`select confirm_inbox($1, $2)`, [x.inbox, x.drafts]);
      await db.query(`select undo_inbox($1)`, [x.inbox]);
    });
    expect((await one<{ p: number }>(db, `select progress_pct p from stages where id = $1`, [frame])).p).toBe(start);
    const empty = await inboxWithDrafts([{ kind: 'stage_progress', fields: { stage_id: frame } }]);
    await asUser(db, OWNER, async () => {
      await expect(db.query(`select confirm_inbox($1, $2)`, [empty.inbox, empty.drafts])).rejects.toThrow(/percent or a status/);
    });
  });
  it('deletion time cannot be back-dated; a file\'s hider is written by the database only', async () => {
    const id = await asUser(db, OWNER, async () =>
      (await one<{ id: string }>(db, `insert into daily_notes (ledger_id, note_date, body) values ($1, current_date, 'x') returning id`, [project])).id);
    await asUser(db, OWNER, async () => { await db.query(`update daily_notes set voided_at = '2020-01-01' where id = $1`, [id]); });
    expect((await one<{ y: number }>(db, `select extract(year from voided_at)::int y from daily_notes where id = $1`, [id])).y).toBeGreaterThan(2020);
    const { media } = await inboxWithDrafts([]);
    await asUser(db, OWNER, async () => {
      await expect(db.query(`update media set hidden_by = $2 where id = $1`, [media, ACCOUNTANT])).rejects.toThrow(/permission denied/);
    });
  });
  it('a phone that is not an Iranian mobile never blocks sign-up', async () => {
    const u = '00000000-0000-4000-8000-00000000000a';
    await db.query(`insert into auth.users (id, email, phone) values ($1, 'q', '14155550100')`, [u]);
    expect(await rows(db, `select phone from profiles where id = $1 and phone is not null`, [u])).toHaveLength(0);
  });
});
