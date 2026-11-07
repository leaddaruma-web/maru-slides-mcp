# maru-slides-mcp

MCP server cho AI agent đọc, dựng và sửa Google Slides **tại chỗ** qua Google Slides API v1. Sửa trực tiếp trên deck đang có, giữ nguyên mã tệp, link chia sẻ, bình luận.

Cùng họ với maru-docs-mcp, maru-sheets-mcp, maru-forms-mcp.

## Dành cho người dùng

Bạn không cần biết code. Mở Claude Code, Antigravity hoặc AI agent khác, dán đoạn sau:

```
Cài giúp tôi MCP server "maru-slides-mcp" để đọc và sửa Google Slides.
Đọc README.md ở https://github.com/leaddaruma-web/maru-slides-mcp, phần "Dành cho AI agent", làm hết các bước.
Tôi chỉ bấm "Cho phép" khi trình duyệt hỏi quyền Google.
```

Cài xong, bạn nói kiểu:

- *"Đọc deck [link], liệt kê mỗi trang có những chữ gì"*
- *"Chụp ảnh trang 3 của deck [link] cho tôi xem"*
- *"Đếm thử chữ 'móc' trong deck có mấy chỗ, đừng sửa"* rồi *"giờ thay 'móc' thành 'mã hoá'"*
- *"Ô tiêu đề trang 2 đổi thành 'Bài 5: Kanji số đếm', cỡ 32, đỏ đậm"*
- *"Viết ghi chú người nói cho trang 4: ..."*
- *"Thay ảnh logo trang 1 bằng ảnh này trên Drive [link], giữ nguyên chỗ"*
- *"Thêm một trang theo layout Tiêu đề và nội dung, có bảng 3 cột"*
- *"Xuất deck ra PDF"*, *"chụp ảnh cả deck thành một tờ xem nhanh"*
- *"Trước khi sửa, xem ai vừa sửa deck này và có bình luận nào chưa giải quyết"*

Lưu ý:
- Deck phải được chia sẻ quyền **Người chỉnh sửa** cho tài khoản Google đã đăng nhập.
- Không có công cụ xoá trang, xoá tệp, hay đổi quyền chia sẻ. Cố ý như vậy.
- Muốn xoá một khối trên trang, agent phải gửi kèm cờ xác nhận, và lệnh được ghi vào sổ vết trên máy.

## Dành cho AI agent

### Bước 1. Node.js 18 trở lên, tải mã

```bash
node --version
git clone https://github.com/leaddaruma-web/maru-slides-mcp.git
cd maru-slides-mcp
npm install
```

### Bước 2. credentials.json

Làm như Bước 2 của [maru-docs-mcp](https://github.com/leaddaruma-web/maru-docs-mcp) (tạo dự án Google Cloud, OAuth client loại **Desktop app**), nhưng bật **Google Slides API** và **Google Drive API**. Đặt `credentials.json` ở thư mục gốc. Đã có `credentials.json` của maru-docs-mcp thì dùng lại được, chỉ cần bật thêm Slides API trong cùng dự án.

### Bước 3. Cấp quyền (cần người bấm "Cho phép")

```bash
npm run auth
```

In ra một địa chỉ. **Người dùng** mở địa chỉ đó, đăng nhập, bấm "Cho phép". Google chuyển về `http://localhost:4573`, `token.json` được lưu với quyền 600. Phạm vi xin: `presentations` và `drive`.

Agent ⛔ không tự mở trình duyệt đăng nhập thay người dùng. Không có người bấm thì dừng ở đây và báo.

Cách nạp khác (máy đã có sẵn token có quyền `drive`), dùng biến môi trường, không chép token vào kho:

| Biến | Nghĩa |
|---|---|
| `MARU_SLIDES_CREDENTIALS` | đường tới credentials.json (mặc định thư mục gốc) |
| `MARU_SLIDES_TOKEN_FILE` | đường tới tệp token (phẳng, hoặc bọc `{token:{...}}`) |
| `MARU_SLIDES_TOKEN_HELPER` | mô-đun có hàm `layAccessToken({duongToken, client})`, tự làm mới token |
| `MARU_SLIDES_KHOA_GHI` | danh sách id deck, ngăn bằng dấu phẩy, server **từ chối mọi lệnh ghi** lên chúng |
| `MARU_SLIDES_AUDIT_LOG` | đường sổ vết (mặc định `so-vet/so-vet-ghi.jsonl`) |

### Bước 4. Đăng ký MCP (người dùng tự làm hoặc cho phép)

Đoạn mẫu, thay đường dẫn:

```json
{
  "mcpServers": {
    "maru-slides": {
      "command": "node",
      "args": ["/duong-dan-tuyet-doi/maru-slides-mcp/src/slides-server.js"]
    }
  }
}
```

Dùng token có sẵn thay cho token.json:

```json
{
  "mcpServers": {
    "maru-slides": {
      "command": "node",
      "args": ["/duong-dan-tuyet-doi/maru-slides-mcp/src/slides-server.js"],
      "env": {
        "MARU_SLIDES_CREDENTIALS": "/duong-dan/credentials.json",
        "MARU_SLIDES_TOKEN_FILE": "/duong-dan/token-co-quyen-drive.json",
        "MARU_SLIDES_KHOA_GHI": "id-deck-khong-duoc-sua"
      }
    }
  }
}
```

Claude Code: `claude mcp add maru-slides -- node /duong-dan-tuyet-doi/maru-slides-mcp/src/slides-server.js`

### Bước 5. Kiểm

Gọi `get_presentation` với một deck tài khoản đó mở được. Có danh sách trang là xong. Bộ kiểm đầy đủ (tạo bản sao `[ĐO]` rồi gọi mọi công cụ trên bản sao): `node scripts/kiem-mcp.js <id-deck-nguồn>`.

## Công cụ (35)

`presentationId` lấy từ link `docs.google.com/presentation/d/{presentationId}/edit`. Toạ độ khối mới tính theo `unit`: `IN` (mặc định), `PT`, `CM`, hoặc `PCT` (phần trăm khổ trang).

**Đọc, xuất**

| Công cụ | Làm gì |
|---|---|
| `get_presentation` | Khổ trang, số trang, mỗi trang các khối (id, loại, x y w h pt, chữ, cỡ chữ) và ghi chú. Giới hạn bằng `fromPage`/`toPage`/`pageIds` (mặc định 20 trang) |
| `get_layouts` | Master, layout, placeholder từng layout, bảng màu chủ đề |
| `get_thumbnail` | Ảnh PNG một trang ra tệp |
| `export_thumbnails` | Ảnh mọi trang vào thư mục + tờ ghép `contact-sheet.png` |
| `export_pdf`, `export_pptx` | Xuất tệp qua Drive (Google giới hạn 10 MB) |
| `list_revisions` | Lịch sử phiên bản (giờ, người sửa) và bình luận. Gọi trước khi ghi |

**Deck, trang**

| Công cụ | Làm gì |
|---|---|
| `create_presentation` | Deck trống mới, đặt vào thư mục Drive |
| `copy_presentation` | Bản sao từ deck mẫu hoặc master (riêng tư) |
| `create_slide` | Trang mới theo layout, điền chữ vào placeholder |
| `duplicate_slide`, `move_slide` | Nhân bản trang, đổi thứ tự |
| `set_page_background` | Nền màu hoặc ảnh |
| `build_slide_from_json` | Dựng cả trang trong một lệnh từ mô tả JSON |

**Chữ**

| Công cụ | Làm gì |
|---|---|
| `replace_text` | Thay chữ khắp deck. `dryRun` chỉ đếm. Chặn khi cụm nằm lọt trong từ dài hơn. Đếm lại sau khi thay |
| `update_text` | Thay toàn bộ chữ của một khối hoặc ô bảng |
| `update_text_style` | Cỡ, đậm, nghiêng, gạch, màu, tô nền, phông, link, cho cả khối hoặc một khoảng |
| `update_paragraph_style` | Căn lề, giãn dòng, khoảng cách, thụt lề, gạch đầu dòng, số thứ tự |
| `update_speaker_notes` | Ghi chú người nói |

**Khối**

| Công cụ | Làm gì |
|---|---|
| `insert_element` | Chèn hộp chữ, hình khối (mọi shapeType), đường kẻ và mũi tên, ảnh, video YouTube/Drive, bảng, biểu đồ Sheets |
| `replace_image` | Thay ảnh, giữ vị trí và khung |
| `replace_shapes_with_image` | Thay mọi hình khối chứa chữ mốc (vd `{{LOGO}}`) bằng ảnh |
| `move_resize` | Vị trí, kích thước (giữ góc xoay) |
| `transform_element` | Xoay, lật ngang, lật dọc quanh tâm |
| `set_alt_text` | Mô tả ảnh |
| `group_elements`, `ungroup_elements` | Nhóm, bỏ nhóm |
| `set_z_order` | Đưa lên trên cùng, lên một lớp, xuống, xuống dưới cùng |
| `delete_elements` | Xoá khối, cần `confirm="TOI_XAC_NHAN_XOA"`, từ chối nếu id là trang |

**Bảng, biểu đồ, nâng cao**

| Công cụ | Làm gì |
|---|---|
| `table_edit` | Thêm hàng, cột; bớt hàng, cột (cần cờ xác nhận) |
| `write_table_cells` | Ghi nhiều ô |
| `merge_table_cells` | Gộp, tách ô |
| `style_table_cells` | Nền ô, căn dọc, viền, độ rộng cột |
| `refresh_sheets_chart` | Làm mới biểu đồ nhúng (chèn bằng `insert_element` loại `chart`) |
| `batch_update` | Gửi thẳng mảng requests. Lệnh xoá cần cờ; xoá trang luôn bị từ chối |

Ví dụ `build_slide_from_json`:

```json
{ "unit": "PCT", "background": "#FFFFFF", "elements": [
  { "type": "text", "x": 5, "y": 5, "w": 90, "h": 12, "text": "Tiêu đề", "fontSize": 28, "bold": true, "colorHex": "#C00000" },
  { "type": "text", "x": 5, "y": 20, "w": 40, "h": 30, "text": "Ý một\nÝ hai", "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE" },
  { "type": "shape", "shapeType": "ROUND_RECTANGLE", "x": 50, "y": 20, "w": 20, "h": 15, "fillHex": "#1F6FB2", "text": "Hộp" },
  { "type": "line", "x1": 70, "y1": 27, "x2": 80, "y2": 27, "endArrow": "FILL_ARROW" },
  { "type": "image", "driveFileId": "...", "x": 5, "y": 55, "w": 25, "h": 20 },
  { "type": "table", "x": 35, "y": 55, "w": 35, "h": 20, "data": [["A", "B"], ["1", "2"]] }
] }
```

## Giới hạn: API không làm được, server không giả lập

- **Hiệu ứng chuyển trang và animation**: Slides API v1 không đọc, không ghi. Thay chữ hay ảnh thì hiệu ứng sẵn có vẫn giữ, nhưng không tạo mới được.
- **Đổi layout của trang đã có**: API không có lệnh này. Cách làm: `create_slide` với layout mới rồi chuyển nội dung sang.
- **Sửa master, layout**: đọc được (`get_layouts`), sửa khối trên layout bằng `batch_update` được, nhưng không tạo master mới.
- **Video**: chỉ chèn theo id YouTube hoặc tệp Drive; không đặt giờ bắt đầu, tự phát qua công cụ riêng (dùng `batch_update` với `updateVideoProperties`).
- **Biểu đồ Sheets**: chỉ nhúng biểu đồ đã có trong bảng tính (cần `spreadsheetId` và `chartId`). Không vẽ biểu đồ mới trong Slides.
- **Ảnh từ Drive**: Slides API chỉ tải được ảnh công khai. `driveFileId` chạy được khi tệp ảnh để chế độ "Bất kỳ ai có đường liên kết". Server không tự đổi quyền, gặp ảnh riêng tư thì báo lỗi kèm hướng dẫn. (Đã thử đường ảnh xem trước của Drive: Google cũng từ chối.)
- **Xuất tệp lớn**: Drive chặn xuất trên 10 MB; server tự chuyển sang đường `exportLinks`, nhưng deck nặng có thể mất hơn một phút. Máy khách MCP có hạn chờ 60 giây sẽ cắt ngang.
- **Chữ tiếng Nhật, Trung**: không có khoảng trắng giữa từ, nên `replace_text` gần như luôn cảnh báo "lọt trong từ". Đọc mẫu rồi mới gọi lại với `allowInsideWord=true`.
- **Bình luận**: chỉ đọc, không trả lời hay đánh dấu đã giải quyết.

## Sổ vết

Mọi lệnh ghi thêm một dòng vào `so-vet/so-vet-ghi.jsonl`: thời gian, id deck, công cụ, số request, loại request, ghi chú (với xoá khối thì có danh sách id). Sổ không có token, không đưa lên git.

## Lỗi hay gặp

| Lỗi | Sửa |
|---|---|
| `Chưa có token.json` | `npm run auth` |
| `The caller does not have permission` | Chia sẻ deck quyền Người chỉnh sửa cho tài khoản đã đăng nhập |
| `invalid_grant` | Token bị thu hồi: xoá `token.json`, chạy lại `npm run auth` |
| `predefined layout ... is not present` | Deck dùng master riêng: lấy `layoutId` từ `get_layouts` |
| `nằm trong danh sách khoá ghi` | Deck đang được bảo vệ bằng `MARU_SLIDES_KHOA_GHI` |
