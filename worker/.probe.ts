import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { slicePdf } from './pipeline';
import { buildPayload } from './app-bridge';
const keys = (readFileSync('/opt/pdfocr-deploy/ocr.env', 'utf8').match(/^GEMINI_API_KEYS=(.*)$/m) || [])[1]!.split(',').map(s => s.trim());
const src = await PDFDocument.load(readFileSync('input/' + process.argv[2]), { ignoreEncryption: true });
const prompt = readFileSync('public/prompts/html_reflow_instructions.md', 'utf8');
const [s, e] = [11, 13];
const { parts, system } = buildPayload(await slicePdf(src, s, e), prompt, s, e, 'html', null);
const model = process.argv[3];
const levels = ['LOW', 'MEDIUM', 'HIGH'];
await Promise.all(levels.map(async (lv, i) => {
  const t0 = Date.now();
  for (let k = 0; k < keys.length; k++) {
    const key = keys[(i + k) % keys.length];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], systemInstruction: { parts: [{ text: system }] },
        generationConfig: { temperature: 0.1, thinkingConfig: { thinkingLevel: lv } } }) });
    const d: any = await r.json();
    if (r.status === 429) continue;
    const c = d?.candidates?.[0], u = d?.usageMetadata || {};
    const text = (c?.content?.parts || []).map((p: any) => p.text || '').join('');
    writeFileSync(`/tmp/claude-1000/lv-${lv}.html`, text);
    console.log(`${lv.padEnd(6)} HTTP ${r.status} ${((Date.now() - t0) / 1000).toFixed(0)}s  finish=${c?.finishReason || d?.error?.status}  suy nghĩ=${u.thoughtsTokenCount ?? 0}  ra=${u.candidatesTokenCount ?? 0} token  ${text.length} ký tự`);
    return;
  }
  console.log(`${lv}: mọi key hết lượt ${model}`);
}));
