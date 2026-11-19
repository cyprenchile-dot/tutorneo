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
            console.error('Error conectando a PostgreSQL, usando disco temporal:', err.message);
            pool = null;
            storageMode = 'DISK_TEMPORARY';
        }
    }
    try {
        if (fs.existsSync(DB_FILE)) {
            memState = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (memState && !memState.rev) memState.rev = 1;
        }
    } catch (e) {
        console.error('Error leyendo JSON local:', e.message);
    }
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

// 1. Lectura unificada en tiempo real
app.get('/api/state', async (req, res) => {
    await storageReady;
    if (!memState) {
        return res.json({ empty: true, storageMode });
    }
    res.json({ empty: false, storageMode, state: memState });
});

// 2. Guardado atómico con incremento de revisión
app.post('/api/state', async (req, res) => {
    try {
        if (!req.body || !req.body.torneos) {
            return res.status(400).json({ ok: false, error: 'Datos inválidos' });
        }
        const meta = await guardarEstadoDB(req.body);
        res.json({ ok: true, rev: meta.rev, lastUpdated: meta.lastUpdated, storageMode });
    } catch (err) {
        console.error('Error guardando estado:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// 3. Crear preferencia oficial de cobro en Mercado Pago
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
                id: String(folioMP || `BOX-${boxId}`),
                title: `Inscripcion ${nombreTorneo || 'Torneo'} - ${categoriaNombre || 'Cat'} (Box #${boxId}: ${aliasDupla || 'Dupla'})`,
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

// 4. Webhook de Mercado Pago (guarda en PostgreSQL y pasa el Box a rojo en todos los teléfonos)
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
                const cupo = memState.torneos?.[ref.torneoId]?.cupos?.[ref.cat]?.find(x => x.id === Number(ref.box));
                if (cupo) {
                    cupo.ocupado = true;
                    cupo.estadoPagoMP = 'PAGADO_MP';
                    cupo.expiraReservaTimestamp = 0;
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
