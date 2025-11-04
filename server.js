import express from 'express';
import cors from 'cors';
import { Client, NoAuth } from 'whatsapp-web.js'; // Alterado de LocalAuth para NoAuth
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

app.get('/api/whatsapp/start/:id', (req, res) => {
    const { id } = req.params;

    if (clients[id]) {
        console.log(`Sessão para ${id} já existe.`);
        return res.json({ status: 'already-started', message: 'Sessão já iniciada.' });
    }

    console.log(`Iniciando sessão para o ID: ${id}`);

    // ====================================================================
    // ALTERAÇÃO PRINCIPAL: Removida a estratégia de autenticação local
    // ====================================================================
    const client = new Client({
        authStrategy: new NoAuth(), // Usando NoAuth para manter a sessão apenas em memória
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true, // Garante que o navegador rode sem interface gráfica
        },
    });
    // ====================================================================

    clients[id] = client;

    client.on('qr', (qr) => {
        console.log(`QR Code gerado para ${id}`);
        // A rota de status vai lidar com o envio do QR
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

app.get('/api/whatsapp/status/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];

    if (!client) {
        return res.json({ status: 'disconnected', qr: null });
    }

    // Função para enviar o QR code
    const sendQr = (qr) => {
        if (!res.headersSent) {
            res.json({ status: 'qr', qr: qr });
        }
    };

    // Se o QR já foi gerado, ele será pego aqui.
    client.once('qr', sendQr);

    client.getState().then(state => {
        if (state === 'CONNECTED') {
            client.removeListener('qr', sendQr); // Remove o listener se já estiver conectado
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

    // Timeout para garantir uma resposta
    setTimeout(() => {
        client.removeListener('qr', sendQr);
        if (!res.headersSent) {
            res.json({ status: 'waiting', qr: null });
        }
    }, 10000);
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Exporta o app para o Vercel
export default app;
