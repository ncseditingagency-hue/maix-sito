// netlify/functions/oauth-callback.js
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const { code, state: clienteId } = event.queryStringParameters;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    await supabase
      .from('clienti')
      .update({ google_refresh_token: tokens.refresh_token })
      .eq('id', clienteId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: '<h2>✅ Calendario collegato! Torna alla dashboard.</h2>',
    };
  } catch (e) {
    return { statusCode: 500, body: 'Errore OAuth: ' + e.message };
  }
};
