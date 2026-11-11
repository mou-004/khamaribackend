// The order and these critical in-app notifications must commit together.
// Optional email delivery happens after the successful database transaction.
export function orderNotificationRows(created = [], identity = {}, userDocs = []) {
  if (!created.length) return [];
  const total = created.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const rows = created.map((order) => ({
    userId: order.sellerId,
    type: 'order',
    title: 'New customer order received',
    body: `${order.orderNumber} · ${order.itemsCount} item(s) · ${String(order.paymentMethod).toUpperCase()} · Seller amount ৳${order.sellerNet} · Payment ${order.paymentStatus}.`,
    link: 'seller-orders'
  }));
  rows.push({
    userId: identity.uid,
    type: 'order', title: 'Order placed',
    body: `${created[0].orderNumber}${created.length > 1 ? ` and ${created.length - 1} more` : ''} · ৳${total} · ${String(created[0].paymentMethod).toUpperCase()} payment ${created[0].paymentStatus}.`,
    link: 'orders'
  });
  const adminIds = new Set();
  const adminBody = `${identity.name} placed ${created.length} seller order(s): ${created.map((o) => o.orderNumber).join(', ')} · Total ৳${total}.`;
  for (const doc of userDocs) {
    const role = String(doc.data()?.role || '');
    if (['admin', 'superAdmin', 'super-admin'].includes(role) && !adminIds.has(doc.id)) {
      adminIds.add(doc.id);
      rows.push({ userId: doc.id, type: 'order', title: 'New customer order', body: adminBody, link: 'admin-orders' });
    }
  }
  return rows.filter((row) => row.userId);
}
