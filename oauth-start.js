// netlify/functions/oauth-start.js
const { google } = require('googleapis');

exports.handler = async (event) => {
  const clienteId = event.queryStringParameters.cliente_id;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI // es: https://tuosito.netlify.app/.netlify/functions/oauth-callback
  );

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: clienteId,
  });

  return { statusCode: 302, headers: { Location: url }, body: '' };
};
