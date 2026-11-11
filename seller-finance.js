// Seller settlement calculations. Order value is visible as soon as an order is
// placed; money becomes withdrawable only after receipt and payment are confirmed.
import { orderPaymentMethod } from './payment-policy.js';

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const ACTIVE_ORDER_STATUSES = ['placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered'];

/**
 * Backfill calculated fields for older orders created before sellerNet,
 * commission and subtotal were stored consistently. Never infer that an
 * unpaid order has been paid.
 */
export function normalizeSellerOrder(order = {}, defaultCommissionRate = 5) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsSubtotal = money(items.reduce((sum, item) => {
    const lineTotal = item.lineTotal != null
      ? Number(item.lineTotal)
      : Number(item.price || 0) * Number(item.quantity || 0);
    return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
  }, 0));

  const subtotal = order.subtotal == null || (Number(order.subtotal) === 0 && itemsSubtotal > 0)
    ? itemsSubtotal
    : money(order.subtotal);
  const discount = money(order.discount || 0);
  const deliveryFee = money(order.deliveryFee || 0);
  const commissionBase = Math.max(0, subtotal - discount);
  const commissionRate = order.commissionRate == null
    ? Number(defaultCommissionRate || 0)
    : Number(order.commissionRate || 0);
  const commission = order.commission == null
    ? money(commissionBase * commissionRate / 100)
    : money(order.commission);
  const sellerNet = order.sellerNet == null
    ? money(Math.max(0, commissionBase - commission))
    : money(order.sellerNet);
  const total = order.total == null
    ? money(commissionBase + deliveryFee)
    : money(order.total);

  return {
    ...order,
    paymentStatus: orderPaymentMethod(order) === 'cash' ? 'not_required' : (order.paymentStatus || 'pending'),
    items,
    subtotal,
    discount,
    deliveryFee,
    commissionRate,
    commission,
    sellerNet,
    total
  };
}

export function calculateSellerFinance(orders = [], payouts = [], refunds = []) {
  const validRefunds = refunds.filter((r) => r.kind !== 'cancellation');
  const paidRefunds = validRefunds.filter((r) => r.status === 'refunded');
  const refundedNet = money(paidRefunds.reduce((n, r) => n + Number(r.sellerDeduction || 0), 0));
  const refundedGross = money(paidRefunds.reduce((n, r) => n + Number(r.itemsAmount || 0), 0));
  const refundedFee = money(paidRefunds.reduce((n, r) => n + Number(r.commissionReversal || 0), 0));
  const refundHold = money(validRefunds
    .filter((r) => ['requested', 'approved', 'return_shipped', 'refund_pending', 'escalated'].includes(r.status))
    .reduce((n, r) => n + Number(r.sellerDeduction || 0), 0));

  // Legacy demo-paid records remain visible for audit but never count as sales.
  const realOrders = orders.filter((o) => o.paymentDemo !== true);
  const completedPaid = realOrders.filter((o) => o.status === 'received' && orderPaymentMethod(o) !== 'cash' && o.paymentStatus === 'paid');
  const completedCod = realOrders.filter((o) => o.status === 'received' && orderPaymentMethod(o) === 'cash');
  const completedSettled = [...completedPaid, ...completedCod];
  const active = realOrders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status));
  const nonCancelled = realOrders.filter((o) => o.status !== 'cancelled');
  const unpaid = nonCancelled.filter((o) => orderPaymentMethod(o) !== 'cash' && !['paid', 'not_required'].includes(String(o.paymentStatus || 'pending').toLowerCase()));
  const paidOnline = nonCancelled.filter((o) => orderPaymentMethod(o) !== 'cash' && o.paymentStatus === 'paid');
  const codOrders = nonCancelled.filter((o) => orderPaymentMethod(o) === 'cash');
  const earned = money(completedSettled.reduce((n, o) => n + Number(o.sellerNet || 0), 0) - refundedNet);
  const inProgress = money(active.reduce((n, o) => n + Number(o.sellerNet || 0), 0));
  const committed = money(payouts
    .filter((p) => p.status === 'requested' || p.status === 'paid')
    .reduce((n, p) => n + Number(p.amount || 0), 0));
  const paidOut = money(payouts.filter((p) => p.status === 'paid').reduce((n, p) => n + Number(p.amount || 0), 0));
  const gross = money(completedSettled.reduce((n, o) => n + Number(o.subtotal || 0) - Number(o.discount || 0), 0) - refundedGross);
  const commission = money(completedSettled.reduce((n, o) => n + Number(o.commission || 0), 0) - refundedFee);

  return {
    earned,
    inProgress,
    paidOut,
    available: money(Math.max(0, earned - committed - refundHold)),
    refundedNet,
    refundHold,
    pendingPayout: money(payouts.filter((p) => p.status === 'requested').reduce((n, p) => n + Number(p.amount || 0), 0)),
    gross,
    commission,
    orderValue: money(nonCancelled.reduce((n, o) => n + Number(o.sellerNet || 0), 0)),
    grossOrderValue: money(nonCancelled.reduce((n, o) => n + Number(o.subtotal || 0) - Number(o.discount || 0), 0)),
    pendingPayment: money(unpaid.reduce((n, o) => n + Number(o.sellerNet || 0), 0)),
    pendingPaymentOrders: unpaid.length,
    paidOnlineOrders: paidOnline.length,
    codOrders: codOrders.length,
    completedPaidOrders: completedPaid.length,
    completedCodOrders: completedCod.length,
    completedSettledOrders: completedSettled.length,
    activeOrders: active.length,
    totalOrders: nonCancelled.length
  };
}
