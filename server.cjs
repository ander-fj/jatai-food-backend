const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Configura o CORS para permitir origens específicas do frontend
const allowedOrigins = ['https://www.jataifood.com.br', 'https://jataifood-alpha.vercel.app'];
app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem 'origin' (como de apps mobile ou Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'A política de CORS para este site não permite acesso da origem especificada.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));
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
        if (clients[id]) {
            clients[id].status = 'DISCONNECTED';
            // Remove o cliente para permitir uma nova inicialização
            delete clients[id];
        }
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
    
    if (clients[clientId] && (clients[clientId].status === 'READY' || clients[clientId].status === 'QR_RECEIVED')) {
        return res.status(200).json({ message: 'Cliente já inicializado ou aguardando QR code.', status: clients[clientId].status });
    }

    console.log(`Iniciando cliente ${clientId}`);
    const client = createClient(clientId);

    client.initialize().catch(err => {
        console.error(`Falha ao inicializar cliente ${clientId}:`, err);
        if (clients[clientId]) {
            clients[clientId].status = 'FAILED';
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
        res.status(404).json({ message: 'QR code não disponível.' });
    }
});

// Endpoint para verificar o status do cliente
app.get('/api/whatsapp/status/:clientId', async (req, res) => {
    const clientId = req.params.clientId;
    const clientData = clients[clientId];

    if (clientData) {
        // Usa o status que mantemos internamente, que é atualizado pelos eventos do cliente
        res.status(200).json({ status: clientData.status });
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