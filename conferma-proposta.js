// netlify/functions/conferma-proposta.js
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let proposta_id, auth_user_id;
  try {
    const body = JSON.parse(event.body);
    proposta_id = body.proposta_id; auth_user_id = body.auth_user_id;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Richiesta non valida' }) };
  }

  const { data: proposta } = await supabase.from('eventi_proposti').select('*').eq('id', proposta_id).single();
  const { data: utente } = await supabase.from('maix_users').select('*').eq('auth_user_id', auth_user_id).single();
  if (!proposta || !utente) return { statusCode: 404, body: JSON.stringify({ error: 'Non trovato' }) };

  // Idempotenza: se è già stata confermata (doppio click, tab duplicate), non duplicare sul calendario
  if (proposta.stato === 'confermato') {
    return { statusCode: 200, body: JSON.stringify({ success: true, aggiunti: 0, gia_confermata: true }) };
  }

  if (!utente.google_refresh_token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Google Calendar non collegato' }) };
  }

  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: utente.google_refresh_token });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  let aggiunti = 0;
  const errori = [];

  for (const ev of proposta.proposta_json) {
    try {
      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: `${ev.emoji || '📅'} ${ev.titolo}`,
          description: ev.note || '',
          start: { dateTime: ev.data_inizio },
          end: { dateTime: ev.data_fine || ev.data_inizio },
        },
      });
      await supabase.from('eventi').insert({
        auth_user_id, titolo: ev.titolo, emoji: ev.emoji,
        data_inizio: ev.data_inizio, data_fine: ev.data_fine || ev.data_inizio, note: ev.note || '',
      });
      aggiunti++;
    } catch (err) {
      console.error('Errore inserimento evento singolo:', ev.titolo, err.message);
      errori.push(ev.titolo);
    }
  }

  // Segna confermata solo se almeno un evento è andato a buon fine, per evitare stato falsamente "confermato" se tutto fallisce
  if (aggiunti > 0) {
    await supabase.from('eventi_proposti').update({ stato: 'confermato' }).eq('id', proposta_id);
    await supabase.from('maix_users').update({
      tot_appuntamenti_confermati: (utente.tot_appuntamenti_confermati || 0) + aggiunti,
      bookeasy_attivo: true,
    }).eq('auth_user_id', auth_user_id);
  }

  const msgFinale = errori.length > 0
    ? `✅ Aggiunti ${aggiunti} appuntamento/i. ⚠️ Non sono riuscito ad aggiungere: ${errori.join(', ')} — riprova a scriverli di nuovo.`
    : `✅ Fatto! Ho aggiunto ${aggiunti} appuntamento/i al calendario.`;

  await supabase.from('chat_messaggi').insert({ auth_user_id, ruolo: 'assistant', tipo: 'testo', testo: msgFinale });

  return { statusCode: 200, body: JSON.stringify({ success: aggiunti > 0, aggiunti, errori }) };
};
