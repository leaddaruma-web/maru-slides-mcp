// Hàm thuần dùng chung: đơn vị, màu, mã khối, dựng request, tóm tắt deck. Không gọi mạng.
import crypto from "node:crypto";

export const EMU = { IN: 914400, PT: 12700, CM: 360000 };

export const newId = (p = "maru") => `${p}_${crypto.randomBytes(6).toString("hex")}`;

export function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Màu không hợp lệ: ${hex} (cần dạng #RRGGBB)`);
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}
export const solid = (hex) => ({ solidFill: { color: { rgbColor: hexToRgb(hex) } } });
export const opaque = (hex) => ({ opaqueColor: { rgbColor: hexToRgb(hex) } });

/** Đổi một giá trị sang EMU. unit: IN | PT | CM | PCT (PCT tính theo chiều rộng/cao trang). */
export function toEmu(v, unit = "IN", axis = "x", pageSize) {
  if (v === undefined || v === null) return undefined;
  if (unit === "PCT") {
    const base = axis === "x" ? pageSize.width.magnitude : pageSize.height.magnitude;
    return Math.round((v / 100) * base);
  }
  const k = EMU[unit];
  if (!k) throw new Error(`Đơn vị không hỗ trợ: ${unit}`);
  return Math.round(v * k);
}

/** elementProperties cho khối mới: x,y,w,h theo đơn vị. */
export function elementProps(pageObjectId, box, pageSize) {
  const u = box.unit || "IN";
  const w = toEmu(box.w, u, "x", pageSize), h = toEmu(box.h, u, "y", pageSize);
  return {
    pageObjectId,
    size: { width: { magnitude: w, unit: "EMU" }, height: { magnitude: h, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: toEmu(box.x ?? 0, u, "x", pageSize), translateY: toEmu(box.y ?? 0, u, "y", pageSize), unit: "EMU" },
  };
}

/** Kiểu chữ từ tham số gọn → {style, fields}. */
export function textStyleOf(o = {}) {
  const s = {}, f = [];
  const set = (k, v) => { s[k] = v; f.push(k); };
  if (o.bold !== undefined) set("bold", o.bold);
  if (o.italic !== undefined) set("italic", o.italic);
  if (o.underline !== undefined) set("underline", o.underline);
  if (o.strikethrough !== undefined) set("strikethrough", o.strikethrough);
  if (o.fontFamily) set("fontFamily", o.fontFamily);
  if (o.fontSize) set("fontSize", { magnitude: o.fontSize, unit: "PT" });
  if (o.colorHex) set("foregroundColor", opaque(o.colorHex));
  if (o.highlightHex) set("backgroundColor", opaque(o.highlightHex));
  if (o.linkUrl) set("link", { url: o.linkUrl });
  if (o.linkSlideId) set("link", { pageObjectId: o.linkSlideId });
  return { style: s, fields: f.join(",") };
}

export function paragraphStyleOf(o = {}) {
  const s = {}, f = [];
  const pt = (v) => ({ magnitude: v, unit: "PT" });
  if (o.alignment) { s.alignment = o.alignment; f.push("alignment"); }
  if (o.lineSpacing) { s.lineSpacing = o.lineSpacing; f.push("lineSpacing"); }
  if (o.spaceAbovePt !== undefined) { s.spaceAbove = pt(o.spaceAbovePt); f.push("spaceAbove"); }
  if (o.spaceBelowPt !== undefined) { s.spaceBelow = pt(o.spaceBelowPt); f.push("spaceBelow"); }
  if (o.indentStartPt !== undefined) { s.indentStart = pt(o.indentStartPt); f.push("indentStart"); }
  if (o.indentFirstLinePt !== undefined) { s.indentFirstLine = pt(o.indentFirstLinePt); f.push("indentFirstLine"); }
  return { style: s, fields: f.join(",") };
}

export const textRange = (start, end) =>
  start === undefined && end === undefined ? { type: "ALL" }
    : end === undefined ? { type: "FROM_START_INDEX", startIndex: start }
      : { type: "FIXED_RANGE", startIndex: start ?? 0, endIndex: end };

/** Request chèn chữ + kiểu chữ + kiểu đoạn + gạch đầu dòng cho một khối vừa tạo. */
export function textRequests(objectId, el, cellLocation) {
  const out = [];
  if (!el.text) return out;
  const base = cellLocation ? { objectId, cellLocation } : { objectId };
  out.push({ insertText: { ...base, text: el.text, insertionIndex: 0 } });
  const ts = textStyleOf(el);
  if (ts.fields) out.push({ updateTextStyle: { ...base, textRange: { type: "ALL" }, style: ts.style, fields: ts.fields } });
  const ps = paragraphStyleOf(el);
  if (ps.fields) out.push({ updateParagraphStyle: { ...base, textRange: { type: "ALL" }, style: ps.style, fields: ps.fields } });
  if (el.bulletPreset) out.push({ createParagraphBullets: { ...base, textRange: { type: "ALL" }, bulletPreset: el.bulletPreset } });
  return out;
}

/** Dựng request cho một khối theo mô tả gọn. Trả {id, requests}. Dùng cho insert_* và build_slide_from_json. */
export function buildElement(pageId, el, pageSize) {
  const id = el.objectId || newId(el.type);
  const props = () => elementProps(pageId, el, pageSize);
  const r = [];
  switch (el.type) {
    case "text":
    case "shape": {
      r.push({ createShape: { objectId: id, shapeType: el.type === "text" ? "TEXT_BOX" : (el.shapeType || "RECTANGLE"), elementProperties: props() } });
      const sp = {}, f = [];
      if (el.fillHex) { sp.shapeBackgroundFill = solid(el.fillHex); f.push("shapeBackgroundFill.solidFill.color"); }
      if (el.outlineHex) { sp.outline = { outlineFill: solid(el.outlineHex) }; f.push("outline.outlineFill.solidFill.color"); }
      if (el.outlineWeightPt) { sp.outline = { ...(sp.outline || {}), weight: { magnitude: el.outlineWeightPt, unit: "PT" } }; f.push("outline.weight"); }
      if (el.contentAlignment) { sp.contentAlignment = el.contentAlignment; f.push("contentAlignment"); }
      if (f.length) r.push({ updateShapeProperties: { objectId: id, shapeProperties: sp, fields: f.join(",") } });
      r.push(...textRequests(id, el));
      break;
    }
    case "image": {
      if (!el.url) throw new Error("Khối ảnh cần url (đã đổi từ driveFileId trước khi gọi)");
      r.push({ createImage: { objectId: id, url: el.url, elementProperties: props() } });
      break;
    }
    case "video": {
      const source = el.youtubeId ? "YOUTUBE" : "DRIVE";
      r.push({ createVideo: { objectId: id, source, id: el.youtubeId || el.driveFileId, elementProperties: props() } });
      break;
    }
    case "line": {
      const u = el.unit || "IN";
      const x1 = toEmu(el.x1, u, "x", pageSize), y1 = toEmu(el.y1, u, "y", pageSize);
      const x2 = toEmu(el.x2, u, "x", pageSize), y2 = toEmu(el.y2, u, "y", pageSize);
      const w = Math.max(Math.abs(x2 - x1), 1), h = Math.max(Math.abs(y2 - y1), 1);
      r.push({ createLine: { objectId: id, category: el.category || "STRAIGHT", elementProperties: {
        pageObjectId: pageId,
        size: { width: { magnitude: w, unit: "EMU" }, height: { magnitude: h, unit: "EMU" } },
        // Lật để hướng đường kẻ đi từ (x1,y1) tới (x2,y2).
        transform: { scaleX: x2 >= x1 ? 1 : -1, scaleY: y2 >= y1 ? 1 : -1, translateX: x1, translateY: y1, unit: "EMU" },
      } } });
      const lp = {}, f = [];
      if (el.colorHex) { lp.lineFill = solid(el.colorHex); f.push("lineFill.solidFill.color"); }
      if (el.weightPt) { lp.weight = { magnitude: el.weightPt, unit: "PT" }; f.push("weight"); }
      if (el.dashStyle) { lp.dashStyle = el.dashStyle; f.push("dashStyle"); }
      if (el.startArrow) { lp.startArrow = el.startArrow; f.push("startArrow"); }
      if (el.endArrow) { lp.endArrow = el.endArrow; f.push("endArrow"); }
      if (f.length) r.push({ updateLineProperties: { objectId: id, lineProperties: lp, fields: f.join(",") } });
      break;
    }
    case "table": {
      const rows = el.rows || el.data?.length, cols = el.cols || el.data?.[0]?.length;
      if (!rows || !cols) throw new Error("Bảng cần rows/cols hoặc data");
      r.push({ createTable: { objectId: id, rows, columns: cols, elementProperties: props() } });
      (el.data || []).forEach((row, ri) => row.forEach((txt, ci) => {
        if (txt !== null && txt !== undefined && String(txt) !== "") {
          r.push(...textRequests(id, { ...el.cellStyle, text: String(txt) }, { rowIndex: ri, columnIndex: ci }));
        }
      }));
      break;
    }
    case "chart": {
      r.push({ createSheetsChart: { objectId: id, spreadsheetId: el.spreadsheetId, chartId: el.chartId,
        linkingMode: el.linked === false ? "NOT_LINKED_IMAGE" : "LINKED", elementProperties: props() } });
      break;
    }
    default: throw new Error(`Loại khối không hỗ trợ: ${el.type}`);
  }
  if (el.altTitle || el.altDescription) {
    r.push({ updatePageElementAltText: { objectId: id, title: el.altTitle, description: el.altDescription } });
  }
  return { id, requests: r };
}

// ── Đọc deck ──

export const plainText = (t) => (t?.textElements || []).map((e) => e.textRun?.content || "").join("");
const firstFontSize = (t) => (t?.textElements || []).find((e) => e.textRun?.style?.fontSize)?.textRun.style.fontSize.magnitude;

/** Hộp bao của khối (pt), góc xoay (độ). */
export function geometry(el) {
  const t = el.transform || {}, s = el.size || {};
  const conv = (u) => (u === "PT" ? 12700 : 1); // đưa về EMU
  const w = (s.width?.magnitude || 0) * conv(s.width?.unit);
  const h = (s.height?.magnitude || 0) * conv(s.height?.unit);
  const sx = t.scaleX ?? 1, sy = t.scaleY ?? 1, hx = t.shearX ?? 0, hy = t.shearY ?? 0;
  const tx = (t.translateX || 0) * conv(t.unit), ty = (t.translateY || 0) * conv(t.unit);
  const pt = (v) => Math.round((v / 12700) * 10) / 10;
  return {
    x: pt(tx), y: pt(ty),
    w: pt(Math.hypot(sx, hy) * w), h: pt(Math.hypot(hx, sy) * h),
    rot: Math.round((Math.atan2(hy, sx) * 180) / Math.PI),
  };
}

export function summarizeElement(el, maxChars) {
  const g = geometry(el);
  const o = { id: el.objectId, x: g.x, y: g.y, w: g.w, h: g.h };
  if (g.rot) o.rot = g.rot;
  const cut = (s) => (s.length > maxChars ? s.slice(0, maxChars) + "…" : s);
  if (el.shape) {
    o.kind = el.shape.placeholder ? `placeholder:${el.shape.placeholder.type}` : el.shape.shapeType;
    const txt = plainText(el.shape.text);
    if (txt.trim()) { o.text = cut(txt.replace(/\n$/, "")); const fs = firstFontSize(el.shape.text); if (fs) o.fontSize = fs; }
  } else if (el.image) { o.kind = "IMAGE"; }
  else if (el.video) { o.kind = `VIDEO:${el.video.source}`; }
  else if (el.line) { o.kind = `LINE:${el.line.lineCategory || el.line.lineType}`; }
  else if (el.sheetsChart) { o.kind = "SHEETS_CHART"; o.spreadsheetId = el.sheetsChart.spreadsheetId; }
  else if (el.table) {
    o.kind = `TABLE ${el.table.rows}x${el.table.columns}`;
    o.cells = el.table.tableRows.map((r) => r.tableCells.map((c) => cut(plainText(c.text).trim())));
  } else if (el.elementGroup) {
    o.kind = "GROUP";
    o.children = el.elementGroup.children.map((c) => summarizeElement(c, maxChars));
  } else if (el.wordArt) { o.kind = "WORD_ART"; }
  if (el.title || el.description) o.alt = [el.title, el.description].filter(Boolean).join(" | ");
  return o;
}

export function notesOf(slide) {
  const np = slide.slideProperties?.notesPage;
  const id = np?.notesProperties?.speakerNotesObjectId;
  const el = (np?.pageElements || []).find((e) => e.objectId === id);
  return { notesShapeId: id, text: el ? plainText(el.shape?.text) : "" };
}

/** Mọi khối chữ trong phạm vi trang (mặt slide + ghi chú). */
export function collectTexts(pres, pageIds) {
  const out = [];
  const walk = (els, where) => (els || []).forEach((el) => {
    if (el.shape?.text) out.push({ where, text: plainText(el.shape.text) });
    if (el.table) el.table.tableRows.forEach((r) => r.tableCells.forEach((c) => out.push({ where, text: plainText(c.text) })));
    if (el.elementGroup) walk(el.elementGroup.children, where);
  });
  (pres.slides || []).forEach((s, i) => {
    if (pageIds?.length && !pageIds.includes(s.objectId)) return;
    walk(s.pageElements, `trang ${i + 1}`);
    if (!pageIds?.length) walk(s.slideProperties?.notesPage?.pageElements, `trang ${i + 1} ghi chú`);
  });
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Đếm chỗ khớp trơn và chỗ cụm nằm lọt trong từ dài hơn (vd "cue" trong "Rescue"). */
export function countMatches(texts, find, matchCase) {
  const flags = matchCase ? "gu" : "giu";
  const plain = new RegExp(esc(find), flags);
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])${esc(find)}(?![\\p{L}\\p{N}_])`, flags);
  let total = 0, inside = 0; const samples = [];
  for (const { where, text } of texts) {
    const n = (text.match(plain) || []).length;
    if (!n) continue;
    const nw = (text.match(word) || []).length;
    total += n; inside += n - nw;
    if (n - nw > 0 && samples.length < 5) {
      const i = text.search(plain);
      samples.push(`${where}: "…${text.slice(Math.max(0, i - 15), i + find.length + 15).replace(/\n/g, " ")}…"`);
    }
  }
  return { total, insideWord: inside, samples };
}

/** Các mã trang (slide, layout, master, notes) — để chặn xoá trang. */
export function pageIdsOf(pres) {
  const ids = new Set();
  for (const k of ["slides", "layouts", "masters"]) (pres[k] || []).forEach((p) => ids.add(p.objectId));
  (pres.slides || []).forEach((s) => s.slideProperties?.notesPage && ids.add(s.slideProperties.notesPage.objectId));
  if (pres.notesMaster) ids.add(pres.notesMaster.objectId);
  return ids;
}

export function findElement(pres, objectId) {
  const walk = (els, page) => {
    for (const el of els || []) {
      if (el.objectId === objectId) return { el, page };
      const c = el.elementGroup && walk(el.elementGroup.children, page);
      if (c) return c;
    }
    return null;
  };
  for (const k of ["slides", "layouts", "masters"]) {
    for (const p of pres[k] || []) {
      const f = walk(p.pageElements, p) || walk(p.slideProperties?.notesPage?.pageElements, p.slideProperties?.notesPage);
      if (f) return f;
    }
  }
  return null;
}
