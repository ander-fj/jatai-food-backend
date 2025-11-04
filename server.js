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
const qrStore = {}; // Objeto para armazenar o QR code temporariamente

// Rota para iniciar a sessão (POST) - CORRETO
app.post('/api/whatsapp/start/:id', (req, res) => {
    const { id } = req.params;

    if (clients[id]) {
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
        qrStore[id] = qr; // Armazena o QR code
    });

    client.on('ready', () => {
        console.log(`Cliente ${id} está pronto!`);
        delete qrStore[id]; // Limpa o QR code depois de conectar
    });

    client.on('auth_failure', msg => {
        console.error(`Falha na autenticação para ${id}:`, msg);
        if (clients[id]) { clients[id].destroy(); delete clients[id]; }
        delete qrStore[id];
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente ${id} foi desconectado:`, reason);
        if (clients[id]) { clients[id].destroy(); delete clients[id]; }
        delete qrStore[id];
    });

    client.initialize().catch(err => {
        console.error(`Erro ao inicializar cliente ${id}:`, err);
        if (clients[id]) { delete clients[id]; }
        delete qrStore[id];
    });

    res.json({ status: 'starting', message: 'Iniciando sessão do WhatsApp. Aguarde o QR Code.' });
});

// ====================================================================
// NOVA ROTA: /api/whatsapp/qr/:id
// O frontend vai chamar esta rota para buscar o QR code.
// ====================================================================
app.get('/api/whatsapp/qr/:id', (req, res) => {
    const { id } = req.params;
    const qr = qrStore[id];

    if (qr) {
        res.json({ status: 'qr', qr: qr });
    } else {
        // Se não houver QR, pode ser que já conectou ou ainda não foi gerado
        const client = clients[id];
        if (client) {
            client.getState().then(state => {
                if (state === 'CONNECTED') {
                    res.json({ status: 'connected', qr: null });
                } else {
                    res.status(404).json({ status: 'waiting', message: 'Aguardando geração do QR code.' });
                }
            }).catch(() => res.status(500).json({ status: 'error', message: 'Erro ao obter estado do cliente.' }));
        } else {
            res.status(404).json({ status: 'disconnected', message: 'Sessão não encontrada.' });
        }
    }
});
// ====================================================================


// Rota de status (GET) - CORRETO
app.get('/api/whatsapp/status/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];

    if (!client) {
        return res.json({ status: 'disconnected' });
    }

    client.getState().then(state => {
        res.json({ status: state === 'CONNECTED' ? 'connected' : 'pending' });
    }).catch(() => {
        res.json({ status: 'disconnected' });
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
