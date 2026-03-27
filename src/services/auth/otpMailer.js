import nodemailer from 'nodemailer'
import { env } from '../../config/environment.js'

let cachedTransporter = null

const hasSmtpConfig = () => {
  return Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPass)
}

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter

  if (hasSmtpConfig()) {
    cachedTransporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    })
    return cachedTransporter
  }

  // Development-safe fallback when SMTP env vars are not provided.
  cachedTransporter = nodemailer.createTransport({
    jsonTransport: true,
  })
  return cachedTransporter
}

export const sendOtpEmail = async ({ name, email, otpCode, expiresInMinutes }) => {
  const transporter = getTransporter()
  const senderAddress = env.smtpFrom || env.smtpUser || 'no-reply@aaply.ai'
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

  await transporter.sendMail({
    from: senderAddress,
    to: email,
    subject,
    text,
    html,
  })

  if (!hasSmtpConfig() && env.nodeEnv !== 'production') {
    // eslint-disable-next-line no-console
    console.log(`[auth] OTP for ${email}: ${otpCode}`)
  }
}
