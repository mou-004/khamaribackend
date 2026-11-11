import { db } from '../runtime.js';
import { sampleCategories } from '../sampleCatalog.js';
import { uniqueDepartments } from '../category-catalog.js';
import { needDb, shapeAll, stamp } from '../lib.js';

// First run only: copy the default departments into Firestore so the admin can edit them from the dashboard.
async function seedDepartments() {
  const marker = db.collection('settings').doc('categorySeed');
  if ((await marker.get()).exists) return;
  const any = await db.collection('categories').limit(1).get();
  if (any.empty) await Promise.all(sampleCategories.map((c, i) => db.collection('categories').add({ ...c, order: i + 1, status: 'active', createdAt: stamp(), updatedAt: stamp() })));
  await marker.set({ seededAt: stamp() });
}

export default function registerCategoriesRoutes(app) {
  app.get('/api/categories', async (_req, res, next) => {
    try {
      needDb();
      let snap = await db.collection('categories').where('status', '==', 'active').get();
      if (snap.empty) { await seedDepartments(); snap = await db.collection('categories').where('status', '==', 'active').get(); }
      const items = uniqueDepartments(shapeAll(snap).sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name).localeCompare(String(b.name))));
      res.json({ items, source: 'firestore' });
    } catch (error) { next(error); }
  });
}