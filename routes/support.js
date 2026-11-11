import { db, httpError } from '../runtime.js';
import { needDb, requireUser, requireAdminUser, shapeAll, stamp, text, notify, notifyAdmins } from '../lib.js';

const TOPICS = ['Order or delivery', 'Seller account', 'Product', 'Auction', 'Payment', 'Other'];
const STATES = ['open', 'in_progress', 'resolved', 'closed'];

export default function registerSupportRoutes(app) {
  app.post('/api/support/tickets', requireUser, async (req, res, next) => {
    try {
      needDb();
      const topic = TOPICS.includes(req.body?.topic) ? req.body.topic : 'Other';
      const message = text(req.body?.message, 3000);
      if (message.length < 10) throw httpError(400, 'Please describe the problem in at least 10 characters.');
      const ref = db.collection('supportTickets').doc();
      const ticketNumber = `KS-${Date.now().toString(36).toUpperCase()}`;
      const record = {
        ticketNumber, userId: req.identity.uid, userName: req.identity.name, userEmail: req.identity.email,
        userRole: req.identity.role, topic, subject: text(req.body?.subject || topic, 120),
        status: 'open', messages: [{ id: `${Date.now()}-customer`, senderId: req.identity.uid, senderName: req.identity.name, senderRole: req.identity.role, body: message, createdAt: new Date().toISOString() }],
        createdAt: stamp(), updatedAt: stamp()
      };
      await ref.set(record);
      await notifyAdmins('New support request', `${req.identity.name}: ${record.subject}`, 'admin-support');
      res.status(201).json({ item: { id: ref.id, ...record, createdAt: new Date().toISOString() }, message: `Support request ${ticketNumber} submitted.` });
    } catch (error) { next(error); }
  });

  app.get('/api/support/tickets/mine', requireUser, async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('supportTickets').where('userId', '==', req.identity.uid).get();
      res.json({ items: shapeAll(snap).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/support', requireAdminUser, async (_req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('supportTickets').get();
      res.json({ items: shapeAll(snap).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/support/:id/reply', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      const body = text(req.body?.message, 3000);
      if (body.length < 2) throw httpError(400, 'Write a reply before sending.');
      const ref = db.collection('supportTickets').doc(text(req.params.id, 100));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Support request not found.');
      const ticket = snap.data();
      if (['resolved', 'closed'].includes(ticket.status)) throw httpError(409, 'This support request is closed. Reopen it before replying.');
      const message = { id: `${Date.now()}-admin`, senderId: req.identity.uid, senderName: req.identity.name, senderRole: 'admin', body, createdAt: new Date().toISOString() };
      await ref.update({ messages: [...(ticket.messages || []), message], status: 'in_progress', updatedAt: stamp(), lastReplyBy: req.identity.name });
      await notify(ticket.userId, 'Khamari Support replied', `There is a new reply to ${ticket.ticketNumber}.`, 'support', 'account');
      res.json({ message: 'Reply sent to the customer.' });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/support/:id/status', requireAdminUser, async (req, res, next) => {
    try {
      needDb();
      const status = text(req.body?.status, 20);
      if (!STATES.includes(status)) throw httpError(400, 'Choose a valid support status.');
      const ref = db.collection('supportTickets').doc(text(req.params.id, 100));
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, 'Support request not found.');
      await ref.update({ status, updatedAt: stamp() });
      await notify(snap.data().userId, 'Support request updated', `Your request ${snap.data().ticketNumber} is now ${status.replace('_', ' ')}.`, 'support', 'account');
      res.json({ message: `Support request marked ${status.replace('_', ' ')}.` });
    } catch (error) { next(error); }
  });
}
