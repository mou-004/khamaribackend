// Database side of the auction system: public shaping, closing finished auctions and the background jobs.
import { admin, db } from './runtime.js';
import { needDb, notify, plain, shape, shapeAll, stamp } from './lib.js';
import { AUCTION_PAYMENT_DAYS, buyNowAvailable, maskName, minimumBid, reserveMet, settleOutcome } from './auction-engine.js';

export const taka = (n) => `৳${Number(n || 0).toLocaleString('en-BD')}`;
export const auctionLink = (id) => `auction-detail?id=${id}`;
const absImg = (req, url) => (typeof url === 'string' && url.startsWith('/api/images/') ? `${process.env.PUBLIC_API_URL ? process.env.PUBLIC_API_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`}${url}` : url);

// What the browser may see. The reserve price, the leader's id and every maximum bid stay on the server.
export function publicAuction(req, a, viewer = null) {
  const uid = viewer?.uid || null;
  const owner = Boolean(uid && (a.sellerId === uid || viewer.role === 'admin'));
  const ended = a.status !== 'active' || Date.parse(a.endsAt) <= Date.now();
  const out = {
    id: a.id, productId: a.productId || null, title: a.title, category: a.category, description: a.description || '', condition: a.condition || '',
    image: absImg(req, a.image), images: (a.images || []).map((u) => absImg(req, u)),
    startingBid: a.startingBid, currentBid: a.currentBid, incrementAmount: a.incrementAmount, bidCount: a.bidCount || 0, bidderCount: a.bidderCount || 0, watchers: a.watchers || 0,
    minNextBid: minimumBid(a), hasReserve: Boolean(a.reservePrice), reserveMet: reserveMet(a),
    buyNowPrice: a.buyNowPrice || null, buyNowAvailable: !ended && buyNowAvailable(a),
    status: a.status, isEnded: ended, createdAt: a.createdAt, endsAt: a.endsAt, endedAt: a.endedAt || null,
    sellerId: a.sellerId, sellerName: a.sellerName || 'Khamari seller',
    leaderName: a.highestBidderName ? maskName(a.highestBidderName) : null,
    finalPrice: a.finalPrice || null, winnerName: a.winnerName ? maskName(a.winnerName) : null, paymentDueAt: a.paymentDueAt || null,
    isLeading: Boolean(uid && a.status === 'active' && a.highestBidderId === uid), isSeller: Boolean(uid && a.sellerId === uid), isWinner: Boolean(uid && a.winnerId === uid),
  };
  if (owner) { out.reservePrice = a.reservePrice || null; out.winnerFullName = a.winnerName || null; }
  if (uid && (a.winnerId === uid || owner)) { out.orderId = a.orderId || null; out.orderNumber = a.orderNumber || null; }
  return out;
}

async function participantIds(auctionId) {
  const [bidders, watchers] = await Promise.all([db.collection('auctionBidders').where('auctionId', '==', auctionId).get(), db.collection('auctionWatch').where('auctionId', '==', auctionId).get()]);
  return { bidders: bidders.docs.map((d) => d.data().userId), watchers: watchers.docs.map((d) => d.data().userId) };
}

// Closes an auction whose time is up: decides sold / unsold, saves the winner and tells everybody. Safe to call twice.
export async function settleAuction(id) {
  needDb();
  const ref = db.collection('auctions').doc(String(id));
  const done = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const a = plain(snap.data()); a.id = snap.id;
    if (a.status !== 'active' || Date.parse(a.endsAt) > Date.now()) return null;
    const out = settleOutcome(a);
    const now = new Date();
    const update = { status: out.status, endedAt: admin.firestore.Timestamp.fromDate(now), settledAt: stamp() };
    if (out.status === 'sold') Object.assign(update, { winnerId: out.winnerId, winnerName: a.highestBidderName, finalPrice: out.finalPrice, paymentDueAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + AUCTION_PAYMENT_DAYS * 86400000)) });
    else update.unsoldReason = out.reason;
    tx.update(ref, update);
    return { a, out };
  });
  if (!done) return null;
  const { a, out } = done;
  const { bidders, watchers } = await participantIds(a.id);
  const link = auctionLink(a.id);
  if (out.status === 'sold') {
    await notify(out.winnerId, 'You won the auction! 🎉', `${a.title} is yours for ${taka(out.finalPrice)}. Pay within ${AUCTION_PAYMENT_DAYS} days to complete the purchase.`, 'my-bids', 'auction');
    await notify(a.sellerId, 'Your auction sold', `${a.title} sold for ${taka(out.finalPrice)}. The winner has ${AUCTION_PAYMENT_DAYS} days to pay.`, 'seller-auctions', 'auction');
    await Promise.all([...new Set([...bidders, ...watchers])].filter((u) => u !== out.winnerId).map((u) => notify(u, 'Auction ended', `${a.title} ended and sold for ${taka(out.finalPrice)}.`, link, 'auction')));
  } else {
    const why = out.reason === 'reserve_not_met' ? 'The reserve price was not met.' : 'There were no bids.';
    await notify(a.sellerId, 'Your auction ended unsold', `${a.title}: ${why} You can relist it from My auctions.`, 'seller-auctions', 'auction');
    await Promise.all([...new Set([...bidders, ...watchers])].map((u) => notify(u, 'Auction ended', `${a.title} ended without a sale.`, link, 'auction')));
  }
  return out;
}

// Background work, run every 30 seconds: close finished auctions, warn about ending ones, expire unpaid wins.
export async function runAuctionJobs() {
  if (!db) return;
  const snap = await db.collection('auctions').where('status', 'in', ['active', 'sold']).get();
  const now = Date.now();
  for (const doc of snap.docs) {
    const a = { id: doc.id, ...plain(doc.data()) };
    try {
      if (a.status === 'active' && Date.parse(a.endsAt) <= now) { await settleAuction(a.id); continue; }
      if (a.status === 'active' && !a.endingSoonNotified && Date.parse(a.endsAt) - now <= 3600000) {
        await doc.ref.update({ endingSoonNotified: true });
        const { bidders, watchers } = await participantIds(a.id);
        await Promise.all([...new Set([...bidders, ...watchers])].map((u) => notify(u, 'Auction ends within the hour', `${a.title} is at ${taka(a.currentBid)}${a.highestBidderId === u ? ' and you are leading' : ''}.`, auctionLink(a.id), 'auction')));
      }
      if (a.status === 'sold' && !a.orderId && a.paymentDueAt && Date.parse(a.paymentDueAt) <= now) {
        await doc.ref.update({ status: 'unpaid', unpaidAt: stamp() });
        await notify(a.winnerId, 'Auction win expired', `You did not complete payment for ${a.title} in time, so the sale was cancelled.`, 'my-bids', 'auction');
        await notify(a.sellerId, 'Winner did not pay', `${a.title} was not paid for. You can relist it from My auctions.`, 'seller-auctions', 'auction');
      } else if (a.status === 'sold' && !a.orderId && !a.payReminderSent && a.paymentDueAt && Date.parse(a.paymentDueAt) - now <= 86400000) {
        await doc.ref.update({ payReminderSent: true });
        await notify(a.winnerId, 'Pay for your auction win', `${a.title} must be paid within 24 hours.`, 'my-bids', 'auction');
      }
    } catch (error) { console.error('Auction job failed for', a.id, error.message); }
  }
}

export const loadAuction = async (id) => { const snap = await needDb().collection('auctions').doc(String(id)).get(); return snap.exists ? shape(snap) : null; };
export { shapeAll };