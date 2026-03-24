export const errorHandler = (error, _request, response, _next) => {
  const statusCode = Number(error.statusCode || 500)
  const message = error.message || 'Unexpected server error.'

  response.status(statusCode).json({
    message,
  })
}
