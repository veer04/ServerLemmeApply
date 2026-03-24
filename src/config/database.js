import mongoose from 'mongoose'
import { env } from './environment.js'

export const connectDatabase = async () => {
  await mongoose.connect(env.mongoDbUri)
}
