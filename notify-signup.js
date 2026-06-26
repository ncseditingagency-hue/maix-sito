// netlify/functions/notify-signup.js
//
// Chiamata dal browser dopo il primo login di un nuovo utente.
// Manda un messaggio Telegram al proprietario di Maix (fp), e nient'altro.
// Il token del bot resta SOLO qui, lato server, mai esposto al browser.

// ⚠️ SOSTITUISCI questi due valori con quelli che ti ha dato @BotFather
// e quelli ottenuti da getUpdates (vedi guida).
const TELEGRAM_BOT_TOKEN = "8951388037:AAFdkymaTYiOJonJu7042ae2G06AW7UCiNU";
const TELEGRAM_CHAT_ID = "5843214375";

exports.handler = async (event) => {
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

  const { email, fullName } = payload;
  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Email mancante" }) };
  }

  const text = `🎉 *Nuova registrazione su Maix!*\n\n👤 ${fullName || "Nome non disponibile"}\n📧 ${email}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Errore Telegram:", errText);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: errText }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Errore notify-signup:", err);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
