import { env } from '../config/env.js';

// Email delivery menggunakan Resend REST API agar tidak menambah dependency SMTP.
export async function sendEmail({ to, subject, html, text }) {
  if (!env.email.apiKey || !env.email.from) {
    if (env.isProd) throw new Error('EMAIL_API_KEY dan EMAIL_FROM belum dikonfigurasi');
    return { sent: false, reason: 'email_not_configured' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.email.from, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email provider gagal (${response.status}): ${detail.slice(0, 300)}`);
  }
  return { sent: true };
}
