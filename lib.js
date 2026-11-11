// Shared helpers for the seller / admin / order APIs. Every new route uses these.
import { admin, db, httpError, mailer, smtpConfigured } from './runtime.js';
import { shouldCreateInAppNotification, shouldSendNotificationEmail } from './notification-policy.js';

const ADMIN_ROLES = ['admin', 'superAdmin', 'super-admin'];

export const needDb = () => {
  if (!db) throw httpError(503, 'Firebase is not connected. Place firebase-service-account.json beside server.js and restart the backend.');
  return db;
};
export const stamp = () => admin.firestore.FieldValue.serverTimestamp();
export const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
export const toNum = (value, fallback = 0) => (value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : fallback);
export const money = (value) => Math.round(Number(value || 0) * 100) / 100;
export const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

// Firestore Timestamps -> ISO strings (recursively) so the browser gets plain JSON.
export function plain(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}
export const shape = (doc) => ({ id: doc.id, ...plain(doc.data()) });
export const shapeAll = (snapshot) => snapshot.docs.map(shape);

// ---- identity & guards -------------------------------------------------------------------
export async function identify(req, { optional = false } = {}) {
  needDb();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { if (optional) return null; throw httpError(401, 'Sign in is required.'); }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch { if (optional) return null; throw httpError(401, 'Your sign-in expired. Please sign in again.'); }
  const snap = await db.collection('users').doc(decoded.uid).get();
  const profile = snap.exists ? snap.data() : null;
  if (!profile || profile.emailVerified !== true) { if (optional) return null; throw httpError(403, 'Verify your email to use this feature.'); }
  const status = String(profile.status || 'active');
  if (status === 'suspended') { if (optional) return null; throw httpError(403, 'This account is suspended. Contact support.'); }
  const rawRole = ADMIN_ROLES.includes(profile.role) ? 'admin' : String(profile.role || 'customer');
  return {
    uid: decoded.uid,
    email: String(decoded.email || profile.email || ''),
    name: text(profile.name || decoded.name || decoded.email || 'Khamari user', 80),
    role: ADMIN_ROLES.includes(rawRole) ? 'admin' : rawRole, // customer | seller_pending | seller | admin
    status,
    profile,
  };
}
const guard = (check) => (req, _res, next) => identify(req).then((identity) => { check(identity); req.identity = identity; next(); }).catch(next);
export const requireUser = guard(() => {});
export const requireAdminUser = guard((id) => { if (id.role !== 'admin') throw httpError(403, 'Administrator access is required.'); });
export const requireSeller = guard((id) => {
  if (id.role === 'admin') return;
  if (id.role !== 'seller' && id.role !== 'seller_pending') throw httpError(403, 'A seller account is required.');
  if (id.role === 'seller_pending' || !['approved', 'active'].includes(id.status)) throw httpError(403, 'Your seller account is awaiting approval by an administrator.');
});
// Pending sellers may open their dashboard (read-only data) but not create/modify.
export const requireSellerArea = guard((id) => { if (!['seller', 'seller_pending', 'admin'].includes(id.role)) throw httpError(403, 'A seller account is required.'); });

// ---- notifications -------------------------------------------------------------------------
export const NOTIFY_TYPES = ['order', 'product', 'auction', 'payment', 'review', 'announcement', 'account'];
export const DEFAULT_NOTIFY_PREFS = { order: true, product: true, auction: true, payment: true, review: true, announcement: true, email: true };
const inferType = (link = '') => (/order/.test(link) ? 'order' : /auction/.test(link) ? 'auction' : /earnings|payout/.test(link) ? 'payment' : /product/.test(link) ? 'product' : 'account');

// Creates an in-app notification for one user. It respects that user's notification settings
// (account messages are always delivered) and emails order/payment updates when SMTP is set up.
export async function notify(uid, title, body = '', link = '', type = '') {
  if (!uid || !db) return;
  try {
    const kind = NOTIFY_TYPES.includes(type) ? type : inferType(link);
    const user = (await db.collection('users').doc(uid).get()).data();
    if (!user) { console.error(`Notification recipient not found: ${uid}`); return; }
    const prefs = { ...DEFAULT_NOTIFY_PREFS, ...(user.notifyPrefs || {}) };
    // Always persist critical order/payment events in-app. Preferences may
    // disable their email copy, but must never hide a marketplace transaction.
    if (!shouldCreateInAppNotification(kind, prefs)) return;
    await db.collection('notifications').add({ userId: uid, type: kind, title: text(title, 120), body: text(body, 300), link, read: false, createdAt: stamp() });
    if (smtpConfigured && user.email && shouldSendNotificationEmail(kind, prefs)) {
      mailer.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: `Khamari: ${text(title, 100)}`, text: `${text(body, 300)}\n\nOpen Khamari to see the details.` }).catch(() => {});
    }
  } catch (error) { console.error('Notification failed:', error.message); }
}

// Send only the optional email copy for an event whose in-app notification was
// already committed atomically with the order/payment record.
export async function emailNotification(uid, title, body = '', type = '') {
  if (!smtpConfigured || !uid || !['order', 'payment'].includes(type)) return;
  try {
    const user = (await db.collection('users').doc(uid).get()).data();
    const prefs = { ...DEFAULT_NOTIFY_PREFS, ...(user?.notifyPrefs || {}) };
    if (!user?.email || !shouldSendNotificationEmail(type, prefs)) return;
    await mailer.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: `Khamari: ${text(title, 100)}`, text: `${text(body, 300)}\n\nOpen Khamari to see the details.` });
  } catch (error) { console.error('Notification email failed:', error.message); }
}

export async function notifyAdmins(title, body = '', link = '', type = 'account') {
  if (!db) return;
  try {
    const found = await Promise.all(ADMIN_ROLES.map((r) => db.collection('users').where('role', '==', r).get()));   // every admin account
    await Promise.all(found.flatMap((snap) => snap.docs).map((doc) => notify(doc.id, title, body, link, type)));
  } catch (error) { console.error('Admin notification failed:', error.message); }
}

// ---- images --------------------------------------------------------------------------------
export const apiOrigin = (req) => (process.env.PUBLIC_API_URL ? process.env.PUBLIC_API_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`);
const absUrl = (req, url) => (typeof url === 'string' && url.startsWith('/api/images/') ? apiOrigin(req) + url : url);
export const withImages = (req, item) => ({ ...item, image: absUrl(req, item.image), images: (item.images || []).map((u) => absUrl(req, u)) });
export const withOrderImages = (req, order) => ({ ...order, items: (order.items || []).map((i) => ({ ...i, image: absUrl(req, i.image) })) });
export const relativeImage = (url) => String(url || '').trim().replace(/^https?:\/\/[^/]+(?=\/api\/images\/)/, '');

// ---- platform settings ---------------------------------------------------------------------
export const DEFAULT_SETTINGS = { commissionRate: 5, deliveryFee: 60, freeDeliveryOver: 1500, minPayout: 500 };
export async function getSettings() {
  const snap = await needDb().collection('settings').doc('platform').get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? plain(snap.data()) : {}) };
}

// ---- analytics helpers ---------------------------------------------------------------------
export const lastDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
export function revenueSeries(orders, days = 30, field = 'total') {
  const map = new Map(lastDays(days).map((d) => [d, { date: d, revenue: 0, orders: 0 }]));
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const row = map.get(String(o.createdAt || '').slice(0, 10));
    if (row) { row.revenue += Number(o[field] || 0); row.orders += 1; }
  }
  return [...map.values()].map((r) => ({ ...r, revenue: money(r.revenue) }));
}
export function countBy(list, key) { const out = {}; for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1; return out; }
export function topProducts(orders, limit = 5) {
  const map = new Map();
  for (const o of orders) { if (o.status === 'cancelled') continue; for (const i of o.items || []) {
    const row = map.get(i.productId) || { productId: i.productId, name: i.name, image: i.image, units: 0, revenue: 0 };
    row.units += Number(i.quantity || 0);
    row.revenue += Number(i.lineTotal ?? (Number(i.price || 0) * Number(i.quantity || 0)));
    map.set(i.productId, row);
  } }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}