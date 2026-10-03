/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

/** Đường dẫn trạng thái do worker OCR tự động (máy chủ) ghi ra; nginx phát ở /ocr/. */
export const AUTO_OCR_BASE = '/ocr/';

/** Kiểm tra máy chủ có worker xử lý tự động không (bản AI Studio / Cloudflare sẽ không có). */
export async function isAutoOcrAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${AUTO_OCR_BASE}_trangthai.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const d = await r.json();
    return typeof d?.updated === 'number';
  } catch {
    return false;
  }
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-auto-ocr-modal',
  imports: [CommonModule, MatIconModule],
  template: `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm"
         role="button" tabindex="-1" aria-label="Đóng"
         (click)="closeModal.emit()" (keydown.escape)="closeModal.emit()">
      <div class="w-full max-w-4xl max-h-[92vh] flex flex-col bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
           role="dialog" aria-modal="true" aria-label="Xử lý tự động" tabindex="-1"
           (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">

        <!-- Tiêu đề -->
        <div class="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/5 shrink-0">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="h-9 w-9 rounded-xl bg-emerald-500/15 flex items-center justify-center text-emerald-400 border border-emerald-500/10 shrink-0">
              <mat-icon class="!text-[20px] !w-5 !h-5">auto_mode</mat-icon>
            </div>
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-100">Xử lý tự động trên máy chủ</h2>
              <p class="text-[11px] text-slate-500 truncate">
                Chép file vào <code class="text-slate-400">input/</code> (Bảo toàn) hoặc <code class="text-slate-400">input/docx/</code> (DOCX) ·
                {{ updatedText() }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <a [href]="base" target="_blank" rel="noopener"
               class="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg border border-white/5">
              <mat-icon class="!text-[14px] !w-3.5 !h-3.5">open_in_new</mat-icon> Trang đầy đủ
            </a>
            <button type="button" (click)="closeModal.emit()" class="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 cursor-pointer" title="Đóng">
              <mat-icon class="!text-[18px] !w-[18px] !h-[18px]">close</mat-icon>
            </button>
          </div>
        </div>

        <div class="overflow-y-auto px-5 py-4 space-y-4 text-xs">
          @if (error()) {
            <div class="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{{ error() }}</div>
          }
          @if (data(); as d) {
            <!-- Trạng thái chung -->
            <div class="p-3 rounded-lg bg-slate-800/60 border border-white/5 text-slate-200 font-medium flex items-center gap-2"
                 [class.border-rose-500/40]="isAlert()" [class.text-rose-300]="isAlert()">
              <mat-icon class="!text-[16px] !w-4 !h-4 shrink-0" [class.animate-spin]="!!d.current">{{ d.current ? 'progress_activity' : (isAlert() ? 'error' : 'schedule') }}</mat-icon>
              <span>{{ d.headline }}</span>
            </div>

            <!-- File đang xử lý -->
            @if (d.current; as c) {
              <section class="space-y-2">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 class="text-sm font-semibold text-slate-100 break-all">{{ c.name }}</h3>
                  <span class="text-slate-400">
                    {{ c.pages }} trang · {{ c.total }} phần · {{ c.mode === 'html' ? 'Bảo toàn' : 'DOCX' }}
                    @if (c.etaMin !== null && c.etaMin !== undefined) { · <b class="text-slate-200">còn ~{{ c.etaMin }} phút</b> }
                  </span>
                </div>
                <div class="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                  <div class="h-full bg-emerald-500 transition-all duration-500" [style.width.%]="c.pct"></div>
                </div>
                <p class="text-slate-400">
                  Xong {{ c.ok }}/{{ c.total }} phần ({{ c.pct }}%)
                  @if (c.running) { · {{ c.running }} phần đang chạy }
                  @if (c.bad) { · <span class="text-rose-400">{{ c.bad }} phần lỗi</span> }
                </p>
                <!-- Lưới từng phần -->
                <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                  @for (ch of c.chunks; track ch.part) {
                    <div class="rounded-md border px-1.5 py-1 text-[10px] leading-tight"
                         [title]="chunkTitle(ch)"
                         [class.bg-emerald-500/10]="ch.status === 'done'" [class.border-emerald-500/30]="ch.status === 'done'"
                         [class.bg-indigo-500/15]="ch.status === 'running'" [class.border-indigo-400/50]="ch.status === 'running'"
                         [class.animate-pulse]="ch.status === 'running'"
                         [class.bg-rose-500/10]="ch.status === 'error'" [class.border-rose-500/40]="ch.status === 'error'"
                         [class.border-white/5]="ch.status === 'pending'">
                      <div class="font-semibold text-slate-200">P{{ ch.part }}</div>
                      <div class="text-slate-400">{{ ch.s }}–{{ ch.e }}</div>
                      <div>{{ chunkIcon(ch.status) }}@if (ch.sec) { {{ ch.sec }}s }</div>
                    </div>
                  }
                </div>
              </section>
            }

            <!-- Hạn mức model -->
            @if (d.quota?.length) {
              <section>
                <h3 class="font-semibold text-slate-300 mb-1.5">Model &amp; hạn mức hôm nay
                  <span class="font-normal text-slate-500">(key miễn phí ~20 lần/ngày mỗi model, lần bị 503 cũng tính)</span></h3>
                <div class="overflow-x-auto">
                  <table class="w-full text-left">
                    <tbody>
                      @for (q of d.quota; track q.m) {
                        <tr class="border-b border-white/5">
                          <td class="py-1 pr-3 font-mono text-slate-300">{{ q.m }}</td>
                          <td class="py-1 pr-3 text-slate-400 whitespace-nowrap">{{ q.n }} lần</td>
                          <td class="py-1 text-slate-400">{{ q.st }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }

            <div class="grid md:grid-cols-2 gap-4">
              <!-- Hàng đợi -->
              <section>
                <h3 class="font-semibold text-slate-300 mb-1.5">Hàng đợi ({{ d.queue?.length || 0 }})</h3>
                @if (d.queue?.length) {
                  <ol class="list-decimal pl-5 space-y-0.5 text-slate-400 break-all">
                    @for (q of d.queue; track q) { <li>{{ q }}</li> }
                  </ol>
                } @else { <p class="text-slate-500">Trống.</p> }
              </section>

              <!-- Kết quả -->
              <section>
                <h3 class="font-semibold text-slate-300 mb-1.5">Kết quả gần đây</h3>
                @if (d.outputs?.length) {
                  <ul class="space-y-0.5">
                    @for (o of d.outputs; track o.name) {
                      <li class="flex justify-between gap-2">
                        <a [href]="base + encode(o.name)" target="_blank" rel="noopener" class="text-indigo-400 hover:text-indigo-300 break-all">{{ o.name }}</a>
                        <span class="text-slate-500 whitespace-nowrap">{{ o.mtime | date:'HH:mm dd/MM' }}</span>
                      </li>
                    }
                  </ul>
                } @else { <p class="text-slate-500">Chưa có.</p> }
              </section>
            </div>

            <!-- File lỗi -->
            @if (d.failed?.length) {
              <section>
                <h3 class="font-semibold text-rose-300 mb-1.5">File lỗi ({{ d.failed.length }})</h3>
                <ul class="space-y-1.5">
                  @for (f of d.failed; track f.name) {
                    <li class="p-2 rounded-lg bg-rose-500/5 border border-rose-500/20">
                      <div class="text-slate-200 break-all">{{ f.name }}</div>
                      <div class="text-slate-400">{{ f.why }}</div>
                      <div class="text-amber-300/90">{{ f.next }}</div>
                    </li>
                  }
                </ul>
              </section>
            }

            <!-- Nhật ký -->
            <section>
              <button type="button" (click)="showLog.set(!showLog())" class="flex items-center gap-1 font-semibold text-slate-300 cursor-pointer">
                <mat-icon class="!text-[16px] !w-4 !h-4">{{ showLog() ? 'expand_less' : 'expand_more' }}</mat-icon> Nhật ký
              </button>
              @if (showLog()) {
                <pre class="mt-1.5 p-2.5 rounded-lg bg-slate-950 border border-white/5 text-[11px] text-slate-400 whitespace-pre-wrap max-h-72 overflow-y-auto">{{ (d.log || []).join('\\n') }}</pre>
              }
            </section>
          } @else if (!error()) {
            <p class="text-slate-500">Đang tải trạng thái…</p>
          }
        </div>
      </div>
    </div>
  `,
})
export class AutoOcrModal implements OnInit, OnDestroy {
  closeModal = output<void>();
  base = AUTO_OCR_BASE;
  data = signal<any>(null);
  error = signal('');
  showLog = signal(false);
  private timer: any = null;

  isAlert = computed(() => /KHÔNG HỢP LỆ|CHƯA CÓ API KEY/.test(this.data()?.headline || ''));
  updatedText = computed(() => {
    const t = this.data()?.updated;
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s > 120 ? `⚠️ worker không cập nhật ${Math.round(s / 60)} phút — có thể đã dừng` : `cập nhật ${s}s trước`;
  });

  ngOnInit() {
    void this.load();
    this.timer = setInterval(() => this.load(), 5000);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async load() {
    try {
      const r = await fetch(`${AUTO_OCR_BASE}_trangthai.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.data.set(await r.json());
      this.error.set('');
    } catch (e: any) {
      this.error.set(`Không đọc được trạng thái worker (${e?.message || e}).`);
    }
  }

  encode(n: string) { return encodeURIComponent(n); }

  chunkIcon(st: string) {
    return st === 'done' ? '✅' : st === 'running' ? '⏳' : st === 'error' ? '❌' : '▫️';
  }

  chunkTitle(ch: any) {
    return `Phần ${ch.part}: trang ${ch.s}–${ch.e}` + (ch.error ? `\nLỗi: ${ch.error}` : '');
  }
}
