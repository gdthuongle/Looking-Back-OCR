/* OCR một tài liệu PDF: chia khối như ứng dụng web, gọi Gemini với chiến lược xử lý lỗi tự động. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { callGemini, GeminiError, ErrKind } from './gemini';
import { buildPayload, parseProfile, Mode, DocumentStyleProfile, DEFAULT_STYLE_PROFILE } from './app-bridge';

export interface Cfg {
  baseUrl: string;
  keys: string[];
  model: string;
  fallbackModels: string[];   // model dự phòng, thử lần lượt ([] = không dùng)
  concurrency: number;        // số khối chạy song song (ứng dụng web dùng 2)
  chunkPages: number;         // tối đa trang mỗi khối (ứng dụng web: 12)
  minChunkPages?: number;     // không tự chia nhỏ hơn mức này khi gặp 503 (mặc định 3)
  maxTries: number;           // số lần thử khi lỗi tạm thời, cho MỖI model
  backoffBaseMs: number;
  backoffMaxMs: number;
  quotaWaitMs: number;        // chờ khi mọi key đều hết hạn mức mà Google không nói rõ bao lâu
  timeoutMs: number;
  thinking?: string;          // mức suy nghĩ của Gemini (bản web: HIGH)
  promptsDir: string;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ChunkState { s: number; e: number; status: 'pending' | 'done' | 'error'; raw?: string; error?: string; kind?: ErrKind;
                              running?: boolean; sec?: number; note?: string; }

const sleepReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ key & model */
const LONG_WAIT = 10 * 60_000;      // mọi key cùng hết hạn mức của 1 model lâu hơn mức này -> coi model đó tạm không dùng được

export class KeyPool {
  private until = new Map<string, number>();          // "key|model" -> hết bị chặn lúc (theo CHUỖI key, giữ được khi nạp lại)
  private bannedKeys = new Set<string>();
  private next = 0;
  modelBlocked = new Map<string, number>();            // model -> hết bị chặn lúc
  preferFallbackUntil = 0;                             // (giữ để tương thích trang theo dõi; không còn dùng để chọn model)
  busyUntil = new Map<string, number>();               // model vừa trả 503 -> tạm tránh tới lúc này
  private busyStreak = new Map<string, number>();
  lastGood = '';                                       // model vừa chạy thành công -> ưu tiên dùng tiếp
  /** Model trả 503: tạm tránh theo OCR_BACKOFF_SECONDS × 1, 2, 4… (tối đa OCR_BACKOFF_MAX_SECONDS). */
  markBusy(m: string) {
    const n = (this.busyStreak.get(m) || 0) + 1;
    this.busyStreak.set(m, n);
    this.busyUntil.set(m, Date.now() + Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (n - 1)));
  }
  markOk(m: string) { this.busyStreak.delete(m); this.busyUntil.delete(m); this.lastGood = m; }
  isBusy(m: string) { return (this.busyUntil.get(m) || 0) > Date.now(); }
  usage: Record<string, Record<string, number>> = {};  // ngày (giờ Mỹ, Google tính hạn mức theo đó) -> model -> số lần gọi
  static day() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
  record(model: string) {
    const d = KeyPool.day();
    for (const k of Object.keys(this.usage)) if (k !== d) delete this.usage[k];
    (this.usage[d] ??= {})[model] = (this.usage[d][model] || 0) + 1;
  }
  used(model: string) { return this.usage[KeyPool.day()]?.[model] || 0; }
  constructor(private keys: string[], private cfg: Cfg) {}
  private get banned() { return this.keys.map(k => this.bannedKeys.has(k)); }
  get usable() { return this.keys.some(k => !this.bannedKeys.has(k)); }
  get count() { return this.keys.length; }
  private cooled(i: number, model: string) { return this.until.get(`${this.keys[i]}|${model}`) || 0; }
  /** Nạp lại danh sách key khi đang chạy. Key mới (vd project khác) có hạn mức riêng -> mở lại các model đang bị chặn. */
  setKeys(keys: string[]) {
    const added = keys.filter(k => !this.keys.includes(k));
    this.keys = keys;
    this.next = 0;
    for (const k of keys) if (added.includes(k)) this.bannedKeys.delete(k);
    if (added.length) { this.modelBlocked.clear(); this.preferFallbackUntil = 0; }
    return added.length;
  }
  /** Thời điểm sớm nhất có key dùng được cho model (0 = ngay). */
  soonest(model: string) {
    const t = this.keys.map((_, i) => i).filter(i => !this.banned[i]).map(i => this.cooled(i, model));
    return t.length ? Math.min(...t) : Infinity;
  }
  /** Lấy key còn dùng được cho model (xoay vòng); nếu tất cả đang bị chặn hạn mức thì chờ. */
  async acquire(model: string): Promise<number> {
    for (;;) {
      if (!this.usable) throw new GeminiError('auth', 'không còn API key hợp lệ nào');
      const now = Date.now();
      for (let k = 0; k < this.keys.length; k++) {
        const i = (this.next + k) % this.keys.length;
        if (!this.banned[i] && this.cooled(i, model) <= now) {
          this.next = (i + 1) % this.keys.length;
          return i;
        }
      }
      const wait = Math.max(1000, this.soonest(model) - now);
      if (wait > LONG_WAIT) {                       // chờ quá lâu: báo để chuyển model khác thay vì treo
        this.blockModel(model, wait);
        throw new GeminiError('model_missing', `${model}: hết hạn mức trên mọi key (${Math.round(wait / 60000)} phút)`);
      }
      this.cfg.log(`⏳ mọi key đều hết hạn mức ${model}, chờ ${Math.round(wait / 1000)}s`);
      await (this.cfg.sleep || sleepReal)(wait);
    }
  }
  key(i: number) { return this.keys[i]; }
  cool(i: number, model: string, ms: number) { this.until.set(`${this.keys[i]}|${model}`, Date.now() + ms); }
  ban(i: number) { this.bannedKeys.add(this.keys[i]); }
  modelOk(m: string) { return (this.modelBlocked.get(m) || 0) <= Date.now(); }
  blockModel(m: string, ms: number) { this.modelBlocked.set(m, Date.now() + ms); }
  /** Model nên dùng lúc này: chính, hoặc dự phòng nếu chính đang bị chặn / vừa quá tải. */
  get models() { return [this.cfg.model, ...this.cfg.fallbackModels.filter(m => m && m !== this.cfg.model)]; }
  /** Model nên dùng: model vừa chạy tốt, rồi theo thứ tự cấu hình; bỏ qua model hết lượt hoặc đang quá tải. */
  pick(exclude: Set<string> = new Set()): string | null {
    const order = this.lastGood && this.models.includes(this.lastGood)
      ? [this.lastGood, ...this.models.filter(m => m !== this.lastGood)] : this.models;
    return order.find(m => !exclude.has(m) && this.modelOk(m) && !this.isBusy(m)) || null;
  }
  /** Chờ tới khi có model dùng được (chỉ chờ khi MỌI model đều hết lượt hoặc đang quá tải). */
  async pickWait(exclude: Set<string> = new Set()): Promise<string> {
    for (;;) {
      const m = this.pick(exclude);
      if (m) return m;
      const cand = this.models.filter(x => !exclude.has(x) && this.modelOk(x));
      if (!cand.length && exclude.size) return this.pickWait();             // mọi model còn lại đều bị loại: bỏ loại trừ
      const ts = cand.length ? cand.map(x => this.busyUntil.get(x) || 0) : this.models.map(x => this.modelBlocked.get(x) || 0);
      const wait = Math.max(5000, Math.min(...ts) - Date.now());
      this.cfg.log(`⏳ mọi model đều ${cand.length ? 'đang quá tải' : 'hết lượt'}, chờ ${wait >= 120_000 ? Math.round(wait / 60000) + ' phút' : Math.round(wait / 1000) + 's'}`);
      await (this.cfg.sleep || sleepReal)(wait);
    }
  }
}

/* ------------------------------------------------------------------ chia khối (giống pdf-processor.ts) */
export function makeChunks(numPages: number, maxPages = 12): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  const divide = (s: number, e: number) => {
    const n = e - s + 1;
    if (n <= 0) return;
    if (n <= maxPages) { out.push({ s, e }); return; }
    const mid = Math.floor(n / 2);
    divide(s, s + mid - 1);
    divide(s + mid, e);
  };
  divide(1, numPages);
  return out;
}

export async function slicePdf(src: PDFDocument, s: number, e: number): Promise<string> {
  const sub = await PDFDocument.create();
  const idx = Array.from({ length: e - s + 1 }, (_, k) => s - 1 + k);
  (await sub.copyPages(src, idx)).forEach(p => sub.addPage(p));
  return Buffer.from(await sub.save()).toString('base64');
}

const REFUSAL = /^(tôi (không thể|xin lỗi|rất tiếc)|xin lỗi|i('m| am) sorry|i can(no|')t|sorry,)/i;

/** Phát hiện kết quả hỏng dù API báo thành công. */
export function validateOutput(text: string, s: number, e: number, mode: Mode): string | null {
  const t = text.trim();
  if (!t) return 'kết quả rỗng';
  if (REFUSAL.test(t) && t.length < 600) return `AI trả lời thay vì OCR: "${t.slice(0, 80)}"`;
  if (mode === 'html' && e > s && !/PAGE_BREAK:\s*\d+/.test(t)) return 'thiếu dấu ngắt trang (PAGE_BREAK)';
  return null;
}

/* ------------------------------------------------------------------ OCR 1 dải trang, tự xử lý lỗi */
export class Ocr {
  maxPages: number;                 // cỡ khối tối đa cho file này; tự giảm khi khối lớn bị 503 lặp lại
  constructor(public cfg: Cfg, public pool: KeyPool, public mode: Mode) { this.maxPages = cfg.chunkPages; }
  private prompt(name: string) { return readFileSync(join(this.cfg.promptsDir, name), 'utf8'); }
  private get sleep() { return this.cfg.sleep || sleepReal; }

  backoff(n: number) {
    const b = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (n - 1));
    return Math.round(b * (0.8 + Math.random() * 0.4));
  }

  /** Gọi Gemini có xoay key + chờ hạn mức (không tính là lần thử). */
  private async call(model: string, parts: any[], system: string, json = false) {
    for (;;) {
      const i = await this.pool.acquire(model);
      this.pool.record(model);
      try {
        return await callGemini({ baseUrl: this.cfg.baseUrl, key: this.pool.key(i), model, parts, system, json,
                                  timeoutMs: this.cfg.timeoutMs, thinking: this.cfg.thinking });
      } catch (e: any) {
        if (e instanceof GeminiError && e.kind === 'quota') {
          const zero = /limit:\s*0\b/.test(e.message);                   // key không được dùng model này (vd Pro với key miễn phí)
          const perDay = /per.?day|PerDay|daily/i.test(e.message);
          const ms = zero ? 24 * 3600_000 : e.retryAfterMs || (perDay ? 3600_000 : this.cfg.quotaWaitMs);
          this.cfg.log(`🔁 key #${i + 1} ${zero ? 'không có hạn mức' : 'hết hạn mức' + (perDay ? ' trong ngày' : '')} cho ${model}` +
                       `, tạm nghỉ ${ms >= 3600_000 ? Math.round(ms / 3600_000) + ' giờ' : Math.round(ms / 1000) + 's'}`);
          this.pool.cool(i, model, ms);
          const wait = this.pool.soonest(model) - Date.now();
          if (wait > LONG_WAIT) {
            this.pool.blockModel(model, wait);
            throw new GeminiError('model_missing', `${model}: hết hạn mức trên mọi key (${Math.round(wait / 60000)} phút)`);
          }
          continue;
        }
        if (e instanceof GeminiError && e.kind === 'auth') {
          this.cfg.log(`🚫 key #${i + 1} không hợp lệ (${e.message.slice(0, 120)}), bỏ key này`);
          this.pool.ban(i);
          continue;
        }
        if (e instanceof GeminiError && e.kind === 'model_missing') this.pool.blockModel(model, 24 * 3600_000);
        throw e;
      }
    }
  }

  async ocrRange(src: PDFDocument, s: number, e: number, profile: DocumentStyleProfile | null, label: string): Promise<string> {
    const cfg = this.cfg;
    const promptName = this.mode === 'html' ? 'html_reflow_instructions.md' : 'markdown_reflow_instructions.md';
    let model = await this.pool.pickWait(), tries = 0, odd = 0, total = 0;
    const split = async (why: string) => {
      const mid = Math.floor((s + e) / 2);
      if (why) cfg.log(`✂️  ${label} trang ${s}-${e}: ${why} -> chia đôi (${s}-${mid} | ${mid + 1}-${e})`);
      const a = await this.ocrRange(src, s, mid, profile, label);
      const b = await this.ocrRange(src, mid + 1, e, profile, label);
      return `${a}\n${b}`;
    };
    const exhausted = new Set<string>();                         // model đã thử hết lượt cho dải trang này
    const switchModel = (why: string) => {
      exhausted.add(model);
      const to = this.pool.models.find(m => !exhausted.has(m) && this.pool.modelOk(m));
      if (!to) return false;
      cfg.log(`🔀 ${label} trang ${s}-${e}: ${why} -> đổi sang ${to}`);
      model = to; tries = 0;
      return true;
    };

    if (e - s + 1 > this.maxPages) return split('');           // file này cần khối nhỏ (đã học từ lỗi trước)

    for (;;) {
      try {
        const { parts, system } = buildPayload(await slicePdf(src, s, e), this.prompt(promptName), s, e, this.mode, profile);
        const r = await this.call(model, parts, system);
        const bad = validateOutput(r.text, s, e, this.mode);
        if (bad) throw new GeminiError('bad_output', bad);
        this.pool.markOk(model);
        return r.text;
      } catch (err: any) {
        const g = err instanceof GeminiError ? err : new GeminiError('transient', `${err?.name || 'Error'}: ${err?.message || err}`);
        cfg.log(`⚠️  ${label} trang ${s}-${e} [${model}]: ${g.kind} — ${g.message.slice(0, 200)}`);
        if (g.kind === 'auth') throw g;
        switch (g.kind) {
          case 'transient': {
            tries++; total++;
            this.pool.markBusy(model);
            const minP = cfg.minChunkPages ?? 3;
            if (e - s + 1 > minP && tries >= 3) {                       // khối lớn bị 503 lặp lại: gửi nhỏ hơn hiệu quả hơn chờ
              this.maxPages = Math.max(minP, Math.min(this.maxPages, Math.ceil((e - s + 1) / 2)));
              cfg.log(`📉 từ giờ dùng khối tối đa ${this.maxPages} trang cho file này`);
              return split(`${g.message.slice(0, 40)}… lặp lại với khối ${e - s + 1} trang`);
            }
            if (total >= cfg.maxTries * this.pool.models.length) throw g;    // đã thử đủ nhiều trên mọi model
            const next = await this.pool.pickWait();                         // đổi ngay sang model khác đang rảnh
            if (next !== model) cfg.log(`🔀 ${label} trang ${s}-${e}: ${model} quá tải -> ${next}`);
            model = next;
            continue;
          }
          case 'too_big':
            if (e > s) return split(g.message);
            if (++odd <= 1) continue;
            if (switchModel(g.message)) { odd = 0; continue; }
            throw g;
          case 'refused':
          case 'bad_output':
            if (++odd <= 1) { await this.sleep(this.backoff(1)); continue; }   // thử lại 1 lần với cùng model
            if (switchModel(g.message)) { odd = 0; continue; }
            if (e > s) return split(g.message);
            throw g;
          case 'model_missing':
            if (switchModel(g.message)) continue;
            if (this.pool.models.some(m => !exhausted.has(m))) {      // mọi model còn lại tạm bị chặn hạn mức: chờ, không bỏ cuộc
              model = await this.pool.pickWait(); tries = 0;
              continue;
            }
            throw g;
          default:
            throw g;
        }
      }
    }
  }

  /** Phân tích hồ sơ thiết kế từ 3 khối mẫu như ứng dụng; lỗi -> mặc định (có ghi log, không âm thầm). */
  async styleProfile(src: PDFDocument, chunks: { s: number; e: number }[]): Promise<DocumentStyleProfile> {
    const n = chunks.length;
    const idx = n <= 3 ? chunks.map((_, i) => i) : n === 4 ? [0, 1, 2] : [0, Math.floor(n / 2), Math.floor(n / 2) + 1];
    let use = idx, model = await this.pool.pickWait();
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const parts: any[] = [];
        for (const i of use) parts.push({ inlineData: { mimeType: 'application/pdf', data: await slicePdf(src, chunks[i].s, chunks[i].e) } });
        parts.push({ text: 'Hãy phân tích phong cách thiết kế của tài liệu này.' });
        const r = await this.call(model, parts, this.prompt('style_analysis_instructions.md'), true);
        const p = parseProfile(r.text, use);
        this.cfg.log(`🎨 hồ sơ thiết kế: ${p.styleArchetype}, ${p.bodyFont} ${p.bodyFontSize} / ${p.headingFont}`);
        return p;
      } catch (err: any) {
        const kind = err instanceof GeminiError ? err.kind : 'bad_output';
        if (kind === 'auth') throw err;                                           // key sai: dừng ngay, không đoán mặc định
        this.cfg.log(`⚠️  phân tích thiết kế lần ${attempt} [${model}]: ${kind} — ${String(err?.message || err).slice(0, 160)}`);
        if (kind === 'too_big' && use.length > 1) { use = [use[0]]; continue; }   // mẫu quá nặng -> chỉ lấy khối đầu
        const alt = this.pool.models.find(m => m !== model && this.pool.modelOk(m));
        if (alt && (attempt >= 2 || kind === 'model_missing')) { model = alt; continue; }   // quá tải 2 lần -> thử model kia
        if (kind === 'model_missing') model = await this.pool.pickWait();
        if (attempt < 4) await this.sleep(this.backoff(attempt));
      }
    }
    this.cfg.log('🎨 dùng hồ sơ thiết kế mặc định');
    return { ...DEFAULT_STYLE_PROFILE, analyzedAt: Date.now() } as DocumentStyleProfile;
  }
}

/** Chạy các khối còn dang dở với số luồng giới hạn; gọi onDone sau MỖI khối để lưu tiến độ. */
export async function runChunks(ocr: Ocr, src: PDFDocument, chunks: ChunkState[], profile: DocumentStyleProfile | null,
                                onDone: () => void): Promise<void> {
  const todo = chunks.map((c, i) => i).filter(i => chunks[i].status !== 'done');
  let cursor = 0, aborted = false;
  const workers = Array.from({ length: Math.min(ocr.cfg.concurrency, todo.length) }, async () => {
    while (cursor < todo.length && !aborted) {
      const i = todo[cursor++];
      const c = chunks[i];
      const label = `Phần ${i + 1}/${chunks.length}`;
      const t0 = Date.now();
      c.running = true; c.note = undefined;
      onDone();
      try {
        c.raw = await ocr.ocrRange(src, c.s, c.e, profile, label);
        c.status = 'done'; c.error = undefined; c.kind = undefined; c.sec = Math.round((Date.now() - t0) / 1000);
        ocr.cfg.log(`✅ ${label} (trang ${c.s}-${c.e}) xong sau ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (err: any) {
        c.status = 'error';
        c.kind = err instanceof GeminiError ? err.kind : 'fatal';
        c.error = String(err?.message || err).slice(0, 300);
        ocr.cfg.log(`❌ ${label} (trang ${c.s}-${c.e}) bỏ cuộc: ${c.error}`);
        if (c.kind === 'auth') { aborted = true; throw err; }   // hết key hợp lệ: dừng cả file
      } finally {
        c.running = false;
        onDone();
      }
    }
  });
  const res = await Promise.allSettled(workers);              // đợi mọi luồng dừng hẳn rồi mới báo
  const bad = res.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (bad) throw bad.reason;
}
