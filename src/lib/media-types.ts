// File types shared by the bots and the site, so both decide the same way what can be read.

/** Audio the speech-to-text reads → the extension it is stored with. Other audio (AMR, AAC, 3GPP …) is only archived. */
export const STT_AUDIO: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/x-opus+ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpeg3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'webm',
};

/** Photos the AI can look at. */
export const READABLE_IMAGE = /^image\/(jpeg|png|webp|gif)$/;
