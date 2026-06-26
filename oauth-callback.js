// netlify/functions/oauth-callback.js
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function pagina(titolo, messaggio, mostraTornaBtn = true) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<html><body style="font-family:-apple-system,sans-serif; text-align:center; padding-top:80px; background:#f6f5fb;">
      <h2>${titolo}</h2>
      <p style="color:#5a5a66;">${messaggio}</p>
      ${mostraTornaBtn ? `<a href="dashboard.html" style="display:inline-block; margin-top:16px; padding:12px 24px; border-radius:20px; background:linear-gradient(135deg,#4fd8ff,#9a7bff); color:#fff; text-decoration:none; font-weight:600;">Torna alla dashboard →</a>` : ''}
      <script>setTimeout(() => { window.location.href = 'dashboard.html'; }, 2500);</script>
    </body></html>`,
  };
}

exports.handler = async (event) => {
  const { code, state: authUserId, error: oauthError } = event.queryStringParameters;

  // L'utente ha cliccato "Annulla" su Google invece di "Consenti"
  if (oauthError) {
    return pagina('⚠️ Collegamento annullato', 'Hai annullato l\'accesso al Calendar. Puoi riprovare quando vuoi dalla dashboard.');
  }

  if (!code || !authUserId) {
    return pagina('⚠️ Richiesta non valida', 'Manca qualche informazione, riprova dalla dashboard.');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return pagina('⚠️ Permesso incompleto', 'Google non ha fornito l\'accesso permanente. Riprova dalla dashboard (a volte serve revocare l\'accesso precedente dalle impostazioni Google e riprovare).');
    }

    await supabase.from('maix_users').update({ google_refresh_token: tokens.refresh_token }).eq('auth_user_id', authUserId);
    return pagina('✅ Calendario collegato!', 'Ti riportiamo alla dashboard in automatico...');
  } catch (e) {
    console.error('Errore OAuth callback:', e);
    return pagina('⚠️ Qualcosa è andato storto', 'Non sono riuscito a completare il collegamento. Riprova dalla dashboard.');
  }
};
