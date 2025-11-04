import express from 'express';
import cors from 'cors';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const app = express();

// ====================================================================
// CONFIGURAÇÃO DO CORS
// Isso permite que seu site (frontend) faça requisições para este servidor (backend).
// ====================================================================
const corsOptions = {
  origin: [
    'https://www.jataifood.com.br', 
    'https://jataifood.vercel.app',
    'http://localhost:5173' // Adicionado para facilitar testes locais no futuro
  ]
};

// Aplica o middleware do CORS em todas as rotas
app.use(cors(corsOptions ));
// ====================================================================

// Objeto para armazenar as instâncias do cliente do WhatsApp por ID
const clients = {};

// Rota para iniciar uma nova sessão do WhatsApp
app.get('/api/whatsapp/start/:id', (req, res) => {
    const { id } = req.params;

    if (clients[id] && clients[id].info) {
        return res.json({ status: 'already-started', message: 'Sessão já iniciada.' });
    }

    console.log(`Iniciando sessão para o ID: ${id}`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    clients[id] = client;

    client.on('qr', (qr) => {
        console.log(`QR Code para ${id}:`, qr);
        // Não enviamos o QR aqui, o frontend vai pegar pela rota de status
    });

    client.on('ready', () => {
        console.log(`Cliente ${id} está pronto!`);
    });

    client.on('auth_failure', msg => {
        console.error(`Falha na autenticação para ${id}:`, msg);
        delete clients[id];
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente ${id} foi desconectado:`, reason);
        client.destroy();
        delete clients[id];
    });

    client.initialize().catch(err => {
        console.error(`Erro ao inicializar cliente ${id}:`, err);
        delete clients[id];
    });

    res.json({ status: 'starting', message: 'Iniciando sessão do WhatsApp. Aguarde o QR Code.' });
});

// Rota para verificar o status da conexão e obter o QR code
app.get('/api/whatsapp/status/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];

    if (!client) {
        return res.json({ status: 'disconnected', qr: null });
    }

    // Usamos um pequeno truque para pegar o QR code que já foi gerado
    client.once('qr', (qr) => {
        res.json({ status: 'qr', qr: qr });
    });

    // Se já estiver conectado, informa o status
    client.getState().then(state => {
        if (state === 'CONNECTED') {
            res.json({ status: 'connected', qr: null });
        }
        // Se não estiver conectado e o evento 'qr' não disparar em 5s,
        // respondemos que está desconectado para o frontend não ficar esperando para sempre.
        setTimeout(() => {
            if (!res.headersSent) {
                res.json({ status: 'disconnected', qr: null });
            }
        }, 5000);
    }).catch(() => {
        if (!res.headersSent) {
            res.json({ status: 'disconnected', qr: null });
        }
    });
});

// Rota para fazer logout
app.get('/api/whatsapp/logout/:id', (req, res) => {
    const { id } = req.params;
    const client = clients[id];

    if (client) {
        client.logout().then(() => {
            console.log(`Logout realizado para o cliente ${id}`);
            delete clients[id];
            res.json({ status: 'success', message: 'Logout realizado com sucesso.' });
        }).catch(err => {
            console.error(`Erro ao fazer logout para ${id}:`, err);
            res.status(500).json({ status: 'error', message: 'Erro ao fazer logout.' });
        });
    } else {
        res.status(404).json({ status: 'error', message: 'Sessão não encontrada.' });
    }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
