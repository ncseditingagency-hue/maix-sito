// netlify/functions/conferma-proposta.js
// Riceve: { proposta_id, cliente_id }

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const { proposta_id, cliente_id } = JSON.parse(event.body);

  const { data: proposta } = await supabase.from('eventi_proposti').select('*').eq('id', proposta_id).single();
  const { data: cliente } = await supabase.from('clienti').select('*').eq('id', cliente_id).single();
  if (!proposta || !cliente) return { statusCode: 404, body: JSON.stringify({ error: 'Non trovato' }) };

  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: cliente.google_refresh_token });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  for (const ev of proposta.proposta_json) {
    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `${ev.emoji} ${ev.titolo}`,
        description: ev.note || '',
        start: { dateTime: ev.data_inizio },
        end: { dateTime: ev.data_fine || ev.data_inizio },
      },
    });
    await supabase.from('eventi').insert({
      cliente_id, titolo: ev.titolo, emoji: ev.emoji,
      data_inizio: ev.data_inizio, data_fine: ev.data_fine || ev.data_inizio, note: ev.note || '',
    });
  }

  await supabase.from('eventi_proposti').update({ stato: 'confermato' }).eq('id', proposta_id);
  await supabase.from('clienti').update({
    tot_appuntamenti_confermati: cliente.tot_appuntamenti_confermati + proposta.proposta_json.length,
    attivo: true,
  }).eq('id', cliente_id);

  await supabase.from('chat_messaggi').insert({
    cliente_id, ruolo: 'assistant', tipo: 'testo',
    testo: `✅ Fatto! Ho aggiunto ${proposta.proposta_json.length} appuntamento/i al calendario.`,
  });

  return { statusCode: 200, body: JSON.stringify({ success: true, aggiunti: proposta.proposta_json.length }) };
};
