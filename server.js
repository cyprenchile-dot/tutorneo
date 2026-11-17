const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'circuito360_db.json');

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

function leerEstadoDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {}
    return null;
}

function guardarEstadoDB(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {}
}

// 1. Obtener el estado centralizado para todos los teléfonos y el Admin
app.get('/api/state', (req, res) => {
    const data = leerEstadoDB();
    if (!data) return res.status(404).json({ ok: false });
    res.json(data);
});

// 2. Guardar cualquier cambio en tiempo real
app.post('/api/state', (req, res) => {
    if (req.body && req.body.torneos) {
        req.body.lastUpdated = Date.now();
        guardarEstadoDB(req.body);
        return res.json({ ok: true, lastUpdated: req.body.lastUpdated });
    }
    res.status(400).json({ ok: false });
});

// 3. Crear Preferencia Oficial en Mercado Pago Checkout Pro con retorno verificado
app.post('/api/mp/create-preference', async (req, res) => {
    const { torneoId, nombreTorneo, categoriaKey, categoriaNombre, boxId, aliasDupla, monto, folioMP, mpAccessToken, fallbackLink } = req.body;
    const token = (mpAccessToken && mpAccessToken.trim()) || process.env.MP_ACCESS_TOKEN;

    if (!token) {
        return res.json({ init_point: fallbackLink || 'https://www.mercadopago.cl' });
    }

    try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const preferenceBody = {
            items: [{
                id: folioMP,
                title: `Inscripción ${nombreTorneo} - ${categoriaNombre} (Box #${boxId}: ${aliasDupla})`,
                quantity: 1,
                currency_id: 'CLP',
                unit_price: Number(monto) || 70000
            }],
            external_reference: JSON.stringify({ torneoId, cat: categoriaKey, box: Number(boxId), folioMP }),
            back_urls: {
                success: `${baseUrl}/?torneo=${torneoId}&cat=${categoriaKey}&box=${boxId}&mp_status=approved`,
                failure: `${baseUrl}/?torneo=${torneoId}&cat=${categoriaKey}&box=${boxId}&mp_status=failure`,
                pending: `${baseUrl}/?torneo=${torneoId}&cat=${categoriaKey}&box=${boxId}&mp_status=pending`
            },
            auto_return: 'approved',
            notification_url: `${baseUrl}/api/mp/webhook`
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
        if (mpData && mpData.init_point) {
            return res.json({ init_point: mpData.init_point });
        }
    } catch (err) {}

    res.json({ init_point: fallbackLink || 'https://www.mercadopago.cl' });
});

// 4. Webhook Oficial de Mercado Pago: Pasa el Box a ROJO (PAGADO_MP) solo cuando el dinero ingresa
app.post('/api/mp/webhook', async (req, res) => {
    try {
        const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
        const token = process.env.MP_ACCESS_TOKEN;
        if (paymentId && token) {
            const pResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const pData = await pResp.json();
            if (pData && pData.status === 'approved' && pData.external_reference) {
                const ref = JSON.parse(pData.external_reference);
                const db = leerEstadoDB();
                if (db && db.torneos && db.torneos[ref.torneoId]) {
                    const cuposCat = db.torneos[ref.torneoId].cupos[ref.cat] || [];
                    const cupo = cuposCat.find(x => x.id === Number(ref.box));
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
    } catch (e) {}
    res.sendStatus(200);
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`CIRCUITO360.CL corriendo en puerto ${PORT}`);
});
