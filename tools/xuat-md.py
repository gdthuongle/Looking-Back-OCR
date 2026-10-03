#!/usr/bin/env python3
"""Xuất TẤT CẢ tài liệu đã OCR xong sang Markdown (cho giasu), lấy từ bản thô đã lưu (.ocr-state) nên GIỮ CÔNG THỨC
dạng LaTeX $...$ (bản .html đã đổi công thức sang MathML).

  Chạy:     /opt/pdfocr/tools/xuat-md.py               -> /opt/pdfocr/tools/md/<tên>.md
            /opt/pdfocr/tools/xuat-md.py <thư mục ra>  -> thư mục khác
            /opt/pdfocr/tools/xuat-md.py --lai         -> xuất lại tất cả (bỏ qua bộ nhớ "đã chuyển")

- Lần chạy sau BỎ QUA tài liệu đã chuyển (ghi trong <thư mục ra>/.da-chuyen.json), kể cả khi bạn đã chuyển/xóa file .md đi.
  Tài liệu được OCR lại (nội dung đổi) thì xuất lại.
- Tài liệu đang OCR dở / còn phần lỗi: bỏ qua, lần sau xong sẽ xuất.
- Trang AI từ chối: chèn ảnh trang gốc (<tên>-trang-N.png) dựng từ PDF trong input/daocr/.
Không gọi AI, không tốn lượt.
"""
import glob
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from html2md import state_to_md  # noqa: E402


def main():
    args = [a for a in sys.argv[1:] if a != '--lai']
    again = '--lai' in sys.argv[1:]
    out_dir = os.path.abspath(args[0]) if args else os.path.join(HERE, 'md')
    os.makedirs(out_dir, exist_ok=True)
    reg_path = os.path.join(out_dir, '.da-chuyen.json')
    try:
        reg = json.load(open(reg_path))
    except (OSError, ValueError):
        reg = {}

    states = []
    for f in sorted(glob.glob(os.path.join(ROOT, '.ocr-state', '*.json'))):
        if os.path.basename(f) == 'usage.json':
            continue
        try:
            states.append((f, json.load(open(f))))
        except ValueError:
            print(f'❌ {os.path.basename(f)}: đọc lỗi, bỏ qua')
    titles = {}
    for _, st in states:                                    # tên trùng (cùng sách ở 2 kiểu) -> thêm hậu tố kiểu
        t = re.sub(r'^[LMH][-_ ]', '', re.sub(r'\.[^.]+$', '', st['name']), flags=re.I)
        titles.setdefault(t, set()).add(st.get('mode'))

    new = skip = wait = bad = 0
    for f, st in states:
        name = st['name']
        if any(c.get('status') != 'done' for c in st['chunks']):
            done = sum(c.get('status') == 'done' for c in st['chunks'])
            print(f'⏳ {name}: chưa OCR xong ({done}/{len(st["chunks"])} phần) — để lần sau')
            wait += 1
            continue
        sig = hashlib.sha1(json.dumps([name, st.get('mode')] + [c.get('raw') for c in st['chunks']]).encode()).hexdigest()
        key = os.path.basename(f)
        if not again and reg.get(key, {}).get('sig') == sig:
            skip += 1
            continue
        base = re.sub(r'^[LMH][-_ ]', '', re.sub(r'\.[^.]+$', '', name), flags=re.I)
        if len(titles.get(base, ())) > 1:
            base += ' (docx)' if st.get('mode') != 'html' else ''
        try:
            pdf = os.path.join(ROOT, 'input', 'daocr', name)
            md, images = state_to_md(st, base, pdf if os.path.exists(pdf) else None)
            for img, data in images:
                with open(os.path.join(out_dir, img), 'wb') as fh:
                    fh.write(data)
            out = os.path.join(out_dir, base + '.md')
            with open(out + '.tmp', 'w', encoding='utf-8') as fh:
                fh.write(md)
            os.replace(out + '.tmp', out)
            reg[key] = {'sig': sig, 'name': name, 'md': base + '.md'}
            with open(reg_path + '.tmp', 'w') as fh:            # ghi nhớ ngay sau mỗi file
                json.dump(reg, fh, ensure_ascii=False, indent=1)
            os.replace(reg_path + '.tmp', reg_path)
            body = md.split('\n\n', 2)[-1]                     # bỏ tiêu đề + ghi chú nguồn (có chữ `$...$`)
            n_math = len(re.findall(r'(?<!\$)\$(?!\$)[^$\n]+\$', body))
            pages = len(re.findall(r'^\[Trang \d+\]$', md, flags=re.M))
            print(f'✅ {name} -> {base}.md ({len(md.encode()) // 1024} KB'
                  + (f', {pages} trang' if pages else '') + (f', {n_math} công thức' if n_math else '')
                  + (f', {len(images)} ảnh trang gốc' if images else '') + ')')
            new += 1
        except Exception as e:
            print(f'❌ {name}: {type(e).__name__}: {e}')
            bad += 1
    print(f'\nXong: {new} file mới' + (f', bỏ qua {skip} file đã chuyển trước đó' if skip else '')
          + (f', {wait} file chưa OCR xong' if wait else '') + (f', {bad} file lỗi' if bad else '')
          + f'. Thư mục: {out_dir}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
