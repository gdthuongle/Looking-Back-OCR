#!/usr/bin/env python3
"""Chuyển HÀNG LOẠT file .html (kết quả OCR) sang Markdown, rồi XÓA file .html đã chuyển thành công.

  Chép file .html vào  /opt/pdfocr/tools/html/
  Chạy:                /opt/pdfocr/tools/chuyen-html-md.py
  Kết quả:             /opt/pdfocr/tools/md/<tên>.md   (+ ảnh trang gốc nếu có: <tên>-anh-1.png ...)

Thư mục khác:  chuyen-html-md.py <thư mục html> <thư mục md>
File lỗi được GIỮ NGUYÊN trong thư mục html (không xóa) và báo ra màn hình. Không gọi AI.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from html2md import html_file_to_md  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    src_dir = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, 'html')
    out_dir = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(HERE, 'md')
    if len(sys.argv) not in (1, 3):
        sys.exit(__doc__)
    os.makedirs(src_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(f for f in os.listdir(src_dir) if f.lower().endswith(('.html', '.htm')) and not f.startswith('.'))
    if not files:
        print(f'Không có file .html nào trong {src_dir}')
        return 0
    ok = bad = 0
    for f in files:
        path = os.path.join(src_dir, f)
        base = re.sub(r'\.html?$', '', f, flags=re.I)
        try:
            with open(path, encoding='utf-8', errors='replace') as fh:
                md, images = html_file_to_md(fh.read(), base, f'{base}-anh')
            body = re.sub(r'^#.*\n|^>.*\n', '', md, flags=re.M).strip()
            if len(body) < 20:
                raise ValueError('không lấy được nội dung chữ nào (file rỗng hoặc không phải kết quả OCR?)')
            for name, data in images:                       # ảnh trang gốc (trang AI từ chối) tách thành file
                with open(os.path.join(out_dir, name), 'wb') as fh:
                    fh.write(data)
            out = os.path.join(out_dir, base + '.md')
            tmp = out + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                fh.write(md)
            os.replace(tmp, out)                            # ghi xong trọn vẹn rồi mới coi là thành công
            os.remove(path)
            pages = len(re.findall(r'^\[Trang \d+\]$', md, flags=re.M))
            print(f'✅ {f} -> md/{base}.md ({len(md.encode()) // 1024} KB, {pages} trang'
                  + (f', {len(images)} ảnh' if images else '') + ') — đã xóa file html')
            ok += 1
        except Exception as e:                              # lỗi: giữ nguyên file html để xử lý lại
            print(f'❌ {f}: {type(e).__name__}: {e} — GIỮ NGUYÊN file html')
            bad += 1
    print(f'\nXong: {ok} file chuyển thành công' + (f', {bad} file lỗi (vẫn nằm trong {src_dir})' if bad else '') + '.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
