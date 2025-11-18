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
const fs = require('fs');
const path = require('path');

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
  'https://jataifood.com.br',
  'https://jatai-food-backend.onrender.com',
  'http://localhost:5173',
];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// --- ARMAZENAMENTO DE SESSÕES ---
const sessions = {};
const chatContexts = {};
const initializingLocks = {}; // Previne múltiplas inicializações simultâneas

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

const initializeWhatsAppClient = async (sessionId) => {
  // Previne múltiplas inicializações simultâneas
  if (initializingLocks[sessionId]) {
    console.log(`[Sessão ${sessionId}] Já está inicializando. Aguardando...`);
    return;
  }

  if (sessions[sessionId] && sessions[sessionId].client) {
    console.log(`[Sessão ${sessionId}] Já existe uma instância ativa.`);
    return;
  }

  initializingLocks[sessionId] = true;
  const sessionRef = ref(database, `tenants/${sessionId}/session`);

  console.log(`[Sessão ${sessionId}] Configurando novo cliente...`);
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
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
  });

  sessions[sessionId] = { client, status: 'INITIALIZING', qrAttempts: 0 };

  // Evento QR Code - limita a 3 tentativas
  client.on('qr', async (qr) => {
    sessions[sessionId].qrAttempts++;
    
    if (sessions[sessionId].qrAttempts > 3) {
      console.log(`[Sessão ${sessionId}] Limite de QR codes atingido. Reiniciando...`);
      await cleanupSession(sessionId);
      delete initializingLocks[sessionId];
      return;
    }

    console.log(`[Sessão ${sessionId}] QR Code gerado (tentativa ${sessions[sessionId].qrAttempts}/3)`);
    qrcodeTerminal.generate(qr, { small: true });
    
    try {
      const qrUrl = await qrcode.toDataURL(qr);
      await set(sessionRef, { status: 'QR_CODE', qr: qrUrl, attempt: sessions[sessionId].qrAttempts });
      sessions[sessionId].status = 'QR_CODE';
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao gerar QR code:`, error);
    }
  });

  // Evento Ready
  client.on('ready', async () => {
    console.log(`[Sessão ${sessionId}] ✅ Cliente conectado e pronto!`);
    await set(sessionRef, { status: 'ready', connectedAt: new Date().toISOString() });
    sessions[sessionId].status = 'ready';
    sessions[sessionId].qrAttempts = 0;
    delete initializingLocks[sessionId];
    
    // Remove o QR code quando conectar
    await remove(ref(database, `tenants/${sessionId}/session/qr`));
  });

  // Evento de Autenticação
  client.on('authenticated', () => {
    console.log(`[Sessão ${sessionId}] ✅ Autenticado com sucesso!`);
  });

  // Evento de Mensagens
  client.on('message', async (message) => {
    if (message.fromMe) return;

    console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${message.from}: "${message.body}"`);
    const chatId = message.from;

    try {
      const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
      const snapshot = await get(configRef);
      const config = snapshot.exists() ? snapshot.val() : {};

      if (!config.isActive) {
        console.log(`[Sessão ${sessionId}] Assistente desativado. Ignorando.`);
        return;
      }

      if (!chatContexts[chatId]) {
        console.log(`[Sessão ${sessionId}] Iniciando novo contexto de chat para ${chatId}`);
        const systemInstruction = createSystemInstruction(config);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        chatContexts[chatId] = model.startChat({ history: [] });
      }

      const chat = chatContexts[chatId];
      const result = await chat.sendMessage(message.body);
      const response = await result.response;
      const text = response.text();
      
      console.log(`[Sessão ${sessionId}] 🤖 Resposta: "${text.substring(0, 50)}..."`);
      await message.reply(text);

    } catch (error) {
      console.error(`[Sessão ${sessionId}] ❌ Erro ao processar mensagem:`, error);
      await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔');
    }
  });

  // Evento de Desconexão
  client.on('disconnected', async (reason) => {
    console.log(`[Sessão ${sessionId}] ❌ Cliente desconectado. Razão:`, reason);
    
    // Logout programático ou pelo usuário no celular não deve apagar a sessão.
    // Falha na autenticação (ex: token inválido) deve apagar para forçar novo QR.
    if (reason === 'AUTHENTICATION_FAILED') {
        console.log(`[Sessão ${sessionId}] Falha de autenticação. Limpeza completa da sessão necessária.`);
        await cleanupSession(sessionId, true); // Força a remoção da pasta de autenticação
    } else {
        console.log(`[Sessão ${sessionId}] Desconexão normal. Apenas destruindo o cliente.`);
        await cleanupSession(sessionId, false); // Apenas destrói o cliente, mantém a autenticação
    }
    delete initializingLocks[sessionId];
  });
  
  // Evento de Falha de Autenticação
  client.on('auth_failure', async (msg) => {
    console.error(`[Sessão ${sessionId}] ❌ Falha na autenticação:`, msg);
    await set(sessionRef, { status: 'AUTH_FAILURE', error: msg });
    sessions[sessionId].status = 'AUTH_FAILURE';
    await cleanupSession(sessionId);
    delete initializingLocks[sessionId];
  });

  // Inicialização com timeout
  try {
    console.log(`[Sessão ${sessionId}] 🚀 Inicializando cliente...`);
    
    // Timeout de 60 segundos para inicialização
    const initPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout na inicialização')), 120000)
    );
    
    await Promise.race([initPromise, timeoutPromise]);
    
  } catch (error) {
    console.error(`[Sessão ${sessionId}] ❌ Erro crítico na inicialização:`, error);
    await set(sessionRef, { status: 'ERROR', error: error.message });
    await cleanupSession(sessionId);
    delete initializingLocks[sessionId];
  }
};

// Função de limpeza de sessão
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... (Remover Auth: ${forceRemoveAuth})`);
  
  // Remove do Firebase
  await remove(ref(database, `tenants/${sessionId}/session`));
  
  // Limpa contextos de chat
  Object.keys(chatContexts).forEach(chatId => {
    if (chatContexts[chatId]) {
      delete chatContexts[chatId];
    }
  });

  // Destrói o cliente
  if (sessions[sessionId] && sessions[sessionId].client) {
    try {
      await sessions[sessionId].client.destroy();
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, error);
    }
    delete sessions[sessionId];
  }

  // Remove a pasta da sessão APENAS se forçado (logout, etc.)
  if (forceRemoveAuth) {
    const sessionFolderPath = path.join('.wwebjs_auth', `session-${sessionId}`);
    try {
      if (fs.existsSync(sessionFolderPath)) {
        fs.rmSync(sessionFolderPath, { recursive: true, force: true });
        console.log(`[Sessão ${sessionId}] Pasta da sessão .wwebjs_auth/session-${sessionId} removida FORÇADAMENTE.`);
      }
    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro ao remover a pasta da sessão:`, err);
    }
  }
};

// --- ROTAS DA API ---

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const statusRef = ref(database, `tenants/${sessionId}/session/status`);
    const snapshot = await get(statusRef);
    const status = snapshot.exists() ? snapshot.val() : 'disconnected';
    res.json({ status });
  } catch (error) {
    console.error(`[Status ${sessionId}] Erro:`, error);
    res.status(500).json({ status: 'disconnected', message: 'Erro ao buscar status.' });
  }
});

app.get('/api/whatsapp/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const qrRef = ref(database, `tenants/${sessionId}/session/qr`);
    const snapshot = await get(qrRef);
    
    if (snapshot.exists()) {
      res.status(200).json({ qr: snapshot.val() });
    } else {
      res.status(200).json({ qr: null, message: 'QR code ainda não gerado ou já utilizado.' });
    }
  } catch (error) {
    console.error(`[QR ${sessionId}] Erro:`, error);
    res.status(500).json({ error: 'Erro ao buscar QR code.', qr: null });
  }
});

app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  if (initializingLocks[sessionId]) {
    return res.status(409).json({
      success: false,
      message: 'Sessão já está sendo inicializada. Aguarde.',
    });
  }

  const session = sessions[sessionId];
  if (session && session.client) {
    try {
      const state = await session.client.getState();
      // O estado 'CONNECTED' na biblioteca whatsapp-web.js indica que o cliente está autenticado e pronto.
      if (state === 'CONNECTED') {
        console.log(`[Sessão ${sessionId}] Cliente já conectado (estado: ${state}). Requisição de início ignorada.`);
        return res.status(200).json({
          success: true,
          message: 'Sessão já está conectada.',
        });
      }
      console.log(`[Sessão ${sessionId}] Cliente existente encontrado em estado não ideal: ${state || 'N/A'}. Prosseguindo com a reinicialização.`);
    } catch (error) {
      console.log(`[Sessão ${sessionId}] Erro ao obter estado do cliente: ${error.message}. Prosseguindo com a reinicialização.`);
    }
  }

  // A verificação de status local é uma segurança adicional.
  if (sessions[sessionId] && sessions[sessionId].status === 'ready') {
    return res.status(200).json({
      success: true,
      message: 'Sessão já está conectada.',
    });
  }

  console.log(`[Sessão ${sessionId}] 📥 Recebida requisição para iniciar.`);

  if (sessions[sessionId]) {
    console.log(`[Sessão ${sessionId}] ⚠️ Sessão existente encontrada. Limpando antes de reiniciar.`);
    await cleanupSession(sessionId, false); // Limpa a sessão anterior sem apagar a autenticação
  }

  await remove(ref(database, `tenants/${sessionId}/session/qr`));
  await set(ref(database, `tenants/${sessionId}/session/status`), 'INITIALIZING');

  initializeWhatsAppClient(sessionId).catch(err => {
    console.error(`[Sessão ${sessionId}] Falha não capturada na inicialização:`, err);
  });

  res.status(202).json({
    success: true,
    message: `Inicialização da sessão ${sessionId} iniciada.`,
  });
});

app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (session && session.client) {
    console.log(`[Sessão ${sessionId}] 🛑 Recebida requisição para parar.`);
    try {
      await session.client.logout();
      res.status(200).json({ success: true, message: `Sessão ${sessionId} desconectada.` });
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao fazer logout:`, error);
      res.status(500).json({ success: false, error: 'Erro ao desconectar.' });
    }
  } else {
    await set(ref(database, `tenants/${sessionId}/session/status`), 'disconnected');
    res.status(404).json({ success: false, error: `Sessão ${sessionId} não encontrada ou já inativa.` });
  }
});

app.post('/api/config/update/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const newConfig = req.body;

  if (!newConfig || Object.keys(newConfig).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado fornecido.' });
  }
  
  try {
    const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
    await set(configRef, newConfig);

    // Limpa contextos de chat para forçar recriação com nova config
    Object.keys(chatContexts).forEach(chatId => {
      delete chatContexts[chatId];
    });

    console.log(`[Sessão ${sessionId}] ⚙️ Configurações atualizadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas.' });
  } catch (error) {
    console.error(`[Config ${sessionId}] Erro ao salvar:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração.' });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
  console.log('📱 Aguardando requisições para iniciar sessões do WhatsApp...');
});