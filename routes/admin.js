import { db, httpError } from '../runtime.js';
import { byNewest, countBy, DEFAULT_SETTINGS, getSettings, money, needDb, notify, plain, requireAdminUser, revenueSeries, shape, shapeAll, stamp, text, toNum, topProducts, withImages, withOrderImages } from '../lib.js';
import { listOrders } from './orders.js';
import { cleanImages } from './products.js';
import { couponId } from './coupons.js';

const all = async (name) => shapeAll(await db.collection(name).get());

export default function registerAdminRoutes(app) {
  const A = requireAdminUser;
  // Every admin action is written to an activity log (visible on the Activity log page).
  const audit = (req, action, target = '', detail = '') => db.collection('auditLog').add({ adminId: req.identity.uid, adminName: req.identity.name, action, target: text(target, 120), detail: text(detail, 200), createdAt: stamp() }).catch(() => {});

  // ---------------------------------------------------------------- analytics / overview
  app.get('/api/admin/analytics', A, async (req, res, next) => {
    try {
      needDb();
      const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      const [users, products, orders, payouts, auctions, refunds] = await Promise.all(['users', 'products', 'orders', 'payouts', 'auctions', 'refunds'].map(all));
      const live = orders.filter((o) => o.status !== 'cancelled');
      const delivered = orders.filter((o) => ['delivered', 'received'].includes(o.status));
      const sellers = new Map();
      for (const o of live) { const r = sellers.get(o.sellerId) || { sellerId: o.sellerId, name: o.sellerName, orders: 0, revenue: 0 }; r.orders += 1; r.revenue += Number(o.subtotal - o.discount || 0); sellers.set(o.sellerId, r); }
      const categories = new Map();
      const productCategory = new Map(products.map((p) => [p.id, p.category]));
      for (const o of live) for (const i of o.items || []) { const c = productCategory.get(i.productId) || 'Other'; categories.set(c, (categories.get(c) || 0) + i.lineTotal); }
      const thirty = new Date(Date.now() - 30 * 86400000).toISOString();
      res.json({
        totals: {
          users: users.length, customers: users.filter((u) => u.role === 'customer').length, sellers: users.filter((u) => u.role === 'seller').length,
          newUsers: users.filter((u) => String(u.createdAt || '') >= thirty).length,
          products: products.length, activeProducts: products.filter((p) => p.status === 'active').length,
          orders: live.length, revenue: money(live.reduce((n, o) => n + Number(o.total || 0), 0)), deliveredRevenue: money(delivered.reduce((n, o) => n + Number(o.total || 0), 0)),
          commission: money(delivered.reduce((n, o) => n + Number(o.commission || 0), 0)),
          avgOrder: live.length ? money(live.reduce((n, o) => n + Number(o.total || 0), 0) / live.length) : 0,
          refunded: money(refunds.filter((r) => r.status === 'refunded').reduce((n, r) => n + Number(r.amount || 0), 0)), refundsOpen: refunds.filter((r) => ['requested', 'approved', 'return_shipped', 'refund_pending', 'escalated'].includes(r.status)).length,
          openAuctions: auctions.filter((a) => a.status === 'active' && Date.parse(a.endsAt) > Date.now()).length,
        },
        pending: {
          sellers: users.filter((u) => u.role === 'seller_pending').length,
          products: products.filter((p) => p.status === 'pending').length,
          payouts: payouts.filter((p) => p.status === 'requested').length,
          refunds: refunds.filter((r) => ['requested', 'approved', 'return_shipped', 'refund_pending', 'escalated'].includes(r.status)).length,
          newOrders: live.filter((o) => o.status === 'placed').length,
          onlinePayments: live.filter((o) => !['cash', 'cod', 'cash on delivery'].includes(String(o.paymentMethod || '').toLowerCase()) && ['pending', 'submitted'].includes(String(o.paymentStatus || 'pending').toLowerCase())).length,
          onlinePaymentValue: money(live.filter((o) => !['cash', 'cod', 'cash on delivery'].includes(String(o.paymentMethod || '').toLowerCase()) && ['pending', 'submitted'].includes(String(o.paymentStatus || 'pending').toLowerCase())).reduce((n, o) => n + Number(o.total || 0), 0)),
        },
        ordersByStatus: countBy(orders, 'status'),
        revenueByDay: revenueSeries(orders, days, 'total'),
        topProducts: topProducts(orders, 6).map((p) => withImages(req, p)),
        topSellers: [...sellers.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((s) => ({ ...s, revenue: money(s.revenue) })),
        categorySales: [...categories.entries()].map(([category, revenue]) => ({ category, revenue: money(revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
        recentOrders: [...orders].sort(byNewest).slice(0, 6).map((o) => withOrderImages(req, o)),
      });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- users and seller approvals
  app.get('/api/admin/users', A, async (req, res, next) => {
    try {
      needDb();
      const users = await all('users');
      const rows = users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, phone: u.phone || '', area: u.area || '', storeName: u.storeName || '', createdAt: u.createdAt || '', adminApplication: '' })).sort(byNewest);
      res.json({ items: rows });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/users/:uid', A, async (req, res, next) => {
    try {
      needDb();
      const uid = String(req.params.uid);
      const action = String(req.body?.action || '');
      const ref = db.collection('users').doc(uid);
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'User not found.');
      const user = snap.data();
      const self = uid === req.identity.uid;
      const set = async (patch, title, body, link) => { await ref.set({ ...patch, updatedAt: stamp() }, { merge: true }); if (title) await notify(uid, title, body, link); };
      if (action === 'approve-seller') {
        if (!['seller_pending', 'customer'].includes(user.role)) throw httpError(400, 'This account is not waiting for seller approval.');
        await set({ role: 'seller', status: 'approved' }, 'Your seller account was approved', 'You can now add products and start selling.', 'seller');
      } else if (action === 'reject-seller') {
        await set({ role: 'customer', status: 'active', sellerApplication: 'rejected' }, 'Seller application declined', 'Contact support if you think this is a mistake.', 'support');
      } else if (action === 'suspend') {
        if (self) throw httpError(400, 'You cannot suspend your own account.');
        await set({ status: 'suspended' });
      } else if (action === 'activate') {
        await set({ status: user.role === 'seller' ? 'approved' : 'active' });
      } else throw httpError(400, 'Unknown action.');
      await audit(req, `user.${action}`, `${user.name || uid} (${user.email || ''})`);
      res.json({ message: 'User updated.' });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- products (moderation)
  app.get('/api/admin/products', A, async (req, res, next) => {
    try {
      needDb();
      let list = (await all('products')).sort(byNewest);
      if (req.query.status) list = list.filter((p) => p.status === req.query.status);
      res.json({ items: list.map((p) => withImages(req, p)) });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/products/:id/review', A, async (req, res, next) => {
    try {
      needDb();
      const status = String(req.body?.status || '');
      if (!['active', 'rejected', 'pending', 'paused'].includes(status)) throw httpError(400, 'Invalid status.');
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const note = text(req.body?.note, 300);
      await ref.update({ status, reviewNote: note, reviewedBy: req.identity.name, updatedAt: stamp() });
      const p = snap.data();
      if (status === 'active') await notify(p.sellerId, 'Product approved', `${p.name} is now live in the marketplace.`, 'seller-products');
      if (status === 'rejected') await notify(p.sellerId, 'Product needs changes', `${p.name}: ${note || 'Please review the details and resubmit.'}`, 'seller-products');
      await audit(req, `product.${status}`, p.name, note);
      res.json({ message: status === 'active' ? 'Product approved.' : 'Product updated.' });
    } catch (error) { next(error); }
  });

  // Explicitly assign older/orphaned products to a verified seller account.
  // This is an administrator-only fallback when legacy records contain no
  // reliable seller UID or email that the seller repair route can match.
  app.patch('/api/admin/products/:id/assign-seller', A, async (req, res, next) => {
    try {
      needDb();
      const productRef = db.collection('products').doc(String(req.params.id));
      const sellerId = text(req.body?.sellerId, 128);
      if (!sellerId) throw httpError(400, 'Choose a seller account.');
      const [productSnap, sellerSnap] = await Promise.all([
        productRef.get(),
        db.collection('users').doc(sellerId).get()
      ]);
      if (!productSnap.exists) throw httpError(404, 'Product not found.');
      if (!sellerSnap.exists) throw httpError(404, 'Seller account not found.');
      const seller = sellerSnap.data();
      if (!['seller', 'seller_pending'].includes(seller.role) || seller.status === 'suspended') {
        throw httpError(400, 'Choose an active seller or a seller awaiting approval.');
      }
      const product = productSnap.data();
      await productRef.update({
        sellerId,
        sellerUid: sellerId,
        sellerEmail: String(seller.email || '').trim().toLowerCase(),
        sellerName: String(seller.storeName || seller.name || 'Khamari Seller').slice(0, 100),
        ownershipAssignedBy: req.identity.uid,
        ownershipAssignedAt: stamp(),
        updatedAt: stamp()
      });
      await audit(req, 'product.assign-seller', product.name, `Assigned to ${seller.name || sellerId}`);
      await notify(sellerId, 'Product linked to your store', `${product.name} is now connected to your seller account.`, 'seller-products');
      res.json({ success: true, message: `${product.name} is now linked to ${seller.storeName || seller.name || 'the selected seller'}.` });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- orders
  app.get('/api/admin/orders', A, async (req, res, next) => { try { res.json({ items: await listOrders(req) }); } catch (error) { next(error); } });

  // ---------------------------------------------------------------- categories
  const categoryDoc = (b) => {
    const name = text(b.name, 60);
    if (name.length < 2) throw httpError(400, 'Enter a category name.');
    return { name, subcategories: [...new Set((Array.isArray(b.subcategories) ? b.subcategories : String(b.subcategories || '').split(',')).map((s) => text(s, 60)).filter(Boolean))].slice(0, 30), image: text(b.image, 1500), order: Math.floor(toNum(b.order, 0)), status: b.status === 'hidden' ? 'hidden' : 'active', updatedAt: stamp() };
  };
  app.get('/api/admin/categories', A, async (_req, res, next) => { try { needDb(); res.json({ items: (await all('categories')).sort((a, b) => Number(a.order) - Number(b.order) || String(a.name).localeCompare(b.name)) }); } catch (error) { next(error); } });
  app.post('/api/admin/categories', A, async (req, res, next) => { try { needDb(); const ref = await db.collection('categories').add({ ...categoryDoc(req.body || {}), createdAt: stamp() }); await audit(req, 'category.create', String(req.body?.name || '')); res.status(201).json({ id: ref.id, message: 'Category added.' }); } catch (error) { next(error); } });
  app.put('/api/admin/categories/:id', A, async (req, res, next) => { try { needDb(); const ref = db.collection('categories').doc(String(req.params.id)); if (!(await ref.get()).exists) throw httpError(404, 'Category not found.'); await ref.update(categoryDoc(req.body || {})); await audit(req, 'category.update', String(req.body?.name || '')); res.json({ message: 'Category saved.' }); } catch (error) { next(error); } });
  app.delete('/api/admin/categories/:id', A, async (req, res, next) => { try { needDb(); await db.collection('categories').doc(String(req.params.id)).delete(); await audit(req, 'category.delete', String(req.params.id)); res.json({ message: 'Category removed.' }); } catch (error) { next(error); } });
  app.post('/api/admin/categories/import', A, async (req, res, next) => {
    try {
      needDb();
      const existing = new Set((await all('categories')).map((c) => c.name));
      let created = 0, order = existing.size;
      for (const c of (Array.isArray(req.body?.categories) ? req.body.categories : []).slice(0, 40)) {
        if (!c?.name || c.name === 'All products' || existing.has(c.name)) continue;
        await db.collection('categories').add({ ...categoryDoc({ ...c, order: order += 1 }), createdAt: stamp() });
        created += 1;
      }
      res.json({ message: created ? `Imported ${created} categories.` : 'The default categories are already imported.', created });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- coupons
  app.get('/api/admin/coupons', A, async (_req, res, next) => { try { needDb(); res.json({ items: (await all('coupons')).sort(byNewest) }); } catch (error) { next(error); } });
  app.post('/api/admin/coupons', A, async (req, res, next) => {
    try {
      needDb();
      const b = req.body || {};
      const id = couponId(b.code);
      if (id.length < 3) throw httpError(400, 'Coupon codes need at least 3 letters or numbers.');
      const discount = toNum(b.discount, NaN);
      if (!(discount > 0 && discount <= 90)) throw httpError(400, 'Discount must be between 1% and 90%.');
      const ref = db.collection('coupons').doc(id);
      if ((await ref.get()).exists) throw httpError(409, 'That coupon code already exists.');
      const expires = b.expiresAt ? new Date(`${b.expiresAt}T23:59:59.999Z`) : null;
      if (expires && Number.isNaN(expires.getTime())) throw httpError(400, 'Enter a valid expiry date.');
      await ref.set({ code: id, discount, role: ['all', 'customer', 'seller', 'admin'].includes(b.role) ? b.role : 'all', minOrder: Math.max(0, toNum(b.minOrder, 0)), maxUses: Math.max(0, Math.floor(toNum(b.maxUses, 0))), usedCount: 0, expiresAt: expires ? expires.toISOString() : null, status: 'active', createdAt: stamp() });
      await audit(req, 'coupon.create', id, `${discount}% off`);
      res.status(201).json({ message: 'Coupon created.' });
    } catch (error) { next(error); }
  });
  app.patch('/api/admin/coupons/:code', A, async (req, res, next) => { try { needDb(); const status = req.body?.status === 'disabled' ? 'disabled' : 'active'; await db.collection('coupons').doc(couponId(req.params.code)).update({ status }); await audit(req, `coupon.${status}`, couponId(req.params.code)); res.json({ message: 'Coupon updated.' }); } catch (error) { next(error); } });
  app.delete('/api/admin/coupons/:code', A, async (req, res, next) => { try { needDb(); await db.collection('coupons').doc(couponId(req.params.code)).delete(); await audit(req, 'coupon.delete', couponId(req.params.code)); res.json({ message: 'Coupon removed.' }); } catch (error) { next(error); } });

  // ---------------------------------------------------------------- payouts and platform settings
  app.get('/api/admin/payouts', A, async (_req, res, next) => { try { needDb(); res.json({ items: (await all('payouts')).sort(byNewest) }); } catch (error) { next(error); } });
  app.patch('/api/admin/payouts/:id', A, async (req, res, next) => {
    try {
      needDb();
      const status = String(req.body?.status || '');
      if (!['paid', 'rejected'].includes(status)) throw httpError(400, 'Choose paid or rejected.');
      const ref = db.collection('payouts').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Payout not found.');
      if (snap.data().status !== 'requested') throw httpError(400, 'This payout was already processed.');
      await ref.update({ status, note: text(req.body?.note, 200), processedBy: req.identity.name, updatedAt: stamp() });
      await notify(snap.data().sellerId, status === 'paid' ? 'Payout sent' : 'Payout declined', `৳${snap.data().amount} ${status === 'paid' ? `was sent to ${snap.data().account}.` : 'was not approved.'}`, 'seller-earnings');
      await audit(req, `payout.${status}`, `${snap.data().sellerName} · ৳${snap.data().amount}`, text(req.body?.note, 120));
      res.json({ message: status === 'paid' ? 'Payout marked as paid.' : 'Payout rejected.' });
    } catch (error) { next(error); }
  });
  app.get('/api/admin/settings', A, async (_req, res, next) => { try { res.json({ settings: await getSettings() }); } catch (error) { next(error); } });
  app.put('/api/admin/settings', A, async (req, res, next) => {
    try {
      needDb();
      const b = req.body || {};
      const next_ = {
        commissionRate: Math.min(50, Math.max(0, toNum(b.commissionRate, DEFAULT_SETTINGS.commissionRate))),
        deliveryFee: Math.max(0, toNum(b.deliveryFee, DEFAULT_SETTINGS.deliveryFee)),
        freeDeliveryOver: Math.max(0, toNum(b.freeDeliveryOver, DEFAULT_SETTINGS.freeDeliveryOver)),
        minPayout: Math.max(0, toNum(b.minPayout, DEFAULT_SETTINGS.minPayout)),
      };
      await db.collection('settings').doc('platform').set(next_, { merge: true });
      await audit(req, 'settings.update', 'Platform settings', `fee ${next_.commissionRate}% · delivery ৳${next_.deliveryFee} · free over ৳${next_.freeDeliveryOver} · min payout ৳${next_.minPayout}`);
      res.json({ message: 'Platform settings saved. New orders use these values.', settings: next_ });
    } catch (error) { next(error); }
  });
  // Public: delivery rules so checkout can show an estimate (server recalculates the real values).
  app.get('/api/settings/public', async (_req, res, next) => { try { const s = await getSettings(); res.json({ deliveryFee: s.deliveryFee, freeDeliveryOver: s.freeDeliveryOver }); } catch { res.json({ deliveryFee: DEFAULT_SETTINGS.deliveryFee, freeDeliveryOver: DEFAULT_SETTINGS.freeDeliveryOver }); } });

  // ---------------------------------------------------------------- sidebar counters
  app.get('/api/admin/counts', A, async (_req, res, next) => {
    try {
      needDb();
      const [s, p, y, o, rf, st] = await Promise.all([db.collection('users').where('role', '==', 'seller_pending').get(), db.collection('products').where('status', '==', 'pending').get(), db.collection('payouts').where('status', '==', 'requested').get(), db.collection('orders').where('status', '==', 'placed').get(), db.collection('refunds').where('status', 'in', ['escalated', 'refund_pending']).get(), db.collection('supportTickets').where('status', 'in', ['open', 'in_progress']).get()]);
      res.json({ sellers: s.size, products: p.size, payouts: y.size, orders: o.size, refunds: rf.size, support: st.size });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- one user in detail
  app.get('/api/admin/users/:uid', A, async (req, res, next) => {
    try {
      needDb();
      const uid = String(req.params.uid);
      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) throw httpError(404, 'User not found.');
      const u = shape(snap);
      const [asCustomer, asSeller, products, payouts] = (await Promise.all([db.collection('orders').where('customerId', '==', uid).get(), db.collection('orders').where('sellerId', '==', uid).get(), db.collection('products').where('sellerId', '==', uid).get(), db.collection('payouts').where('sellerId', '==', uid).get()])).map(shapeAll);
      const bought = asCustomer.filter((o) => o.status !== 'cancelled'), sold = asSeller.filter((o) => o.status !== 'cancelled');
      res.json({
        user: { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, phone: u.phone || '', area: u.area || '', address: u.address || '', storeName: u.storeName || '', bio: u.bio || '', createdAt: u.createdAt || '', payout: u.payout || null },
        customer: { orders: bought.length, spent: money(bought.reduce((n, o) => n + Number(o.total || 0), 0)) },
        seller: { orders: sold.length, sales: money(sold.reduce((n, o) => n + Number(o.sellerNet || 0), 0)), products: products.length, live: products.filter((p) => p.status === 'active').length, pending: products.filter((p) => p.status === 'pending').length, paidOut: money(payouts.filter((p) => p.status === 'paid').reduce((n, p) => n + Number(p.amount || 0), 0)) },
        recentOrders: [...asCustomer, ...asSeller].sort(byNewest).slice(0, 5).map((o) => withOrderImages(req, o)),
      });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- review moderation
  app.get('/api/admin/reviews', A, async (_req, res, next) => {
    try {
      needDb();
      const [reviews, products] = await Promise.all([all('reviews'), all('products')]);
      const names = new Map(products.map((p) => [p.id, p.name]));
      res.json({ items: reviews.sort(byNewest).slice(0, 300).map((r) => ({ ...r, productName: names.get(r.productId) || 'Removed product' })) });
    } catch (error) { next(error); }
  });
  app.delete('/api/admin/reviews/:id', A, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('reviews').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Review not found.');
      const { productId, userName, rating } = snap.data();
      await ref.delete();
      const rest = shapeAll(await db.collection('reviews').where('productId', '==', productId).get());
      const productRef = db.collection('products').doc(productId);
      if ((await productRef.get()).exists) await productRef.update({ ratingCount: rest.length, ratingAvg: rest.length ? Math.round((rest.reduce((n, r) => n + r.rating, 0) / rest.length) * 10) / 10 : 0 });
      await audit(req, 'review.delete', `${userName} · ${rating}★`, productId);
      res.json({ message: 'Review removed and the product rating was recalculated.' });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- activity log
  app.get('/api/admin/activity', A, async (_req, res, next) => {
    try { needDb(); res.json({ items: (await all('auditLog')).sort(byNewest).slice(0, 200) }); } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- announcements (broadcast notifications)
  app.get('/api/admin/announcements', A, async (_req, res, next) => {
    try { needDb(); res.json({ items: (await all('announcements')).sort(byNewest).slice(0, 50) }); } catch (error) { next(error); }
  });
  app.post('/api/admin/announcements', A, async (req, res, next) => {
    try {
      needDb();
      const b = req.body || {};
      const title = text(b.title, 100), body = text(b.body, 300);
      if (title.length < 3) throw httpError(400, 'Enter a title of at least 3 characters.');
      if (body.length < 3) throw httpError(400, 'Enter the message customers will read.');
      const audience = ['all', 'customer', 'seller'].includes(b.audience) ? b.audience : 'all';
      const link = ['', 'products', 'auction', 'orders', 'seller', 'support'].includes(b.link) ? b.link : '';
      const users = (await all('users')).filter((u) => u.status !== 'suspended' && (audience === 'all' || (audience === 'customer' ? u.role === 'customer' : ['seller', 'seller_pending'].includes(u.role))));
      const recipients = users.filter((u) => u.notifyPrefs?.announcement !== false).slice(0, 2000);
      for (let i = 0; i < recipients.length; i += 25) {
        await Promise.all(recipients.slice(i, i + 25).map((u) => db.collection('notifications').add({ userId: u.id, type: 'announcement', title, body, link, read: false, createdAt: stamp() })));
      }
      await db.collection('announcements').add({ title, body, audience, link, sentTo: recipients.length, adminName: req.identity.name, createdAt: stamp() });
      await audit(req, 'announcement.send', title, `${audience} · ${recipients.length} people`);
      res.status(201).json({ message: `Announcement sent to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}.`, sentTo: recipients.length });
    } catch (error) { next(error); }
  });
}