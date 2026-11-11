import { db, httpError } from '../runtime.js';
import { identify, needDb, requireSeller, requireSellerArea, shape, shapeAll, stamp, text, toNum, notifyAdmins, withImages, relativeImage, byNewest, notify, apiOrigin } from '../lib.js';

const IMAGE_OK = /^(\/api\/images\/[A-Za-z0-9]+|https?:\/\/\S+|\/images\/\S+)$/;
export const cleanImages = (list) => [...new Set((Array.isArray(list) ? list : []).map(relativeImage).filter((u) => IMAGE_OK.test(u)))].slice(0, 8);

// Validates a product body from a seller/admin and returns the document fields to store.
export function buildProduct(body, identity, existing) {
  const name = text(body.name, 120);
  if (name.length < 2) throw httpError(400, 'Enter a product name.');
  const price = toNum(body.price, NaN);
  if (!(price > 0)) throw httpError(400, 'Enter a price greater than zero.');
  const oldPrice = body.oldPrice === '' || body.oldPrice == null ? null : toNum(body.oldPrice, NaN);
  if (oldPrice != null && !(oldPrice > price)) throw httpError(400, 'The original price must be higher than the selling price.');
  const images = cleanImages(body.images?.length ? body.images : body.image ? [body.image] : []);
  if (!images.length) throw httpError(400, 'Add at least one product picture.');
  const listingType = ['animal', 'preorder'].includes(body.listingType) ? body.listingType : 'product';
  const profile = identity.profile || {};
  const doc = {
    name, category: text(body.category || 'Other', 80), subcategory: text(body.subcategory, 80),
    price, oldPrice, unit: text(body.unit || '1 kg', 40), stock: Math.max(0, Math.floor(toNum(body.stock, 0))),
    description: text(body.description || 'Seller-provided product details.', 2000),
    images, image: images[0], listingType,
    farm: existing?.farm || `${text(profile.storeName || identity.name, 60)} · ${text(profile.area || 'Bangladesh', 40)}`,
    rating: existing?.rating ?? 0, reviews: existing?.reviews ?? 0, badge: existing?.badge ?? '',
    updatedAt: stamp(),
  };
  if (listingType === 'animal') {
    const a = body.animalDetails || {};
    doc.animalDetails = { breed: text(a.breed || 'Not specified', 60), age: text(a.age || 'Ask seller', 40), sex: text(a.sex || 'Ask seller', 40), health: text(a.health || 'Confirm with seller', 200), vaccination: text(a.vaccination || 'Confirm records with seller', 200) };
  }
  if (listingType === 'preorder') {
    const p = body.preOrderDetails || {};
    const harvestDate = text(p.harvestDate, 10);
    const preorderDeadline = text(p.preorderDeadline, 10);
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
    if (!validDate(harvestDate) || !validDate(preorderDeadline)) throw httpError(400, 'Set a valid expected availability date and pre-order deadline.');
    if (preorderDeadline > harvestDate) throw httpError(400, 'The pre-order deadline cannot be after the expected availability date.');
    doc.preOrderDetails = {
      harvestDate,
      preorderDeadline,
      note: text(p.note, 800)
    };
    doc.badge = 'Pre-order';
  }
  return doc;
}


// What the shop sees: pictures as full URLs and rating numbers that come only from real customer reviews.
const activeDiscount = (p) => {
  const percent = Number(p.discountPercent || 0);
  const now = Date.now();
  const starts = p.discountStartsAt ? Date.parse(p.discountStartsAt) : 0;
  const ends = p.discountEndsAt ? Date.parse(p.discountEndsAt) : Infinity;
  const active = Number.isFinite(percent) && percent > 0 && percent <= 90 && now >= starts && now <= ends;
  return active ? { percent, price: Math.max(0, Math.round(Number(p.price) * (1 - percent / 100) * 100) / 100) } : null;
};
export const present = (req, p) => {
  const discount = activeDiscount(p);
  return { ...withImages(req, p), price: discount ? discount.price : Number(p.price), oldPrice: discount ? Number(p.price) : (p.oldPrice || null), discountPercent: discount?.percent || 0, rating: Number(p.ratingAvg || 0), reviews: Number(p.ratingCount || 0) };
};

// Public phone/address details are only returned when a seller has explicitly
// enabled the listing-contact option in their account profile.
async function attachPublicSellerContacts(products) {
  const sellerIds = [...new Set(products.map((product) => String(product.sellerId || product.sellerUid || '').trim()).filter(Boolean))];
  if (!sellerIds.length) return products;
  const refs = sellerIds.map((uid) => db.collection('users').doc(uid));
  const snapshots = await db.getAll(...refs);
  const profiles = new Map(snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => [snapshot.id, snapshot.data()]));
  return products.map((product) => {
    const uid = String(product.sellerId || product.sellerUid || '').trim();
    const profile = profiles.get(uid) || {};
    const shared = profile.showContactOnListings === true;
    return {
      ...product,
      sellerPhone: shared ? text(profile.phone, 20) : '',
      sellerArea: shared ? text(profile.area, 80) : '',
      sellerAddress: shared ? text(profile.address, 300) : ''
    };
  });
}

const LEGACY_SELLER_IDS = new Set(['', 'khamari-store', 'unknown', 'undefined', 'null', 'none']);
const canManage = (product, identity) => identity.role === 'admin' || product.sellerId === identity.uid || (LEGACY_SELLER_IDS.has(String(product.sellerId || '').trim().toLowerCase()) && [product.sellerUid, product.ownerUid, product.ownerId, product.createdByUid, product.userId].some((value) => String(value || '') === identity.uid));

export default function registerProductsRoutes(app) {
  // Public catalogue (only approved listings). Search, filters, sorting and paging all happen on the server.
  app.get('/api/products', async (req, res, next) => {
    try {
      needDb();
      const { category, subcategory, sellerId, exclude } = req.query;
      const q = String(req.query.q || req.query.search || '').trim().toLowerCase();
      const sort = String(req.query.sort || 'featured');
      const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 24, 1), 200);
      const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
      const minPrice = Number(req.query.minPrice) || 0, maxPrice = Number(req.query.maxPrice) || Infinity;
      let snap = await db.collection('products').where('status', '==', 'active').get();
      let list = shapeAll(snap).filter((p) => String(p.id) !== String(exclude || '') && (!sellerId || p.sellerId === sellerId || (LEGACY_SELLER_IDS.has(String(p.sellerId || '').trim().toLowerCase()) && p.sellerUid === sellerId)));
      if (q) list = list.filter((p) => [p.name, p.category, p.subcategory, p.farm, p.description, p.animalDetails?.breed].filter(Boolean).join(' ').toLowerCase().includes(q));
      list = list.filter((p) => Number(p.price) >= minPrice && Number(p.price) <= maxPrice);
      const facets = {}; for (const p of list) facets[p.category] = (facets[p.category] || 0) + 1;   // counts before the department filter
      if (category && category !== 'All products') list = list.filter((p) => p.category === category);
      if (subcategory && subcategory !== 'All') list = list.filter((p) => p.subcategory === subcategory);
      const bySort = { 'price-low': (a, b) => a.price - b.price, 'price-high': (a, b) => b.price - a.price, rating: (a, b) => Number(b.ratingAvg || 0) - Number(a.ratingAvg || 0) || Number(b.ratingCount || 0) - Number(a.ratingCount || 0), newest: byNewest,
        featured: (a, b) => Number(b.ratingCount || 0) - Number(a.ratingCount || 0) || byNewest(a, b) || String(a.name).localeCompare(String(b.name)) };
      list = [...list].sort(bySort[sort] || bySort.featured);
      const total = list.length;
      const pageItems = list.slice((page - 1) * limit, page * limit);
      const itemsWithContact = await attachPublicSellerContacts(pageItems);
      res.json({ items: itemsWithContact.map((p) => present(req, p)), total, page, pages: Math.max(1, Math.ceil(total / limit)), facets, source: 'firestore' });
    } catch (error) { next(error); }
  });

  app.get('/api/products/:id', async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('products').doc(String(req.params.id)).get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const product = shape(snap);
      if (product.status !== 'active') {
        const identity = await identify(req, { optional: true });
        if (!identity || !canManage(product, identity)) throw httpError(404, 'Product not found.');
      }
      const [productWithContact] = await attachPublicSellerContacts([product]);
      res.json({ item: present(req, productWithContact) });
    } catch (error) { next(error); }
  });

  // Seller: all of my own listings, any status.
  app.get('/api/seller/products', requireSellerArea, async (req, res, next) => {
    try {
      needDb();
      const [sellerIdSnap, sellerUidSnap] = await Promise.all([
        db.collection('products').where('sellerId', '==', req.identity.uid).get(),
        db.collection('products').where('sellerUid', '==', req.identity.uid).get()
      ]);
      const unique = new Map();
      for (const doc of [...sellerIdSnap.docs, ...sellerUidSnap.docs]) unique.set(doc.id, { id: doc.id, ...doc.data() });
      const owned = [...unique.values()].filter((product) => canManage(product, req.identity));
      res.json({ items: owned.sort(byNewest).map((p) => withImages(req, p)) });
    } catch (error) { next(error); }
  });

  app.post('/api/products', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req;
      const isAdmin = identity.role === 'admin';
      const doc = {
        ...buildProduct(req.body || {}, identity),
        sellerId: identity.uid,
        sellerUid: identity.uid,
        sellerEmail: String(identity.email || '').trim().toLowerCase(),
        sellerName: identity.name,
        status: isAdmin ? 'active' : 'pending',
        createdAt: stamp()
      };
      const ref = await db.collection('products').add(doc);
      if (!isAdmin) await notifyAdmins('New product awaiting review', `${doc.name} by ${identity.name}`, 'admin-products');
      res.status(201).json({ id: ref.id, message: isAdmin ? 'Product published.' : 'Product submitted. It goes live after an administrator approves it.' });
    } catch (error) { next(error); }
  });

  app.put('/api/products/:id', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const current = snap.data();
      if (!canManage(current, req.identity)) throw httpError(403, 'You can only edit your own products.');
      const owner = current.sellerId === req.identity.uid ? req.identity : { ...req.identity, profile: {}, name: current.sellerName || req.identity.name };
      const doc = buildProduct(req.body || {}, owner, current);
      if (current.status === 'rejected' && req.identity.role !== 'admin') doc.status = 'pending';
      await ref.update({
        ...doc,
        sellerId: LEGACY_SELLER_IDS.has(String(current.sellerId || '').trim().toLowerCase()) ? (current.sellerUid || req.identity.uid) : current.sellerId,
        sellerUid: current.sellerUid || current.sellerId || req.identity.uid,
        sellerEmail: current.sellerEmail || req.identity.email,
        sellerName: current.sellerName || req.identity.name
      });
      if (doc.status === 'pending') await notifyAdmins('Product resubmitted for review', doc.name, 'admin-products');
      res.json({ message: 'Product updated.' });
    } catch (error) { next(error); }
  });

  // Seller quick stock adjustment. Checkout still reserves stock transactionally.
  app.patch('/api/products/:id/stock', requireSellerArea, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const product = snap.data();
      if (!canManage(product, req.identity)) throw httpError(403, 'You can only update stock for your own products.');
      const raw = req.body?.stock;
      const stock = Number(raw);
      if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw httpError(400, 'Stock must be a whole number between 0 and 1,000,000.');
      await ref.update({ stock, stockUpdatedAt: stamp() });
      await db.collection('auditLog').add({
        adminId: req.identity.uid,
        adminName: req.identity.name,
        actorRole: req.identity.role,
        action: 'product.stock-update',
        target: product.name,
        detail: `Stock changed from ${Number(product.stock || 0)} to ${stock}.`,
        createdAt: stamp()
      }).catch(() => {});
      await notify(req.identity.uid, 'Stock updated' , `${product.name}: stock is now ${stock} unit(s).`, 'seller-products', 'product');
      res.json({ success: true, stock, message: `Stock updated for ${product.name}.` });
    } catch (error) { next(error); }
  });

  // Seller-managed product discount. The original product price remains unchanged.
  app.patch('/api/products/:id/discount', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const product = snap.data();
      if (!canManage(product, req.identity)) throw httpError(403, 'You can only discount your own products.');
      if (product.status !== 'active') throw httpError(400, 'Only live products can have a customer discount.');
      const percent = Number(req.body?.discountPercent || 0);
      if (!Number.isFinite(percent) || percent < 0 || percent > 90) throw httpError(400, 'Discount must be between 0 and 90 percent.');
      const endsAt = String(req.body?.discountEndsAt || '').trim();
      if (endsAt && (!/^\d{4}-\d{2}-\d{2}$/.test(endsAt) || Number.isNaN(Date.parse(`${endsAt}T23:59:59`)) || Date.parse(`${endsAt}T23:59:59`) < Date.now())) {
        throw httpError(400, 'Choose a valid discount end date in the future.');
      }
      await ref.update({
        discountPercent: percent,
        discountStartsAt: percent ? new Date().toISOString() : null,
        discountEndsAt: percent && endsAt ? `${endsAt}T23:59:59.999Z` : null,
        discountUpdatedAt: stamp()
      });
      res.json({ message: percent ? `${percent}% discount is now live on ${product.name}.` : 'Product discount removed.' });
    } catch (error) { next(error); }
  });

  // Sellers can hide / show an approved listing; admins can set any status.
  app.patch('/api/products/:id/status', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const status = String(req.body?.status || '');
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const current = snap.data();
      if (!canManage(current, req.identity)) throw httpError(403, 'You can only change your own products.');
      if (req.identity.role !== 'admin') {
        if (!['active', 'paused'].includes(status)) throw httpError(400, 'Choose active or paused.');
        if (!['active', 'paused'].includes(current.status)) throw httpError(400, 'Only approved products can be shown or hidden.');
      } else if (!['active', 'paused', 'pending', 'rejected'].includes(status)) throw httpError(400, 'Invalid status.');
      await ref.update({ status, updatedAt: stamp() });
      res.json({ message: status === 'active' ? 'Product is now visible to customers.' : 'Product updated.' });
    } catch (error) { next(error); }
  });

  app.delete('/api/products/:id', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('products').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const current = snap.data();
      if (!canManage(current, req.identity)) throw httpError(403, 'You can only delete your own products.');
      await ref.delete();
      await Promise.all((current.images || []).filter((u) => u.startsWith('/api/images/')).map((u) => db.collection('productImages').doc(u.split('/').pop()).delete().catch(() => {})));
      if (req.identity.role === 'admin' && current.sellerId !== req.identity.uid) await notify(current.sellerId, 'A product was removed', current.name, 'seller-products');
      res.json({ message: 'Product deleted.' });
    } catch (error) { next(error); }
  });
}