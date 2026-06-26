// netlify/functions/attiva-bot.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const { cliente_id } = JSON.parse(event.body);
  await supabase.from('clienti').update({ attivo: true }).eq('id', cliente_id);
  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
