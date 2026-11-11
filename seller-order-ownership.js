// Shared seller ownership helpers for checkout and seller order retrieval.
// New product records store the same Firebase UID in sellerId and sellerUid.
// Legacy records are resolved conservatively against the authenticated seller
// directory. Names are only accepted when they uniquely identify one seller.
const PLACEHOLDER_IDS = new Set(['', 'khamari-store', 'unknown', 'undefined', 'null', 'none']);
const SELLER_ROLES = new Set(['seller', 'seller_pending', 'admin']);
const clean = (value) => String(value || '').trim();
const emailKey = (value) => clean(value).toLowerCase();
const nameKey = (value) => clean(value).toLowerCase().replace(/\s+/g, ' ');

export function isPlaceholderSellerId(value) {
  return PLACEHOLDER_IDS.has(clean(value).toLowerCase());
}

// Build lookup maps from Firebase users. Ambiguous email/name matches are
// deliberately omitted so checkout never assigns an order to the wrong seller.
export function buildSellerDirectory(users = []) {
  const accounts = users
    .map((user) => ({ ...user, id: clean(user.id || user.uid) }))
    .filter((user) => user.id && SELLER_ROLES.has(clean(user.role)));
  const byUid = new Map(accounts.map((user) => [user.id, user]));
  const emails = new Map();
  const names = new Map();

  for (const user of accounts) {
    const email = emailKey(user.email);
    if (email) emails.set(email, [...(emails.get(email) || []), user.id]);
    for (const candidate of [user.name, user.storeName]) {
      const name = nameKey(candidate);
      if (name) names.set(name, [...(names.get(name) || []), user.id]);
    }
  }

  const uniqueMap = (source) => new Map(
    [...source.entries()].filter(([, ids]) => new Set(ids).size === 1).map(([key, ids]) => [key, ids[0]])
  );
  return { byUid, byEmail: uniqueMap(emails), byName: uniqueMap(names) };
}

export function resolveProductSellerId(product = {}, directory = null) {
  const candidates = product.ownershipAssignedBy
    ? [product.sellerId, product.sellerUid, product.ownerUid, product.ownerId, product.createdByUid, product.userId]
    : [product.sellerUid, product.ownerUid, product.ownerId, product.createdByUid, product.userId, product.sellerId];
  const ids = candidates.map(clean).filter((value) => value && !isPlaceholderSellerId(value));
  const direct = ids[0];

  // Backward-compatible behavior for callers/tests without a seller directory.
  if (!directory) return direct || '';

  // Trust direct IDs only when they point to a known seller/admin account.
  if (direct && directory.byUid.has(direct)) return direct;
  // An administrator's explicit assignment is authoritative. Do not replace
  // it using weaker email/name hints.
  if (product.ownershipAssignedBy) return '';
  const knownUid = ids.find((id) => directory.byUid.has(id));
  if (knownUid) return knownUid;

  const emailCandidates = [product.sellerEmail, product.ownerEmail, product.createdByEmail, product.userEmail, product.sellerId]
    .map(emailKey).filter(Boolean);
  for (const email of emailCandidates) {
    const uid = directory.byEmail.get(email);
    if (uid) return uid;
  }

  const nameCandidates = [product.sellerName, product.storeName, String(product.farm || '').split(' · ')[0], product.sellerId]
    .map(nameKey).filter(Boolean);
  for (const name of nameCandidates) {
    const uid = directory.byName.get(name);
    if (uid) return uid;
  }

  // Unknown legacy strings (e.g. a store name saved in sellerId) are not UIDs.
  return '';
}

export function orderBelongsToSeller(order = {}, uid) {
  const sellerUid = clean(uid);
  if (!sellerUid) return false;

  const sellerId = clean(order.sellerId);
  const storedSellerUid = clean(order.sellerUid);
  if (sellerId === sellerUid || storedSellerUid === sellerUid) return true;

  // Some older checkout versions stored seller ownership only on line items.
  // Include the sub-order only when every line item points to this exact seller;
  // never expose a mixed-seller order to one seller account.
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length && items.every((item) => {
    const itemSeller = clean(item.sellerUid || item.sellerId);
    return itemSeller === sellerUid;
  })) return true;

  if (isPlaceholderSellerId(sellerId)) {
    return [order.ownerUid, order.ownerId, order.createdByUid, order.userId]
      .some((value) => clean(value) === sellerUid);
  }
  return false;
}
