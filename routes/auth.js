import { createHash } from "node:crypto";
import {
  admin,
  randomInt,
  timingSafeEqual,
  db,
  mailer,
  otpDigest,
  safeRequestedRole,
  verifyFirebaseRequest,
  httpError
} from "../runtime.js";

export default function registerAuthRoutes(app) {

  // SEND EMAIL OTP
  app.post("/api/auth/email-otp/send", async (req, res, next) => {
    try {
      const decoded = await verifyFirebaseRequest(req);
      const email = String(decoded.email || "").trim().toLowerCase();

      if (!email || decoded.email_verified) {
        return res.status(400).json({
          error: decoded.email_verified
            ? "This email is already verified. Please sign in."
            : "The Firebase account has no email address."
        });
      }

      if (!mailer) {
        return res.status(503).json({
          error: "Email OTP is not configured. Check SMTP settings."
        });
      }

      const challengeRef = db.collection("emailOtpChallenges").doc(decoded.uid);
      const previousSnap = await challengeRef.get();
      const previous = previousSnap.exists ? previousSnap.data() : {};
      const nowMs = Date.now();

      const lastSentAt =
        previous.lastSentAt?.toDate?.().getTime?.() || 0;

      if (nowMs - lastSentAt < 60000) {
        return res.status(429).json({
          error: "Please wait before requesting another code."
        });
      }

      const code = String(randomInt(100000, 1000000));
      if (req.body?.requestedRole === 'admin') throw httpError(403, 'Use the Admin Registration page and enter the Admin Code.');
      const requestedRole = req.body?.requestedRole
        ? safeRequestedRole(req.body.requestedRole)
        : safeRequestedRole(previous.requestedRole || "customer");

      await challengeRef.set({
        uid: decoded.uid,
        email,
        name: String(
          req.body?.name ||
          previous.name ||
          decoded.name ||
          email.split("@")[0]
        ).slice(0, 100),
        requestedRole,
        otpHash: otpDigest(decoded.uid, code),
        expiresAt: admin.firestore.Timestamp.fromMillis(
          nowMs + 10 * 60 * 1000
        ),
        lastSentAt: admin.firestore.Timestamp.fromMillis(nowMs),
        attempts: 0
      });

      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM,
          to: email,
          subject: "Your Khamari verification code",
          text: `Your verification code is ${code}. It expires in 10 minutes.`,
          html: `<div style="font-family:Arial,sans-serif;padding:24px">
            <h2>Verify your Khamari account</h2>
            <p>Your verification code is:</p>
            <h1>${code}</h1>
            <p>Expires in 10 minutes.</p>
          </div>`
        });
      } catch (error) {
        await challengeRef.delete().catch(() => {});
        throw httpError(502, "Verification email could not be sent.");
      }

      return res.json({
        message: "Verification code sent to your email."
      });

    } catch (error) {
      next(error);
    }
  });

  // VERIFY EMAIL OTP
  app.post("/api/auth/email-otp/verify", async (req, res, next) => {
    try {
      const decoded = await verifyFirebaseRequest(req);
      const code = String(req.body?.code || "").trim();

      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({
          error: "Enter a valid 6-digit verification code."
        });
      }

      const challengeRef = db.collection("emailOtpChallenges").doc(decoded.uid);
      const snap = await challengeRef.get();

      if (!snap.exists) {
        return res.status(400).json({
          error: "No active verification code found."
        });
      }

      const challenge = snap.data();

      if (challenge.email !== String(decoded.email || "").toLowerCase()) {
        return res.status(403).json({
          error: "Verification code does not match this account."
        });
      }

      if (
        !challenge.expiresAt ||
        challenge.expiresAt.toMillis() <= Date.now()
      ) {
        await challengeRef.delete().catch(() => {});
        return res.status(410).json({
          error: "Verification code expired."
        });
      }

      if (Number(challenge.attempts || 0) >= 5) {
        await challengeRef.delete().catch(() => {});
        return res.status(429).json({
          error: "Too many incorrect attempts."
        });
      }

      const expected = Buffer.from(
        String(challenge.otpHash || ""), "hex"
      );
      const received = Buffer.from(
        otpDigest(decoded.uid, code), "hex"
      );

      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        await challengeRef.update({
          attempts: admin.firestore.FieldValue.increment(1)
        });
        return res.status(400).json({
          error: "Incorrect verification code."
        });
      }

      const requestedRole = safeRequestedRole(challenge.requestedRole);
      const profileRole =
        requestedRole === "seller" ? "seller_pending" :
        requestedRole === "admin" ? "admin" : "customer";

      const now = admin.firestore.FieldValue.serverTimestamp();

      await admin.auth().updateUser(decoded.uid, {
        emailVerified: true,
        displayName: challenge.name
      });
      if (requestedRole === "admin") {
        await admin.auth().setCustomUserClaims(decoded.uid, { role: "admin" });
      }

      const profile = {
        uid: decoded.uid,
        name: String(challenge.name || decoded.email.split("@")[0]).slice(0, 100),
        email: String(decoded.email).toLowerCase(),
        role: profileRole,
        status: requestedRole === "seller" ? "pending approval" : "active",
        emailVerified: true,
        createdAt: now,
        updatedAt: now
      };

      await db.collection("users").doc(decoded.uid)
        .set(profile, { merge: true });

      await challengeRef.delete();

      return res.json({
        message: "Email verified successfully.",
        profile: {
          ...profile,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        requestedRole
      });

    } catch (error) {
      next(error);
    }
  });

}
