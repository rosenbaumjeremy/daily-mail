// daily-mail: readers of the study sites sign up to get each day's brief by
// email, choosing which sections they want (as in the sites' PDF dialog).
//
//   GET  /options?site=&lang=   the choices, for the sign-up dialog on the site
//   POST /subscribe             {email, site, lang, sections} -> a confirmation email
//   GET  /confirm?c=            the link in that email: the subscription starts
//   GET  /m?t=  POST /m         change what you get (link in every email)
//   GET  /u?t=  POST /u         unsubscribe (also the one-click List-Unsubscribe)
//
// Every confirmed sign-up is also reported to NOTIFY_EMAIL (the owner) in a
// separate email the reader never sees.
//
// The cron runs hourly in the morning; once a site's brief for today (Israel
// date) is up and it is SEND_HOUR or later in Israel, each confirmed reader of
// that site gets it once. Sending is through a Gmail account over SMTP:
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
let ready = null;
const setup = (db) => (ready ??= db.batch(SCHEMA.map((q) => db.prepare(q))));

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
    confirmed: "ההרשמה אושרה", confirmedText: (n) => `מעכשיו תקבלו את ${n} במייל בכל בוקר.`,
    badLink: "הקישור אינו בתוקף", badLinkText: "ייתכן שכבר השתמשתם בו או שעבר זמן רב. אפשר להירשם שוב מהאתר.",
    manage: "מה לקבל במייל", save: "שמירה", saved: "נשמר", lang: "שפה",
    stop: "הפסקת המיילים", stopAsk: (n) => `להפסיק לקבל את ${n} במייל?`, stopped: "הוסרת מהרשימה", stoppedText: (n) => `לא יישלחו אליכם עוד מיילים של ${n}.`,
    confirmSubject: (n) => `אישור הרשמה: ${n} במייל`,
    confirmBody: (n) => `ביקשתם לקבל את ${n} במייל. לאישור לחצו על הכפתור. אם לא ביקשתם, אפשר להתעלם מהמייל הזה.`,
    confirmButton: "אישור ההרשמה", back: "חזרה לאתר",
  },
  en: {
    confirmed: "You're subscribed", confirmedText: (n) => `${n} will reach you by email every morning.`,
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
  return `<form method="post" action="${action}"><input type="hidden" name="t" value="${esc(sub.token)}">
<fieldset>${opts}</fieldset><fieldset><legend>${esc(WORDS[lang].lang)}</legend>${langs}</fieldset>
<button type="submit">${esc(WORDS[lang].save)}</button></form>`;
}

async function subscribe(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400, origin); }
  const email = String(body.email || "").trim().toLowerCase();
  const site = String(body.site || "");
  const lang = body.lang === "en" ? "en" : "he";
  if (!SITES[site]) return json({ error: "unknown site" }, 400, origin);
  if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "email" }, 400, origin);
  const sections = cleanSections(site, body.sections);
  if (!sections.length) return json({ error: "sections" }, 400, origin);

  // at most 3 confirmation emails a day to one address, so the form cannot be used to flood someone
  const day = new Date(Date.now() - 864e5).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending WHERE email = ? AND created > ?").bind(email, day).first();
  if (recent.n >= 3) return json({ error: "too many" }, 429, origin);

  const code = token();
  await env.DB.prepare("INSERT INTO pending (code, email, site, lang, sections, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(code, email, site, lang, sections.join(","), now()).run();
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
    env.DB.prepare(`INSERT INTO subs (email, site, lang, sections, token, created) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (email, site) DO UPDATE SET lang = excluded.lang, sections = excluded.sections`)
      .bind(p.email, p.site, p.lang, p.sections, old ? old.token : token(), now()),
    env.DB.prepare("DELETE FROM pending WHERE code = ?").bind(p.code),
  ]);
  await notifyOwner(env, p, !!old);
  const w = WORDS[p.lang];
  return page(p.lang, w.confirmed, `<p>${esc(w.confirmedText(SITES[p.site].name[p.lang]))}</p>${backLink(p.site, p.lang)}`);
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
    `מייל: ${p.email}`, `שפה: ${p.lang === "he" ? "עברית" : "English"}`, `חלקים: ${chosen}`,
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
  return { t: data.get("t") || "", lang: data.get("lang"), s: data.getAll("s") };
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
    if (sections.length) await env.DB.prepare("UPDATE subs SET lang = ?, sections = ? WHERE token = ?").bind(lang, sections.join(","), sub.token).run();
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

/** Send today's brief of every site that has one and has not been sent yet. */
export async function daily(env, when = new Date()) {
  await setup(env.DB);
  const { date, hour } = israel(when);
  const sendHour = Number(env.SEND_HOUR || 7);
  const report = [];
  if (hour < sendHour || hour > sendHour + 5) return report;   // too early, or the morning has passed
  for (const [site, s] of Object.entries(SITES)) {
    try {
      if (await env.DB.prepare("SELECT 1 FROM sent WHERE site = ? AND date = ?").bind(site, date).first()) continue;
      const subs = (await env.DB.prepare("SELECT * FROM subs WHERE site = ?").bind(site).all()).results;
      if (!subs.length) continue;
      const index = await getJson(`${s.url}/${s.index}`);
      const day = index.days.find((d) => d.date === date && !d.file) || index.days.find((d) => d.date === date);
      if (!day) { report.push(`${site}: no brief yet for ${date}`); continue; }
      const record = await getJson(`${s.url}/${s.file(day)}`);
      // claim the day first, so a crash part-way through never sends anyone the brief twice
      await env.DB.prepare("INSERT INTO sent (site, date, count, at) VALUES (?, ?, ?, ?)").bind(site, date, subs.length, now()).run();
      // each choice of sections is drawn once; only the reader's own links differ
      const drawn = new Map();
      const messages = subs.map((sub) => {
        const manage = `${env.PUBLIC_URL}/m?t=${sub.token}`, stop = `${env.PUBLIC_URL}/u?t=${sub.token}`;
        const key = `${sub.lang}|${sub.sections}`;
        if (!drawn.has(key)) drawn.set(key, renderEmail(site, record, sub.lang, sub.sections.split(","), { manage: "%%MANAGE%%", stop: "%%STOP%%" }));
        const own = (text) => text.replaceAll("%%MANAGE%%", manage).replaceAll("%%STOP%%", stop);
        const mail = drawn.get(key);
        return { to: sub.email, subject: mail.subject, html: own(mail.html), text: own(mail.text), headers: {
          "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
      });
      await send(env, messages);
      report.push(`${site}: sent ${messages.length} for ${date}`);
    } catch (error) {
      report.push(`${site}: ${error.message}`);
    }
  }
  await env.DB.prepare("DELETE FROM pending WHERE created < ?").bind(new Date(Date.now() - 8 * 864e5).toISOString()).run();
  return report;
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
