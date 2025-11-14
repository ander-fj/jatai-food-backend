const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 3000;

const allowedOrigins = [
    'https://www.jataifood.com.br',
    'https://jataifood-alpha.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'https://jatai-food.vercel.app',
    'https://jatai-food-backend.onrender.com'
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

// Endpoint para enviar mensagens usando o WhatsApp Cloud API
app.post('/api/whatsapp/cloud/send', async (req, res) => {
    const { to, message } = req.body;
    const WABA_ID = process.env.WABA_ID; // ID da sua Conta do WhatsApp Business
    const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ID do número de telefone de origem
    const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // O seu token de acesso

    if (!to || !message || !WABA_ID || !PHONE_NUMBER_ID || !ACCESS_TOKEN) {
        return res.status(400).json({ message: 'Faltam parâmetros obrigatórios (to, message) ou variáveis de ambiente (WABA_ID, PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN).' });
    }

    try {
        const response = await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: to,
            type: 'text',
            text: { body: message }
        }, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });
        res.status(200).json({ message: 'Mensagem enviada com sucesso!', data: response.data });
    } catch (error) {
        console.error('Erro ao enviar mensagem via Cloud API:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Falha ao enviar mensagem.', error: error.response ? error.response.data : error.message });
    }
});

// Endpoint de Webhook para a API do WhatsApp Cloud
// Usado para verificação e para receber mensagens
app.all('/api/whatsapp/webhook', (req, res) => {
    // Parte 1: Verificação do Webhook (GET)
    if (req.method === 'GET' && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verificado com sucesso!');
        res.status(200).send(req.query['hub.challenge']);
        return;
    }

    // Parte 2: Recebimento de notificações (POST)
    if (req.method === 'POST') {
        console.log('Notificação de webhook recebida:', JSON.stringify(req.body, null, 2));

        // Extrai a mensagem do corpo da requisição
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (message) {
            const from = message.from; // Número de quem enviou a mensagem
            const msg_body = message.text.body; // Conteúdo da mensagem

            console.log(`Mensagem de ${from}: ${msg_body}`);

            // Aqui você pode adicionar sua lógica para processar a mensagem recebida.
            // Por exemplo, responder automaticamente:
            // await axios.post(...);
        }

        res.sendStatus(200);
        return;
    }

    // Se não for GET para verificação ou POST de notificação
    res.sendStatus(403);
});

app.get('/', (req, res) => {
    res.send('<h1>Servidor Jatai Food Backend está rodando.</h1>');
});

app.listen(port, () => {
    console.log(`Servidor escutando na porta ${port}`);
});

// Exporta o app para ser usado por provedores de hospedagem como Vercel
module.exports = app;
