/* Gọi Gemini REST (cùng tham số với ứng dụng web) + phân loại lỗi để worker biết cách xử lý lại. */

export type ErrKind =
  | 'transient'     // 5xx, quá tải, mạng, timeout, phản hồi rỗng -> chờ rồi thử lại
  | 'quota'         // 429 -> đổi key / chờ
  | 'auth'          // key sai/bị khóa -> bỏ key đó
  | 'too_big'       // khối quá nặng, bị cắt cụt (MAX_TOKENS) -> chia đôi khối
  | 'refused'       // SAFETY / RECITATION / bị chặn -> thử lại, đổi model, chia nhỏ
  | 'bad_output'    // trả về nhưng nội dung không đạt -> thử lại
  | 'model_missing' // model không tồn tại -> dùng model dự phòng
  | 'fatal';

export class GeminiError extends Error {
  constructor(public kind: ErrKind, message: string, public status = 0, public retryAfterMs = 0) {
    super(message);
  }
}

export interface GeminiResult { text: string; inputTokens: number; outputTokens: number; }

export interface CallOpts {
  baseUrl: string;
  key: string;
  model: string;
  parts: any[];
  system?: string;
  json?: boolean;
  timeoutMs: number;
  thinking?: string;          // HIGH (như bản web) | MEDIUM | LOW | MINIMAL
}

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];
const REFUSE_REASONS = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'OTHER', 'IMAGE_SAFETY'];

/** "Please retry in 37.5s" / RetryInfo.retryDelay "37s" -> ms */
export function parseRetryDelay(err: any, msg: string): number {
  const details: any[] = err?.details || [];
  for (const d of details) {
    const m = typeof d?.retryDelay === 'string' && d.retryDelay.match(/^([\d.]+)s$/);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  }
  const m = msg.match(/retry in ([\d.]+)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

export function classifyHttp(code: number, status: string, msg: string): ErrKind {
  const s = `${status} ${msg}`;
  if (code === 429 || /RESOURCE_EXHAUSTED/.test(s)) return 'quota';
  if (code === 401 || code === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|API key expired/i.test(s)) return 'auth';
  if (code === 404 || /NOT_FOUND|is not found for API version|not supported for generateContent/i.test(s)) return 'model_missing';
  if (code === 413 || /too large|payload size|exceeds the maximum|maximum number of tokens|token count/i.test(s)) return 'too_big';
  if (code >= 500 || /UNAVAILABLE|overloaded|DEADLINE_EXCEEDED|INTERNAL/i.test(s)) return 'transient';
  if (code === 400) return 'too_big';          // INVALID_ARGUMENT với PDF thường do trang/khối lỗi -> chia nhỏ để cô lập
  return 'fatal';
}

export function stripFences(text: string): string {
  if (text.includes('```')) {
    const m = text.match(/```(?:markdown|html|xml|json)?([\s\S]*?)```/i);
    if (m && m[1]) return m[1].trim();
  }
  return text;
}

export async function callGemini(o: CallOpts): Promise<GeminiResult> {
  const body: any = {
    contents: [{ parts: o.parts }],
    generationConfig: { temperature: 0.1, thinkingConfig: { thinkingLevel: o.thinking || 'HIGH' } },
    safetySettings: SAFETY,
  };
  if (o.json) body.generationConfig.responseMimeType = 'application/json';
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };

  let res: Response;
  try {
    res = await fetch(`${o.baseUrl}/v1beta/models/${o.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },   // key trong header, không lộ ra URL/log
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e: any) {
    const what = e?.name === 'TimeoutError' ? `quá ${Math.round(o.timeoutMs / 1000)}s không phản hồi` : `lỗi mạng: ${e?.message || e}`;
    throw new GeminiError('transient', what);
  }

  if (!res.ok) {
    const d: any = await res.json().catch(() => ({}));
    const msg = String(d?.error?.message || res.statusText || '').slice(0, 400);
    const st = String(d?.error?.status || '');
    const kind = classifyHttp(res.status, st, msg);
    throw new GeminiError(kind, `HTTP ${res.status}${st ? ' ' + st : ''}: ${msg}`, res.status, parseRetryDelay(d?.error, msg));
  }

  const d: any = await res.json().catch(() => null);
  if (!d) throw new GeminiError('transient', 'phản hồi không phải JSON');
  if (d?.promptFeedback?.blockReason) throw new GeminiError('refused', `bị chặn (${d.promptFeedback.blockReason})`);
  const cand = d?.candidates?.[0];
  const finish: string = cand?.finishReason || '';
  const text = ((cand?.content?.parts || []) as any[]).filter(p => !p.thought).map(p => p.text || '').join('');
  if (finish === 'MAX_TOKENS') throw new GeminiError('too_big', 'kết quả bị cắt cụt (MAX_TOKENS)');
  if (!text.trim()) {
    if (REFUSE_REASONS.includes(finish)) throw new GeminiError('refused', `AI từ chối (${finish})`);
    throw new GeminiError('transient', `phản hồi rỗng${finish ? ' (' + finish + ')' : ''}`);
  }
  return {
    text: o.json ? text : stripFences(text),
    inputTokens: d?.usageMetadata?.promptTokenCount || 0,
    outputTokens: d?.usageMetadata?.candidatesTokenCount || 0,
  };
}
