const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'circuito360_db.json');
const TIEMPO_HOLD_MS = 10 * 60 * 1000;

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});
app.use(express.static(__dirname));

// Clientes conectados en tiempo real (Server-Sent Events)
const sseClients = new Set();

function leerEstadoDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error leyendo DB:', e.message);
    }
    return null;
}

function guardarEstadoDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
        console.error('Error guardando DB:', e.message);
    }
}

function broadcastSync(motivo = 'update') {
    const db = leerEstadoDB();
    const payload = JSON.stringify({
        type: 'sync',
        motivo,
        lastUpdated: db ? db.lastUpdated : Date.now(),
        serverNow: Date.now()
    });
    for (const res of sseClients) {
        try {
            res.write(`data: ${payload}\n\n`);
        } catch (e) {
            sseClients.delete(res);
        }
    }
}

function limpiarReservasExpiradasEnServidor() {
    const db = leerEstadoDB();
    if (!db || !db.torneos) return false;
    const ahora = Date.now();
    let huboCambios = false;

    Object.values(db.torneos).forEach(t => {
        Object.keys(t.cupos || {}).forEach(catKey => {
            (t.cupos[catKey] || []).forEach(c => {
                if (c.ocupado && c.estadoPagoMP === 'RESERVANDO_MP' && c.expiraReservaTimestamp > 0 && ahora > c.expiraReservaTimestamp) {
                    c.ocupado = false;
                    c.estadoPagoMP = 'LIBRE';
                    c.expiraReservaTimestamp = 0;
                    c.alias = '';
                    c.j1 = '';
                    c.j2 = '';
                    c.urlCheckoutMP = '';
                    huboCambios = true;
                }
            });
        });
    });

    if (huboCambios) {
        db.lastUpdated = Date.now();
        guardarEstadoDB(db);
        broadcastSync('expiry_cleanup');
    }
    return huboCambios;
}

// Revisa cada 15 segundos en el servidor si expiró alguna reserva de 10 minutos
setInterval(limpiarReservasExpiradasEnServidor, 15000);

// 1. Canal Push en Tiempo Real (SSE) para celulares, PCs y Monitor TV
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', serverNow: Date.now() })}\n\n`);

    const keepAlive = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch (e) { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
    });
});

// 2. Obtener estado central + hora oficial del servidor
app.get('/api/state', (req, res) => {
    limpiarReservasExpiradasEnServidor();
    const data = leerEstadoDB();
    if (!data) return res.status(404).json({ ok: false, serverNow: Date.now() });
    res.json({ ok: true, data, serverNow: Date.now() });
});

// 3. Guardar cambios administrativos y notificar al instante a todos los dispositivos
app.post('/api/state', (req, res) => {
    if (req.body && req.body.torneos) {
        req.body.lastUpdated = Date.now();
        guardarEstadoDB(req.body);
        broadcastSync('admin_update');
        return res.json({ ok: true, lastUpdated: req.body.lastUpdated, serverNow: Date.now() });
    }
    res.status(400).json({ ok: false });
});

// 4. Reserva ATÓMICA de Box (evita que dos teléfonos reserven el mismo Box simultáneamente)
app.post('/api/reserve', (req, res) => {
    limpiarReservasExpiradasEnServidor();
    const { torneoId, catKey, boxId, datos } = req.body || {};
    const db = leerEstadoDB();

    if (!db || !db.torneos || !db.torneos[torneoId]) {
        return res.status(404).json({ ok: false, error: 'Torneo no encontrado en el servidor.' });
    }

    const cuposCat = db.torneos[torneoId].cupos?.[catKey] || [];
    const cupo = cuposCat.find(c => c.id === Number(boxId));

    if (!cupo) {
        return res.status(404).json({ ok: false, error: 'Box no encontrado.' });
    }

    if (cupo.ocupado && cupo.estadoPagoMP !== 'LIBRE') {
        return res.status(409).json({
            ok: false,
            error: 'Este Box acaba de ser tomado por otra pareja. Elige otro Box disponible en verde.'
        });
    }

    Object.assign(cupo, datos, {
        ocupado: true,
        estadoPagoMP: 'RESERVANDO_MP',
        expiraReservaTimestamp: Date.now() + TIEMPO_HOLD_MS,
        estadoNivel: 'PENDIENTE_REVISION'
    });

    db.lastUpdated = Date.now();
    guardarEstadoDB(db);
    broadcastSync('box_reserved');
    res.json({ ok: true, cupo, lastUpdated: db.lastUpdated, serverNow: Date.now() });
});

// 5. Resolver Access Token de Mercado Pago (prioriza variable segura de Render)
function obtenerTokenMP(torneoId, tokenEnviado, fallbackLink) {
    const db = leerEstadoDB();
    const tConfig = db?.torneos?.[torneoId]?.config;
    const candidatos = [
        tokenEnviado,
        tConfig?.mpAccessToken,
        process.env.MP_ACCESS_TOKEN,
        fallbackLink,
        tConfig?.linkPago
    ];
    for (const c of candidatos) {
        if (typeof c === 'string' && c.includes('APP_USR-')) {
            return c.replace(/^https?:\/\//i, '').trim();
        }
    }
    return '';
}

// 6. Crear Preferencia Oficial en Mercado Pago Checkout Pro
app.post('/api/mp/create-preference', async (req, res) => {
    const {
        torneoId,
        nombreTorneo,
        categoriaKey,
        categoriaNombre,
        boxId,
        aliasDupla,
        monto,
        folioMP,
        mpAccessToken,
        fallbackLink
    } = req.body || {};

    const token = obtenerTokenMP(torneoId, mpAccessToken, fallbackLink);
    const linkLimpio = (fallbackLink && !fallbackLink.includes('APP_USR-'))
        ? fallbackLink
        : 'https://www.mercadopago.cl';

    if (!token) {
        return res.json({ ok: true, init_point: linkLimpio, mode: 'link' });
    }

    try {
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;

        const preferenceBody = {
            items: [{
                id: String(folioMP || `BOX-${boxId}`),
                title: `Inscripcion ${nombreTorneo || 'Torneo Padel'} - ${categoriaNombre || 'Cat'} (Box #${boxId}: ${aliasDupla || 'Dupla'})`,
                quantity: 1,
                currency_id: 'CLP',
                unit_price: Math.max(100, Math.round(Number(monto) || 80000))
            }],
            external_reference: JSON.stringify({
                torneoId,
                cat: categoriaKey,
                box: Number(boxId),
                folioMP
            }),
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
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(preferenceBody)
        });

        const mpData = await mpResp.json();
        if (mpResp.ok && mpData && mpData.init_point) {
            return res.json({ ok: true, init_point: mpData.init_point, mode: 'api' });
        }
        console.error('Error MP Preferences:', JSON.stringify(mpData));
        return res.status(400).json({ ok: false, error: mpData?.message || 'Error al crear cobro en Mercado Pago', init_point: linkLimpio });
    } catch (err) {
        console.error('Excepción MP:', err.message);
        return res.status(500).json({ ok: false, error: err.message, init_point: linkLimpio });
    }
});

// 7. Webhook Oficial de Mercado Pago: pasa el Box a ROJO en todos los equipos al aprobarse
app.post('/api/mp/webhook', async (req, res) => {
    try {
        const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
        const torneoIdQuery = req.query?.torneoId;
        const token = obtenerTokenMP(torneoIdQuery, '', '');
        const db = leerEstadoDB();

        if (paymentId && token && db) {
            const pResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const pData = await pResp.json();

            if (pData && pData.status === 'approved' && pData.external_reference) {
                const ref = JSON.parse(pData.external_reference);
                const torneo = db.torneos?.[ref.torneoId];
                if (torneo && torneo.cupos?.[ref.cat]) {
                    const cupo = torneo.cupos[ref.cat].find(x => x.id === Number(ref.box));
                    if (cupo) {
                        cupo.ocupado = true;
                        cupo.estadoPagoMP = 'PAGADO_MP';
                        cupo.expiraReservaTimestamp = 0;
                        db.lastUpdated = Date.now();
                        guardarEstadoDB(db);
                        broadcastSync('mp_payment_approved');
                    }
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

app.listen(PORT, () => {
    console.log(`CIRCUITO360.CL corriendo en puerto ${PORT}`);
});
