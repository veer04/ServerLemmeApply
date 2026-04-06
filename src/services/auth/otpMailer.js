import { env } from '../../config/environment.js'
import { sendEmail } from '../../utils/auth/sendEmail.js'

export const sendOtpEmail = async ({ name, email, otpCode, expiresInMinutes }) => {
  const subject = 'Aaply verification code'
  const safeName = String(name || 'there').trim()

  const text = [
    `Hi ${safeName},`,
    '',
    `Your Aaply verification code is: ${otpCode}`,
    `This code expires in ${expiresInMinutes} minutes.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n')

  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;color:#0d1c2e;padding:16px;max-width:560px;">
      <h2 style="margin:0 0 8px;">Verify your Aaply account</h2>
      <p style="margin:0 0 12px;">Hi ${safeName},</p>
      <p style="margin:0 0 12px;">Use this code to verify your account:</p>
      <p style="margin:0 0 14px;font-size:28px;font-weight:700;letter-spacing:4px;color:#0b3d91;">${otpCode}</p>
      <p style="margin:0 0 12px;">This code expires in ${expiresInMinutes} minutes.</p>
      <p style="margin:0;color:#51607a;">If you did not request this, you can ignore this email.</p>
    </div>
  `

  const delivery = await sendEmail({
    to: email,
    subject,
    text,
    html,
  })

  if (env.nodeEnv !== 'production') {
    // eslint-disable-next-line no-console
    console.log(
      `[auth] OTP email dispatched to ${email} (status=${delivery?.statusCode || 'n/a'} messageId=${delivery?.messageId || 'n/a'})`,
    )
  }
}
