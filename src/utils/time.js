export const getISTTime = (dateValue) => {
  return new Date(dateValue).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
  })
}
