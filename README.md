# daily-mail

Readers of the study sites (פרשת השבוע, שניים ליום, משנה יומית) press **במייל / Email**
beside PDF and Print, choose which sections they want (the same choices as the PDF
dialog), the language and their address, and confirm from an email. Each morning
they get that day's brief with only those sections. Every email has links to
change the choices or unsubscribe (plus a one-click List-Unsubscribe header).
Every confirmed sign-up is also reported to `NOTIFY_EMAIL` (you) in a separate
email; the reader is not copied and never sees it.

- `src/worker.js` — the Cloudflare Worker: sign-up API, confirm / manage /
  unsubscribe pages, and the morning cron that sends.
- `src/sites.js` — each site: where its briefs are, its title and deep link, and
  the sections a reader may choose.
- `src/render.js` — a brief as an email (inline styles, RTL for Hebrew).
- `src/smtp.js` — sending through Gmail.
- On each site: `site/mail.js` + `site/mail.css` (the same in all three), loaded
  in `index.html` as `<script src="mail.js" data-site="aliyah|tanach|mishna">`, and
  this worker's address in `connect-src` in `site/_headers`.

## When it sends

Cron every hour 03:15–09:15 UTC. A site's brief goes out once its file for today
(Israel date) is in the site's index and it is `SEND_HOUR` (07) or later in Israel
(up to 5 hours later). The `sent` table makes sure it goes once per site per day.

## Sending

Through a Gmail account kept just for this (not the owner's own), over SMTP
(smtp.gmail.com:465) with a Google app password. Gmail allows about 500
emails a day; each reader of each site is one email. `src/smtp.js` does the
SMTP; `src/index.js` hands it Cloudflare's socket API.

## Setup (once)

1. In the sending Gmail account: turn on 2-Step Verification, then create an
   app password (myaccount.google.com/apppasswords).
2. Put the account's address in `wrangler.jsonc` (`GMAIL_USER`).
3. **Cloudflare → Storage & Databases → D1 → Create** a database named
   `daily-mail`; put its ID in `wrangler.jsonc` (`database_id`). The worker
   creates its tables on first use.
4. **GitHub**: an empty repo `daily-mail`; push this repo to it.
5. **Cloudflare → Workers → Create → Import a repository** (Workers Builds),
   pick `daily-mail`. Then in the worker's Settings → Variables and Secrets add
   the secret `GMAIL_APP_PASSWORD` (the app password).
6. Check https://daily-mail.dailylearning.workers.dev/ says `daily-mail`, sign
   up once from a site, then push the three site repos (their Email button
   talks to this address).

## Test locally

```sh
node test/run.mjs          # sign-up, confirm, the morning send, manage, unsubscribe; emails in test/out/
node test/dev.mjs aliyah   # a site with the button on http://localhost:8790, emails printed to the console
```
