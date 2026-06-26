// netlify/functions/tidydesk-ai.js
//
// Questa function riceve la lista di file dal programma TidyDesk.py
// installato sul PC del cliente, e chiede a Groq come categorizzarli.
// La chiave Groq vive SOLO qui (variabile d'ambiente sul server),
// non è mai visibile nel file scaricato dal cliente.

const GROQ_API_KEY = "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";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Lista di modelli da provare in ordine: se il primo è rifiutato/deprecato,
// si passa automaticamente al successivo, senza che l'utente se ne accorga.
const MODELS_TO_TRY = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"];

async function callGroqWithFallback(messages, maxTokens, temperature) {
  let lastError = null;
  for (const model of MODELS_TO_TRY) {
    try {
      // Timeout per singolo tentativo: se un modello è lento, lo abbandoniamo
      // e passiamo al successivo invece di consumare tutto il tempo disponibile
      // (prima un modello lento poteva far scadere il timeout lato TidyDesk
      // prima ancora che si arrivasse a provare gli altri due).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_completion_tokens: maxTokens,
          reasoning_effort: "low",
          include_reasoning: false
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return { ok: true, data, modelUsed: model };
      }

      const errText = await response.text();
      lastError = `[${model}] HTTP ${response.status}: ${errText}`;
      console.error("Tentativo fallito con", model, "-", lastError);
      // Continua al modello successivo
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? `[${model}] Timeout (oltre 9 secondi)`
        : `[${model}] Errore di rete: ${err.message}`;
      console.error(lastError);
    }
  }
  return { ok: false, error: lastError };
}

// Endpoint 1: categorizza i file (usato da TidyDesk)
// Endpoint 2 (stesso file, azione diversa): genera una risposta colloquiale
// quando TidyDesk deve fare una domanda di chiarimento o un commento naturale.
async function handleChitchat(payload, headers) {
  const { context, history } = payload;

  const systemPrompt = `Sei TidyDesk, l'assistente AI di Maix. Organizzi i file
sul computer dell'utente quando te lo chiede, ma sei anche un assistente AI
generico e utile: se l'utente fa una domanda normale o chiede aiuto con
qualcosa che non riguarda i file, rispondigli per bene come farebbe un buon
assistente, in modo completo quanto serve (non limitarti a una frase se la
domanda merita di più). Solo per i piccoli commenti di stato durante
l'organizzazione dei file resta breve e colloquiale. Rispondi sempre in
italiano, tono naturale, non robotico, non ripetitivo. Niente markdown.

Hai memoria di tutta la conversazione fatta finora con questo utente (vedi i messaggi
precedenti forniti): usala per non ripetere domande già fatte, non contraddire cose
già dette, e capire a cosa si riferisce l'utente se usa "quella cartella", "come prima", ecc.

Principi che segui sempre, senza essere pedante o elencarli all'utente:
- Non agire mai su operazioni irreversibili (spostare/rinominare molti file) senza
  che l'utente abbia confermato esplicitamente cosa vuole.
- Se non sei sicuro di qualcosa, dillo onestamente invece di inventare una risposta.
- Se un file sembra importante o delicato (es. nomi che suggeriscono documenti legali,
  contratti, backup), puoi menzionarlo con un avviso gentile invece di trattarlo come gli altri.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(history) ? history.slice(-30) : []),
    { role: "user", content: context }
  ];

  const result = await callGroqWithFallback(messages, 600, 0.7);

  if (!result.ok) {
    return { statusCode: 200, headers, body: JSON.stringify({ reply: null, debug: result.error }) };
  }

  const reply = result.data.choices?.[0]?.message?.content?.trim() || null;
  return { statusCode: 200, headers, body: JSON.stringify({ reply, modelUsed: result.modelUsed }) };
}

async function handleRename(payload, headers) {
  const { criterio, files } = payload;

  if (!Array.isArray(files) || files.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Nessun file ricevuto" }) };
  }

  const systemPrompt = `Sei un assistente che rinomina file in modo sensato e leggibile.
Ricevi un criterio dell'utente (es. "in base al contenuto", "per data", "per cliente")
e una lista di nomi di file attuali. Alcuni nomi possono includere il percorso della
sottocartella in cui si trovano (es. "Lavoro/fattura.pdf") — usalo come contesto,
ma nella risposta usa SEMPRE la chiave esatta come te l'ho data. Devi rispondere
SOLO con un oggetto JSON (nessun testo extra, nessun markdown), dove ogni chiave
è il nome ESATTO del file attuale e il valore è il nuovo nome proposto, SENZA il
percorso della sottocartella (solo il nuovo nome del file, senza estensione, la
aggiungo io dopo). Usa nomi brevi, chiari, senza spazi strani, in italiano se il
criterio è in italiano. Se per un file non hai informazioni sufficienti per
migliorare il nome, ripeti il nome originale del file (senza percorso).`;

  const userPrompt = `Criterio di rinomina: ${criterio || "rendi i nomi più leggibili"}

File attuali:
${files.map(f => `- ${f}`).join("\n")}

Rispondi solo con il JSON {"nomefile.ext": "nuovo_nome", ...}`;

  const result = await callGroqWithFallback([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ], 1500, 0.3);

  if (!result.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ renaming: null, debug: result.error }) };
  }

  let raw = result.data.choices?.[0]?.message?.content || "";
  raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

  let renaming;
  try {
    renaming = JSON.parse(raw);
  } catch (parseErr) {
    return { statusCode: 200, headers, body: JSON.stringify({ renaming: null, error: "Risposta AI malformata" }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ renaming, modelUsed: result.modelUsed }) };
}

exports.handler = async (event) => {
  // CORS: permette al programma .py locale di chiamare questa function
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Metodo non permesso" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const { instruction, files, action } = payload;

  if (action === "chitchat") {
    return handleChitchat(payload, headers);
  }

  if (action === "rename") {
    return handleRename(payload, headers);
  }

  if (!Array.isArray(files) || files.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Nessun file ricevuto" }) };
  }

  const systemPrompt = `Sei un assistente che organizza file in cartelle.
Ricevi un'istruzione dell'utente e una lista di nomi di file.
Alcuni nomi possono includere il percorso della sottocartella in cui si
trovano oggi (es. "Lavoro/fattura.pdf") — usa questa informazione come
contesto aggiuntivo, ma nella risposta usa SEMPRE la chiave esatta come
te l'ho data (con o senza percorso), senza modificarla.
Devi rispondere SOLO con un oggetto JSON (nessun testo extra, nessun markdown,
nessun blocco \`\`\`), dove ogni chiave è il nome esatto del file e il valore
è il nome della categoria/cartella in cui va spostato.
Le categorie devono essere brevi, in italiano, con la maiuscola iniziale
(es. "Immagini", "Documenti", "Fatture", "Progetti Lavoro").
Segui l'istruzione dell'utente quando indica criteri specifici
(es. per cliente, per data, per progetto). Se l'istruzione è generica,
categorizza per tipo di file.`;

  const userPrompt = `Istruzione: ${instruction || "organizza per tipo di file"}

File da categorizzare:
${files.map(f => `- ${f}`).join("\n")}

Rispondi solo con il JSON {"nomefile.ext": "Categoria", ...}`;

  const result = await callGroqWithFallback([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ], 1500, 0.2);

  if (!result.ok) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Errore nel contattare l'AI", categorization: null, debug: result.error })
    };
  }

  let raw = result.data.choices?.[0]?.message?.content || "";

  // Pulizia: a volte i modelli aggiungono ```json o testo extra
  raw = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

  let categorization;
  try {
    categorization = JSON.parse(raw);
  } catch (parseErr) {
    console.error("Risposta AI non in JSON valido:", raw);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ categorization: null, error: "Risposta AI malformata" })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ categorization, modelUsed: result.modelUsed })
  };
};
