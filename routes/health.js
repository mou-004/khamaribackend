import { db, mailer, smtpStatus } from "../runtime.js";

export default function registerHealthRoutes(app) {
app.get('/api/health', (_req, res) => res.status(db ? 200 : 503).json({

  ok: Boolean(db), service: 'khamari-api',

  persistence: db ? 'firestore' : 'unavailable',

  firebase: Boolean(db),

  emailOtpConfigured: Boolean(db && mailer),

  emailOtpTransport: mailer ? 'smtp' : 'not-configured',
  smtpStatus,

  auctionRules: { durationDays: '1-30 per lot', bidIncrement: 'fixed amount per lot', timezone: 'UTC timestamps' },

}));
}
