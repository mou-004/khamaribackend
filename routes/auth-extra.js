import {admin,db,mailer,httpError,verifyFirebaseRequest,timingSafeEqual,randomInt,otpDigest} from '../runtime.js';
export default function registerAuthExtra(app) {
  const adminRegistrationAttempts = new Map();
  // Admin registration: validate the shared Admin Code first, then require
  // email OTP. A successfully verified Admin becomes active immediately;
  // there is no Super Admin approval or pending-admin stage.
  app.post('/api/auth/admin/register', async (req, res, next) => {
    try {
      const attemptTime = Date.now();
      const attempt = adminRegistrationAttempts.get(req.ip) || { count: 0, until: attemptTime + 15 * 60 * 1000 };
      if (attempt.until <= attemptTime) { attempt.count = 0; attempt.until = attemptTime + 15 * 60 * 1000; }
      if (attempt.count >= 10) throw httpError(429, 'Too many Admin Code attempts. Try again in 15 minutes.');
      attempt.count += 1;
      adminRegistrationAttempts.set(req.ip, attempt);

      const decoded = await verifyFirebaseRequest(req);
      const configuredCode = String(process.env.ADMIN_REGISTRATION_CODE || '').trim();
      const suppliedCode = String(req.body?.adminCode || '');
      const expected = Buffer.from(configuredCode);
      const received = Buffer.from(suppliedCode);
      if (!configuredCode) {
        throw httpError(503, 'Admin registration is disabled until the site owner configures ADMIN_REGISTRATION_CODE.');
      }
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        throw httpError(403, 'The Admin Code is incorrect.');
      }

      const email = String(decoded.email || '').trim().toLowerCase();
      if (!email) throw httpError(400, 'A valid email address is required.');
      if (decoded.email_verified) throw httpError(400, 'This email is already verified. Please sign in.');
      if (!mailer) throw httpError(503, 'Email OTP is not configured. Check SMTP settings.');

      const challengeRef = db.collection('emailOtpChallenges').doc(decoded.uid);
      const previousSnap = await challengeRef.get();
      const previous = previousSnap.exists ? previousSnap.data() : {};
      const nowMs = Date.now();
      const lastSentAt = previous.lastSentAt?.toDate?.().getTime?.() || 0;
      if (nowMs - lastSentAt < 60000) throw httpError(429, 'Please wait before requesting another verification code.');

      const code = String(randomInt(100000, 1000000));
      const name = String(req.body?.name || decoded.name || email.split('@')[0]).trim().slice(0, 100);
      await challengeRef.set({
        uid: decoded.uid,
        email,
        name,
        requestedRole: 'admin',
        otpHash: otpDigest(decoded.uid, code),
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + 10 * 60 * 1000),
        lastSentAt: admin.firestore.Timestamp.fromMillis(nowMs),
        attempts: 0
      });

      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM,
          to: email,
          subject: 'Your Khamari administrator verification code',
          text: `Your Khamari Admin verification code is ${code}. It expires in 10 minutes.`,
          html: `<div style="font-family:Arial,sans-serif;padding:24px"><h2>Verify your Khamari Admin account</h2><p>Your verification code is:</p><h1>${code}</h1><p>It expires in 10 minutes.</p></div>`
        });
      } catch (error) {
        await challengeRef.delete().catch(() => {});
        throw httpError(502, 'Admin verification email could not be sent. Check the server SMTP configuration.');
      }

      adminRegistrationAttempts.delete(req.ip);
      return res.status(200).json({ message: 'Admin verification code sent to your email. Enter it to activate your Admin account.' });
    } catch (e) { next(e); }
  });

  app.get('/api/auth/profile',async(req,res,next)=>{
    try {
      const decoded=await verifyFirebaseRequest(req); const user=await admin.auth().getUser(decoded.uid);
      if(!user.emailVerified)return res.json({profile:null});
      const snap=await db.collection('users').doc(decoded.uid).get();
      if(!snap.exists)return res.json({profile:null});
      const profile=snap.data();
      const role=['admin','superAdmin','super-admin'].includes(profile.role)?'admin':profile.role;
      res.json({profile:{...profile,uid:decoded.uid,email:user.email,role}});
    }catch(e){next(e);}
  });
  // Bound per-IP and per-address counters, suitable for the single-process server.
  const attempts=new Map();
  app.post('/api/auth/password-reset',async(req,res,next)=>{
    try {
      if(!db)throw httpError(503,'Firebase Admin is not configured.');
      if(!mailer)return res.status(503).json({code:'SMTP_NOT_CONFIGURED',error:'SMTP is not configured. Firebase email delivery will be used.'});
      const email=String(req.body?.email||'').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw httpError(400,'Enter a valid email address.');
      const now=Date.now();for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
      for(const key of [`ip:${req.ip}`,`email:${email}`]){const a=attempts.get(key)||{count:0,until:now+15*60000};if(a.count>=5)throw httpError(429,'Too many reset requests. Try again in 15 minutes.');a.count++;attempts.set(key,a);}
      let link;
      try {link=await admin.auth().generatePasswordResetLink(email);}catch(e){if(e.code!=='auth/user-not-found')throw e;}
      if(link){try {await mailer.sendMail({from:process.env.SMTP_FROM,to:email,subject:'Reset your Khamari password',text:`Use this secure Firebase link to choose a new password:\n\n${link}\n\nIf you did not request this, ignore this email.`});}catch{throw httpError(502,'Password reset email could not be sent. Check the server SMTP configuration.');}}
      res.json({message:'If an account exists, password reset instructions have been sent.'});
    }catch(e){next(e);}
  });
}
