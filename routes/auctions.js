import { admin, db, httpError } from '../runtime.js';
import { getSettings, identify, money, needDb, notify, notifyAdmins, plain, requireAdminUser, requireSeller, requireSellerArea, requireUser, shape, shapeAll, stamp, text } from '../lib.js';
import { AUCTION_PAYMENT_DAYS, applyProxyBid, buyNowAvailable, maskName, reserveMet, validateListing } from '../auction-engine.js';
import { auctionLink, loadAuction, publicAuction, settleAuction, taka } from '../auction-service.js';

const bidderKey = (auctionId, uid) => `${auctionId}_${uid}`;
const SORTS = {
  ending: (a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt),
  newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
  'price-low': (a, b) => a.currentBid - b.currentBid,
  'price-high': (a, b) => b.currentBid - a.currentBid,
  bids: (a, b) => (b.bidCount || 0) - (a.bidCount || 0),
};
const asTs = (d) => admin.firestore.Timestamp.fromDate(d);
const ledger = (action, req, a, detail = '') => db.collection('auditLog').add({ adminId: req.identity.uid, adminName: req.identity.name, action, target: text(a.title, 120), detail: text(detail, 200), createdAt: stamp() }).catch(() => {});

async function createListing(req, product, body) {
  const rules = validateListing(body);
  const now = new Date();
  const ref = db.collection('auctions').doc();
  const doc = {
    productId: product?.id || null, title: text(product?.name || body.title, 160), category: text(product?.category || body.category || 'Farm products', 80),
    image: product?.image || text(body.image, 1500), images: product?.images || [], description: text(product?.description || body.description, 2000),
    ...rules, currentBid: rules.startingBid, bidCount: 0, bidderCount: 0, watchers: 0, status: 'active',
    sellerId: req.identity.uid, sellerName: text(req.identity.profile?.storeName || req.identity.name, 80), highestBidderId: null, highestBidderName: null,
    createdAt: asTs(now), endsAt: asTs(new Date(now.getTime() + rules.durationDays * 86400000)),
  };
  if (doc.title.length < 3) throw httpError(400, 'Enter an auction title.');
  await ref.set(doc);
  return { id: ref.id, ...plain(doc) };
}

export default function registerAuctionsRoutes(app) {
  // ------------------------------------------------------------------ browse (public)
  app.get('/api/auctions', async (req, res, next) => {
    try {
      needDb();
      const viewer = await identify(req, { optional: true });
      const status = ['active', 'ended', 'all'].includes(req.query.status) ? req.query.status : (req.query.includeEnded === 'true' ? 'all' : 'active');
      let list = shapeAll(await db.collection('auctions').orderBy('endsAt', 'asc').limit(300).get());
      const due = list.filter((a) => a.status === 'active' && Date.parse(a.endsAt) <= Date.now());
      if (due.length) { await Promise.all(due.map((a) => settleAuction(a.id).catch(() => null))); list = shapeAll(await db.collection('auctions').orderBy('endsAt', 'asc').limit(300).get()); }
      if (status === 'active') list = list.filter((a) => a.status === 'active');
      else if (status === 'ended') list = list.filter((a) => a.status !== 'active');
      else list = list.filter((a) => a.status !== 'cancelled' || viewer?.role === 'admin');
      if (req.query.category) list = list.filter((a) => a.category === String(req.query.category));
      if (req.query.seller) list = list.filter((a) => a.sellerId === String(req.query.seller));
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) list = list.filter((a) => [a.title, a.category, a.sellerName].join(' ').toLowerCase().includes(q));
      const categories = [...new Set(shapeAll(await db.collection('auctions').limit(300).get()).filter((a) => a.status === 'active').map((a) => a.category))].sort();
      list.sort(SORTS[req.query.sort] || (status === 'active' ? SORTS.ending : SORTS.newest));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
      res.json({ items: list.slice(0, limit).map((a) => publicAuction(req, a, viewer)), categories, total: list.length });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ one auction + its history
  app.get('/api/auctions/:id', async (req, res, next) => {
    try {
      needDb();
      const viewer = await identify(req, { optional: true });
      let a = await loadAuction(req.params.id);
      if (!a) throw httpError(404, 'Auction not found.');
      if (a.status === 'active' && Date.parse(a.endsAt) <= Date.now()) { await settleAuction(a.id); a = await loadAuction(a.id); }
      const uid = viewer?.uid;
      const [bidSnap, mine, watch] = await Promise.all([
        db.collection('auctions').doc(a.id).collection('bids').orderBy('createdAt', 'desc').limit(60).get(),
        uid ? db.collection('auctionBidders').doc(bidderKey(a.id, uid)).get() : null,
        uid ? db.collection('auctionWatch').doc(bidderKey(a.id, uid)).get() : null,
      ]);
      const bids = bidSnap.docs.map((d) => { const b = plain(d.data()); return { id: d.id, amount: b.amount, bidder: maskName(b.bidderName), auto: Boolean(b.auto), createdAt: b.createdAt, isMine: Boolean(uid && b.bidderId === uid) }; });
      res.json({ item: publicAuction(req, a, viewer), bids, viewer: { signedIn: Boolean(viewer), myMax: mine?.exists ? mine.data().maxBid : null, watching: Boolean(watch?.exists) } });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ place a bid (maximum / proxy bid)
  app.post('/api/auctions/:id/bids', requireUser, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req;
      const maxBid = Number(req.body?.maxBid ?? req.body?.amount);
      const ref = db.collection('auctions').doc(String(req.params.id));
      const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, 'Auction not found.');
        const a = plain(snap.data()); a.id = snap.id;
        if (a.status !== 'active' || Date.parse(a.endsAt) <= Date.now()) throw httpError(410, 'This auction has ended. Bids are closed.');
        if (a.sellerId === identity.uid) throw httpError(403, 'You cannot bid on your own auction.');
        const leaderRef = a.highestBidderId ? db.collection('auctionBidders').doc(bidderKey(a.id, a.highestBidderId)) : null;
        const mineRef = db.collection('auctionBidders').doc(bidderKey(a.id, identity.uid));
        const [leaderSnap, mineSnap] = await Promise.all([leaderRef ? tx.get(leaderRef) : null, tx.get(mineRef)]);
        const leaderMax = leaderSnap?.exists ? Number(leaderSnap.data().maxBid) : Number(a.currentBid);
        const result = applyProxyBid(a, leaderMax, identity.uid, maxBid);
        const now = new Date();
        const names = { [identity.uid]: identity.name, [a.highestBidderId]: a.highestBidderName };
        result.events.forEach((e, i) => tx.set(ref.collection('bids').doc(), { amount: e.amount, bidderId: e.bidderId, bidderName: names[e.bidderId] || 'Bidder', auto: e.auto, createdAt: asTs(new Date(now.getTime() + i)) }));
        const myMax = result.leaderId === identity.uid ? result.leaderMax : Math.max(maxBid, Number(mineSnap.exists ? mineSnap.data().maxBid : 0));
        tx.set(mineRef, { auctionId: a.id, userId: identity.uid, userName: identity.name, maxBid: myMax, bids: (mineSnap.exists ? mineSnap.data().bids || 0 : 0) + 1, updatedAt: asTs(now), ...(mineSnap.exists ? {} : { createdAt: asTs(now) }) }, { merge: true });
        tx.update(ref, {
          currentBid: result.price, bidCount: admin.firestore.FieldValue.increment(result.events.length),
          highestBidderId: result.leaderId, highestBidderName: result.leaderId === identity.uid ? identity.name : a.highestBidderName,
          ...(mineSnap.exists ? {} : { bidderCount: admin.firestore.FieldValue.increment(1) }), updatedAt: asTs(now),
        });
        return { result, a, wasReserveMet: reserveMet(a) };
      });
      const { result, a, wasReserveMet } = outcome;
      if (result.leaderChanged && result.previousLeaderId && result.previousLeaderId !== identity.uid) {
        await notify(result.previousLeaderId, 'You have been outbid', `${a.title} is now at ${taka(result.price)}. Place a higher maximum bid to take the lead back.`, auctionLink(a.id), 'auction');
      }
      await notify(a.sellerId, 'New bid on your auction', `${a.title} is now at ${taka(result.price)} (${(a.bidCount || 0) + result.events.length} bids).`, 'seller-auctions', 'auction');
      if (a.reservePrice && !wasReserveMet && result.reserveMet) await notify(a.sellerId, 'Reserve price met', `${a.title} has reached your reserve price.`, 'seller-auctions', 'auction');
      const leading = result.leaderId === identity.uid;
      res.status(201).json({
        leading, price: result.price, reserveMet: result.reserveMet,
        message: leading ? `You are the highest bidder at ${taka(result.price)}. Your maximum bid stays private.` : `Another bidder's maximum is higher, so you were outbid at ${taka(result.price)}. Raise your maximum to keep bidding.`,
      });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ buy it now
  app.post('/api/auctions/:id/buy-now', requireUser, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req;
      const ref = db.collection('auctions').doc(String(req.params.id));
      const a = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, 'Auction not found.');
        const d = plain(snap.data()); d.id = snap.id;
        if (d.status !== 'active' || Date.parse(d.endsAt) <= Date.now()) throw httpError(410, 'This auction has ended.');
        if (d.sellerId === identity.uid) throw httpError(403, 'You cannot buy your own auction.');
        if (!buyNowAvailable(d)) throw httpError(409, 'Buy It Now is no longer available because bidding has started.');
        const now = new Date();
        tx.update(ref, { status: 'sold', soldVia: 'buy_now', winnerId: identity.uid, winnerName: identity.name, finalPrice: d.buyNowPrice, currentBid: d.buyNowPrice, highestBidderId: identity.uid, highestBidderName: identity.name,
          endedAt: asTs(now), paymentDueAt: asTs(new Date(now.getTime() + AUCTION_PAYMENT_DAYS * 86400000)), settledAt: stamp() });
        tx.set(db.collection('auctionBidders').doc(bidderKey(d.id, identity.uid)), { auctionId: d.id, userId: identity.uid, userName: identity.name, maxBid: d.buyNowPrice, updatedAt: asTs(now) }, { merge: true });
        return d;
      });
      await notify(identity.uid, 'You bought it now', `${a.title} is yours for ${taka(a.buyNowPrice)}. Complete payment within ${AUCTION_PAYMENT_DAYS} days.`, 'my-bids', 'auction');
      await notify(a.sellerId, 'Your auction sold', `${identity.name} bought ${a.title} for ${taka(a.buyNowPrice)}.`, 'seller-auctions', 'auction');
      if (a.highestBidderId && a.highestBidderId !== identity.uid) await notify(a.highestBidderId, 'Auction closed', `${a.title} was bought outright.`, auctionLink(a.id), 'auction');
      res.json({ message: 'It’s yours! Complete payment to confirm your purchase.', id: a.id });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ watchlist
  app.post('/api/auctions/:id/watch', requireUser, async (req, res, next) => {
    try {
      needDb();
      const id = String(req.params.id), uid = req.identity.uid;
      const aRef = db.collection('auctions').doc(id), wRef = db.collection('auctionWatch').doc(bidderKey(id, uid));
      const watching = await db.runTransaction(async (tx) => {
        const [a, w] = await Promise.all([tx.get(aRef), tx.get(wRef)]);
        if (!a.exists) throw httpError(404, 'Auction not found.');
        const want = req.body?.watch === undefined ? !w.exists : Boolean(req.body.watch);
        if (want && !w.exists) { tx.set(wRef, { auctionId: id, userId: uid, createdAt: stamp() }); tx.update(aRef, { watchers: admin.firestore.FieldValue.increment(1) }); }
        if (!want && w.exists) { tx.delete(wRef); tx.update(aRef, { watchers: admin.firestore.FieldValue.increment(-1) }); }
        return want;
      });
      res.json({ watching, message: watching ? 'Added to your watchlist. We will warn you before it ends.' : 'Removed from your watchlist.' });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ my bids / watchlist
  app.get('/api/me/bids', requireUser, async (req, res, next) => {
    try {
      needDb();
      const uid = req.identity.uid;
      const [bidderSnap, watchSnap] = await Promise.all([db.collection('auctionBidders').where('userId', '==', uid).get(), db.collection('auctionWatch').where('userId', '==', uid).get()]);
      const ids = [...new Set([...bidderSnap.docs.map((d) => d.data().auctionId), ...watchSnap.docs.map((d) => d.data().auctionId)])];
      const snaps = ids.length ? await db.getAll(...ids.map((id) => db.collection('auctions').doc(id))) : [];
      const byId = new Map(snaps.filter((s) => s.exists).map((s) => [s.id, shape(s)]));
      for (const a of byId.values()) if (a.status === 'active' && Date.parse(a.endsAt) <= Date.now()) { await settleAuction(a.id).catch(() => null); byId.set(a.id, await loadAuction(a.id)); }
      const maxOf = new Map(bidderSnap.docs.map((d) => [d.data().auctionId, d.data().maxBid]));
      const stateOf = (a) => {
        if (a.status === 'active') return a.highestBidderId === uid ? 'winning' : 'outbid';
        if (a.status === 'sold') return a.winnerId === uid ? (a.orderId ? 'won_paid' : 'won') : 'lost';
        if (a.status === 'unpaid') return a.winnerId === uid ? 'unpaid' : 'lost';
        return a.status === 'cancelled' ? 'cancelled' : 'no_sale';
      };
      const items = [...maxOf.keys()].filter((id) => byId.has(id)).map((id) => { const a = byId.get(id); return { auction: publicAuction(req, a, req.identity), state: stateOf(a), myMax: maxOf.get(id) }; })
        .sort((x, y) => Date.parse(y.auction.endsAt) - Date.parse(x.auction.endsAt));
      const watching = watchSnap.docs.map((d) => d.data().auctionId).filter((id) => byId.has(id)).map((id) => publicAuction(req, byId.get(id), req.identity));
      res.json({ items, watching, paymentDays: AUCTION_PAYMENT_DAYS });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ winner pays: turn the won lot into an order
  app.post('/api/auctions/:id/checkout', requireUser, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req, body = req.body || {}, rec = body.recipient || {};
      const name = text(rec.name, 80), phone = text(rec.phone, 20).replace(/[\s-]/g, ''), address = text(rec.address, 300), area = text(rec.area, 80);
      if (!name || !/^\+?\d{10,15}$/.test(phone)) throw httpError(400, 'Enter a recipient name and a valid phone number.');
      if (address.length < 5) throw httpError(400, 'Enter a full delivery address.');
      const method = ['cash', 'bkash', 'nagad'].includes(body.paymentMethod) ? body.paymentMethod : 'cash';
      if (method !== 'cash' && !process.env[`PAYMENT_${method.toUpperCase()}_ACCOUNT`]) throw httpError(400, 'This payment method is not configured.');
      const settings = await getSettings();
      const aRef = db.collection('auctions').doc(String(req.params.id));
      const created = await db.runTransaction(async (tx) => {
        const snap = await tx.get(aRef);
        if (!snap.exists) throw httpError(404, 'Auction not found.');
        const a = plain(snap.data()); a.id = snap.id;
        if (a.winnerId !== identity.uid) throw httpError(403, 'Only the winning bidder can pay for this auction.');
        if (a.orderId) throw httpError(409, 'This auction has already been paid for.');
        if (a.status !== 'sold') throw httpError(409, a.status === 'unpaid' ? `The ${AUCTION_PAYMENT_DAYS}-day payment period has ended.` : 'This auction is not ready for payment.');
        const pRef = a.productId ? db.collection('products').doc(a.productId) : null;
        const pSnap = pRef ? await tx.get(pRef) : null;
        const price = money(a.finalPrice);
        const deliveryFee = price >= Number(settings.freeDeliveryOver) ? 0 : Number(settings.deliveryFee);
        const commission = money((price * Number(settings.commissionRate)) / 100);
        const ref = db.collection('orders').doc();
        const orderNumber = `KH-${ref.id.slice(0, 7).toUpperCase()}`;
        const doc = {
          orderNumber, checkoutId: `AU${Date.now().toString(36).toUpperCase()}`, source: 'auction', auctionId: a.id,
          customerId: identity.uid, customerName: name, customerEmail: identity.email, phone, address, area,
          paymentMethod: method, paymentStatus: 'pending', paymentVerifiedAt: null,
          sellerId: a.sellerId, sellerName: a.sellerName,
          items: [{ productId: a.productId || `auction-${a.id}`, name: a.title, image: a.image, unit: '1 lot', price, quantity: 1, lineTotal: price, auctionId: a.id }],
          subtotal: price, discount: 0, couponCode: '', deliveryFee, total: money(price + deliveryFee),
          commissionRate: Number(settings.commissionRate), commission, sellerNet: money(price - commission),
          status: 'placed', history: [{ status: 'placed', at: new Date().toISOString(), by: identity.name, note: 'Auction won' }], createdAt: stamp(), updatedAt: stamp(),
        };
        tx.set(ref, doc);
        if (pSnap?.exists) tx.update(pRef, { stock: Math.max(0, Number(pSnap.data().stock || 0) - 1) });
        tx.update(aRef, { orderId: ref.id, orderNumber, paidAt: stamp() });
        return { id: ref.id, orderNumber, total: doc.total, sellerId: a.sellerId, title: a.title, paymentMethod: method };
      });
      await notify(created.sellerId, 'New order received', `${created.orderNumber} · auction win · ${taka(created.total)}`, 'seller-orders', 'order');
      await notify(identity.uid, 'Order placed', `${created.orderNumber} · ${created.title} · ${taka(created.total)}.${created.paymentMethod === 'cash' ? ' Pay on delivery.' : ' Submit your transaction reference on My payments.'}`, created.paymentMethod === 'cash' ? 'orders' : 'payments', 'order');
      res.status(201).json({ order: created, message: created.paymentMethod === 'cash' ? 'Order placed. Pay when your lot is delivered.' : 'Order placed. Submit your payment reference to finish.' });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ seller tools
  app.get('/api/seller/auctions', requireSellerArea, async (req, res, next) => {
    try {
      needDb();
      const uid = req.identity.uid;
      let list = shapeAll(await db.collection('auctions').where('sellerId', '==', uid).get());
      const due = list.filter((a) => a.status === 'active' && Date.parse(a.endsAt) <= Date.now());
      if (due.length) { await Promise.all(due.map((a) => settleAuction(a.id).catch(() => null))); list = shapeAll(await db.collection('auctions').where('sellerId', '==', uid).get()); }
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json({ items: list.map((a) => publicAuction(req, a, req.identity)) });
    } catch (error) { next(error); }
  });

  app.post('/api/seller/products/:id/auction', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('products').doc(String(req.params.id)).get();
      if (!snap.exists) throw httpError(404, 'Product not found.');
      const p = { id: snap.id, ...snap.data() };
      if (p.sellerId !== req.identity.uid && req.identity.role !== 'admin') throw httpError(403, 'You can only auction your own products.');
      if (p.status !== 'active') throw httpError(400, 'Only approved products can be auctioned.');
      if (Number(p.stock) < 1) throw httpError(400, 'This product is out of stock, so it cannot be auctioned.');
      const open = shapeAll(await db.collection('auctions').where('productId', '==', p.id).get()).some((a) => a.status === 'active');
      if (open) throw httpError(409, 'This product already has a live auction.');
      const item = await createListing(req, p, req.body || {});
      res.status(201).json({ id: item.id, message: 'Auction started. Customers can bid now.' });
    } catch (error) { next(error); }
  });

  app.post('/api/auctions', requireSeller, async (req, res, next) => {   // stand-alone listing (no catalogue product)
    try { needDb(); const item = await createListing(req, null, req.body || {}); res.status(201).json({ id: item.id, item: publicAuction(req, item, req.identity), message: 'Auction created.' }); } catch (error) { next(error); }
  });

  app.post('/api/auctions/:id/relist', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const old = await loadAuction(req.params.id);
      if (!old) throw httpError(404, 'Auction not found.');
      if (old.sellerId !== req.identity.uid && req.identity.role !== 'admin') throw httpError(403, 'This is not your auction.');
      if (!['unsold', 'unpaid', 'cancelled'].includes(old.status)) throw httpError(409, 'Only auctions that ended without a sale can be relisted.');
      if (old.productId) {
        const open = shapeAll(await db.collection('auctions').where('productId', '==', old.productId).get()).some((a) => a.status === 'active');
        if (open) throw httpError(409, 'This product already has a live auction.');
      }
      const item = await createListing(req, null, { ...old, title: old.title, category: old.category, image: old.image, description: old.description, durationDays: req.body?.durationDays || old.durationDays });
      await db.collection('auctions').doc(item.id).update({ productId: old.productId || null, images: old.images || [], relistOf: old.id });
      res.status(201).json({ id: item.id, message: 'Auction relisted.' });
    } catch (error) { next(error); }
  });

  app.patch('/api/auctions/:id/end', requireSeller, async (req, res, next) => {   // seller withdraws an auction that has no bids
    try {
      needDb();
      const ref = db.collection('auctions').doc(String(req.params.id));
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, 'Auction not found.');
        const a = snap.data();
        if (a.sellerId !== req.identity.uid && req.identity.role !== 'admin') throw httpError(403, 'This is not your auction.');
        if (a.status !== 'active') throw httpError(409, 'This auction is not live.');
        if (Number(a.bidCount) > 0) throw httpError(409, 'An auction with bids cannot be ended early. Contact support if something is wrong with the item.');
        tx.update(ref, { status: 'cancelled', endedAt: admin.firestore.Timestamp.now(), cancelReason: 'Ended by seller' });
      });
      res.json({ message: 'Auction ended.' });
    } catch (error) { next(error); }
  });

  // ------------------------------------------------------------------ administrators
  app.get('/api/admin/auctions', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      let list = shapeAll(await db.collection('auctions').get());
      const due = list.filter((a) => a.status === 'active' && Date.parse(a.endsAt) <= Date.now());
      if (due.length) { await Promise.all(due.map((a) => settleAuction(a.id).catch(() => null))); list = shapeAll(await db.collection('auctions').get()); }
      list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json({ items: list.slice(0, 300).map((a) => ({ ...publicAuction(req, a, req.identity), winnerId: a.winnerId || null, reservePrice: a.reservePrice || null, cancelReason: a.cancelReason || '' })) });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/auctions/:id/bids', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('auctions').doc(String(req.params.id)).collection('bids').orderBy('createdAt', 'desc').limit(200).get();
      res.json({ items: snap.docs.map((d) => { const b = plain(d.data()); return { id: d.id, amount: b.amount, bidder: b.bidderName, auto: Boolean(b.auto), createdAt: b.createdAt }; }) });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/auctions/:id/cancel', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      const reason = text(req.body?.reason, 200);
      if (reason.length < 3) throw httpError(400, 'Give a short reason. Bidders and the seller will see it.');
      const ref = db.collection('auctions').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Auction not found.');
      const a = shape(snap);
      if (a.status !== 'active') throw httpError(400, 'Only live auctions can be cancelled.');
      await ref.update({ status: 'cancelled', endedAt: admin.firestore.Timestamp.now(), cancelReason: reason });
      const [bidders, watchers] = await Promise.all([db.collection('auctionBidders').where('auctionId', '==', a.id).get(), db.collection('auctionWatch').where('auctionId', '==', a.id).get()]);
      const people = new Set([...bidders.docs, ...watchers.docs].map((d) => d.data().userId));
      await notify(a.sellerId, 'Auction cancelled', `${a.title}: ${reason}`, 'seller-auctions', 'auction');
      await Promise.all([...people].map((u) => notify(u, 'Auction cancelled', `${a.title} was cancelled by Khamari. ${reason}`, auctionLink(a.id), 'auction')));
      await ledger('auction.cancel', req, a, reason);
      res.json({ message: 'Auction cancelled and everyone involved was notified.' });
    } catch (error) { next(error); }
  });
}