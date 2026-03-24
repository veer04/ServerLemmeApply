const fallbackUserId = '64f1c2a3b4d5e6f708091011'

export const authPlaceholder = (request, _response, next) => {
  const headerUserId = request.headers['x-user-id']
  const bodyUserId = request.body?.userId
  const paramUserId = request.params?.userId

  request.user = {
    userId: String(headerUserId || bodyUserId || paramUserId || fallbackUserId).trim(),
  }

  next()
}
