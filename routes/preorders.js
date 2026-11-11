import { db, httpError } from '../runtime.js';
import { needDb, requireUser, requireAdminUser, shapeAll, stamp, text, toNum } from '../lib.js';

const STATUSES = ['requested', 'confirmed', 'ready', 'completed', 'cancelled'];
const cleanPhone = (value) => text(value, 20).replace(/[\s-]/g, '');

export default function registerPreOrderRoutes(app) {
  app.post('/api/preorders', requireUser, async (req, res, next) => {
    try {
      needDb();
      const { identity } = req;
      const body = req.body || {};
      const recipient = body.recipient || {};
      const name = text(recipient.name || identity.name, 80);
      const phone = cleanPhone(recipient.phone);
      const address = text(recipient.address, 300);
      const area = text(recipient.area, 80);
      const quantity = Math.floor(toNum(body.quantity, 1));
      const note = text(body.note, 500);
      if (!name || !/^\+?\d{10,15}$/.test(phone)) throw httpError(400, 'Enter a recipient name and valid phone number.');
      if (address.length < 5) throw httpError(400, 'Enter your full delivery address.');
      if (quantity < 1 || quantity > 20) throw httpError(400, 'Choose between 1 and 20 harvest boxes.');
      const unitPrice = 520;
      const ref = db.collection('preorders').doc();
      const orderNumber = `KP-${Date.now().toString(36).toUpperCase()}`;
      const record = {
        orderNumber, customerId: identity.uid, customerName: name, customerEmail: identity.email,
        phone, address, area, quantity, note, productName: 'Winter Garden Vegetable Box',
        unit: '4–5 kg box', unitPrice, total: unitPrice * quantity,
        harvestDate: 'Harvest begins 12 November', farm: 'Green Valley Farm',
        paymentMethod: 'cash on delivery', paymentStatus: 'due on delivery',
        status: 'requested', createdAt: stamp(), updatedAt: stamp()
      };
      await ref.set(record);
      res.status(201).json({ item: { id: ref.id, ...record, createdAt: new Date().toISOString() }, message: 'Your pre-order request has been submitted.' });
    } catch (error) { next(error); }
  });

  app.get('/api/preorders/mine', requireUser, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('preorders').where('customerId', '==', req.identity.uid).get();
      res.json({ items: shapeAll(snap).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/preorders', requireAdminUser, async (_req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('preorders').get();
      res.json({ items: shapeAll(snap).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/preorders/:id/status', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      const status = text(req.body?.status, 20);
      if (!STATUSES.includes(status)) throw httpError(400, 'Choose a valid pre-order status.');
      const ref = db.collection('preorders').doc(text(req.params.id, 100));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Pre-order not found.');
      if (['completed', 'cancelled'].includes(snap.data().status)) throw httpError(409, 'This pre-order is already closed.');
      await ref.update({ status, updatedAt: stamp() });
      res.json({ message: `Pre-order ${status}.` });
    } catch (error) { next(error); }
  });
}
