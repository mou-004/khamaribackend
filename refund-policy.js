export const SELLER_RESPONSE_DAYS = 3;   // seller must answer, otherwise the request goes to an administrator
export const RETURN_SHIP_DAYS = 7;       // customer must ship an approved return within this time
export const ESCALATION_DAYS = 7;        // customer may escalate a rejection within this time
export const MAX_EVIDENCE = 5;

export const REASONS = {
  damaged:          { label: 'Item arrived damaged or defective', windowDays: 7,  returnRequired: false, evidence: true,  faultSeller: true },
  spoiled:          { label: 'Fresh item spoiled or poor quality', windowDays: 2,  returnRequired: false, evidence: true,  faultSeller: true },
  wrong_item:       { label: 'Wrong item received',               windowDays: 7,  returnRequired: true,  evidence: true,  faultSeller: true },
  not_as_described: { label: 'Not as described',                  windowDays: 7,  returnRequired: true,  evidence: true,  faultSeller: true },
  missing_items:    { label: 'Missing items from my order',       windowDays: 3,  returnRequired: false, evidence: false, faultSeller: true },
  not_received:     { label: 'Order never arrived',               windowDays: 14, returnRequired: false, evidence: false, faultSeller: true },
  changed_mind:     { label: 'I changed my mind',                 windowDays: 7,  returnRequired: true,  evidence: false, faultSeller: false },
  other:            { label: 'Something else',                    windowDays: 7,  returnRequired: false, evidence: false, faultSeller: false },
};

// Fresh produce, animals and similar goods cannot be returned just because the buyer changed their mind.
export const NON_RETURNABLE_CATEGORY = /vegetable|fruit|dairy|egg|fish|meat|livestock|pet/i;

export const ACTIVE = ['requested', 'approved', 'return_shipped', 'refund_pending', 'escalated'];   // still being handled
export const COUNTS_AGAINST_ORDER = [...ACTIVE, 'refunded'];                                          // quantities/amounts reserved
export const STATUS_LABEL = {
  requested: 'Awaiting seller', approved: 'Approved – return the item', return_shipped: 'Return on the way', refund_pending: 'Refund being processed',
  refunded: 'Refunded', rejected: 'Rejected', escalated: 'With Khamari support', cancelled: 'Cancelled',
};

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });
const daysBetween = (fromIso, now) => (now - Date.parse(fromIso)) / 86400000;

export const reasonList = () => Object.entries(REASONS).map(([code, r]) => ({ code, label: r.label, windowDays: r.windowDays, returnRequired: r.returnRequired, evidence: r.evidence }));

// How much of each ordered item can still be refunded (other open/finished requests reserve their quantity).
export function remainingByItem(order, otherRefunds) {
  const used = new Map();
  for (const rf of otherRefunds) {
    if (!COUNTS_AGAINST_ORDER.includes(rf.status)) continue;
    for (const i of rf.items || []) used.set(i.productId, (used.get(i.productId) || 0) + Number(i.quantity));
  }
  return (order.items || []).map((i) => ({ ...i, remaining: Math.max(0, Number(i.quantity) - (used.get(i.productId) || 0)) }));
}

// Is this order, right now, allowed to open a request for this reason?
export function checkEligibility(order, otherRefunds, reasonCode, now = Date.now()) {
  const reason = REASONS[reasonCode];
  if (!reason) throw fail(400, 'Choose a reason for your refund.');
  if (!order) throw fail(404, 'Order not found.');
  if (order.status === 'cancelled') throw fail(409, 'This order was cancelled. If you had already paid, your money is refunded automatically.');
  if (order.paymentStatus !== 'paid') throw fail(409, 'Refunds apply to paid orders. Cash on delivery orders become refundable once delivered and paid.');
  const delivered = ['delivered', 'received'].includes(order.status);
  if (!delivered && !(reasonCode === 'not_received' && order.status === 'shipped')) throw fail(409, reasonCode === 'not_received' ? 'You can report a missing order once it has been shipped.' : 'You can request a refund after your order has been delivered.');
  if (order.activeRefundId && otherRefunds.some((r) => r.id === order.activeRefundId && ACTIVE.includes(r.status))) throw fail(409, 'This order already has a refund request in progress.');
  const since = delivered ? (order.deliveredAt || order.updatedAt || order.createdAt) : order.createdAt;
  if (since && daysBetween(since, now) > reason.windowDays) throw fail(409, `The ${reason.windowDays}-day window for “${reason.label}” has passed for this order.`);
  if (order.auctionId && reasonCode === 'changed_mind') throw fail(409, 'Auction bids are binding, so auction purchases cannot be returned because you changed your mind.');
  return { reason, deadline: since ? new Date(Date.parse(since) + reason.windowDays * 86400000).toISOString() : null };
}

/**
 * Works out what a request is worth. `lines` = [{ productId, quantity }], `remaining` = remainingByItem(...).
 * Discounts (coupons) are shared proportionally; the delivery fee is returned only when the whole order is refunded
 * for a reason that is the seller's fault.
 */
export function calculateRefund(order, remaining, lines, reasonCode, { deliveryAlreadyRefunded = false, categories = {} } = {}) {
  const reason = REASONS[reasonCode];
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Choose at least one item to refund.');
  const items = [];
  for (const line of lines) {
    const base = remaining.find((i) => i.productId === line.productId);
    const qty = Math.floor(Number(line.quantity));
    if (!base) throw fail(400, 'One of the selected items is not part of this order.');
    if (!(qty >= 1)) throw fail(400, `Choose a quantity for ${base.name}.`);
    if (qty > base.remaining) throw fail(400, `Only ${base.remaining} of ${base.name} can still be refunded.`);
    if (reasonCode === 'changed_mind' && NON_RETURNABLE_CATEGORY.test(categories[line.productId] || '')) throw fail(400, `${base.name} is fresh produce or a live animal, so it cannot be returned because of a change of mind.`);
    if (items.some((i) => i.productId === base.productId)) throw fail(400, 'Each item can only be listed once.');
    items.push({ productId: base.productId, name: base.name, image: base.image, unit: base.unit, price: Number(base.price), quantity: qty, lineTotal: r2(Number(base.price) * qty) });
  }
  const gross = r2(items.reduce((n, i) => n + i.lineTotal, 0));
  const discount = Number(order.discount || 0), subtotal = Number(order.subtotal || 0) || gross;
  const itemsAmount = r2(gross - (discount * gross) / subtotal);
  const wholeOrder = remaining.filter((b) => b.remaining > 0).every((b) => (items.find((i) => i.productId === b.productId)?.quantity || 0) === b.remaining);
  const deliveryRefund = reason.faultSeller && wholeOrder && !deliveryAlreadyRefunded ? r2(Number(order.deliveryFee || 0)) : 0;
  const amount = r2(itemsAmount + deliveryRefund);
  const rate = Number(order.commissionRate || 0);
  const commissionReversal = r2((itemsAmount * rate) / 100);
  return { items, itemsAmount, deliveryRefund, amount, commissionReversal, sellerDeduction: r2(itemsAmount - commissionReversal) };
}

export const kindFor = (reasonCode) => (REASONS[reasonCode]?.returnRequired ? 'return_refund' : 'refund_only');

// Who may move a request to which status.
export const TRANSITIONS = {
  requested:      { customer: ['cancelled'], seller: ['approved', 'refund_pending', 'rejected'], admin: ['approved', 'refund_pending', 'rejected'], system: ['escalated'] },
  approved:       { customer: ['return_shipped', 'cancelled'], seller: [], admin: ['rejected', 'cancelled'], system: ['cancelled'] },
  return_shipped: { customer: [], seller: ['refund_pending', 'rejected'], admin: ['refund_pending', 'rejected'], system: [] },
  rejected:       { customer: ['escalated'], seller: [], admin: ['approved', 'refund_pending'], system: [] },
  escalated:      { customer: [], seller: [], admin: ['approved', 'refund_pending', 'rejected'], system: [] },
  refund_pending: { customer: [], seller: [], admin: ['refunded'], system: [] },
  refunded: { customer: [], seller: [], admin: [], system: [] },
  cancelled: { customer: [], seller: [], admin: [], system: [] },
};
export const canMove = (from, to, role) => Boolean(TRANSITIONS[from]?.[role]?.includes(to));

// Paid orders that get cancelled are refunded in full automatically (an administrator sends the money).
export function cancellationRefund(order, orderId, actorName) {
  const now = new Date().toISOString();
  return {
    refundNumber: `RF-${String(orderId).slice(0, 7).toUpperCase()}C`, orderId, orderNumber: order.orderNumber,
    customerId: order.customerId, customerName: order.customerName, customerEmail: order.customerEmail, sellerId: order.sellerId, sellerName: order.sellerName,
    kind: 'cancellation', reason: 'cancelled', reasonLabel: 'Order cancelled after payment', details: `Order cancelled by ${actorName}.`, evidence: [],
    items: (order.items || []).map((i) => ({ productId: i.productId, name: i.name, image: i.image, unit: i.unit, price: i.price, quantity: i.quantity, lineTotal: i.lineTotal })),
    itemsAmount: r2(Number(order.total) - Number(order.deliveryFee || 0)), deliveryRefund: r2(order.deliveryFee || 0), amount: r2(order.total), commissionReversal: 0, sellerDeduction: 0,
    refundTo: { method: order.paymentMethod, account: order.paymentReference ? `Original ${order.paymentMethod} payment · ref ${order.paymentReference}` : `Original ${order.paymentMethod} payment` },
    status: 'refund_pending', history: [{ status: 'refund_pending', at: now, by: 'Khamari', byRole: 'system', note: 'Order cancelled after payment. Full refund queued.' }], messages: [],
  };
}