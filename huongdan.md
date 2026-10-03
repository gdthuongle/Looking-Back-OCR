# Looking-Back-OCR (/opt/pdfocr)

OCR sách scan / PDF mờ tiếng Việt bằng Gemini (hoặc Meta AI). Ứng dụng chạy **hoàn toàn trong trình duyệt**:
file PDF và API key không đi qua máy chủ này, trình duyệt gửi thẳng tới Google/Meta.

## Mở
- Trong mạng nhà: http://192.168.1.209:8095
- Qua Tailscale: http://100.105.115.14:8095
- Cần Internet (tải PDF.js, MathJax, font từ CDN và gọi Gemini).

## Dùng lần đầu
1. Tạo API key Gemini miễn phí: https://aistudio.google.com/api-keys (thấy chữ "Free tier" là đúng).
2. Mở ứng dụng → nhập API key (lưu trong localStorage của trình duyệt đó, máy khác phải nhập lại).

## Chuyển một cuốn sách
1. Tải lên PDF (**không giới hạn số trang/dung lượng** — file trên 100MB vẫn chạy nhưng trình duyệt chậm, tốn RAM;
   file rất lớn nên dùng Xử lý tự động) **hoặc** nhiều ảnh JPG/PNG (≤100 ảnh, ≤5MB/ảnh). Không trộn PDF với ảnh.
   **Số trang mỗi phần** (cột trái, cạnh nút DOCX/Bảo toàn; mặc định 12, nhớ cho lần sau): nhỏ hơn = mỗi lần gửi
   nhẹ hơn, ít bị lỗi 503, nhưng tốn nhiều lượt gọi hơn. Chỉ đổi được trước khi bắt đầu xử lý.
   Nhiều PDF cùng lúc: ≤20 file, mỗi file ≤12 trang, ≤10MB.
2. Chọn model: **Flash** (mặc định, nhanh, miễn phí ~150–200 trang/ngày/tài khoản), **Pro** (cấu trúc phức tạp,
   hết lượt miễn phí sớm hơn), **Meta** (khi Gemini từ chối vì tưởng còn bản quyền).
3. Chọn kiểu **trước khi** bấm *Xử lý tất cả*:
   - **Bảo toàn** (mặc định): xuất HTML giống bố cục gốc (cột, cỡ chữ…).
   - **DOCX**: bố cục đơn giản, tải được file Word để sửa.
   Đổi kiểu sau khi đã xử lý = phải tải file lên lại.
4. Bấm **Xử lý tất cả**, chờ, rồi tải kết quả (.html hoặc .docx). Có màn hình so sánh với trang gốc.

## Hết lượt miễn phí giữa chừng
Mục **Lịch sử** (góc phải trên) → **Xuất dự án** (.zip) → mở trên trình duyệt/tài khoản có key khác →
**Nhập dự án** → xử lý tiếp. Hoặc đợi hôm sau. Lịch sử giữ 10 dự án gần nhất, chỉ trong trình duyệt đó.

## Lưu ý
- Key miễn phí / Meta có thể dùng dữ liệu tải lên để huấn luyện AI → chỉ nên OCR sách đã hết bản quyền,
  không đưa tài liệu riêng tư.
- Không tách được hình ảnh trong PDF scan, chỉ xử lý chữ (và công thức toán).

## Quản trị
    /opt/pdfocr-deploy/update.sh                 # cập nhật bản mới từ GitHub + build lại
    docker restart pdfocr                        # khởi động lại web
    docker logs --tail 20 pdfocr                 # xem log
    docker rm -f pdfocr                          # gỡ web (mã nguồn vẫn ở /opt/pdfocr)
Container `pdfocr` (nginx:alpine, 64MB RAM) tự chạy lại sau reboot, phục vụ thư mục /opt/pdfocr/dist ở cổng 8095.
Cấu hình nginx: /opt/pdfocr-deploy/nginx.conf. Cài bằng `bun install --frozen-lockfile`
vì package-lock.json của repo đang lệch với package.json (npm ci lỗi).

---

# Xử lý tự động (không cần mở trình duyệt)

Chép file vào thư mục, máy chủ tự OCR **lần lượt từng file**, tự xử lý lỗi và thử lại.

| Chép file vào | Kiểu OCR | Kết quả trong `/opt/pdfocr/output/` |
|---|---|---|
| `/opt/pdfocr/input/` | Bảo toàn (giữ bố cục) | `<tên>.html` |
| `/opt/pdfocr/input/docx/` | DOCX (để sửa tiếp) | `<tên>.docx` + `<tên>.md` |

Nhận file `.pdf`, `.jpg`, `.png` (mỗi ảnh thành một tài liệu riêng). Không giới hạn số trang/dung lượng như bản web.

- Xong: file gốc chuyển vào `input/daocr/`.
- Lỗi: file gốc chuyển vào `input/loi/`, kèm `<tên>.loi.txt` ghi lý do. Phần đã OCR được vẫn xuất ra
  `output/<tên> - CHUA-DU.html`, chỗ thiếu có khung đỏ "chưa OCR được".
- **Theo dõi tiến trình**: nút **"Tự động"** trên thanh đầu trang của bản web (chỉ hiện khi máy chủ có worker), hoặc trang **http://192.168.1.209:8095/ocr/** (Tailscale: http://100.105.115.14:8095/ocr/)
  — file đang làm, % và thời gian còn lại, trạng thái từng phần, hàng đợi, file lỗi kèm giờ tự thử lại,
  nhật ký, và link tải kết quả. Không có trình duyệt thì xem `output/_trangthai.txt`, `output/_nhatky.log`.

## Cài đặt lần đầu: điền API key
    nano /opt/pdfocr-deploy/ocr.env        # GEMINI_API_KEYS=key1,key2,...   (nhiều key -> tự xoay khi hết hạn mức)
Worker tự nhận thay đổi trong `ocr.env` sau tối đa 30 giây, **kể cả khi đang xử lý** (không cần restart, không mất tiến độ). Key đúng tạo ở https://aistudio.google.com/api-keys,
dạng `AIza…`. Key sai: file **vẫn nằm trong hàng đợi** (không bị coi là lỗi), sửa key là chạy tiếp.

## Model và hạn mức (key miễn phí)
- Key miễn phí: **khoảng 20 lần gọi/ngày cho MỖI model**, tính theo project Google, **lần bị 503 cũng bị trừ**.
  Mỗi lần gọi là 1 khối (≤12 trang), nên 1 model đủ cho khoảng 150–200 trang/ngày nếu không bị lỗi nhiều.
- Worker dùng lần lượt các model Flash miễn phí: `gemini-flash-latest` → `3.7-flash` → `3.6-flash` → `3.5-flash`
  → `3-flash-preview` → `2.5-flash` (sửa `OCR_FALLBACK_MODELS` trong `ocr.env`). **Không dùng Pro** (key miễn phí không có lượt Pro).
- Model hết lượt trong ngày bị bỏ qua đến lúc Google mở lại (khoảng 7 giờ sáng giờ VN), trang theo dõi có ghi giờ.
- Muốn nhiều lượt hơn: tạo thêm key ở **project khác** (key cùng project dùng chung hạn mức), điền
  `GEMINI_API_KEYS=key1,key2` — worker tự xoay key.

## Tự xử lý lỗi thế nào
| Lỗi | Worker làm gì |
|---|---|
| 503 quá tải, 500, mạng, quá thời gian, phản hồi rỗng | Chờ 60s, 120s, 240s… rồi thử lại (4 lần mỗi model); khối lớn bị 503 lần thứ 3 → chia đôi (không nhỏ hơn 3 trang) và các khối sau của file dùng luôn cỡ nhỏ; vẫn lỗi → model miễn phí kế tiếp |
| 429 hết hạn mức | Đổi key; model hết lượt trên mọi key → chuyển model miễn phí kế tiếp; hết sạch → chờ đến khi Google mở lại |
| Key sai / bị khóa | Bỏ key đó, dùng key còn lại |
| Kết quả bị cắt cụt, khối quá nặng | Chia đôi khối (12 → 6 → 3 → 1 trang) và làm từng nửa |
| AI từ chối (bản quyền/an toàn), trả lời linh tinh | Thử lại, rồi đổi model, rồi chia nhỏ |
| Hồ sơ thiết kế không phân tích được | Thử 3 lần, rồi dùng hồ sơ mặc định (ghi rõ trong nhật ký) |

- **Lưu tiến độ theo từng phần**: máy khởi động lại, worker dừng giữa chừng → làm tiếp, phần đã xong không gọi lại.
- **Lỗi một phần**: các phần lỗi được làm lại khi file chạy lại; phần đã xong giữ nguyên, không tốn thêm lượt.
- **Tự thử lại file lỗi**: lỗi tạm thời (quá tải, hạn mức…) → file trong `input/loi/` tự quay lại hàng đợi sau 2 giờ,
  4 giờ, 6 giờ (tối đa 3 lần). Lỗi không tự khỏi (file hỏng, bị từ chối) thì không tự thử.
- **Thử lại bằng tay**: chép file từ `input/loi/` về `input/` (hoặc `input/docx/`); chỉ các phần lỗi được làm lại.

## Quản trị worker
    docker logs -f pdfocr-worker                 # xem trực tiếp
    docker restart pdfocr-worker                 # sau khi sửa ocr.env
    docker stop pdfocr-worker                    # tạm dừng (tiến độ đã lưu)
    cd /opt/pdfocr && bun test worker/           # chạy bộ test (máy chủ Gemini giả, không tốn quota)

Mã nguồn worker: `/opt/pdfocr/worker/` (dùng lại prompt và bộ dựng HTML/DOCX của ứng dụng web, nên
`update.sh` cập nhật bản mới thì worker cũng được hưởng). Cấu hình: `/opt/pdfocr-deploy/ocr.env`.

## Web và xử lý tự động: độc lập
- Bản web chạy trong trình duyệt (key, lịch sử lưu trong trình duyệt). Worker chạy trên máy chủ (key trong `ocr.env`,
  tiến độ trong `.ocr-state/`). Hai bên không chia sẻ việc đang làm; file tải lên web không vào hàng đợi worker.
- Dùng chung: prompt, bộ dựng HTML/DOCX -> **kết quả cùng định dạng**. Khác biệt nhỏ: worker ghi thêm `.md` khi xuất
  DOCX, phần lỗi được đánh dấu khung đỏ trong bản `- CHUA-DU`, và mỗi file là một tài liệu riêng (web có chế độ
  nhiều file gộp thành gói .zip).
- Dùng chung **hạn mức** nếu dùng cùng key/project: chạy song song web và worker sẽ ăn chung 20 lượt/ngày/model.

## Cập nhật bản mới
    /opt/pdfocr-deploy/update.sh
Giữ các bản sửa tại máy (git commit "Bản sửa tại máy…", lấy bản GitHub rồi đặt bản sửa lên trên). Nếu xung đột thì dừng, không đổi gì.
