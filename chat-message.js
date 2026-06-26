// netlify/functions/chat-message.js
// Riceve: { auth_user_id, testo?, media_base64?, media_mime? }

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let auth_user_id, testo, media_base64, media_mime;
  try {
    const body = JSON.parse(event.body);
    auth_user_id = body.auth_user_id; testo = body.testo;
    media_base64 = body.media_base64; media_mime = body.media_mime;
  } catch {
    return ok({ risposta: '⚠️ Richiesta non valida, riprova.' }, 400);
  }

  if (!auth_user_id) return ok({ risposta: '⚠️ Sessione non valida, ricarica la pagina.' }, 400);

  const { data: utente } = await supabase.from('maix_users').select('*').eq('auth_user_id', auth_user_id).single();
  if (!utente) return ok({ risposta: '⚠️ Utente non trovato, accedi di nuovo a Maix.' }, 404);

  await supabase.from('chat_messaggi').insert({
    auth_user_id,
    ruolo: 'user',
    tipo: media_base64 ? (media_mime && media_mime.startsWith('audio') ? 'audio' : 'immagine') : 'testo',
    testo: testo || '[media]',
  });

  if (!utente.google_refresh_token) {
    const risposta = '⚠️ Prima devi collegare il tuo Google Calendar dal pannello sopra, poi possiamo iniziare! 📅';
    await salvaRisposta(auth_user_id, risposta);
    return ok({ risposta });
  }

  let result;
  try {
    result = await chiamaGemini(testo, media_base64, media_mime, utente);
  } catch (err) {
    console.error('Errore chiamata Gemini:', err);
    const risposta = '😅 Ho avuto un problema tecnico nel capire il messaggio. Puoi riprovare?';
    await salvaRisposta(auth_user_id, risposta);
    return ok({ risposta });
  }

  if (result.tipo === 'chat' && result.testo) {
    await aggiornaRiassunto(auth_user_id, utente.riassunto_chat, testo);
    await salvaRisposta(auth_user_id, result.testo);
    return ok({ risposta: result.testo });
  }

  if (result.tipo === 'proposta' && Array.isArray(result.eventi) && result.eventi.length > 0) {
    // Filtro di sicurezza business: scarta eventi senza data valida o nel passato
    // (un cliente vero non vuole appuntamenti fantasma o già scaduti nel calendario)
    const ora = new Date();
    const eventiValidi = result.eventi.filter(e => {
      const data = new Date(e.data_inizio);
      return e.titolo && !isNaN(data.getTime()) && data.getTime() > ora.getTime() - 3600000; // tolleranza 1h per fuso/arrotondamenti
    });

    if (eventiValidi.length === 0) {
      const risposta = '🤔 Ho capito che parli di un appuntamento, ma non sono riuscito a trovare una data/ora chiara e futura. Puoi specificarla meglio?';
      await salvaRisposta(auth_user_id, risposta);
      return ok({ risposta });
    }

    const { data: proposta } = await supabase
      .from('eventi_proposti')
      .insert({ auth_user_id, proposta_json: eventiValidi, stato: 'in_attesa' })
      .select()
      .single();

    const recap = formattaRecap(eventiValidi);
    await salvaRisposta(auth_user_id, recap);
    await supabase.from('maix_users').update({
      tot_appuntamenti_inviati: (utente.tot_appuntamenti_inviati || 0) + eventiValidi.length,
    }).eq('auth_user_id', auth_user_id);

    return ok({ risposta: recap, proposta_id: proposta.id, eventi: eventiValidi, richiede_conferma: true });
  }

  const fallback = '❓ Non sono riuscito a capire bene, puoi riscrivere o rimandare più chiaro? Anche un audio va benissimo 🎙️';
  await salvaRisposta(auth_user_id, fallback);
  return ok({ risposta: fallback });
};

function ok(body, statusCode = 200) { return { statusCode, body: JSON.stringify(body) }; }

async function salvaRisposta(auth_user_id, testo) {
  await supabase.from('chat_messaggi').insert({ auth_user_id, ruolo: 'assistant', tipo: 'testo', testo });
}

// ============ PROMPT — versione potenziata: piu' umana, intelligente, attenta al business ============
async function chiamaGemini(testo, mediaBase64, mediaMime, utente) {
  const oggi = new Date();
  const giornoSettimana = oggi.toLocaleDateString('it-IT', { weekday: 'long' });

  const sistemaPrompt = `Sei l'assistente personale di BookEasy, uno strumento che aiuta ${utente.full_name ? utente.full_name : 'il proprietario'} a gestire gli appuntamenti del suo business nel settore "${utente.settore}".

CHI SEI: Non sei un bot rigido. Sei come un assistente personale sveglio, simpatico e molto competente — capisci il contesto, fai battute leggere quando ha senso, ti accorgi di sfumature ed emozioni nel messaggio (es. se il cliente è stressato per troppi appuntamenti, lo noti e lo dici con empatia). Parli come parlerebbe una persona reale e capace, mai in modo robotico o con frasi fatte da customer service.

MEMORIA: Cronologia recente di questo cliente (riassunto): ${utente.riassunto_chat || 'è la prima volta che ci scriviamo'}.
Usa questa memoria per essere coerente: se ha già menzionato preferenze, nomi ricorrenti di clienti suoi, abitudini, usale per essere più preciso e personale.

REGOLE BUSINESS DA RISPETTARE SEMPRE (vincolanti, non derogabili):
${utente.regole_blocco || 'nessuna regola particolare impostata'}
Se un appuntamento richiesto viola queste regole, NON proporlo come evento: spiega gentilmente perché non va bene e suggerisci un'alternativa plausibile (es. un altro orario vicino).

FORMATO CALENDARIO PREFERITO da questo cliente: "${utente.formato_calendario}". Adatta titolo/note degli eventi a questo stile.

OGGI è ${giornoSettimana} ${oggi.toLocaleDateString('it-IT')}, ora ${oggi.toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'})}. Usa questo come riferimento assoluto per capire "domani", "venerdì prossimo", "stasera", ecc. Se l'utente scrive solo un giorno della settimana senza specificare quale, assumi il PROSSIMO che capita (es. se oggi è martedì e scrive "venerdì", intendi questo venerdì, non quello della settimana dopo, a meno che la data sia già passata in giornata).

COSA FARE CON IL MESSAGGIO:
- Se è solo conversazione/domande/saluti, rispondi naturalmente come faresti tu, in modo utile e con personalità (tipo="chat").
- Se contiene uno o più impegni con orario/data riconoscibile (anche scritti in modo super disordinato, anche dentro una chat copiata da un cliente, anche con errori di battitura, abbreviazioni, o gergo del settore), estrai TUTTI gli eventi distinti che trovi.
- Se il messaggio è ambiguo su data/ora (es. "ci vediamo" senza quando), NON inventare una data: chiedi chiarimento in tono="chat".
- Se due appuntamenti estratti si sovrappongono in orario, segnalalo nella risposta testuale prima del recap, così il cliente se ne accorge.
- Se riconosci un nome proprio di persona nel messaggio, includilo nel titolo dell'evento (è più utile per il cliente ritrovarlo dopo).

Rispondi SOLO con JSON valido, nessun markdown, nessun testo fuori dal JSON:
{"tipo": "chat" | "proposta", "testo": "la tua risposta naturale e umana", "eventi": [{"titolo":"...","emoji":"emoji pertinente al tipo di appuntamento","data_inizio":"YYYY-MM-DDTHH:MM:SS","data_fine":"YYYY-MM-DDTHH:MM:SS","note":"eventuali dettagli utili"}]}`;

  const parts = [{ text: sistemaPrompt + '\n\nMessaggio del cliente: ' + (testo || '[vedi media allegato: trascrivi/leggi attentamente e comportati come se fosse testo]') }];
  if (mediaBase64) parts.push({ inline_data: { mime_type: mediaMime, data: mediaBase64 } });

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] }) }
  );

  if (!resp.ok) {
    throw new Error('Gemini API ha risposto con status ' + resp.status);
  }

  const data = await resp.json();
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
    throw new Error('Risposta Gemini senza contenuto valido (possibile blocco safety o key invalida)');
  }

  const raw = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Gemini ha risposto con JSON non valido: ' + raw.slice(0, 200));
  }
}

function formattaRecap(eventi) {
  let r = eventi.length > 1 ? `✨ Ho trovato ${eventi.length} appuntamenti, eccoli:\n\n` : '✨ Ecco cosa ho capito:\n\n';
  for (const e of eventi) {
    const d = new Date(e.data_inizio).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
    r += `${e.emoji || '📅'} ${e.titolo} — ${d}\n`;
  }
  r += '\nTutto giusto? Conferma e li metto sul calendario ✅';
  return r;
}

async function aggiornaRiassunto(auth_user_id, riassuntoAttuale, msgUtente) {
  if (!msgUtente) return;
  const nuovo = (riassuntoAttuale ? riassuntoAttuale + ' | ' : '') + msgUtente.slice(0, 80);
  const tagliato = nuovo.slice(-1500);
  await supabase.from('maix_users').update({ riassunto_chat: tagliato }).eq('auth_user_id', auth_user_id);
}
