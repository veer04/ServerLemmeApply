import { env } from '../../config/environment.js'
import { hasSendgridConfig, sendgridClient } from '../../config/sendgrid.js'

export const sendEmail = async ({ to, subject, text, html }) => {
  if (!hasSendgridConfig()) {
    const error = new Error(
      'SendGrid is not configured. Set SENDGRID_API_KEY and EMAIL_FROM in server/.env.',
    )
    error.statusCode = 503
    throw error
  }

  try {
    const [sendgridResponse] = await sendgridClient.send({
      to,
      from: env.emailFrom,
      subject,
      text,
      html,
    })

    return {
      statusCode: Number(sendgridResponse?.statusCode || 0),
      messageId: String(
        sendgridResponse?.headers?.['x-message-id'] || sendgridResponse?.headers?.['X-Message-Id'] || '',
      ).trim(),
    }
  } catch (error) {
    const providerMessage = Array.isArray(error?.response?.body?.errors)
      ? error.response.body.errors
          .map((entry) => String(entry?.message || '').trim())
          .filter(Boolean)
          .join('; ')
      : ''
    const wrappedError = new Error(
      providerMessage
        ? `SendGrid rejected email: ${providerMessage}`
        : error?.message || 'SendGrid email request failed.',
    )
    wrappedError.statusCode = Number(error?.code) >= 400 ? Number(error.code) : 502
    throw wrappedError
  }
}
