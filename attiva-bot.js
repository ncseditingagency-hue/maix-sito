// netlify/functions/attiva-bot.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  try {
    const { auth_user_id } = JSON.parse(event.body);
    if (!auth_user_id) return { statusCode: 400, body: JSON.stringify({ error: 'auth_user_id mancante' }) };
    await supabase.from('maix_users').update({ bookeasy_attivo: true }).eq('auth_user_id', auth_user_id);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Richiesta non valida' }) };
  }
};
