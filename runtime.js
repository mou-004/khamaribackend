import { readFileSync, existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

// Load a local .env file when running locally. Render environment variables
// take precedence because dotenv does not overwrite existing process.env values.
dotenv.config({
  path: fileURLToPath(new URL('../.env', import.meta.url))
});

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

import {
  createHash,
  createPrivateKey,
  randomInt,
  timingSafeEqual
} from 'node:crypto';

// ==========================================
// EXPRESS APPLICATION AND CORS
// ==========================================

const app = express();
const port = Number(process.env.PORT || 5000);

const configuredClientOrigins = String(process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  'https://khamariclient.onrender.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  ...configuredClientOrigins
];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ],
  optionsSuccessStatus: 204
};

// Register CORS before other middleware and before all routes so that
// normal requests and browser OPTIONS preflight requests are both handled.
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ==========================================
// ERROR HELPER
// ==========================================

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

// ==========================================
// FIREBASE ADMIN
// ==========================================

let db = null;

try {
  let serviceAccount = null;

  // Render may store PEM line breaks as literal \n characters.
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();

  const hasCompleteEnvCredentials = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    privateKey
  );

  let envKeyLooksValid = false;

  if (privateKey) {
    try {
      createPrivateKey(privateKey);
      envKeyLooksValid = true;
    } catch {
      envKeyLooksValid = false;
    }
  }

  // Prefer complete PEM environment credentials. If the private key is a
  // placeholder/hash or malformed, try the service-account JSON file instead.
  if (hasCompleteEnvCredentials && envKeyLooksValid) {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: privateKey
    };
  } else {
    if (hasCompleteEnvCredentials && !envKeyLooksValid) {
      console.warn(
        'FIREBASE_PRIVATE_KEY is not a valid PEM private key; trying the service-account JSON file instead.'
      );
    }

    const configuredPath = String(
      process.env.GOOGLE_APPLICATION_CREDENTIALS || ''
    ).trim();

    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const fallbackPath = fileURLToPath(
      new URL('../firebase-service-account.json', import.meta.url)
    );

    const credentialPath = configuredPath
      ? (isAbsolute(configuredPath)
          ? configuredPath
          : resolve(projectRoot, configuredPath))
      : fallbackPath;

    if (existsSync(credentialPath)) {
      serviceAccount = JSON.parse(
        readFileSync(credentialPath, 'utf8').replace(/^\uFEFF/, '')
      );

      if (serviceAccount?.private_key) {
        serviceAccount.private_key = String(serviceAccount.private_key)
          .replace(/\\r\\n/g, '\n')
          .replace(/\\n/g, '\n')
          .trim();
      }
    }
  }

  if (!serviceAccount) {
    throw new Error(
      'Firebase credentials are missing or invalid. Provide a valid PEM FIREBASE_PRIVATE_KEY or set GOOGLE_APPLICATION_CREDENTIALS to a valid service-account JSON file.'
    );
  }

  let serviceAccountKeyValid = false;

  try {
    createPrivateKey(String(serviceAccount.private_key || ''));
    serviceAccountKeyValid = true;
  } catch {
    serviceAccountKeyValid = false;
  }

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccountKeyValid
  ) {
    throw new Error(
      'Firebase service-account credentials are incomplete or invalid. Check project_id, client_email and the PEM private_key in the JSON file.'
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();
  console.log('Firebase Admin connected.');
} catch (error) {
  console.error('Firebase initialization failed:', error.message);
}

// ==========================================
// EMAIL CONFIGURATION: BREVO API + SMTP
// ==========================================

const smtpConfigured = Boolean(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  process.env.SMTP_FROM
);

const brevoSenderEmail = String(
  process.env.BREVO_FROM_EMAIL || ''
).trim();

const brevoConfigured = Boolean(
  process.env.BREVO_API_KEY && brevoSenderEmail
);

const emailConfigured = brevoConfigured || smtpConfigured;

// Keep the real SMTP transport available. Render Free may block outbound SMTP,
// but this remains usable locally or on hosts that permit SMTP connections.
const smtpMailer = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    })
  : null;

function parseEmailAddress(value) {
  if (value && typeof value === 'object' && value.email) {
    return {
      email: String(value.email).trim(),
      name: String(value.name || '').trim()
    };
  }

  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)\s*<([^<>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^['"]|['"]$/g, '').trim(),
      email: match[2].trim()
    };
  }
  return { email: raw, name: '' };
}

function normaliseRecipients(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(item => typeof item === 'string' && item.includes(',')
      ? item.split(',')
      : [item])
    .map(parseEmailAddress)
    .filter(item => item.email);
}

async function sendViaBrevo(message) {
  const senderFromMessage = parseEmailAddress(message.from || process.env.SMTP_FROM);
  const sender = {
    email: brevoSenderEmail || senderFromMessage.email,
    name: String(
      process.env.BREVO_FROM_NAME || senderFromMessage.name || 'Khamari'
    ).trim()
  };
  const to = normaliseRecipients(message.to).map(({ email, name }) =>
    name ? { email, name } : { email }
  );

  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured.');
  }
  if (!sender.email) {
    throw new Error('BREVO_FROM_EMAIL is not configured.');
  }
  if (!to.length) {
    throw new Error('No valid recipient email address was supplied.');
  }

  const payload = {
    sender,
    to,
    subject: String(message.subject || 'Khamari notification'),
    ...(message.text ? { textContent: String(message.text) } : {}),
    ...(message.html ? { htmlContent: String(message.html) } : {})
  };

  const cc = normaliseRecipients(message.cc).map(({ email, name }) =>
    name ? { email, name } : { email }
  );
  const bcc = normaliseRecipients(message.bcc).map(({ email, name }) =>
    name ? { email, name } : { email }
  );
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;

  const replyTo = parseEmailAddress(message.replyTo);
  if (replyTo.email) {
    payload.replyTo = replyTo.name
      ? { email: replyTo.email, name: replyTo.name }
      : { email: replyTo.email };
  }

  // Support simple Nodemailer attachments as well as the existing text/HTML emails.
  if (Array.isArray(message.attachments) && message.attachments.length) {
    payload.attachment = message.attachments.map(item => {
      if (item.content != null) {
        const content = Buffer.isBuffer(item.content)
          ? item.content.toString('base64')
          : Buffer.from(String(item.content), item.encoding === 'base64' ? 'base64' : 'utf8').toString('base64');
        return { name: item.filename || item.name || 'attachment', content };
      }
      if (item.path && /^https:\/\//i.test(String(item.path))) {
        return { name: item.filename || item.name || 'attachment', url: String(item.path) };
      }
      if (item.path) {
        return {
          name: item.filename || item.name || 'attachment',
          content: readFileSync(item.path).toString('base64')
        };
      }
      throw new Error('Unsupported email attachment format for Brevo.');
    });
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  const responseText = await response.text();
  let responseData = {};
  try { responseData = responseText ? JSON.parse(responseText) : {}; } catch { /* keep raw response out of user-facing errors */ }

  if (!response.ok) {
    const error = new Error(
      responseData.message || `Brevo email API returned HTTP ${response.status}.`
    );
    error.code = 'BREVO_API_ERROR';
    error.status = response.status;
    throw error;
  }

  return {
    accepted: to.map(item => item.email),
    rejected: [],
    messageId: responseData.messageId || null,
    provider: 'brevo'
  };
}

let smtpStatus = smtpMailer ? 'checking' : 'not-configured';
let emailStatus = brevoConfigured ? 'configured' : smtpStatus;

if (smtpMailer) {
  smtpMailer.verify()
    .then(() => {
      smtpStatus = 'ready';
      if (!brevoConfigured) emailStatus = 'ready';
      console.log('SMTP connection and authentication OK.');
    })
    .catch(error => {
      smtpStatus = 'failed';
      if (!brevoConfigured) emailStatus = 'failed';
      console.error('SMTP verification failed:', error.code, error.message);
    });
}

// Existing route files can continue calling mailer.sendMail(...).
// Brevo is preferred when configured. SMTP remains available when Brevo is
// not configured, or as an opt-in fallback on hosts that permit SMTP.
const mailer = emailConfigured
  ? {
      async sendMail(message) {
        if (brevoConfigured) {
          try {
            return await sendViaBrevo(message);
          } catch (error) {
            const smtpFallbackEnabled =
              String(process.env.EMAIL_SMTP_FALLBACK || 'false').toLowerCase() === 'true';
            if (!smtpMailer || !smtpFallbackEnabled) throw error;
            console.warn('Brevo send failed; trying configured SMTP fallback:', error.message);
            return smtpMailer.sendMail(message);
          }
        }
        if (smtpMailer) return smtpMailer.sendMail(message);
        throw new Error('No email provider is configured.');
      },
      // Kept for the existing SMTP diagnostic endpoint.
      verify() {
        if (!smtpMailer) throw new Error('SMTP is not configured.');
        return smtpMailer.verify();
      }
    }
  : null;

// ==========================================
// OTP HASH
// ==========================================

const otpDigest = (uid, code) =>
  createHash('sha256')
    .update(
      `${uid}:${code}:${process.env.OTP_HASH_SECRET ||
        process.env.FIREBASE_PROJECT_ID ||
        'khamari-email-otp'}`
    )
    .digest('hex');

// ==========================================
// USER ROLES
// ==========================================

const safeRequestedRole = role =>
  ['customer', 'seller', 'admin'].includes(role)
    ? role
    : 'customer';

// ==========================================
// FIREBASE REQUEST VERIFICATION
// ==========================================

async function verifyFirebaseRequest(req) {
  if (!admin.apps.length || !db) {
    throw httpError(503, 'Firebase Admin is not configured.');
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : '';

  if (!token) {
    throw httpError(401, 'Sign in is required.');
  }

  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    throw httpError(
      401,
      'Your Firebase sign-in token is invalid or expired. Please sign in again.'
    );
  }
}

// ==========================================
// AUTHENTICATED USER IDENTITY
// ==========================================

async function readIdentity(req, { required = true } = {}) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : '';

  if (!db) {
    throw httpError(
      503,
      'Firebase is not connected. Configure server credentials.'
    );
  }

  if (!token && required) {
    throw httpError(401, 'A Firebase sign-in token is required.');
  }

  if (!token) return null;

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    throw httpError(
      401,
      'Your sign-in token is invalid or expired. Please sign in again.'
    );
  }

  let profile = {};

  try {
    const userDoc = await db
      .collection('users')
      .doc(decoded.uid)
      .get();

    if (userDoc.exists) {
      profile = userDoc.data() || {};
    }
  } catch (error) {
    console.error('User profile lookup failed:', error.message);
  }

  const role = [
    'admin',
    'superAdmin',
    'super-admin'
  ].includes(profile.role)
    ? 'admin'
    : String(profile.role || 'customer');

  return {
    uid: decoded.uid,

    // Customer email is used for OTP delivery.
    email: String(
      decoded.email ||
      profile.email ||
      ''
    ).trim().toLowerCase(),

    name: String(
      profile.name ||
      decoded.name ||
      decoded.email ||
      'Khamari user'
    ).slice(0, 80),

    role,
    status: String(profile.status || 'active')
  };
}

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

const requireUser = async (req, res, next) => {
  try {
    const identity = await readIdentity(req);

    if (!identity) {
      throw httpError(401, 'Please sign in.');
    }

    if (!identity.email) {
      throw httpError(
        400,
        'Your authenticated account has no email address.'
      );
    }

    req.identity = identity;
    next();
  } catch (error) {
    next(error);
  }
};

// ==========================================
// SELLER OR ADMIN MIDDLEWARE
// ==========================================

const requireSellerOrAdmin = async (req, res, next) => {
  try {
    const identity = await readIdentity(req);

    if (
      !['seller', 'admin', 'superAdmin', 'super-admin']
        .includes(identity.role)
    ) {
      return res.status(403).json({
        error:
          'Only approved sellers or administrators can create auction listings.'
      });
    }

    if (
      identity.role === 'seller' &&
      identity.status !== 'approved' &&
      identity.status !== 'active'
    ) {
      return res.status(403).json({
        error:
          'Your seller account is awaiting approval before you can create auction listings.'
      });
    }

    req.identity = identity;
    next();
  } catch (error) {
    next(error);
  }
};

// ==========================================
// ADMIN MIDDLEWARE
// ==========================================

const requireAdmin = async (req, res, next) => {
  try {
    const identity = await readIdentity(req);

    if (
      !['admin', 'superAdmin', 'super-admin']
        .includes(identity.role)
    ) {
      return res.status(403).json({
        error: 'Administrator access is required.'
      });
    }

    req.identity = identity;
    next();
  } catch (error) {
    next(error);
  }
};

// ==========================================
// EMAIL DIAGNOSTIC ENDPOINT
// ==========================================

app.get('/api/payments/email-status', (req, res) => {
  res.json({
    configured: emailConfigured,
    status: emailStatus,
    provider: brevoConfigured ? 'brevo' : (smtpConfigured ? 'smtp' : 'not-configured'),
    brevoConfigured,
    smtpConfigured,
    smtpStatus,
    senderConfigured: Boolean(process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM)
  });
});

// ==========================================
// EXPORTS
// ==========================================

export {
  readFileSync,
  dotenv,
  fileURLToPath,
  express,
  cors,
  helmet,
  morgan,
  admin,
  nodemailer,

  createHash,
  createPrivateKey,
  randomInt,
  timingSafeEqual,

  app,
  port,
  db,

  smtpConfigured,
  smtpMailer,
  brevoConfigured,
  emailConfigured,
  emailStatus,
  mailer,
  smtpStatus,

  otpDigest,
  safeRequestedRole,
  verifyFirebaseRequest,

  httpError,
  readIdentity,
  requireUser,
  requireSellerOrAdmin,
  requireAdmin
};
