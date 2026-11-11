// Collapse duplicate department documents for public browsing without deleting
// administrator-managed Firestore records or altering distinct product listings.
export function uniqueDepartments(rows = []) {
  const seen = new Map();
  for (const row of rows) {
    const name = String(row?.name || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase('en');
    if (!name || key === 'all products') continue;
    const subcategories = [];
    const addSubcategories = (values) => {
      for (const entry of Array.isArray(values) ? values : []) {
        const sub = String(entry || '').trim().replace(/\s+/g, ' ');
        if (sub && !subcategories.some((existing) => existing.toLocaleLowerCase('en') === sub.toLocaleLowerCase('en'))) subcategories.push(sub);
      }
    };
    if (!seen.has(key)) {
      addSubcategories(row.subcategories);
      seen.set(key, { ...row, name, subcategories });
    } else {
      const current = seen.get(key);
      // Preserve the first sorted document, adding any unique subcategories
      // from duplicate department entries so nothing disappears from navigation.
      subcategories.push(...current.subcategories);
      addSubcategories(row.subcategories);
      current.subcategories = subcategories;
    }
  }
  return [...seen.values()];
}
