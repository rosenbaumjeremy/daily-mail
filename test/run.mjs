// Runs the worker in Node against an in-memory database, the briefs in the
// local site folders, and a fake Gmail (test/fake-gmail.mjs), then writes the emails to test/out/.
//   node test/run.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { daily, setConnect, dueOf, holy } from "../src/worker.js";
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
ok(r.status === 502 && (await r.json()).detail.includes("535"), "a wrong app password is reported");
ok(!sql.prepare("SELECT 1 FROM pending WHERE email = 'late@example.com'").get(), "a failed sign-up does not count toward the limit");
// many readers: one connection per 40 messages; a Gmail refusal is reported, not hidden
setConnect(gmail);
for (let i = 0; i < 85; i++) sql.prepare("INSERT INTO subs (email, site, lang, sections, token, created) VALUES (?, 'tanach', 'he', 'summary', ?, '')").run(`r${i}@example.com`, `tok${i}`);
outbox.splice(0); gmail.connections.length = 0;
sql.prepare("DELETE FROM sent").run();
report = await daily(env, new Date("2026-10-11T04:30:00Z"));
ok(gmail.connections.length === 5 && outbox.length === 89, `89 emails (86 on one site) over ${gmail.connections.length} connections`);
const limited = []; setConnect(fakeGmail({ user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, outbox: limited, failAfter: 10 }));
sql.prepare("DELETE FROM sent").run();
report = await daily(env, new Date("2026-10-11T04:30:00Z"));
ok(limited.length === 10 && report.some((x) => x.includes("quota") && / of \d+ sent/.test(x)), "quota refusal reported: " + report.find((x) => x.includes("quota")));

// weekly: Friday 2026-10-09 07:30 Israel; daily readers are not touched by the weekly send
setConnect(gmail);
sql.prepare("DELETE FROM subs").run(); sql.prepare("DELETE FROM sent").run(); outbox.splice(0);
const weekly = [
  ["wk-aliyah@example.com", "aliyah", "he", ["summary", "questions"]],
  ["wk-mishna@example.com", "mishna", "en", ["summary", "topics"]],
];
for (const [email, site, lang, sections] of weekly) {
  await signup({ email, site, lang, sections, freq: "weekly" });
  r = await call("/confirm?c=" + code(outbox.find((m) => m.to[0] === email)));
  ok((await r.text()).includes(lang === "he" ? "פעם בשבוע" : "once a week"), `weekly confirmation page for ${email}`);
}
ok(outbox.filter((m) => m.to[0] === "owner@example.com").every((m) => m.text.includes("פעם בשבוע")), "owner notice says weekly");
await signup({ email: "day@example.com", site: "aliyah", sections: ["summary"] });
await call("/confirm?c=" + code(outbox.find((m) => m.to[0] === "day@example.com")));
outbox.splice(0);
report = await daily(env, new Date("2026-10-08T04:30:00Z"));   // Thursday
ok(!outbox.some((m) => m.to[0].startsWith("wk-")), "no weekly email on Thursday");
outbox.splice(0);
report = await daily(env, new Date("2026-10-09T04:30:00Z"));   // Friday
console.log(report.join("\n"));
const wk = Object.fromEntries(outbox.map((m) => [m.to[0], m]));
ok(wk["day@example.com"] && !wk["day@example.com"].subject.includes("סיכום שבועי"), "daily reader still gets just Friday");
const wa = wk["wk-aliyah@example.com"];
ok(wa && wa.subject.includes("סיכום שבועי") && wa.subject.includes("פרשת"), "weekly aliyah subject: " + (wa && wa.subject));
const aliyot = (wa.html.match(/<h2 style="margin:8px 0 2px/g) || []).length;
ok(aliyot >= 5, `weekly aliyah email holds ${aliyot} days`);
ok(wa.html.includes("סיכום העלייה") && !wa.html.includes(">תירוץ א<"), "weekly keeps the reader's sections only");
const wm = wk["wk-mishna@example.com"];
ok(wm && (wm.html.match(/Mishnah Berakhot \d/g) || []).length >= 2 && wm.html.includes("Key terms"), "weekly mishna in English, its perakim");
writeFileSync(here + "out/weekly-aliyah.html", wa.html);
console.log("weekly aliyah size:", Math.round(wa.html.length / 1024), "KB");
outbox.splice(0);
await daily(env, new Date("2026-10-09T05:30:00Z"));
ok(!outbox.some((m) => m.to[0].startsWith("wk-")), "weekly not sent twice");
// manage page switches frequency
const wtok = wa.headers["List-Unsubscribe"].match(/t=([0-9a-f]+)/)[1];
const fd2 = new FormData(); fd2.append("t", wtok); fd2.append("lang", "he"); fd2.append("freq", "daily"); fd2.append("s", "summary");
r = await call("/m", { method: "POST", body: fd2 });
ok((await r.text()).includes('value="daily" checked'), "manage page switches weekly to daily");

// Shabbat and Yom Tov: the day's email waits until 21:00 of the last holy day in a row
const due = (d) => { const x = dueOf(d, env); return `${x.date} ${x.hour}`; };
ok(due("2026-10-11") === "2026-10-11 7", "a weekday: 07:00");
ok(due("2026-10-10") === "2026-10-10 21", "Shabbat: 21:00 that night");
ok(due("2026-09-12") === "2026-09-13 21" && due("2026-09-13") === "2026-09-13 21", "Rosh Hashana 5787 (Sat+Sun): both at 21:00 on the second day");
ok(due("2026-09-21") === "2026-09-21 21", "Yom Kippur: 21:00");
ok(due("2027-06-11") === "2027-06-12 21", "Shavuot on Friday, then Shabbat: Saturday 21:00");
ok(!holy("2026-09-27") && holy("2026-09-26") && holy("2026-10-03"), "Sukkot 1 and Shemini Atzeret are Yom Tov, chol hamoed is not");
ok(holy("2027-04-22") && holy("2027-04-28") && !holy("2027-04-23"), "Pesach 1 and 7 in Israel");
setConnect(gmail);
sql.prepare("DELETE FROM subs").run(); sql.prepare("DELETE FROM sent").run(); outbox.splice(0);
await signup({ email: "shabbat@example.com", site: "tanach", sections: ["summary"] });
await call("/confirm?c=" + code(outbox.find((m) => m.to[0] === "shabbat@example.com")));
outbox.splice(0);
await daily(env, new Date("2026-10-10T04:30:00Z"));    // Shabbat 07:30
ok(outbox.length === 0, "nothing on Shabbat morning");
await daily(env, new Date("2026-10-10T15:15:00Z"));    // Shabbat 18:15
ok(outbox.length === 0, "nothing before 21:00 on Shabbat");
report = await daily(env, new Date("2026-10-10T18:15:00Z"));    // motzei Shabbat 21:15
ok(outbox.length === 1 && outbox[0].subject.includes("יהושע"), "Shabbat's brief at 21:15: " + report.join("; "));
outbox.splice(0);
await daily(env, new Date("2026-10-10T19:15:00Z"));
await daily(env, new Date("2026-10-11T04:30:00Z"));    // Sunday 07:30: Sunday's brief only
ok(outbox.length === 1 && outbox[0].text.includes("2026-10-11"), "Sunday morning: only Sunday's brief");

// preview: only ever to the owner, rate-limited
outbox.splice(0);
r = await call("/preview?site=aliyah&freq=weekly&to=attacker@example.com", { method: "POST" });
ok(r.status === 200 && outbox.length === 1 && outbox[0].to[0] === "owner@example.com" && outbox[0].subject.startsWith("[ניסיון]"), "preview goes to the owner only: " + await r.text());
ok((outbox[0].html.match(/<h2 style="margin:8px 0 2px/g) || []).length >= 5, "preview is a whole week");
await call("/preview?site=mishna", { method: "POST" }); await call("/preview?site=tanach", { method: "POST" });
ok((await call("/preview?site=aliyah", { method: "POST" })).status === 429, "4th preview in an hour refused");
ok((await call("/preview?site=aliyah")).status === 404, "GET does not send");

// on Cloudflare the sites come through service bindings, not fetch
{
  const seen = [];
  const bound = { ...env, ALIYAH: { fetch: async (u) => { seen.push(String(u)); return globalThis.fetch(u); } } };
  sql.prepare("DELETE FROM sent").run();
  r = await worker.fetch(new Request("https://daily-mail.test/preview?site=aliyah", { method: "POST" }), bound);
  ok(seen.some((u) => u.includes("/data/aliyot/index.json")), "the aliyah site is read through its binding");
}
