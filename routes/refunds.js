import { admin, db, httpError } from '../runtime.js';
import { apiOrigin, needDb, notify, notifyAdmins, plain, relativeImage, requireAdminUser, requireSellerArea, requireUser, shape, shapeAll, stamp, text, money } from '../lib.js';
import {
  TRANSITIONS, ACTIVE, ESCALATION_DAYS, MAX_EVIDENCE, REASONS, RETURN_SHIP_DAYS, SELLER_RESPONSE_DAYS, STATUS_LABEL, calculateRefund, canMove, checkEligibility, kindFor, reasonList, remainingByItem,
} from '../refund-policy.js';

const DAY = 86400000;
const iso = (days) => new Date(Date.now() + days * DAY).toISOString();
const taka = (n) => `৳${Number(n || 0).toLocaleString('en-BD')}`;
const METHODS = ['bkash', 'nagad', 'bank'];
const ledger = (req, action, refund, detail = '') => db.collection('auditLog').add({ adminId: req.identity.uid, adminName: req.identity.name, action, target: text(refund.refundNumber, 120), detail: text(detail, 200), createdAt: stamp() }).catch(() => {});

const roleOf = (refund, identity) => (identity.role === 'admin' ? 'admin' : refund.customerId === identity.uid ? 'customer' : refund.sellerId === identity.uid ? 'seller' : null);


function actionsFor(refund, role) {
  const out = [];
  const can = (to) => canMove(refund.status, to, role);
  if (role === 'customer') {
    if (can('cancelled')) out.push('cancel');
    if (can('return_shipped')) out.push('ship');
    if (can('escalated') && !refund.final && refund.escalateUntil && Date.parse(refund.escalateUntil) > Date.now()) out.push('escalate');
  } else if (role === 'seller') {
    if (refund.status === 'requested' && (can('approved') || can('refund_pending'))) out.push('approve');
    if (can('rejected')) out.push(refund.status === 'return_shipped' ? 'reject_return' : 'reject');
    if (refund.status === 'return_shipped' && can('refund_pending')) out.push('received');
  } else if (role === 'admin') {
    if (['requested', 'escalated', 'rejected'].includes(refund.status) && (can('approved') || can('refund_pending'))) out.push('approve');
    if (can('rejected')) out.push('reject');
    if (refund.status === 'return_shipped') out.push('received');
    if (refund.status === 'refund_pending') out.push('process');
  }
  if (refund.status !== 'cancelled') out.push('message');
  return out;
}

const abs = (req, url) => (typeof url === 'string' && url.startsWith('/api/images/') ? apiOrigin(req) + url : url);
const present = (req, refund, role) => ({
  ...refund,
  statusLabel: STATUS_LABEL[refund.status] || refund.status,
  items: (refund.items || []).map((i) => ({ ...i, image: abs(req, i.image) })),
  evidence: (refund.evidence || []).map((u) => abs(req, u)),
  role, actions: role ? actionsFor(refund, role) : [],
});
const list = async (req, field, value, role) => {
  needDb();
  const snap = field ? await db.collection('refunds').where(field, '==', value).get() : await db.collection('refunds').get();
  return shapeAll(snap).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 500).map((r) => present(req, r, role));
};

// Moves a refund to a new status inside one transaction (checks who may do it, writes history, keeps the order in sync).
async function transition(req, id, to, { prepare, build, noteRequired = 0 } = {}) {
  needDb();
  const { identity } = req;
  const ref = db.collection('refunds').doc(String(id));
  const note = text(req.body?.note, 400);
  if (noteRequired && note.length < noteRequired) throw httpError(400, 'Please write a short explanation (at least a few words).');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, 'Refund request not found.');
    const refund = plain(snap.data()); refund.id = snap.id;
    const role = roleOf(refund, identity);
    if (!role) throw httpError(403, 'You cannot change this refund request.');
    if (!Object.values(TRANSITIONS).some((t) => t[role]?.includes(to))) throw httpError(403, 'You do not have permission to do that on this request.');
    if (!canMove(refund.status, to, role)) throw httpError(409, `A request that is “${STATUS_LABEL[refund.status] || refund.status}” cannot be changed that way.`);
    const orderRef = db.collection('orders').doc(refund.orderId);
    const orderSnap = await tx.get(orderRef);
    const order = orderSnap.exists ? plain(orderSnap.data()) : {};
    const ctx = prepare ? await prepare(tx, refund, order, role) : null;
    const { patch = {}, orderPatch = {} } = (build ? await build(refund, order, ctx, role, tx) : {}) || {};
    const entry = { status: to, at: new Date().toISOString(), by: identity.name, byRole: role, note };
    tx.update(ref, { status: to, history: [...(refund.history || []), entry], updatedAt: stamp(), ...patch });
    if (orderSnap.exists && Object.keys(orderPatch).length) tx.update(orderRef, { ...orderPatch, updatedAt: stamp() });
    return { refund: { ...refund, ...patch, status: to }, order, role, note };
  });
}
const clearActive = (order) => ({ activeRefundId: '', refundStatus: Number(order.refundedAmount || 0) > 0 ? 'partial' : '' });

export default function registerRefundRoutes(app) {
  // ---------------------------------------------------------------- policy (public, so the policy page matches the server)
  app.get('/api/refunds/policy', (_req, res) => res.json({ reasons: reasonList(), sellerResponseDays: SELLER_RESPONSE_DAYS, returnShipDays: RETURN_SHIP_DAYS, escalationDays: ESCALATION_DAYS, maxEvidence: MAX_EVIDENCE }));

  // ---------------------------------------------------------------- evidence photos (any signed-in customer)
  app.post('/api/refunds/evidence', requireUser, async (req, res, next) => {
    try {
      needDb();
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
      if (!match) throw httpError(400, 'Upload a JPG, PNG or WebP picture.');
      if (match[2].length > 900000) throw httpError(413, 'This picture is too large. Choose a smaller picture.');
      const ref = db.collection('productImages').doc();
      await ref.set({ mime: match[1], data: match[2], ownerId: req.identity.uid, kind: 'refund-evidence', createdAt: stamp() });
      res.status(201).json({ id: ref.id, url: `/api/images/${ref.id}` });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- what can I claim on this order?
  app.get('/api/refunds/eligibility/:orderId', requireUser, async (req, res, next) => {
    try {
      needDb();
      const orderSnap = await db.collection('orders').doc(String(req.params.orderId)).get();
      if (!orderSnap.exists || orderSnap.data().customerId !== req.identity.uid) throw httpError(404, 'Order not found.');
      const order = shape(orderSnap);
      const others = shapeAll(await db.collection('refunds').where('orderId', '==', order.id).get());
      const productSnaps = await Promise.all((order.items || []).filter((i) => !String(i.productId).startsWith('auction-')).map((i) => db.collection('products').doc(i.productId).get()));
      const categories = Object.fromEntries(productSnaps.filter((s) => s.exists).map((s) => [s.id, s.data().category || '']));
      const reasons = Object.keys(REASONS).map((code) => {
        try { const e = checkEligibility(order, others, code); return { code, label: REASONS[code].label, ok: true, deadline: e.deadline, returnRequired: REASONS[code].returnRequired, evidence: REASONS[code].evidence }; }
        catch (error) { return { code, label: REASONS[code].label, ok: false, error: error.message }; }
      });
      const defaultMethod = METHODS.includes(order.paymentMethod) ? order.paymentMethod : 'bkash';
      res.json({
        order: { id: order.id, orderNumber: order.orderNumber, status: order.status, paymentMethod: order.paymentMethod, total: order.total, deliveryFee: order.deliveryFee, discount: order.discount, source: order.source || '' },
        items: remainingByItem(order, others).map((i) => ({ ...i, image: abs(req, i.image), freshGoods: /vegetable|fruit|dairy|egg|fish|meat|livestock|pet/i.test(categories[i.productId] || '') })),
        reasons, defaultMethod, anyAllowed: reasons.some((r) => r.ok), maxEvidence: MAX_EVIDENCE,
      });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- open a request
  app.post('/api/refunds', requireUser, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req, b = req.body || {};
      const reasonCode = String(b.reason || '');
      if (!REASONS[reasonCode]) throw httpError(400, 'Choose a reason for your refund.');
      const details = text(b.details, 1000);
      if (details.length < 10) throw httpError(400, 'Please describe the problem in at least a few words (10 characters).');
      const evidence = (Array.isArray(b.evidence) ? b.evidence : []).map((u) => relativeImage(u)).filter((u) => /^\/api\/images\/[A-Za-z0-9]+$/.test(u)).slice(0, MAX_EVIDENCE);
      if (REASONS[reasonCode].evidence && !evidence.length) throw httpError(400, 'Please attach at least one photo showing the problem.');
      const method = METHODS.includes(b.refundTo?.method) ? b.refundTo.method : '';
      const account = text(b.refundTo?.account, 80);
      if (!method || account.length < 5) throw httpError(400, 'Tell us where to send your refund (bKash, Nagad or bank account).');
      const orderRef = db.collection('orders').doc(String(b.orderId || ''));
      const first = await orderRef.get();
      if (!first.exists || first.data().customerId !== identity.uid) throw httpError(404, 'Order not found.');
      const pre = await Promise.all((first.data().items || []).filter((i) => !String(i.productId).startsWith('auction-')).map((i) => db.collection('products').doc(i.productId).get()));
      const categories = Object.fromEntries(pre.filter((s) => s.exists).map((s) => [s.id, s.data().category || '']));
      const ref = db.collection('refunds').doc();
      const created = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const others = shapeAll(await tx.get(db.collection('refunds').where('orderId', '==', orderRef.id)));
        const order = { id: orderSnap.id, ...plain(orderSnap.data()) };
        checkEligibility(order, others, reasonCode);
        const calc = calculateRefund(order, remainingByItem(order, others), b.items, reasonCode, { deliveryAlreadyRefunded: others.some((r) => ['requested', 'approved', 'return_shipped', 'refund_pending', 'escalated', 'refunded'].includes(r.status) && r.deliveryRefund > 0), categories });
        const paidAndRefunded = money(Number(order.refundedAmount || 0) + calc.amount);
        if (paidAndRefunded > Number(order.total) + 0.01) throw httpError(409, 'This request would refund more than you paid.');
        const now = new Date().toISOString();
        const doc = {
          refundNumber: `RF-${ref.id.slice(0, 7).toUpperCase()}`, orderId: order.id, orderNumber: order.orderNumber,
          customerId: order.customerId, customerName: order.customerName, customerEmail: order.customerEmail, sellerId: order.sellerId, sellerName: order.sellerName,
          kind: kindFor(reasonCode), reason: reasonCode, reasonLabel: REASONS[reasonCode].label, details, evidence, ...calc, refundTo: { method, account },
          status: 'requested', sellerDeadline: iso(SELLER_RESPONSE_DAYS), final: false,
          history: [{ status: 'requested', at: now, by: identity.name, byRole: 'customer', note: details }], messages: [], createdAt: stamp(), updatedAt: stamp(),
        };
        tx.set(ref, doc);
        tx.update(orderRef, { activeRefundId: ref.id, refundStatus: 'requested', updatedAt: stamp() });
        return doc;
      });
      await notify(created.sellerId, 'Refund request received', `${created.refundNumber} · ${created.orderNumber} · ${taka(created.amount)}. Please respond within ${SELLER_RESPONSE_DAYS} days.`, 'seller-refunds', 'order');
      await notify(identity.uid, 'Refund request submitted', `${created.refundNumber} for ${taka(created.amount)} is with the seller. You will be notified of every update.`, 'refunds', 'order');
      res.status(201).json({ id: ref.id, refundNumber: created.refundNumber, amount: created.amount, message: 'Your refund request was submitted.' });
    } catch (error) { next(error); }
  });

  // ---------------------------------------------------------------- lists and detail
  app.get('/api/refunds/mine', requireUser, async (req, res, next) => { try { res.json({ items: await list(req, 'customerId', req.identity.uid, 'customer') }); } catch (e) { next(e); } });
  app.get('/api/seller/refunds', requireSellerArea, async (req, res, next) => { try { res.json({ items: await list(req, 'sellerId', req.identity.uid, 'seller') }); } catch (e) { next(e); } });
  app.get('/api/admin/refunds', requireAdminUser, async (req, res, next) => {
    try {
      const items = await list(req, null, null, 'admin');
      const sum = (f) => money(items.filter(f).reduce((n, r) => n + Number(r.amount || 0), 0));
      res.json({ items, stats: { open: items.filter((r) => ACTIVE.includes(r.status)).length, escalated: items.filter((r) => r.status === 'escalated').length, toPay: items.filter((r) => r.status === 'refund_pending').length, toPayAmount: sum((r) => r.status === 'refund_pending'), refundedAmount: sum((r) => r.status === 'refunded'), refunded: items.filter((r) => r.status === 'refunded').length } });
    } catch (e) { next(e); }
  });
  app.get('/api/refunds/:id', requireUser, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('refunds').doc(String(req.params.id)).get();
      if (!snap.exists) throw httpError(404, 'Refund request not found.');
      const refund = shape(snap), role = roleOf(refund, req.identity);
      if (!role) throw httpError(403, 'You cannot view this refund request.');
      res.json({ item: present(req, refund, role) });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- customer actions
  app.patch('/api/refunds/:id/cancel', requireUser, async (req, res, next) => {
    try {
      const r = await transition(req, req.params.id, 'cancelled', { build: (_rf, order) => ({ orderPatch: clearActive(order) }) });
      await notify(r.refund.sellerId, 'Refund request withdrawn', `${r.refund.refundNumber} was withdrawn by the customer.`, 'seller-refunds', 'order');
      res.json({ message: 'Your refund request was withdrawn.' });
    } catch (e) { next(e); }
  });
  app.patch('/api/refunds/:id/return-shipped', requireUser, async (req, res, next) => {
    try {
      const courier = text(req.body?.courier, 60), trackingNo = text(req.body?.trackingNo, 60);
      if (courier.length < 2 || trackingNo.length < 3) throw httpError(400, 'Enter the courier name and the tracking / receipt number.');
      const r = await transition(req, req.params.id, 'return_shipped', { build: () => ({ patch: { returnShipment: { courier, trackingNo, shippedAt: new Date().toISOString() } } }) });
      await notify(r.refund.sellerId, 'Return item shipped', `${r.refund.refundNumber}: ${courier}, tracking ${trackingNo}. Confirm when it arrives.`, 'seller-refunds', 'order');
      res.json({ message: 'Thanks. The seller will confirm when the item arrives.' });
    } catch (e) { next(e); }
  });
  app.patch('/api/refunds/:id/escalate', requireUser, async (req, res, next) => {
    try {
      const r = await transition(req, req.params.id, 'escalated', {
        noteRequired: 10,
        build: (rf, order) => {
          if (rf.final) throw httpError(409, 'Khamari support has already made a final decision on this request.');
          if (!rf.escalateUntil || Date.parse(rf.escalateUntil) < Date.now()) throw httpError(409, `The ${ESCALATION_DAYS}-day period to escalate this decision has ended.`);
          if (order.activeRefundId && order.activeRefundId !== rf.id) throw httpError(409, 'You have a newer request on this order, so this one can no longer be escalated.');
          return { patch: { escalatedAt: new Date().toISOString() }, orderPatch: { activeRefundId: rf.id, refundStatus: 'requested' } };
        },
      });
      await notifyAdmins('Refund escalated', `${r.refund.refundNumber} · ${r.refund.customerName} disputes the seller's decision.`, 'admin-refunds');
      await notify(r.refund.sellerId, 'Refund escalated to Khamari', `${r.refund.refundNumber} will now be reviewed by Khamari support.`, 'seller-refunds', 'order');
      res.json({ message: 'Escalated. A Khamari administrator will review your case.' });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- seller / admin decision
  app.patch('/api/refunds/:id/respond', requireUser, async (req, res, next) => {
    try {
      const action = req.body?.action;
      if (!['approve', 'reject'].includes(action)) throw httpError(400, 'Choose approve or reject.');
      const snap = await db.collection('refunds').doc(String(req.params.id)).get();
      if (!snap.exists) throw httpError(404, 'Refund request not found.');
      const rf = snap.data();
      const isAdmin = req.identity.role === 'admin';
      const skipReturn = isAdmin && Boolean(req.body?.skipReturn);
      const to = action === 'reject' ? 'rejected' : rf.kind === 'return_refund' && !skipReturn && rf.status !== 'return_shipped' ? 'approved' : 'refund_pending';
      const r = await transition(req, req.params.id, to, {
        noteRequired: action === 'reject' ? 10 : 0,
        build: (cur, order, _c, role) => {
          if (to === 'rejected') return { patch: { rejectedReason: text(req.body?.note, 400), escalateUntil: iso(ESCALATION_DAYS), final: role === 'admin' }, orderPatch: clearActive(order) };
          if (to === 'approved') return { patch: { shipBy: iso(RETURN_SHIP_DAYS), approvedBy: req.identity.name } };
          return { patch: { approvedBy: req.identity.name, approvedAt: new Date().toISOString() }, orderPatch: { activeRefundId: cur.id, refundStatus: 'requested' } };
        },
      });
      const f = r.refund;
      if (to === 'rejected') {
        await notify(f.customerId, 'Refund request declined', `${f.refundNumber}: ${r.note}${r.role === 'admin' ? ' This is a final decision by Khamari support.' : ` You can escalate this to Khamari support within ${ESCALATION_DAYS} days.`}`, 'refunds', 'order');
        if (r.role === 'admin') await notify(f.sellerId, 'Refund request declined by Khamari', `${f.refundNumber} was declined by an administrator.`, 'seller-refunds', 'order');
      } else if (to === 'approved') {
        await notify(f.customerId, 'Refund approved – please return the item', `${f.refundNumber}: ship the item back within ${RETURN_SHIP_DAYS} days and add the tracking number.`, 'refunds', 'order');
      } else {
        await notify(f.customerId, 'Refund approved', `${f.refundNumber} for ${taka(f.amount)} was approved and is being processed.`, 'refunds', 'order');
        await notifyAdmins('Refund ready to pay', `${f.refundNumber} · ${taka(f.amount)} to ${f.refundTo?.method}`, 'admin-refunds');
      }
      if (r.role === 'admin') { await ledger(req, `refund.${action}`, f, r.note); if (to !== 'rejected') await notify(f.sellerId, 'Refund approved by Khamari', `${f.refundNumber} was approved by an administrator.`, 'seller-refunds', 'order'); }
      res.json({ message: action === 'reject' ? 'Request declined.' : to === 'approved' ? 'Approved. The customer will return the item.' : 'Approved. It is now with Khamari for payment.' });
    } catch (e) { next(e); }
  });

  app.patch('/api/refunds/:id/received', requireUser, async (req, res, next) => {
    try {
      const restock = Boolean(req.body?.restock);
      const r = await transition(req, req.params.id, 'refund_pending', {
        prepare: async (tx, rf) => (restock ? Promise.all((rf.items || []).filter((i) => !String(i.productId).startsWith('auction-')).map(async (i) => { const pr = db.collection('products').doc(i.productId); return { pr, snap: await tx.get(pr), qty: i.quantity }; })) : []),
        build: (rf, _o, ctx, _role, tx) => { for (const p of ctx) if (p.snap.exists) tx.update(p.pr, { stock: Number(p.snap.data().stock || 0) + Number(p.qty) }); return { patch: { returnReceivedAt: new Date().toISOString(), restocked: restock && ctx.length > 0 } }; },
      });
      const f = r.refund;
      await notify(f.customerId, 'Return received', `${f.refundNumber}: the seller received your item. Your ${taka(f.amount)} refund is being processed.`, 'refunds', 'order');
      await notifyAdmins('Refund ready to pay', `${f.refundNumber} · ${taka(f.amount)} to ${f.refundTo?.method}`, 'admin-refunds');
      res.json({ message: 'Return confirmed. The refund is now with Khamari for payment.' });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- admin: send the money
  app.patch('/api/admin/refunds/:id/process', requireAdminUser, async (req, res, next) => {
    try {
      const method = ['bkash', 'nagad', 'bank', 'cash'].includes(req.body?.method) ? req.body.method : '';
      const reference = text(req.body?.reference, 60);
      if (!method) throw httpError(400, 'Choose how the refund was sent.');
      if (!/^[A-Za-z0-9-]{4,60}$/.test(reference)) throw httpError(400, 'Enter the transaction reference of the refund payment (4–60 letters or numbers).');
      const r = await transition(req, req.params.id, 'refunded', {
        build: (rf, order) => {
          const refundedAmount = money(Number(order.refundedAmount || 0) + Number(rf.amount));
          return { patch: { payoutMethod: method, payoutReference: reference, refundedAt: new Date().toISOString(), processedBy: req.identity.name }, orderPatch: { refundedAmount, refundStatus: refundedAmount >= Number(order.total) - 0.01 ? 'refunded' : 'partial', activeRefundId: '' } };
        },
      });
      const f = r.refund;
      await notify(f.customerId, 'Refund sent', `${f.refundNumber}: ${taka(f.amount)} was sent via ${method} (ref ${reference}).`, 'refunds', 'payment');
      if (f.sellerDeduction > 0) await notify(f.sellerId, 'Refund deducted from earnings', `${f.refundNumber}: ${taka(f.sellerDeduction)} was deducted from your earnings.`, 'seller-earnings', 'payment');
      await ledger(req, 'refund.paid', f, `${taka(f.amount)} via ${method}`);
      res.json({ message: 'Refund recorded as paid. The customer was notified.' });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- conversation thread
  app.post('/api/refunds/:id/messages', requireUser, async (req, res, next) => {
    try {
      needDb();
      const body = text(req.body?.text, 800);
      if (body.length < 2) throw httpError(400, 'Write a message first.');
      const ref = db.collection('refunds').doc(String(req.params.id));
      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, 'Refund request not found.');
        const rf = plain(snap.data()), role = roleOf(rf, req.identity);
        if (!role) throw httpError(403, 'You cannot message on this request.');
        if (rf.status === 'cancelled') throw httpError(409, 'This request was withdrawn.');
        const messages = [...(rf.messages || []), { from: role, name: req.identity.name, text: body, at: new Date().toISOString() }].slice(-100);
        tx.update(ref, { messages, updatedAt: stamp() });
        return { rf, role };
      });
      const { rf, role } = out;
      const targets = [rf.customerId, rf.sellerId].filter((u) => u && u !== req.identity.uid);
      await Promise.all(targets.map((u) => notify(u, 'New message on your refund', `${rf.refundNumber}: ${body.slice(0, 120)}`, u === rf.sellerId ? 'seller-refunds' : 'refunds', 'order')));
      if (role !== 'admin' && rf.status === 'escalated') await notifyAdmins('Message on escalated refund', `${rf.refundNumber}: ${body.slice(0, 100)}`, 'admin-refunds');
      res.status(201).json({ message: 'Message sent.' });
    } catch (e) { next(e); }
  });
}


export async function runRefundJobs() {
  if (!db) return;
  const snap = await db.collection('refunds').where('status', 'in', ['requested', 'approved']).get();
  const now = Date.now();
  for (const doc of snap.docs) {
    const rf = { id: doc.id, ...plain(doc.data()) };
    try {
      if (rf.status === 'requested' && Date.parse(rf.sellerDeadline) <= now) {
        await doc.ref.update({ status: 'escalated', escalatedAt: new Date().toISOString(), history: [...(rf.history || []), { status: 'escalated', at: new Date().toISOString(), by: 'Khamari', byRole: 'system', note: `The seller did not respond within ${SELLER_RESPONSE_DAYS} days.` }], updatedAt: stamp() });
        await notifyAdmins('Refund needs a decision', `${rf.refundNumber}: the seller did not respond in time.`, 'admin-refunds');
        await notify(rf.customerId, 'Your refund moved to Khamari support', `${rf.refundNumber}: the seller did not respond in time, so our team will decide.`, 'refunds', 'order');
        await notify(rf.sellerId, 'Refund escalated', `${rf.refundNumber} was escalated because there was no response.`, 'seller-refunds', 'order');
      } else if (rf.status === 'approved' && rf.shipBy && Date.parse(rf.shipBy) <= now) {
        const order = await db.collection('orders').doc(rf.orderId).get();
        await doc.ref.update({ status: 'cancelled', history: [...(rf.history || []), { status: 'cancelled', at: new Date().toISOString(), by: 'Khamari', byRole: 'system', note: `The item was not shipped back within ${RETURN_SHIP_DAYS} days.` }], updatedAt: stamp() });
        if (order.exists && order.data().activeRefundId === rf.id) await order.ref.update(clearActive(order.data()));
        await notify(rf.customerId, 'Refund request closed', `${rf.refundNumber}: the return was not shipped within ${RETURN_SHIP_DAYS} days.`, 'refunds', 'order');
      }
    } catch (error) { console.error('Refund job failed for', rf.id, error.message); }
  }
}