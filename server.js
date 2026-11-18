const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'circuito360_db.json');

// Tu Access Token de Producción oficial pre-cargado como respaldo automático
const DEFAULT_MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-6343439635613247-111721-d62e99775b7b52b629d88e2540c6e3dd-2521587898';

app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});
app.use(express.static(__dirname));

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

// 1. Entregar siempre el estado central en vivo a todos los celulares y PCs
app.get('/api/state', (req, res) => {
    const data = leerEstadoDB();
    if (!data) return res.status(404).json({ ok: false });
    res.json(data);
});

// 2. Guardar cualquier cambio de fechas, canchas o inscripciones en tiempo real
app.post('/api/state', (req, res) => {
    if (req.body && req.body.torneos) {
        req.body.lastUpdated = Date.now();
        guardarEstadoDB(req.body);
        return res.json({ ok: true, lastUpdated: req.body.lastUpdated });
    }
    res.status(400).json({ ok: false });
});

// 3. Crear cobro real en Mercado Pago Checkout Pro
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
    } = req.body;

    const db = leerEstadoDB();
    const tokenEnTorneo = db?.torneos?.[torneoId]?.config?.mpAccessToken;
    const linkEnTorneo = db?.torneos?.[torneoId]?.config?.linkPago;

    // Si pegaste APP_USR en la casilla de Enlace Mercado Pago, el servidor lo detecta como Token automáticamente
    let token = DEFAULT_MP_TOKEN;
    if (mpAccessToken && mpAccessToken.trim().startsWith('APP_USR-')) {
        token = mpAccessToken.trim();
    } else if (tokenEnTorneo && tokenEnTorneo.trim().startsWith('APP_USR-')) {
        token = tokenEnTorneo.trim();
    } else if (fallbackLink && fallbackLink.includes('APP_USR-')) {
        token = fallbackLink.replace(/^https?:\/\//i, '').trim();
    } else if (linkEnTorneo && linkEnTorneo.includes('APP_USR-')) {
        token = linkEnTorneo.replace(/^https?:\/\//i, '').trim();
    }

    try {
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;

        const preferenceBody = {
            items: [{
                id: String(folioMP || `BOX-${boxId}`),
                title: `Inscripcion ${nombreTorneo || 'Torneo Padel'} - ${categoriaNombre || 'Categoria'} (Box #${boxId}: ${aliasDupla || 'Dupla'})`,
                quantity: 1,
                currency_id: 'CLP',
                unit_price: Math.max(100, Math.round(Number(monto) || 70000))
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
        } else {
            console.error('Respuesta error MP:', JSON.stringify(mpData));
            return res.status(400).json({ ok: false, error: mpData?.message || 'Error al crear preferencia en MP' });
        }
    } catch (err) {
        console.error('Excepción MP:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// 4. Webhook Oficial de Mercado Pago: Pasa el Box a ROJO en todos los equipos al aprobarse el pago
app.post('/api/mp/webhook', async (req, res) => {
    try {
        const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
        const db = leerEstadoDB();
        const token = DEFAULT_MP_TOKEN;

        if (paymentId && token) {
            const pResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const pData = await pResp.json();

            if (pData && pData.status === 'approved' && pData.external_reference && db) {
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
