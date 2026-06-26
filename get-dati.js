// netlify/functions/get-dati.js
// GET ?auth_user_id=xxx -> dati BookEasy per l'utente Maix gia' loggato

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const authUserId = event.queryStringParameters.auth_user_id;
  if (!authUserId) return { statusCode: 400, body: JSON.stringify({ error: 'auth_user_id mancante' }) };

  const { data: utente, error } = await supabase
    .from('maix_users')
    .select('*')
    .eq('auth_user_id', authUserId)
    .single();

  if (error || !utente) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Utente non trovato. Devi prima accedere su Maix.' }) };
  }

  const { data: eventi } = await supabase
    .from('eventi')
    .select('*')
    .eq('auth_user_id', authUserId)
    .order('data_inizio', { ascending: false })
    .limit(10);

  const { data: chatRaw } = await supabase
    .from('chat_messaggi')
    .select('*')
    .eq('auth_user_id', authUserId)
    .order('created_at', { ascending: false })
    .limit(40);
  const chat = (chatRaw || []).reverse(); // rimettiamo in ordine cronologico dopo aver preso solo gli ultimi 40

  const { data: proposte } = await supabase
    .from('eventi_proposti')
    .select('*')
    .eq('auth_user_id', authUserId)
    .eq('stato', 'in_attesa')
    .order('created_at', { ascending: false })
    .limit(1);

  return {
    statusCode: 200,
    body: JSON.stringify({
      cliente: utente,
      eventi: eventi || [],
      chat: chat || [],
      propostaInAttesa: proposte && proposte.length ? proposte[0] : null,
    }),
  };
};
