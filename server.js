const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

const allowedOrigins = [
    'https://www.jataifood.com.br',
    'https://jataifood-alpha.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'https://jatai-food.vercel.app'
];

const corsOptions = {
    origin: function (origin, callback) {
        console.log('Request Origin:', origin);
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
};

app.use(cors(corsOptions));
app.use(express.json());

// Estrutura para armazenar clientes e seus status
const clients = {};

function createClient(id) {
    console.log(`Criando cliente: ${id}`);
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`QR Code recebido para o cliente ${id}`);
        if (clients[id]) {
            clients[id].qr = qr;
            clients[id].status = 'QR_RECEIVED';
        }
    });

    client.on('ready', () => {
        console.log(`Cliente ${id} está pronto!`);
        if (clients[id]) {
            clients[id].status = 'READY';
            clients[id].qr = null; // Limpa o QR code após a conexão
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log(`Cliente ${id} foi desconectado:`, reason);
        // Em vez de deletar, apenas marcamos como desconectado.
        // A sessão LocalAuth ainda existe, então uma nova inicialização pode ser mais rápida.
        if (clients[id]) {
            clients[id].status = 'DISCONNECTED';
        }
        // Opcional: Implementar lógica de reconexão aqui se desejado.
        // Por exemplo, tentar client.initialize() novamente após um tempo.
        // Por simplicidade, vamos manter a necessidade de uma nova chamada na API /start.
        delete clients[id]; // Mantendo o comportamento original de remover para forçar reinicialização.
    });

    client.on('message', message => {
        if(message.body === '!ping') {
            message.reply('pong');
        }
    });

    clients[id] = {
        client: client,
        id: id,
        status: 'INITIALIZING',
        qr: null
    };
    
    return client;
}

// Endpoint para iniciar a inicialização do cliente
app.post('/api/whatsapp/start/:clientId', (req, res) => {
    const clientId = req.params.clientId;

    // Higienização básica do clientId para garantir que seja um nome de arquivo/diretório seguro.
    const safeClientId = path.normalize(clientId).replace(/^(\.\.[\/\\])+/, '');
    if (safeClientId !== clientId) {
        return res.status(400).json({ message: 'ClientId inválido.' });
    }
    
    if (clients[clientId] && (clients[clientId].status === 'READY' || clients[clientId].status === 'QR_RECEIVED')) {
        return res.status(200).json({ message: 'Cliente já inicializado ou aguardando QR code.', status: clients[clientId].status });
    }

    console.log(`Iniciando cliente ${clientId}`);
    const client = createClient(clientId);

    client.initialize().catch(err => {
        console.error(`Falha ao inicializar cliente ${clientId}:`, err.message);
        if (clients[clientId]) {
            clients[clientId].status = 'FAILED';
            clients[clientId].error = err.message;
        }
    });

    res.status(202).json({ message: 'A inicialização do cliente foi iniciada.' });
});

// Endpoint para buscar o QR code
app.get('/api/whatsapp/qr/:clientId', (req, res) => {
    const clientId = req.params.clientId;
    const clientData = clients[clientId];

    if (clientData && clientData.qr) {
        res.status(200).json({ qr: clientData.qr });
    } else {
        res.status(404).json({ message: 'QR code não disponível. Verifique o status do cliente.' });
    }
});

// Endpoint para verificar o status do cliente
app.get('/api/whatsapp/status/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    const clientData = clients[clientId];

    if (clientData) {
        res.status(200).json({ 
            status: clientData.status,
            // Se houver um erro, envie a mensagem de erro para o cliente.
            error: clientData.error || null 
        });
    } else {
        res.status(404).json({ status: 'NOT_INITIALIZED' });
    }
});

app.get('/', (req, res) => {
    res.send('<h1>Servidor Jatai Food Backend está rodando.</h1>');
});

app.listen(port, () => {
    console.log(`Servidor escutando na porta ${port}`);
});

// Exporta o app para ser usado por provedores de hospedagem como Vercel
module.exports = app;
