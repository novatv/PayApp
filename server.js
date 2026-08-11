require('dotenv').config();
const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const DEMO_MODE = !STRIPE_SECRET_KEY;

let stripe = null;
if (!DEMO_MODE) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (DEMO_MODE) return res.sendStatus(200);
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
    ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Firma de webhook invalida:', err.message);
    return res.sendStatus(400);
  }

         try {
           if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
             const session = event.data.object;
             const { paymentId } = session.metadata || {};
             if (paymentId) {
               db.prepare(
                 `UPDATE payments SET status = 'paid', paid_at = datetime('now'), stripe_payment_intent = ? WHERE id = ?`
                 ).run(session.payment_intent || null, paymentId);
             }
           } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
             const session = event.data.object;
             const { paymentId } = session.metadata || {};
             if (paymentId) {
               const newStatus = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
               db.prepare(`UPDATE payments SET status = ? WHERE id = ?`).run(newStatus, paymentId);
             }
           }
           res.sendStatus(200);
         } catch (err) {
           console.error('Error procesando webhook de Stripe:', err);
           res.sendStatus(500);
         }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}
function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

app.post('/api/tikkies', (req, res) => {
  const { description, amount, creator_name, currency } = req.body;
  if (!description || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'description y amount (>0) son requeridos' });
  }
  const id = nanoid(10);
  const amount_cents = toCents(amount);
  const cur = (currency || 'EUR').toUpperCase();
  db.prepare(
    `INSERT INTO tikkies (id, description, amount_cents, currency, creator_name) VALUES (?, ?, ?, ?, ?)`
    ).run(id, description, amount_cents, cur, creator_name || null);

         res.json({
           id,
           pay_url: `${BASE_URL}/pay/${id}`,
           dashboard_url: `${BASE_URL}/t/${id}`,
         });
});

app.get('/api/tikkies/:id', (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    id: tikkie.id,
    description: tikkie.description,
    amount: fromCents(tikkie.amount_cents),
    currency: tikkie.currency,
    creator_name: tikkie.creator_name,
    created_at: tikkie.created_at,
    demo_mode: DEMO_MODE,
  });
});

app.get('/api/tikkies/:id/status', (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });
  const payments = db
  .prepare(`SELECT * FROM payments WHERE tikkie_id = ? ORDER BY created_at DESC`)
  .all(req.params.id);

        const totalPaidCents = payments
  .filter((p) => p.status === 'paid')
  .reduce((sum, p) => sum + p.amount_cents, 0);

        const totalPayoutCents = payments
  .filter((p) => p.status === 'paid' && p.payout_status === 'instant_paid')
  .reduce((sum, p) => sum + p.amount_cents, 0);

        res.json({
          tikkie: {
            id: tikkie.id,
            description: tikkie.description,
            amount: fromCents(tikkie.amount_cents),
            currency: tikkie.currency,
            creator_name: tikkie.creator_name,
          },
          total_paid: fromCents(totalPaidCents),
          total_paid_out_instantly: fromCents(totalPayoutCents),
          demo_mode: DEMO_MODE,
          payments: payments.map((p) => ({
            id: p.id,
            payer_name: p.payer_name,
            amount: fromCents(p.amount_cents),
            status: p.status,
            payout_status: p.payout_status,
            created_at: p.created_at,
            paid_at: p.paid_at,
          })),
        });
});

app.post('/api/tikkies/:id/pay', async (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });

         const { payer_name } = req.body;
  const paymentId = nanoid(12);

         db.prepare(
           `INSERT INTO payments (id, tikkie_id, amount_cents, payer_name, status) VALUES (?, ?, ?, ?, 'open')`
           ).run(paymentId, tikkie.id, tikkie.amount_cents, payer_name || null);

         if (DEMO_MODE) {
           return res.json({ checkout_url: `${BASE_URL}/demo-checkout/${paymentId}` });
         }

         try {
           const session = await stripe.checkout.sessions.create({
             mode: 'payment',
             line_items: [
               {
                 price_data: {
                   currency: tikkie.currency.toLowerCase(),
                   product_data: { name: tikkie.description },
                   unit_amount: tikkie.amount_cents,
                 },
                 quantity: 1,
               },
               ],
             automatic_payment_methods: { enabled: true },
             success_url: `${BASE_URL}/pay/${tikkie.id}/thanks?payment_id=${paymentId}`,
             cancel_url: `${BASE_URL}/pay/${tikkie.id}`,
             metadata: { paymentId, tikkieId: tikkie.id },
           });

  db.prepare(`UPDATE payments SET stripe_session_id = ? WHERE id = ?`).run(session.id, paymentId);

  res.json({ checkout_url: session.url });
         } catch (err) {
           console.error('Error creando sesion de Stripe:', err);
           res.status(500).json({ error: 'No se pudo iniciar el pago con Stripe' });
         }
});

app.post('/api/tikkies/:id/payout', async (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });

         const paidUnpaidOut = db
  .prepare(`SELECT * FROM payments WHERE tikkie_id = ? AND status = 'paid' AND (payout_status IS NULL OR payout_status = 'pending')`)
  .all(req.params.id);

         if (paidUnpaidOut.length === 0) {
           return res.status(400).json({ error: 'No hay saldo cobrado pendiente de retirar' });
         }

         const totalCents = paidUnpaidOut.reduce((sum, p) => sum + p.amount_cents, 0);

         if (DEMO_MODE) {
           paidUnpaidOut.forEach((p) =>
             db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(p.id)
                                 );
           return res.json({
             demo_mode: true,
             amount: fromCents(totalCents),
             message: 'Retiro instantaneo simulado: el dinero llegaria a tu tarjeta en minutos.',
           });
         }

         try {
           const payout = await stripe.payouts.create({
             amount: totalCents,
             currency: tikkie.currency.toLowerCase(),
             method: 'instant',
             metadata: { tikkieId: tikkie.id },
           });

  paidUnpaidOut.forEach((p) =>
    db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(p.id)
                        );

  res.json({ payout_id: payout.id, amount: fromCents(totalCents), arrival: 'minutos (instant payout)' });
         } catch (err) {
           console.error('Error solicitando payout instantaneo:', err);
           res.status(500).json({
             error: 'No se pudo procesar el retiro instantaneo. Revisa que tu cuenta de Stripe tenga una tarjeta de debito elegible para Instant Payouts, o usa el retiro estandar desde tu dashboard de Stripe.',
           });
         }
});

app.get('/demo-checkout/:paymentId', (req, res) => {
  const payment = db
  .prepare(`SELECT * FROM payments WHERE id = ?`)
  .get(req.params.paymentId);
  if (!payment) return res.status(404).send('Pago no encontrado');
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(payment.tikkie_id);

        res.send('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Simulacion de pago (modo demo)</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1e293b;padding:32px;border-radius:16px;max-width:440px;width:90%;text-align:center}h2{margin-top:0}.amount{font-size:2rem;font-weight:700;color:#22d3ee;margin:12px 0}.section-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin:18px 0 8px;text-align:left}.banks{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:8px 0}.bank{background:#334155;padding:6px 12px;border-radius:8px;font-size:.8rem}.bank.selected{background:#22d3ee;color:#0f172a;font-weight:700}button{background:#22d3ee;color:#0f172a;border:none;padding:14px 24px;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;width:100%;margin-top:20px}.note{font-size:.75rem;color:#94a3b8;margin-top:16px}</style></head><body><div class="card"><h2>Modo demo (sin Stripe configurado)</h2><p>' + tikkie.description + '</p><div class="amount">' + (tikkie.currency === 'EUR' ? String.fromCharCode(8364) : tikkie.currency + ' ') + fromCents(payment.amount_cents) + '</div><div class="section-label">Tarjetas (cualquier pais)</div><div class="banks"><span class="bank selected">Visa</span><span class="bank">Mastercard</span><span class="bank">American Express</span></div><div class="section-label">Latinoamerica</div><div class="banks"><span class="bank">OXXO (MX)</span><span class="bank">SPEI (MX)</span><span class="bank">PIX (BR)</span><span class="bank">Boleto (BR)</span></div><div class="section-label">Europa</div><div class="banks"><span class="bank">iDEAL (NL)</span><span class="bank">Bancontact (BE)</span><span class="bank">SEPA</span></div><div class="section-label">Wallets</div><div class="banks"><span class="bank">PayPal</span><span class="bank">Apple Pay</span><span class="bank">Google Pay</span></div><form method="POST" action="/demo-checkout/' + payment.id + '/confirm"><button type="submit">Simular pago exitoso</button></form><p class="note">Esto es una simulacion local. Configura STRIPE_SECRET_KEY en .env para procesar pagos reales.</p></div></body></html>');
});

app.post('/demo-checkout/:paymentId/confirm', (req, res) => {
  db.prepare(
    `UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?`
    ).run(req.params.paymentId);
  const payment = db
  .prepare(`SELECT * FROM payments WHERE id = ?`)
  .get(req.params.paymentId);
  res.redirect(`/pay/${payment.tikkie_id}/thanks?payment_id=${payment.id}`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/pay/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});
app.get('/pay/:id/thanks', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thanks.html'));
});
app.get('/t/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`PayApp corriendo en ${BASE_URL} ${DEMO_MODE ? 'MODO DEMO' : 'Stripe conectado'}`);
});
