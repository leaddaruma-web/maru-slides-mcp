#!/usr/bin/env node
// Kiểm trước khi commit: chặn tệp khoá bị stage, và quét nội dung stage tìm chuỗi giống token/khoá.
import { execSync } from "node:child_process";

const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const blockedNames = ["credentials.json", "token.json", "client_secret.json", ".env"];
const badFiles = staged.filter((f) =>
  blockedNames.some((b) => f.endsWith(b)) || f.endsWith(".jsonl") || f.startsWith("so-vet/"));

// Mẫu chuỗi bí mật hay gặp của Google. Chỉ in tên tệp và loại mẫu, không in chuỗi khớp.
const patterns = [
  ["access token Google", /ya29\.[0-9A-Za-z_\-]{20,}/],
  ["refresh token Google", /\b1\/\/0[0-9A-Za-z_\-]{20,}/],
  ["client secret Google", /GOCSPX-[0-9A-Za-z_\-]{10,}/],
  ["API key Google", /AIza[0-9A-Za-z_\-]{30,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const hits = [];
for (const f of staged) {
  let body = "";
  try { body = execSync(`git show :${JSON.stringify(f).slice(1, -1)}`, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }); }
  catch { continue; }
  for (const [name, re] of patterns) if (re.test(body)) hits.push(`${f} (${name})`);
}

if (badFiles.length || hits.length) {
  console.error("\n🚫 CHẶN: không được commit tệp chứa khoá hoặc sổ vết:");
  [...badFiles, ...hits].forEach((f) => console.error(`   - ${f}`));
  console.error("\nGỡ khỏi stage bằng: git reset HEAD <tệp>\n");
  process.exit(1);
}
console.log(`✓ check-secrets: ${staged.length} tệp đã stage, không thấy khoá.`);
