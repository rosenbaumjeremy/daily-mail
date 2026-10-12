// Local preview: a study site and the worker on one port, with a fake Gmail
// that prints each email. node test/dev.mjs <aliyah|tanach|mishna> [port]
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import worker, { setConnect } from "../src/worker.js";
import { fakeGmail } from "./fake-gmail.mjs";

const site = process.argv[2] || "aliyah";
const port = Number(process.argv[3] || 8790);
const root = fileURLToPath(new URL("../../", import.meta.url)) + { aliyah: "aliyah-site", tanach: "tanach-site", mishna: "mishna-site" }[site] + "/site/";

const sql = new DatabaseSync(":memory:");
const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a),
  run: async () => { sql.prepare(q).run(...args); return {}; },
  first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }) });
const DB = { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } };
// a fake Gmail that prints each email instead of sending it
const outbox = [];
outbox.push = (...mails) => { for (const m of mails) console.log(`[mail] to ${m.to} — ${m.subject}
${m.text}
`); return 0; };
setConnect(fakeGmail({ user: "test@gmail.com", password: "test", outbox }));
const env = { DB, PUBLIC_URL: `http://localhost:${port}`, GMAIL_USER: "test@gmail.com", GMAIL_APP_PASSWORD: "test", SEND_HOUR: "7" };
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (["/options", "/subscribe", "/confirm", "/m", "/u"].includes(url.pathname)) {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
    const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let path = root + (url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
  if (!existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
  let data = readFileSync(path);
  // same origin here, so the page talks to this server instead of the deployed worker
  if (path.endsWith("mail.js")) data = data.toString().replace(/const API = "[^"]*"/, 'const API = ""');
  res.writeHead(200, { "Content-Type": TYPES[path.split(".").pop()] || "application/octet-stream",
    // the live CSP, so a style or script it would block fails here too
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'" });
  res.end(data);
}).listen(port, () => console.log(`${site} on http://localhost:${port}`));
