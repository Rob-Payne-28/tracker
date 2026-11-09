import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

/** Sends email when SMTP_URL is configured; otherwise a no-op (messages are logged at debug level). */
export class Mailer {
  private transport: Transporter | null;

  constructor(private config: Config) {
    this.transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  }

  get enabled() {
    return this.transport !== null;
  }

  async send(to: string, subject: string, text: string) {
    if (!this.transport) return;
    try {
      await this.transport.sendMail({ from: this.config.mailFrom, to, subject, text });
    } catch (err) {
      console.error('Failed to send email', err);
    }
  }
}
