import { db, httpError } from '../runtime.js';
import { calculateSellerFinance, normalizeSellerOrder } from '../seller-finance.js';
import { byNewest, countBy, getSettings, money, needDb, notifyAdmins, requireSeller, requireSellerArea, revenueSeries, shapeAll, stamp, text, toNum, topProducts, withImages, withOrderImages } from '../lib.js';
import { buildSellerDirectory, orderBelongsToSeller, resolveProductSellerId } from '../seller-order-ownership.js';

const LEGACY_ORDER_STATUS = { confirmed: 'accepted', packed: 'preparing', shipped: 'out_for_delivery' };

export async function sellerBalance(uid) {
  const [sellerOrders, sellerUidOrders, allOrders, payoutSnap, refundSnap, settings] = await Promise.all([
    db.collection('orders').where('sellerId', '==', uid).get(),
    db.collection('orders').where('sellerUid', '==', uid).get(),
    db.collection('orders').get(),
    db.collection('payouts').where('sellerId', '==', uid).get(),
    db.collection('refunds').where('sellerId', '==', uid).get(),
    getSettings()
  ]);
  const orderDocs = new Map();
  // Include legacy orders whose seller UID exists only on line-item snapshots.
  for (const doc of [...sellerOrders.docs, ...sellerUidOrders.docs, ...allOrders.docs]) orderDocs.set(doc.id, { id: doc.id, ...doc.data() });
  const orders = [...orderDocs.values()].filter((order) => orderBelongsToSeller(order, uid) || legacySellerLink(order, uid)).map((order) => {
    const mapped = LEGACY_ORDER_STATUS[order.status]
      ? { ...order, legacyStatus: order.status, status: LEGACY_ORDER_STATUS[order.status] }
      : order;
    return normalizeSellerOrder(mapped, settings.commissionRate);
  }).sort(byNewest);
  const payouts = shapeAll(payoutSnap).sort(byNewest);
  const refunds = shapeAll(refundSnap).filter((r) => r.kind !== 'cancellation');
  const finance = calculateSellerFinance(orders, payouts, refunds);
  return { orders, payouts, refunds, ...finance };
}

const PLACEHOLDER_SELLER_IDS = new Set(['', 'khamari-store', 'unknown', 'undefined', 'null', 'none']);
const legacySellerLink = (doc, uid) => (!String(doc.sellerId || '').trim() || PLACEHOLDER_SELLER_IDS.has(String(doc.sellerId || '').trim().toLowerCase())) && (String(doc.sellerUid || doc.ownerUid || doc.ownerId || doc.createdByUid || doc.userId || '') === uid);
const emailFields = ['sellerEmail', 'ownerEmail', 'createdByEmail', 'userEmail'];
const uidFields = ['sellerUid', 'ownerUid', 'ownerId', 'createdByUid', 'userId'];
const normalEmail = (value) => String(value || '').trim().toLowerCase();
const hasOwnerEmail = (doc, email) => email && emailFields.some((field) => normalEmail(doc[field]) === email);
const hasOwnerUid = (doc, uid) => uidFields.some((field) => String(doc[field] || '').trim() === uid);

async function commitInChunks(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + 400)) batch.update(write.ref, write.data);
    await batch.commit();
  }
}

export default function registerSellerRoutes(app) {
  // Repair older catalogue/order records that were created before seller UID
  // metadata was saved consistently. A seller may only claim records whose
  // stored owner UID or owner email matches the authenticated account.
  app.post('/api/seller/repair-ownership', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const uid = req.identity.uid;
      const email = normalEmail(req.identity.email);
      const [productsSnap, usersSnap] = await Promise.all([
        db.collection('products').get(),
        db.collection('users').get()
      ]);
      const sellerAccounts = usersSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((user) => ['seller', 'seller_pending', 'admin'].includes(user.role));
      const sellerDirectory = buildSellerDirectory(sellerAccounts);
      const productWrites = [];
      const ownedProductIds = new Set();

      for (const doc of productsSnap.docs) {
        const product = doc.data();
        const currentSellerId = String(product.sellerId || '').trim();
        const currentIsPlaceholder = PLACEHOLDER_SELLER_IDS.has(currentSellerId.toLowerCase());
        const resolvedOwnerId = resolveProductSellerId(product, sellerDirectory);
        const ownerMatches = resolvedOwnerId === uid || hasOwnerUid(product, uid) || hasOwnerEmail(product, email);
        const currentSellerIsKnown = sellerDirectory.byUid.has(currentSellerId);
        // Repair placeholder or legacy name/email seller IDs only when they map
        // uniquely to this authenticated account. Never steal a product already
        // assigned to another real seller or explicitly reassigned by an admin.
        const canRepairOwnership = !product.ownershipAssignedBy
          && ownerMatches
          && (!currentSellerIsKnown || currentSellerId === uid);
        if (currentSellerId === uid) {
          ownedProductIds.add(doc.id);
          if (!product.sellerEmail || !product.sellerName || !product.sellerUid) {
            productWrites.push({ ref: doc.ref, data: { sellerId: uid, sellerUid: uid, sellerEmail: email, sellerName: product.sellerName || req.identity.name, ownershipRepairedAt: stamp() } });
          }
          continue;
        }
        if (canRepairOwnership) {
          ownedProductIds.add(doc.id);
          productWrites.push({ ref: doc.ref, data: { sellerId: uid, sellerUid: uid, sellerEmail: email, sellerName: product.sellerName || req.identity.name, ownershipRepairedAt: stamp() } });
        }
      }
      await commitInChunks(productWrites);

      const ordersSnap = await db.collection('orders').get();
      const orderWrites = [];
      let skippedMixedOrders = 0;
      for (const doc of ordersSnap.docs) {
        const order = doc.data();
        const currentSellerId = String(order.sellerId || '').trim();
        if (currentSellerId === uid) continue;

        const items = Array.isArray(order.items) ? order.items : [];
        const itemIds = items.map((item) => String(item.productId || '')).filter(Boolean);
        const currentOrderSellerIsKnown = sellerDirectory.byUid.has(currentSellerId);
        const itemSnapshotMatchesSeller = items.length > 0 && items.every((item) =>
          String(item.sellerUid || item.sellerId || '').trim() === uid
        );
        // Do not reassign a historical order away from another valid seller.
        // A matching line-item seller snapshot is the only override in that case.
        if (currentOrderSellerIsKnown && currentSellerId !== uid && order.sellerUid !== uid && !itemSnapshotMatchesSeller) continue;
        const allItemsBelongToSeller = itemIds.length > 0 && itemIds.every((id) =>
          ownedProductIds.has(id) || items.some((item) => String(item.productId || '') === id && (String(item.sellerId || item.sellerUid || '') === uid))
        );
        const emailMatches = hasOwnerEmail(order, email);
        const uidMatches = hasOwnerUid(order, uid);
        const uniqueNameMatch = sellerDirectory.byName.get(String(order.sellerName || '').trim().toLowerCase().replace(/\s+/g, ' ')) === uid;
        if (itemIds.length && !allItemsBelongToSeller) {
          if (items.some((item) => ownedProductIds.has(String(item.productId || '')))) skippedMixedOrders += 1;
          continue;
        }
        // When an order contains only this seller's products, the product
        // ownership is the strongest source of truth—even if the old order
        // accidentally stored a different seller ID. Without item IDs, only
        // placeholder IDs can be repaired from matching owner metadata.
        if (!itemIds.length && !PLACEHOLDER_SELLER_IDS.has(currentSellerId.toLowerCase())) continue;
        if (!allItemsBelongToSeller && !emailMatches && !uidMatches && !uniqueNameMatch) continue;

        const repairedItems = items.map((item) => {
          const productId = String(item.productId || '');
          const belongsToSeller = ownedProductIds.has(productId) || String(item.sellerId || item.sellerUid || '') === uid;
          return belongsToSeller ? { ...item, sellerId: uid, sellerUid: uid } : item;
        });
        orderWrites.push({ ref: doc.ref, data: {
          sellerId: uid,
          sellerUid: uid,
          sellerEmail: email,
          sellerName: order.sellerName || req.identity.name,
          items: repairedItems,
          ownershipRepairedAt: stamp()
        } });
      }
      await commitInChunks(orderWrites);

      res.json({
        success: true,
        repairedProducts: productWrites.length,
        repairedOrders: orderWrites.length,
        skippedMixedOrders,
        message: productWrites.length || orderWrites.length
          ? `Reconnected ${productWrites.length} product(s) and ${orderWrites.length} order(s) to your seller account.`
          : 'Your existing products and orders are already connected, or older records need administrator review.'
      });
    } catch (error) { next(error); }
  });

  app.get('/api/seller/overview', requireSellerArea, async (req, res, next) => {
    try {
      needDb();
      const uid = req.identity.uid;
      const [productSnap, sellerUidProductSnap, balance] = await Promise.all([
        db.collection('products').where('sellerId', '==', uid).get(),
        db.collection('products').where('sellerUid', '==', uid).get(),
        sellerBalance(uid)
      ]);
      const productDocs = new Map();
      for (const doc of [...productSnap.docs, ...sellerUidProductSnap.docs]) productDocs.set(doc.id, { id: doc.id, ...doc.data() });
      const products = [...productDocs.values()].filter((product) => product.sellerId === uid || legacySellerLink(product, uid));
      const orders = balance.orders.sort(byNewest);
      const now = Date.now();
      const discountedProducts = products
        .filter((p) => p.status === 'active' && Number(p.discountPercent || 0) > 0 && Number(p.discountPercent || 0) <= 90)
        .filter((p) => (!p.discountStartsAt || Date.parse(p.discountStartsAt) <= now) && (!p.discountEndsAt || Date.parse(p.discountEndsAt) >= now))
        .map((p) => withImages(req, { ...p, discountedPrice: money(Number(p.price) * (1 - Number(p.discountPercent) / 100)) }))
        .sort((a, b) => Number(b.discountPercent || 0) - Number(a.discountPercent || 0));
      const realOrders = orders.filter((o) => o.paymentDemo !== true);
      const live = realOrders.filter((o) => o.status !== 'cancelled');
      const totalCustomers = new Set(live.map((o) => o.customerId).filter(Boolean)).size;
      const unitsSold = live.reduce((total, order) => total + (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0), 0);
      res.json({
        sellerStatus: { role: req.identity.role, status: req.identity.status },
        totals: {
          products: products.length, active: products.filter((p) => p.status === 'active').length, pending: products.filter((p) => p.status === 'pending').length,
          discountedProducts: discountedProducts.length,
          rejected: products.filter((p) => p.status === 'rejected').length, lowStock: products.filter((p) => Number(p.stock) <= 5 && p.status !== 'rejected').length,
          orders: live.length,
          activeOrders: balance.activeOrders,
          newOrders: realOrders.filter((o) => o.status === 'placed').length,
          totalCustomers,
          unitsSold,
          grossOrderValue: balance.grossOrderValue,
          sales: balance.orderValue,
          orderValue: balance.orderValue,
          earned: balance.earned,
          available: balance.available,
          inProgress: balance.inProgress,
          pendingPayment: balance.pendingPayment,
          pendingPaymentOrders: balance.pendingPaymentOrders,
          paidOnlineOrders: balance.paidOnlineOrders,
          codOrders: balance.codOrders,
          completedPaidOrders: balance.completedPaidOrders,
          completedCodOrders: balance.completedCodOrders,
          completedSettledOrders: balance.completedSettledOrders,
        },
        ordersByStatus: countBy(realOrders, 'status'),
        salesByDay: revenueSeries(realOrders.filter((o) => o.status === 'received' && (o.paymentStatus === 'paid' || orderBelongsToSeller(o, uid) && ['cash', 'cod', 'cash on delivery'].includes(String(o.paymentMethod || '').toLowerCase()))), 30, 'sellerNet'),
        topProducts: topProducts(realOrders, 5).map((p) => withImages(req, p)),
        lowStock: products.filter((p) => Number(p.stock) <= 5 && ['active', 'paused'].includes(p.status)).sort((a, b) => a.stock - b.stock).slice(0, 6).map((p) => withImages(req, p)),
        recentOrders: orders.slice(0, 10).map((o) => withOrderImages(req, o)),
        discountedProducts: discountedProducts.slice(0, 8),
      });
    } catch (error) { next(error); }
  });

  app.get('/api/seller/earnings', requireSellerArea, async (req, res, next) => {
    try {
      needDb();
      const b = await sellerBalance(req.identity.uid);
      const settings = await getSettings();
      res.json({
        summary: { refunded: b.refundedNet, refundHold: b.refundHold, gross: b.gross, commission: b.commission, earned: b.earned, inProgress: b.inProgress, paidOut: b.paidOut, pendingPayout: b.pendingPayout, available: b.available, orderValue: b.orderValue, pendingPayment: b.pendingPayment, pendingPaymentOrders: b.pendingPaymentOrders, paidOnlineOrders: b.paidOnlineOrders, codOrders: b.codOrders, completedPaidOrders: b.completedPaidOrders, completedCodOrders: b.completedCodOrders, completedSettledOrders: b.completedSettledOrders },
        commissionRate: settings.commissionRate, minPayout: settings.minPayout,
        payouts: b.payouts,
        payoutAccount: req.identity.profile.payout || null,
        series: revenueSeries(b.orders.filter((o) => o.status === 'received' && o.paymentStatus === 'paid'), 30, 'sellerNet'),
      });
    } catch (error) { next(error); }
  });

  app.post('/api/seller/payouts', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const uid = req.identity.uid;
      const [b, settings] = await Promise.all([sellerBalance(uid), getSettings()]);
      const amount = money(toNum(req.body?.amount, 0));
      const method = ['bkash', 'nagad', 'bank'].includes(req.body?.method) ? req.body.method : 'bkash';
      const account = text(req.body?.account, 80);
      if (account.length < 5) throw httpError(400, 'Enter your bKash / Nagad number or bank account details.');
      if (b.payouts.some((p) => p.status === 'requested')) throw httpError(400, 'You already have a payout request waiting for review.');
      if (amount < Number(settings.minPayout)) throw httpError(400, `The minimum payout is ৳${settings.minPayout}.`);
      if (amount > b.available) throw httpError(400, `You can request up to ৳${b.available}.`);
      const ref = await db.collection('payouts').add({ sellerId: uid, sellerName: req.identity.name, sellerEmail: req.identity.email, amount, method, account, status: 'requested', createdAt: stamp(), updatedAt: stamp() });
      await db.collection('users').doc(uid).set({ payout: { method, account } }, { merge: true });
      await notifyAdmins('Payout requested', `${req.identity.name} requested ৳${amount}`, 'admin-payouts');
      res.status(201).json({ id: ref.id, message: 'Payout requested. An administrator will review it.' });
    } catch (error) { next(error); }
  });
}