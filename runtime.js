
import { readFileSync, existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

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
// EXPRESS APPLICATION
// ==========================================

const app = express();
const port = Number(process.env.PORT || 5000);

app.use(helmet());

app.use(cors({
  origin: (
    process.env.CLIENT_ORIGIN ||
    'http://localhost:5173,http://localhost:5174,http://localhost:5175'
  ).split(',').map(s => s.trim())
}));

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

  // Prefer complete PEM environment credentials. If the private key is only a
  // placeholder/hash or is malformed, fall back to the service-account JSON.
  if (hasCompleteEnvCredentials && envKeyLooksValid) {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: privateKey
    };
  } else {
    if (hasCompleteEnvCredentials && !envKeyLooksValid) {
      console.warn('FIREBASE_PRIVATE_KEY is not a PEM private key; trying the service-account JSON file instead.');
    }

    const configuredPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const fallbackPath = fileURLToPath(new URL('../firebase-service-account.json', import.meta.url));
    const credentialPath = configuredPath
      ? (isAbsolute(configuredPath) ? configuredPath : resolve(projectRoot, configuredPath))
      : fallbackPath;

    if (existsSync(credentialPath)) {
      serviceAccount = JSON.parse(readFileSync(credentialPath, 'utf8').replace(/^\\uFEFF/, ''));
      if (serviceAccount?.private_key) {
        serviceAccount.private_key = String(serviceAccount.private_key)
          .replace(/\\r\\n/g, '\n')
          .replace(/\\n/g, '\n')
          .trim();
      }
    }
  }

  if (!serviceAccount) {
    throw new Error('Firebase credentials are missing or invalid. Provide a valid PEM FIREBASE_PRIVATE_KEY or set GOOGLE_APPLICATION_CREDENTIALS to a valid service-account JSON file.');
  }

  let serviceAccountKeyValid = false;
  try {
    createPrivateKey(String(serviceAccount.private_key || ''));
    serviceAccountKeyValid = true;
  } catch {
    serviceAccountKeyValid = false;
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccountKeyValid) {
    throw new Error('Firebase service-account credentials are incomplete or invalid. Check project_id, client_email and the PEM private_key in the JSON file.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  db = admin.firestore();
  console.log('Firebase Admin connected.');
} catch (error) {
  console.error('Firebase initialization failed:', error.message);
}

// ==========================================
// SMTP EMAIL CONFIGURATION
// ==========================================

const smtpConfigured = Boolean(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  process.env.SMTP_FROM
);

const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure:
        String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    })
  : null;

let smtpStatus = mailer ? 'checking' : 'not-configured';

if (mailer) {
  mailer.verify()
    .then(() => {
      smtpStatus = 'ready';
      console.log('SMTP connection and authentication OK.');
    })
    .catch(error => {
      smtpStatus = 'failed';

      console.error(
        'SMTP verification failed:',
        error.code,
        error.message
      );
    });
}

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
    throw httpError(
      503,
      'Firebase Admin is not configured.'
    );
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
    throw httpError(
      401,
      'A Firebase sign-in token is required.'
    );
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

    // IMPORTANT: Customer email for OTP delivery
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
    configured: smtpConfigured,
    status: smtpStatus,
    host: process.env.SMTP_HOST || null,
    senderConfigured: Boolean(process.env.SMTP_FROM)
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
