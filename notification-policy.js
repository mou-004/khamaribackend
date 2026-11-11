// Critical marketplace events must always be written to the in-app inbox.
// User preferences control optional categories and email delivery, not order/payment records.
export const CRITICAL_NOTIFICATION_TYPES = new Set(['order', 'payment']);

export function shouldCreateInAppNotification(type, prefs = {}) {
  if (CRITICAL_NOTIFICATION_TYPES.has(String(type || 'account'))) return true;
  return type === 'account' || prefs[type] !== false;
}

export function shouldSendNotificationEmail(type, prefs = {}) {
  return CRITICAL_NOTIFICATION_TYPES.has(String(type || '')) && prefs.email !== false;
}
