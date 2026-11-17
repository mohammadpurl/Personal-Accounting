// The network side of the AI, used only on the relay server abroad (never in the Iranian site):
// speech-to-text behind one interface so providers can be compared on real voices and swapped, and the
// extraction call (OpenAI structured output). Keys and model names come from the environment.
import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { buildInstructions, ExtractionSchema, PROMPT_VERSION, type ExtractContext, type Extraction } from './extract';

export interface Transcript { text: string; provider: string; model: string; ms: number }
export interface SpeechToText {
  name: string;
  transcribe(audio: Uint8Array, opts: { filename: string; keywords?: string[]; prompt?: string }): Promise<Transcript>;
}

/** OpenAI speech-to-text (default model gpt-transcribe; set STT_MODEL to try gpt-4o-transcribe or whisper-1). */
export function openAiStt(client: OpenAI, model = process.env.STT_MODEL || 'gpt-transcribe'): SpeechToText {
  return {
    name: `openai:${model}`,
    async transcribe(audio, { filename, keywords, prompt }) {
      const t0 = Date.now();
      const supportsHints = model === 'gpt-transcribe';
      const r = await client.audio.transcriptions.create({
        file: await toFile(audio, filename),
        model,
        prompt,
        ...(supportsHints ? { languages: ['fa'], keywords: keywords?.slice(0, 100) } : { language: 'fa' }),
      });
      return { text: r.text.trim(), provider: 'openai', model, ms: Date.now() - t0 };
    },
  };
}

/** Words the speech model should expect: names of people, accounts and stages, and common site words. */
export function sttKeywords(ctx: ExtractContext): string[] {
  const site = ['تنخواه', 'کارت به کارت', 'پایا', 'ساتنا', 'چک', 'صیادی', 'سررسید', 'آرماتوربندی', 'قالب‌بندی', 'بتن‌ریزی', 'صورت‌جلسه', 'ناظر'];
  return [...new Set([...ctx.people.map((p) => p.name), ...ctx.accounts.map((a) => a.name), ...ctx.stages.map((s) => s.name), ...site])]
    .filter((k) => k && !/[<>\r\n]/.test(k));
}

export interface ExtractInput { text?: string; imageDataUrl?: string; context: ExtractContext }

/** One call to the model: the instructions, then the text and/or image; the answer is parsed against the schema. */
export async function extractWithOpenAI(client: OpenAI, input: ExtractInput, model = process.env.AI_MODEL || 'gpt-6-astra'): Promise<{ out: Extraction; model: string; promptVersion: string }> {
  const content: OpenAI.Responses.ResponseInputContent[] = [];
  if (input.text) content.push({ type: 'input_text', text: input.text });
  if (input.imageDataUrl) content.push({ type: 'input_image', image_url: input.imageDataUrl, detail: 'high' });
  if (!content.length) throw new Error('nothing to read');
  const r = await client.responses.parse({
    model,
    input: [
      { role: 'system', content: buildInstructions(input.context) },
      { role: 'user', content },
    ],
    text: { format: zodTextFormat(ExtractionSchema, 'site_records') },
    store: false, // what is said on site is not kept by the provider
  });
  if (!r.output_parsed) throw new Error('the model returned no records');
  return { out: r.output_parsed, model, promptVersion: PROMPT_VERSION };
}
