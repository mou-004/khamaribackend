export const AUCTION_PAYMENT_DAYS = 3;       // winner must check out within this many days
export const MAX_BID = 100000000;

const r2 = (n) => Math.round(Number(n) * 100) / 100;

export function minimumBid(a) {
  return Number(a.bidCount || 0) === 0 ? r2(a.startingBid) : r2(Number(a.currentBid) + Number(a.incrementAmount));
}

export const reserveMet = (a) => !a.reservePrice || Number(a.currentBid) >= Number(a.reservePrice);

export function buyNowAvailable(a) {
  if (!a.buyNowPrice || a.status !== 'active') return false;
  if (a.reservePrice) return !reserveMet(a) || Number(a.bidCount || 0) === 0;
  return Number(a.bidCount || 0) === 0;
}

export function maskName(name = '') {
  const s = String(name).trim();
  if (!s) return 'Bidder';
  if (s.length <= 2) return `${s[0]}***`;
  return `${s[0]}***${s[s.length - 1]}`;
}

export const isOnStep = (a, amount) => {
  const steps = (Number(amount) - Number(a.startingBid)) / Number(a.incrementAmount);
  return Math.abs(steps - Math.round(steps)) < 1e-6;
};
export const snapDown = (a, amount) => r2(Number(a.startingBid) + Math.floor((Number(amount) - Number(a.startingBid)) / Number(a.incrementAmount) + 1e-9) * Number(a.incrementAmount));
export const snapUp = (a, amount) => r2(Number(a.startingBid) + Math.ceil((Number(amount) - Number(a.startingBid)) / Number(a.incrementAmount) - 1e-9) * Number(a.incrementAmount));
const requireStep = (a, max) => {
  if (isOnStep(a, max)) return;
  const lo = snapDown(a, max), hi = snapUp(a, max);
  throw fail(400, `Bids go up in steps of ${r2(a.incrementAmount)}. Choose ${lo >= Number(a.startingBid) ? `${lo} or ` : ''}${hi}.`);
};

const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * Applies one bidder's maximum bid to the auction.
 * @param a            { startingBid, currentBid, incrementAmount, bidCount, reservePrice, highestBidderId }
 * @param leaderMax    the leader's stored maximum bid (defaults to the current price when unknown)
 * @param bidderId     who is bidding
 * @param maxBid       the maximum they entered
 * @returns { price, leaderId, leaderMax, events[], previousLeaderId, leaderChanged, outbidImmediately, reserveMet }
 *          events = the rows to write to the public bid history, oldest first.
 */
export function applyProxyBid(a, leaderMax, bidderId, maxBid) {
  const inc = Number(a.incrementAmount);
  const max = r2(maxBid);
  if (!Number.isFinite(max) || max <= 0) throw fail(400, 'Enter a valid bid amount.');
  if (max > MAX_BID) throw fail(400, 'That bid is higher than the maximum allowed.');
  const hasBids = Number(a.bidCount || 0) > 0 && a.highestBidderId;
  const reserve = a.reservePrice ? Number(a.reservePrice) : 0;
  const events = [];
  let price = Number(a.currentBid), leaderId = a.highestBidderId || null, newMax = leaderMax, leaderChanged = false, outbidImmediately = false;
  const previousLeaderId = hasBids ? a.highestBidderId : null;

  if (!hasBids) {
    if (max < Number(a.startingBid)) throw fail(400, `Your bid must be at least ${r2(a.startingBid)}.`);
    requireStep(a, max);
    price = r2(a.startingBid); leaderId = bidderId; newMax = max; leaderChanged = true;
    events.push({ bidderId, amount: price, auto: false });
  } else if (a.highestBidderId === bidderId) {
    if (max <= Number(leaderMax)) throw fail(400, `You are already the highest bidder with a maximum of ${r2(leaderMax)}. Enter a higher maximum to raise it.`);
    requireStep(a, max);
    newMax = max; // only the hidden maximum moves; the visible price does not
  } else {
    const min = minimumBid(a);
    if (max < min) throw fail(400, `Your bid must be at least ${min}.`);
    requireStep(a, max);
    if (max > Number(leaderMax)) {            // challenger takes the lead
      const lm = Number(leaderMax);
      if (lm > Number(a.currentBid)) events.push({ bidderId: a.highestBidderId, amount: r2(lm), auto: true });
      price = r2(Math.min(max, lm + inc)); leaderId = bidderId; newMax = max; leaderChanged = true;
      events.push({ bidderId, amount: price, auto: false });
    } else {                                   // current leader's proxy defends (ties go to the earlier bidder)
      events.push({ bidderId, amount: max, auto: false });
      price = r2(Math.min(Number(leaderMax), max + inc));
      events.push({ bidderId: a.highestBidderId, amount: price, auto: true });
      outbidImmediately = true; // newMax stays the leader's
    }
  }

  // Reserve: once the leader's maximum reaches the reserve, the price rises to the reserve.
  if (reserve && newMax >= reserve && price < reserve) {
    price = r2(reserve);
    if (events.length) events[events.length - 1].amount = price;
    else events.push({ bidderId: leaderId, amount: price, auto: true });
  }
  return { price, leaderId, leaderMax: newMax, events, previousLeaderId, leaderChanged, outbidImmediately, reserveMet: !reserve || price >= reserve };
}

// What happens when the clock runs out.
export function settleOutcome(a) {
  if (!Number(a.bidCount || 0) || !a.highestBidderId) return { status: 'unsold', reason: 'no_bids' };
  if (a.reservePrice && Number(a.currentBid) < Number(a.reservePrice)) return { status: 'unsold', reason: 'reserve_not_met' };
  return { status: 'sold', winnerId: a.highestBidderId, finalPrice: r2(a.currentBid) };
}

export function validateListing(b) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const startingBid = num(b.startingBid), incrementAmount = num(b.incrementAmount), reservePrice = num(b.reservePrice), buyNowPrice = num(b.buyNowPrice);
  const durationDays = Math.floor(Number(b.durationDays));
  if (!(startingBid > 0)) throw fail(400, 'Starting bid must be greater than zero.');
  if (!(incrementAmount > 0)) throw fail(400, 'Bid increment must be greater than zero.');
  if (!(durationDays >= 1 && durationDays <= 30)) throw fail(400, 'Duration must be between 1 and 30 days.');
  if (reservePrice != null && !(reservePrice > startingBid)) throw fail(400, 'Reserve price must be higher than the starting bid.');
  if (buyNowPrice != null && !(buyNowPrice > startingBid)) throw fail(400, 'Buy-now price must be higher than the starting bid.');
  if (buyNowPrice != null && reservePrice != null && buyNowPrice < reservePrice) throw fail(400, 'Buy-now price cannot be lower than the reserve price.');
  const base = { startingBid: r2(startingBid), incrementAmount: r2(incrementAmount) };
  const reserveOnStep = reservePrice != null ? snapUp(base, reservePrice) : null;   // a reserve is always one of the bid steps
  return { ...base, reservePrice: reserveOnStep, buyNowPrice: buyNowPrice != null ? r2(buyNowPrice) : null, durationDays };
}