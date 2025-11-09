const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Inicializa o cliente do WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    // Gera e exibe o QR code no terminal
    qrcode.generate(qr, { small: true });
    console.log('QR CODE RECEIVED', qr);
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', message => {
	if(message.body === '!ping') {
		message.reply('pong');
	}
});

client.initialize();

app.get('/', (req, res) => {
    res.send('<h1>Servidor Jatai Food Backend está rodando.</h1><p>O cliente do WhatsApp está inicializando...</p>');
});

app.get('/api/whatsapp/status/:clientId', async (req, res) => {
    try {
        const state = await client.getState();
        res.status(200).json({ status: state });
    } catch (error) {
        console.error('Error getting client state:', error);
        res.status(500).json({ status: 'error', message: 'Could not get client state.' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
