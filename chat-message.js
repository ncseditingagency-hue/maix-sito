// netlify/functions/chat-message.js
// Riceve: { cliente_id, testo?, media_base64?, media_mime? }
// Fa: parsing con Gemini (multimodale) -> propone evento(i) -> aspetta conferma utente

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const { cliente_id, testo, media_base64, media_mime } = JSON.parse(event.body);

  const { data: cliente } = await supabase.from('clienti').select('*').eq('id', cliente_id).single();
  if (!cliente) return { statusCode: 404, body: JSON.stringify({ error: 'Cliente non trovato' }) };

  await supabase.from('chat_messaggi').insert({
    cliente_id,
    ruolo: 'user',
    tipo: media_base64 ? (media_mime && media_mime.startsWith('audio') ? 'audio' : 'immagine') : 'testo',
    testo: testo || '[media]',
  });

  if (!cliente.google_refresh_token) {
    const risposta = '⚠️ Prima devi collegare il tuo Google Calendar dal pannello sopra.';
    await salvaRisposta(cliente_id, risposta);
    return ok({ risposta });
  }

  const result = await chiamaGemini(testo, media_base64, media_mime, cliente);

  if (result.tipo === 'chat') {
    await aggiornaRiassunto(cliente_id, cliente.riassunto_chat, testo, result.testo);
    await salvaRisposta(cliente_id, result.testo);
    return ok({ risposta: result.testo });
  }

  if (result.tipo === 'proposta') {
    const { data: proposta } = await supabase
      .from('eventi_proposti')
      .insert({ cliente_id, proposta_json: result.eventi, stato: 'in_attesa' })
      .select()
      .single();

    const recap = formattaRecap(result.eventi);
    await salvaRisposta(cliente_id, recap);
    await supabase.from('clienti').update({
      tot_appuntamenti_inviati: cliente.tot_appuntamenti_inviati + result.eventi.length,
    }).eq('id', cliente_id);

    return ok({ risposta: recap, proposta_id: proposta.id, eventi: result.eventi, richiede_conferma: true });
  }

  const fallback = '❓ Non sono riuscito a capire bene, puoi riscrivere o rimandare più chiaro?';
  await salvaRisposta(cliente_id, fallback);
  return ok({ risposta: fallback });
};

function ok(body) { return { statusCode: 200, body: JSON.stringify(body) }; }

async function salvaRisposta(cliente_id, testo) {
  await supabase.from('chat_messaggi').insert({ cliente_id, ruolo: 'assistant', tipo: 'testo', testo });
}

async function chiamaGemini(testo, mediaBase64, mediaMime, cliente) {
  const sistemaPrompt = `Sei l'assistente di BookEasy per il settore "${cliente.settore}". Tono amichevole, umano, naturale, non robotico.
Cronologia recente cliente: ${cliente.riassunto_chat || 'nessuna ancora'}.
Regole di blocco da rispettare SEMPRE: ${cliente.regole_blocco || 'nessuna'}.
Formato calendario preferito: ${cliente.formato_calendario}.

Se l'utente chiacchiera o fa domande, rispondi normalmente come chat.
Se nel messaggio (anche disordinato, anche piu' appuntamenti insieme) trovi info su appuntamenti con data riconoscibile, estraili TUTTI.

Rispondi SOLO con JSON valido, niente markdown:
{"tipo": "chat" | "proposta", "testo": "risposta conversazionale", "eventi": [{"titolo":"...","emoji":"...","data_inizio":"YYYY-MM-DDTHH:MM:SS","data_fine":"YYYY-MM-DDTHH:MM:SS","note":"..."}]}

Data odierna: ${new Date().toISOString()}`;

  const parts = [{ text: sistemaPrompt + '\n\nMessaggio utente: ' + (testo || '[vedi media allegato]') }];
  if (mediaBase64) {
    parts.push({ inline_data: { mime_type: mediaMime, data: mediaBase64 } });
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );

  const data = await resp.json();
  try {
    const raw = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '');
    return JSON.parse(raw);
  } catch {
    return { tipo: 'errore' };
  }
}

function formattaRecap(eventi) {
  let r = '✨ Ecco cosa ho capito:\n\n';
  for (const e of eventi) {
    const d = new Date(e.data_inizio).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
    r += `${e.emoji} ${e.titolo} — ${d}\n`;
  }
  r += '\nVa bene? Conferma per metterli sul calendario ✅';
  return r;
}

async function aggiornaRiassunto(cliente_id, riassuntoAttuale, msgUtente, rispostaBot) {
  const nuovo = (riassuntoAttuale ? riassuntoAttuale + ' | ' : '') + (msgUtente ? msgUtente.slice(0,80) : '');
  const tagliato = nuovo.slice(-1500);
  await supabase.from('clienti').update({ riassunto_chat: tagliato }).eq('id', cliente_id);
}

async function creaEventoCalendar(refreshToken, evento) {
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: `${evento.emoji} ${evento.titolo}`,
      description: evento.note || '',
      start: { dateTime: evento.data_inizio },
      end: { dateTime: evento.data_fine || evento.data_inizio },
    },
  });
}
