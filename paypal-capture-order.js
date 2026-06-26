// netlify/functions/paypal-capture-order.js
//
// Conferma che il pagamento sia stato davvero completato (capture).
// Solo dopo questa conferma il sito considera l'acquisto vero e sicuro.

const PAYPAL_CLIENT_ID = "AS11o9Ppgw-C-j2MqYJpso72FiaAaNXPjKLl5oY9mTlPnC626POXm5FHlX2BscA1SClUAVTaQzGQm1-k";
const PAYPAL_SECRET = "EHV48__VAmZF5R5g8ZuyACdEOlmJBZC4Jc6KyYipU30FB3zbX3Vc9bmrptzeoj3KPP51dcrgKY7AcaNA";
const PAYPAL_API = "https://api-m.paypal.com";

async function getAccessToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`
  ).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error("Errore autenticazione PayPal:", data);
    throw new Error("Impossibile autenticarsi con PayPal");
  }
  return data.access_token;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Metodo non permesso" }), { status: 405 });
  }

  try {
    const { orderID, productName, customerEmail } = await req.json();

    if (!orderID) {
      return new Response(JSON.stringify({ error: "ID ordine mancante" }), { status: 400 });
    }

    const accessToken = await getAccessToken();

    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      }
    });

    const captureData = await captureRes.json();

    if (!captureRes.ok) {
      console.error("Errore HTTP cattura pagamento PayPal:", captureData);
      return new Response(JSON.stringify({ success: false, error: "Errore nella cattura del pagamento", details: captureData }), { status: 200 });
    }

    if (captureData.status === "COMPLETED") {
      // QUI in futuro: invio email al cliente con il link di download,
      // e notifica a te (Andrea) con i dettagli del nuovo acquisto.
      console.log("Pagamento completato:", productName, customerEmail);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      return new Response(JSON.stringify({ success: false, status: captureData.status }), { status: 200 });
    }

  } catch (err) {
    console.error("Errore conferma pagamento PayPal:", err);
    return new Response(JSON.stringify({ error: "Errore nella conferma del pagamento" }), { status: 500 });
  }
};
