// netlify/functions/get-dati.js
// GET ?cliente_id=xxx -> { cliente, eventi (ultimi 10), chat, propostaInAttesa }

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const clienteId = event.queryStringParameters.cliente_id;

  const { data: cliente } = await supabase.from('clienti').select('*').eq('id', clienteId).single();

  const { data: eventi } = await supabase
    .from('eventi')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('data_inizio', { ascending: false })
    .limit(10);

  const { data: chat } = await supabase
    .from('chat_messaggi')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: true });

  const { data: proposte } = await supabase
    .from('eventi_proposti')
    .select('*')
    .eq('cliente_id', clienteId)
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
