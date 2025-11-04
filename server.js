import express from 'express';
import cors from 'cors';
import { Client } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const app = express();

const corsOptions = {
  origin: [
    'https://www.jataifood.com.br', 
    'https://jataifood.vercel.app',
    'http://localhost:5173'
  ]
};
app.use(cors(corsOptions ));

const clients = {};

// ====================================================================
// CORREÇÃO FINAL: Mudando de app.get para app.post
// ====================================================================
app.post('/api/whatsapp/start/:id', (req, res) => {
// ====================================================================
    const { id } = req.params;

    if (clients[id]) {
        console.log(`Sessão para ${id} já existe.`);
        return res.json({ status: 'already-started', message: 'Sessão já iniciada.' });
    }

    console.log(`Iniciando sessão para o ID: ${id}`);

    const client = new Client({
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
        },
    });

    clients[id] = client;

    client.on('qr', (qr) => {
        console.log(`QR Code gerado para ${id}`);
    });

    client.on('ready', () => {
        console.log(`Cliente ${id} está pronto!`);
    });

    client.on('auth_failure', msg => {
        console.error(`Falha na autenticação para ${id}:`, msg);
        if (clients[id]) {
            clients[id].destroy();
            delete clients[id];
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente ${id} foi desconectado:`, reason);
        if (clients[id]) {
            clients[id].destroy();
            delete clients[id];
        }
    });

    client.initialize().catch(err => {
        console.error(`Erro ao inicializar cliente ${id}:`, err);
        if (clients[id]) {
            delete clients[id];
        }
    });

    res.json({ status: 'starting', message: 'Iniciando sessão do WhatsApp. Aguarde o QR Code.' });
});

// A rota de status é GET, o que está correto.
app.get('/api/whatsapp/status/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];

    if (!client) {
        return res.json({ status: 'disconnected', qr: null });
    }

    const sendQr = (qr) => {
        if (!res.headersSent) {
            res.json({ status: 'qr', qr: qr });
        }
    };

    client.once('qr', sendQr);

    client.getState().then(state => {
        if (state === 'CONNECTED') {
            client.removeListener('qr', sendQr);
            if (!res.headersSent) {
                res.json({ status: 'connected', qr: null });
            }
        }
    }).catch(() => {
        client.removeListener('qr', sendQr);
        if (!res.headersSent) {
            res.json({ status: 'disconnected', qr: null });
        }
    });

    setTimeout(() => {
        client.removeListener('qr', sendQr);
        if (!res.headersSent) {
            res.json({ status: 'waiting', qr: null });
        }
    }, 10000);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
