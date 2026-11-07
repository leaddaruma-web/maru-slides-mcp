// MCP server đọc và sửa Google Slides TẠI CHỖ qua Slides API v1 (+ Drive v3 cho sao chép, xuất tệp, lịch sử).
// Luật: không có công cụ xoá trang hay xoá tệp, không đổi quyền chia sẻ. Xoá khối/hàng/cột cần cờ xác nhận.
// Mọi lệnh ghi được ghi sổ vết jsonl cục bộ. Không in token hay khoá ra đâu cả.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { google } from "googleapis";
import { getAuthClient } from "./auth.js";
import * as L from "./slides-lib.js";
import { contactSheet } from "./png-ghep.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = process.env.MARU_SLIDES_AUDIT_LOG || path.join(ROOT, "so-vet", "so-vet-ghi.jsonl");
const LOCKED = new Set((process.env.MARU_SLIDES_KHOA_GHI || "").split(",").map((s) => s.trim()).filter(Boolean));
const CONFIRM = "TOI_XAC_NHAN_XOA";
const READ_ONLY = new Set(["get_presentation", "get_layouts", "get_thumbnail", "export_thumbnails", "export_pdf", "export_pptx", "list_revisions"]);

const auth = await getAuthClient();
const slides = google.slides({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });
const server = new McpServer({ name: "mcp-maru-slides", version: "1.0.0" });

// ── Hàm dùng chung ──

const errMsg = (e) => e?.response?.data?.error?.message || e?.message || String(e);

/** Đăng ký công cụ: bọc lỗi, trả chữ hoặc JSON gọn. */
function tool(name, desc, shape, fn) {
  server.tool(name, desc, shape, async (args) => {
    try {
      // Deck bị khoá: từ chối NGAY, trước cả lệnh đọc, với mọi công cụ không chỉ-đọc.
      if (args.presentationId && !READ_ONLY.has(name)) assertWritable(args.presentationId);
      const r = await fn(args);
      return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }] };
    } catch (e) {
      const m = errMsg(e);
      return { isError: true, content: [{ type: "text", text: "LỖI: " + m + (/provided image was forbidden|retrieving the image/i.test(m) ? IMG_FORBIDDEN_HINT : "") }] };
    }
  });
}

function audit(entry) {
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  fs.appendFileSync(AUDIT, JSON.stringify({ thoi_gian: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

function assertWritable(id) {
  if (LOCKED.has(id)) throw new Error(`Deck ${id} nằm trong danh sách khoá ghi (MARU_SLIDES_KHOA_GHI). Không gửi lệnh nào.`);
}

/** Mọi lệnh ghi lên deck đi qua đây: kiểm khoá, gửi batchUpdate, ghi sổ vết. */
async function write(presentationId, toolName, requests, note) {
  assertWritable(presentationId);
  if (!requests.length) throw new Error("Không có request nào để gửi");
  const res = await slides.presentations.batchUpdate({ presentationId, requestBody: { requests } });
  audit({ deck: presentationId, cong_cu: toolName, so_request: requests.length, loai: [...new Set(requests.map((r) => Object.keys(r)[0]))], ghi_chu: note });
  return res.data.replies || [];
}

const getPres = async (presentationId, fields) => (await slides.presentations.get({ presentationId, fields })).data;

/** Khi không chỉ layout: lấy layout tên "Blank/Trống", không có thì layout ít placeholder nhất của master đầu. */
async function layoutRef(presentationId, layoutId, predefinedLayout) {
  if (layoutId) return { layoutId };
  if (predefinedLayout) return { predefinedLayout };
  const p = await getPres(presentationId, "masters/objectId,layouts(objectId,layoutProperties,pageElements/shape/placeholder)");
  const ls = (p.layouts || []).filter((l) => l.layoutProperties?.masterObjectId === p.masters?.[0]?.objectId);
  const blank = ls.find((l) => /blank|trống/i.test(l.layoutProperties?.displayName || "") || l.layoutProperties?.name === "BLANK");
  const pick = blank || ls.sort((a, b) => (a.pageElements || []).filter((e) => e.shape?.placeholder).length - (b.pageElements || []).filter((e) => e.shape?.placeholder).length)[0];
  return pick ? { layoutId: pick.objectId } : { predefinedLayout: "BLANK" };
}
const pageSizeOf = (id) => getPres(id, "pageSize").then((p) => p.pageSize);

/** Tệp ảnh trên Drive → địa chỉ tải. Slides chỉ tải được ảnh CÔNG KHAI; server không tự mở quyền tệp. */
async function imageUrl({ imageUrl, driveFileId }) {
  if (imageUrl) return imageUrl;
  if (!driveFileId) throw new Error("Cần imageUrl hoặc driveFileId");
  const f = (await drive.files.get({ fileId: driveFileId, fields: "mimeType", supportsAllDrives: true })).data;
  if (!String(f.mimeType).startsWith("image/")) throw new Error(`Tệp Drive ${driveFileId} không phải ảnh (${f.mimeType})`);
  return `https://drive.google.com/uc?export=download&id=${driveFileId}`;
}
const IMG_FORBIDDEN_HINT = " (Slides API chỉ tải được ảnh công khai. Ảnh trên Drive phải để chế độ 'Bất kỳ ai có đường liên kết'; server này không tự đổi quyền chia sẻ, người có quyền phải bật tay, hoặc dùng URL công khai khác.)";

async function saveStream(res, outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const buf = Buffer.from(res.data);
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

async function thumbnailPng(presentationId, pageObjectId, size = "LARGE") {
  const t = await slides.presentations.pages.getThumbnail({
    presentationId, pageObjectId, "thumbnailProperties.thumbnailSize": size, "thumbnailProperties.mimeType": "PNG",
  });
  const r = await fetch(t.data.contentUrl, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Tải ảnh trang lỗi ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const rgbHex = (c) => "#" + ["red", "green", "blue"].map((k) => Math.round((c?.[k] || 0) * 255).toString(16).padStart(2, "0")).join("");

// Tham số dùng lại
const P = z.string().describe("ID deck: docs.google.com/presentation/d/{presentationId}/edit");
const unit = z.enum(["IN", "PT", "CM", "PCT"]).optional().describe("Đơn vị toạ độ, mặc định IN. PCT = phần trăm khổ trang");
const styleShape = {
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), strikethrough: z.boolean().optional(),
  fontFamily: z.string().optional(), fontSize: z.number().optional().describe("pt"), colorHex: z.string().optional(),
  highlightHex: z.string().optional(), linkUrl: z.string().optional(), linkSlideId: z.string().optional(),
};
const paraShape = {
  alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(), lineSpacing: z.number().optional().describe("% (100 = đơn)"),
  spaceAbovePt: z.number().optional(), spaceBelowPt: z.number().optional(), indentStartPt: z.number().optional(), indentFirstLinePt: z.number().optional(),
  bulletPreset: z.string().optional().describe("Vd BULLET_DISC_CIRCLE_SQUARE, NUMBERED_DIGIT_ALPHA_ROMAN"),
};
const cellShape = { row: z.number().optional().describe("Hàng (từ 0) nếu khối là bảng"), col: z.number().optional() };
const cellLoc = (row, col) => (row !== undefined ? { cellLocation: { rowIndex: row, columnIndex: col ?? 0 } } : {});
const elementSpec = z.object({}).passthrough();

// ── ĐỌC ──

tool("get_presentation", "Đọc deck: khổ trang, số trang, mỗi trang các khối (id, loại, vị trí và kích thước pt, chữ, cỡ chữ) và ghi chú người nói. Giới hạn trang để khỏi trả quá dài.", {
  presentationId: P,
  fromPage: z.number().optional().describe("Trang bắt đầu, đếm từ 1. Mặc định 1"),
  toPage: z.number().optional().describe("Trang cuối. Mặc định fromPage+19"),
  pageIds: z.array(z.string()).optional().describe("Chỉ lấy các trang này (bỏ qua fromPage/toPage)"),
  maxTextChars: z.number().optional().describe("Cắt chữ mỗi khối, mặc định 200"),
  includeNotes: z.boolean().optional().describe("Mặc định true"),
}, async ({ presentationId, fromPage = 1, toPage, pageIds, maxTextChars = 200, includeNotes = true }) => {
  const p = await getPres(presentationId);
  const all = p.slides || [];
  const to = toPage ?? fromPage + 19;
  const layoutName = Object.fromEntries((p.layouts || []).map((l) => [l.objectId, l.layoutProperties?.displayName]));
  const pick = all.map((s, i) => [s, i + 1]).filter(([s, n]) => (pageIds?.length ? pageIds.includes(s.objectId) : n >= fromPage && n <= to));
  const ps = p.pageSize;
  return {
    title: p.title, presentationId, revisionId: p.revisionId,
    pageSize: { wPt: ps.width.magnitude / 12700, hPt: ps.height.magnitude / 12700, wIn: ps.width.magnitude / 914400, hIn: ps.height.magnitude / 914400 },
    slideCount: all.length, shown: pick.map(([, n]) => n).join(",") || "không có",
    slides: pick.map(([s, n]) => {
      const lid = s.slideProperties?.layoutObjectId;
      const o = { n, id: s.objectId, layout: layoutName[lid] || lid, elements: (s.pageElements || []).map((e) => L.summarizeElement(e, maxTextChars)) };
      if (includeNotes) { const nt = L.notesOf(s).text.trim(); if (nt) o.notes = nt.length > maxTextChars * 3 ? nt.slice(0, maxTextChars * 3) + "…" : nt; }
      return o;
    }),
  };
});

tool("get_layouts", "Đọc master và layout: tên, id, placeholder (loại, số thứ tự) của từng layout, bảng màu chủ đề của master.", {
  presentationId: P,
}, async ({ presentationId }) => {
  const p = await getPres(presentationId, "masters(objectId,masterProperties,pageProperties/colorScheme),layouts(objectId,layoutProperties,pageElements(objectId,shape/placeholder))");
  return (p.masters || []).map((m) => ({
    masterId: m.objectId, name: m.masterProperties?.displayName,
    themeColors: Object.fromEntries((m.pageProperties?.colorScheme?.colors || []).map((c) => [c.type, rgbHex(c.color)])),
    layouts: (p.layouts || []).filter((l) => l.layoutProperties?.masterObjectId === m.objectId).map((l) => ({
      layoutId: l.objectId, name: l.layoutProperties?.displayName,
      placeholders: (l.pageElements || []).filter((e) => e.shape?.placeholder).map((e) => `${e.shape.placeholder.type}#${e.shape.placeholder.index || 0}`),
    })),
  }));
});

tool("get_thumbnail", "Lấy ảnh một trang (PNG) và lưu ra đường dẫn chỉ định.", {
  presentationId: P, pageObjectId: z.string(), outPath: z.string().describe("Đường dẫn tệp .png"),
  size: z.enum(["LARGE", "MEDIUM", "SMALL"]).optional().describe("Mặc định LARGE (rộng 1600 px)"),
}, async ({ presentationId, pageObjectId, outPath, size }) => {
  const buf = await thumbnailPng(presentationId, pageObjectId, size);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return `✓ Lưu ảnh trang ${pageObjectId}: ${outPath} (${buf.length} byte)`;
});

tool("export_thumbnails", "Lấy ảnh mọi trang (hoặc các trang chỉ định) vào một thư mục, kèm một tờ ghép xem nhanh contact-sheet.png.", {
  presentationId: P, outDir: z.string(), pageIds: z.array(z.string()).optional(),
  size: z.enum(["LARGE", "MEDIUM", "SMALL"]).optional().describe("Mặc định MEDIUM"),
  maxPages: z.number().optional().describe("Mặc định 60"), contactSheet: z.boolean().optional().describe("Mặc định true"),
  columns: z.number().optional().describe("Số cột tờ ghép, mặc định 4"),
}, async ({ presentationId, outDir, pageIds, size = "MEDIUM", maxPages = 60, contactSheet: cs = true, columns = 4 }) => {
  const p = await getPres(presentationId, "slides/objectId");
  const ids = (p.slides || []).map((s) => s.objectId).filter((id) => !pageIds?.length || pageIds.includes(id)).slice(0, maxPages);
  fs.mkdirSync(outDir, { recursive: true });
  const bufs = [];
  for (const [i, id] of ids.entries()) {
    const b = await thumbnailPng(presentationId, id, size);
    fs.writeFileSync(path.join(outDir, `trang-${String(i + 1).padStart(3, "0")}-${id}.png`), b);
    bufs.push(b);
  }
  let sheet = "";
  if (cs && bufs.length) { sheet = path.join(outDir, "contact-sheet.png"); fs.writeFileSync(sheet, contactSheet(bufs, { columns })); }
  return `✓ Lưu ${bufs.length} ảnh trang vào ${outDir}${sheet ? `, tờ ghép: ${sheet}` : ""}`;
});

for (const [name, mime, ext] of [["export_pdf", "application/pdf", "PDF"], ["export_pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PPTX"]]) {
  tool(name, `Xuất deck ra tệp ${ext} qua Drive (tệp lớn hơn 10 MB thì tự chuyển sang đường exportLinks).`, { presentationId: P, outPath: z.string() },
    async ({ presentationId, outPath }) => {
      let res;
      try {
        res = await drive.files.export({ fileId: presentationId, mimeType: mime }, { responseType: "arraybuffer" });
      } catch (e) {
        if (!/too large/i.test(errMsg(e))) throw e;
        const link = (await drive.files.get({ fileId: presentationId, fields: "exportLinks", supportsAllDrives: true })).data.exportLinks?.[mime];
        if (!link) throw e;
        res = await auth.request({ url: link, responseType: "arraybuffer" });
      }
      return `✓ Xuất ${ext}: ${outPath} (${await saveStream(res, outPath)} byte)`;
    });
}

tool("list_revisions", "Đọc lịch sử phiên bản (giờ sửa, người sửa) và bình luận của deck qua Drive API. Gọi trước khi ghi để biết có ai vừa sửa.", {
  presentationId: P, maxRevisions: z.number().optional().describe("Mặc định 10 bản gần nhất"),
  includeComments: z.boolean().optional().describe("Mặc định true"),
}, async ({ presentationId, maxRevisions = 10, includeComments = true }) => {
  const f = (await drive.files.get({ fileId: presentationId, fields: "name,modifiedTime,lastModifyingUser(displayName,emailAddress)", supportsAllDrives: true })).data;
  const revs = [];
  let pageToken;
  do {
    const r = (await drive.revisions.list({ fileId: presentationId, pageSize: 200, pageToken, fields: "nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))" })).data;
    revs.push(...(r.revisions || [])); pageToken = r.nextPageToken;
  } while (pageToken);
  const out = { name: f.name, modifiedTime: f.modifiedTime, lastModifyingUser: f.lastModifyingUser, revisionCount: revs.length,
    revisions: revs.slice(-maxRevisions).reverse().map((r) => ({ id: r.id, modifiedTime: r.modifiedTime, user: r.lastModifyingUser?.displayName, email: r.lastModifyingUser?.emailAddress })) };
  if (includeComments) {
    const c = (await drive.comments.list({ fileId: presentationId, pageSize: 100, fields: "comments(id,author(displayName),content,createdTime,modifiedTime,resolved,quotedFileContent/value,replies(author(displayName),content,createdTime))" })).data;
    out.comments = (c.comments || []).map((x) => ({ id: x.id, author: x.author?.displayName, at: x.modifiedTime || x.createdTime, resolved: !!x.resolved, quote: x.quotedFileContent?.value, content: x.content, replies: (x.replies || []).map((r) => `${r.author?.displayName}: ${r.content}`) }));
  }
  return out;
});

// ── TẠO DECK ──

tool("create_presentation", "Tạo bộ slide trống mới (tên, thư mục Drive tuỳ chọn). Không chia sẻ cho ai.", {
  title: z.string(), folderId: z.string().optional(),
}, async ({ title, folderId }) => {
  const id = (await slides.presentations.create({ requestBody: { title } })).data.presentationId;
  if (folderId) {
    const f = (await drive.files.get({ fileId: id, fields: "parents" })).data;
    await drive.files.update({ fileId: id, addParents: folderId, removeParents: (f.parents || []).join(","), supportsAllDrives: true });
  }
  audit({ deck: id, cong_cu: "create_presentation", so_request: 1, ghi_chu: title });
  return `✓ Tạo deck "${title}": ${id}\nhttps://docs.google.com/presentation/d/${id}/edit`;
});

tool("copy_presentation", "Tạo bản sao từ deck mẫu hoặc master (Drive files.copy). Bản sao riêng tư, không đổi quyền.", {
  sourceId: z.string(), title: z.string(), folderId: z.string().optional(),
}, async ({ sourceId, title, folderId }) => {
  const r = (await drive.files.copy({ fileId: sourceId, supportsAllDrives: true, fields: "id", requestBody: { name: title, ...(folderId ? { parents: [folderId] } : {}) } })).data;
  audit({ deck: r.id, cong_cu: "copy_presentation", so_request: 1, ghi_chu: `sao từ ${sourceId}` });
  return `✓ Bản sao "${title}": ${r.id}\nhttps://docs.google.com/presentation/d/${r.id}/edit`;
});

// ── TRANG ──

tool("create_slide", "Tạo trang mới theo layout của master (layoutId lấy từ get_layouts, hoặc predefinedLayout), điền chữ vào placeholder.", {
  presentationId: P, layoutId: z.string().optional(),
  predefinedLayout: z.string().optional().describe("Vd BLANK, TITLE, TITLE_AND_BODY, SECTION_HEADER (chỉ dùng khi deck có layout này)"),
  insertionIndex: z.number().optional().describe("Vị trí chèn, đếm từ 0. Bỏ trống = cuối"),
  placeholders: z.array(z.object({ type: z.string().describe("TITLE, BODY, SUBTITLE, CENTERED_TITLE..."), index: z.number().optional(), text: z.string() })).optional(),
}, async ({ presentationId, layoutId, predefinedLayout, insertionIndex, placeholders = [] }) => {
  const slideId = L.newId("slide");
  const maps = placeholders.map((p) => ({ layoutPlaceholder: { type: p.type, index: p.index || 0 }, objectId: L.newId("ph") }));
  const req = [{ createSlide: { objectId: slideId, ...(insertionIndex !== undefined ? { insertionIndex } : {}),
    slideLayoutReference: await layoutRef(presentationId, layoutId, predefinedLayout),
    ...(maps.length ? { placeholderIdMappings: maps } : {}) } }];
  placeholders.forEach((p, i) => req.push({ insertText: { objectId: maps[i].objectId, text: p.text } }));
  await write(presentationId, "create_slide", req);
  return { slideId, placeholderIds: maps.map((m) => m.objectId) };
});

tool("duplicate_slide", "Nhân bản một trang (giữ mọi khối), tuỳ chọn đặt bản mới vào vị trí khác.", {
  presentationId: P, pageObjectId: z.string(), insertionIndex: z.number().optional().describe("Đếm từ 0"),
}, async ({ presentationId, pageObjectId, insertionIndex }) => {
  const newId = L.newId("slide");
  const req = [{ duplicateObject: { objectId: pageObjectId, objectIds: { [pageObjectId]: newId } } }];
  if (insertionIndex !== undefined) req.push({ updateSlidesPosition: { slideObjectIds: [newId], insertionIndex } });
  await write(presentationId, "duplicate_slide", req);
  return { newSlideId: newId };
});

tool("move_slide", "Đổi thứ tự trang: đưa các trang chỉ định tới vị trí mới (đếm từ 0, tính trên thứ tự TRƯỚC khi chuyển).", {
  presentationId: P, pageObjectIds: z.array(z.string()), insertionIndex: z.number(),
}, async ({ presentationId, pageObjectIds, insertionIndex }) => {
  await write(presentationId, "move_slide", [{ updateSlidesPosition: { slideObjectIds: pageObjectIds, insertionIndex } }]);
  return `✓ Chuyển ${pageObjectIds.length} trang tới vị trí ${insertionIndex}`;
});

tool("set_page_background", "Đặt nền trang: màu (#RRGGBB) hoặc ảnh (URL hoặc tệp Drive) kéo giãn.", {
  presentationId: P, pageObjectIds: z.array(z.string()), colorHex: z.string().optional(), imageUrl: z.string().optional(), driveFileId: z.string().optional(),
}, async ({ presentationId, pageObjectIds, colorHex, imageUrl: u, driveFileId }) => {
  const fill = colorHex ? L.solid(colorHex) : { stretchedPictureFill: { contentUrl: await imageUrl({ imageUrl: u, driveFileId }) } };
  await write(presentationId, "set_page_background", pageObjectIds.map((objectId) => ({ updatePageProperties: { objectId, pageProperties: { pageBackgroundFill: fill }, fields: "pageBackgroundFill" } })));
  return `✓ Đặt nền cho ${pageObjectIds.length} trang`;
});

tool("build_slide_from_json", "Dựng nhanh cả trang trong MỘT batchUpdate từ mô tả JSON. spec = {newSlide?:{layoutId?|predefinedLayout?, insertionIndex?}, pageObjectId?, unit?:'IN'|'PT'|'CM'|'PCT', background?:'#hex'|{imageUrl|driveFileId}, elements:[...]}. Mỗi element như insert_element: {type:'text'|'shape'|'image'|'line'|'table'|'video'|'chart', x,y,w,h, ...}.", {
  presentationId: P, spec: z.object({}).passthrough(),
}, async ({ presentationId, spec }) => {
  const ps = await pageSizeOf(presentationId);
  const req = [];
  let pageId = spec.pageObjectId;
  if (!pageId) {
    pageId = L.newId("slide");
    const ns = spec.newSlide || {};
    req.push({ createSlide: { objectId: pageId, ...(ns.insertionIndex !== undefined ? { insertionIndex: ns.insertionIndex } : {}),
      slideLayoutReference: await layoutRef(presentationId, ns.layoutId, ns.predefinedLayout) } });
  }
  if (spec.background) {
    const fill = typeof spec.background === "string" ? L.solid(spec.background) : { stretchedPictureFill: { contentUrl: await imageUrl(spec.background) } };
    req.push({ updatePageProperties: { objectId: pageId, pageProperties: { pageBackgroundFill: fill }, fields: "pageBackgroundFill" } });
  }
  const ids = [];
  for (const el of spec.elements || []) {
    const e = { unit: spec.unit, ...el };
    if (e.type === "image") e.url = await imageUrl({ imageUrl: e.url || e.imageUrl, driveFileId: e.driveFileId });
    const b = L.buildElement(pageId, e, ps);
    ids.push(b.id); req.push(...b.requests);
  }
  await write(presentationId, "build_slide_from_json", req, `${ids.length} khối`);
  return { pageObjectId: pageId, elementIds: ids, requests: req.length };
});

// ── CHỮ ──

tool("replace_text", "Thay chữ khắp deck (replaceAllText). Có chạy thử (chỉ đếm), giới hạn theo trang, và CHẶN khi cụm nằm lọt trong từ dài hơn (vd 'cue' trong 'Rescue') trừ khi allowInsideWord=true.", {
  presentationId: P, find: z.string(), replaceWith: z.string(), matchCase: z.boolean().optional().describe("Mặc định true"),
  pageObjectIds: z.array(z.string()).optional().describe("Chỉ thay trên các trang này (không gồm ghi chú)"),
  dryRun: z.boolean().optional().describe("true = chỉ đếm, không ghi"), allowInsideWord: z.boolean().optional(),
}, async ({ presentationId, find, replaceWith, matchCase = true, pageObjectIds, dryRun, allowInsideWord }) => {
  const pres = await getPres(presentationId);
  const c = L.countMatches(L.collectTexts(pres, pageObjectIds), find, matchCase);
  const head = `Khớp ${c.total} chỗ "${find}"${c.insideWord ? `, trong đó ${c.insideWord} chỗ nằm lọt trong từ dài hơn:\n  ${c.samples.join("\n  ")}` : ""}`;
  if (dryRun) return `CHẠY THỬ, không ghi. ${head}`;
  if (c.insideWord && !allowInsideWord) return `⚠️ KHÔNG GHI. ${head}\nViết cụm dài hơn để khỏi đụng nhầm, hoặc gọi lại với allowInsideWord=true nếu chắc chắn.`;
  const rep = await write(presentationId, "replace_text", [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replaceWith, ...(pageObjectIds?.length ? { pageObjectIds } : {}) } }], `"${find}" → "${replaceWith}"`);
  const changed = rep[0]?.replaceAllText?.occurrencesChanged || 0;
  const after = L.countMatches(L.collectTexts(await getPres(presentationId), pageObjectIds), find, matchCase).total;
  return `✓ Thay ${changed} chỗ "${find}" → "${replaceWith}". Đếm lại sau khi thay: còn ${after} chỗ.`;
});

/** Request thay toàn bộ chữ của một khối (hoặc một ô bảng). */
async function setTextRequests(presentationId, objectId, text, row, col) {
  const f = L.findElement(await getPres(presentationId), objectId);
  if (!f) throw new Error(`Không thấy khối ${objectId}`);
  const t = row !== undefined ? f.el.table?.tableRows?.[row]?.tableCells?.[col ?? 0]?.text : f.el.shape?.text;
  const base = { objectId, ...cellLoc(row, col) };
  const req = [];
  if (L.plainText(t).length) req.push({ deleteText: { ...base, textRange: { type: "ALL" } } });
  if (text) req.push({ insertText: { ...base, text, insertionIndex: 0 } });
  return req;
}

tool("update_text", "Thay TOÀN BỘ chữ của một khối (hoặc một ô bảng) theo objectId. Kiểu chữ đầu khối được giữ.", {
  presentationId: P, objectId: z.string(), text: z.string(), ...cellShape,
}, async ({ presentationId, objectId, text, row, col }) => {
  await write(presentationId, "update_text", await setTextRequests(presentationId, objectId, text, row, col), objectId);
  return `✓ Ghi ${text.length} ký tự vào ${objectId}`;
});

tool("update_text_style", "Đổi kiểu chữ (cỡ, đậm, nghiêng, gạch, màu, tô nền, phông, link) cho cả khối hoặc khoảng [startIndex, endIndex).", {
  presentationId: P, objectId: z.string(), startIndex: z.number().optional(), endIndex: z.number().optional(), ...cellShape, ...styleShape,
}, async ({ presentationId, objectId, startIndex, endIndex, row, col, ...o }) => {
  const ts = L.textStyleOf(o);
  if (!ts.fields) throw new Error("Chưa chọn kiểu nào để đổi");
  await write(presentationId, "update_text_style", [{ updateTextStyle: { objectId, ...cellLoc(row, col), textRange: L.textRange(startIndex, endIndex), style: ts.style, fields: ts.fields } }]);
  return `✓ Đổi ${ts.fields} cho ${objectId}`;
});

tool("update_paragraph_style", "Kiểu đoạn: căn lề, giãn dòng, khoảng trước/sau, thụt lề, gạch đầu dòng hoặc số thứ tự (bulletPreset), bỏ gạch đầu dòng.", {
  presentationId: P, objectId: z.string(), startIndex: z.number().optional(), endIndex: z.number().optional(), ...cellShape, ...paraShape,
  removeBullets: z.boolean().optional(),
}, async ({ presentationId, objectId, startIndex, endIndex, row, col, removeBullets, bulletPreset, ...o }) => {
  const base = { objectId, ...cellLoc(row, col), textRange: L.textRange(startIndex, endIndex) };
  const ps = L.paragraphStyleOf(o), req = [];
  if (ps.fields) req.push({ updateParagraphStyle: { ...base, style: ps.style, fields: ps.fields } });
  if (bulletPreset) req.push({ createParagraphBullets: { ...base, bulletPreset } });
  if (removeBullets) req.push({ deleteParagraphBullets: base });
  await write(presentationId, "update_paragraph_style", req, objectId);
  return `✓ Kiểu đoạn ${objectId}: ${[ps.fields, bulletPreset, removeBullets && "bỏ bullet"].filter(Boolean).join(", ")}`;
});

tool("update_speaker_notes", "Ghi (thay toàn bộ) ghi chú người nói của một trang.", {
  presentationId: P, pageObjectId: z.string(), text: z.string(),
}, async ({ presentationId, pageObjectId, text }) => {
  const s = (await getPres(presentationId)).slides.find((x) => x.objectId === pageObjectId);
  if (!s) throw new Error(`Không thấy trang ${pageObjectId}`);
  const n = L.notesOf(s), req = [];
  if (n.text.length) req.push({ deleteText: { objectId: n.notesShapeId, textRange: { type: "ALL" } } });
  if (text) req.push({ insertText: { objectId: n.notesShapeId, text, insertionIndex: 0 } });
  await write(presentationId, "update_speaker_notes", req, pageObjectId);
  return `✓ Ghi chú trang ${pageObjectId}: ${text.length} ký tự`;
});

// ── KHỐI ──

tool("insert_element", "Chèn một khối lên trang. element = {type, x, y, w, h, unit?} và theo loại: text {text, fontSize, bold, colorHex, fontFamily, alignment, bulletPreset, fillHex}; shape {shapeType (RECTANGLE, ROUND_RECTANGLE, ELLIPSE, RIGHT_ARROW, STAR_5, WEDGE_RECTANGLE_CALLOUT... mọi shapeType API), fillHex, outlineHex, outlineWeightPt, text...}; line {x1,y1,x2,y2, category STRAIGHT|BENT|CURVED, colorHex, weightPt, dashStyle, startArrow, endArrow (vd FILL_ARROW)}; image {url | driveFileId}; video {youtubeId | driveFileId}; table {rows, cols, data:[[...]], cellStyle}; chart {spreadsheetId, chartId, linked}. Thêm altTitle/altDescription nếu cần.", {
  presentationId: P, pageObjectId: z.string(), element: elementSpec,
}, async ({ presentationId, pageObjectId, element }) => {
  const e = { ...element };
  if (e.type === "image") e.url = await imageUrl({ imageUrl: e.url || e.imageUrl, driveFileId: e.driveFileId });
  const b = L.buildElement(pageObjectId, e, await pageSizeOf(presentationId));
  await write(presentationId, "insert_element", b.requests, e.type);
  return { objectId: b.id, type: e.type };
});

tool("replace_image", "Thay ảnh theo objectId bằng URL hoặc tệp Drive. Giữ nguyên vị trí và kích thước khung.", {
  presentationId: P, imageObjectId: z.string(), imageUrl: z.string().optional(), driveFileId: z.string().optional(),
  method: z.enum(["CENTER_INSIDE", "CENTER_CROP"]).optional().describe("Mặc định CENTER_INSIDE (vừa khung, không cắt)"),
}, async ({ presentationId, imageObjectId, imageUrl: u, driveFileId, method = "CENTER_INSIDE" }) => {
  await write(presentationId, "replace_image", [{ replaceImage: { imageObjectId, url: await imageUrl({ imageUrl: u, driveFileId }), imageReplaceMethod: method } }], imageObjectId);
  return `✓ Thay ảnh ${imageObjectId}`;
});

tool("replace_shapes_with_image", "Thay mọi hình khối có chứa một chuỗi chữ (vd {{LOGO}}) bằng ảnh, để dựng theo khuôn. Có chạy thử.", {
  presentationId: P, containsText: z.string(), imageUrl: z.string().optional(), driveFileId: z.string().optional(), matchCase: z.boolean().optional(),
  method: z.enum(["CENTER_INSIDE", "CENTER_CROP"]).optional(), pageObjectIds: z.array(z.string()).optional(), dryRun: z.boolean().optional(),
}, async ({ presentationId, containsText, imageUrl: u, driveFileId, matchCase = true, method = "CENTER_INSIDE", pageObjectIds, dryRun }) => {
  if (dryRun) {
    const n = L.collectTexts(await getPres(presentationId), pageObjectIds).filter((t) => !t.where.includes("ghi chú") && (matchCase ? t.text : t.text.toLowerCase()).includes(matchCase ? containsText : containsText.toLowerCase())).length;
    return `CHẠY THỬ, không ghi. ${n} khối chứa "${containsText}" (gồm cả ô bảng; API chỉ thay hình khối)`;
  }
  const rep = await write(presentationId, "replace_shapes_with_image", [{ replaceAllShapesWithImage: { containsText: { text: containsText, matchCase }, imageUrl: await imageUrl({ imageUrl: u, driveFileId }), imageReplaceMethod: method, ...(pageObjectIds?.length ? { pageObjectIds } : {}) } }], containsText);
  return `✓ Thay ${rep[0]?.replaceAllShapesWithImage?.occurrencesChanged || 0} hình khối bằng ảnh`;
});

/** Ma trận biến đổi hiện tại của khối (EMU) + kích thước gốc. */
async function elementMatrix(presentationId, objectId) {
  const f = L.findElement(await getPres(presentationId), objectId);
  if (!f) throw new Error(`Không thấy khối ${objectId}`);
  const t = f.el.transform || {}, s = f.el.size || {};
  const k = (u) => (u === "PT" ? 12700 : 1);
  return { sx: t.scaleX ?? 1, sy: t.scaleY ?? 1, hx: t.shearX ?? 0, hy: t.shearY ?? 0, tx: (t.translateX || 0) * k(t.unit), ty: (t.translateY || 0) * k(t.unit),
    w: (s.width?.magnitude || 0) * k(s.width?.unit), h: (s.height?.magnitude || 0) * k(s.height?.unit) };
}

tool("move_resize", "Đổi vị trí (x, y góc trên trái) và/hoặc kích thước (w, h) của khối. Giữ nguyên góc xoay.", {
  presentationId: P, objectId: z.string(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), unit,
}, async ({ presentationId, objectId, x, y, w, h, unit: u = "IN" }) => {
  const m = await elementMatrix(presentationId, objectId), ps = await pageSizeOf(presentationId);
  const curW = Math.hypot(m.sx, m.hy) * m.w, curH = Math.hypot(m.hx, m.sy) * m.h;
  const fx = w !== undefined && curW ? L.toEmu(w, u, "x", ps) / curW : 1;
  const fy = h !== undefined && curH ? L.toEmu(h, u, "y", ps) / curH : 1;
  const transform = { scaleX: m.sx * fx, shearY: m.hy * fx, shearX: m.hx * fy, scaleY: m.sy * fy,
    translateX: x !== undefined ? L.toEmu(x, u, "x", ps) : m.tx, translateY: y !== undefined ? L.toEmu(y, u, "y", ps) : m.ty, unit: "EMU" };
  await write(presentationId, "move_resize", [{ updatePageElementTransform: { objectId, applyMode: "ABSOLUTE", transform } }], objectId);
  return `✓ ${objectId}: x=${x ?? "giữ"} y=${y ?? "giữ"} w=${w ?? "giữ"} h=${h ?? "giữ"} (${u})`;
});

tool("transform_element", "Xoay (độ, theo chiều kim đồng hồ) và/hoặc lật ngang, lật dọc một khối quanh tâm của nó.", {
  presentationId: P, objectId: z.string(), rotateDeg: z.number().optional(), flipHorizontal: z.boolean().optional(), flipVertical: z.boolean().optional(),
}, async ({ presentationId, objectId, rotateDeg = 0, flipHorizontal, flipVertical }) => {
  const m = await elementMatrix(presentationId, objectId);
  const cx = m.sx * m.w / 2 + m.hx * m.h / 2 + m.tx, cy = m.hy * m.w / 2 + m.sy * m.h / 2 + m.ty;
  const r = (rotateDeg * Math.PI) / 180, fh = flipHorizontal ? -1 : 1, fv = flipVertical ? -1 : 1;
  // Op = Xoay · Lật
  const a = Math.cos(r) * fh, b = -Math.sin(r) * fv, c = Math.sin(r) * fh, d = Math.cos(r) * fv;
  const transform = { scaleX: a, shearX: b, shearY: c, scaleY: d, translateX: cx - (a * cx + b * cy), translateY: cy - (c * cx + d * cy), unit: "EMU" };
  await write(presentationId, "transform_element", [{ updatePageElementTransform: { objectId, applyMode: "RELATIVE", transform } }], objectId);
  return `✓ ${objectId}: xoay ${rotateDeg}°${flipHorizontal ? ", lật ngang" : ""}${flipVertical ? ", lật dọc" : ""}`;
});

tool("set_alt_text", "Ghi mô tả ảnh (alt text: tiêu đề + mô tả) cho một khối.", {
  presentationId: P, objectId: z.string(), title: z.string().optional(), description: z.string().optional(),
}, async ({ presentationId, objectId, title, description }) => {
  await write(presentationId, "set_alt_text", [{ updatePageElementAltText: { objectId, title, description } }], objectId);
  return `✓ Alt text ${objectId}`;
});

tool("group_elements", "Nhóm nhiều khối trên cùng một trang thành một nhóm.", {
  presentationId: P, objectIds: z.array(z.string()).min(2),
}, async ({ presentationId, objectIds }) => {
  const groupId = L.newId("group");
  await write(presentationId, "group_elements", [{ groupObjects: { groupObjectId: groupId, childrenObjectIds: objectIds } }]);
  return { groupId };
});

tool("ungroup_elements", "Bỏ nhóm (các khối con giữ nguyên trên trang).", {
  presentationId: P, groupObjectIds: z.array(z.string()),
}, async ({ presentationId, groupObjectIds }) => {
  await write(presentationId, "ungroup_elements", [{ ungroupObjects: { objectIds: groupObjectIds } }]);
  return `✓ Bỏ nhóm ${groupObjectIds.length}`;
});

tool("set_z_order", "Đổi thứ tự lớp của khối: BRING_TO_FRONT, BRING_FORWARD, SEND_BACKWARD, SEND_TO_BACK.", {
  presentationId: P, objectIds: z.array(z.string()), operation: z.enum(["BRING_TO_FRONT", "BRING_FORWARD", "SEND_BACKWARD", "SEND_TO_BACK"]),
}, async ({ presentationId, objectIds, operation }) => {
  await write(presentationId, "set_z_order", [{ updatePageElementsZOrder: { pageElementObjectIds: objectIds, operation } }]);
  return `✓ ${operation} cho ${objectIds.length} khối`;
});

tool("delete_elements", `Xoá KHỐI trên trang (không xoá được trang). Bắt buộc confirm="${CONFIRM}". Ghi sổ vết từng id.`, {
  presentationId: P, objectIds: z.array(z.string()).min(1), confirm: z.string(),
}, async ({ presentationId, objectIds, confirm }) => {
  if (confirm !== CONFIRM) throw new Error(`Thiếu cờ xác nhận. Gọi lại với confirm="${CONFIRM}" nếu thật sự muốn xoá.`);
  const pages = L.pageIdsOf(await getPres(presentationId));
  const bad = objectIds.filter((id) => pages.has(id));
  if (bad.length) throw new Error(`Từ chối: ${bad.join(", ")} là TRANG. Công cụ này không xoá trang.`);
  await write(presentationId, "delete_elements", objectIds.map((objectId) => ({ deleteObject: { objectId } })), `xoá khối: ${objectIds.join(",")}`);
  return `✓ Xoá ${objectIds.length} khối (đã ghi sổ vết). Khôi phục: Tệp > Lịch sử phiên bản trên Google Slides.`;
});

// ── BẢNG ──

tool("table_edit", `Thêm hoặc bớt hàng, cột của bảng. Bớt (delete_row, delete_column) cần confirm="${CONFIRM}".`, {
  presentationId: P, tableObjectId: z.string(), action: z.enum(["insert_rows", "insert_columns", "delete_row", "delete_column"]),
  index: z.number().describe("Hàng hoặc cột mốc (từ 0)"), number: z.number().optional().describe("Số hàng/cột thêm, mặc định 1"),
  after: z.boolean().optional().describe("Thêm sau mốc (mặc định true)"), confirm: z.string().optional(),
}, async ({ presentationId, tableObjectId, action, index, number = 1, after = true, confirm }) => {
  const isRow = action.includes("row");
  const cellLocation = isRow ? { rowIndex: index, columnIndex: 0 } : { rowIndex: 0, columnIndex: index };
  let req;
  if (action === "insert_rows") req = { insertTableRows: { tableObjectId, cellLocation, insertBelow: after, number } };
  else if (action === "insert_columns") req = { insertTableColumns: { tableObjectId, cellLocation, insertRight: after, number } };
  else {
    if (confirm !== CONFIRM) throw new Error(`Bớt hàng/cột cần confirm="${CONFIRM}"`);
    req = isRow ? { deleteTableRow: { tableObjectId, cellLocation } } : { deleteTableColumn: { tableObjectId, cellLocation } };
  }
  await write(presentationId, "table_edit", [req], `${action} ${index}`);
  return `✓ ${action} tại ${index}`;
});

tool("write_table_cells", "Ghi chữ vào nhiều ô bảng: cells = [{row, col, text}] (thay toàn bộ chữ của ô).", {
  presentationId: P, tableObjectId: z.string(), cells: z.array(z.object({ row: z.number(), col: z.number(), text: z.string() })),
}, async ({ presentationId, tableObjectId, cells }) => {
  const f = L.findElement(await getPres(presentationId), tableObjectId);
  if (!f?.el.table) throw new Error(`${tableObjectId} không phải bảng`);
  const req = [];
  for (const { row, col, text } of cells) {
    const base = { objectId: tableObjectId, cellLocation: { rowIndex: row, columnIndex: col } };
    if (L.plainText(f.el.table.tableRows[row]?.tableCells[col]?.text).length) req.push({ deleteText: { ...base, textRange: { type: "ALL" } } });
    if (text) req.push({ insertText: { ...base, text, insertionIndex: 0 } });
  }
  await write(presentationId, "write_table_cells", req, `${cells.length} ô`);
  return `✓ Ghi ${cells.length} ô`;
});

const tableRange = (row, col, rowSpan = 1, colSpan = 1) => ({ location: { rowIndex: row, columnIndex: col }, rowSpan, columnSpan: colSpan });

tool("merge_table_cells", "Gộp (hoặc tách lại nếu unmerge=true) một vùng ô bảng.", {
  presentationId: P, tableObjectId: z.string(), row: z.number(), col: z.number(), rowSpan: z.number(), colSpan: z.number(), unmerge: z.boolean().optional(),
}, async ({ presentationId, tableObjectId, row, col, rowSpan, colSpan, unmerge }) => {
  const k = unmerge ? "unmergeTableCells" : "mergeTableCells";
  await write(presentationId, "merge_table_cells", [{ [k]: { objectId: tableObjectId, tableRange: tableRange(row, col, rowSpan, colSpan) } }]);
  return `✓ ${unmerge ? "Tách" : "Gộp"} ô (${row},${col}) ${rowSpan}x${colSpan}`;
});

tool("style_table_cells", "Kiểu ô bảng cho một vùng: màu nền, căn dọc nội dung, viền (màu, độ dày, kiểu, vị trí viền).", {
  presentationId: P, tableObjectId: z.string(), row: z.number(), col: z.number(), rowSpan: z.number().optional(), colSpan: z.number().optional(),
  fillHex: z.string().optional(), contentAlignment: z.enum(["TOP", "MIDDLE", "BOTTOM"]).optional(),
  borderHex: z.string().optional(), borderWeightPt: z.number().optional(), borderDash: z.string().optional(),
  borderPosition: z.enum(["ALL", "BOTTOM", "INNER", "INNER_HORIZONTAL", "INNER_VERTICAL", "LEFT", "OUTER", "RIGHT", "TOP"]).optional(),
  columnWidthIn: z.number().optional().describe("Đặt độ rộng cột col (inch)"),
}, async ({ presentationId, tableObjectId, row, col, rowSpan, colSpan, fillHex, contentAlignment, borderHex, borderWeightPt, borderDash, borderPosition = "ALL", columnWidthIn }) => {
  const range = tableRange(row, col, rowSpan, colSpan), req = [];
  const cp = {}, cf = [];
  if (fillHex) { cp.tableCellBackgroundFill = L.solid(fillHex); cf.push("tableCellBackgroundFill.solidFill.color"); }
  if (contentAlignment) { cp.contentAlignment = contentAlignment; cf.push("contentAlignment"); }
  if (cf.length) req.push({ updateTableCellProperties: { objectId: tableObjectId, tableRange: range, tableCellProperties: cp, fields: cf.join(",") } });
  const bp = {}, bf = [];
  if (borderHex) { bp.tableBorderFill = L.solid(borderHex); bf.push("tableBorderFill.solidFill.color"); }
  if (borderWeightPt !== undefined) { bp.weight = { magnitude: borderWeightPt, unit: "PT" }; bf.push("weight"); }
  if (borderDash) { bp.dashStyle = borderDash; bf.push("dashStyle"); }
  if (bf.length) req.push({ updateTableBorderProperties: { objectId: tableObjectId, tableRange: range, borderPosition, tableBorderProperties: bp, fields: bf.join(",") } });
  if (columnWidthIn) req.push({ updateTableColumnProperties: { objectId: tableObjectId, columnIndices: [col], tableColumnProperties: { columnWidth: { magnitude: columnWidthIn * 914400, unit: "EMU" } }, fields: "columnWidth" } });
  await write(presentationId, "style_table_cells", req, tableObjectId);
  return `✓ Kiểu ô bảng: ${[...cf, ...bf, columnWidthIn && "columnWidth"].filter(Boolean).join(", ")}`;
});

// ── BIỂU ĐỒ ──

tool("refresh_sheets_chart", "Làm mới biểu đồ nhúng từ Google Sheets (chỉ biểu đồ kiểu LINKED). Chèn biểu đồ: insert_element type=chart.", {
  presentationId: P, chartObjectId: z.string(),
}, async ({ presentationId, chartObjectId }) => {
  await write(presentationId, "refresh_sheets_chart", [{ refreshSheetsChart: { objectId: chartObjectId } }]);
  return `✓ Làm mới biểu đồ ${chartObjectId}`;
});

// ── NÂNG CAO ──

const DESTRUCTIVE = ["deleteObject", "deleteTableRow", "deleteTableColumn"];
tool("batch_update", `Gửi thẳng mảng requests của Slides API (cho người biết dùng). Lệnh xoá khối/hàng/cột cần confirm="${CONFIRM}"; xoá TRANG luôn bị từ chối.`, {
  presentationId: P, requests: z.array(z.object({}).passthrough()).min(1), confirm: z.string().optional(),
}, async ({ presentationId, requests, confirm }) => {
  const kinds = requests.map((r) => Object.keys(r)[0]);
  if (kinds.some((k) => DESTRUCTIVE.includes(k))) {
    const pages = L.pageIdsOf(await getPres(presentationId));
    const bad = requests.filter((r) => r.deleteObject && pages.has(r.deleteObject.objectId)).map((r) => r.deleteObject.objectId);
    if (bad.length) throw new Error(`Từ chối: ${bad.join(", ")} là TRANG. Không có đường xoá trang.`);
    if (confirm !== CONFIRM) throw new Error(`Có lệnh xoá (${kinds.filter((k) => DESTRUCTIVE.includes(k)).join(", ")}). Cần confirm="${CONFIRM}".`);
  }
  const rep = await write(presentationId, "batch_update", requests, kinds.join(","));
  return { requests: requests.length, replies: rep };
});

await server.connect(new StdioServerTransport());
