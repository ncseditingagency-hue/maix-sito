// netlify/functions/get-dati.js
// GET ?email=xxx -> trova o crea il cliente Book Easy (progetto Supabase separato da login)
// poi ritorna { cliente, eventi (ultimi 10), chat, propostaInAttesa }

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const email = event.queryStringParameters.email;
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'email mancante' }) };

  // Find or create: il login vive in un progetto Supabase diverso,
  // quindi qui colleghiamo i due mondi tramite email.
  let { data: cliente } = await supabase.from('clienti').select('*').eq('email', email).single();
  if (!cliente) {
    const { data: nuovo } = await supabase.from('clienti').insert({ email }).select().single();
    cliente = nuovo;
  }

  const { data: eventi } = await supabase
    .from('eventi')
    .select('*')
    .eq('cliente_id', cliente.id)
    .order('data_inizio', { ascending: false })
    .limit(10);

  const { data: chat } = await supabase
    .from('chat_messaggi')
    .select('*')
    .eq('cliente_id', cliente.id)
    .order('created_at', { ascending: true });

  const { data: proposte } = await supabase
    .from('eventi_proposti')
    .select('*')
    .eq('cliente_id', cliente.id)
    .eq('stato', 'in_attesa')
    .order('created_at', { ascending: false })
    .limit(1);

  return {
    statusCode: 200,
    body: JSON.stringify({
      cliente,
      eventi: eventi || [],
      chat: chat || [],
      propostaInAttesa: proposte && proposte.length ? proposte[0] : null,
    }),
  };
};
