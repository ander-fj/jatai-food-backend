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

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) callback(null, true);
    else {
      console.log(`[CORS] Origem bloqueada: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
}));

app.options('*', cors());
app.use(express.json());

// --- ARMAZENAMENTO DE SESSÕES ---
const sessions = {};
const sessionModels = {};
const userChats = {};
const initializingLocks = {}; // bloqueio booleano
const activeInitializations = {}; // Promise por sessionId para evitar duplicação
const reconnectionAttempts = {}; // contador de tentativas de reconexão por session

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

// Helper: espera X ms
const wait = ms => new Promise(r => setTimeout(r, ms));

// Função de limpeza de sessão (melhorada)
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... (Remover Auth: ${forceRemoveAuth})`);
  
  try {
    await remove(ref(database, `tenants/${sessionId}/session`));
  } catch (e) {
    console.error(`[Sessão ${sessionId}] Erro ao remover status no Firebase:`, e);
  }

  if (sessions[sessionId] && sessions[sessionId].client) {
    try {
      // Remove listeners e destrói o client
      try { sessions[sessionId].client.removeAllListeners(); } catch (e) {}
      await sessions[sessionId].client.destroy();
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, error);
    }
    delete sessions[sessionId];
    delete sessionModels[sessionId];

    // Remove userChats que pertencem a esta sessão (se conseguir identificar)
    Object.keys(userChats).forEach(chatId => {
      delete userChats[chatId];
    });
    console.log(`[Sessão ${sessionId}] Modelo de IA e sessão local limpos.`);
  }

  if (forceRemoveAuth) {
    try {
      const sessionFolderPath = path.join('.wwebjs_auth', `session-${sessionId}`);
      if (fs.existsSync(sessionFolderPath)) {
        fs.rmSync(sessionFolderPath, { recursive: true, force: true });
        console.log(`[Sessão ${sessionId}] Pasta da sessão .wwebjs_auth/session-${sessionId} removida FORÇADAMENTE.`);
      }
    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro ao remover a pasta da sessão:`, err);
    }
  }
};

// --- Inicialização do WhatsApp Client (robusta) ---
const initializeWhatsAppClient = async (sessionId, opts = {}) => {
  // evita duplicação: se já há uma inicialização em andamento, aguarda a mesma
  if (activeInitializations[sessionId]) {
    console.log(`[Sessão ${sessionId}] 🔁 Inicialização já em andamento - aguardando resultado existente.`);
    return activeInitializations[sessionId];
  }

  // cria promessa que ficará armazenada em activeInitializations
  const initPromise = (async () => {
    // se já existe um client em memória e está 'ready', evita criar outro
    if (sessions[sessionId] && sessions[sessionId].status === 'ready' && sessions[sessionId].client) {
      try {
        const state = await sessions[sessionId].client.getState();
        if (state === 'CONNECTED') {
          console.log(`[Sessão ${sessionId}] ✅ Cliente já conectado (memória).`);
          return sessions[sessionId];
        }
      } catch (e) {
        console.log(`[Sessão ${sessionId}] ⚠️ Cliente em memória inacessível: ${e.message}. Seguindo com reinitialização.`);
        // tenta cleanup leve antes de continuar
        try { await sessions[sessionId].client.destroy(); } catch (_) {}
        delete sessions[sessionId];
      }
    }

    // evita reinício concorrente real
    if (initializingLocks[sessionId]) {
      console.log(`[Sessão ${sessionId}] ⏳ Lock detectado - abortando criação duplicada.`);
      throw new Error('Already initializing');
    }
    initializingLocks[sessionId] = true;
    console.log(`[Sessão ${sessionId}] 🔒 Lock de inicialização ativado (initializeWhatsAppClient).`);

    const sessionRef = ref(database, `tenants/${sessionId}/session`);
    try {
      await set(sessionRef, { status: 'INITIALIZING' });
    } catch (e) {
      console.warn(`[Sessão ${sessionId}] ⚠️ Falha ao setar status INITIALIZING no Firebase:`, e.message || e);
    }

    // Guarda tentativa de reconexão
    reconnectionAttempts[sessionId] = reconnectionAttempts[sessionId] || 0;

    // Função para criar uma nova instância
    const createClientInstance = () => {
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
            '--disable-gpu',
            '--single-process',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
          ],
          headless: true,
        },
      });
      return client;
    };

    // real creation and wiring
    const client = createClientInstance();
    sessions[sessionId] = { client, status: 'INITIALIZING', qrAttempts: 0 };

    // QR event
    client.on('qr', async (qr) => {
      try {
        const snapshot = await get(sessionRef);
        const firebaseStatus = snapshot.exists() ? snapshot.val().status : 'disconnected';
        if (firebaseStatus === 'ready') {
          console.log(`[Sessão ${sessionId}] ⚠️ Evento 'qr' recebido, mas sessão já está 'ready' no Firebase. Ignorando geração de QR Code.`);
          return;
        }
        sessions[sessionId].qrAttempts++;
        console.log(`[Sessão ${sessionId}] QR Code gerado (Tentativa ${sessions[sessionId].qrAttempts}).`);
        const qrUrl = await qrcode.toDataURL(qr);
        await set(sessionRef, { status: 'QR_CODE', qr: qrUrl, attempt: sessions[sessionId].qrAttempts });
        sessions[sessionId].status = 'QR_CODE';
      } catch (err) {
        console.error(`[Sessão ${sessionId}] Erro no handler 'qr':`, err);
      }
    });

    client.on('authenticated', () => {
      console.log(`[Sessão ${sessionId}] ✅ Autenticado com sucesso!`);
    });

    // Ready event
    client.on('ready', async () => {
      try {
        console.log(`[Sessão ${sessionId}] ✅ Cliente conectado e pronto!`);
        await set(sessionRef, { status: 'ready', connectedAt: new Date().toISOString() });
        sessions[sessionId].status = 'ready';
        sessions[sessionId].qrAttempts = 0;
        // Remove QR field se existir
        try { await remove(ref(database, `tenants/${sessionId}/session/qr`)); } catch(_) {}
        // reset reconnection attempts
        reconnectionAttempts[sessionId] = 0;
      } catch (e) {
        console.error(`[Sessão ${sessionId}] Erro no handler 'ready':`, e);
      } finally {
        // libera lock depois de pronto
        if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
      }
    });

    // Mensagens
    client.on('message', async (message) => {
      if (message.fromMe) return;
      const chatId = message.from;
      console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);
      try {
        const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
        const snapshot = await get(configRef);
        const config = snapshot.exists() ? snapshot.val() : {};
        if (!config.isActive) {
          console.log(`[Sessão ${sessionId}] Assistente desativado. Ignorando.`);
          return;
        }

        if (!sessionModels[sessionId]) {
          const systemInstruction = createSystemInstruction(config);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";
          const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
          sessionModels[sessionId] = model;
        }

        if (!userChats[chatId]) {
          console.log(`[Sessão ${sessionId}] Iniciando novo chat para o usuário ${chatId}.`);
          userChats[chatId] = sessionModels[sessionId].startChat({ history: [] });
        }

        const chat = userChats[chatId];
        const result = await chat.sendMessage(message.body);
        const response = await result.response;
        const text = response.text();

        try {
          await message.reply(text);
        } catch (replyError) {
          console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar resposta (message.reply):`, replyError);
        }

      } catch (error) {
        console.error(`[Sessão ${sessionId}] ❌ Erro ao processar mensagem (IA):`, error);
        try { await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔'); } catch (_) {}
      }
    });

    // Desconexão
    client.on('disconnected', async (reason) => {
      try {
        console.log(`[Sessão ${sessionId}] ❌ Cliente desconectado. Razão: ${reason}`);

        // Normaliza motivos comuns que não são destrutivos
        if (!reason) reason = 'UNKNOWN';
        if (reason === 'LOGOUT' || reason.toUpperCase().includes('CONNECTION')) {
          // Trata LOGOUT como desconexão transitória
          console.log(`[Sessão ${sessionId}] ⚠️ Motivo '${reason}' tratado como desconexão transitória (não destrutiva).`);
          await set(sessionRef, { status: 'disconnected', lastReason: reason, disconnectedAt: new Date().toISOString() });
          sessions[sessionId] && (sessions[sessionId].status = 'disconnected');
          // agenda reconexão com backoff controlado
          reconnectionAttempts[sessionId] = (reconnectionAttempts[sessionId] || 0) + 1;
          const maxAttempts = 3;
          if (reconnectionAttempts[sessionId] <= maxAttempts) {
            const delay = 2000 * reconnectionAttempts[sessionId]; // 2s,4s,6s
            console.log(`[Sessão ${sessionId}] Tentativa de reconexão em ${delay}ms (tentativa ${reconnectionAttempts[sessionId]}/${maxAttempts}).`);
            // garante que não haja inicialização concorrente
            if (!initializingLocks[sessionId]) {
              setTimeout(() => {
                initializeWhatsAppClient(sessionId).catch(e => console.error(`[Sessão ${sessionId}] Erro ao reconectar depois de desconexão:`, e));
              }, delay);
            } else {
              console.log(`[Sessão ${sessionId}] Já existe lock de inicialização, skipping reconnection timer.`);
            }
            return;
          } else {
            console.log(`[Sessão ${sessionId}] Ultrapassou tentativas de reconexão (${maxAttempts}). Requer intervenção manual.`);
            // não remove auth automaticamente, mas limpa client local para poder reiniciar manualmente
            await cleanupSession(sessionId, false);
            return;
          }
        }

        // Razões destrutivas exigem limpeza completa
        const destructiveReasons = ['AUTHENTICATION_FAILED', 'CHANGE_IN_CACHE', 'UNPAIRED', 'MULTI_DEVICE_LOGOUT'];
        if (destructiveReasons.includes(reason)) {
          console.log(`[Sessão ${sessionId}] Motivo destrutivo (${reason}) - realizando limpeza com remoção de auth.`);
          await cleanupSession(sessionId, true);
        } else {
          console.log(`[Sessão ${sessionId}] Desconexão não destrutiva (${reason}). Limpando instância do cliente para futura reconexão.`);
          try {
            // apenas destrói a instância, preserva auth (arquivos)
            if (sessions[sessionId] && sessions[sessionId].client) {
              try { sessions[sessionId].client.removeAllListeners(); } catch(_) {}
              try { await sessions[sessionId].client.destroy(); } catch(_) {}
            }
          } catch (err) {
            console.error(`[Sessão ${sessionId}] Erro ao destruir cliente em desconexão não destrutiva:`, err);
          }
          delete sessions[sessionId];
        }
      } catch (err) {
        console.error(`[Sessão ${sessionId}] Erro no handler 'disconnected':`, err);
      } finally {
        if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
      }
    });

    client.on('auth_failure', async (msg) => {
      console.error(`[Sessão ${sessionId}] ❌ Falha na autenticação:`, msg);
      try { await set(sessionRef, { status: 'AUTH_FAILURE', error: msg }); } catch(_) {}
      sessions[sessionId] && (sessions[sessionId].status = 'AUTH_FAILURE');
      await cleanupSession(sessionId, true);
      if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
    });

    // inicializa com timeout e retries leves
    const MAX_INIT_ATTEMPTS = 2;
    let attempt = 0;
    while (attempt < MAX_INIT_ATTEMPTS) {
      attempt++;
      try {
        console.log(`[Sessão ${sessionId}] 🚀 Inicializando cliente (tentativa ${attempt}/${MAX_INIT_ATTEMPTS})...`);
        // aguarda initialize; se falhar entra no catch e tenta novamente
        await client.initialize();
        // se inicializou sem lançar, retorna a sessão
        return sessions[sessionId];
      } catch (err) {
        console.error(`[Sessão ${sessionId}] ❌ Erro na inicialização (tentativa ${attempt}):`, err && err.message ? err.message : err);
        // se erro crítico do puppeteer (target fechado), tenta destruir e re-criar
        try { client.removeAllListeners(); } catch(_) {}
        try { await client.destroy(); } catch(_) {}
        delete sessions[sessionId];
        if (attempt < MAX_INIT_ATTEMPTS) {
          const backoff = 2000 * attempt;
          console.log(`[Sessão ${sessionId}] Aguardando ${backoff}ms antes de nova tentativa de inicialização.`);
          await wait(backoff);
        } else {
          console.error(`[Sessão ${sessionId}] ❌ Excedeu número máximo de tentativas de inicialização.`);
          try { await set(sessionRef, { status: 'ERROR', error: 'INIT_FAILED' }); } catch(_) {}
          if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
          throw new Error('Initialization failed');
        }
      }
    }
  })();

  activeInitializations[sessionId] = initPromise;

  try {
    const res = await initPromise;
    return res;
  } finally {
    // limpa a promessa ativa para permitir futuras inicializações se necessário
    delete activeInitializations[sessionId];
  }
};

// --- ROTAS DA API ---
app.get('/health', (req, res) => {
  const healthInfo = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    },
    activeSessions: Object.keys(sessions).length,
    environment: process.env.NODE_ENV || 'development'
  };
  console.log('[Health Check] Status:', healthInfo);
  res.status(200).json(healthInfo);
});

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
  console.log(`[Sessão ${sessionId}] 📥 Recebida requisição para iniciar.`);

  const sessionRef = ref(database, `tenants/${sessionId}/session`);
  const snapshot = await get(sessionRef);
  const firebaseStatus = snapshot.exists() ? snapshot.val().status : 'disconnected';

  // Se já está ready no firebase, ignora
  if (firebaseStatus === 'ready') {
    console.log(`[Sessão ${sessionId}] ✅ Status 'ready' encontrado no Firebase. Requisição ignorada.`);
    return res.status(200).json({ success: true, message: 'Sessão já está conectada (Status Firebase: ready).' });
  }

  // espera se já existe inicialização em andamento
  if (initializingLocks[sessionId]) {
    console.log(`[Sessão ${sessionId}] ⚠️ Sessão já está sendo inicializada. Requisição bloqueada.`);
    return res.status(409).json({
      success: false,
      message: 'A sessão já está em processo de inicialização. Por favor, aguarde.',
    });
  }

  // ativa lock local e dispara inicialização (não bloqueante)
  initializingLocks[sessionId] = true;
  console.log(`[Sessão ${sessionId}] 🔒 Lock de inicialização ativado.`);

  try {
    // Chama inicialização e aguarda para poder dar resposta inicial (mas sem travar indefinidamente)
    initializeWhatsAppClient(sessionId).then(() => {
      console.log(`[Sessão ${sessionId}] Inicialização concluída (promessa resolvida).`);
    }).catch(err => {
      console.error(`[Sessão ${sessionId}] ❌ Falha não capturada na inicialização:`, err);
      if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
    });

    res.status(202).json({
      success: true,
      message: `Inicialização da sessão ${sessionId} iniciada.`,
    });
  } catch (err) {
    if (initializingLocks[sessionId]) delete initializingLocks[sessionId];
    console.error(`[Sessão ${sessionId}] Erro ao iniciar sessão:`, err);
    res.status(500).json({ success: false, message: 'Erro ao iniciar sessão.' });
  }
});

app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (session && session.client) {
    console.log(`[Sessão ${sessionId}] 🛑 Recebida requisição para parar.`);
    try {
      // Chama logout e força remoção completa
      await session.client.logout();
      // cleanup com remoção do auth
      await cleanupSession(sessionId, true);
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

    delete sessionModels[sessionId];
    Object.keys(userChats).forEach(chatId => { delete userChats[chatId]; });
    
    console.log(`[Sessão ${sessionId}] ⚙️ Configurações atualizadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas.' });
  } catch (error) {
    console.error(`[Config ${sessionId}] Erro ao salvar:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração.' });
  }
});

// --- PROTEÇÕES GLOBAIS ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
  console.log('📱 Aguardando requisições para iniciar sessões do WhatsApp...');
});
