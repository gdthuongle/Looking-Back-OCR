#!/usr/bin/env python3
"""Chuyển kết quả OCR kiểu "Bảo toàn" sang Markdown chữ thuần: từ .ocr-state/*.json (bản thô từng phần)
hoặc từ file .html hoàn chỉnh (bản worker/web xuất ra; xem html_file_to_md và chuyen-html-md.py).

Không gọi AI. Giữ: tiêu đề, đoạn, đậm/nghiêng, danh sách, bảng, công thức $...$ (lấy từ bản thô, chưa đổi sang MathML),
đánh dấu [Trang N] đầu mỗi trang. Bỏ: CSS, bố cục, thẻ ảnh (AI không trích được ảnh thật, các thẻ <img> đều vỡ).

Cách dùng:
  python3 tools/html2md.py <file .ocr-state/xxx.json> <file ra .md>
  python3 tools/html2md.py --name "Toan_3_Tap_1" <file ra .md>     # tìm theo một phần tên file PDF
"""
import base64
import glob
import json
import os
import re
import sys

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

STATE_DIR = os.path.join(os.path.dirname(__file__), '..', '.ocr-state')
BLOCK = {'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'figure', 'figcaption', 'nav',
         'center', 'dl', 'dt', 'dd', 'address', 'details', 'summary', 'form', 'fieldset'}
SKIP = {'style', 'script', 'head', 'title', 'meta', 'link', 'svg', 'img', 'button', 'input', 'select', 'noscript'}


_IMAGES = None        # khi đổi file .html: list [(tên file, bytes)] nhận ảnh data: (ảnh trang gốc) để tách ra file
_IMG_PREFIX = 'anh'


def math_text(n):
    """MathML -> chữ một dòng: 385 = 300 + 80 + 5, a/b, x^2, √(x)."""
    if isinstance(n, NavigableString):
        return str(n).strip()
    if not isinstance(n, Tag) or n.name in ('annotation', 'annotation-xml'):
        return ''
    k = [c for c in n.children if isinstance(c, Tag)]
    if n.name == 'mfrac' and len(k) == 2:
        a, b = math_text(k[0]), math_text(k[1])
        return f'{a}/{b}' if len(a) <= 3 and len(b) <= 3 else f'({a})/({b})'
    if n.name in ('msup', 'msub') and len(k) == 2:
        return math_text(k[0]) + ('^' if n.name == 'msup' else '_') + math_text(k[1])
    if n.name == 'msqrt':
        return '√(' + ''.join(math_text(c) for c in n.children) + ')'
    if n.name == 'mroot' and len(k) == 2:
        return f'{math_text(k[1])}√({math_text(k[0])})'
    if n.name == 'mo':
        op = n.get_text().strip()
        return f' {op} ' if op in ('=', '+', '−', '-', '×', ':', '<', '>', '≤', '≥', '≠', '÷', '·') else op
    if n.name in ('mn', 'mi', 'mtext', 'ms'):
        return n.get_text()
    return ''.join(math_text(c) for c in n.children)


def norm(s):
    return re.sub(r'\s+', ' ', s)


def inline(node):
    """Nội dung inline của một nút -> chuỗi markdown một dòng (giữ <br> thành \\n)."""
    if isinstance(node, Comment):
        return ''
    if isinstance(node, NavigableString):
        return norm(str(node))
    if isinstance(node, Tag) and node.name == 'math':
        return ' ' + re.sub(r'\s+', ' ', math_text(node)).strip() + ' '
    if isinstance(node, Tag) and node.name == 'img':
        src = node.get('src', '')
        alt = norm(node.get('alt', '')).strip()
        m = re.match(r'data:image/(png|jpe?g|webp|gif);base64,(.+)', src, re.S)
        if m and _IMAGES is not None:
            try:
                data = base64.b64decode(m.group(2))
            except ValueError:
                data = b''
            if len(data) >= 5000:                            # ảnh thật nhúng trong file (vd ảnh trang gốc) -> tách ra file
                name = f'{_IMG_PREFIX}-{len(_IMAGES) + 1}.{m.group(1).replace("jpeg", "jpg")}'
                _IMAGES.append((name, data))
                return f'\n![{alt or "ảnh"}]({name})\n'
        # ảnh AI "bịa" (src="#", page1_img1.png, biểu tượng/ảnh rỗng): bỏ ảnh, giữ lời mô tả nếu có nghĩa
        if len(alt) > 3 and alt.lower() not in ('icon', 'image', 'ảnh', 'hình', 'logo', 'hình ảnh'):
            return f' [Hình: {alt}] '
        return ''
    if not isinstance(node, Tag) or node.name in SKIP:
        return ''
    if node.name == 'br':
        return '\n'
    inner = ''.join(inline(c) for c in node.children)
    if node.name in ('strong', 'b') and inner.strip():
        return wrap(inner, '**')
    if node.name in ('em', 'i') and inner.strip():
        return wrap(inner, '*')
    if node.name == 'sup' and inner.strip():
        return '^' + inner.strip()
    if node.name == 'sub' and inner.strip():
        return '_' + inner.strip()
    return inner


def wrap(text, mark):
    lead = text[:len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    return f'{lead}{mark}{text.strip()}{mark}{trail}'


def has_block(node):
    return any(isinstance(c, Tag) and (c.name in BLOCK or c.name in ('table', 'ul', 'ol', 'blockquote', 'hr', 'pre')
                                        or re.fullmatch(r'h[1-6]', c.name or '')) for c in node.children)


def table_md(t):
    rows = []
    for tr in t.find_all('tr'):
        if tr.find_parent('table') is not t:
            continue
        cells = []
        for td in tr.find_all(['td', 'th'], recursive=False):
            txt = norm(inline(td).replace('\n', ' ')).strip().replace('|', '\\|')
            cells.append(txt)
            for _ in range(int(td.get('colspan', 1) or 1) - 1):
                cells.append('')
        if any(cells):
            rows.append(cells)
    if not rows:
        return ''
    n = max(len(r) for r in rows)
    rows = [r + [''] * (n - len(r)) for r in rows]
    out = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * n]
    out += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
    cap = t.find('caption')
    return (f'**{norm(cap.get_text()).strip()}**\n\n' if cap else '') + '\n'.join(out)


def blocks(node, out, quote=False):
    """Duyệt cây, đẩy từng khối markdown vào out."""
    buf = []

    def flush():
        text = ''.join(buf)
        buf.clear()
        lines = [norm(l).strip() for l in text.split('\n')]
        text = '\n'.join(l for l in lines if l)
        if text:
            out.append('\n'.join('> ' + l for l in text.split('\n')) if quote else text)

    for c in node.children:
        if isinstance(c, Comment):
            continue
        if isinstance(c, NavigableString):
            buf.append(norm(str(c)))
            continue
        if not isinstance(c, Tag) or (c.name in SKIP and c.name != 'img'):
            continue
        name = c.name
        if name == 'page-mark':
            flush()
            out.append(f'[Trang {c["n"]}]')
        elif re.fullmatch(r'h[1-6]', name):
            flush()
            t = norm(inline(c).replace('\n', ' ')).strip()
            if t:
                out.append('#' * int(name[1]) + ' ' + t.replace('**', ''))
        elif name == 'table':
            flush()
            t = table_md(c)
            if t:
                out.append(t)
        elif name in ('ul', 'ol'):
            flush()
            items = []
            for i, li in enumerate(c.find_all('li', recursive=False), 1):
                t = norm(inline(li).replace('\n', ' ')).strip()
                if t:
                    items.append(f'{i}. {t}' if name == 'ol' else f'- {t}')
            if items:
                out.append('\n'.join(items))
        elif name == 'blockquote':
            flush()
            blocks(c, out, quote=True)
        elif name == 'hr':
            flush()
            blocks(c, out, quote)          # html.parser đôi khi lồng phần sau vào trong <hr> -> vẫn phải đọc tiếp
        elif name == 'pre':
            flush()
            out.append('```\n' + c.get_text().strip('\n') + '\n```')
        elif name in BLOCK or name == 'li' or has_block(c):
            flush()
            blocks(c, out, quote)
        else:
            buf.append(inline(c))
    flush()


def chunk_to_md(raw):
    raw = re.sub(r'<!--\s*PAGE_BREAK:\s*(\d+)\s*-->', r'<page-mark n="\1"></page-mark>', raw)
    soup = BeautifulSoup(raw, 'html.parser')
    out = []
    blocks(soup, out)
    return out


def html_file_to_md(html, title, img_prefix):
    """File .html hoàn chỉnh (worker/web) -> (markdown, [(tên ảnh, bytes)])."""
    global _IMAGES, _IMG_PREFIX
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup.select('.no-print, script, style, head'):
        t.decompose()
    for d in soup.select('[data-page]'):                    # mốc trang của bản HTML -> [Trang N]
        mark = soup.new_tag('page-mark')
        mark['n'] = d['data-page']
        d.replace_with(mark)
    root = soup.select_one('article.doc-content') or soup.body or soup
    _IMAGES, _IMG_PREFIX = [], img_prefix
    try:
        out = []
        blocks(root, out)
        images = _IMAGES
    finally:
        _IMAGES = None
    parts = [f'# {title}', f'> Nguồn: chuyển từ `{title}.html` (kết quả OCR). Có thể sai sót — đối chiếu bản gốc trước khi '
             'dùng làm đáp án. `[Trang N]` = số trang trong file PDF gốc.'] + out
    md = re.sub(r'\n{3,}', '\n\n', '\n\n'.join(parts)).strip() + '\n'
    return md, images


def convert(state_path, out_path):
    st = json.load(open(state_path))
    if st.get('mode') != 'html':
        sys.exit(f'{state_path}: không phải kiểu Bảo toàn (html)')
    title = re.sub(r'\.[^.]+$', '', st['name'])
    parts = [f'# {title}',
             f'> Nguồn: OCR tự động từ `{st["name"]}` ({st["pages"]} trang) bằng Looking-Back-OCR (Gemini). '
             'Có thể sai sót, nhất là số liệu trong bảng/hình — đối chiếu PDF trước khi dùng làm đáp án. '
             '`[Trang N]` = số trang trong file PDF.']
    for c in st['chunks']:
        if c.get('status') != 'done' or not c.get('raw'):
            parts.append(f'> ⚠️ Trang {c["s"]}–{c["e"]}: chưa OCR được.')
            continue
        parts += chunk_to_md(c['raw'])
    md = '\n\n'.join(parts)
    md = re.sub(r'\n{3,}', '\n\n', md).strip() + '\n'
    with open(out_path, 'w') as f:
        f.write(md)
    return md


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == '--name':
        hits = [p for p in glob.glob(os.path.join(STATE_DIR, '*.json'))
                if a[1] in json.load(open(p)).get('name', '')]
        if len(hits) != 1:
            sys.exit(f'tìm thấy {len(hits)} tài liệu khớp "{a[1]}"')
        a = [hits[0], a[2]]
    if len(a) != 2:
        sys.exit(__doc__)
    md = convert(a[0], a[1])
    print(f'{a[1]}: {len(md) // 1024} KB, {md.count("[Trang ")} trang')
