// Sending through Gmail: SMTP over TLS to smtp.gmail.com:465, signed in with
// the account's app password. One connection carries many messages.
// `connect` is cloudflare:sockets' connect (index.js passes it in; tests pass a fake).

const enc = new TextEncoder();

function b64(text) {
  const bytes = enc.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
// a header value with Hebrew in it, as RFC 2047 encoded words
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (a) => a.replace(/[\r\n<>]/g, "");

export function mime({ from, fromName, to, replyTo, subject, html, text, headers = {} }) {
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  const domain = from.split("@")[1];
  const lines = [
    `From: ${fromName ? `${word(fromName)} ` : ""}<${addr(from)}>`,
    `To: <${addr(to)}>`,
    ...(replyTo ? [`Reply-To: <${addr(replyTo)}>`] : []),
    `Subject: ${word(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, "")}`),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(text || "")),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(html || "")),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

/** messages: [{to, subject, html, text, headers}] — throws on the first refusal,
    saying how many went out before it. */
export async function sendSmtp(connect, { user, password, fromName, replyTo }, messages) {
  const socket = connect({ hostname: "smtp.gmail.com", port: 465 }, { secureTransport: "on", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // one reply, which may run over several lines ("250-..." ... "250 ...")
  async function reply() {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const text = lines.slice(0, i + 1).join("\n");
          buffer = lines.slice(i + 1).join("\r\n");
          return { code: Number(lines[i].slice(0, 3)), text };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("Gmail closed the connection");
      buffer += decoder.decode(value, { stream: true });
    }
  }
  async function cmd(line, want) {
    if (line != null) await writer.write(enc.encode(line + "\r\n"));
    const r = await reply();
    if (r.code !== want) throw new Error(`Gmail: ${r.text.slice(0, 200)}`);
    return r;
  }

  let sent = 0;
  try {
    await cmd(null, 220);
    await cmd("EHLO daily-mail", 250);
    await cmd("AUTH PLAIN " + b64(`\0${user}\0${password}`), 235);
    for (const m of messages) {
      await cmd(`MAIL FROM:<${addr(user)}>`, 250);
      await cmd(`RCPT TO:<${addr(m.to)}>`, 250);
      await cmd("DATA", 354);
      const body = mime({ from: user, fromName, replyTo, ...m }).replace(/^\./gm, "..");   // dot-stuffing
      await writer.write(enc.encode(body + "\r\n.\r\n"));
      await cmd(null, 250);
      sent++;
    }
    await writer.write(enc.encode("QUIT\r\n")).catch(() => {});
  } catch (error) {
    error.message = `${error.message} (${sent} of ${messages.length} sent)`;
    error.sent = sent;
    throw error;
  } finally {
    try { await socket.close(); } catch {}
  }
  return sent;
}
