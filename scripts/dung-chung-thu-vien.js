#!/usr/bin/env node
// Trên máy chủ Daruma: dùng chung bộ thư viện ĐÃ CÀI của maru-docs-mcp (cùng ba gói, cùng phiên bản),
// để khỏi tải gói mới về khi chưa được duyệt. Máy khác thì chạy `npm install` như bình thường.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dich = path.join(ROOT, "node_modules");
const nguon = process.argv[2] || path.join(ROOT, "..", "maru-docs-mcp", "node_modules");

if (fs.existsSync(dich)) { console.log("Đã có thư mục thư viện, không làm gì."); process.exit(0); }
if (!fs.existsSync(nguon)) { console.error("Không thấy thư viện nguồn: " + nguon); process.exit(1); }
fs.symlinkSync(nguon, dich, "dir");
console.log("✓ Đã nối thư viện dùng chung: " + dich + " → " + nguon);
