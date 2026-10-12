// The study sites that readers can get by email: where each one keeps its
// briefs, how a brief links back to its page, and the sections a reader may
// choose (the same choices as the PDF / Print dialog on the site).

const HEB_NUM = (n) => {
  const ones = "אבגדהוזחט", tens = "יכלמנ";
  if (n === 15) return "טו"; if (n === 16) return "טז";
  return (n >= 10 ? tens[Math.floor(n / 10) - 1] : "") + (n % 10 ? ones[(n % 10) - 1] : "");
};

// "יהושע יז, א" -> "יהושע", "משנה ברכות ד, א" -> "משנה ברכות"
const bookOf = (label) => (label || "").replace(/\s+\S+,\s*\S+$/, "").trim();
const firstLabel = (record) => {
  const q = (record.hebrew && record.hebrew.questions || [])[0];
  return q && q.pasuk ? q.pasuk.label : "";
};

const SUMMARY = { key: "summary" };
const QUESTIONS = { key: "questions", sub: "answers" };
const SOURCES = { key: "sources" };

export const LABELS = {
  he: {
    summary: "סיכום", questions: "שאלות", answers: "תשובות", sources: "מקורות שנבדקו",
    text: "לשון המשנה", topics: "מושגים ונושאים", explain: "הסברי המושגים",
  },
  en: {
    summary: "Summary", questions: "Questions", answers: "Answers", sources: "Sources consulted",
    text: "The Mishnah", topics: "Key terms & topics", explain: "Explanations of the terms",
  },
};

export const SITES = {
  aliyah: {
    url: "https://aliyah-yomit.dailylearning.workers.dev",
    name: { he: "פרשת השבוע", en: "Parashat HaShavua" },
    index: "data/aliyot/index.json",
    file: (day) => `data/aliyot/${day.file || day.date}.json`,
    options: [SUMMARY, QUESTIONS, SOURCES],
    labels: { he: { summary: "סיכום העלייה" }, en: { summary: "Summary of the aliyah" } },
    title: (r, lang) => lang === "he"
      ? `פרשת ${r.reading.he} — ${r.aliyah_name.he}`
      : `${r.reading.en} — ${r.aliyah_name.en}`,
    link: (r, lang) => {
      const p = new URLSearchParams({ lang: lang === "he" ? "hebrew" : "english", p: r.reading.slugs[0] });
      if (r.reading.slugs.length > 1) p.set("r", r.reading.slugs.join("+"));
      p.set("a", r.aliyah);
      return `#${p}`;
    },
  },
  tanach: {
    url: "https://tanach-summaries.dailylearning.workers.dev",
    name: { he: "שניים ליום", en: "Shnayim LaYom" },
    index: "data/questions/index.json",
    file: (day) => `data/questions/${day.date}.json`,
    options: [SUMMARY, QUESTIONS, SOURCES],
    labels: { he: { summary: "סיכום הפרקים" }, en: { summary: "Summary of the chapters" } },
    title: (r, lang) => {
      if (lang !== "he") return r.refs.map((x) => x.sefaria).join(", ");
      const ch = r.refs[0].chapters;
      return `${bookOf(firstLabel(r)) || r.refs[0].sefaria} ${ch.map(HEB_NUM).join("–")}`;
    },
    link: (r, lang) => {
      const x = r.refs[0];
      const p = new URLSearchParams({ lang: lang === "he" ? "hebrew" : "english",
        b: x.book + (x.part ? `.${x.part}` : ""), c: x.chapters[0] });
      return `#${p}`;
    },
  },
  mishna: {
    url: "https://mishna-yomit.dailylearning.workers.dev",
    name: { he: "משנה יומית", en: "Mishnah Yomit" },
    index: "data/perakim/index.json",
    file: (day) => `data/perakim/${day.masechet}-${day.perek}.json`,
    options: [SUMMARY, { key: "text" }, { key: "topics", sub: "explain" }, QUESTIONS, SOURCES],
    labels: {
      he: { summary: "סיכום הפרק", questions: "קושיות המפרשים" },
      en: { summary: "Summary of the perek", questions: "Questions of the mefarshim" },
    },
    title: (r, lang) => lang === "he"
      ? `${bookOf(firstLabel(r)) || r.ref} פרק ${HEB_NUM(r.perek)}`
      : r.ref,
    link: (r) => `#${r.masechet}-${r.perek}`,
  },
};

export const label = (site, key, lang) =>
  (SITES[site].labels[lang] || {})[key] || LABELS[lang][key];

// every section key a site allows, in order (sub-options right after their section)
export const keysOf = (site) => SITES[site].options.flatMap((o) => (o.sub ? [o.key, o.sub] : [o.key]));

// the options as the sign-up dialog shows them
export function optionsFor(site, lang) {
  return SITES[site].options.map((o) => ({
    key: o.key, label: label(site, o.key, lang),
    ...(o.sub ? { sub: { key: o.sub, label: label(site, o.sub, lang) } } : {}),
  }));
}

// a reader's choice, cleaned: known keys only, a sub-option only with its section
export function cleanSections(site, list) {
  const want = new Set(Array.isArray(list) ? list : String(list || "").split(","));
  const out = [];
  for (const o of SITES[site].options) {
    if (!want.has(o.key)) continue;
    out.push(o.key);
    if (o.sub && want.has(o.sub)) out.push(o.sub);
  }
  return out;
}

export { HEB_NUM };
