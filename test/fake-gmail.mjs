// A stand-in for smtp.gmail.com: speaks enough SMTP for src/smtp.js, checks the
// sign-in, and turns each message back into {to, subject, html, text, headers}.
const dec = (b64) => Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
const unword = (s) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => dec(b));

export function parse(raw) {
  raw = raw.replace(/^\.\./gm, ".");
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = {};
  for (const line of head.split("\r\n")) { const i = line.indexOf(":"); headers[line.slice(0, i)] = line.slice(i + 2); }
  const boundary = headers["Content-Type"].match(/boundary="([^"]+)"/)[1];
  const parts = rest.join("\r\n\r\n").split(`--${boundary}`).slice(1, -1).map((p) => p.split("\r\n\r\n"));
  const part = (type) => dec(parts.find(([h]) => h.includes(type))[1]);
  return { to: [headers.To.replace(/[<>]/g, "")], from: unword(headers.From), subject: unword(headers.Subject),
    html: part("text/html"), text: part("text/plain"), headers, cc: headers.Cc, bcc: headers.Bcc };
}

export function fakeGmail({ user, password, outbox, failAfter = Infinity }) {
  const connections = [];
  const connect = (where, options) => {
    if (where.hostname !== "smtp.gmail.com" || where.port !== 465 || options.secureTransport !== "on") throw new Error("wrong server");
    connections.push(where);
    let push;
    const readable = new ReadableStream({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); } });
    let buf = "", inData = false, data = "", authed = false;
    const reply = (s) => queueMicrotask(() => push(s + "\r\n"));
    reply("220 smtp.gmail.com ESMTP fake");
    const writable = new WritableStream({ write(chunk) {
      buf += new TextDecoder().decode(chunk);
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
          if (outbox.length >= failAfter) { reply("550 5.4.5 Daily sending quota exceeded"); continue; }
          outbox.push(parse(data)); reply("250 2.0.0 OK"); continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith("EHLO")) reply("250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8");
        else if (line.startsWith("AUTH PLAIN ")) {
          authed = dec(line.slice(11)) === `\0${user}\0${password}`;
          reply(authed ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted");
        } else if (!authed) reply("530 5.7.0 Authentication Required");
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) reply("250 OK");
        else if (line === "DATA") { inData = true; reply("354 Go ahead"); }
        else if (line === "QUIT") reply("221 bye");
      }
    } });
    return { readable, writable, close: async () => {} };
  };
  connect.connections = connections;
  return connect;
}
