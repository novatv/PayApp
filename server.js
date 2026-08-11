require('dotenv').config();
const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 10);
const DEMO_MODE = !STRIPE_SECRET_KEY;

let stripe = null;
if (!DEMO_MODE) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

// ---------- Stripe webhook (raw body) ----------
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
        db.prepare(`UPDATE payments SET status = 'paid', paid_at = datetime('now'), stripe_payment_intent = ? WHERE id = ?`)
          .run(session.payment_intent || null, paymentId);
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

// ---------- Helpers ----------
function toCents(amount) { return Math.round(Number(amount) * 100); }
function fromCents(cents) { return (cents / 100).toFixed(2); }

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  try {
    const token = parseCookies(req).pa_token;
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    return db.prepare('SELECT id, email, stripe_account_id, created_at FROM users WHERE id = ?').get(decoded.uid) || null;
  } catch (e) {
    return null;
  }
}
function setAuthCookie(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie', `pa_token=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; Secure`);
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email no valido' });
  if (password.length < 6) return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'Ese email ya esta registrado' });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
  const user = { id: info.lastInsertRowid, email };
  setAuthCookie(res, user);
  res.json({ ok: true, email });
});

app.post('/api/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: 'Email o contrasena incorrectos' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Email o contrasena incorrectos' });
  setAuthCookie(res, user);
  res.json({ ok: true, email: user.email });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'pa_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json({ user: u ? { id: u.id, email: u.email, stripe_connected: !!u.stripe_account_id } : null });
});

// ---------- Stripe Connect (conectar cobros) ----------
app.post('/api/connect/start', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (DEMO_MODE) {
    db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?').run('acct_demo_' + user.id, user.id);
    return res.json({ url: `${BASE_URL}/connect/return?demo=1`, demo: true });
  }
  try {
    let acctId = user.stripe_account_id;
    if (!acctId) {
      const account = await stripe.accounts.create({
        type: 'express',
        capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      });
      acctId = account.id;
      db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?').run(acctId, user.id);
    }
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: `${BASE_URL}/connect/refresh`,
      return_url: `${BASE_URL}/connect/return`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (err) {
    console.error('Error iniciando Connect:', err);
    res.status(500).json({ error: 'No se pudo iniciar la conexion. Revisa que Connect este habilitado en tu cuenta de Stripe.' });
  }
});

app.get('/api/connect/status', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (!user.stripe_account_id) return res.json({ connected: false, onboarded: false });
  if (DEMO_MODE) return res.json({ connected: true, onboarded: true, demo: true, payouts_enabled: true });
  try {
    const acct = await stripe.accounts.retrieve(user.stripe_account_id);
    res.json({
      connected: true,
      onboarded: !!acct.details_submitted,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
    });
  } catch (e) {
    res.json({ connected: true, onboarded: false });
  }
});

// ---------- Create a payment request (requires login) ----------
app.post('/api/tikkies', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Debes iniciar sesion para crear un enlace' });
  const { description, amount, creator_name, currency } = req.body;
  if (!description || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'description y amount (>0) son requeridos' });
  }
  const id = nanoid(10);
  const amount_cents = toCents(amount);
  const cur = (currency || 'EUR').toUpperCase();
  db.prepare(`INSERT INTO tikkies (id, description, amount_cents, currency, creator_name, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, description, amount_cents, cur, creator_name || user.email, user.id);
  res.json({ id, pay_url: `${BASE_URL}/pay/${id}`, dashboard_url: `${BASE_URL}/t/${id}` });
});

app.get('/api/tikkies/:id', (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    id: tikkie.id, description: tikkie.description, amount: fromCents(tikkie.amount_cents),
    currency: tikkie.currency, creator_name: tikkie.creator_name, created_at: tikkie.created_at, demo_mode: DEMO_MODE,
  });
});

app.get('/api/my-tikkies', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  const rows = db.prepare(`SELECT * FROM tikkies WHERE user_id = ? ORDER BY created_at DESC`).all(user.id);
  const out = rows.map((t) => {
    const paid = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE tikkie_id = ? AND status = 'paid'`).get(t.id).s;
    return { id: t.id, description: t.description, amount: fromCents(t.amount_cents), currency: t.currency,
      total_paid: fromCents(paid), pay_url: `${BASE_URL}/pay/${t.id}`, created_at: t.created_at };
  });
  res.json({ email: user.email, tikkies: out });
});

// ---------- Wallet (saldo del usuario) ----------
function walletFor(userId) {
  const rows = db.prepare(`SELECT p.amount_cents, p.status, p.payout_status FROM payments p JOIN tikkies t ON p.tikkie_id = t.id WHERE t.user_id = ?`).all(userId);
  const paid = rows.filter((r) => r.status === 'paid');
  const grossCents = paid.reduce((s, r) => s + r.amount_cents, 0);
  const feeCents = Math.round(grossCents * (PLATFORM_FEE_PERCENT / 100));
  const netCents = grossCents - feeCents;
  const availGross = paid.filter((r) => r.payout_status !== 'instant_paid').reduce((s, r) => s + r.amount_cents, 0);
  const availableCents = availGross - Math.round(availGross * (PLATFORM_FEE_PERCENT / 100));
  return { grossCents, feeCents, netCents, availableCents };
}

app.get('/api/wallet', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  const w = walletFor(user.id);
  res.json({
    currency: 'EUR',
    total_collected: fromCents(w.grossCents),
    platform_fee: fromCents(w.feeCents),
    your_share: fromCents(w.netCents),
    available: fromCents(w.availableCents),
    fee_percent: PLATFORM_FEE_PERCENT,
    connected: !!user.stripe_account_id,
    demo_mode: DEMO_MODE,
  });
});

app.post('/api/wallet/payout', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  const rows = db.prepare(`SELECT p.id, p.amount_cents FROM payments p JOIN tikkies t ON p.tikkie_id = t.id WHERE t.user_id = ? AND p.status = 'paid' AND (p.payout_status IS NULL OR p.payout_status = 'pending')`).all(user.id);
  if (rows.length === 0) return res.status(400).json({ error: 'No tienes saldo disponible para retirar' });
  const gross = rows.reduce((s, r) => s + r.amount_cents, 0);
  const net = gross - Math.round(gross * (PLATFORM_FEE_PERCENT / 100));
  if (DEMO_MODE) {
    rows.forEach((r) => db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(r.id));
    return res.json({ demo_mode: true, amount: fromCents(net), message: 'Retiro instantaneo simulado.' });
  }
  if (!user.stripe_account_id || user.stripe_account_id.startsWith('acct_demo_')) {
    return res.status(400).json({ error: 'Conecta tus cobros antes de retirar' });
  }
  try {
    const payout = await stripe.payouts.create(
      { amount: net, currency: 'eur', method: 'instant' },
      { stripeAccount: user.stripe_account_id }
    );
    rows.forEach((r) => db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(r.id));
    res.json({ payout_id: payout.id, amount: fromCents(net), arrival: 'minutos (instant payout)' });
  } catch (err) {
    console.error('Error en payout de wallet:', err);
    res.status(500).json({ error: 'No se pudo procesar el retiro. Revisa que tu cuenta tenga una tarjeta de debito elegible para pagos instantaneos.' });
  }
});

app.get('/api/tikkies/:id/status', (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });
  const payments = db.prepare(`SELECT * FROM payments WHERE tikkie_id = ? ORDER BY created_at DESC`).all(req.params.id);
  const totalPaidCents = payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount_cents, 0);
  const totalPayoutCents = payments.filter((p) => p.status === 'paid' && p.payout_status === 'instant_paid').reduce((s, p) => s + p.amount_cents, 0);
  res.json({
    tikkie: { id: tikkie.id, description: tikkie.description, amount: fromCents(tikkie.amount_cents), currency: tikkie.currency, creator_name: tikkie.creator_name },
    total_paid: fromCents(totalPaidCents), total_paid_out_instantly: fromCents(totalPayoutCents), demo_mode: DEMO_MODE,
    payments: payments.map((p) => ({ id: p.id, payer_name: p.payer_name, amount: fromCents(p.amount_cents), status: p.status, payout_status: p.payout_status, created_at: p.created_at, paid_at: p.paid_at })),
  });
});

app.post('/api/tikkies/:id/pay', async (req, res) => {
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(req.params.id);
  if (!tikkie) return res.status(404).json({ error: 'No encontrado' });
  const { payer_name } = req.body;
  const paymentId = nanoid(12);
  db.prepare(`INSERT INTO payments (id, tikkie_id, amount_cents, payer_name, status) VALUES (?, ?, ?, ?, 'open')`)
    .run(paymentId, tikkie.id, tikkie.amount_cents, payer_name || null);
  if (DEMO_MODE) return res.json({ checkout_url: `${BASE_URL}/demo-checkout/${paymentId}` });
  try {
    // Si el dueno del enlace tiene cuenta Connect, enrutamos: 90% a su cuenta, 10% de comision a la plataforma.
    const owner = tikkie.user_id ? db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(tikkie.user_id) : null;
    const ownerAcct = owner && owner.stripe_account_id && !owner.stripe_account_id.startsWith('acct_demo_') ? owner.stripe_account_id : null;
    const sessionParams = {
      mode: 'payment',
      line_items: [{ price_data: { currency: tikkie.currency.toLowerCase(), product_data: { name: tikkie.description }, unit_amount: tikkie.amount_cents }, quantity: 1 }],
      automatic_payment_methods: { enabled: true },
      success_url: `${BASE_URL}/pay/${tikkie.id}/thanks?payment_id=${paymentId}`,
      cancel_url: `${BASE_URL}/pay/${tikkie.id}`,
      metadata: { paymentId, tikkieId: tikkie.id },
    };
    if (ownerAcct) {
      const fee = Math.round(tikkie.amount_cents * (PLATFORM_FEE_PERCENT / 100));
      sessionParams.payment_intent_data = { application_fee_amount: fee, transfer_data: { destination: ownerAcct } };
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
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
  const paidUnpaidOut = db.prepare(`SELECT * FROM payments WHERE tikkie_id = ? AND status = 'paid' AND (payout_status IS NULL OR payout_status = 'pending')`).all(req.params.id);
  if (paidUnpaidOut.length === 0) return res.status(400).json({ error: 'No hay saldo cobrado pendiente de retirar' });
  const totalCents = paidUnpaidOut.reduce((s, p) => s + p.amount_cents, 0);
  if (DEMO_MODE) {
    paidUnpaidOut.forEach((p) => db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(p.id));
    return res.json({ demo_mode: true, amount: fromCents(totalCents), message: 'Retiro instantaneo simulado.' });
  }
  try {
    const payout = await stripe.payouts.create({ amount: totalCents, currency: tikkie.currency.toLowerCase(), method: 'instant', metadata: { tikkieId: tikkie.id } });
    paidUnpaidOut.forEach((p) => db.prepare(`UPDATE payments SET payout_status = 'instant_paid' WHERE id = ?`).run(p.id));
    res.json({ payout_id: payout.id, amount: fromCents(totalCents), arrival: 'minutos (instant payout)' });
  } catch (err) {
    console.error('Error solicitando payout instantaneo:', err);
    res.status(500).json({ error: 'No se pudo procesar el retiro instantaneo. Revisa que tu cuenta de Stripe tenga una tarjeta de debito elegible.' });
  }
});

// ---------- Demo checkout ----------
app.get('/demo-checkout/:paymentId', (req, res) => {
  const payment = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(req.params.paymentId);
  if (!payment) return res.status(404).send('Pago no encontrado');
  const tikkie = db.prepare(`SELECT * FROM tikkies WHERE id = ?`).get(payment.tikkie_id);
  res.send('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Simulacion de pago</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1e293b;padding:32px;border-radius:16px;max-width:440px;width:90%;text-align:center}.amount{font-size:2rem;font-weight:700;color:#3EE27B;margin:12px 0}button{background:#0EA54E;color:#fff;border:none;padding:14px 24px;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;width:100%;margin-top:20px}.note{font-size:.75rem;color:#94a3b8;margin-top:16px}</style></head><body><div class="card"><h2>Modo demo</h2><p>' + tikkie.description + '</p><div class="amount">' + (tikkie.currency === 'EUR' ? String.fromCharCode(8364) : tikkie.currency + ' ') + fromCents(payment.amount_cents) + '</div><form method="POST" action="/demo-checkout/' + payment.id + '/confirm"><button type="submit">Simular pago exitoso</button></form><p class="note">Configura STRIPE_SECRET_KEY para pagos reales.</p></div></body></html>');
});

app.post('/demo-checkout/:paymentId/confirm', (req, res) => {
  db.prepare(`UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(req.params.paymentId);
  const payment = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(req.params.paymentId);
  res.redirect(`/pay/${payment.tikkie_id}/thanks?payment_id=${payment.id}`);
});

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mi-panel.html')));
app.get('/connect/return', (req, res) => res.sendFile(path.join(__dirname, 'public', 'connect-return.html')));
app.get('/connect/refresh', (req, res) => res.redirect('/'));
app.get('/pay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));
app.get('/pay/:id/thanks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'thanks.html')));
app.get('/t/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`PayApp corriendo en ${BASE_URL} ${DEMO_MODE ? 'MODO DEMO' : 'Stripe conectado'}`);
});
