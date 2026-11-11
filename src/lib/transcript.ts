// A voice transcript is plain text with some spans highlighted (what the AI used for the cards).
// It is kept as parts, never as HTML, so nothing in what someone said can run in the page.
export type TranscriptPart = string | { hl: string };

/** Turns «text <mark>highlight</mark> text» into parts. Only <mark> is understood; everything else stays text. */
export function parseMarked(s: string): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) parts.push(s.slice(at, m.index));
    if (m[1]) parts.push({ hl: m[1] });
    at = m.index + m[0].length;
  }
  if (at < s.length) parts.push(s.slice(at));
  return parts;
}

export const transcriptText = (parts: TranscriptPart[]) => parts.map((p) => (typeof p === 'string' ? p : p.hl)).join('');
