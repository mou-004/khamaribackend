// Reviews, saved items (wishlist) and basket checks. Everything is stored in Firestore.
import { db, httpError } from '../runtime.js';
import { byNewest, identify, needDb, notify, requireUser, shape, shapeAll, stamp, text, toNum, withImages } from '../lib.js';
import { present } from './products.js';

const productRef = (id) => db.collection('products').doc(String(id));

// Has this customer received (delivered) this product? Only those customers may review it.
async function hasReceived(uid, productId) {
  const orders = shapeAll(await db.collection('orders').where('customerId', '==', uid).get());
  return orders.some((o) => o.status === 'received' && (o.items || []).some((i) => i.productId === productId));
}
const summarize = (reviews) => {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  reviews.forEach((r) => { distribution[r.rating] += 1; });
  const count = reviews.length;
  return { count, avg: count ? Math.round((reviews.reduce((n, r) => n + r.rating, 0) / count) * 10) / 10 : 0, distribution };
};

export default function registerEngageRoutes(app) {
  app.get('/api/products/:id/reviews', async (req, res, next) => {
    try {
      needDb();
      const id = String(req.params.id);
      const reviews = shapeAll(await db.collection('reviews').where('productId', '==', id).get()).sort(byNewest);
      const identity = await identify(req, { optional: true });
      const mine = identity ? reviews.find((r) => r.userId === identity.uid) || null : null;
      res.json({ items: reviews.slice(0, 50), summary: summarize(reviews), signedIn: Boolean(identity), canReview: Boolean(identity) && identity.role === 'customer' && (await hasReceived(identity.uid, id)), myReview: mine });
    } catch (error) { next(error); }
  });

  app.post('/api/products/:id/reviews', requireUser, async (req, res, next) => {
    try {
      needDb();
      const id = String(req.params.id);
      if (req.identity.role !== 'customer') throw httpError(403, 'Only customer accounts can submit product reviews.');
      const rating = Math.floor(toNum(req.body?.rating, 0));
      if (rating < 1 || rating > 5) throw httpError(400, 'Choose a rating from 1 to 5 stars.');
      const comment = text(req.body?.comment, 600);
      const snap = await productRef(id).get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      if (!(await hasReceived(req.identity.uid, id))) throw httpError(403, 'You can review a product after your order with it has been delivered.');
      const ref = db.collection('reviews').doc(`${id}_${req.identity.uid}`);
      const existing = await ref.get();
      await ref.set({ productId: id, userId: req.identity.uid, userName: req.identity.name, rating, comment, verified: true, createdAt: existing.exists ? existing.data().createdAt : stamp(), updatedAt: stamp() });
      const all = shapeAll(await db.collection('reviews').where('productId', '==', id).get());
      const s = summarize(all);
      await productRef(id).update({ ratingAvg: s.avg, ratingCount: s.count });
      if (!existing.exists) await notify(snap.data().sellerId, 'New customer review', `${req.identity.name} rated ${snap.data().name} ${rating}★`, `product-detail?id=${id}`, 'review');
      res.status(201).json({ message: existing.exists ? 'Your review was updated.' : 'Thank you for your review!', summary: s });
    } catch (error) { next(error); }
  });

  // Customers can see the reviews they have submitted and return to edit them.
  app.get('/api/reviews/mine', requireUser, async (req, res, next) => {
    try {
      needDb();
      if (req.identity.role !== 'customer') throw httpError(403, 'Customer account required.');
      const reviews = shapeAll(await db.collection('reviews').where('userId', '==', req.identity.uid).get()).sort(byNewest);
      const productIds = [...new Set(reviews.map((r) => r.productId))];
      const products = await Promise.all(productIds.map(async (id) => {
        const snap = await productRef(id).get();
        return [id, snap.exists ? present(req, { id: snap.id, ...snap.data() }) : null];
      }));
      const byId = new Map(products);
      res.json({ items: reviews.map((r) => ({ ...r, product: byId.get(r.productId) })) });
    } catch (error) { next(error); }
  });

  // Sellers may view, but never edit or delete, reviews for their own products.
  app.get('/api/seller/reviews', requireUser, async (req, res, next) => {
    try {
      needDb();
      if (!['seller', 'seller_pending', 'admin'].includes(req.identity.role)) throw httpError(403, 'A seller account is required.');
      const products = shapeAll(await db.collection('products').where('sellerId', '==', req.identity.uid).get());
      const productIds = new Set(products.map((p) => p.id));
      const names = new Map(products.map((p) => [p.id, p.name]));
      const reviews = shapeAll(await db.collection('reviews').get())
        .filter((r) => productIds.has(r.productId))
        .sort(byNewest)
        .slice(0, 300)
        .map((r) => ({ ...r, productName: names.get(r.productId) || 'Product' }));
      res.json({ items: reviews });
    } catch (error) { next(error); }
  });

  // ---- saved items
  app.get('/api/wishlist', requireUser, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('wishlists').doc(req.identity.uid).get();
      const ids = snap.exists ? snap.data().ids || [] : [];
      const items = (await Promise.all(ids.map((id) => productRef(id).get()))).filter((d) => d.exists && d.data().status === 'active').map((d) => present(req, shape(d)));
      res.json({ ids, items });
    } catch (error) { next(error); }
  });
  const writeList = async (uid, change) => {
    const ref = db.collection('wishlists').doc(uid);
    const current = (await ref.get()).data()?.ids || [];
    const ids = [...new Set(change(current))].slice(0, 200);
    await ref.set({ ids, updatedAt: stamp() });
    return ids;
  };
  app.post('/api/wishlist/:id', requireUser, async (req, res, next) => {
    try { needDb(); const id = String(req.params.id); if (!(await productRef(id).get()).exists) throw httpError(404, 'Product not found.'); res.json({ ids: await writeList(req.identity.uid, (l) => [...l, id]) }); } catch (error) { next(error); }
  });
  app.delete('/api/wishlist/:id', requireUser, async (req, res, next) => {
    try { needDb(); const id = String(req.params.id); res.json({ ids: await writeList(req.identity.uid, (l) => l.filter((x) => x !== id)) }); } catch (error) { next(error); }
  });

  // ---- basket check: fresh price and stock for what is in the browser basket
  app.post('/api/cart/check', async (req, res, next) => {
    try {
      needDb();
      const wanted = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 40).map((i) => ({ id: text(i.productId, 80), quantity: Math.max(1, Math.floor(toNum(i.quantity, 1))) })).filter((i) => i.id);
      const items = await Promise.all(wanted.map(async ({ id, quantity }) => {
        const snap = await productRef(id).get();
        const p = snap.exists ? snap.data() : null;
        const ok = Boolean(p) && p.status === 'active' && Number(p.stock) > 0;
        return { productId: id, available: ok, price: ok ? Number(p.price) : 0, stock: ok ? Number(p.stock) : 0, quantity: ok ? Math.min(quantity, Number(p.stock)) : 0, name: p?.name || '', image: ok ? withImages(req, p).image : '', unit: p?.unit || '', sellerId: p?.sellerId || '' };
      }));
      res.json({ items });
    } catch (error) { next(error); }
  });
}