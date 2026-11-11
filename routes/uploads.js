// Product pictures are stored in Firestore (collection "productImages") so no extra Firebase Storage setup is needed.
import { db } from '../runtime.js';
import { needDb, requireSeller, stamp } from '../lib.js';
import { httpError } from '../runtime.js';

export default function registerUploadRoutes(app) {
  app.post('/api/uploads/image', requireSeller, async (req, res, next) => {
    try {
      needDb();
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
      if (!match) throw httpError(400, 'Upload a JPG, PNG or WebP picture.');
      if (match[2].length > 900000) throw httpError(413, 'This picture is too large. Choose a smaller picture.');
      const ref = db.collection('productImages').doc();
      await ref.set({ mime: match[1], data: match[2], ownerId: req.identity.uid, createdAt: stamp() });
      res.status(201).json({ id: ref.id, url: `/api/images/${ref.id}` });
    } catch (error) { next(error); }
  });

  app.get('/api/images/:id', async (req, res, next) => {
    try {
      needDb();
      const snap = await db.collection('productImages').doc(String(req.params.id)).get();
      if (!snap.exists) throw httpError(404, 'Picture not found.');
      const { mime, data } = snap.data();
      res.set({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
      res.send(Buffer.from(data, 'base64'));
    } catch (error) { next(error); }
  });
}