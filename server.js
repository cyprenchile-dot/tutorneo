const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Crítico en Render para detectar HTTPS correctamente

const PORT = process.env.PORT || 10000;
const DB_FILE = path.join(__dirname, 'circuito360_db.json');

app.use(express.json({ limit: '15mb' }));
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

// 1. Obtener estado centralizado para todos los dispositivos
app.get('/api/state', (req, res) => {
    const data = leerEstadoDB();
    if (!data) return res.status(404).json({ ok: false });
    res.json(data);
});

// 2. Guardar cambios sincronizados en tiempo real
app.post('/api/state', (req, res) => {
    if (req.body && req.body.torneos) {
        req.body.lastUpdated = Date.now();
        guardarEstadoDB(req.body);
        return res.json({ ok: true, lastUpdated: req.body.lastUpdated });
    }
    res.status(400).json({ ok: false });
});

// 3. Crear Preferencia Oficial en Mercado Pago Checkout Pro
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

    // Buscar token en la petición, en la DB del torneo o en las variables de Render
    const db = leerEstadoDB();
    const tokenGuardadoEnTorneo = db?.torneos?.[torneoId]?.config?.mpAccessToken;
    const token = (mpAccessToken && mpAccessToken.trim()) ||
                  (tokenGuardadoEnTorneo && tokenGuardadoEnTorneo.trim()) ||
                  process.env.MP_ACCESS_TOKEN;

    // Si no hay Access Token configurado, usar el Link de Pago directo (mpago.la)
    if (!token) {
        console.log('Sin Access Token MP. Usando link directo:', fallbackLink);
        return res.json({ init_point: fallbackLink || 'https://www.mercadopago.cl', mode: 'link' });
    }

    try {
        // Forzar https en producción para que Mercado Pago acepte auto_return
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;

        const preferenceBody = {
            items: [{
                id: String(folioMP || `BOX-${boxId}`),
                title: `Inscripcion ${nombreTorneo} - ${categoriaNombre} (Box #${boxId}: ${aliasDupla})`,
                quantity: 1,
                currency_id: 'CLP',
                unit_price: Math.round(Number(monto) || 70000)
            }],
            external_reference: JSON.stringify({
                torneoId,
                cat: categoriaKey,
                box: Number(boxId),
                folioMP
            }),
            back_urls: {
                success: `${baseUrl}/?torneo=${encodeURIComponent(torneoId)}&cat=${encodeURIComponent(categoriaKey)}&box=${boxId}&mp_status=approved`,
                failure: `${baseUrl}/?neo=${encodeURIComponent(torneoId)}&cat=${encodeURIComponent(categoriaKey)}&box=${boxId}&mp_status=failure`,
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
            return res.json({ init_point: mpData.init_point, mode: 'api' });
        } else {
            console.error('Error devuelto por Mercado Pago API:', JSON.stringify(mpData));
        }
    } catch (err) {
        console.error('Excepción al conectar con Mercado Pago:', err.message);
    }

    res.json({ init_point: fallbackLink || 'https://www.mercadopago.cl', mode: 'fallback' });
});

// 4. Webhook Oficial de Mercado Pago: Pasa el Box a ROJO (PAGADO_MP) automáticamente
app.post('/api/mp/webhook', async (req, res) => {
    try {
        const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
        const torneoIdQuery = req.query?.torneoId;
        const db = leerEstadoDB();

        let token = process.env.MP_ACCESS_TOKEN;
        if (!token && db && torneoIdQuery && db.torneos?.[torneoIdQuery]?.config?.mpAccessToken) {
            token = db.torneos[torneoIdQuery].config.mpAccessToken.trim();
        }
        // Si aún no hay token, buscar en cualquier torneo activo de la DB
        if (!token && db && db.torneos) {
            const tConToken = Object.values(db.torneos).find(t => t.config?.mpAccessToken);
            if (tConToken) token = tConToken.config.mpAccessToken.trim();
        }

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
                        console.log(`Pago aprobado Webhook MP: Torneo ${ref.torneoId}, Box #${ref.box}`);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error en Webhook MP:', e.message);
    }
    res.sendStatus(200);
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`CIRCUITO360.CL corriendo en puerto ${PORT}`);
});
