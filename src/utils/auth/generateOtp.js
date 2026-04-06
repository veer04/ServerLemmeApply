import crypto from 'node:crypto'

export const generateOtpCode = () => {
  const random = crypto.randomInt(0, 1000000)
  return String(random).padStart(6, '0')
}
