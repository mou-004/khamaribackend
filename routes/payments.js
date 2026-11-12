
import {
  admin,
  db,
  httpError,
  mailer,
  randomInt,
  otpDigest,
  timingSafeEqual,
  smtpConfigured,
  smtpMailer,
  brevoConfigured,
  emailConfigured,
  emailStatus,
  smtpStatus
} from '../runtime.js';

import {
  requireUser,
  requireAdminUser,
  stamp,
  text,
  notify,
  notifyAdmins
} from '../lib.js';

import { checkPaymentSubmission } from '../payment-policy.js';

export default function registerPaymentRoutes(app) {

  // =====================================
  // PAYMENT CONFIGURATION
  // =====================================

  app.get('/api/payments/config', requireUser, (req, res) => {

    const accounts = Object.fromEntries(
      ['bkash', 'nagad']
        .filter(m => process.env[`PAYMENT_${m.toUpperCase()}_ACCOUNT`])
        .map(m => [
          m,
          process.env[`PAYMENT_${m.toUpperCase()}_ACCOUNT`]
        ])
    );

    res.json({
      methods: ['cash', 'bkash', 'nagad', 'card'],
      accounts,
      emailOtpMethods: ['bkash', 'nagad'],
      // Card is intentionally shown in checkout, but cannot be used until a real
      // PCI-compliant card gateway is integrated and configured.
      cardGatewayConfigured: false,
      instructions: process.env.PAYMENT_INSTRUCTIONS || ''
    });

  });


  // =====================================
  // EMAIL SERVICE STATUS
  // =====================================

  app.get('/api/payments/email-status', requireUser, (req, res) => {

    res.json({
      configured: emailConfigured,
      status: emailStatus,
      provider: brevoConfigured ? 'brevo' : (smtpConfigured ? 'smtp' : 'not-configured'),
      brevoConfigured,
      smtpConfigured,
      smtpStatus,
      senderConfigured: Boolean(process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM),
      customerEmailAvailable: Boolean(req.identity.email)
    });

  });


  // Admin-only live SMTP diagnostic: verifies the configured transport and sends a test message.
  app.post('/api/admin/payments/smtp-test', requireAdminUser, async (req, res, next) => {
    try {
      if (!smtpConfigured || !smtpMailer) {
        throw httpError(503, 'SMTP is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM to test SMTP.');
      }
      const recipient = String(req.identity.email || '').trim().toLowerCase();
      if (!recipient) throw httpError(400, 'The signed-in admin account has no email address for the SMTP test.');
      await smtpMailer.verify();
      const info = await smtpMailer.sendMail({
        from: process.env.SMTP_FROM,
        to: recipient,
        subject: 'Khamari SMTP test successful',
        text: 'Your Khamari SMTP connection is working. Customer email OTP messages can be sent through this SMTP account.'
      });
      if (!info.accepted?.length || info.rejected?.length) {
        throw httpError(502, 'SMTP connected, but the test email was not accepted by the recipient server.');
      }
      res.json({ success: true, message: `SMTP is working. A test email was sent to ${recipient.replace(/^(.{2}).*(@.*)$/, '$1***$2')}.` });
    } catch (error) {
      next(error);
    }
  });

  // =====================================
  // SEND EMAIL OTP (BREVO API PRIMARY, SMTP AVAILABLE)
  // =====================================

  app.post(
    '/api/payments/email-otp/send',
    requireUser,
    async (req, res, next) => {
      try {
        const method = String(req.body?.method || '').toLowerCase();
        if (!['bkash', 'nagad'].includes(method)) {
          throw httpError(400, 'Choose bKash or Nagad.');
        }

        if (!db) throw httpError(503, 'Firebase database is unavailable.');
        if (!mailer) throw httpError(503, 'Email service is not configured. Add BREVO_API_KEY and BREVO_FROM_EMAIL, or configure SMTP.');

        // Email OTP is an account-verification step only. It must not depend on
        // a merchant account number or payment-gateway credentials.

        const email = String(req.identity.email || '').trim().toLowerCase();
        if (!email) throw httpError(400, 'Your verified account email is required for checkout OTP.');

        const ref = db.collection('paymentEmailOtps').doc(`${req.identity.uid}_${method}`);
        const snap = await ref.get();
        const previous = snap.exists ? snap.data() : {};
        const now = Date.now();
        const last = previous.lastSentAt?.toMillis?.() || 0;

        if (now - last < 60000 && !previous.consumed && previous.expiresAt?.toMillis?.() > now) {
          res.json({
            success: true,
            method,
            alreadySent: true,
            message: `A recent OTP was already sent to ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}. Check that email or wait before requesting another code.`
          });
          return;
        }

        const code = String(randomInt(100000, 1000000));
        await ref.set({
          uid: req.identity.uid,
          email,
          method,
          otpHash: otpDigest(req.identity.uid, code),
          expiresAt: admin.firestore.Timestamp.fromMillis(now + 5 * 60 * 1000),
          lastSentAt: admin.firestore.Timestamp.fromMillis(now),
          attempts: 0,
          verifiedAt: null,
          consumed: false
        });

        try {
          const info = await mailer.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: `Khamari ${method.toUpperCase()} checkout verification OTP`,
            text: `Your Khamari checkout email verification code is ${code}. It expires in 5 minutes. This code verifies your email only; it does not make a payment. Do not share this code.`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:25px;border:1px solid #eee;border-radius:12px">
                <h2 style="color:#25804b">Khamari email verification</h2>
                <p>You selected ${method.toUpperCase()} for your order.</p>
                <p>Your email verification code is:</p>
                <h1 style="letter-spacing:10px;color:#25804b;font-size:34px">${code}</h1>
                <p>This code expires in 5 minutes.</p>
                <p><strong>This verifies your email only. It does not transfer or confirm payment.</strong></p>
                <p>Never share your OTP with anyone.</p>
              </div>
            `
          });

          if (!info.accepted?.length || info.rejected?.length) {
            throw new Error('SMTP did not accept the recipient.');
          }
        } catch (emailError) {
          await ref.delete().catch(() => {});
          console.error('Khamari OTP email error:', emailError.code, emailError.message);
          throw httpError(502, 'OTP email could not be sent. Check the Brevo API key and verified sender email. SMTP fallback is optional.');
        }

        res.json({
          success: true,
          method,
          message: `Email verification OTP sent to ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}.`
        });
      } catch (error) {
        next(error);
      }
    }
  );


  // =====================================
  // VERIFY EMAIL OTP
  // =====================================

  app.post(
    '/api/payments/email-otp/verify',
    requireUser,
    async (req, res, next) => {
      try {
        const method = String(req.body?.method || '').toLowerCase();
        const code = String(req.body?.code || '').trim();

        if (!['bkash', 'nagad'].includes(method)) {
          throw httpError(400, 'Choose bKash or Nagad.');
        }
        if (!/^\d{6}$/.test(code)) throw httpError(400, 'Enter the six-digit OTP.');
        if (!db) throw httpError(503, 'Firebase database is unavailable.');

        const ref = db.collection('paymentEmailOtps').doc(`${req.identity.uid}_${method}`);
        let verifiedData;

        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw httpError(400, 'Request a new verification OTP first.');

          const data = snap.data();
          if (data.consumed || data.method !== method || data.demoMode === true) {
            throw httpError(400, 'OTP is invalid, expired or already used. Request a new email OTP.');
          }
          if (!data.expiresAt || data.expiresAt.toMillis() < Date.now()) {
            throw httpError(400, 'OTP expired. Request a new code.');
          }
          if (Number(data.attempts || 0) >= 5) {
            throw httpError(429, 'Too many incorrect attempts. Request a new OTP.');
          }

          const expected = Buffer.from(data.otpHash || '');
          const supplied = Buffer.from(otpDigest(req.identity.uid, code));
          if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            tx.update(ref, { attempts: admin.firestore.FieldValue.increment(1) });
            verifiedData = { invalid: true };
            return;
          }

          tx.update(ref, { verifiedAt: admin.firestore.Timestamp.now() });
          verifiedData = { valid: true, method: data.method };
        });

        if (verifiedData?.invalid) throw httpError(400, 'Incorrect OTP. Please try again.');

        res.json({
          success: true,
          verified: true,
          method: verifiedData.method,
          message: 'Email verification successful. This OTP does not confirm payment.'
        });
      } catch (error) {
        next(error);
      }
    }
  );


  // =====================================
  // CUSTOMER PAYMENT REFERENCE
  // =====================================

  app.post(
    '/api/orders/:id/payment',
    requireUser,
    async (req, res, next) => {

      try {

        const reference = text(
          req.body?.reference,
          60
        );

        let submittedOrder = null;
        await db.runTransaction(async tx => {

          const orderRef = db
            .collection('orders')
            .doc(req.params.id);

          const snap = await tx.get(orderRef);

          const order = snap.exists
            ? snap.data()
            : null;

          checkPaymentSubmission(
            order,
            req.identity,
            reference
          );
          submittedOrder = { id: req.params.id, ...order };

          const receipt = db
            .collection('paymentReferences')
            .doc(
              `${order.paymentMethod}-${reference.toUpperCase()}`
            );

          const previous = await tx.get(receipt);

          if (
            previous.exists &&
            previous.data().orderId !== req.params.id
          ) {
            throw httpError(
              409,
              'This transaction reference has already been used.'
            );
          }

          if (order.paymentStatus === 'submitted') {
            throw httpError(
              409,
              'Payment is already awaiting review.'
            );
          }

          tx.set(receipt, {
            orderId: req.params.id,
            customerId: req.identity.uid,
            createdAt: stamp()
          });

          tx.update(orderRef, {
            paymentReference: reference,
            paymentStatus: 'submitted',
            paymentSubmittedAt: stamp(),
            updatedAt: stamp()
          });

        });

        // Notify the marketplace administrators and the seller that the
        // customer submitted a reference. Sellers can view the status only;
        // payment collection and verification remain with Khamari/admin.
        await notifyAdmins(
          'Customer payment submitted',
          `${submittedOrder?.orderNumber || req.params.id} · ${submittedOrder?.paymentMethod || 'mobile wallet'} · ৳${submittedOrder?.total || 0} · awaiting verification.`,
          'admin-orders',
          'payment'
        );
        const sellerUid = String(submittedOrder?.sellerUid || '').trim() || String(submittedOrder?.sellerId || '').trim();
        if (sellerUid) {
          await notify(
            sellerUid,
            'Customer payment reference submitted',
            `${submittedOrder?.orderNumber || req.params.id} · ${submittedOrder?.paymentMethod || 'mobile wallet'} · awaiting Khamari admin verification. Do not collect payment separately.`,
            'seller-orders',
            'payment'
          );
        }

        res.json({
          message:
            'Payment reference submitted. Awaiting Khamari administrator verification.'
        });

      } catch (error) {

        next(error);

      }

    }
  );


  // =====================================
  // ADMIN PAYMENT VERIFICATION
  // =====================================

  app.patch(
    '/api/admin/orders/:id/payment',
    requireAdminUser,
    async (req, res, next) => {

      try {

        const status = req.body?.status;

        if (!['paid', 'rejected'].includes(status)) {
          throw httpError(
            400,
            'Choose paid or rejected.'
          );
        }

        const ref = db
          .collection('orders')
          .doc(req.params.id);

        const order = await db.runTransaction(async tx => {

          const snap = await tx.get(ref);

          if (!snap.exists) {
            throw httpError(
              404,
              'Order not found.'
            );
          }

          const current = snap.data();

          if (
            current.paymentStatus !== 'submitted' ||
            current.status === 'cancelled'
          ) {
            throw httpError(
              409,
              'This order has no submitted payment to review.'
            );
          }

          tx.update(ref, {

            paymentStatus: status,

            paymentReviewNote: text(
              req.body?.note,
              200
            ),

            paymentReviewedBy:
              req.identity.uid,

            paymentReviewedAt: stamp(),
            paymentVerifiedAt: status === 'paid' ? stamp() : null,

            updatedAt: stamp()

          });

          return current;

        });

        await db.collection('auditLog').add({

          adminId: req.identity.uid,

          adminName: req.identity.name,

          action: `payment.${status}`,

          target: req.params.id,

          createdAt: stamp()

        });

        await notify(
          order.customerId,
          status === 'paid' ? 'Payment received' : 'Payment needs attention',
          `Payment for ${order.orderNumber}: ${status}.${status === 'rejected' && req.body?.note ? ` Note: ${text(req.body.note, 200)}` : ''}`,
          'payments',
          'payment'
        );

        // Keep the seller informed when Khamari admin verifies/rejects an
        // online payment. COD orders never enter this payment-review route.
        const itemSellerUids = [...new Set((order.items || [])
          .map((item) => String(item.sellerUid || item.sellerId || '').trim())
          .filter(Boolean))];
        const sellerUid = itemSellerUids.length === 1
          ? itemSellerUids[0]
          : String(order.sellerUid || order.sellerId || '').trim();
        if (sellerUid) {
          await notify(
            sellerUid,
            status === 'paid' ? 'Customer payment verified' : 'Customer payment rejected',
            `${order.orderNumber} · ${order.paymentMethod || 'online payment'} · ৳${order.total || 0} · ${status === 'paid' ? 'Payment verified by Khamari admin.' : `Payment was rejected.${req.body?.note ? ` Note: ${text(req.body.note, 160)}` : ''}`}`,
            'seller-orders',
            'payment'
          );
        }

        res.json({
          message: `Payment ${status}.`
        });

      } catch (error) {

        next(error);

      }

    }
  );

}
