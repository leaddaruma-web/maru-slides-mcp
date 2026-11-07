// Đăng nhập Google cho maru-slides-mcp. KHÔNG in token, khoá hay client secret ra đâu cả.
//
// Ba cách nạp, theo thứ tự ưu tiên:
// 1) MARU_SLIDES_TOKEN_HELPER + MARU_SLIDES_TOKEN_FILE: gọi hàm layAccessToken({duongToken, client}) của một
//    mô-đun có sẵn trên máy (mô-đun tự làm mới token và tự ghi lại tệp).
// 2) MARU_SLIDES_TOKEN_FILE: tệp token dạng phẳng {access_token, refresh_token, ...} hoặc bọc {token:{...}}.
// 3) Mặc định: credentials.json + token.json ở thư mục gốc (tạo bằng `npm run auth`), giống maru-docs-mcp.
// MARU_SLIDES_CREDENTIALS: đường tới credentials.json (mặc định thư mục gốc).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { google } from "googleapis";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRED_PATH = process.env.MARU_SLIDES_CREDENTIALS || path.join(ROOT, "credentials.json");
const TOKEN_PATH = path.join(ROOT, "token.json");
const PORT = 4573;

export const SCOPES = [
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
];

function readClient() {
  if (!fs.existsSync(CRED_PATH)) {
    throw new Error("Thiếu credentials.json: tải OAuth Desktop client từ Google Cloud, đặt vào " + ROOT);
  }
  const raw = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
  const c = raw.installed || raw.web;
  const redirect = (c.redirect_uris || []).find((u) => u.startsWith("http://localhost")) || `http://localhost:${PORT}/oauth2callback`;
  return { client_id: c.client_id, client_secret: c.client_secret, redirect };
}

function writePrivate(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export async function getAuthClient() {
  const c = readClient();
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect);
  const tokenFile = process.env.MARU_SLIDES_TOKEN_FILE;
  const helper = process.env.MARU_SLIDES_TOKEN_HELPER;

  if (tokenFile && helper) {
    const mod = await import(pathToFileURL(helper).href);
    if (typeof mod.layAccessToken !== "function") throw new Error("Mô-đun token không có hàm layAccessToken");
    const fresh = async () => {
      const access_token = await mod.layAccessToken({ duongToken: tokenFile, client: c });
      const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
      const expiry_date = Number((saved.token || saved).expiry_date) || Date.now() + 30 * 60000;
      return { access_token, expiry_date };
    };
    o.setCredentials(await fresh());
    o.refreshHandler = fresh; // không có refresh_token trong bộ nhớ, hết hạn thì gọi lại helper
    return o;
  }

  const p = tokenFile || TOKEN_PATH;
  if (!fs.existsSync(p)) throw new Error("Chưa có token.json: chạy `npm run auth` một lần để cấp quyền.");
  const saved = JSON.parse(fs.readFileSync(p, "utf8"));
  const wrapped = !!saved.token;
  o.setCredentials(wrapped ? saved.token : saved);
  o.on("tokens", (t) => {
    try {
      const cur = JSON.parse(fs.readFileSync(p, "utf8"));
      const merged = { ...(wrapped ? cur.token : cur), ...t };
      writePrivate(p, wrapped ? { ...cur, token: merged } : merged);
    } catch { /* ghi lại hỏng thì lần sau làm mới tiếp, không in gì */ }
  });
  return o;
}

async function runConsentFlow() {
  const c = readClient();
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, `http://localhost:${PORT}/oauth2callback`);
  const url = o.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  console.log("\n1) Mở địa chỉ sau trong trình duyệt, đăng nhập rồi bấm Cho phép:\n\n" + url + "\n");
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
        res.end(code ? "Đã nhận mã. Quay lại terminal, đóng tab này được." : "Đang chờ mã...");
        if (code) { server.close(); resolve(code); }
      } catch (e) { reject(e); }
    }).listen(PORT, () => console.log(`2) Đang chờ Google chuyển về http://localhost:${PORT} ...`));
  });
  const { tokens } = await o.getToken(code);
  writePrivate(TOKEN_PATH, tokens);
  console.log("\n✓ Đã lưu token.json (quyền 600). MCP server dùng được.\n");
}

if (process.argv[1]?.endsWith("auth.js")) {
  runConsentFlow().catch((e) => { console.error("LỖI auth:", e.message); process.exit(1); });
}
