export function checkPaymentSubmission(order, identity, reference) {
  if (!order) throw Object.assign(new Error('Order not found.'), {status: 404});
  if (order.customerId !== identity.uid) throw Object.assign(new Error('This is not your order.'), {status: 403});
  if (order.status === 'cancelled' || order.paymentStatus === 'paid') throw Object.assign(new Error('This order cannot accept another payment.'), {status: 409});
  if (!['bkash','nagad'].includes(order.paymentMethod)) throw Object.assign(new Error('This order uses cash on delivery.'), {status: 400});
  if (!/^[A-Za-z0-9-]{6,60}$/.test(reference)) throw Object.assign(new Error('Enter a valid transaction reference (6–60 letters or numbers).'), {status: 400});
}

// Use the same legacy payment aliases for display and server-side actions.
export function orderPaymentMethod(order = {}) {
  const raw = [order.paymentMethod, order.payment, order.paymentType, order.payment_method, order.selectedPaymentMethod]
    .find(value => typeof value === 'string' && value.trim());
  const key = String(raw || '').trim().toLowerCase().replace(/[ _-]+/g, ' ');
  return ({ cod: 'cash', 'cash on delivery': 'cash', 'b kash': 'bkash' })[key]
    || (['cash', 'bkash', 'nagad', 'card'].includes(key) ? key : '');
}
