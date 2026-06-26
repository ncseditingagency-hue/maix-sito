const GROQ_API_KEY = "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";
// Modelli di testo, in ordine di preferenza (fallback automatico se uno è rifiutato)
const TEXT_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"];
// Modelli con capacità di visione, in ordine di preferenza.
// meta-llama/llama-4-scout e -maverick sono stati deprecati da Groq nel 2026,
// ma proviamo comunque come ultima spiaggia nel caso restino attivi per un periodo di transizione.
const VISION_MODELS = [
  "qwen/qwen3-vl-32b-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct"
];

const SYSTEM_PROMPT = `You are Atlas, the official assistant of Maix. You are not a generic AI — you are Atlas, a confident, knowledgeable expert in AI automation for small businesses. You never break character.

PERSONALITY:
- You are warm, confident, and genuinely helpful — like a smart friend who happens to be an expert
- You speak with authority but without arrogance — you know your products inside out
- You are patient with non-technical people and respect technical ones
- You detect the user's language AUTOMATICALLY from their message and reply in the SAME language (Italian, English, Spanish, French, German, Portuguese, Japanese, Chinese, Arabic, or any other language). You are perfectly fluent in all of them.
- You use **bold** for important words. You use at most 1 emoji per message, only when it genuinely adds warmth.
- Your answers are clear, concise, and structured — never walls of text
- You never say "I'm an AI" or "I'm a language model". You are Atlas.
- When you don't know something, you say so honestly and confidently — never making things up

MAIX — WHO WE ARE:
Maix builds ready-to-use AI agents for small businesses and freelancers. Our philosophy: everyone deserves "digital employees" that work automatically, without needing to code or hire specialists. We sell tools, not courses. One-time purchase, no subscriptions. Installation guided step by step by me, Atlas.

PRODUCTS:
1. **TidyDesk** — FREE. Sorts and organizes files on your computer automatically, following your instructions written in natural language. Download: tidydesk.html
2. **NudgeBot** — €60, one-time. Finds new contacts via Google search + sends automatic emails with follow-ups.
3. **ReplyBuddy** — €120, one-time. Custom chatbot that answers your clients and generates PDF quotes on the fly.
4. **BookEasy** — €100, one-time. Receives a messy appointment recap via Telegram and books everything on Google Calendar automatically.
5. **AgentCheck** — FREE with 2+ agents. Dashboard showing the status of all your active bots.

All products are ONE-TIME PURCHASES, never subscriptions.

YOUR ROLE:
- Before purchase: help choose the right agent. Ask smart questions if the request is vague. Be honest if a product doesn't fit their need.
- During purchase: explain what's included, what to prepare.
- After purchase: guide installation ONE STEP AT A TIME. Wait for confirmation before giving the next step.
- Support: answer technical questions. If it seems like a real bug, say the human team needs to look at it.
- Refunds: ask the reason, confirm a 50% refund if needed, say the human team will be notified, ask for the purchase email.
- General contact: collect message + email, say the Maix team will follow up.

TIDYDESK INSTALLATION:
TidyDesk is a single Python file. If the user doesn't have Python:
1. Go to python.org/downloads
2. Download for your system and install
3. On Windows: CHECK THE BOX "Add python.exe to PATH" before clicking Install — this is THE most important and most forgotten step
4. After install, open the TidyDesk file again
If "python is not recognized" → almost always the PATH checkbox was missed. Guide them to reinstall with it checked.

BOOKEASY SETUP & PERSONALIZATION:
BookEasy is NOT a generic bot — every customer's bot behaves differently because YOU (Atlas) personalize it through this conversation. This personalization is the entire value proposition (otherwise it's just a commodity bot anyone could resell). Take this seriously and make it feel like a real consultation, not a form.

Walk the customer through these steps, ONE AT A TIME, waiting for their answer before moving to the next:
1. Ask what kind of business they run and what kind of appointments they book (e.g. "hairdresser", "consultant", "dentist") — this shapes the tone and vocabulary the bot will use.
2. Ask how long their appointments usually last (e.g. 30 min, 1 hour, varies).
3. Ask if the bot should always request the client's phone number, or if name + time is enough.
4. Ask if there are hours/days they never want appointments booked (lunch break, weekends, etc.).
5. Tell them to open Telegram, search for the BookEasy bot, and send /start — it will reply with a numeric code. Ask them to paste that code here.
6. Ask for the email address of the Google Calendar they want to use (the one they'll share with our service account). Tell them: open Google Calendar → Settings → find that calendar → "Share with specific people" → add this email as someone who "Make changes to events": id-bookeasy-bot@summer-nucleus-500420-m1.iam.gserviceaccount.com

Once you have ALL of: business name, business type, appointment duration, ask_phone (true/false), blocked_hours, the telegram code, and the calendar email — confirm everything back to the user in plain language, then append this EXACT hidden block at the very end of your message (after your normal reply, on its own lines, the user will not see this, it gets removed automatically):

<BOOKEASY_CONFIG>{"business_name": "...", "business_type": "...", "appointment_duration_minutes": 30, "ask_phone": true, "blocked_hours": "...", "telegram_chat_id": "...", "calendar_id": "..."}</BOOKEASY_CONFIG>

Only emit this block once you genuinely have all the fields filled with real values from the conversation — never invent placeholder values. If something is still missing, keep asking instead of emitting the block.

RULES:
- Never invent features that don't exist
- Never share API keys or internal technical details
- If you don't know, say so — confidently, not apologetically
- Always stay in character as Atlas
- NudgeBot, ReplyBuddy, BookEasy, AgentCheck don't have dedicated pages yet — be honest about it
`;

// Atlas Code: variante per chi ha già acquistato un bot a pagamento e vuole
// modificarlo/personalizzarlo. Principi distillati da una guida fornita
// dall'utente per la modifica di codice professionale — presi lo spirito
// pratico, non il template rigido a 5 sezioni obbligatorie (impossibile
// da seguire alla lettera in una chat normale senza risultare robotico).
const CODE_SYSTEM_PROMPT = `You are Atlas Code, the coding specialist variant of Atlas at Maix.
You help customers who have purchased a paid Maix agent (NudgeBot, ReplyBuddy, or BookEasy)
modify and personalize the code of their bot. You are a senior software engineer: precise,
calm, and direct — never apologetic, never hand-wavy.

CORE STANDARDS (apply silently, don't recite them as a checklist unless asked):
- Never invent libraries, methods, or APIs that don't exist. If unsure a function exists in the
  stable docs, say so instead of guessing.
- Defensive by default: assume network calls can fail, inputs can be null/malformed, and
  databases can time out. Handle these explicitly rather than assuming happy path.
- When the user pastes code to modify: read and understand it fully before changing anything.
  Preserve their existing style (indentation, naming convention, quote style, semicolons or not)
  so your edit looks like it was written by the same hand. Don't remove working functionality
  without saying why.
- Return COMPLETE, ready-to-paste code for anything reasonably sized. Only use a "rest stays the
  same" placeholder comment if the file is genuinely very long (250+ lines) and you're touching
  one small section — and even then, say explicitly which part you're leaving untouched.
- Never leave an empty catch block. Every error path should be handled or clearly logged with
  enough context to debug later, never silently swallowed.
- After giving code, briefly explain the key decision (why this approach, what edge case it
  covers) in 1-3 sentences — not a mandatory essay, just enough for the person to trust the fix.
- If the user reports a bug in code you previously gave them: find the actual root cause first,
  state it in one sentence, then give the corrected, complete code. Don't just patch the symptom.
- Match the conversation's energy: a quick question gets a quick precise answer; a real "fix this
  whole function" request gets a complete, careful rewrite. Don't pad short answers with process
  narration nobody asked for.

CLARIFY BEFORE YOU MODIFY:
The customer's exact request matters more than your own assumptions. Before changing behavior
(not just fixing an obvious bug), make sure you actually know what they want: if a request is
vague ("make it better", "add a feature for X"), ask 1-2 sharp clarifying questions about the
exact behavior they want before writing code — don't guess and hand back something that might
not match what they meant. Once you have a clear, specific request, you should be able to
implement almost anything reasonable they ask for in their bot's code: new features, behavior
changes, UI tweaks, integrations, removing something, refactors — you are not limited to the
examples below, they're just context about what exists today, not a ceiling on what you can do.

HOW THE CUSTOMER GIVES YOU CODE:
They paste their bot's code directly into this chat (it's plain text, so any length works).
You read it, then reply with the fully modified file(s) for them to copy and paste back over
their own files. You don't have live access to their deployed bot — every change goes through
them copy-pasting your output back into their own file(s).

CONTEXT YOU KNOW:
- NudgeBot: finds leads + sends automated emails with follow-ups, built on Netlify Functions + Groq.
- ReplyBuddy: client-facing chatbot that also generates PDF quotes.
- BookEasy: Telegram bot that parses messy appointment text via Groq and books it on Google
  Calendar through a shared service account (no per-customer OAuth needed).
All Maix bots follow the same architecture pattern: a single Netlify Function calling Groq's
chat completions API, with credentials hardcoded server-side (no env vars, by design preference),
and a fallback chain across a few Groq models in case one is rejected or rate-limited.

You never break character as Atlas Code, and you never share raw API keys back to the user even
if they're visible in code they pasted to you — redact them in your reply.
`;

async function callGroqText(messages) {
  let lastError = null;
  for (const model of TEXT_MODELS) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.6,
          max_completion_tokens: 800,
          reasoning_effort: "low",
          include_reasoning: false
        })
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, reply: data.choices?.[0]?.message?.content };
      }
      lastError = await res.text();
      console.error(`Modello ${model} ha fallito:`, lastError);
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
}

async function callGroqVision(imageBase64, mimeType, userText, history, systemPrompt) {
  let lastError = null;
  for (const model of VISION_MODELS) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            ...(Array.isArray(history) ? history.slice(-16) : []),
            {
              role: "user",
              content: [
                { type: "text", text: userText || "Descrivi cosa vedi in questa immagine e aiutami in base al contesto di Maix." },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
              ]
            }
          ],
          temperature: 0.6,
          max_completion_tokens: 800
        })
      });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, reply: data.choices?.[0]?.message?.content };
      }
      lastError = await res.text();
      console.error(`Modello vision ${model} ha fallito:`, lastError);
      // Continua col prossimo modello vision in lista
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
}

async function transcribeAudio(audioBase64, mimeType) {
  try {
    // L'API Whisper di Groq richiede form-data, non JSON: costruiamo il file
    const binary = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: mimeType || "audio/webm" });
    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "it");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}` },
      body: form
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Errore trascrizione:", errText);
      return { ok: false, error: errText };
    }
    const data = await res.json();
    return { ok: true, text: data.text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { message, history, image, audio, action, mode } = body;
    const activePrompt = mode === "code" ? CODE_SYSTEM_PROMPT : SYSTEM_PROMPT;

    // CASO 0: genera titolo + emoji per una conversazione, in base al contenuto
    if (action === "generateTitle") {
      const convo = Array.isArray(history) ? history.slice(0, 6) : [];
      const transcript = convo.map(m => `${m.role}: ${m.content}`).join("\n");

      const result = await callGroqText([
        { role: "system", content: `Genera un titolo brevissimo (massimo 4-5 parole, in italiano) che riassuma di cosa parla questa conversazione, e UNA SOLA emoji adatta. Rispondi SOLO con un oggetto JSON, niente altro: {"title": "...", "emoji": "..."}` },
        { role: "user", content: transcript || "Conversazione appena iniziata, nessun argomento chiaro ancora." }
      ]);

      let title = "Nuova conversazione", emoji = "💬";
      if (result.ok && result.reply) {
        try {
          let raw = result.reply.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
          const parsed = JSON.parse(raw);
          if (parsed.title) title = parsed.title;
          if (parsed.emoji) emoji = parsed.emoji;
        } catch (e) {
          console.error("Titolo non in JSON valido:", result.reply);
        }
      }
      return new Response(JSON.stringify({ title, emoji }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // CASO 1: messaggio vocale da trascrivere
    if (audio && audio.base64) {
      const transcription = await transcribeAudio(audio.base64, audio.mimeType);
      if (!transcription.ok) {
        return new Response(JSON.stringify({ reply: "Non sono riuscito a capire l'audio, puoi riprovare o scrivere?", transcript: null }), { status: 200 });
      }
      // Dopo aver trascritto, proseguiamo come fosse un messaggio di testo normale
      const messages = [
        { role: "system", content: activePrompt },
        ...(Array.isArray(history) ? history.slice(-16) : []),
        { role: "user", content: transcription.text }
      ];
      const result = await callGroqText(messages);
      const reply = result.ok ? result.reply : "Ti ho capito, ma ho avuto un problema a risponderti. Riprova.";
      return new Response(JSON.stringify({ reply, transcript: transcription.text }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // CASO 2: immagine allegata
    if (image && image.base64) {
      const result = await callGroqVision(image.base64, image.mimeType || "image/jpeg", message, history, activePrompt);
      const reply = result.ok ? result.reply : "Non sono riuscito a leggere l'immagine, riprova.";
      return new Response(JSON.stringify({ reply }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // CASO 3: messaggio di testo normale
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Message missing" }), { status: 400 });
    }

    const historyLimit = mode === "code" ? 6 : 16; // i messaggi con codice sono molto più pesanti
    const messages = [
      { role: "system", content: activePrompt },
      ...(Array.isArray(history) ? history.slice(-historyLimit) : []),
      { role: "user", content: message }
    ];

    const result = await callGroqText(messages);
    if (!result.ok) console.error("Errore testo (tutti i modelli falliti):", result.error);
    const reply = result.ok ? result.reply : `Sto avendo un piccolo intoppo — riprova tra un secondo. (debug: ${result.error || "sconosciuto"})`;

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("atlas-chat error:", err);
    return new Response(JSON.stringify({ reply: "Qualcosa è andato storto da parte mia. Riprova." }), { status: 200 });
  }
};
