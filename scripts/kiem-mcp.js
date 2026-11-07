#!/usr/bin/env node
// Kịch bản kiểm: gọi lần lượt MỌI công cụ qua giao thức MCP (stdio) trên MỘT BẢN SAO "[ĐO]" của deck nguồn.
// Deck nguồn chỉ được ĐỌC để sao chép, và được đưa vào danh sách khoá ghi để server tự từ chối mọi lệnh ghi lên nó.
// Kết quả thô ghi ra ket-qua-kiem/ (không commit). Màn hình chỉ in bảng đếm.
//
// Chạy: node scripts/kiem-mcp.js <id-deck-nguồn>
// Cần biến môi trường đăng nhập như README (MARU_SLIDES_TOKEN_FILE, MARU_SLIDES_TOKEN_HELPER, MARU_SLIDES_CREDENTIALS) hoặc token.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { google } from "googleapis";
import { getAuthClient } from "../src/auth.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2];
if (!SRC) { console.error("Cần id deck nguồn"); process.exit(2); }
const OUT = path.join(ROOT, "ket-qua-kiem");
fs.mkdirSync(OUT, { recursive: true });
const CONFIRM = "TOI_XAC_NHAN_XOA";
const FAKE_LOCKED = "deck_gia_bi_khoa_de_kiem";
const PUBLIC_IMG = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

const env = { ...process.env, MARU_SLIDES_KHOA_GHI: [SRC, FAKE_LOCKED].join(","), MARU_SLIDES_AUDIT_LOG: path.join(ROOT, "so-vet", "so-vet-ghi.jsonl") };
const client = new Client({ name: "kiem-maru-slides", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(ROOT, "src/slides-server.js")], env, stderr: "inherit" }));

const log = [];
async function call(name, args, { expectError = false, note = "" } = {}) {
  const t0 = Date.now();
  let text, isError;
  try {
    const r = await client.callTool({ name, arguments: args });
    text = r.content?.[0]?.text || ""; isError = !!r.isError;
  } catch (e) { text = "NÉM LỖI: " + e.message; isError = true; }
  const pass = expectError ? isError : !isError;
  log.push({ name, note, pass, expectError, ms: Date.now() - t0, out: text.slice(0, 400) });
  fs.writeFileSync(path.join(OUT, "ket-qua.json"), JSON.stringify(log, null, 1));
  return { text, isError, json: () => JSON.parse(text) };
}

const auth = await getAuthClient();
const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });

// 0. Danh sách công cụ
const tools = (await client.listTools()).tools.map((t) => t.name);
fs.writeFileSync(path.join(OUT, "cong-cu.json"), JSON.stringify(tools));

// 1. Bản sao [ĐO] vào My Drive (root) của chủ token, không có quyền chia sẻ nào thêm
const cp = await call("copy_presentation", { sourceId: SRC, title: "[ĐO] maru-slides-mcp thử", folderId: "root" });
const D = cp.text.match(/: ([\w-]{20,})/)[1];
const perms = (await drive.permissions.list({ fileId: D, fields: "permissions(role,type)" })).data.permissions;
fs.writeFileSync(path.join(OUT, "ban-sao.json"), JSON.stringify({ id: D, quyen: perms.map((p) => `${p.type}:${p.role}`) }));

// 2. Đọc
const full = (await call("get_presentation", { presentationId: D, fromPage: 1, toPage: 500, maxTextChars: 80 })).json();
fs.writeFileSync(path.join(OUT, "deck-doc.json"), JSON.stringify(full));
await call("get_presentation", { presentationId: D, fromPage: 2, toPage: 3 }, { note: "giới hạn trang 2-3" });
const layouts = (await call("get_layouts", { presentationId: D })).json();
await call("list_revisions", { presentationId: D, maxRevisions: 3 });

const s1 = full.slides[0];
const flat = (els) => els.flatMap((e) => [e, ...(e.children ? flat(e.children) : [])]);
const allEls = full.slides.flatMap((s) => flat(s.elements).map((e) => ({ ...e, slide: s.id })));
let target = flat(s1.elements).find((e) => e.text && !e.kind?.startsWith("TABLE") && !e.kind?.startsWith("GROUP")) || allEls.find((e) => e.text && e.kind && !e.kind.startsWith("TABLE"));
const tSlide = target.slide || s1.id;

// 3. Ảnh TRƯỚC
await call("get_thumbnail", { presentationId: D, pageObjectId: tSlide, outPath: path.join(OUT, "truoc.png") });

// 4. Sửa chữ một khối + khoanh đỏ ngay trên bản sao
await call("update_text", { presentationId: D, objectId: target.id, text: "[ĐO] chữ đã sửa bằng maru-slides-mcp" });
await call("update_text_style", { presentationId: D, objectId: target.id, bold: true, colorHex: "#C00000", fontSize: 20 });
await call("update_text_style", { presentationId: D, objectId: target.id, startIndex: 0, endIndex: 4, italic: true, linkUrl: "https://example.com" }, { note: "khoảng chữ + link" });
await call("update_paragraph_style", { presentationId: D, objectId: target.id, alignment: "CENTER", lineSpacing: 115, spaceBelowPt: 4 });
const unit = "PT", pad = 6;
const ring = (await call("insert_element", { presentationId: D, pageObjectId: tSlide, element: { type: "shape", shapeType: "ROUND_RECTANGLE", unit, x: target.x - pad, y: target.y - pad, w: target.w + 2 * pad, h: target.h + 2 * pad, outlineHex: "#FF0000", outlineWeightPt: 3 } })).json();
await call("batch_update", { presentationId: D, requests: [{ updateShapeProperties: { objectId: ring.objectId, shapeProperties: { shapeBackgroundFill: { propertyState: "NOT_RENDERED" } }, fields: "shapeBackgroundFill.propertyState" } }] }, { note: "nền trong suốt cho vòng đỏ" });
const label = (await call("insert_element", { presentationId: D, pageObjectId: tSlide, element: { type: "text", unit, x: Math.max(0, target.x - pad), y: target.y + target.h + pad + 2, w: 300, h: 26, text: "ĐÃ SỬA: update_text + update_text_style", fontSize: 12, bold: true, colorHex: "#FFFFFF", fillHex: "#FF0000" } })).json();
await call("set_z_order", { presentationId: D, objectIds: [ring.objectId, label.objectId], operation: "BRING_TO_FRONT" });
await call("get_thumbnail", { presentationId: D, pageObjectId: tSlide, outPath: path.join(OUT, "sau.png") });

// 5. replace_text: chạy thử, chặn lọt-trong-từ, ghi thật giới hạn trang
await call("replace_text", { presentationId: D, find: "đã sửa", replaceWith: "đã thay", dryRun: true });
const word = allEls.map((e) => e.text || "").join(" ").match(/[A-Za-zÀ-ỹ]{7,}/u)?.[0] || "maruslides";
await call("replace_text", { presentationId: D, find: word.slice(2, 5), replaceWith: "XYZ" }, { note: `chặn cụm "${word.slice(2, 5)}" lọt trong "${word}" (kết quả phải là KHÔNG GHI)` });
await call("replace_text", { presentationId: D, find: "đã sửa", replaceWith: "đã thay", pageObjectIds: [tSlide] });

// 6. Ghi chú người nói
await call("update_speaker_notes", { presentationId: D, pageObjectId: tSlide, text: "[ĐO] ghi chú người nói ghi bằng maru-slides-mcp" });

// 7. Trang: tạo theo layout, nhân bản, đổi thứ tự, nền
const lay = layouts.flatMap((m) => m.layouts).find((l) => l.placeholders.some((p) => p.startsWith("TITLE"))) || layouts[0].layouts[0];
const ph = lay.placeholders.find((p) => p.startsWith("TITLE"));
const ns = (await call("create_slide", { presentationId: D, layoutId: lay.layoutId, placeholders: ph ? [{ type: ph.split("#")[0], index: Number(ph.split("#")[1]), text: "[ĐO] Trang tạo theo layout" }] : [] })).json();
const dup = (await call("duplicate_slide", { presentationId: D, pageObjectId: tSlide, insertionIndex: 1 })).json();
await call("move_slide", { presentationId: D, pageObjectIds: [dup.newSlideId], insertionIndex: full.slideCount + 2 });
await call("set_page_background", { presentationId: D, pageObjectIds: [ns.slideId], colorHex: "#FFF4E5" });

// 8. Dựng trang từ JSON (chữ, hình, đường mũi tên, ảnh, bảng, video), một batchUpdate
const built = (await call("build_slide_from_json", { presentationId: D, spec: { unit: "PCT", background: "#FFFFFF", elements: [
  { type: "text", x: 5, y: 5, w: 90, h: 12, text: "[ĐO] Trang dựng từ JSON", fontSize: 28, bold: true, colorHex: "#C00000" },
  { type: "text", x: 5, y: 20, w: 40, h: 30, text: "Ý một\nÝ hai\nÝ ba", fontSize: 16, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
  { type: "shape", shapeType: "ROUND_RECTANGLE", x: 50, y: 20, w: 20, h: 15, fillHex: "#1F6FB2", text: "Hình khối", colorHex: "#FFFFFF", alignment: "CENTER", contentAlignment: "MIDDLE" },
  { type: "shape", shapeType: "ELLIPSE", x: 75, y: 20, w: 15, h: 15, fillHex: "#2E9E5B" },
  { type: "line", x1: 70, y1: 27, x2: 75, y2: 27, colorHex: "#333333", weightPt: 2, endArrow: "FILL_ARROW" },
  { type: "image", url: PUBLIC_IMG, x: 5, y: 55, w: 25, h: 10, altTitle: "Logo thử", altDescription: "ảnh công khai" },
  { type: "table", x: 35, y: 55, w: 35, h: 20, data: [["Cột A", "Cột B"], ["1", "2"], ["3", "4"]], cellStyle: { fontSize: 12 } },
  { type: "video", youtubeId: "M7lc1UVf-VE", x: 75, y: 55, w: 20, h: 20 },
] } })).json();
const [bTitle, , bShape, bEllipse, , bImg, bTable] = built.elementIds;
const P2 = built.pageObjectId;

// 9. Khối: chèn đơn lẻ, đổi vị trí, xoay, lật, alt, nhóm, lớp
const box = (await call("insert_element", { presentationId: D, pageObjectId: P2, element: { type: "shape", shapeType: "STAR_5", unit: "PCT", x: 8, y: 80, w: 1, h: 1, fillHex: "#F2B705" } })).json();
await call("move_resize", { presentationId: D, objectId: bImg, x: 0.5, y: 4.2, w: 2.5, unit: "IN" });
await call("transform_element", { presentationId: D, objectId: bShape, rotateDeg: 10 });
await call("transform_element", { presentationId: D, objectId: box.objectId, flipHorizontal: true, flipVertical: true });
await call("move_resize", { presentationId: D, objectId: bShape, w: 2.2 }, { note: "đổi rộng khối đang xoay" });
await call("set_alt_text", { presentationId: D, objectId: bEllipse, title: "Vòng xanh", description: "[ĐO] mô tả ảnh" });
const grp = (await call("group_elements", { presentationId: D, objectIds: [bEllipse, box.objectId] })).json();
await call("ungroup_elements", { presentationId: D, groupObjectIds: [grp.groupId] });
await call("set_z_order", { presentationId: D, objectIds: [bEllipse], operation: "SEND_TO_BACK" });

// 10. Bảng
await call("table_edit", { presentationId: D, tableObjectId: bTable, action: "insert_rows", index: 2, number: 1 });
await call("table_edit", { presentationId: D, tableObjectId: bTable, action: "insert_columns", index: 1, number: 1 });
await call("table_edit", { presentationId: D, tableObjectId: bTable, action: "delete_row", index: 3 }, { expectError: true, note: "thiếu cờ xác nhận, phải bị chặn" });
await call("table_edit", { presentationId: D, tableObjectId: bTable, action: "delete_row", index: 3, confirm: CONFIRM });
await call("write_table_cells", { presentationId: D, tableObjectId: bTable, cells: [{ row: 0, col: 2, text: "Cột C" }, { row: 1, col: 0, text: "10" }, { row: 2, col: 2, text: "mới" }] });
await call("merge_table_cells", { presentationId: D, tableObjectId: bTable, row: 2, col: 0, rowSpan: 1, colSpan: 2 });
await call("merge_table_cells", { presentationId: D, tableObjectId: bTable, row: 2, col: 0, rowSpan: 1, colSpan: 2, unmerge: true });
await call("style_table_cells", { presentationId: D, tableObjectId: bTable, row: 0, col: 0, rowSpan: 1, colSpan: 3, fillHex: "#C00000", contentAlignment: "MIDDLE", borderHex: "#333333", borderWeightPt: 1.5, borderPosition: "ALL" });
await call("update_text_style", { presentationId: D, objectId: bTable, row: 0, col: 0, bold: true, colorHex: "#FFFFFF" }, { note: "kiểu chữ trong ô" });

// 11. Ảnh: thay bằng URL, bằng tệp Drive (riêng tư, không mở quyền)
await call("replace_image", { presentationId: D, imageObjectId: bImg, imageUrl: PUBLIC_IMG, method: "CENTER_CROP" });
const png = fs.readFileSync(path.join(OUT, "truoc.png"));
const up = (await drive.files.create({ requestBody: { name: "[ĐO] maru-slides-mcp ảnh thử.png", parents: ["root"] }, media: { mimeType: "image/png", body: (await import("node:stream")).Readable.from(png) }, fields: "id" })).data;
// Ảnh Drive RIÊNG TƯ: Slides API không tải được, server phải báo lỗi rõ kèm hướng dẫn (không tự mở quyền)
await call("replace_image", { presentationId: D, imageObjectId: bImg, driveFileId: up.id }, { expectError: true, note: "ảnh Drive riêng tư: phải báo lỗi rõ, không đổi quyền" });

// 12. Khuôn: thay hình khối chứa {{LOGO_DO}} bằng ảnh
await call("insert_element", { presentationId: D, pageObjectId: P2, element: { type: "shape", shapeType: "RECTANGLE", unit: "PCT", x: 75, y: 80, w: 20, h: 12, text: "{{LOGO_DO}}" } });
await call("replace_shapes_with_image", { presentationId: D, containsText: "{{LOGO_DO}}", imageUrl: PUBLIC_IMG, dryRun: true });
await call("replace_shapes_with_image", { presentationId: D, containsText: "{{LOGO_DO}}", imageUrl: PUBLIC_IMG, pageObjectIds: [P2] });

// 13. Biểu đồ Sheets: tạo bảng tính [ĐO] riêng tư có một biểu đồ, nhúng LINKED, làm mới
const ss = (await sheets.spreadsheets.create({ requestBody: { properties: { title: "[ĐO] maru-slides-mcp biểu đồ thử" } }, fields: "spreadsheetId,sheets.properties.sheetId" })).data;
await sheets.spreadsheets.values.update({ spreadsheetId: ss.spreadsheetId, range: "A1:B4", valueInputOption: "RAW", requestBody: { values: [["Tháng", "Số"], ["T9", 5], ["T10", 8], ["T11", 12]] } });
const sid = ss.sheets[0].properties.sheetId;
const ch = (await sheets.spreadsheets.batchUpdate({ spreadsheetId: ss.spreadsheetId, requestBody: { requests: [{ addChart: { chart: { spec: { title: "Thử", basicChart: { chartType: "COLUMN", legendPosition: "NO_LEGEND",
  domains: [{ domain: { sourceRange: { sources: [{ sheetId: sid, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
  series: [{ series: { sourceRange: { sources: [{ sheetId: sid, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 }] } } }], headerCount: 1 } },
  position: { overlayPosition: { anchorCell: { sheetId: sid, rowIndex: 0, columnIndex: 3 } } } } } }] } })).data;
const chartId = ch.replies[0].addChart.chart.chartId;
const chart = (await call("insert_element", { presentationId: D, pageObjectId: ns.slideId, element: { type: "chart", spreadsheetId: ss.spreadsheetId, chartId, x: 1, y: 1.5, w: 5, h: 3 } })).json();
await call("refresh_sheets_chart", { presentationId: D, chartObjectId: chart.objectId });

// 14. Xoá khối: thiếu cờ, xoá trang (phải từ chối), xoá đúng
await call("delete_elements", { presentationId: D, objectIds: [bTitle], confirm: "co" }, { expectError: true, note: "sai cờ" });
await call("delete_elements", { presentationId: D, objectIds: [P2], confirm: CONFIRM }, { expectError: true, note: "là TRANG, phải từ chối" });
await call("batch_update", { presentationId: D, requests: [{ deleteObject: { objectId: P2 } }], confirm: CONFIRM }, { expectError: true, note: "xoá trang qua batch_update, phải từ chối" });
await call("batch_update", { presentationId: D, requests: [{ deleteObject: { objectId: bTitle } }] }, { expectError: true, note: "xoá khối qua batch thiếu cờ" });
await call("delete_elements", { presentationId: D, objectIds: [label.objectId === bTitle ? bTitle : bTitle], confirm: CONFIRM });

// 15. Khoá ghi: deck trong danh sách khoá phải bị từ chối TRƯỚC khi gọi mạng (dùng id giả, không đụng deck nguồn)
await call("update_text", { presentationId: FAKE_LOCKED, objectId: "x", text: "y" }, { expectError: true, note: "deck bị khoá ghi" });
await call("move_slide", { presentationId: FAKE_LOCKED, pageObjectIds: ["x"], insertionIndex: 0 }, { expectError: true, note: "deck bị khoá ghi" });

// 16. Xuất
await call("export_pdf", { presentationId: D, outPath: path.join(OUT, "ban-sao.pdf") });
await call("export_pptx", { presentationId: D, outPath: path.join(OUT, "ban-sao.pptx") });
await call("export_thumbnails", { presentationId: D, outDir: path.join(OUT, "anh-trang"), size: "SMALL", columns: 5 });
await call("create_presentation", { title: "[ĐO] maru-slides-mcp deck trống" });
await call("get_thumbnail", { presentationId: D, pageObjectId: P2, outPath: path.join(OUT, "trang-dung-tu-json.png") });
await call("get_thumbnail", { presentationId: D, pageObjectId: ns.slideId, outPath: path.join(OUT, "trang-co-bieu-do.png") });

await client.close();
const called = new Set(log.map((l) => l.name));
const missing = tools.filter((t) => !called.has(t));
const fail = log.filter((l) => !l.pass);
fs.writeFileSync(path.join(OUT, "tom-tat.json"), JSON.stringify({ banSao: D, anhDrive: up.id, bangTinh: ss.spreadsheetId, congCu: tools.length, luotGoi: log.length, dat: log.length - fail.length, truot: fail.map((f) => f.name + ": " + f.out.slice(0, 200)), chuaGoi: missing }, null, 1));
console.log(`Công cụ: ${tools.length} · lượt gọi: ${log.length} · đạt: ${log.length - fail.length} · trượt: ${fail.length} · chưa gọi: ${missing.length ? missing.join(",") : 0}`);
fail.forEach((f) => console.log(`  TRƯỢT ${f.name} (${f.note}): ${f.out.slice(0, 160)}`));
process.exit(fail.length || missing.length ? 1 : 0);
