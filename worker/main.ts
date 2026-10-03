/* Worker OCR tự động:
   input/*.pdf|jpg|png       -> OCR kiểu "Bảo toàn" -> output/<tên>.html
   input/docx/*.pdf|jpg|png  -> OCR kiểu "DOCX"     -> output/<tên>.docx + .md
   Xong: file gốc -> input/daocr/. Lỗi: -> input/loi/ (+ <tên>.loi.txt), tự thử lại sau.
   Tiến độ lưu theo từng khối trong .ocr-state/: dừng/khởi động lại sẽ làm tiếp, không tốn lại lượt. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Cfg, ChunkState, KeyPool, makeChunks, Ocr, pageImgComment, pageImgKey, renderPagePng, runChunks } from './pipeline';
import { GeminiError, ErrKind } from './gemini';
import { DocumentStyleProfile, generateHtmlDocument, markdownToDocx, MarkdownRenderer, Mode } from './app-bridge';

export interface Dirs { root: string; input: string; docxIn: string; done: string; failed: string; output: string; state: string; }

export function dirsFor(root: string): Dirs {
  const input = join(root, 'input');
  return { root, input, docxIn: join(input, 'docx'), done: join(input, 'daocr'), failed: join(input, 'loi'),
           output: join(root, 'output'), state: join(root, '.ocr-state') };
}

interface FileState {
  name: string; size: number; mode: Mode; pages: number;
  chunks: ChunkState[]; profile?: DocumentStyleProfile | null;
  fails: number; lastFail?: number; lastKind?: ErrKind; created: number;
  skipped?: { s: number; e: number; why: string }[];
}

const EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const LEVELS: Record<string, string> = { L: 'LOW', M: 'MEDIUM', H: 'HIGH' };

/** Tiền tố chọn mức suy nghĩ: "M-sach.pdf" -> MEDIUM. Không có tiền tố -> null (dùng OCR_THINKING). */
export function levelFromName(name: string): string | null {
  const m = name.match(/^([LMH])[-_ ]/i);
  return m ? LEVELS[m[1].toUpperCase()] : null;
}
/** Tên tài liệu khi xuất kết quả: bỏ đuôi và tiền tố chọn mức. */
export function docTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/^[LMH][-_ ]/i, '') || name;
}
const RETRYABLE: ErrKind[] = ['transient', 'quota', 'too_big', 'bad_output', 'model_missing'];

export class Worker {
  pool: KeyPool;
  private seen = new Map<string, string>();     // path -> "size:mtime" lần quét trước (đợi file chép xong)
  recent: string[] = [];                        // nhật ký gần nhất cho trang theo dõi
  current: { st: FileState; started: number } | null = null;
  headline = 'Đang khởi động';
  constructor(public cfg: Cfg, public d: Dirs, public opts = { stableMs: 10_000, retryFailedMs: 2 * 3600_000, maxFileRetries: 3 }) {
    for (const p of [d.input, d.docxIn, d.done, d.failed, d.output, d.state]) mkdirSync(p, { recursive: true });
    const orig = cfg.log;
    cfg.log = (m: string) => {
      orig(m);
      this.recent.push(`${new Date().toLocaleTimeString('vi-VN', { hour12: false })}  ${m}`);
      if (this.recent.length > 60) this.recent.shift();
      this.renderStatus();
    };
    this.pool = new KeyPool(cfg.keys, cfg);
    try { this.pool.usage = JSON.parse(readFileSync(join(d.state, 'usage.json'), 'utf8')); } catch { /* chưa có */ }
  }

  /* ---------------------------------------------------------------- quét thư mục */
  /** File đã chép xong: kích thước + mtime không đổi giữa 2 lần quét và đủ "cũ". */
  ready(): { path: string; mode: Mode }[] {
    const out: { path: string; mode: Mode; mtime: number }[] = [];
    for (const [dir, mode] of [[this.d.input, 'html'], [this.d.docxIn, 'docx']] as [string, Mode][]) {
      for (const n of readdirSync(dir)) {
        if (n.startsWith('.') || n.startsWith('~') || !EXT.has(extname(n).toLowerCase())) continue;
        const p = join(dir, n);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        const sig = `${st.size}:${st.mtimeMs}`;
        const prev = this.seen.get(p);
        this.seen.set(p, sig);
        if (prev === sig && Date.now() - st.mtimeMs >= this.opts.stableMs && st.size > 0) out.push({ path: p, mode, mtime: st.mtimeMs });
      }
    }
    return out.sort((a, b) => a.mtime - b.mtime);
  }

  /** Đưa file trong input/loi/ về hàng đợi khi lỗi thuộc loại tạm thời và đã đủ thời gian chờ. */
  requeueFailed() {
    for (const n of readdirSync(this.d.failed)) {
      if (!EXT.has(extname(n).toLowerCase())) continue;
      const p = join(this.d.failed, n);
      const st = this.loadState(n, statSync(p).size);
      if (!st || !st.lastKind || !RETRYABLE.includes(st.lastKind) || st.fails >= this.opts.maxFileRetries) continue;
      if (Date.now() - (st.lastFail || 0) < this.opts.retryFailedMs * st.fails) continue;
      const back = st.mode === 'docx' ? this.d.docxIn : this.d.input;
      this.cfg.log(`🔁 thử lại tự động ${n} (lần ${st.fails + 1}/${this.opts.maxFileRetries})`);
      renameSync(p, join(back, n));
    }
  }

  /* ---------------------------------------------------------------- trạng thái */
  stateId(name: string, size: number) { return createHash('sha1').update(`${name}\0${size}`).digest('hex').slice(0, 16); }
  statePath(name: string, size: number) { return join(this.d.state, `${this.stateId(name, size)}.json`); }
  loadState(name: string, size: number): FileState | null {
    try { return JSON.parse(readFileSync(this.statePath(name, size), 'utf8')); } catch { return null; }
  }
  saveState(st: FileState) {
    const p = this.statePath(st.name, st.size);
    writeFileSync(p + '.tmp', JSON.stringify(st));
    renameSync(p + '.tmp', p);
  }

  status(headline: string) {
    this.headline = headline;
    this.renderStatus();
  }

  /** Thông tin file lỗi: lý do + lần tự thử lại kế tiếp. */
  failedInfo() {
    const out: { name: string; why: string; next: string }[] = [];
    for (const n of readdirSync(this.d.failed)) {
      if (!EXT.has(extname(n).toLowerCase())) continue;
      let why = '', next = 'không tự thử lại — chép về input/ để chạy lại';
      try { why = readFileSync(join(this.d.failed, n.replace(/\.[^.]+$/, '') + '.loi.txt'), 'utf8').split('\n').slice(1, 3).join(' ').trim(); } catch { /* */ }
      const st = this.loadState(n, statSync(join(this.d.failed, n)).size);
      if (st?.lastKind && RETRYABLE.includes(st.lastKind) && st.fails < this.opts.maxFileRetries) {
        next = `tự thử lại lúc ${new Date((st.lastFail || 0) + this.opts.retryFailedMs * st.fails).toLocaleString('vi-VN', { hour12: false })}` +
               ` (lần ${st.fails + 1}/${this.opts.maxFileRetries})`;
      }
      out.push({ name: n, why, next });
    }
    return out;
  }

  queued() {
    const q: string[] = [];
    for (const [dir, tag] of [[this.d.input, ''], [this.d.docxIn, ' (DOCX)']] as [string, string][]) {
      for (const n of readdirSync(dir)) if (EXT.has(extname(n).toLowerCase())) q.push(n + tag);
    }
    return q.filter(n => n.replace(' (DOCX)', '') !== this.current?.st.name);
  }

  /** Ghi output/_trangthai.txt + output/_trangthai.html (trang web tự làm mới, xem qua http://<máy>:8095/ocr/). */
  renderStatus() {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const now = new Date().toLocaleString('vi-VN', { hour12: false });
    const txt: string[] = [now, this.headline];
    let cur = '';
    const data: any = { updated: Date.now(), headline: this.headline, current: null };
    try {
      if (this.current) {
        const { st, started } = this.current;
        const ok = st.chunks.filter(c => c.status === 'done').length, n = st.chunks.length;
        const run = st.chunks.filter(c => c.running).length;
        const bad = st.chunks.filter(c => c.status === 'error' && !c.running).length;
        const secs = st.chunks.map(c => c.sec || 0).filter(Boolean);
        const left = n - ok - bad;
        const eta = secs.length && left ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length * left / Math.max(1, this.cfg.concurrency) / 60) : null;
        const pct = Math.round(ok / n * 100);
        data.current = { name: st.name, pages: st.pages, mode: st.mode, thinking: levelFromName(st.name) || this.cfg.thinking, started, ok, total: n, bad, running: run, pct, etaMin: eta,
          chunks: st.chunks.map((c, i) => ({ part: i + 1, s: c.s, e: c.e, sec: c.sec || 0,
            status: c.running ? 'running' : c.status, error: c.status === 'error' ? c.error || '' : '' })) };
        txt.push(`File: ${st.name} — ${st.pages} trang, xong ${ok}/${n} phần (${pct}%)${bad ? `, lỗi ${bad}` : ''}` +
                 (eta !== null ? `, còn khoảng ${eta} phút` : ''));
        const rows = st.chunks.map((c, i) => {
          const s = c.running ? '⏳ đang làm' : c.status === 'done' ? `✅ xong${c.sec ? ` (${c.sec}s)` : ''}` : c.status === 'error' ? '❌ lỗi' : '▫️ chờ';
          txt.push(`  Phần ${i + 1} (trang ${c.s}-${c.e}): ${s}${c.error && c.status === 'error' ? ' — ' + c.error : ''}`);
          return `<tr class="${c.running ? 'run' : c.status}"><td>Phần ${i + 1}</td><td>${c.s}–${c.e}</td><td>${s}</td><td>${c.status === 'error' ? esc(c.error || '') : ''}</td></tr>`;
        }).join('');
        cur = `<h2>Đang xử lý: ${esc(st.name)}</h2>
<p>${st.pages} trang · ${n} phần · kiểu ${st.mode === 'html' ? 'Bảo toàn (HTML)' : 'DOCX'} · bắt đầu ${new Date(started).toLocaleTimeString('vi-VN', { hour12: false })}
${run ? ` · ${run} phần đang chạy` : ''}${eta !== null ? ` · <b>còn khoảng ${eta} phút</b>` : ''}</p>
<div class="bar"><div style="width:${pct}%"></div></div><p class="muted">${ok}/${n} phần (${pct}%)${bad ? ` · <span class="err">${bad} phần lỗi</span>` : ''}</p>
<table><tr><th>Phần</th><th>Trang</th><th>Trạng thái</th><th>Lỗi</th></tr>${rows}</table>`;
      }
      const q = this.queued(), f = this.failedInfo();
      try { writeFileSync(join(this.d.state, 'usage.json'), JSON.stringify(this.pool.usage)); } catch { /* */ }
      const quota = this.pool.models.map(m => {
        const until = this.pool.modelBlocked.get(m) || 0;
        const st = until > Date.now() ? `❌ hết lượt, mở lại lúc ${new Date(until).toLocaleString('vi-VN', { hour12: false })}`
          : this.pool.preferFallbackUntil > Date.now() && m === this.cfg.model ? '⏸ tạm tránh (vừa quá tải)' : '✅ dùng được';
        return { m, n: this.pool.used(m), st };
      });
      txt.push('Hạn mức hôm nay: ' + quota.map(x => `${x.m} ${x.n} lần (${x.st})`).join('; '));
      const outs = readdirSync(this.d.output).filter(n => !n.startsWith('_') && !n.startsWith('.'))
        .map(n => ({ n, t: statSync(join(this.d.output, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 15);
      txt.push(`Hàng đợi: ${q.length ? q.join(', ') : 'trống'}`);
      Object.assign(data, { queue: q, failed: f, quota, outputs: outs.map(o => ({ name: o.n, mtime: o.t })), log: this.recent.slice().reverse() });
      writeFileSync(join(this.d.output, '._trangthai.json.tmp'), JSON.stringify(data));
      renameSync(join(this.d.output, '._trangthai.json.tmp'), join(this.d.output, '_trangthai.json'));
      for (const x of f) txt.push(`Lỗi: ${x.name} — ${x.why} — ${x.next}`);
      writeFileSync(join(this.d.output, '_trangthai.txt'), txt.join('\n') + '\n');
      const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>OCR tự động</title><style>
:root{--bg:#f8fafc;--fg:#0f172a;--card:#fff;--line:#e2e8f0;--muted:#64748b;--ok:#16a34a;--err:#dc2626;--run:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--card:#111827;--line:#1f2937;--muted:#94a3b8}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:auto}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0;overflow-x:auto}
h1{font-size:20px;margin:4px 0}h2{font-size:17px;margin:0 0 8px}.muted{color:var(--muted)}.err{color:var(--err)}
.bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden}.bar div{height:100%;background:var(--ok)}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
tr.run td{color:var(--run);font-weight:600}tr.error td{color:var(--err)}pre{white-space:pre-wrap;font-size:12.5px;margin:0}a{color:var(--run)}
</style></head><body><main>
<h1>OCR tự động</h1><p class="muted">Cập nhật ${now} · tự làm mới mỗi 10 giây</p>
<section><b>${esc(this.headline)}</b></section>
${cur ? `<section>${cur}</section>` : ''}
<section><h2>Model &amp; hạn mức hôm nay</h2><p class="muted">Key miễn phí: khoảng 20 lần gọi/ngày cho MỖI model (lần bị 503 cũng tính). Thử lần lượt từ trên xuống.</p>
<table><tr><th>Model</th><th>Đã gọi hôm nay</th><th>Trạng thái</th></tr>${quota.map(x => `<tr><td>${esc(x.m)}</td><td>${x.n}</td><td>${esc(x.st)}</td></tr>`).join('')}</table></section>
<section><h2>Hàng đợi (${q.length})</h2>${q.length ? `<ol>${q.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="muted">Trống. Chép file vào input/ (Bảo toàn) hoặc input/docx/ (DOCX).</p>'}</section>
<section><h2>File lỗi (${f.length})</h2>${f.length ? `<table><tr><th>File</th><th>Lý do</th><th>Xử lý lại</th></tr>${f.map(x => `<tr class="error"><td>${esc(x.name)}</td><td>${esc(x.why)}</td><td>${esc(x.next)}</td></tr>`).join('')}</table>` : '<p class="muted">Không có.</p>'}</section>
<section><h2>Kết quả gần đây</h2>${outs.length ? `<ul>${outs.map(o => `<li><a href="${encodeURIComponent(o.n)}">${esc(o.n)}</a> <span class="muted">${new Date(o.t).toLocaleString('vi-VN', { hour12: false })}</span></li>`).join('')}</ul>` : '<p class="muted">Chưa có.</p>'}</section>
<section><h2>Nhật ký</h2><pre>${esc(this.recent.slice().reverse().join('\n'))}</pre></section>
</main></body></html>`;
      const tmp = join(this.d.output, '._trangthai.html.tmp');
      writeFileSync(tmp, html);
      renameSync(tmp, join(this.d.output, '_trangthai.html'));
    } catch { /* trang theo dõi không được làm hỏng việc OCR */ }
  }

  /* ---------------------------------------------------------------- xử lý 1 file */
  async loadPdf(path: string): Promise<PDFDocument> {
    const bytes = readFileSync(path);
    const ext = extname(path).toLowerCase();
    if (ext === '.pdf') return PDFDocument.load(bytes, { ignoreEncryption: true });
    const doc = await PDFDocument.create();
    const img = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return doc;
  }

  async processFile(path: string, mode: Mode): Promise<'done' | 'partial' | 'failed'> {
    const name = basename(path);
    const size = statSync(path).size;
    const log = this.cfg.log;
    let st = this.loadState(name, size);
    let src: PDFDocument;
    try {
      src = await this.loadPdf(path);
    } catch (e: any) {
      log(`❌ ${name}: không đọc được file (${e?.message || e})`);
      this.finish(path, 'failed', `Không đọc được file: ${e?.message || e}`, null);
      return 'failed';
    }
    const pages = src.getPageCount();
    if (!st || st.mode !== mode || st.pages !== pages) {
      st = { name, size, mode, pages, chunks: makeChunks(pages, this.cfg.chunkPages).map(c => ({ ...c, status: 'pending' })),
             fails: st?.fails || 0, created: Date.now() };
    } else {
      st.chunks.forEach(c => { if (c.status === 'error') c.status = 'pending'; });
      const done = st.chunks.filter(c => c.status === 'done').length;
      if (done) log(`↪️  ${name}: làm tiếp, đã xong ${done}/${st.chunks.length} phần từ lần trước`);
    }
    const thinking = levelFromName(name) || this.cfg.thinking || 'HIGH';
    log(`▶️  ${name}: ${pages} trang, ${st.chunks.length} phần, kiểu ${mode === 'html' ? 'Bảo toàn (HTML)' : 'DOCX'}, ` +
        `suy nghĩ ${thinking}${levelFromName(name) ? ' (theo tiền tố tên file)' : ''}`);
    this.saveState(st);

    const ocr = new Ocr({ ...this.cfg, thinking }, this.pool, mode);
    this.current = { st, started: Date.now() };
    const progress = () => { if (this.current?.st === st) this.status(`Đang OCR ${name}`); };
    progress();
    try {
      if (mode === 'html' && !st.profile) {
        st.profile = await ocr.styleProfile(src, st.chunks);
        this.saveState(st);
      }
      ocr.skipped = st.skipped || [];
      await runChunks(ocr, src, st.chunks, st.profile || null, () => { st!.skipped = ocr.skipped; this.saveState(st!); progress(); });
    } catch (e: any) {
      const kind: ErrKind = e instanceof GeminiError ? e.kind : 'fatal';
      this.current = null;
      if (kind === 'auth') {                                   // lỗi do key, không phải do file: giữ file trong hàng đợi
        st.chunks.forEach(c => { c.running = false; if (c.status === 'error' && c.kind === 'auth') c.status = 'pending'; });
        this.saveState(st);
        log(`⛔ ${name}: API key không hợp lệ — giữ file trong hàng đợi, chờ sửa key`);
        return 'failed';
      }
      log(`❌ ${name}: dừng (${kind}) ${e?.message || e}`);
      st.fails++; st.lastFail = Date.now(); st.lastKind = kind;
      this.saveState(st);
      this.finish(path, 'failed', `Dừng vì: ${e?.message || e}`, st);
      return 'failed';
    }

    this.current = null;
    const failed = st.chunks.filter(c => c.status !== 'done');
    const outPath = await this.writeOutput(st, failed.length > 0, src);
    if (failed.length) {
      st.fails++; st.lastFail = Date.now();
      st.lastKind = failed.every(c => c.kind && RETRYABLE.includes(c.kind)) ? 'transient' : (failed[0].kind || 'fatal');
      this.saveState(st);
      const why = failed.map(c => `- trang ${c.s}-${c.e}: ${c.error}`).join('\n');
      log(`⚠️  ${name}: ${failed.length}/${st.chunks.length} phần lỗi, xuất bản chưa đủ -> ${basename(outPath)}`);
      this.finish(path, 'failed', `${failed.length}/${st.chunks.length} phần chưa OCR được:\n${why}\n\nBản chưa đủ: ${outPath}`, st);
      return 'partial';
    }
    for (const ext of ['.html', '.md', '.docx']) {            // bỏ bản "chưa đủ" của lần chạy trước
      const old = join(this.d.output, `${docTitle(name)} - CHUA-DU${ext}`);
      if (existsSync(old)) renameSync(old, join(this.d.state, `${this.stateId(name, size)}-cu${ext}`));
    }
    const skipped = (st.skipped || []).map(x => x.s === x.e ? `${x.s}` : `${x.s}-${x.e}`);
    log(`🎉 ${name}: xong -> ${outPath}` + (skipped.length ? ` (bỏ qua trang ${skipped.join(', ')} vì AI từ chối)` : ''));
    this.finish(path, 'done', '', st);
    return 'done';
  }

  private uniquePath(dir: string, base: string, ext: string) {
    let p = join(dir, base + ext);
    for (let i = 2; existsSync(p); i++) p = join(dir, `${base} (${i})${ext}`);
    return p;
  }

  async writeOutput(st: FileState, partial: boolean, src?: PDFDocument): Promise<string> {
    // Ảnh trang gốc cho các trang AI từ chối (để bản xuất đủ nội dung)
    const imgs = new Map<number, { dataUrl: string; width: number; height: number }>();
    if (src) {
      for (const x of st.skipped || []) {
        for (let p = x.s; p <= x.e; p++) {
          if (imgs.has(p)) continue;
          const im = await renderPagePng(src, p);
          if (im) imgs.set(p, im); else this.cfg.log(`⚠️  không dựng được ảnh trang ${p} (thiếu pdftoppm?)`);
        }
      }
      if (imgs.size) this.cfg.log(`🖼️  chèn ảnh trang gốc: ${[...imgs.keys()].join(', ')}`);
    }
    const base = docTitle(st.name) + (partial ? ' - CHUA-DU' : '');
    const errBox = (c: ChunkState) => `<div style="border:2px solid #dc2626;border-radius:8px;padding:12px;margin:16px 0;color:#991b1b">` +
      `⚠️ Trang ${c.s}–${c.e} chưa OCR được: ${(c.error || '').replace(/</g, '&lt;')}</div>`;
    if (st.mode === 'html') {
      const withImg = (raw: string) => raw.replace(/<!--PAGE_IMG:(\d+)-->/g, (_m, n) => {
        const im = imgs.get(+n);
        return im ? `<img src="${im.dataUrl}" alt="Trang ${n} (ảnh bản gốc)" style="display:block;max-width:100%;margin:8px auto 20px;border:1px solid #e5e7eb;border-radius:6px">` : '';
      });
      const content = st.chunks.map(c => c.status === 'done' ? MarkdownRenderer.renderHtmlContent(withImg(c.raw || '')) : errBox(c))
        .join('<hr class="my-10 border-slate-200" />');
      const html = generateHtmlDocument({ title: docTitle(st.name), content, profile: st.profile || undefined,
                                          subtitle: 'Trọn bộ tài liệu' } as any);
      return this.atomicWrite(this.uniquePath(this.d.output, base, '.html'), html);
    }
    const md = st.chunks.map(c => c.status === 'done' ? (c.raw || '') : `> ⚠️ Trang ${c.s}–${c.e} chưa OCR được: ${c.error}`).join('\n\n');
    this.atomicWrite(this.uniquePath(this.d.output, base, '.md'),
      md.replace(/!\[IMG-(\d+)\]/g, (_m, n) => `*(ảnh trang ${n} bản gốc: xem trong file .docx)*`));
    const docx = await markdownToDocx(docTitle(st.name), md,
      [...imgs].map(([p, im]) => ({ key: pageImgKey(p), ...im })));
    return this.atomicWrite(this.uniquePath(this.d.output, base, '.docx'), docx);
  }

  private atomicWrite(p: string, data: string | Uint8Array) {
    const tmp = join(this.d.output, `.${basename(p)}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, p);
    return p;
  }

  private finish(path: string, how: 'done' | 'failed', why: string, st: FileState | null) {
    const name = basename(path);
    const dir = how === 'done' ? this.d.done : this.d.failed;
    const dst = this.uniquePath(dir, name.replace(/\.[^.]+$/, ''), extname(name));
    renameSync(path, dst);
    this.seen.delete(path);
    const note = join(this.d.failed, name.replace(/\.[^.]+$/, '') + '.loi.txt');
    if (how === 'failed') {
      const auto = st && st.lastKind && RETRYABLE.includes(st.lastKind) && st.fails < this.opts.maxFileRetries
        ? `Sẽ TỰ thử lại sau khoảng ${Math.round(this.opts.retryFailedMs * st.fails / 60000)} phút (lần ${st.fails + 1}/${this.opts.maxFileRetries}).`
        : 'Không tự thử lại nữa. Muốn chạy lại: chép file này về thư mục input (phần đã xong được giữ, chỉ làm phần lỗi).';
      writeFileSync(note, `${new Date().toLocaleString('vi-VN')}\n${why}\n\n${auto}\n`);
    } else if (existsSync(note)) {
      renameSync(note, note + '.cu');
    }
    this.current = null;
    this.status(how === 'done' ? `Vừa xong ${name}` : `${name} bị lỗi, đã chuyển vào input/loi/`);
  }

  /* ---------------------------------------------------------------- vòng lặp */
  async tick(): Promise<boolean> {
    if (!this.pool.usable) return false;
    this.requeueFailed();
    const files = this.ready();
    if (!files.length) {
      this.status(this.queued().length ? 'Đang đợi file chép xong…' : 'Rảnh — đang chờ file mới trong input/ (Bảo toàn) hoặc input/docx/ (DOCX).');
      return false;
    }
    const { path, mode } = files[0];
    try {
      await this.processFile(path, mode);
    } catch (e: any) {
      this.cfg.log(`❌ lỗi không lường trước với ${basename(path)}: ${e?.stack || e}`);
      try { if (existsSync(path)) this.finish(path, 'failed', `Lỗi hệ thống: ${e?.message || e}`, null); } catch { /* bỏ qua */ }
    }
    return true;
  }
}

/* ------------------------------------------------------------------ cấu hình từ biến môi trường */
export function loadEnvFile(p: string, override = false) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && (override || process.env[m[1]] === undefined)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function cfgFromEnv(log: (m: string) => void): Cfg {
  const e = process.env, num = (k: string, d: number) => (e[k] ? Number(e[k]) : d);
  return {
    baseUrl: e.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    keys: (e.GEMINI_API_KEYS || e.GEMINI_API_KEY || '').split(/[,\s]+/).filter(Boolean),
    model: e.OCR_MODEL || 'gemini-flash-latest',
    fallbackModels: (e.OCR_FALLBACK_MODELS ?? e.OCR_FALLBACK_MODEL ?? 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash')
      .split(/[,\s]+/).filter(Boolean),
    concurrency: num('OCR_CONCURRENCY', 2),
    chunkPages: num('OCR_CHUNK_PAGES', 12),
    minChunkPages: num('OCR_MIN_CHUNK_PAGES', 3),
    maxTries: num('OCR_MAX_TRIES', 6),
    backoffBaseMs: num('OCR_BACKOFF_SECONDS', 30) * 1000,
    backoffMaxMs: num('OCR_BACKOFF_MAX_SECONDS', 600) * 1000,
    quotaWaitMs: num('OCR_QUOTA_WAIT_SECONDS', 60) * 1000,
    timeoutMs: num('OCR_TIMEOUT_SECONDS', 600) * 1000,
    thinking: (e.OCR_THINKING || 'HIGH').toUpperCase(),
    promptsDir: e.OCR_PROMPTS_DIR || join(import.meta.dir, '..', 'public', 'prompts'),
    log,
  };
}

if (import.meta.main) {
  loadEnvFile(process.env.OCR_ENV || '/opt/pdfocr-deploy/ocr.env');
  const root = process.env.OCR_ROOT || join(import.meta.dir, '..');
  const logFile = join(root, 'output', '_nhatky.log');
  const log = (m: string) => {
    const line = `${new Date().toLocaleString('vi-VN', { hour12: false })}  ${m}`;
    console.log(line);
    try { appendFileSync(logFile, line + '\n'); } catch { /* bỏ qua */ }
  };
  const cfg = cfgFromEnv(log);
  const w = new Worker(cfg, dirsFor(root));
  log(`🚀 worker OCR khởi động: ${cfg.keys.length} key, model ${cfg.model}` +
      (cfg.fallbackModels.length ? ` (dự phòng: ${cfg.fallbackModels.join(', ')})` : '') + `, thư mục ${root}`);
  let stop = false;
  process.on('SIGTERM', () => { log('⏹  nhận SIGTERM, dừng (tiến độ đã lưu theo từng phần)'); stop = true; process.exit(0); });
  const envPath = process.env.OCR_ENV || '/opt/pdfocr-deploy/ocr.env';
  let envSig = '';
  const envMtime = () => { try { return String(statSync(envPath).mtimeMs); } catch { return ''; } };
  envSig = envMtime();
  /** Theo dõi ocr.env mỗi 30 giây, kể cả khi đang OCR: đổi key thì nạp ngay, không cần restart, không mất tiến độ. */
  setInterval(() => {
    const sig = envMtime();
    if (!sig || sig === envSig) return;
    envSig = sig;
    loadEnvFile(envPath, true);
    const keys = (process.env.GEMINI_API_KEYS || '').split(/[,\s]+/).filter(Boolean);
    const added = w.pool.setKeys(keys);
    cfg.keys = keys;
    log(`🔑 nạp lại ocr.env: ${keys.length} key${added ? ` (${added} key mới -> thử lại các model đang bị chặn)` : ''}`);
  }, 30_000);
  for (;;) {
    if (stop) break;
    if (!cfg.keys.length || !w.pool.usable) {
      w.status(!cfg.keys.length
        ? 'CHƯA CÓ API KEY — điền GEMINI_API_KEYS trong /opt/pdfocr-deploy/ocr.env (tự nhận sau tối đa 30 giây)'
        : 'API KEY KHÔNG HỢP LỆ — sửa GEMINI_API_KEYS trong /opt/pdfocr-deploy/ocr.env (tự nhận sau tối đa 30 giây). File vẫn nằm trong hàng đợi.');
      await Bun.sleep(10_000);
      continue;
    }
    const busy = await w.tick();
    if (!busy) await Bun.sleep(5_000);
  }
}
