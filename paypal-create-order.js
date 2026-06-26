// netlify/functions/paypal-create-order.js
//
// Crea un ordine di pagamento PayPal. Il Secret resta sempre nel server,
// mai visibile al pubblico. Va salvato su Netlify come variabile d'ambiente: PAYPAL_SECRET
// Il Client ID può restare anche visibile, va salvato come: PAYPAL_CLIENT_ID

const PAYPAL_CLIENT_ID = "AS11o9Ppgw-C-j2MqYJpso72FiaAaNXPjKLl5oY9mTlPnC626POXm5FHlX2BscA1SClUAVTaQzGQm1-k";
const PAYPAL_SECRET = "EHV48__VAmZF5R5g8ZuyACdEOlmJBZC4Jc6KyYipU30FB3zbX3Vc9bmrptzeoj3KPP51dcrgKY7AcaNA";
const PAYPAL_API = "https://api-m.paypal.com"; // ambiente LIVE (soldi veri)

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
    const { productName, price } = await req.json();

    if (!productName || !price) {
      return new Response(JSON.stringify({ error: "Dati mancanti" }), { status: 400 });
    }

    const accessToken = await getAccessToken();

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: productName,
            amount: {
              currency_code: "EUR",
              value: price
            }
          }
        ]
      })
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok || !orderData.id) {
      console.error("Errore creazione ordine PayPal:", orderData);
      return new Response(JSON.stringify({ error: "PayPal non ha creato l'ordine", details: orderData }), { status: 502 });
    }

    return new Response(JSON.stringify({ id: orderData.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("Errore creazione ordine PayPal:", err);
    return new Response(JSON.stringify({ error: "Errore nella creazione dell'ordine" }), { status: 500 });
  }
};
