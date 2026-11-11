import { db, httpError } from '../runtime.js';
import { identify, needDb, requireUser, text } from '../lib.js';

export const couponId = (code) => text(code, 24).toUpperCase().replace(/[^A-Z0-9_-]/g, '');

// Returns the discount amount for a coupon document or throws a friendly error.
export function checkCoupon(coupon, identity, subtotal) {
  if (!coupon || coupon.status !== 'active') throw httpError(400, 'This coupon code is not valid.');
  if (coupon.expiresAt && Date.parse(coupon.expiresAt?.toDate ? coupon.expiresAt.toDate().toISOString() : coupon.expiresAt) < Date.now()) throw httpError(400, 'This coupon has expired.');
  if (coupon.role && coupon.role !== 'all' && coupon.role !== (identity.role === 'seller_pending' ? 'customer' : identity.role)) throw httpError(400, 'This coupon is not available for your account.');
  if (Number(coupon.maxUses) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) throw httpError(400, 'This coupon has been fully redeemed.');
  if (Number(coupon.minOrder) > 0 && subtotal < Number(coupon.minOrder)) throw httpError(400, `Spend at least ৳${coupon.minOrder} to use this coupon.`);
  return Math.floor((subtotal * Number(coupon.discount || 0)) / 100);
}

const dateMillis = (value) => {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export default function registerCouponRoutes(app) {
  // Show active admin-created promo codes to the audiences allowed to use them.
  // This endpoint reveals offer terms only, never internal admin or redemption data.
  app.get('/api/coupons/available', async (req, res, next) => {
    try {
      needDb();
      const identity = await identify(req, { optional: true });
      const role = identity?.role === 'seller_pending' ? 'customer' : (identity?.role || 'customer');
      const now = Date.now();
      const snap = await db.collection('coupons').where('status', '==', 'active').get();
      const items = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((coupon) => !coupon.role || coupon.role === 'all' || coupon.role === role)
        .filter((coupon) => !dateMillis(coupon.expiresAt) || dateMillis(coupon.expiresAt) >= now)
        .filter((coupon) => !(Number(coupon.maxUses) > 0) || Number(coupon.usedCount || 0) < Number(coupon.maxUses))
        .sort((a, b) => dateMillis(b.createdAt) - dateMillis(a.createdAt))
        .map((coupon) => ({
          code: coupon.code || coupon.id,
          discount: Number(coupon.discount || 0),
          role: coupon.role || 'all',
          minOrder: Number(coupon.minOrder || 0),
          expiresAt: coupon.expiresAt || null,
          maxUses: Number(coupon.maxUses || 0),
          usedCount: Number(coupon.usedCount || 0)
        }));
      res.json({ items });
    } catch (error) { next(error); }
  });

  app.post('/api/coupons/validate', requireUser, async (req, res, next) => {
    try {
      needDb();
      const id = couponId(req.body?.code);
      if (!id) throw httpError(400, 'Enter a coupon code.');
      const snap = await db.collection('coupons').doc(id).get();
      const subtotal = Number(req.body?.subtotal) || 0;
      const discount = checkCoupon(snap.exists ? snap.data() : null, req.identity, subtotal);
      res.json({ code: id, percent: Number(snap.data().discount), discount, message: `Coupon applied: ${snap.data().discount}% off.` });
    } catch (error) { next(error); }
  });
}