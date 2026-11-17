// Compare speech-to-text models on your own voice notes before choosing one.
//   1. Put voice files in a folder, e.g. samples/voices/ (ogg, mp3, m4a, wav).
//   2. Optionally, next to each, a .txt with what was really said (same name: v1.ogg + v1.txt) — then an error rate is shown.
//   3. OPENAI_API_KEY=… npx tsx scripts/stt-eval.ts samples/voices gpt-transcribe gpt-4o-transcribe whisper-1
// Prints, per voice and model, the text, the time it took and the character error rate (lower is better).
// The voices are sent to the provider only when you run this script yourself.
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import OpenAI from 'openai';
import { openAiStt } from '../src/lib/ai/providers';
import { normFa } from '../src/lib/text';

/** Character error rate on normalised Persian (spaces and punctuation ignored). */
export function cer(ref: string, hyp: string): number {
  const clean = (s: string) => [...normFa(s).replace(/[\s.,،؛:!؟?«»"()-]/g, '')];
  const a = clean(ref), b = clean(hyp);
  if (!a.length) return b.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

async function main() {
  const [dir, ...models] = process.argv.slice(2);
  if (!dir || !existsSync(dir)) throw new Error('usage: tsx scripts/stt-eval.ts <folder> [model …]');
  const client = new OpenAI();
  const providers = (models.length ? models : ['gpt-transcribe', 'gpt-4o-transcribe']).map((m) => openAiStt(client, m));
  const voices = readdirSync(dir).filter((f) => ['.ogg', '.oga', '.mp3', '.m4a', '.wav', '.webm'].includes(extname(f).toLowerCase()));
  const rows: string[] = ['voice\tmodel\tseconds\tCER\ttext'];
  const totals = new Map<string, { cer: number; n: number; ms: number }>();
  for (const v of voices) {
    const refPath = join(dir, `${basename(v, extname(v))}.txt`);
    const ref = existsSync(refPath) ? readFileSync(refPath, 'utf8') : null;
    const bytes = new Uint8Array(readFileSync(join(dir, v)));
    for (const p of providers) {
      try {
        const t = await p.transcribe(bytes, { filename: v });
        const e = ref ? cer(ref, t.text) : NaN;
        const s = totals.get(p.name) ?? { cer: 0, n: 0, ms: 0 };
        totals.set(p.name, { cer: s.cer + (Number.isNaN(e) ? 0 : e), n: s.n + (Number.isNaN(e) ? 0 : 1), ms: s.ms + t.ms });
        rows.push(`${v}\t${p.name}\t${(t.ms / 1000).toFixed(1)}\t${Number.isNaN(e) ? '-' : (e * 100).toFixed(1) + '%'}\t${t.text}`);
      } catch (err) {
        rows.push(`${v}\t${p.name}\t-\t-\tERROR ${(err as Error).message}`);
      }
    }
  }
  rows.push('', 'model\tavg CER\ttotal seconds');
  for (const [name, s] of totals) rows.push(`${name}\t${s.n ? ((s.cer / s.n) * 100).toFixed(1) + '%' : '-'}\t${(s.ms / 1000).toFixed(1)}`);
  const out = join(dir, 'stt-results.tsv');
  writeFileSync(out, rows.join('\n'), 'utf8');
  console.log(rows.join('\n'));
  console.log(`\nsaved: ${out}`);
}

if (process.argv[1]?.includes('stt-eval')) main().catch((e) => { console.error(e.message); process.exit(1); });
