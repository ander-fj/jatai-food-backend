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
const qrStore = {}; 

app.post('/api/whatsapp/start/:id', (req, res) => {
    const { id } = req.params;

    if (clients[id]) {
        return res.json({ status: 'already-started' });
    }

    console.log(`Iniciando sessão para o ID: ${id}`);
    qrStore[id] = null; // Limpa QR antigo ao iniciar

    const client = new Client({
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
        },
    });

    clients[id] = client;

    client.on('qr', (qr) => {
        console.log(`QR Code gerado para ${id}`);
        qrStore[id] = qr; 
    });

    client.on('ready', () => {
        console.log(`Cliente ${id} está pronto!`);
        delete qrStore[id]; 
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente ${id} foi desconectado:`, reason);
        if (clients[id]) { clients[id].destroy(); delete clients[id]; }
        delete qrStore[id];
    });

    client.initialize().catch(err => {
        console.error(`Erro ao inicializar cliente ${id}:`, err);
    });

    res.json({ status: 'starting' });
});

// ====================================================================
// ROTA /qr/ SIMPLIFICADA E CORRIGIDA
// ====================================================================
app.get('/api/whatsapp/qr/:id', (req, res) => {
    const { id } = req.params;
    const qr = qrStore[id];

    if (qr) {
        // Se temos um QR code, enviamos.
        console.log(`Enviando QR code para o frontend (ID: ${id})`);
        res.json({ status: 'qr', qr: qr });
    } else {
        // Se não temos, simplesmente dizemos que não foi encontrado ainda.
        // O frontend continuará tentando.
        res.status(404).json({ status: 'waiting' });
    }
});
// ====================================================================

app.get('/api/whatsapp/status/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];
    
    // Esta rota agora só verifica se o cliente existe (conectado ou não)
    if (client && client.info) {
        return res.json({ status: 'connected' });
    }
    
    // Se o QR existe, significa que está pendente
    if (qrStore[id]) {
        return res.json({ status: 'pending_qr' });
    }

    return res.json({ status: 'disconnected' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
