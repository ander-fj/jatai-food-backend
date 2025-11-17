const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');
 
const requiredEnvVars = [
  'MONGO_URI',
  'GEMINI_API_KEY',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];
 
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
 
if (missingEnvVars.length > 0) {
  console.error('\n[ERRO CRÍTICO] As seguintes variáveis de ambiente essenciais não foram encontradas:');
  missingEnvVars.forEach(v => console.error(`- ${v}`));
  console.error('\nPor favor, configure-as no seu ambiente de produção (ex: Render Environment Variables) ou no arquivo .env para desenvolvimento local.\n');
  process.exit(1);
}

// --- VERIFICAÇÃO E CONEXÃO COM O BANCO DE DADOS ---
const MONGO_URI = process.env.MONGO_URI;

// Conexão com o MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Conexão com MongoDB estabelecida com sucesso!'))
  .catch(err => {
    console.error('ERRO ao conectar ao MongoDB:', err);
    process.exit(1);
  });

// --- CONFIGURAÇÃO DO FIREBASE ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

// Inicializa o Firebase
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const app = express();
const port = process.env.PORT || 3001;

// --- CONFIGURAÇÃO DO CORS ---
const allowedOrigins = [
  'https://www.jataifood.com.br',
  'https://jatai-food-backend.onrender.com',
  'http://localhost:5173',
];

app.use(cors({
  origin: allowedOrigins
}));

app.use(express.json());

// Armazena as sessões dos clientes
const sessions = {};
const sessionChatMappings = {};
let chatSessions = {};

app.get('/', (req, res) => {
  res.send('Olá! Este é o servidor para o bot do WhatsApp.');
});

// Rota para verificar o status da conexão
app.get('/api/whatsapp/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const statusRef = ref(database, `tenants/${id}/session/status`);
    const snapshot = await get(statusRef);
    const status = snapshot.exists() ? snapshot.val() : 'disconnected';
    res.json({ status: status, message: `Sessão ${id} está ${status}.` });
  } catch (error) {
    console.error('Erro ao buscar status:', error);
    res.status(500).json({ status: 'disconnected', message: 'Erro ao buscar status.' });
  }
});

// Rota para obter o QR code
app.get('/api/whatsapp/qr/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const qrRef = ref(database, `tenants/${id}/session/qr`);
    const snapshot = await get(qrRef);
    if (snapshot.exists()) {
      res.json({ qr: snapshot.val() });
    } else {
      res.status(404).json({ error: 'QR code não encontrado.' });
    }
  } catch (error) {
    console.error('Erro ao buscar QR code:', error);
    res.status(500).json({ error: 'Erro ao buscar QR code.' });
  }
});

// Rota para iniciar a conexão do WhatsApp
app.post('/api/whatsapp/start/:id', async (req, res) => {
  const { id } = req.params;

  if (sessions[id]) {
    const statusRef = ref(database, `tenants/${id}/session/status`);
    const snapshot = await get(statusRef);
    if (snapshot.exists() && snapshot.val() === 'ready') {
      return res.status(200).json({ success: true, message: `Sessão ${id} já está conectada.` });
    }
  }

  console.log(`Iniciando conexão para a sessão: ${id}`);
  const statusRef = ref(database, `tenants/${id}/session/status`);
  const qrRef = ref(database, `tenants/${id}/session/qr`);
  await set(statusRef, 'INITIALIZING');

  try {
    // Configuração do MongoStore
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        clientId: id,
        dataPath: `./.wwebjs_auth/session-${id}`,
        backupSyncIntervalMs: 300000
      }),
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        headless: true,
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      }
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[Sessão ${id}] Carregando: ${percent}% - ${message}`);
    });

    client.on('authenticated', () => {
      console.log(`[Sessão ${id}] Autenticada com sucesso!`);
    });

    client.on('auth_failure', async (msg) => {
      console.error(`[Sessão ${id}] Falha na autenticação:`, msg);
      await set(statusRef, 'AUTH_FAILURE');
      await remove(qrRef);
    });

    client.on('qr', async (qr) => {
      console.log(`[Sessão ${id}] QR Code gerado`);
      qrcodeTerminal.generate(qr, { small: true });
      await set(statusRef, 'QR_CODE');
      qrcode.toDataURL(qr, async (err, url) => {
        if (!err) {
          await set(qrRef, url);
        }
      });
    });

    client.on('ready', async () => {
      console.log(`[Sessão ${id}] Conectada e pronta!`);
      await set(statusRef, 'ready');
      await remove(qrRef);
    });

    if (!sessionChatMappings[id]) {
      sessionChatMappings[id] = new Set();
    }

    client.on('message', async (message) => {
      if (message.fromMe) {
        return;
      }

      console.log(`[Sessão ${id}] Mensagem de ${message.from}: "${message.body}"`);

      try {
        const chatId = message.from;
        sessionChatMappings[id].add(chatId);

        let restaurantData = {};
        try {
          const configRef = ref(database, `tenants/${id}/whatsappConfig`);
          const snapshot = await get(configRef);
          if (snapshot.exists()) {
            restaurantData = snapshot.val();
          }
        } catch (dbError) {
          console.error(`[Sessão ${id}] Erro ao buscar configuração:`, dbError);
        }

        if (!restaurantData.isActive) {
          console.log(`[Sessão ${id}] Assistente desativado. Ignorando mensagem.`);
          return;
        }

        if (!chatSessions[chatId]) {
          console.log(`[Sessão ${id}] Iniciando nova sessão de chat para ${chatId}`);

          const systemInstruction = `
            Você é o assistente virtual do restaurante ${restaurantData.restaurantName || 'do nosso restaurante'}! Seu nome é Jataí.
            Sua personalidade é super divertida, animada e simpática! Use emojis para deixar a conversa mais legal. 🥳🍕✨
            Sua mensagem de boas-vindas é: "${restaurantData.welcomeMessage || 'Olá! Como posso te ajudar?'}"
            Sua missão é ajudar os clientes com um sorriso no rosto (virtual, claro!). Use as informações abaixo para responder:
            - Horário de funcionamento: ${restaurantData.hours || 'Não informado'}
            - Endereço (se perguntarem onde fica): ${restaurantData.address || 'Não informado'}
            - Link do Cardápio e Pedidos: ${restaurantData.menuUrl || 'Não informado'}
            - Telefone de contato: ${restaurantData.phoneNumber || 'Não informado'}
            IMPORTANTE: Ao enviar o link do cardápio, envie apenas a URL, sem formatação de link ou markdown. Por exemplo: https://seusite.com/cardapio
            NUNCA invente informações. Se não souber algo, diga algo como: "Opa, essa pergunta me pegou! Vou chamar um humano pra te ajudar, só um minutinho! 🧑‍🍳"
          `;

          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash-exp";
          const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
          chatSessions[chatId] = model.startChat({
            history: [],
          });
        }

        const chat = chatSessions[chatId];
        const result = await chat.sendMessage(message.body);
        const response = await result.response;
        const text = response.text();
        await message.reply(text);
      } catch (e) {
        console.error(`[Sessão ${id}] Erro ao gerar resposta da IA:`, e);
        await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔');
      }
    });

    client.on('disconnected', async (reason) => {
      console.log(`[Sessão ${id}] Desconectada. Razão:`, reason);
      const sessionRef = ref(database, `tenants/${id}/session`);
      await remove(sessionRef);

      Object.keys(chatSessions).forEach(key => {
        if (sessionChatMappings[id]?.has(key)) {
          console.log(`[Sessão ${id}] Limpando sessão de chat para ${key}`);
          delete chatSessions[key];
        }
      });

      if (sessionChatMappings[id]) {
        delete sessionChatMappings[id];
      }

      await client.destroy();
      delete sessions[id];
    });

    await client.initialize();
    sessions[id] = client;

    res.status(202).json({ success: true, message: `Inicialização da sessão ${id} iniciada. Escaneie o QR Code.` });
  } catch (error) {
    console.error(`[Sessão ${id}] Erro ao inicializar:`, error);
    await set(statusRef, 'ERROR');
    res.status(500).json({ success: false, error: 'Erro ao inicializar sessão.', details: error.message });
  }
});

// Rota para parar a conexão do WhatsApp
app.post('/api/whatsapp/stop/:id', async (req, res) => {
  const { id } = req.params;
  const client = sessions[id];

  if (client) {
    console.log(`[Sessão ${id}] Desconectando...`);
    try {
      await client.logout();
      res.status(200).json({ success: true, message: `Sessão ${id} desconectada.` });
    } catch (error) {
      console.error(`[Sessão ${id}] Erro ao desconectar:`, error);
      res.status(500).json({ success: false, error: 'Erro ao desconectar.' });
    }
  } else {
    const statusRef = ref(database, `tenants/${id}/session/status`);
    await set(statusRef, 'disconnected');
    res.status(404).json({ success: false, error: `Sessão ${id} não encontrada.` });
  }
});

// Rota para enviar mensagem
app.post('/api/whatsapp/send-message/:id', async (req, res) => {
  const { id } = req.params;
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'Número e mensagem são obrigatórios.' });
  }

  const client = sessions[id];

  const statusRef = ref(database, `tenants/${id}/session/status`);
  const snapshot = await get(statusRef);

  if (!client || !snapshot.exists() || snapshot.val() !== 'ready') {
    return res.status(404).json({ success: false, error: `Sessão ${id} não está conectada ou não foi encontrada.` });
  }

  try {
    const chatId = `${number}@c.us`;
    await client.sendMessage(chatId, message);
    console.log(`[Sessão ${id}] Mensagem enviada para ${number}`);
    res.status(200).json({ success: true, message: `Mensagem enviada para ${number}` });
  } catch (error) {
    console.error(`[Sessão ${id}] Erro ao enviar mensagem:`, error);
    res.status(500).json({ success: false, error: 'Erro ao enviar mensagem.', details: error.message });
  }
});

// Rota para atualizar a configuração do restaurante
app.post('/api/config/update/:id', async (req, res) => {
  const { id } = req.params;
  const newData = req.body;

  if (!newData || Object.keys(newData).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado fornecido para atualização.' });
  }
  
  try {
    const configRef = ref(database, `tenants/${id}/whatsappConfig`);
    await set(configRef, newData);

    if (sessionChatMappings[id]) {
      sessionChatMappings[id].forEach(chatId => {
        if (chatSessions[chatId]) {
          delete chatSessions[chatId];
        }
      });
    }
    console.log(`[Sessão ${id}] Configurações atualizadas com sucesso no Firebase!`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas e sessões de IA reiniciadas.' });
  } catch (error) {
    console.error(`[Sessão ${id}] Erro ao salvar configuração:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração no servidor.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});