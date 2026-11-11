import { admin, db, httpError, mailer, randomInt, otpDigest, timingSafeEqual } from '../runtime.js';

import {
  byNewest,
  getSettings,
  money,
  needDb,
  notify,
  notifyAdmins,
  emailNotification,
  plain,
  requireUser,
  requireSellerArea,
  shape,
  shapeAll,
  stamp,
  text,
  toNum,
  withOrderImages
} from '../lib.js';

import { checkCoupon, couponId } from './coupons.js';
import { orderPaymentMethod } from '../payment-policy.js';
import { orderNotificationRows } from '../order-notifications.js';
import { cancellationRefund } from '../refund-policy.js';
import { normalizeSellerOrder } from '../seller-finance.js';
import { buildSellerDirectory, orderBelongsToSeller, resolveProductSellerId } from '../seller-order-ownership.js';

const FLOW = {
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  // Legacy stored statuses transition forward into the new fulfilment stages.
  confirmed: ['preparing', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['received'],
  received: [],
  cancelled: []
};

export const ORDER_STATUSES = ['placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'received', 'cancelled'];

const PAYMENTS = ['cash', 'bkash', 'nagad'];
const sellerRecipientId = (order) => {
  const sellerUid = String(order?.sellerUid || '').trim();
  const sellerId = String(order?.sellerId || '').trim();
  const valid = (value) => value && !['', 'khamari-store', 'unknown', 'undefined', 'null', 'none'].includes(value.toLowerCase());
  // sellerUid is the stable account link on legacy orders; new orders store
  // the same UID in both fields.
  return valid(sellerUid) ? sellerUid : (valid(sellerId) ? sellerId : '');
};


// ==========================================
// LIST ORDERS
// ==========================================

export async function listOrders(req, field, value) {
  needDb();

  const col = db.collection('orders');
  let list;
  if (field === 'sellerId') {
    // Include canonical sellerId orders and older records that stored sellerUid.
    const [sellerIdSnap, sellerUidSnap, allOrdersSnap, settings] = await Promise.all([
      col.where('sellerId', '==', value).get(),
      col.where('sellerUid', '==', value).get(),
      // Older records sometimes saved seller ownership only on each line item.
      // Firestore cannot query that legacy shape reliably, so include the full
      // collection and enforce ownership in application code before returning.
      col.get(),
      getSettings()
    ]);
    const unique = new Map();
    for (const doc of [...sellerIdSnap.docs, ...sellerUidSnap.docs, ...allOrdersSnap.docs]) {
      const order = { id: doc.id, ...doc.data() };
      // Include orders whose legacy sellerId is stale but sellerUid is the
      // authenticated seller UID. This was the reason some seller orders
      // were created successfully but hidden from the seller dashboard.
      if (!orderBelongsToSeller(order, value)) continue;
      const legacyMap = { confirmed: 'accepted', packed: 'preparing', shipped: 'out_for_delivery' };
      const normalized = legacyMap[order.status] ? { ...order, legacyStatus: order.status, status: legacyMap[order.status] } : order;
      unique.set(doc.id, normalizeSellerOrder(normalized, settings.commissionRate));
    }
    list = [...unique.values()].sort(byNewest);
  } else {
    const snap = field ? await col.where(field, '==', value).get() : await col.get();
    list = shapeAll(snap).sort(byNewest);
  }

  const { status, q } = req.query;

  if (status && ORDER_STATUSES.includes(status)) {
    list = list.filter(o => o.status === status);
  }

  if (q) {
    const s = String(q).toLowerCase();

    list = list.filter(o =>
      [
        o.orderNumber,
        o.customerName,
        o.customerEmail,
        o.sellerName
      ].join(' ').toLowerCase().includes(s)
    );
  }

  return list
    .slice(0, 500)
    .map(o => {
      const legacyMap = { confirmed: 'accepted', packed: 'preparing', shipped: 'out_for_delivery' };
      const paymentMethod = orderPaymentMethod(o);
      const normalizedBase = { ...o, paymentMethod, paymentStatus: paymentMethod === 'cash' ? 'not_required' : (o.paymentStatus || 'pending') };
      const normalized = legacyMap[normalizedBase.status] ? { ...normalizedBase, legacyStatus: normalizedBase.status, status: legacyMap[normalizedBase.status] } : normalizedBase;
      if (Array.isArray(normalized.history)) {
        normalized.history = normalized.history.map(h => ({ ...h, status: legacyMap[h.status] || h.status }));
      }
      return withOrderImages(req, normalized);
    });
}

// ==========================================
// REGISTER ORDER ROUTES
// ==========================================

export default function registerOrdersRoutes(app) {

  // ========================================
  // CREATE ORDER + VERIFY OTP
  // ========================================

  app.post('/api/orders', requireUser, async (req, res, next) => {
    let orderStage = 'initialization';
    try {
      orderStage = 'database-connection';
      needDb();

      const { identity } = req;
      const body = req.body || {};
      const rec = body.recipient || {};

      const name = text(rec.name, 80);

      const phone = text(rec.phone, 20)
        .replace(/[\s-]/g, '');

      const address = text(rec.address, 300);
      const area = text(rec.area, 80);

      if (!name || !/^\+?\d{10,15}$/.test(phone)) {
        throw httpError(
          400,
          'Enter a recipient name and a valid phone number.'
        );
      }

      if (address.length < 5) {
        throw httpError(400, 'Enter a full delivery address.');
      }

      // BUILD PRODUCT QUANTITIES

      const wanted = new Map();

      for (
        const item of Array.isArray(body.items)
          ? body.items.slice(0, 40)
          : []
      ) {
        const id = text(item.productId, 80);
        const qty = Math.floor(toNum(item.quantity, 0));

        if (id && qty > 0) {
          wanted.set(
            id,
            (wanted.get(id) || 0) + Math.min(qty, 500)
          );
        }
      }

      if (!wanted.size) {
        throw httpError(400, 'Your basket is empty.');
      }

      // PAYMENT METHOD

      const requestedPayment = String(body.paymentMethod || 'cash').toLowerCase();
      if (!PAYMENTS.includes(requestedPayment)) {
        throw httpError(400, 'Choose Cash on Delivery, bKash or Nagad. Card checkout is unavailable until a secure card gateway is connected.');
      }
      const payment = requestedPayment;

      // bKash/Nagad checkout requires a valid email OTP, but SMTP verification
      // does not require merchant credentials and never marks an order as paid.
      const otpRef = payment !== 'cash' ? db.collection('paymentEmailOtps').doc(`${identity.uid}_${payment}`) : null;

      const code = couponId(body.couponCode);
      orderStage = 'loading-platform-settings-and-seller-directory';
      const [settings, sellerUsersSnap] = await Promise.all([
        getSettings(),
        db.collection('users').get()
      ]);
      const sellerDirectory = buildSellerDirectory(sellerUsersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));

      const checkoutId =
        `CK${Date.now().toString(36).toUpperCase()}`;

      let lowStock = [];

      // ======================================
      // FIRESTORE TRANSACTION
      // ======================================

      orderStage = 'firestore-order-transaction';
      const created = await db.runTransaction(async tx => {

        lowStock = [];

        if (otpRef) {
          const otpSnap = await tx.get(otpRef);
          if (!otpSnap.exists) throw httpError(400, 'Please verify your payment email OTP first.');
          const otpData = otpSnap.data();
          const verifiedAt = otpData.verifiedAt?.toMillis?.() || 0;
          const expiresAt = otpData.expiresAt?.toMillis?.() || 0;
          if (otpData.consumed || otpData.method !== payment || !verifiedAt || verifiedAt > Date.now() || Date.now() - verifiedAt > 10 * 60 * 1000 || expiresAt < Date.now()) {
            throw httpError(400, 'OTP verification is invalid or expired. Please verify again.');
          }
          if (otpData.demoMode === true) throw httpError(400, 'Demo OTPs are disabled. Request a new OTP sent to your email.');
        }

        // FETCH PRODUCTS

        const productRefs = [...wanted.keys()].map(id =>
          db.collection('products').doc(id)
        );

        const productSnaps = await Promise.all(
          productRefs.map(ref => tx.get(ref))
        );

        const couponRef = code
          ? db.collection('coupons').doc(code)
          : null;

        const couponSnap = couponRef
          ? await tx.get(couponRef)
          : null;

        // GROUP PRODUCTS BY SELLER

        const bySeller = new Map();
        const stockUpdates = [];

        productSnaps.forEach((snap, index) => {

          const qty = wanted.get(
            productRefs[index].id
          );

          if (
            !snap.exists ||
            snap.data().status !== 'active'
          ) {
            throw httpError(
              400,
              'One of the products in your basket is no longer available.'
            );
          }

          const p = snap.data();

          const sellerId = resolveProductSellerId(p, sellerDirectory);
          if (!sellerId) {
            throw httpError(409, `The product “${p.name}” is not connected to a seller account. Ask the seller or administrator to repair its ownership before checkout.`);
          }
          if (sellerId === identity.uid) {
            throw httpError(
              400,
              `You cannot order your own product (${p.name}).`
            );
          }

          const availableStock = toNum(p.stock, 0);
          if (!Number.isFinite(availableStock) || availableStock < qty) {
            throw httpError(
              409,
              `Only ${Math.max(0, availableStock)} left of ${p.name || 'this product'}.`
            );
          }

          const sellerAccount = sellerDirectory.byUid.get(sellerId) || {};
          const group = bySeller.get(sellerId) || {
            sellerId,
            sellerUid: sellerId,
            sellerEmail: String(p.sellerEmail || p.ownerEmail || sellerAccount.email || '').trim().toLowerCase(),
            sellerName: p.sellerName || sellerAccount.storeName || sellerAccount.name || String(p.farm || 'Khamari Seller').split(' · ')[0],
            items: []
          };

          const discountPercent = Number(p.discountPercent || 0);
          const discountEndsAt = p.discountEndsAt ? Date.parse(p.discountEndsAt) : Infinity;
          const discountStartsAt = p.discountStartsAt ? Date.parse(p.discountStartsAt) : 0;
          const discountActive = discountPercent > 0 && discountPercent <= 90 && Date.now() >= discountStartsAt && Date.now() <= discountEndsAt;
          const originalPrice = Number(p.price);
          const effectivePrice = discountActive ? money(originalPrice * (1 - discountPercent / 100)) : originalPrice;
          const orderItem = {
            productId: snap.id,
            sellerId,
            sellerUid: sellerId,
            name: text(p.name, 120) || 'Product',
            image: p.image || p.images?.[0] || '',
            unit: p.unit || '',
            price: effectivePrice,
            discountPercent: discountActive ? discountPercent : 0,
            quantity: qty,
            listingType: p.listingType || 'product',
            isPreorder: p.listingType === 'preorder',
            lineTotal: money(effectivePrice * qty)
          };
          // Firestore rejects explicit `undefined` values unless the database
          // is configured to ignore them. Only add optional fields when present.
          if (discountActive) orderItem.originalPrice = originalPrice;
          if (p.listingType === 'preorder') orderItem.preOrderDetails = p.preOrderDetails || {};
          group.items.push(orderItem);

          bySeller.set(sellerId, group);

          stockUpdates.push({
            ref: productRefs[index],
            stock: availableStock - qty,
            sellerId,
            sellerEmail: String(p.sellerEmail || p.ownerEmail || sellerAccount.email || '').trim().toLowerCase(),
            sellerName: p.sellerName || sellerAccount.storeName || sellerAccount.name || String(p.farm || 'Khamari Seller').split(' · ')[0]
          });

          if (
            availableStock - qty <= 5 &&
            sellerId
          ) {
            lowStock.push({
              sellerId,
              name: p.name,
              left: Number(p.stock) - qty
            });
          }
        });

        // CALCULATE TOTALS

        const groups = [...bySeller.values()].map(g => ({
          ...g,
          subtotal: money(
            g.items.reduce(
              (n, i) => n + i.lineTotal,
              0
            )
          )
        }));

        const grandSubtotal = groups.reduce(
          (n, g) => n + g.subtotal,
          0
        );

        let discountTotal = 0;

        if (couponRef) {
          discountTotal = checkCoupon(
            couponSnap.exists ? couponSnap.data() : null,
            identity,
            grandSubtotal
          );
        }

        if (otpRef) tx.update(otpRef, { consumed: true, consumedAt: stamp() });

        // UPDATE STOCK

        stockUpdates.forEach(({ ref, stock, sellerId, sellerEmail, sellerName }) => {
          // Persist the canonical Firebase seller UID at the same time stock is
          // reserved. This repairs legacy store-name/email seller IDs safely.
          tx.update(ref, {
            stock,
            sellerId,
            sellerUid: sellerId,
            ...(sellerEmail ? { sellerEmail } : {}),
            ...(sellerName ? { sellerName } : {}),
            ownershipResolvedAt: stamp()
          });
        });

        if (couponRef && discountTotal > 0) {
          tx.update(couponRef, {
            usedCount: admin.firestore.FieldValue.increment(1)
          });
        }

        // CREATE SELLER ORDERS

        let allocated = 0;

        const createdOrders = groups.map((g, i) => {

          const discount =
            i === groups.length - 1
              ? discountTotal - allocated
              : Math.round(
                  (discountTotal * g.subtotal) /
                  (grandSubtotal || 1)
                );

          allocated += discount;

          const deliveryFee =
            g.subtotal >= settings.freeDeliveryOver
              ? 0
              : Number(settings.deliveryFee);

          const net = money(
            Math.max(0, g.subtotal - discount)
          );

          const commission = money(
            (net * Number(settings.commissionRate)) / 100
          );

          const ref = db.collection('orders').doc();

          const orderNumber =
            `KH-${ref.id.slice(0, 7).toUpperCase()}`;

          const doc = {

            orderNumber,
            checkoutId,

            customerId: identity.uid,
            customerName: name,
            customerEmail: identity.email,

            phone,
            address,
            area,

            paymentMethod: payment,

            paymentStatus: payment === 'cash' ? 'not_required' : 'pending',

            sellerId: g.sellerId,
            sellerUid: g.sellerId,
            sellerEmail: g.sellerEmail || '',
            sellerName: g.sellerName,

            items: g.items,

            subtotal: g.subtotal,
            discount,
            couponCode: discount > 0 ? code : '',

            deliveryFee,

            total: money(net + deliveryFee),

            commissionRate: Number(settings.commissionRate),
            commission,
            sellerNet: money(net - commission),

            status: 'placed',

            history: [
              {
                status: 'placed',
                at: new Date().toISOString(),
                by: identity.name
              }
            ],

            createdAt: stamp(),
            updatedAt: stamp()
          };

          tx.set(ref, doc);

          return {
            id: ref.id,
            orderNumber,
            sellerId: g.sellerId,
            total: doc.total,
            sellerNet: doc.sellerNet,
            itemsCount: g.items.length,
            paymentMethod: doc.paymentMethod,
            paymentStatus: doc.paymentStatus
          };

        });

        // Critical order notifications commit with the orders and reserved stock.
        // A successful checkout can no longer silently lose the order alert.
        const inboxRows = orderNotificationRows(createdOrders, identity, sellerUsersSnap.docs);
        for (const row of inboxRows) {
          tx.set(db.collection('notifications').doc(), { ...row, read: false, createdAt: stamp() });
        }
        return createdOrders;

      });

      // The order and its seller/customer/admin in-app notifications are now
      // committed atomically above. Email is an optional second channel.
      orderStage = 'sending-optional-email-notifications';
      const emailRows = [];
      for (const order of created) {
        emailRows.push([order.sellerId, 'New customer order received', `${order.orderNumber} · ${order.itemsCount} item(s) · ${String(order.paymentMethod).toUpperCase()} · Seller amount ৳${order.sellerNet} · Payment ${order.paymentStatus}.`]);
      }
      emailRows.push([identity.uid, 'Order placed', `${created[0].orderNumber}${created.length > 1 ? ` and ${created.length - 1} more` : ''} · ৳${created.reduce((n, o) => n + o.total, 0)}.`]);
      const adminEmailUsers = sellerUsersSnap.docs.filter((doc) => ['admin', 'superAdmin', 'super-admin'].includes(String(doc.data().role || '')));
      const adminEmailBody = `${identity.name} placed ${created.length} seller order(s): ${created.map((o) => o.orderNumber).join(', ')} · Total ৳${created.reduce((n, o) => n + o.total, 0)}.`;
      for (const doc of adminEmailUsers) emailRows.push([doc.id, 'New customer order', adminEmailBody]);
      await Promise.all(emailRows.map(([uid, title, body]) => emailNotification(uid, title, body, 'order')));

      orderStage = 'sending-low-stock-notifications';
      await Promise.all(
        lowStock.map(l =>
          notify(
            l.sellerId,
            l.left <= 0
              ? `Sold out: ${l.name}`
              : `Low stock: ${l.name}`,
            l.left <= 0
              ? 'This product is now out of stock.'
              : `Only ${l.left} left. Restock soon.`,
            'seller-products',
            'product'
          )
        )
      );

      // ======================================
      // RESPONSE TO CHECKOUT PAGE
      // ======================================

      res.status(201).json({

        success: true,

        message: payment === 'cash'
          ? 'Order placed successfully. Pay the delivery person when your order arrives.'
          : 'Order placed successfully. Complete the merchant transfer and submit its transaction reference under My Payments.',

        checkoutId,

        order: created[0] || null,

        orders: created,

        paymentStatus:
          created[0]?.paymentStatus || 'pending',

      });

    } catch (error) {
      console.error('[orders:create] failed', {
        stage: orderStage,
        uid: req.identity?.uid || null,
        code: error?.code || null,
        status: error?.status || null,
        message: error?.message || String(error),
        stack: error?.stack || null
      });
      const routedError = Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { orderStage }
      );
      next(routedError);
    }
  });

  // ======================================
  // CUSTOMER ORDERS
  // ======================================

  app.get(
    '/api/orders/mine',
    requireUser,
    async (req, res, next) => {
      try {
        res.json({
          items: await listOrders(
            req,
            'customerId',
            req.identity.uid
          )
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // ======================================
  // SELLER ORDERS
  // ======================================

  app.get(
    '/api/seller/orders',
    requireSellerArea,
    async (req, res, next) => {
      try {
        res.json({
          items: await listOrders(
            req,
            'sellerId',
            req.identity.uid
          )
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // ======================================
  // CASH-ON-DELIVERY RECEIPT OTP (SMTP ONLY)
  // ======================================

  app.post('/api/orders/:id/receipt-otp/send', requireUser, async (req, res, next) => {
    try {
      throw httpError(410, 'COD does not use a payment or OTP workflow. Use Confirm received on your order.');
      needDb();
      if (!mailer) throw httpError(503, 'Email service is not configured. Contact the store administrator.');

      const orderId = String(req.params.id);
      const orderRef = db.collection('orders').doc(orderId);
      const snap = await orderRef.get();
      if (!snap.exists) throw httpError(404, 'Order not found.');

      const order = snap.data();
      if (order.customerId !== req.identity.uid) throw httpError(403, 'Only the customer who placed this order can confirm receipt.');
      if (!['delivered', 'received'].includes(order.status)) throw httpError(400, 'The seller must mark the order delivered before you can confirm receipt.');
      if (orderPaymentMethod(order) !== 'cash') throw httpError(400, 'Delivery OTP confirmation is only for cash-on-delivery orders.');
      if (order.paymentStatus === 'paid') throw httpError(409, 'This order has already been paid and received.');

      const email = String(req.identity.email || '').trim().toLowerCase();
      if (!email) throw httpError(400, 'Your verified account email is required for delivery confirmation.');

      const now = Date.now();
      const otpRef = db.collection('orderReceiptOtps').doc(orderId);
      const previous = await otpRef.get();
      const lastSentAt = previous.exists ? previous.data().lastSentAt?.toMillis?.() || 0 : 0;
      if (now - lastSentAt < 60000) {
        throw httpError(429, `Please wait ${Math.ceil((60000 - (now - lastSentAt)) / 1000)} seconds before requesting another OTP.`);
      }

      const code = String(randomInt(100000, 1000000));
      await otpRef.set({
        orderId,
        uid: req.identity.uid,
        email,
        otpHash: otpDigest(`${req.identity.uid}:${orderId}`, code),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + 5 * 60 * 1000),
        lastSentAt: admin.firestore.Timestamp.fromMillis(now),
        attempts: 0,
        consumed: false
      });

      try {
        const info = await mailer.sendMail({
          from: process.env.SMTP_FROM,
          to: email,
          subject: `Khamari delivery confirmation · ${order.orderNumber}`,
          text: `Your Khamari delivery confirmation OTP is ${code}. It expires in 5 minutes. Enter it only after receiving your order and paying the delivery person. Do not share this code.`
        });
        if (!info.accepted?.length || info.rejected?.length) {
          throw new Error('SMTP did not accept the recipient.');
        }
      } catch (emailError) {
        await otpRef.delete().catch(() => {});
        console.error('Khamari COD OTP email error:', emailError.code, emailError.message);
        throw httpError(502, 'Could not send the delivery OTP email. Check SMTP settings and try again.');
      }

      res.json({
        success: true,
        email: email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
        expiresIn: 300,
        message: 'A delivery confirmation OTP has been sent to your registered email.'
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/orders/:id/receipt-otp/verify', requireUser, async (req, res, next) => {
    try {
      throw httpError(410, 'COD does not use a payment or OTP workflow. Use Confirm received on your order.');
      needDb();
      const orderId = String(req.params.id);
      const code = String(req.body?.code || '').trim();
      if (!/^\d{6}$/.test(code)) throw httpError(400, 'Enter the six-digit delivery OTP.');

      const orderRef = db.collection('orders').doc(orderId);
      const otpRef = db.collection('orderReceiptOtps').doc(orderId);
      let result;

      await db.runTransaction(async tx => {
        const [orderSnap, otpSnap] = await Promise.all([tx.get(orderRef), tx.get(otpRef)]);
        if (!orderSnap.exists) throw httpError(404, 'Order not found.');
        if (!otpSnap.exists) throw httpError(400, 'Request a new delivery OTP first.');

        const order = orderSnap.data();
        const otp = otpSnap.data();
        if (order.customerId !== req.identity.uid || otp.uid !== req.identity.uid) throw httpError(403, 'You cannot confirm this order.');
        if (!['delivered', 'received'].includes(order.status) || orderPaymentMethod(order) !== 'cash' || order.paymentStatus === 'paid') {
          throw httpError(409, 'This order is not awaiting COD receipt confirmation.');
        }
        if (otp.consumed || otp.demoMode === true) throw httpError(400, 'This OTP is invalid or has already been used. Request a new email OTP.');
        if (!otp.expiresAt || otp.expiresAt.toMillis() < Date.now()) throw httpError(400, 'The delivery OTP has expired. Request a new one.');
        if (Number(otp.attempts || 0) >= 5) throw httpError(429, 'Too many incorrect attempts. Request a new OTP.');

        const expected = Buffer.from(otp.otpHash || '');
        const supplied = Buffer.from(otpDigest(`${req.identity.uid}:${orderId}`, code));
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
          tx.update(otpRef, { attempts: admin.firestore.FieldValue.increment(1) });
          result = { invalid: true };
          return;
        }

        const now = new Date().toISOString();
        tx.update(otpRef, { consumed: true, consumedAt: admin.firestore.Timestamp.now() });
        tx.update(orderRef, {
          status: 'received',
          paymentStatus: 'paid',
          paymentVerifiedAt: stamp(),
          receivedAt: now,
          updatedAt: stamp(),
          history: [...(order.history || []), { status: 'received', at: now, by: req.identity.name, note: 'Customer confirmed receipt and COD payment by OTP.' }]
        });
        result = { success: true, orderNumber: order.orderNumber, total: order.total, sellerId: sellerRecipientId(order), sellerName: order.sellerName };
      });

      if (result?.invalid) throw httpError(400, 'Incorrect delivery OTP. Please try again.');
      await db.collection('auditLog').add({
        adminId: req.identity.uid,
        adminName: req.identity.name,
        actorRole: req.identity.role,
        action: 'payment.cod-receipt-confirmed',
        target: result.orderNumber,
        detail: `Customer confirmed receipt and COD payment of ${money(result.total)} by OTP.`,
        createdAt: stamp()
      }).catch(() => {});
      await notify(result.sellerId, `COD payment received · ${result.orderNumber}`, `The customer confirmed delivery and paid ${money(result.total)} by OTP.`, 'seller-orders', 'payment');
      await notifyAdmins(`COD payment confirmed · ${result.orderNumber}`, `Customer ${req.identity.name} confirmed receipt and paid ${money(result.total)} by OTP.`, 'admin-orders', 'payment');
      await notify(req.identity.uid, 'Payment successful', `Your COD payment of ${money(result.total)} for ${result.orderNumber} is confirmed. Thank you for shopping with Khamari.`, 'orders', 'payment');
      res.json({ success: true, paymentStatus: 'paid', orderStatus: 'received', orderNumber: result.orderNumber, total: result.total, message: 'Payment Successful! Your cash-on-delivery payment and receipt are confirmed.' });
    } catch (error) {
      next(error);
    }
  });

  // ======================================
  // UPDATE ORDER STATUS
  // ======================================

  app.patch(
    '/api/orders/:id/status',
    requireUser,
    async (req, res, next) => {
      try {

        needDb();

        const next_ = String(
          req.body?.status || ''
        );

        if (!ORDER_STATUSES.includes(next_)) {
          throw httpError(400, 'Choose a valid order status.');
        }

        const ref = db
          .collection('orders')
          .doc(String(req.params.id));

        const { identity } = req;

        const result = await db.runTransaction(async tx => {

          const snap = await tx.get(ref);

          if (!snap.exists) {
            throw httpError(404, 'Order not found.');
          }

          const order = snap.data();

          const isAdmin = identity.role === 'admin';
          // Use the same conservative ownership resolver as the seller order
          // list. Older orders may have a stale top-level sellerId but a valid
          // sellerUid or unanimous line-item seller snapshot.
          const isSeller = identity.role === 'seller'
            && ['approved', 'active'].includes(identity.status)
            && orderBelongsToSeller(order, identity.uid);
          const isCustomer = order.customerId === identity.uid;

          if (!isAdmin && !isSeller && !isCustomer) {
            throw httpError(403, 'You cannot change this order.');
          }

          const customerAction =
            isCustomer &&
            ((next_ === 'cancelled' && order.status === 'placed') ||
             (next_ === 'received' && order.status === 'delivered'));

          if (!isAdmin && !isSeller && !customerAction) {
            throw httpError(
              403,
              'Only the assigned seller or admin can update fulfilment. Customers can cancel before acceptance or confirm receipt after delivery.'
            );
          }

          if (next_ === 'received' && isSeller && !isAdmin) {
            throw httpError(403, 'Only the customer can confirm that the order has been received. Sellers can mark it Delivered.');
          }

          if (
            !FLOW[order.status]?.includes(next_) &&
            !(
              isAdmin &&
              next_ === 'cancelled' &&
              !['delivered', 'received', 'cancelled'].includes(order.status)
            )
          ) {
            throw httpError(
              400,
              `An order that is ${order.status} cannot be changed to ${next_}.`
            );
          }

          if (next_ === 'delivered' && isCustomer) {
            throw httpError(403, 'Only the seller or admin can mark an order delivered.');
          }

          let productSnaps = [];
          let refundQueued = null;

          if (next_ === 'cancelled') {
            productSnaps = await Promise.all(
              order.items.map(i =>
                tx.get(
                  db.collection('products').doc(i.productId)
                )
              )
            );
          }

          const update = {
            status: next_,
            updatedAt: stamp(),

            history: [
              ...(order.history || []),
              {
                status: next_,
                at: new Date().toISOString(),
                by: identity.name,
                note: text(req.body?.note, 200)
              }
            ]
          };

          if (next_ === 'out_for_delivery') {
            const deliveryInfo = req.body?.deliveryInfo || {};
            const estimatedDelivery = text(deliveryInfo.estimatedDelivery, 10);
            const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(estimatedDelivery);
            const validDate = Boolean(dateMatch) && (() => {
              const [, year, month, day] = dateMatch;
              const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
              return parsed.getUTCFullYear() === Number(year)
                && parsed.getUTCMonth() === Number(month) - 1
                && parsed.getUTCDate() === Number(day);
            })();
            if (!validDate || estimatedDelivery < new Date().toISOString().slice(0, 10)) {
              throw httpError(400, 'Enter a valid estimated delivery date that is today or later.');
            }
            update.deliveryInfo = {
              method: text(deliveryInfo.method || 'Seller delivery', 80),
              courier: text(deliveryInfo.courier, 100),
              trackingNumber: text(deliveryInfo.trackingNumber, 100),
              estimatedDelivery,
              dispatchedAt: new Date().toISOString()
            };
          }
          if (next_ === 'delivered') {
            update.deliveredAt = new Date().toISOString();
          }
          if (next_ === 'received') {
            update.receivedAt = new Date().toISOString();
          }
          if (next_ === 'cancelled') {

            productSnaps.forEach((s, i) => {
              if (s.exists) {
                tx.update(s.ref, {
                  stock:
                    Number(s.data().stock || 0) +
                    order.items[i].quantity
                });
              }
            });

            update.cancelledBy = identity.name;

            // Money already received must go back: queue a full refund for an administrator to pay out.
            if (order.paymentStatus === 'paid') {
              const refundRef = db.collection('refunds').doc();
              tx.set(refundRef, {
                ...cancellationRefund(order, snap.id, identity.name),
                refundNumber: `RF-${refundRef.id.slice(0, 7).toUpperCase()}`,
                createdAt: stamp(),
                updatedAt: stamp()
              });
              update.refundStatus = 'requested';
              update.activeRefundId = refundRef.id;
              refundQueued = { number: `RF-${refundRef.id.slice(0, 7).toUpperCase()}`, amount: order.total };
            }
          }

          tx.update(ref, update);

          return {
            order,
            id: snap.id,
            refundQueued
          };
        });

        const label = {
          accepted: 'accepted',
          preparing: 'being prepared',
          out_for_delivery: 'out for delivery',
          delivered: 'delivered',
          received: 'receipt confirmed',
          cancelled: 'cancelled'
        }[next_];

        if (result.order.customerId !== identity.uid) {
          await notify(
            result.order.customerId,
            `Order ${result.order.orderNumber} ${label}`,
            `Your order is now ${label}.${next_ === 'out_for_delivery' && req.body?.deliveryInfo?.estimatedDelivery ? ` Estimated delivery: ${req.body.deliveryInfo.estimatedDelivery}.` : ''}`,
            'orders'
          );
        }

        if (next_ === 'received' && result.order.customerId === identity.uid) {
          await Promise.all(
            (result.order.items || [])
              .slice(0, 3)
              .map(i =>
                notify(
                  result.order.customerId,
                  `How was ${i.name}?`,
                  'Thanks for confirming receipt. You can now review the products.',
                  `product-detail?id=${i.productId}`,
                  'review'
                )
              )
          );
        }

        if (next_ === 'received') {
          const receiptMessage = `${identity.name} confirmed that the order was received. COD receipt confirmation does not process a payment.`;
          await Promise.all([
            notify(
              sellerRecipientId(result.order),
              `Customer confirmed receipt · ${result.order.orderNumber}`,
              receiptMessage,
              'seller-orders',
              'order'
            ),
            notifyAdmins(
              `Customer confirmed receipt · ${result.order.orderNumber}`,
              receiptMessage,
              'admin-orders',
              'order'
            )
          ]);
        }

        if (result.refundQueued) {
          await notify(
            result.order.customerId,
            'Refund on the way',
            `${result.refundQueued.number}: ৳${result.refundQueued.amount} will be returned for cancelled order ${result.order.orderNumber}.`,
            'refunds',
            'order'
          );
          await notifyAdmins(
            'Refund ready to pay',
            `${result.refundQueued.number} · ৳${result.refundQueued.amount} (order cancelled after payment)`,
            'admin-refunds'
          );
        } else if (next_ === 'cancelled' && result.order.paymentStatus === 'submitted') {
          await notifyAdmins(
            'Cancelled order has a payment to check',
            `${result.order.orderNumber} was cancelled while a payment was awaiting verification. If the money arrived, refund it.`,
            'admin-orders'
          );
        }

        if (
          sellerRecipientId(result.order) && sellerRecipientId(result.order) !== identity.uid &&
          next_ === 'cancelled'
        ) {
          await notify(
            sellerRecipientId(result.order),
            `Order ${result.order.orderNumber} cancelled`,
            `Cancelled by ${identity.name}.`,
            'seller-orders'
          );
        }

        await db.collection('auditLog').add({
          adminId: identity.uid,
          adminName: identity.name,
          actorRole: identity.role,
          action: `order.${next_}`,
          target: result.order.orderNumber,
          detail: `${identity.name} changed order status to ${next_}. Payment: ${result.order.paymentMethod}/${result.order.paymentStatus}.`,
          createdAt: stamp()
        }).catch(() => {});

        res.json({
          message: `Order ${label}.`
        });

      } catch (error) {
        next(error);
      }
    }
  );

}
