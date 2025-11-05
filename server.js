import express from 'express';
import cors from 'cors';
import { Client } from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const app = express();

// =======================================================
// CONFIGURAÇÕES DE CORS
// =======================================================
const corsOptions = {
  origin: [
    'https://www.jataifood.com.br',
    'https://jataifood.vercel.app',
    'http://localhost:5173'
  ],
};
app.use(cors(corsOptions));

const clients = {};
const qrStore = {};

// =======================================================
// ROTA PARA INICIAR CLIENTE WHATSAPP
// =======================================================
app.post('/api/whatsapp/start/:id', (req, res) => {
  const { id } = req.params;

  if (clients[id]) {
    console.log(`(${id}) Cliente já iniciado.`);
    return res.json({ status: 'already-started' });
  }

  console.log(`🚀 Iniciando sessão para o ID: ${id}`);
  qrStore[id] = null; // Limpa QR antigo

  const client = new Client({
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    },
  });

  clients[id] = client;

  // =======================================================
  // EVENTOS DO WHATSAPP WEB.JS
  // =======================================================
  client.on('loading_screen', (percent, message) => {
    console.log(`(${id}) Carregando WhatsApp: ${percent}% - ${message}`);
  });

  client.on('qr', (qr) => {
    console.log(`✅ (${id}) QR Code gerado com sucesso.`);
    qrStore[id] = qr;
  });

  client.on('authenticated', () => {
    console.log(`🔐 (${id}) Autenticado com sucesso.`);
  });

  client.on('auth_failure', msg => {
    console.error(`❌ (${id}) Falha na autenticação:`, msg);
  });

  client.on('ready', () => {
    console.log(`🤖 (${id}) Cliente pronto e conectado!`);
    delete qrStore[id];
  });

  client.on('disconnected', (reason) => {
    console.log(`⚠️ (${id}) Cliente desconectado: ${reason}`);
    if (clients[id]) {
      clients[id].destroy();
      delete clients[id];
    }
    delete qrStore[id];
  });

  console.log(`Inicializando cliente WhatsApp para ${id}...`);
  client.initialize().then(() => {
    console.log(`(${id}) Inicialização enviada para o cliente.`);
  }).catch(err => {
    console.error(`💥 (${id}) Erro ao inicializar cliente:`, err);
  });

  res.json({ status: 'starting' });
});

// =======================================================
// ROTA PARA OBTER QR CODE
// =======================================================
app.get('/api/whatsapp/qr/:id', async (req, res) => {
  const { id } = req.params;
  const qr = qrStore[id];

  if (qr) {
    try {
      // Converter QR code de texto para data URL (imagem)
      const qrDataUrl = await QRCode.toDataURL(qr);
      console.log(`📲 Enviando QR Code como imagem para o frontend (ID: ${id})`);
      return res.json({ status: 'qr', qr: qrDataUrl });
    } catch (error) {
      console.error(`❌ (${id}) Erro ao gerar QR code:`, error);
      return res.status(500).json({ error: 'Erro ao gerar QR code' });
    }
  } else {
    return res.status(404).json({ status: 'aguardando' });
  }
});

// =======================================================
// ROTA PARA STATUS DO CLIENTE
// =======================================================
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

// =======================================================
// INICIALIZA SERVIDOR
// =======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});