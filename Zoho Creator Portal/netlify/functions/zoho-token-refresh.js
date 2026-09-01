// Scheduled function: keeps the shared Zoho OAuth token (netlify/functions/lib/zoho-auth.js)
// warm in Blobs so request-path functions never need to call Zoho's OAuth
// endpoint during traffic bursts. Runs well inside the token's ~55 min cache
// window so a missed run or two doesn't matter.
const { schedule } = require('@netlify/functions');
const { refreshAndStore } = require('./lib/zoho-auth');

exports.handler = schedule('*/15 * * * *', async (event) => {
  try {
    await refreshAndStore(event);
    console.log('zoho-token-refresh: token refreshed');
  } catch (err) {
    console.error('zoho-token-refresh: failed:', err.message);
  }
  return { statusCode: 200 };
});
