// One day's brief as an email, with only the sections the reader chose.
// Email programs ignore <style> blocks unevenly, so every style is inline.

import { SITES, label, HEB_NUM } from "./sites.js";

const NAVY = "#16305c", GOLD = "#b8924a", BEIGE = "#faf6ec", INK = "#1e1c1a", MUTED = "#6b6560", LINE = "#e4dccb";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const strip = (s) => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
const sefaria = (ref) => `https://www.sefaria.org/${encodeURIComponent(String(ref).replace(/ /g, "_")).replace(/%3A/g, ":").replace(/%2C/g, ",")}`;

const TEXT = {
  he: {
    askedBy: "שואלים", answer: (i) => `תירוץ ${"אבגדהוזחטי"[i] || i + 1}`, why: "למה זה חשוב",
    synthesis: "סינתזה שלנו", open: "לקריאה באתר", manage: "שינוי הבחירות", stop: "הפסקת המיילים",
    footer: (name) => `קיבלתם מייל זה כי נרשמתם ל${name} במייל.`,
  },
  en: {
    askedBy: "Asked by", answer: (i) => `Answer ${i + 1}`, why: "Why it matters",
    synthesis: "our synthesis", open: "Read it on the site", manage: "Change what you get", stop: "Unsubscribe",
    footer: (name) => `You get this email because you signed up for ${name} by email.`,
  },
};

const H = (text) => `<h2 style="margin:22px 0 8px;font-size:17px;color:${NAVY};border-bottom:2px solid ${GOLD};padding-bottom:4px">${esc(text)}</h2>`;
const P = (html, extra = "") => `<p style="margin:0 0 10px;line-height:1.65;${extra}">${html}</p>`;
const heb = (s) => `<span dir="rtl" lang="he">${esc(s)}</span>`;

function cite(who) {
  const name = who.ref ? `<a href="${sefaria(who.ref)}" style="color:${NAVY}">${esc(who.name)}</a>` : esc(who.name);
  const quote = who.quote ? ` — <q dir="rtl" lang="he" style="color:${MUTED}">${esc(who.quote)}</q>` : "";
  return `<div style="font-size:14px;margin:2px 0 4px">${name}${quote}</div>`;
}
const smallLabel = (text) => `<div style="font-size:12px;font-weight:700;color:${GOLD};margin-top:8px">${esc(text)}</div>`;

function question(q, i, t, withAnswers) {
  let out = `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid ${LINE};border-radius:8px;background:#fff">`;
  out += `<div style="font-weight:700;color:${NAVY}">${i + 1}. ${esc(q.title)}</div>`;
  if (q.pasuk) {
    const at = q.pasuk.label || q.pasuk.ref;
    out += P(`${heb(`"${q.pasuk.text}"`)}${at ? ` <a href="${sefaria(q.pasuk.ref)}" style="color:${MUTED};font-size:13px">(${esc(at)})</a>` : ""}`, "margin-top:6px");
  }
  if (q.question && q.question !== q.title) out += P(esc(q.question));
  if (withAnswers) {
    if (q.asked_by && q.asked_by.length) out += smallLabel(t.askedBy) + q.asked_by.map(cite).join("");
    (q.answers || []).forEach((a, n) => {
      out += smallLabel(t.answer(n)) + P(esc(a.text) + (a.synthesis ? ` <i style="color:${MUTED}">— ${esc(t.synthesis)}</i>` : ""), "margin-bottom:4px");
      out += (a.sources || []).map(cite).join("");
    });
    if (q.why) out += P(`<i>${esc(t.why)}: ${esc(q.why)}</i>`, `color:${MUTED};margin-top:8px;font-size:14px`);
  }
  return out + "</div>";
}

/** site: key of SITES; record: the brief file; lang "he" | "en"; sections: chosen keys;
    links: { manage, stop } URLs for this reader. */
export function renderEmail(site, record, lang, sections, links) {
  const s = SITES[site];
  const t = TEXT[lang];
  const want = new Set(sections);
  const brief = record[lang === "he" ? "hebrew" : "english"] || record.hebrew || record.english;
  const dir = lang === "he" ? "rtl" : "ltr";
  const title = s.title(record, lang);
  const date = record.hebrew_date ? record.hebrew_date[lang === "he" ? "hebrew" : "english"] : record.date;
  const pageUrl = s.url + "/" + s.link(record, lang);

  let body = "";
  for (const o of s.options) {
    if (!want.has(o.key)) continue;
    const head = H(label(site, o.key, lang));
    if (o.key === "summary" && brief.summary) {
      body += head + brief.summary.split(/\n+/).map((p) => P(esc(p))).join("");
    } else if (o.key === "text" && record.mishnayot) {
      body += head + record.mishnayot.map((m, i) => {
        let one = P(`<b style="color:${GOLD}">${HEB_NUM(i + 1)}</b> ${heb(strip(m.he))}`, "font-size:17px");
        if (lang === "en" && m.en) one += P(esc(strip(m.en)), `color:${MUTED};font-size:14px`);
        return one;
      }).join("");
    } else if (o.key === "topics" && (brief.topics || []).length) {
      body += head + brief.topics.map((x) => {
        let one = `<div style="font-weight:700;color:${NAVY};margin-top:8px">◆ ${esc(x.term)}</div>`;
        if (want.has("explain")) one += P(esc(x.explanation), "margin-bottom:2px") + (x.source ? cite(x.source) : "");
        return one;
      }).join("");
    } else if (o.key === "questions" && (brief.questions || []).length) {
      // "Questions & answers" when the answers come too (a site's own heading, e.g. Mishnah's, stays)
      const own = (s.labels[lang] || {}).questions;
      const heading = want.has("answers") && !own ? H(lang === "he" ? "שאלות ותשובות" : "Questions & answers") : head;
      body += heading + brief.questions.map((q, i) => question(q, i, t, want.has("answers"))).join("");
    } else if (o.key === "sources" && (brief.sources_consulted || []).length) {
      body += head + P(esc(brief.sources_consulted.join(" · ")), `color:${MUTED};font-size:14px`);
    }
  }

  const button = `<a href="${esc(pageUrl)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-weight:700">${esc(t.open)}</a>`;
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BEIGE}">
<div dir="${dir}" style="max-width:640px;margin:0 auto;padding:18px 16px;font-family:Arial,'Segoe UI',sans-serif;font-size:15px;color:${INK};text-align:${lang === "he" ? "right" : "left"}">
<div style="border-bottom:3px solid ${NAVY};padding-bottom:8px;margin-bottom:6px">
<div style="font-size:13px;color:${GOLD};font-weight:700">${esc(s.name[lang])}</div>
<h1 style="margin:2px 0 2px;font-size:22px;color:${NAVY}">${esc(title)}</h1>
<div style="font-size:13px;color:${MUTED}">${esc(date)} · ${esc(record.date)}</div>
</div>
${body}
<div style="margin:22px 0 10px">${button}</div>
<div style="border-top:1px solid ${LINE};margin-top:18px;padding-top:10px;font-size:12px;color:${MUTED};line-height:1.6">
${esc(t.footer(s.name[lang]))}<br>
<a href="${esc(links.manage)}" style="color:${MUTED}">${esc(t.manage)}</a> · <a href="${esc(links.stop)}" style="color:${MUTED}">${esc(t.stop)}</a>
</div></div></body></html>`;

  const subject = `${s.name[lang]}: ${title}`;
  return { subject, html, text: textVersion(s, record, brief, lang, want, t, title, date, pageUrl, links) };
}

// the plain-text part, for email programs that do not show HTML
function textVersion(s, record, brief, lang, want, t, title, date, pageUrl, links) {
  const out = [`${s.name[lang]} — ${title}`, `${date} · ${record.date}`, ""];
  if (want.has("summary") && brief.summary) out.push(brief.summary, "");
  if (want.has("questions")) (brief.questions || []).forEach((q, i) => {
    out.push(`${i + 1}. ${q.title}`);
    if (want.has("answers")) (q.answers || []).forEach((a, n) => out.push(`   ${t.answer(n)}: ${a.text}`));
  });
  out.push("", `${t.open}: ${pageUrl}`, "", `${t.manage}: ${links.manage}`, `${t.stop}: ${links.stop}`);
  return out.join("\n");
}
