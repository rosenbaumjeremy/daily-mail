// Runs the worker in Node against an in-memory database, the briefs in the
// local site folders, and a fake Resend, then writes the emails to test/out/.
//   node test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { daily, setConnect } from "../src/worker.js";
import { fakeGmail } from "./fake-gmail.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const GIT = here + "../../";
const LOCAL = {
  "https://aliyah-yomit.dailylearning.workers.dev": GIT + "aliyah-site/site/",
  "https://tanach-summaries.dailylearning.workers.dev": GIT + "tanach-site/site/",
  "https://mishna-yomit.dailylearning.workers.dev": GIT + "mishna-site/site/",
};

// D1's API over node:sqlite
const sql = new DatabaseSync(":memory:");
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  run: async () => { sql.prepare(q).run(...args); return { success: true }; },
  first: async () => sql.prepare(q).get(...args) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...args) }),
});
const DB = { prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) await s.run(); } };

const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  for (const [origin, dir] of Object.entries(LOCAL)) if (url.startsWith(origin)) {
    const path = dir + url.slice(origin.length + 1).split("?")[0];
    return existsSync(path) ? new Response(readFileSync(path)) : new Response("", { status: 404 });
  }
  throw new Error("unexpected fetch " + url);
};

const env = { DB, PUBLIC_URL: "https://daily-mail.test", GMAIL_USER: "sender@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
  FROM_NAME: "לימוד יומי", SEND_HOUR: "7", NOTIFY_EMAIL: "owner@example.com" };
const gmail = fakeGmail({ user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, outbox });
setConnect(gmail);
const call = (path, init) => worker.fetch(new Request("https://daily-mail.test" + path, init), env);
const ok = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); };
const SITE = "https://aliyah-yomit.dailylearning.workers.dev";

// options + CORS
let r = await call("/options?site=mishna&lang=he", { headers: { Origin: SITE } });
let body = await r.json();
ok(r.headers.get("Access-Control-Allow-Origin") === SITE, "CORS for a study site");
ok(body.options.map((o) => o.key).join() === "summary,text,topics,questions,sources", "mishna options");
r = await call("/options?site=aliyah", { headers: { Origin: "https://evil.example" } });
ok(!r.headers.get("Access-Control-Allow-Origin"), "no CORS for other sites");

// sign up: bad input, then good
const signup = (data) => call("/subscribe", { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE }, body: JSON.stringify(data) });
ok((await signup({ email: "nope", site: "aliyah", sections: ["summary"] })).status === 400, "bad email refused");
ok((await signup({ email: "a@b.com", site: "aliyah", sections: ["answers"] })).status === 400, "answers without questions refused");

const readers = [
  ["full@example.com", "aliyah", "he", ["summary", "questions", "answers", "sources"]],
  ["qonly@example.com", "aliyah", "en", ["questions"]],
  ["tanach@example.com", "tanach", "he", ["summary", "questions"]],
  ["mishna@example.com", "mishna", "he", ["text", "topics", "questions", "answers"]],
  ["mishna-en@example.com", "mishna", "en", ["summary", "text", "topics", "explain"]],
];
for (const [email, site, lang, sections] of readers) {
  r = await signup({ email, site, lang, sections });
  ok(r.status === 200, `signed up ${email}`);
}
ok(outbox.length === readers.length, "one confirmation email each");
ok(outbox[0].from === "לימוד יומי <sender@gmail.com>" && outbox[0].subject.startsWith("אישור הרשמה"), "from the Gmail account, Hebrew subject intact");
const code = (m) => m.html.match(/confirm\?c=([0-9a-f]+)/)[1];
for (const m of outbox.splice(0)) {
  r = await call("/confirm?c=" + code(m));
  ok(r.status === 200 && (await r.text()).includes("<h1>"), `confirmed ${m.to[0]}`);
  const notes = outbox.splice(0);
  ok(notes.length === 1 && notes[0].to[0] === "owner@example.com" && notes[0].text.includes(m.to[0])
    && !notes[0].cc && !notes[0].bcc, `owner told about ${m.to[0]}, in a separate email`);
}
ok((await call("/confirm?c=deadbeef")).status === 404, "unknown confirmation code");
for (let i = 0; i < 3; i++) await signup({ email: "flood@example.com", site: "aliyah", sections: ["summary"] });
ok((await signup({ email: "flood@example.com", site: "aliyah", sections: ["summary"] })).status === 429, "4th confirmation in a day refused");
outbox.splice(0);

// the morning send: 2026-10-11 07:30 Israel (UTC+3) = 04:30 UTC
ok((await daily(env, new Date("2026-10-11T02:30:00Z"))).length === 0, "nothing before 07:00 Israel");
let report = await daily(env, new Date("2026-10-11T04:30:00Z"));
console.log(report.join("\n"));
ok(outbox.length === readers.length, "one email per reader");
report = await daily(env, new Date("2026-10-11T05:30:00Z"));
ok(outbox.length === readers.length, "not sent twice");

const byTo = Object.fromEntries(outbox.map((m) => [m.to[0], m]));
const has = (who, text) => byTo[who].html.includes(text);
ok(has("full@example.com", "תירוץ") && has("full@example.com", "מקורות שנבדקו"), "full reader gets answers and sources");
ok(!has("qonly@example.com", "Answer 1") && !has("qonly@example.com", "Summary") && has("qonly@example.com", "Questions"), "questions-only reader");
ok(byTo["qonly@example.com"].headers["List-Unsubscribe"].includes("/u?t="), "one-click unsubscribe header");
ok(!has("mishna@example.com", "סיכום הפרק") && has("mishna@example.com", "לשון המשנה") && has("mishna@example.com", "תירוץ"), "mishna reader without summary");
ok(!has("mishna@example.com", "הסברי") && has("mishna-en@example.com", "Key terms"), "mishna topics");

mkdirSync(here + "out", { recursive: true });
for (const m of outbox) writeFileSync(here + "out/" + m.to[0].split("@")[0] + ".html", m.html);
console.log("subjects:\n  " + outbox.map((m) => m.subject).join("\n  "));

// manage + unsubscribe
const token = byTo["qonly@example.com"].headers["List-Unsubscribe"].match(/t=([0-9a-f]+)/)[1];
r = await call("/m?t=" + token);
ok((await r.text()).includes('value="questions" checked'), "manage page shows current choice");
const fd = new FormData(); fd.append("t", token); fd.append("lang", "he"); fd.append("s", "summary"); fd.append("s", "questions"); fd.append("s", "answers");
r = await call("/m", { method: "POST", body: fd });
ok((await r.text()).includes('value="answers" checked'), "manage page saves");
r = await call("/u?t=" + token);
ok((await r.text()).includes('method="post"'), "unsubscribe asks first");
r = await call("/u?t=" + token, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
ok(r.status === 200, "one-click unsubscribe");
ok((await call("/m?t=" + token)).status === 404, "gone after unsubscribing");

// a wrong app password: the sign-up reports a failure instead of pretending
setConnect(fakeGmail({ user: env.GMAIL_USER, password: "wrong", outbox }));
r = await signup({ email: "late@example.com", site: "aliyah", sections: ["summary"] });
ok(r.status === 500, "a wrong app password shows as an error");
// many readers: one connection per 40 messages; a Gmail refusal is reported, not hidden
setConnect(gmail);
for (let i = 0; i < 85; i++) sql.prepare("INSERT INTO subs VALUES (?, 'tanach', 'he', 'summary', ?, '')").run(`r${i}@example.com`, `tok${i}`);
outbox.splice(0); gmail.connections.length = 0;
sql.prepare("DELETE FROM sent").run();
report = await daily(env, new Date("2026-10-11T04:30:00Z"));
ok(gmail.connections.length === 5 && outbox.length === 89, `89 emails (86 on one site) over ${gmail.connections.length} connections`);
const limited = []; setConnect(fakeGmail({ user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, outbox: limited, failAfter: 10 }));
sql.prepare("DELETE FROM sent").run();
report = await daily(env, new Date("2026-10-11T04:30:00Z"));
ok(limited.length === 10 && report.some((x) => x.includes("quota") && / of \d+ sent/.test(x)), "quota refusal reported: " + report.find((x) => x.includes("quota")));
