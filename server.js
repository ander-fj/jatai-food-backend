import express from 'express';
import cors from 'cors';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const app = express();

// =========================
// 🔐 CORS CONFIG
// =========================
const corsOptions = {
  origin: [
    'https://www.jataifood.com.br',
    'https://jataifood.vercel.app',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.use(express.json());

// =========================
// 🔧 Variáveis
// =========================
const clients = {};
const qrStore = {};

// =========================
// 🚀 Iniciar sessão
// =========================
app.post('/api/whatsapp/start/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (clients[id]) {
      console.log(`⚠️ Sessão ${id} já está ativa.`);
      return res.json({ status: 'already-started' });
    }

    console.log(`🚀 Iniciando sessão para ID: ${id}`);
    qrStore[id] = null;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: id }),
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
        ],
        headless: true,
      },
    });

    clients[id] = client;

    client.on('qr', (qr) => {
      console.log(`✅ QR Code gerado para ${id}`);
      qrStore[id] = qr;
    });

    client.on('ready', () => {
      console.log(`🎉 Cliente ${id} conectado e pronto!`);
      delete qrStore[id];
    });

    client.on('disconnected', (reason) => {
      console.log(`⚠️ Cliente ${id} desconectado:`, reason);
      if (clients[id]) clients[id].destroy();
      delete clients[id];
      delete qrStore[id];
    });

    await client.initialize();

    return res.json({ status: 'starting' });
  } catch (err) {
    console.error('❌ Erro ao iniciar sessão:', err);
    res.status(500).json({ error: 'Erro ao iniciar cliente WhatsApp' });
  }
});

// =========================
// 🧾 Buscar QR Code
// =========================
app.get('/api/whatsapp/qr/:id', (req, res) => {
  const { id } = req.params;
  const qr = qrStore[id];

  if (qr) {
    console.log(`📤 Enviando QR code para o frontend (ID: ${id})`);
    return res.json({ status: 'qr', qr });
  }

  return res.status(404).json({ status: 'waiting' });
});

// =========================
// 🟢 Status da sessão
// =========================
app.get('/api/whatsapp/status/:id', (req, res) => {
  const { id } = req.params;
  const client = clients[id];

  if (client && client.info) {
    return res.json({ status: 'connected' });
  }

  if (qrStore[id]) {
    return res.json({ status: 'pending_qr' });
  }

  return res.json({ status: 'disconnected' });
});

// =========================
// 🔥 Health Check
// =========================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// =========================
// 🚀 Iniciar servidor
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
