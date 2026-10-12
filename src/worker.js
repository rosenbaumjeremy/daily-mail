// daily-mail: readers of the study sites sign up to get each day's brief by
// email, choosing which sections they want (as in the sites' PDF dialog).
//
//   GET  /options?site=&lang=   the choices, for the sign-up dialog on the site
//   POST /subscribe             {email, site, lang, sections, freq} -> a confirmation email
//   GET  /confirm?c=            the link in that email: the subscription starts
//   GET  /m?t=  POST /m         change what you get (link in every email)
//   GET  /u?t=  POST /u         unsubscribe (also the one-click List-Unsubscribe)
//   POST /preview?site=&freq=   a sample email, to the owner (NOTIFY_EMAIL) only
//
// Every confirmed sign-up is also reported to NOTIFY_EMAIL (the owner) in a
// separate email the reader never sees.
//
// The cron runs hourly in the morning and at night; once a site's brief for a
// day is up and that day is due (SEND_HOUR in Israel; on Shabbat and Yom Tov
// HOLY_HOUR, 21:00, after the last holy day in a row), each confirmed daily
// reader of that site gets it once. Weekly readers get one email on WEEK_DAY
// (5 = Friday) with the seven days ending that day (Shabbat..Friday: on
// פרשת השבוע, the whole parasha). Sending is through a Gmail account over SMTP:
// GMAIL_USER (the address) and the secret GMAIL_APP_PASSWORD (a Google app password).

import { SITES, optionsFor, cleanSections, keysOf } from "./sites.js";
import { renderEmail } from "./render.js";
import { sendSmtp } from "./smtp.js";

// cloudflare:sockets' connect; set by index.js (the entry point), or by a test
let connect = null;
export const setConnect = (fn) => { connect = fn; };

const ORIGINS = new Set(Object.values(SITES).map((s) => s.url));

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subs (email TEXT NOT NULL, site TEXT NOT NULL, lang TEXT NOT NULL,
     sections TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created TEXT NOT NULL, PRIMARY KEY (email, site))`,
  `CREATE TABLE IF NOT EXISTS pending (code TEXT PRIMARY KEY, email TEXT NOT NULL, site TEXT NOT NULL,
     lang TEXT NOT NULL, sections TEXT NOT NULL, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sent (site TEXT NOT NULL, date TEXT NOT NULL, count INTEGER, at TEXT,
     PRIMARY KEY (site, date))`,
];
// columns added after the first release: added to an existing database once (the error
// when one is already there is expected)
const LATER = [
  "ALTER TABLE subs ADD COLUMN freq TEXT NOT NULL DEFAULT 'daily'",
  "ALTER TABLE pending ADD COLUMN freq TEXT NOT NULL DEFAULT 'daily'",
];
let ready = null;
const setup = (db) => (ready ??= (async () => {
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  for (const q of LATER) { try { await db.prepare(q).run(); } catch {} }
})());
const FREQS = ["daily", "weekly"];
const freqOf = (v) => (v === "weekly" ? "weekly" : "daily");

const now = () => new Date().toISOString();
const token = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

function israel(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/* ---------- web ---------- */

const cors = (origin) => (ORIGINS.has(origin) ? {
  "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST",
  "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin",
} : {});
const json = (data, status, origin) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) } });

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const WORDS = {
  he: {
    confirmed: "ההרשמה אושרה",
    confirmedText: (n, f) => (f === "weekly" ? `מעכשיו תקבלו את ${n} במייל פעם בשבוע, ביום שישי בבוקר.` : `מעכשיו תקבלו את ${n} במייל בכל בוקר (בשבת ובחג: ב-21:00).`),
    freq: "באיזו תדירות", freqs: { daily: "כל יום (בשבת ובחג: ב-21:00)", weekly: "פעם בשבוע (ביום שישי, כל השבוע)" },
    badLink: "הקישור אינו בתוקף", badLinkText: "ייתכן שכבר השתמשתם בו או שעבר זמן רב. אפשר להירשם שוב מהאתר.",
    manage: "מה לקבל במייל", save: "שמירה", saved: "נשמר", lang: "שפה",
    stop: "הפסקת המיילים", stopAsk: (n) => `להפסיק לקבל את ${n} במייל?`, stopped: "הוסרת מהרשימה", stoppedText: (n) => `לא יישלחו אליכם עוד מיילים של ${n}.`,
    confirmSubject: (n) => `אישור הרשמה: ${n} במייל`,
    confirmBody: (n) => `ביקשתם לקבל את ${n} במייל. לאישור לחצו על הכפתור. אם לא ביקשתם, אפשר להתעלם מהמייל הזה.`,
    confirmButton: "אישור ההרשמה", back: "חזרה לאתר",
  },
  en: {
    confirmed: "You're subscribed",
    confirmedText: (n, f) => (f === "weekly" ? `${n} will reach you by email once a week, on Friday morning.` : `${n} will reach you by email every morning (on Shabbat and Yom Tov: at 9 pm).`),
    freq: "How often", freqs: { daily: "Every day (Shabbat and Yom Tov: at 9 pm)", weekly: "Once a week (Friday, the whole week)" },
    badLink: "This link is no longer valid", badLinkText: "It may have been used already or be too old. You can sign up again on the site.",
    manage: "What to get by email", save: "Save", saved: "Saved", lang: "Language",
    stop: "Unsubscribe", stopAsk: (n) => `Stop getting ${n} by email?`, stopped: "You're unsubscribed", stoppedText: (n) => `You will get no more ${n} emails.`,
    confirmSubject: (n) => `Confirm: ${n} by email`,
    confirmBody: (n) => `You asked to get ${n} by email. Press the button to confirm. If you did not ask, ignore this email.`,
    confirmButton: "Confirm", back: "Back to the site",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function page(lang, title, inner, status = 200) {
  const dir = lang === "he" ? "rtl" : "ltr";
  return new Response(`<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#faf6ec;color:#1e1c1a;font:16px/1.6 Arial,'Segoe UI',sans-serif}
main{max-width:520px;margin:40px auto;padding:22px;background:#fff;border:1px solid #e4dccb;border-radius:12px}
h1{margin:0 0 10px;font-size:22px;color:#16305c}label{display:flex;gap:8px;padding:4px 0}label.sub{padding-inline-start:24px}
button,a.btn{background:#16305c;color:#fff;border:0;border-radius:8px;padding:8px 16px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
fieldset{border:1px solid #e4dccb;border-radius:8px;margin:0 0 12px}a{color:#16305c}</style></head>
<body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
}
const backLink = (site, lang) => `<p><a class="btn" href="${SITES[site].url}/">${esc(WORDS[lang].back)}</a></p>`;

function choicesForm(sub, action) {
  const lang = sub.lang;
  const chosen = new Set(sub.sections.split(","));
  const box = (key, text, cls = "") => `<label class="${cls}"><input type="checkbox" name="s" value="${key}"${chosen.has(key) ? " checked" : ""}> ${esc(text)}</label>`;
  const opts = optionsFor(sub.site, lang).map((o) => box(o.key, o.label) + (o.sub ? box(o.sub.key, o.sub.label, "sub") : "")).join("");
  const langs = [["he", "עברית"], ["en", "English"]].map(([v, t]) =>
    `<label><input type="radio" name="lang" value="${v}"${v === lang ? " checked" : ""}> ${t}</label>`).join("");
  const freqs = FREQS.map((v) =>
    `<label><input type="radio" name="freq" value="${v}"${v === freqOf(sub.freq) ? " checked" : ""}> ${esc(WORDS[lang].freqs[v])}</label>`).join("");
  return `<form method="post" action="${action}"><input type="hidden" name="t" value="${esc(sub.token)}">
<fieldset>${opts}</fieldset><fieldset><legend>${esc(WORDS[lang].freq)}</legend>${freqs}</fieldset>
<fieldset><legend>${esc(WORDS[lang].lang)}</legend>${langs}</fieldset>
<button type="submit">${esc(WORDS[lang].save)}</button></form>`;
}

async function subscribe(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, origin); }
  const email = String(body.email || "").trim().toLowerCase();
  const site = String(body.site || "");
  const lang = body.lang === "en" ? "en" : "he";
  const freq = freqOf(body.freq);
  if (!SITES[site]) return json({ error: "unknown site" }, 400, origin);
  if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "email" }, 400, origin);
  const sections = cleanSections(site, body.sections);
  if (!sections.length) return json({ error: "sections" }, 400, origin);

  // at most 3 confirmation emails a day to one address, so the form cannot be used to flood someone
  const day = new Date(Date.now() - 864e5).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending WHERE email = ? AND created > ?").bind(email, day).first();
  if (recent.n >= 3) return json({ error: "too many" }, 429, origin);

  const code = token();
  await env.DB.prepare("INSERT INTO pending (code, email, site, lang, sections, freq, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(code, email, site, lang, sections.join(","), freq, now()).run();
  const name = SITES[site].name[lang];
  const w = WORDS[lang];
  const link = `${env.PUBLIC_URL}/confirm?c=${code}`;
  const dir = lang === "he" ? "rtl" : "ltr";
  const confirmation = {
    to: email, subject: w.confirmSubject(name),
    html: `<div dir="${dir}" style="font-family:Arial,sans-serif;font-size:15px;color:#1e1c1a;max-width:520px">
<p>${esc(w.confirmBody(name))}</p><p><a href="${link}" style="background:#16305c;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none;font-weight:700">${esc(w.confirmButton)}</a></p></div>`,
    text: `${w.confirmBody(name)}\n\n${link}`,
  };
  try {
    await send(env, [confirmation]);
  } catch (error) {
    // not sent: it does not count toward the day's limit, and the reason is
    // logged and returned (Gmail's reply, or a missing setting; never the password)
    await env.DB.prepare("DELETE FROM pending WHERE code = ?").bind(code).run();
    console.error("confirmation:", error.message);
    return json({ error: "send", detail: error.message.slice(0, 200) }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}

async function confirm(url, env) {
  const p = await env.DB.prepare("SELECT * FROM pending WHERE code = ?").bind(url.searchParams.get("c") || "").first();
  if (!p || Date.now() - Date.parse(p.created) > 7 * 864e5)
    return page("he", WORDS.he.badLink, `<p>${WORDS.he.badLinkText}</p><p dir="ltr">${WORDS.en.badLink}. ${WORDS.en.badLinkText}</p>`, 404);
  const old = await env.DB.prepare("SELECT token FROM subs WHERE email = ? AND site = ?").bind(p.email, p.site).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO subs (email, site, lang, sections, freq, token, created) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (email, site) DO UPDATE SET lang = excluded.lang, sections = excluded.sections, freq = excluded.freq`)
      .bind(p.email, p.site, p.lang, p.sections, freqOf(p.freq), old ? old.token : token(), now()),
    env.DB.prepare("DELETE FROM pending WHERE code = ?").bind(p.code),
  ]);
  await notifyOwner(env, p, !!old);
  const w = WORDS[p.lang];
  return page(p.lang, w.confirmed, `<p>${esc(w.confirmedText(SITES[p.site].name[p.lang], freqOf(p.freq)))}</p>${backLink(p.site, p.lang)}`);
}

// a separate email to the site owner (NOTIFY_EMAIL) for every confirmed sign-up;
// the reader is not copied and never sees it, and a failure here does not stop the sign-up
async function notifyOwner(env, p, changed) {
  if (!env.NOTIFY_EMAIL) return;
  const site = SITES[p.site];
  const chosen = optionsFor(p.site, "he").flatMap((o) => [o, ...(o.sub ? [o.sub] : [])])
    .filter((o) => p.sections.split(",").includes(o.key)).map((o) => o.label).join(", ");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM subs WHERE site = ?").bind(p.site).first();
  const lines = [
    `${changed ? "עדכון בחירות" : "נרשם/ה חדש/ה"}: ${site.name.he}`,
    `מייל: ${p.email}`, `תדירות: ${WORDS.he.freqs[freqOf(p.freq)]}`, `שפה: ${p.lang === "he" ? "עברית" : "English"}`, `חלקים: ${chosen}`,
    `מנויים ל${site.name.he} עכשיו: ${count.n}`,
  ];
  try {
    await send(env, [{ to: env.NOTIFY_EMAIL, subject: lines[0],
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">${lines.map(esc).join("<br>")}</div>`,
      text: lines.join("\n") }]);
  } catch (error) { console.error("notify:", error.message); }
}

async function form(request) {
  const data = await request.formData();
  return { t: data.get("t") || "", lang: data.get("lang"), freq: data.get("freq"), s: data.getAll("s") };
}
const byToken = (env, t) => env.DB.prepare("SELECT * FROM subs WHERE token = ?").bind(t).first();
const gone = () => page("he", WORDS.he.badLink, `<p>${WORDS.he.badLinkText}</p><p dir="ltr">${WORDS.en.badLink}. ${WORDS.en.badLinkText}</p>`, 404);

async function manage(request, url, env) {
  if (request.method === "POST") {
    const f = await form(request);
    const sub = await byToken(env, f.t);
    if (!sub) return gone();
    const sections = cleanSections(sub.site, f.s);
    const lang = f.lang === "en" ? "en" : "he";
    if (sections.length) await env.DB.prepare("UPDATE subs SET lang = ?, sections = ?, freq = ? WHERE token = ?")
      .bind(lang, sections.join(","), freqOf(f.freq), sub.token).run();
    const fresh = await byToken(env, f.t);
    return page(fresh.lang, WORDS[fresh.lang].saved, choicesForm(fresh, "/m") + stopLink(fresh));
  }
  const sub = await byToken(env, url.searchParams.get("t") || "");
  if (!sub) return gone();
  return page(sub.lang, `${WORDS[sub.lang].manage} — ${SITES[sub.site].name[sub.lang]}`, choicesForm(sub, "/m") + stopLink(sub));
}
const stopLink = (sub) => `<p style="margin-top:18px"><a href="/u?t=${sub.token}">${esc(WORDS[sub.lang].stop)}</a></p>`;

async function unsubscribe(request, url, env) {
  if (request.method === "POST") {
    // a form from the page, or a mail program's one-click unsubscribe (token in the URL)
    let t = url.searchParams.get("t") || "";
    if (!t) { try { t = (await form(request)).t; } catch {} }
    const sub = await byToken(env, t);
    if (!sub) return gone();
    await env.DB.prepare("DELETE FROM subs WHERE token = ?").bind(sub.token).run();
    const w = WORDS[sub.lang];
    return page(sub.lang, w.stopped, `<p>${esc(w.stoppedText(SITES[sub.site].name[sub.lang]))}</p>${backLink(sub.site, sub.lang)}`);
  }
  const sub = await byToken(env, url.searchParams.get("t") || "");
  if (!sub) return gone();
  const w = WORDS[sub.lang];
  // a page with a button, not an immediate removal: link scanners open every link in an email
  return page(sub.lang, w.stop, `<p>${esc(w.stopAsk(SITES[sub.site].name[sub.lang]))}</p>
<form method="post" action="/u"><input type="hidden" name="t" value="${esc(sub.token)}"><button type="submit">${esc(w.stop)}</button></form>`);
}

/* ---------- sending ---------- */

async function send(env, messages) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD is not set");
  const account = { user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, fromName: env.FROM_NAME, replyTo: env.REPLY_TO };
  // a fresh connection every 40 messages, well inside what Gmail takes on one
  for (let i = 0; i < messages.length; i += 40) await sendSmtp(connect, account, messages.slice(i, i + 40));
}

async function getJson(url) {
  const res = await fetch(`${url}?v=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// one reader's email: each choice of sections is drawn once per send; only the
// reader's own links differ
function messagesFor(env, site, subs, records, weekly) {
  const drawn = new Map();
  return subs.map((sub) => {
    const manage = `${env.PUBLIC_URL}/m?t=${sub.token}`, stop = `${env.PUBLIC_URL}/u?t=${sub.token}`;
    const key = `${sub.lang}|${sub.sections}`;
    if (!drawn.has(key)) drawn.set(key, renderEmail(site, records, sub.lang, sub.sections.split(","),
      { manage: "%%MANAGE%%", stop: "%%STOP%%" }, weekly));
    const own = (text) => text.replaceAll("%%MANAGE%%", manage).replaceAll("%%STOP%%", stop);
    const mail = drawn.get(key);
    return { to: sub.email, subject: mail.subject, html: own(mail.html), text: own(mail.text), headers: {
      "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  });
}

const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// Shabbat and Yom Tov (Israel: one day each, Rosh Hashana two)
const HEBREW = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", day: "numeric", month: "long" });
const YOM_TOV = new Set(["1 Tishri", "2 Tishri", "10 Tishri", "15 Tishri", "22 Tishri", "15 Nisan", "21 Nisan", "6 Sivan"]);
export const holy = (date) => {
  const d = new Date(date + "T12:00:00Z");
  return d.getUTCDay() === 6 || YOM_TOV.has(HEBREW.format(d));
};

// When a day's email goes out, in Israel time: SEND_HOUR that morning, or on
// Shabbat / Yom Tov at HOLY_HOUR (21:00) on the last of the holy days in a row
// (Rosh Hashana, or Yom Tov next to Shabbat), so nothing arrives while it is holy.
export function dueOf(date, env) {
  if (!holy(date)) return { date, hour: Number(env.SEND_HOUR || 7) };
  let end = date;
  while (holy(addDays(end, 1))) end = addDays(end, 1);
  return { date: end, hour: Number(env.HOLY_HOUR || 21) };
}
// Israel date + hour as one count of hours, to compare and subtract
const hours = ({ date, hour }) => Date.parse(date + "T00:00:00Z") / 36e5 + hour;
const LATE = 6;   // a run more than this many hours after the due time sends nothing (stale)

/** Send each site's due briefs: to daily readers, each day's brief once; to
    weekly readers, on WEEK_DAY the 7 days ending that day, once. */
export async function daily(env, when = new Date()) {
  await setup(env.DB);
  const here = israel(when);
  const weekDay = Number(env.WEEK_DAY ?? 5);
  const report = [];
  const isDue = (date) => {
    const late = hours(here) - hours(dueOf(date, env));
    return late >= 0 && late < LATE;
  };
  // the days that may be due now: the last few, oldest first
  const recent = [3, 2, 1, 0].map((n) => addDays(here.date, -n));
  const dueDays = recent.filter(isDue);
  const weekEnd = recent.find((d) => new Date(d + "T12:00:00Z").getUTCDay() === weekDay && isDue(d));
  if (!dueDays.length && !weekEnd) return report;
  const sentAlready = async (key, date) => !!(await env.DB.prepare("SELECT 1 FROM sent WHERE site = ? AND date = ?").bind(key, date).first());
  const claim = (key, date, n) => env.DB.prepare("INSERT INTO sent (site, date, count, at) VALUES (?, ?, ?, ?)").bind(key, date, n, now()).run();

  for (const [site, s] of Object.entries(SITES)) {
    try {
      const all = (await env.DB.prepare("SELECT * FROM subs WHERE site = ?").bind(site).all()).results;
      const dailySubs = all.filter((x) => freqOf(x.freq) === "daily");
      const weeklySubs = weekEnd ? all.filter((x) => freqOf(x.freq) === "weekly") : [];
      const days = [];
      if (dailySubs.length) for (const d of dueDays) if (!(await sentAlready(site, d))) days.push(d);
      const doWeekly = weeklySubs.length > 0 && !(await sentAlready(`${site}:week`, weekEnd));
      if (!days.length && !doWeekly) continue;

      const index = await getJson(`${s.url}/${s.index}`);
      const files = new Map();   // each brief fetched once
      const load = (day) => {
        const file = s.file(day);
        if (!files.has(file)) files.set(file, getJson(`${s.url}/${file}`));
        return files.get(file);
      };

      for (const date of days) {
        const day = index.days.find((d) => d.date === date && !d.file) || index.days.find((d) => d.date === date);
        if (!day) { report.push(`${site}: no brief yet for ${date}`); continue; }
        const record = await load(day);
        // claim the day first, so a crash part-way through never sends anyone the brief twice
        await claim(site, date, dailySubs.length);
        await send(env, messagesFor(env, site, dailySubs, [record], false));
        report.push(`${site}: sent ${dailySubs.length} daily for ${date}`);
      }
      if (doWeekly) {
        if (!index.days.some((d) => d.date === weekEnd)) { report.push(`${site}: no brief yet for ${weekEnd} (weekly)`); continue; }
        const from = addDays(weekEnd, -6);
        const week = index.days.filter((d) => d.date >= from && d.date <= weekEnd)
          .sort((x, y) => x.date.localeCompare(y.date) || String(x.file || "").localeCompare(String(y.file || "")));
        const records = await Promise.all(week.map(load));
        await claim(`${site}:week`, weekEnd, weeklySubs.length);
        await send(env, messagesFor(env, site, weeklySubs, records, true));
        report.push(`${site}: sent ${weeklySubs.length} weekly (${records.length} days, ${from}..${weekEnd})`);
      }
    } catch (error) {
      report.push(`${site}: ${error.message}`);
    }
  }
  await env.DB.prepare("DELETE FROM pending WHERE created < ?").bind(new Date(Date.now() - 8 * 864e5).toISOString()).run();
  return report;
}

/** POST /preview?site=&freq=weekly|daily — a sample of what readers get, sent
    only to NOTIFY_EMAIL (the owner), never to anyone else; at most 3 an hour.
    Uses the owner's own choices for that site if subscribed, else every section.
    Weekly: the most recent full week (the 7 days ending the last WEEK_DAY). */
async function preview(url, env, when = new Date()) {
  const site = url.searchParams.get("site") || "aliyah";
  const weekly = url.searchParams.get("freq") !== "daily";
  const s = SITES[site];
  if (!s || !env.NOTIFY_EMAIL) return new Response("unknown site", { status: 400 });
  const hourAgo = new Date(when.getTime() - 36e5).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM sent WHERE site = 'preview' AND at > ?").bind(hourAgo).first();
  if (recent.n >= 3) return new Response("too many previews this hour", { status: 429 });

  const today = israel(when).date;
  const weekDay = Number(env.WEEK_DAY ?? 5);
  let end = today;
  while (new Date(end + "T12:00:00Z").getUTCDay() !== weekDay) end = addDays(end, -1);
  const index = await getJson(`${s.url}/${s.index}`);
  const from = weekly ? addDays(end, -6) : today;
  const until = weekly ? end : today;
  const days = index.days.filter((d) => d.date >= from && d.date <= until)
    .sort((x, y) => x.date.localeCompare(y.date) || String(x.file || "").localeCompare(String(y.file || "")));
  if (!days.length) return new Response(`no briefs for ${from}..${until}`, { status: 404 });
  const records = await Promise.all(days.map((d) => getJson(`${s.url}/${s.file(d)}`)));

  const own = await env.DB.prepare("SELECT * FROM subs WHERE email = ? AND site = ?").bind(env.NOTIFY_EMAIL.toLowerCase(), site).first();
  const sub = own || { email: env.NOTIFY_EMAIL, lang: "he", sections: keysOf(site).join(","), token: "preview" };
  const [mail] = messagesFor(env, site, [sub], records, weekly);
  mail.to = env.NOTIFY_EMAIL;
  mail.subject = `[ניסיון] ${mail.subject}`;
  await env.DB.prepare("INSERT INTO sent (site, date, count, at) VALUES ('preview', ?, 1, ?)").bind(crypto.randomUUID(), when.toISOString()).run();
  await send(env, [mail]);
  return new Response(`sent a ${weekly ? "weekly" : "daily"} ${site} preview (${records.length} days, ${from}..${until}) to the owner`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    await setup(env.DB);
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    try {
      if (url.pathname === "/options") {
        const site = url.searchParams.get("site");
        if (!SITES[site]) return json({ error: "unknown site" }, 400, origin);
        const lang = url.searchParams.get("lang") === "en" ? "en" : "he";
        return json({ options: optionsFor(site, lang), keys: keysOf(site) }, 200, origin);
      }
      if (url.pathname === "/subscribe" && request.method === "POST") return await subscribe(request, env, origin);
      if (url.pathname === "/confirm") return await confirm(url, env);
      if (url.pathname === "/m") return await manage(request, url, env);
      if (url.pathname === "/u") return await unsubscribe(request, url, env);
      if (url.pathname === "/preview" && request.method === "POST") return await preview(url, env);
      if (url.pathname === "/") return new Response("daily-mail", { headers: { "Content-Type": "text/plain" } });
      return new Response("not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return json({ error: "server" }, 500, origin);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(daily(env, new Date(event.scheduledTime)).then((r) => r.length && console.log(r.join("\n"))));
  },
};
