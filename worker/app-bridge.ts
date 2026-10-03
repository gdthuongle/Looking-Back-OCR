/* Dùng lại code của ứng dụng web (prompt, dựng HTML, xuất DOCX) trên máy chủ.
   '@angular/compiler' phải nạp TRƯỚC: header.ts là component Angular (cần JIT khi chạy ngoài bản build). */
import '@angular/compiler';
import { JSDOM } from 'jsdom';
import { AiPromptOptimizer } from '../src/app/ai-prompt-optimizer';
import { MarkdownRenderer } from '../src/app/markdown/markdown-renderer';
import { generateHtmlDocument } from '../src/app/utils/html-template-builder';
import { DocxExporter } from '../src/app/docx/docx-exporter';
import { DEFAULT_STYLE_PROFILE, DocumentStyleProfile } from '../src/app/header';

(globalThis as any).DOMParser ??= new JSDOM('').window.DOMParser;   // docx-math-parser cần DOMParser

const P = AiPromptOptimizer.prototype as any;
const optimizer = { formatDesignTokensBlock: P.formatDesignTokensBlock };

export type Mode = 'html' | 'docx';
export { DEFAULT_STYLE_PROFILE, MarkdownRenderer, generateHtmlDocument };
export type { DocumentStyleProfile };

/** Đúng payload ứng dụng gửi cho một khối (PDF đã cắt + chỉ dẫn + token thiết kế). */
export function buildPayload(pdfBase64: string, systemPrompt: string, start: number, end: number,
                             mode: Mode, profile: DocumentStyleProfile | null): { parts: any[]; system: string } {
  const r = P.buildMultimodalPayload.call(optimizer, pdfBase64, systemPrompt,
    { startPageNum: start, endPageNum: end }, mode === 'html' ? 'html' : 'markdown', profile, false);
  return { parts: r.parts, system: r.systemInstructionText };
}

/** Sao chép parseProfileFromJson trong ai-prompt-optimizer.ts (là closure nên không gọi lại được). */
export function parseProfile(rawText: string, sampleIndices: number[]): DocumentStyleProfile {
  const validFonts = ['Lora', 'Merriweather', 'EB Garamond', 'Alegreya', 'Be Vietnam Pro', 'Plus Jakarta Sans',
                      'Inter', 'Montserrat', 'Roboto', 'JetBrains Mono'];
  const sansFonts = ['Be Vietnam Pro', 'Plus Jakarta Sans', 'Inter', 'Roboto', 'JetBrains Mono'];
  let clean = rawText;
  const m = clean.match(/```(?:json)?([\s\S]*?)```/i);
  if (m && m[1]) clean = m[1].trim();
  const p = JSON.parse(clean);
  return {
    bodyFont: sansFonts.includes(p.bodyFont) ? p.bodyFont : 'Be Vietnam Pro',
    headingFont: validFonts.includes(p.headingFont) ? p.headingFont : 'Alegreya',
    bodyFontSize: p.bodyFontSize || '18px',
    lineHeight: p.lineHeight || '1.7',
    textAlign: p.textAlign === 'left' ? 'left' : 'justify',
    paragraphSpacing: p.paragraphSpacing || '16px',
    styleArchetype: p.styleArchetype || 'Văn bản / Sách tiêu chuẩn',
    h1FontSize: p.h1FontSize || '2.1em', h1FontWeight: p.h1FontWeight || '700',
    h2FontSize: p.h2FontSize || '1.6em', h2FontWeight: p.h2FontWeight || '700',
    h3FontSize: p.h3FontSize || '1.3em', h3FontWeight: p.h3FontWeight || '600',
    analyzedSampleChunks: sampleIndices, analyzedAt: Date.now(),
  } as DocumentStyleProfile;
}

export async function markdownToDocx(title: string, markdown: string): Promise<Uint8Array> {
  const blob: Blob = await DocxExporter.generateDocx(title, markdown, []);
  return new Uint8Array(await blob.arrayBuffer());
}
