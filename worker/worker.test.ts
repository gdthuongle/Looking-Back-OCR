/* Chạy: cd /opt/pdfocr && bun test worker/   (dùng máy chủ Gemini GIẢ, không tốn quota) */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Cfg } from './pipeline';
import { classifyHttp, parseRetryDelay } from './gemini';
import { dirsFor, Worker } from './main';
import { makeChunks, validateOutput } from './pipeline';

type Reply = (c: { model: string; key: string; s: number; e: number; n: number; style: boolean }) => Response | null | Promise<Response>;
let script: Reply = () => null;
const calls: { model: string; key: string; s: number; e: number; style: boolean }[] = [];

const ok = (s: number, e: number) => {
  let html = '';
  for (let p = s; p <= e; p++) html += `<!-- PAGE_BREAK: ${p} -->\n<p>Nội dung trang ${p}</p>\n`;
  return Response.json({ candidates: [{ content: { parts: [{ text: html }] }, finishReason: 'STOP' }], usageMetadata: {} });
};
const err = (code: number, status: string, message: string, details: any[] = []) =>
  Response.json({ error: { code, status, message, details } }, { status: code });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const model = new URL(req.url).pathname.split('/models/')[1].split(':')[0];
    const key = req.headers.get('x-goog-api-key') || '';
    const body: any = await req.json();
    const texts = body.contents[0].parts.map((p: any) => p.text || '').join(' ');
    const style = /phân tích phong cách/.test(texts);
    const m = texts.match(/từ trang \*\*(\d+)\*\* đến trang \*\*(\d+)\*\*/);
    const s = m ? +m[1] : 0, e = m ? +m[2] : 0;
    calls.push({ model, key, s, e, style });
    const n = calls.filter(c => c.s === s && c.e === e && !c.style).length;
    const r = await script({ model, key, s, e, n, style });
    if (r) return r;
    if (style) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ bodyFont: 'Inter', headingFont: 'Lora', styleArchetype: 'Thử nghiệm' }) }] }, finishReason: 'STOP' }] });
    return ok(s, e);
  },
});
afterAll(() => server.stop(true));

async function makePdf(path: string, pages: number) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([300, 400]).drawText(`Page ${i}`, { x: 50, y: 300, size: 24, font });
  writeFileSync(path, await doc.save());
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(path, old, old);
}

let root = '', logs: string[] = [];
function worker(over: Partial<Cfg> = {}) {
  const cfg: Cfg = {
    baseUrl: `http://localhost:${server.port}`, keys: ['K1', 'K2'], model: 'flash', fallbackModels: ['pro'],
    concurrency: 2, chunkPages: 12, maxTries: 3, backoffBaseMs: 1, backoffMaxMs: 5, quotaWaitMs: 50,
    timeoutMs: 5000, promptsDir: join(import.meta.dir, '..', 'public', 'prompts'),
    log: m => { logs.push(m); if (process.env.DBG) console.log(m); }, sleep: async () => {}, ...over,
  };
  return new Worker(cfg, dirsFor(root), { stableMs: 0, retryFailedMs: 0, maxFileRetries: 3 });
}
async function runUntilIdle(w: Worker) {
  w.ready();                                   // lần quét 1: ghi nhận kích thước
  for (let i = 0, idle = 0; i < 12 && idle < 2; i++) idle = (await w.tick()) ? 0 : idle + 1;   // 2 nhịp rảnh liền = xong
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ocr-'));
  mkdirSync(join(root, 'input', 'docx'), { recursive: true });
  logs = []; calls.length = 0; script = () => null;
});

describe('phân loại & tiện ích', () => {
  test('phân loại lỗi HTTP', () => {
    expect(classifyHttp(503, 'UNAVAILABLE', 'The model is overloaded')).toBe('transient');
    expect(classifyHttp(429, 'RESOURCE_EXHAUSTED', 'quota')).toBe('quota');
    expect(classifyHttp(400, 'INVALID_ARGUMENT', 'API key not valid')).toBe('auth');
    expect(classifyHttp(404, 'NOT_FOUND', 'models/x is not found')).toBe('model_missing');
    expect(classifyHttp(400, 'INVALID_ARGUMENT', 'Request payload size exceeds the limit')).toBe('too_big');
    expect(parseRetryDelay({ details: [{ retryDelay: '37s' }] }, '')).toBe(37000);
  });
  test('chia khối giống ứng dụng web (≤12 trang, chia đôi)', () => {
    expect(makeChunks(154).length).toBe(16);             // khớp ảnh chụp: 154 trang -> 16 khối
    expect(makeChunks(154)[0]).toEqual({ s: 1, e: 9 });  // "Phần 1 Trang 1-9"
    expect(makeChunks(154)[1]).toEqual({ s: 10, e: 19 });
    expect(makeChunks(5)).toEqual([{ s: 1, e: 5 }]);
  });
  test('phát hiện kết quả hỏng', () => {
    expect(validateOutput('', 1, 2, 'html')).toContain('rỗng');
    expect(validateOutput('Tôi xin lỗi, tôi không thể giúp', 1, 1, 'html')).toContain('AI trả lời');
    expect(validateOutput('<p>a</p>', 1, 3, 'html')).toContain('PAGE_BREAK');
    expect(validateOutput('<!-- PAGE_BREAK: 1 --><p>a</p>', 1, 3, 'html')).toBeNull();
  });
});

describe('đường ống đầy đủ', () => {
  test('HTML: xử lý xong, chuyển file vào input/daocr', async () => {
    await makePdf(join(root, 'input', 'sach.pdf'), 30);
    await runUntilIdle(worker());
    const html = readFileSync(join(root, 'output', 'sach.html'), 'utf8');
    expect(html).toContain('Nội dung trang 1');
    expect(html).toContain('Nội dung trang 30');
    expect(html).toContain('Lora');                       // hồ sơ thiết kế được áp dụng
    expect(existsSync(join(root, 'input', 'daocr', 'sach.pdf'))).toBe(true);
    expect(existsSync(join(root, 'input', 'sach.pdf'))).toBe(false);
  });

  test('DOCX: thư mục input/docx -> .docx + .md', async () => {
    await makePdf(join(root, 'input', 'docx', 'bai.pdf'), 3);
    script = c => c.style ? null : Response.json({ candidates: [{ content: { parts: [{ text: '# Tiêu đề\n\nĐoạn $x^2$' }] }, finishReason: 'STOP' }] });
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'bai.docx'))).toBe(true);
    expect(readFileSync(join(root, 'output', 'bai.md'), 'utf8')).toContain('# Tiêu đề');
    expect(calls.some(c => c.style)).toBe(false);         // DOCX không cần hồ sơ thiết kế
  });

  test('503 quá tải: chờ rồi thử lại, sau đó thành công', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 5);
    script = c => !c.style && c.n <= 2 ? err(503, 'UNAVAILABLE', 'The model is overloaded') : null;
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(calls.filter(c => !c.style).length).toBe(3);               // flash 503 -> pro 503 -> flash qua: không ngồi chờ
    expect(logs.some(l => l.includes('flash quá tải -> pro'))).toBe(true);
  });

  test('503 kéo dài: đổi sang model dự phòng', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 5);
    script = c => c.model === 'flash' ? err(503, 'UNAVAILABLE', 'overloaded') : null;
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(logs.some(l => l.includes('flash quá tải -> pro'))).toBe(true);
    expect(calls.filter(c => !c.style && c.model === 'flash').length).toBeLessThanOrEqual(3);   // flash bận -> không gọi lại liên tục
  });

  test('429: đổi key, không tính là lần thất bại', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 5);
    script = c => c.key === 'K1' ? err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ retryDelay: '3600s' }]) : null;
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(calls.filter(c => c.key === 'K1').length).toBe(1);   // K1 bị nghỉ sau lần đầu
  });

  test('bị cắt cụt (MAX_TOKENS): tự chia đôi khối', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 10);
    script = c => !c.style && c.e - c.s >= 5 ? Response.json({ candidates: [{ content: { parts: [{ text: '<p>dở' }] }, finishReason: 'MAX_TOKENS' }] }) : null;
    await runUntilIdle(worker());
    const html = readFileSync(join(root, 'output', 'a.html'), 'utf8');
    for (const p of [1, 5, 6, 10]) expect(html).toMatch(new RegExp(`Nội dung trang ${p}(\\.\\.\\.)?</p>`));
  });

  test('key sai: bỏ key đó, dùng key còn lại', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 3);
    script = c => c.key === 'K2' ? err(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.') : null;
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
  });

  test('lỗi mãi: xuất bản chưa đủ, file vào input/loi, rồi tự thử lại và làm tiếp phần lỗi', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 30);      // 4 khối: 1-7, 8-15, 16-22, 23-30
    let broken = true;
    script = c => broken && !c.style && c.s === 16 ? err(503, 'UNAVAILABLE', 'overloaded') : null;
    const w = worker();
    w.ready(); await w.tick();
    expect(existsSync(join(root, 'input', 'loi', 'a.pdf'))).toBe(true);
    expect(readFileSync(join(root, 'input', 'loi', 'a.loi.txt'), 'utf8')).toContain('TỰ thử lại');
    expect(readFileSync(join(root, 'output', 'a - CHUA-DU.html'), 'utf8')).toContain('Trang 16–22 chưa OCR được');
    const before = calls.filter(c => !c.style && c.s !== 16).length;

    broken = false;                                        // Google hết quá tải
    await runUntilIdle(w);                                 // requeueFailed -> chạy lại
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(existsSync(join(root, 'output', 'a - CHUA-DU.html'))).toBe(false);
    expect(existsSync(join(root, 'input', 'daocr', 'a.pdf'))).toBe(true);
    expect(calls.filter(c => !c.style && c.s !== 16).length).toBe(before);   // phần đã xong KHÔNG gọi lại
  });

  test('khởi động lại giữa chừng: làm tiếp từ tiến độ đã lưu', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 30);      // 4 khối; worker 1 "chết" khi đang làm khối 4
    let hang = true;
    script = c => hang && !c.style && c.s === 23 ? new Promise<Response>(() => {}) : null;
    const w1 = worker({ concurrency: 1, timeoutMs: 600_000 });
    w1.ready();
    void w1.tick();                                        // bỏ mặc, coi như tiến trình đã chết
    while (!calls.some(c => c.s === 23)) await Bun.sleep(10);
    hang = false;
    const w2 = worker({ concurrency: 1 });
    await runUntilIdle(w2);
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(logs.some(l => l.includes('đã xong 3/4 phần'))).toBe(true);
    expect(calls.filter(c => c.s === 1 && !c.style).length).toBe(1);    // khối 1 không gọi lại
    expect(calls.filter(c => c.style).length).toBe(1);                  // hồ sơ thiết kế không phân tích lại
  }, 20_000);

  test('file đang chép dở (kích thước còn đổi) chưa bị xử lý', async () => {
    const p = join(root, 'input', 'dang-chep.pdf');
    await makePdf(p, 2);
    const w = worker();
    w.ready();
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from('x')]));
    expect(w.ready().length).toBe(0);
  });

  test('file hỏng (không phải PDF): vào input/loi, không tự thử lại', async () => {
    const p = join(root, 'input', 'hong.pdf');
    writeFileSync(p, 'không phải pdf');
    const old = (Date.now() - 60_000) / 1000; utimesSync(p, old, old);
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'input', 'loi', 'hong.pdf'))).toBe(true);
    expect(readFileSync(join(root, 'input', 'loi', 'hong.loi.txt'), 'utf8')).toContain('Không tự thử lại');
  });

  test('ảnh JPG/PNG được nhận', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const p = join(root, 'input', 'anh.png');
    writeFileSync(p, png);
    const old = (Date.now() - 60_000) / 1000; utimesSync(p, old, old);
    await runUntilIdle(worker());
    expect(existsSync(join(root, 'output', 'anh.html'))).toBe(true);
    expect(readdirSync(join(root, 'input', 'daocr'))).toContain('anh.png');
  });

  test('mọi key đều sai: file Ở LẠI hàng đợi (không vào loi), sửa key thì chạy tiếp', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 5);
    script = c => c.key !== 'GOOD' ? err(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.') : null;
    const w = worker();
    await runUntilIdle(w);
    expect(existsSync(join(root, 'input', 'a.pdf'))).toBe(true);
    expect(readdirSync(join(root, 'input', 'loi'))).toEqual([]);
    expect(w.pool.usable).toBe(false);
    w.cfg.keys = ['GOOD']; w.pool.setKeys(['GOOD']);                  // như bộ theo dõi ocr.env nạp lại
    await runUntilIdle(w);
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
  });

  test('trang theo dõi: tiến độ từng phần, hàng đợi, file lỗi kèm giờ tự thử lại', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 30);
    await makePdf(join(root, 'input', 'b.pdf'), 2);
    script = c => !c.style && c.s === 16 ? err(503, 'UNAVAILABLE', 'overloaded') : null;
    const w = worker();
    (w.opts as any).retryFailedMs = 3600_000;
    w.ready(); await w.tick();
    const html = readFileSync(join(root, 'output', '_trangthai.html'), 'utf8');
    expect(html).toContain('b.pdf');                          // còn trong hàng đợi
    expect(html).toContain('tự thử lại lúc');                 // a.pdf lỗi tạm thời -> có giờ thử lại
    expect(html).toContain('a - CHUA-DU.html');               // kết quả chưa đủ có link
    expect(readFileSync(join(root, 'output', '_trangthai.txt'), 'utf8')).toContain('Lỗi: a.pdf');
  });

  test('model dự phòng: thử LẦN LƯỢT danh sách, model "limit: 0" bị bỏ qua ngay (không chờ 21 giờ)', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 5);
    script = c => c.model === 'flash' ? err(503, 'UNAVAILABLE', 'high demand')
      : c.model === 'f2' ? err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: x, limit: 0, model: f2', [{ retryDelay: '76982s' }])
      : null;
    const w = worker({ fallbackModels: ['f2', 'f3'] });
    await runUntilIdle(w);
    expect(existsSync(join(root, 'output', 'a.html'))).toBe(true);
    expect(calls.filter(c => c.model === 'f2').length).toBe(2);      // hỏi 1 lần mỗi key (2 key) rồi bỏ model
    expect(calls.some(c => c.model === 'f3')).toBe(true);
    expect(logs.some(l => l.includes('không có hạn mức cho f2'))).toBe(true);
  });

  test('hạn mức tính theo từng model: hết hạn mức model A không chặn model B trên cùng key', async () => {
    const { KeyPool } = await import('./pipeline');
    const cfg: any = { model: 'a', fallbackModels: ['b'], log: () => {}, sleep: async () => {} };
    const p = new KeyPool(['K'], cfg);
    p.cool(0, 'a', 3600_000);
    expect(await p.acquire('b')).toBe(0);
    expect(p.soonest('a')).toBeGreaterThan(Date.now());
  });

  test('khối đang dùng model vừa bị chặn dài hạn: đổi model ngay, không treo chờ', async () => {
    const { KeyPool } = await import('./pipeline');
    const cfg: any = { model: 'a', fallbackModels: ['b'], log: () => {}, sleep: async () => { throw new Error('không được chờ'); } };
    const p = new KeyPool(['K'], cfg);
    p.cool(0, 'a', 21 * 3600_000);
    await expect(p.acquire('a')).rejects.toMatchObject({ kind: 'model_missing' });
    expect(p.pick()).toBe('b');
  });

  test('khối nhiều trang bị 503 lặp lại: tự chia nhỏ và các khối sau dùng luôn cỡ nhỏ', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 30);      // khối 7-8 trang
    script = c => !c.style && c.e - c.s + 1 > 4 ? err(503, 'UNAVAILABLE', 'high demand') : null;   // chỉ khối ≤4 trang qua
    const w = worker({ concurrency: 1 });
    await runUntilIdle(w);
    const html = readFileSync(join(root, 'output', 'a.html'), 'utf8');
    for (const p of [1, 15, 16, 30]) expect(html).toMatch(new RegExp(`Nội dung trang ${p}(\\.\\.\\.)?</p>`));
    const big = calls.filter(c => !c.style && c.e - c.s + 1 > 4 && c.s >= 16).length;
    expect(big).toBe(0);                                   // khối 3, 4 không còn bị gửi nguyên cỡ lớn
  });

  test('nạp thêm key khi đang chạy: giữ trạng thái key cũ, mở lại model bị chặn', async () => {
    const { KeyPool } = await import('./pipeline');
    const cfg: any = { model: 'a', fallbackModels: ['b'], log: () => {}, sleep: async () => {} };
    const p = new KeyPool(['K1'], cfg);
    p.cool(0, 'a', 21 * 3600_000); p.blockModel('a', 21 * 3600_000);
    expect(p.pick()).toBe('b');
    expect(p.setKeys(['K1', 'K2'])).toBe(1);
    expect(p.pick()).toBe('a');                           // key mới -> thử lại model chính
    expect(await p.acquire('a')).toBe(1);                 // nhưng K1 vẫn đang nghỉ với model a -> dùng K2
  });

  test('trang bị từ chối bản quyền trên mọi model: cô lập đúng trang đó, phần còn lại vẫn xong', async () => {
    await makePdf(join(root, 'input', 'a.pdf'), 8);
    script = c => !c.style && c.s <= 5 && c.e >= 5
      ? Response.json({ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] }) : null;
    const w = worker({ fallbackModels: ['f2', 'f3'] });
    await runUntilIdle(w);
    const html = readFileSync(join(root, 'output', 'a.html'), 'utf8');   // vẫn ra bản đầy đủ
    expect(html).toContain('Trang 5: không OCR được');                // chỉ đúng trang 5 bị bỏ
    for (const p of [1, 4, 6, 8]) expect(html).toMatch(new RegExp(`Nội dung trang ${p}(\\.\\.\\.)?</p>`));
    expect(existsSync(join(root, 'input', 'daocr', 'a.pdf'))).toBe(true);
    expect(logs.some(l => l.includes('bỏ qua trang 5 vì AI từ chối'))).toBe(true);
    expect(calls.filter(c => !c.style).length).toBeLessThan(40);      // không lặp vô hạn
  });

  test('tiền tố L-/M-/H- chọn mức suy nghĩ; tên kết quả bỏ tiền tố', async () => {
    const { levelFromName, docTitle } = await import('./main');
    expect(levelFromName('M-sach-y-hoc.pdf')).toBe('MEDIUM');
    expect(levelFromName('h_sach.pdf')).toBe('HIGH');
    expect(levelFromName('L sach.pdf')).toBe('LOW');
    expect(levelFromName('Mau-sach.pdf')).toBeNull();                 // "Mau-..." không phải tiền tố
    expect(docTitle('M-sach-y-hoc.pdf')).toBe('sach-y-hoc');
    const seen: string[] = [];
    script = c => null;
    await makePdf(join(root, 'input', 'M-sach-y-hoc.pdf'), 3);
    await makePdf(join(root, 'input', 'thuong.pdf'), 3);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any, init: any) => {
      const b = JSON.parse(init.body); seen.push(b.generationConfig.thinkingConfig.thinkingLevel);
      return orig(u, init);
    }) as any;
    try { await runUntilIdle(worker({ thinking: 'LOW' })); } finally { globalThis.fetch = orig; }
    expect(existsSync(join(root, 'output', 'sach-y-hoc.html'))).toBe(true);
    expect(existsSync(join(root, 'input', 'daocr', 'M-sach-y-hoc.pdf'))).toBe(true);
    expect(seen).toContain('MEDIUM');
    expect(seen).toContain('LOW');                                     // file không tiền tố dùng OCR_THINKING
  });
});
