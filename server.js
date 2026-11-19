const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'circuito360_db.json');
const DEFAULT_MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-6343439635613247-111721-d62e99775b7b52b629d88e2540c6e3dd-2521587898';

app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.use(express.static(__dirname));

let pool = null;
let storageMode = 'DISK_TEMPORARY';
let memState = null;

async function initStorage() {
    if (process.env.DATABASE_URL) {
        try {
            pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false }
            });
            await pool.query(`
                CREATE TABLE IF NOT EXISTS circuito360_state (
                    id TEXT PRIMARY KEY,
                    payload JSONB NOT NULL,
                    rev INTEGER NOT NULL DEFAULT 1,
                    updated_at BIGINT NOT NULL
                )
            `);
            const res = await pool.query('SELECT payload, rev, updated_at FROM circuito360_state WHERE id = $1', ['main']);
            if (res.rows.length > 0) {
                memState = res.rows[0].payload;
                memState.rev = Number(res.rows[0].rev) || 1;
                memState.lastUpdated = Number(res.rows[0].updated_at) || Date.now();
            }
            storageMode = 'POSTGRES_PERMANENT';
            console.log('DB PERMANENTE POSTGRESQL CONECTADA OK');
            return;
        } catch (err) {
            console.error('Error conectando a PostgreSQL:', err.message);
            pool = null;
            storageMode = 'DISK_TEMPORARY';
        }
    }
    try {
        if (fs.existsSync(DB_FILE)) {
            memState = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (memState && !memState.rev) memState.rev = 1;
        }
    } catch (e) {}
}

const storageReady = initStorage();

async function guardarEstadoDB(data) {
    await storageReady;
    const nextRev = (memState && Number(memState.rev) ? Number(memState.rev) : 0) + 1;
    const now = Date.now();
    data.rev = nextRev;
    data.lastUpdated = now;
    memState = data;

    if (pool) {
        await pool.query(
            `INSERT INTO circuito360_state (id, payload, rev, updated_at)
             VALUES ($1, $2::jsonb, $3, $4)
             ON CONFLICT (id) DO UPDATE
             SET payload = EXCLUDED.payload, rev = EXCLUDED.rev, updated_at = EXCLUDED.updated_at`,
            ['main', JSON.stringify(data), nextRev, now]
        );
    } else {
        fs.writeFileSync(DB_FILE, JSON.stringify(data), 'utf8');
    }
    return { rev: nextRev, lastUpdated: now };
}

// Envío automático de Cupón de Kit y Alerta por Email (vía Resend API si está configurado RESEND_API_KEY)
async function enviarCorreoCupon(torneo, catNombre, cupo) {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.MAIL_FROM || 'CIRCUITO360 <onboarding@resend.dev>';
    const destinatarios = [cupo.email1, cupo.email2, torneo?.config?.emailAlertaAdmin]
        .map(e => (e || '').trim())
        .filter(e => e.includes('@'));

    if (!apiKey || destinatarios.length === 0) {
        return { sent: false, reason: !apiKey ? 'FALTA_RESEND_API_KEY' : 'SIN_DESTINATARIOS' };
    }

    const cfg = torneo.config || {};
    const tituloCupon = cfg.cuponTitulo || 'CUPÓN OFICIAL • KIT DE JUGADOR RESERVADO';
    const textoCupon = cfg.cuponTexto || 'Con este número tienes reservado tu Kit Oficial de Jugador al llegar al club.';
    const notaCupon = cfg.cuponNota || 'Presenta este cupón en mesa de acreditación el día del torneo.';
    const igClub = cfg.instagramClub || '';
    const numKit = cupo.codigoCupon || cupo.folioMP || `KIT-${cupo.id}`;

    const html = `
      <div style="font-family:Arial,sans-serif;background:#04070D;color:#F8FAFC;padding:28px;border-radius:16px;max-width:560px;margin:0 auto;border:2px solid #D4AF37;">
        <div style="text-align:center;margin-bottom:18px;">
          <span style="background:#D4AF37;color:#030508;font-weight:900;padding:5px 12px;border-radius:6px;font-size:12px;">CIRCUITO360.CL</span>
          <h2 style="color:#10B981;margin:12px 0 4px;">✅ ¡INSCRIPCIÓN CONFIRMADA!</h2>
          <div style="color:#FDE047;font-weight:bold;font-size:14px;">${tituloCupon}</div>
        </div>
        <div style="background:#0B1220;padding:18px;border-radius:12px;border:1px dashed #D4AF37;text-align:center;margin-bottom:16px;">
          <div style="font-size:12px;color:#94A3B8;text-transform:uppercase;">NÚMERO DE CUPÓN / KIT RESERVADO</div>
          <div style="font-size:28px;font-weight:900;color:#D4AF37;letter-spacing:2px;margin:6px 0;">${numKit}</div>
          <p style="font-size:14px;color:#E2E8F0;margin:8px 0 0;">${textoCupon}</p>
        </div>
        <div style="font-size:14px;line-height:1.7;background:#060B14;padding:14px;border-radius:10px;">
          <div><strong>Torneo:</strong> ${cfg.nombreTorneo || 'Torneo Pádel'} (${cfg.badgeOrg || ''})</div>
          <div><strong>Categoría:</strong> ${catNombre} • <strong>Cupo #${cupo.id}</strong></div>
          <div><strong>Dupla:</strong> ${cupo.alias}</div>
          <div><strong>Jugadores:</strong> ${cupo.j1} (${cupo.redes1 || '-'}) & ${cupo.j2} (${cupo.redes2 || '-'})</div>
          <div><strong>WhatsApp:</strong> ${cupo.tel1 || '-'} / ${cupo.tel2 || '-'}</div>
        </div>
        <p style="font-size:12px;color:#94A3B8;text-align:center;margin-top:16px;">${notaCupon} ${igClub ? `• Etiquétanos en Instagram: <strong>${igClub}</strong>` : ''}</p>
      </div>
    `;

    try {
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: fromEmail,
                to: [...new Set(destinatarios)],
                subject: `🎟️ Inscrito ${cfg.nombreTorneo || 'Torneo'} | Cupón Kit ${numKit} (${cupo.alias})`,
                html
            })
        });
        const data = await resp.json();
        return { sent: resp.ok, data };
    } catch (e) {
        console.error('Error enviando correo:', e.message);
        return { sent: false, error: e.message };
    }
}

app.get('/api/state', async (req, res) => {
    await storageReady;
    if (!memState) return res.json({ empty: true, storageMode });
    res.json({ empty: false, storageMode, state: memState });
});

app.post('/api/state', async (req, res) => {
    try {
        if (!req.body || !req.body.torneos) return res.status(400).json({ ok: false });
        const meta = await guardarEstadoDB(req.body);
        res.json({ ok: true, rev: meta.rev, lastUpdated: meta.lastUpdated, storageMode });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/notify-coupon', async (req, res) => {
    try {
        await storageReady;
        const { torneoId, categoriaKey, boxId, force } = req.body || {};
        const torneo = memState?.torneos?.[torneoId];
        const catObj = torneo?.config?.categorias?.find(c => c.key === categoriaKey);
        const cupo = torneo?.cupos?.[categoriaKey]?.find(x => x.id === Number(boxId));
        if (!torneo || !cupo) return res.status(404).json({ ok: false });
        if (cupo.emailEnviado && !force) return res.json({ ok: true, alreadySent: true });

        const r = await enviarCorreoCupon(torneo, catObj?.nombre || categoriaKey, cupo);
        if (r.sent) {
            cupo.emailEnviado = true;
            await guardarEstadoDB(memState);
        }
        res.json({ ok: true, ...r });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/mp/create-preference', async (req, res) => {
    await storageReady;
    const { torneoId, nombreTorneo, categoriaKey, categoriaNombre, boxId, aliasDupla, monto, folioMP, mpAccessToken, fallbackLink } = req.body;
    const tokenEnTorneo = memState?.torneos?.[torneoId]?.config?.mpAccessToken;
    const linkEnTorneo = memState?.torneos?.[torneoId]?.config?.linkPago;

    let token = DEFAULT_MP_TOKEN;
    if (mpAccessToken && mpAccessToken.trim().startsWith('APP_USR-')) token = mpAccessToken.trim();
    else if (tokenEnTorneo && tokenEnTorneo.trim().startsWith('APP_USR-')) token = tokenEnTorneo.trim();
    else if (fallbackLink && fallbackLink.includes('APP_USR-')) token = fallbackLink.replace(/^https?:\/\//i, '').trim();
    else if (linkEnTorneo && linkEnTorneo.includes('APP_USR-')) token = linkEnTorneo.replace(/^https?:\/\//i, '').trim();

    try {
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;

        const preferenceBody = {
            items: [{
                id: String(folioMP || `CUPO-${boxId}`),
                title: `Inscripcion ${nombreTorneo || 'Torneo'} - ${categoriaNombre || 'Cat'} (Cupo #${boxId}: ${aliasDupla || 'Dupla'})`,
                quantity: 1,
                currency_id: 'CLP',
                unit_price: Math.max(100, Math.round(Number(monto) || 70000))
            }],
            external_reference: JSON.stringify({ torneoId, cat: categoriaKey, box: Number(boxId), folioMP }),
            back_urls: {
                success: `${baseUrl}/?torneo=${encodeURIComponent(torneoId)}&cat=${encodeURIComponent(categoriaKey)}&box=${boxId}&mp_status=approved`,
                failure: `${baseUrl}/?torneo=${encodeURIComponent(torneoId)}&cat=${encodeURIComponent(categoriaKey)}&box=${boxId}&mp_status=failure`,
                pending: `${baseUrl}/?torneo=${encodeURIComponent(torneoId)}&cat=${encodeURIComponent(categoriaKey)}&box=${boxId}&mp_status=pending`
            },
            auto_return: 'approved',
            notification_url: `${baseUrl}/api/mp/webhook?torneoId=${encodeURIComponent(torneoId)}`
        };

        const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(preferenceBody)
        });
        const mpData = await mpResp.json();
        if (mpResp.ok && mpData && mpData.init_point) {
            return res.json({ ok: true, init_point: mpData.init_point });
        }
        return res.status(400).json({ ok: false, error: mpData?.message || 'Error API MP' });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/mp/webhook', async (req, res) => {
    try {
        await storageReady;
        const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
        const token = DEFAULT_MP_TOKEN;
        if (paymentId && token && memState) {
            const pResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const pData = await pResp.json();
            if (pData && pData.status === 'approved' && pData.external_reference) {
                const ref = JSON.parse(pData.external_reference);
                const torneo = memState.torneos?.[ref.torneoId];
                const catObj = torneo?.config?.categorias?.find(c => c.key === ref.cat);
                const cupo = torneo?.cupos?.[ref.cat]?.find(x => x.id === Number(ref.box));
                if (cupo) {
                    cupo.ocupado = true;
                    cupo.estadoPagoMP = 'PAGADO_MP';
                    cupo.expiraReservaTimestamp = 0;
                    if (!cupo.codigoCupon) cupo.codigoCupon = `KIT-${Math.floor(10000 + Math.random() * 90000)}`;
                    if (!cupo.emailEnviado) {
                        const mailRes = await enviarCorreoCupon(torneo, catObj?.nombre || ref.cat, cupo);
                        if (mailRes.sent) cupo.emailEnviado = true;
                    }
                    await guardarEstadoDB(memState);
                }
            }
        }
    } catch (e) {
        console.error('Error Webhook MP:', e.message);
    }
    res.sendStatus(200);
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

storageReady.then(() => {
    app.listen(PORT, () => console.log(`CIRCUITO360.CL corriendo en puerto ${PORT} [${storageMode}]`));
});
