import { db, httpError } from '../runtime.js';
import { byNewest, DEFAULT_NOTIFY_PREFS, needDb, NOTIFY_TYPES, requireUser, shapeAll, stamp, text } from '../lib.js';

export default function registerAccountRoutes(app) {
  app.get('/api/me', requireUser, (req, res) => res.json({ profile: { uid: req.identity.uid, email: req.identity.email, name: req.identity.name, role: req.identity.role, status: req.identity.status, phone: req.identity.profile.phone || '', area: req.identity.profile.area || '', address: req.identity.profile.address || '', storeName: req.identity.profile.storeName || '', bio: req.identity.profile.bio || '', showContactOnListings: req.identity.profile.showContactOnListings === true, payout: req.identity.profile.payout || null } }));

  app.patch('/api/me', requireUser, async (req, res, next) => {
    try {
      needDb();
      const b = req.body || {};
      const name = text(b.name, 80);
      if (name.length < 2) throw httpError(400, 'Enter your full name.');
      const phone = text(b.phone, 20).replace(/[\s-]/g, '');
      if (phone && !/^\+?\d{10,15}$/.test(phone)) throw httpError(400, 'Enter a valid phone number.');
      const update = { name, phone, area: text(b.area, 80), address: text(b.address, 300), updatedAt: stamp() };
      if (['seller', 'seller_pending', 'admin'].includes(req.identity.role)) {
        update.storeName = text(b.storeName, 80);
        update.bio = text(b.bio, 500);
        update.showContactOnListings = b.showContactOnListings === true || b.showContactOnListings === 'on' || b.showContactOnListings === 'true';
      }
      await db.collection('users').doc(req.identity.uid).set(update, { merge: true });
      const fresh = (await db.collection('users').doc(req.identity.uid).get()).data();
      const { createdAt, updatedAt, notifyPrefs, ...safe } = fresh;
      res.json({ message: 'Profile saved.', profile: { ...safe, uid: req.identity.uid } });
    } catch (error) { next(error); }
  });

  // ---- notifications ---------------------------------------------------------------------------
  const mine = async (uid) => shapeAll(await db.collection('notifications').where('userId', '==', uid).get()).sort(byNewest);

  app.get('/api/notifications', requireUser, async (req, res, next) => {
    try {
      needDb();
      const all = await mine(req.identity.uid);
      const counts = {}; all.forEach((n) => { counts[n.type || 'account'] = (counts[n.type || 'account'] || 0) + 1; });
      let list = all;
      if (req.query.type && NOTIFY_TYPES.includes(req.query.type)) list = list.filter((n) => (n.type || 'account') === req.query.type);
      if (req.query.unread === 'true') list = list.filter((n) => !n.read);
      const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 30, 1), 100);
      res.json({ items: list.slice(0, limit).map((n) => ({ ...n, type: n.type || 'account' })), total: list.length, unread: all.filter((n) => !n.read).length, counts });
    } catch (error) { next(error); }
  });

  const setRead = (value) => async (req, res, next) => {
    try {
      needDb();
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
      const list = (await mine(req.identity.uid)).filter((n) => n.read !== value && (!ids || ids.includes(n.id)));
      await Promise.all(list.map((n) => db.collection('notifications').doc(n.id).update({ read: value })));
      res.json({ message: 'Notifications updated.', changed: list.length });
    } catch (error) { next(error); }
  };
  app.post('/api/notifications/read', requireUser, setRead(true));
  app.post('/api/notifications/unread', requireUser, setRead(false));

  app.delete('/api/notifications/:id', requireUser, async (req, res, next) => {
    try {
      needDb();
      const ref = db.collection('notifications').doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists || snap.data().userId !== req.identity.uid) throw httpError(404, 'Notification not found.');
      await ref.delete();
      res.json({ message: 'Notification removed.' });
    } catch (error) { next(error); }
  });
  // Clear everything, or only the ones already read (?read=true)
  app.delete('/api/notifications', requireUser, async (req, res, next) => {
    try {
      needDb();
      const list = (await mine(req.identity.uid)).filter((n) => req.query.read !== 'true' || n.read);
      await Promise.all(list.map((n) => db.collection('notifications').doc(n.id).delete()));
      res.json({ message: `Removed ${list.length} notification${list.length === 1 ? '' : 's'}.`, removed: list.length });
    } catch (error) { next(error); }
  });

  // ---- notification settings ------------------------------------------------------------------
  app.get('/api/me/notification-settings', requireUser, (req, res) => res.json({ settings: { ...DEFAULT_NOTIFY_PREFS, ...(req.identity.profile.notifyPrefs || {}) } }));
  app.put('/api/me/notification-settings', requireUser, async (req, res, next) => {
    try {
      needDb();
      const body = req.body || {};
      const settings = Object.fromEntries(Object.keys(DEFAULT_NOTIFY_PREFS).map((k) => [k, body[k] !== false]));
      await db.collection('users').doc(req.identity.uid).set({ notifyPrefs: settings }, { merge: true });
      res.json({ message: 'Notification settings saved.', settings });
    } catch (error) { next(error); }
  });
}