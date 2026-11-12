# Khamari backend email fix

## What changed
- Brevo HTTPS API is the primary email provider when `BREVO_API_KEY` and `BREVO_FROM_EMAIL` are configured.
- Existing Nodemailer SMTP configuration is retained.
- If Brevo is not configured, existing SMTP calls continue to use SMTP.
- Optional SMTP fallback after a Brevo API failure is controlled by `EMAIL_SMTP_FALLBACK=true`.
- Existing route calls to `mailer.sendMail(...)` continue to work.
- Payment OTP creation and verification logic is preserved.

## Replace files in your backend repository
1. Replace the backend root `runtime.js` with this folder's `runtime.js`.
2. Replace `backend/lib.js` with this folder's `lib.js`.
3. Replace `backend/routes/payments.js` with this folder's `routes/payments.js`.
4. Merge the `engines.node` setting into your existing `package.json` (the included file preserves the dependencies and scripts you provided).

## Render environment variables
Required for Brevo:
- `BREVO_API_KEY` = your newly generated Brevo API key
- `BREVO_FROM_EMAIL` = the sender email address verified in Brevo
- `BREVO_FROM_NAME` = Khamari

Keep existing SMTP variables if you want SMTP available as well:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

On Render Free, leave `EMAIL_SMTP_FALLBACK` unset or set it to `false`. Render's free service may not allow outbound SMTP, and waiting for an SMTP timeout after a Brevo error can delay OTP requests. Set `EMAIL_SMTP_FALLBACK=true` only on a host/network that permits SMTP.

## Important
- Never paste `BREVO_API_KEY` or SMTP passwords into source code or chat.
- The sender address must be verified in Brevo.
- Revoke any API key or SMTP password that was exposed in screenshots.
- Deploy the backend repository, not the frontend repository.

## Quick test
After deployment, check:
`https://YOUR-BACKEND.onrender.com/api/health`

Then sign in to Khamari and request an email OTP. The admin SMTP test endpoint specifically tests SMTP, not Brevo. The normal OTP/email routes use Brevo when configured.
