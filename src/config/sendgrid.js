import sendgridMail from '@sendgrid/mail'
import { env } from './environment.js'

const hasApiKey = Boolean(env.sendgridApiKey)

if (hasApiKey) {
  sendgridMail.setApiKey(env.sendgridApiKey)
}

export const hasSendgridConfig = () => {
  return Boolean(env.sendgridApiKey && env.emailFrom)
}

export const sendgridClient = sendgridMail
