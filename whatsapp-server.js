// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');

// --- VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE ---
const requiredEnvVars = [
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
  console.error('[ERRO CRÍTICO] Variáveis de ambiente essenciais não encontradas:');
  missingEnvVars.forEach(v => console.error(`- ${v}`));
  console.error('\nConfigure-as no seu ambiente ou no arquivo .env.\n');
  process.exit(1);
}

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
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// --- CONFIGURAÇÃO DO EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;

const allowedOrigins = [
  'https://www.jataifood.com.br',
  'https://jatai-food-backend.onrender.com',
  'http://localhost:5173',
];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// --- ARMAZENAMENTO DE SESSÕES ---
const sessions = {};
const chatContexts = {};

// --- FUNÇÕES AUXILIARES ---

const createSystemInstruction = (config) => `
  Você é o assistente virtual do restaurante ${config.restaurantName || 'do nosso restaurante'}! Seu nome é Jataí.
  Sua personalidade é super divertida, animada e simpática! Use emojis para deixar a conversa mais legal. 🥳🍕✨
  Sua mensagem de boas-vindas é: "${config.welcomeMessage || 'Olá! Como posso te ajudar?'}"
  Sua missão é ajudar os clientes com um sorriso no rosto (virtual, claro!). Use as informações abaixo para responder:
  - Horário de funcionamento: ${config.hours || 'Não informado'}
  - Endereço (se perguntarem onde fica): ${config.address || 'Não informado'}
  - Link do Cardápio e Pedidos: ${config.menuUrl || 'Não informado'}
  - Telefone de contato: ${config.phoneNumber || 'Não informado'}
  IMPORTANTE: Ao enviar o link do cardápio, envie apenas a URL, sem formatação de link ou markdown. Por exemplo: https://seusite.com/cardapio
  NUNCA invente informações. Se não souber algo, diga algo como: "Opa, essa pergunta me pegou! Vou chamar um humano pra te ajudar, só um minutinho! 🧑‍🍳"
`;

const initializeWhatsAppClient = async (id) => {
  if (sessions[id] && sessions[id].client) {
    console.log(`[Sessão ${id}] Tentativa de iniciar, mas já existe uma instância.`);
    return;
  }

  const sessionRef = ref(database, `tenants/${id}/session`);

  console.log(`[Sessão ${id}] Configurando cliente...`);
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
  });

  sessions[id] = { client, status: 'INITIALIZING' };

  client.on('qr', async (qr) => {
    console.log(`[Sessão ${id}] QR Code gerado.`);
    qrcodeTerminal.generate(qr, { small: true });
    const qrUrl = await qrcode.toDataURL(qr);
    await set(sessionRef, { status: 'QR_CODE', qr: qrUrl });
    sessions[id].status = 'QR_CODE';
  });

  client.on('ready', async () => {
    console.log(`[Sessão ${id}] Cliente conectado e pronto!`);
    await set(sessionRef, { status: 'ready' });
    sessions[id].status = 'ready';
    
    // Remove o QR code quando conectar
    await remove(ref(database, `tenants/${id}/session/qr`));
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;

    console.log(`[Sessão ${id}] Mensagem de ${message.from}: "${message.body}"`);
    const chatId = message.from;

    try {
      const configRef = ref(database, `tenants/${id}/whatsappConfig`);
      const snapshot = await get(configRef);
      const config = snapshot.exists() ? snapshot.val() : {};

      if (!config.isActive) {
        console.log(`[Sessão ${id}] Assistente desativado. Ignorando.`);
        return;
      }

      if (!chatContexts[chatId]) {
        console.log(`[Sessão ${id}] Iniciando novo contexto de chat para ${chatId}`);
        const systemInstruction = createSystemInstruction(config);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash";
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        chatContexts[chatId] = model.startChat({ history: [] });
      }

      const chat = chatContexts[chatId];
      const result = await chat.sendMessage(message.body);
      const response = await result.response;
      const text = response.text();
      await message.reply(text);

    } catch (e) {
      console.error(`[Sessão ${id}] Erro ao processar mensagem com IA:`, e);
      await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔');
    }
  });

  client.on('disconnected', async (reason) => {
    console.log(`[Sessão ${id}] Cliente desconectado. Razão:`, reason);
    await remove(ref(database, `tenants/${id}/session`));
    
    Object.keys(chatContexts).forEach(chatId => {
      if (sessions[id]) { 
        delete chatContexts[chatId];
      }
    });

    if (sessions[id]) {
      try {
        await sessions[id].client.destroy();
      } catch (e) {
        console.error(`[Sessão ${id}] Erro ao destruir cliente:`, e);
      }
      delete sessions[id];
    }
  });
  
  client.on('auth_failure', async (msg) => {
    console.error(`[Sessão ${id}] Falha na autenticação:`, msg);
    await set(sessionRef, { status: 'AUTH_FAILURE' });
    sessions[id].status = 'AUTH_FAILURE';
  });

  try {
    console.log(`[Sessão ${id}] Inicializando cliente...`);
    await client.initialize();
  } catch (error) {
    console.error(`[Sessão ${id}] Erro crítico na inicialização:`, error);
    await set(sessionRef, { status: 'ERROR' });
    if (sessions[id]) delete sessions[id];
  }
};

// --- ROTAS DA API ---

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/whatsapp/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const statusRef = ref(database, `tenants/${id}/session/status`);
    const snapshot = await get(statusRef);
    const status = snapshot.exists() ? snapshot.val() : 'disconnected';
    res.json({ status });
  } catch (error) {
    console.error(`[Status ${id}] Erro:`, error);
    res.status(500).json({ status: 'disconnected', message: 'Erro ao buscar status.' });
  }
});

// ✅ CORREÇÃO: Retorna 200 com null quando não há QR code
app.get('/api/whatsapp/qr/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const qrRef = ref(database, `tenants/${id}/session/qr`);
    const snapshot = await get(qrRef);
    
    if (snapshot.exists()) {
      res.status(200).json({ qr: snapshot.val() });
    } else {
      // Retorna 200 com null em vez de 404
      res.status(200).json({ qr: null, message: 'QR code ainda não gerado ou já utilizado.' });
    }
  } catch (error) {
    console.error(`[QR ${id}] Erro:`, error);
    res.status(500).json({ error: 'Erro ao buscar QR code.', qr: null });
  }
});

app.post('/api/whatsapp/start/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`[Sessão ${id}] Recebida requisição para iniciar.`);
  
  // Limpa QR code antigo antes de iniciar
  await remove(ref(database, `tenants/${id}/session/qr`));
  await set(ref(database, `tenants/${id}/session/status`), 'INITIALIZING');
  
  initializeWhatsAppClient(id).catch(err => {
    console.error(`[Sessão ${id}] Falha não capturada na inicialização:`, err);
  });
  
  res.status(202).json({ success: true, message: `Inicialização da sessão ${id} iniciada.` });
});

app.post('/api/whatsapp/stop/:id', async (req, res) => {
  const { id } = req.params;
  const session = sessions[id];

  if (session && session.client) {
    console.log(`[Sessão ${id}] Recebida requisição para parar.`);
    try {
      await session.client.logout();
      res.status(200).json({ success: true, message: `Sessão ${id} desconectada.` });
    } catch (error) {
      console.error(`[Sessão ${id}] Erro ao fazer logout:`, error);
      res.status(500).json({ success: false, error: 'Erro ao desconectar.' });
    }
  } else {
    await set(ref(database, `tenants/${id}/session/status`), 'disconnected');
    res.status(404).json({ success: false, error: `Sessão ${id} não encontrada ou já inativa.` });
  }
});

app.post('/api/config/update/:id', async (req, res) => {
  const { id } = req.params;
  const newConfig = req.body;

  if (!newConfig || Object.keys(newConfig).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado fornecido.' });
  }
  
  try {
    const configRef = ref(database, `tenants/${id}/whatsappConfig`);
    await set(configRef, newConfig);

    Object.keys(chatContexts).forEach(chatId => {
      delete chatContexts[chatId];
    });

    console.log(`[Sessão ${id}] Configurações atualizadas e contextos de IA reiniciados.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas.' });
  } catch (error) {
    console.error(`[Config ${id}] Erro ao salvar:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração.' });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  console.log('Aguardando requisições para iniciar sessões do WhatsApp...');
});