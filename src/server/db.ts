// The site's own server-side access to the database and the archive (service role). Never imported by browser code:
// the key gives full access and stays on the Iranian server. Wrapped in a small interface so the request handlers can
// be tested without a database.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ServerDb {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  putFile(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  getFile(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
}

let client: SupabaseClient | null = null;
function admin(): SupabaseClient {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set');
  client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export const serverDb: ServerDb = {
  async rpc(fn, args) {
    const { data, error } = await admin().rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data as never;
  },
  async putFile(path, bytes, mime) {
    // upsert: false — an archived original is never overwritten
    const { error } = await admin().storage.from('archive').upload(path, bytes, { contentType: mime, upsert: false });
    if (error && !/exists/i.test(error.message)) throw new Error(error.message);
  },
  async getFile(path) {
    const { data, error } = await admin().storage.from('archive').download(path);
    if (error || !data) throw new Error(error?.message ?? 'file not found');
    return { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type || 'application/octet-stream' };
  },
};
