export const notFoundHandler = (_request, response) => {
  response.status(404).json({
    message: 'Route not found.',
  })
}
