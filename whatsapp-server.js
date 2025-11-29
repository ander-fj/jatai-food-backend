// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const axios = require('axios'); // Adicionado para buscar o cardápio
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÃO DE SESSÃO PERSISTENTE ---
const SESSION_BASE_PATH = process.env.SESSION_PATH || path.join(__dirname, '.wwebjs_auth');

let sessionPathResolved = SESSION_BASE_PATH;

const ensureDir = (p) => {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
    const testFile = path.join(p, `.writetest-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    return false;
  }
};

if (!ensureDir(SESSION_BASE_PATH)) {
  const fallback = path.join(__dirname, '.wwebjs_auth');
  console.warn(`[Sessão] Não foi possível usar SESSION_BASE_PATH="${SESSION_BASE_PATH}". Tentando fallback: ${fallback}`);
  if (!ensureDir(fallback)) {
    console.error('[Sessão] Não foi possível criar diretório de sessão nem no fallback.');
  } else {
    sessionPathResolved = fallback;
    console.log(`[Sessão] Diretório de sessão persistente criado em (fallback): ${sessionPathResolved}`);
  }
} else {
  console.log(`[Sessão] Diretório de sessão persistente: ${sessionPathResolved}`);
}

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
  console.error('[ERRO CRÍTICO] Variáveis de ambiente faltando:');
  missingEnvVars.forEach(v => console.error(`- ${v}`));
  process.exit(1);
}

// --- CONFIGURAÇÃO FIREBASE ---
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

// --- EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  credentials: true,
}));

app.options('*', cors());
app.use(express.json());

// --- SESSÕES ---
const sessions = {};
const sessionModels = {};
const userChats = {};
const activeInitializations = {};
const reconnectionAttempts = {};
const startRequestTimestamps = {};
const reconnectionTimers = {};
const messageProcessingLocks = {};
const globalInitLock = {}; // Lock global para evitar múltiplas inicializações

// --- CONSTANTES ---
const MAX_RECONNECTION_ATTEMPTS = 3; // Reduzido para evitar loops
const RECONNECTION_DELAY = 10000; // 10 segundos (aumentado)
const HEARTBEAT_INTERVAL = 30000; // 30 segundos
const MESSAGE_TIMEOUT = 30000; // 30 segundos
const QR_READY_TIMEOUT = 60000; // 1 minuto para atingir ready
const INIT_COOLDOWN = 5000; // Aguardar 5 segundos antes de reconectar

// --- SISTEMA IA ---
const createSystemInstruction = async (config) => {
  let menuContent = 'O cardápio ainda não foi configurado. Por favor, peça para o lojista o cadastrar.';

  if (config.menuUrl) {
    try {
      console.log(`[IA] Buscando cardápio de: ${config.menuUrl}`);
      // Usamos um User-Agent para simular um navegador e evitar bloqueios
      const response = await axios.get(config.menuUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
      });
      // Extrai o texto do HTML, remove tags e espaços extras
      menuContent = response.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('[IA] Cardápio online carregado com sucesso.');
    } catch (error) {
      console.error(`[IA] Falha ao buscar cardápio da URL. Usando mensagem padrão. Erro: ${error.message}`);
    }
  }

  return `
  Você é o assistente virtual do restaurante ${config.restaurantName || 'Nosso Restaurante'}!
  Nome: Jataí 🍕🤖
  - Seja simpático, rápido, informal e use emojis
  - Horário: ${config.hours || 'Consulte nosso horário de funcionamento.'}
  - Endereço: ${config.address || 'Peça nosso endereço para entrega ou retirada.'}
  - Cardápio: ${menuContent}
  - Telefone: ${config.phoneNumber || 'Peça nosso número de telefone para contato.'}
  - Sua saudação inicial padrão é: "${config.welcomeMessage || 'Olá! Como posso te ajudar?'}"
  Nunca invente informações.
`;
};

const wait = ms => new Promise(r => setTimeout(r, ms));

// --- LIMPEZA DE SESSÃO ---
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... RemoveAuth=${forceRemoveAuth}`);

  const client = sessions[sessionId]?.client || null;

  try { await remove(ref(database, `tenants/${sessionId}/session`)); } catch {}

  if (client) {
    try {
      client.removeAllListeners();
      await client.destroy();
    } catch (e) {
      console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, e);
    }
    delete sessions[sessionId];
  }

  delete sessionModels[sessionId];
  delete userChats[sessionId];

  // Limpar timers de reconexão
  if (reconnectionTimers[sessionId]) {
    clearTimeout(reconnectionTimers[sessionId]);
    delete reconnectionTimers[sessionId];
  }

  if (forceRemoveAuth) {
    const folder = path.join(sessionPathResolved, `session-${sessionId}`);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
      console.log(`[Sessão ${sessionId}] Pasta removida: ${folder}`);
    }
  }
};

// --- VERIFICAÇÃO DE ESTADO DO CLIENTE ---
const isClientValid = async (sessionId) => {
  const session = sessions[sessionId];
  if (!session || !session.client) return false;

  try {
    const state = await session.client.getState();
    return state === 'CONNECTED';
  } catch (e) {
    return false;
  }
};

// --- HEARTBEAT PARA MANTER CONEXÃO VIVA ---
const startHeartbeat = (sessionId) => {
  const interval = setInterval(async () => {
    try {
      if (!(await isClientValid(sessionId))) {
        clearInterval(interval);
      }
    } catch (e) {
      clearInterval(interval);
    }
  }, HEARTBEAT_INTERVAL);

  return interval;
};

// --- LISTENERS DE CICLO ---
const attachLifecycleListeners = (client, sessionId) => {
  const sessionRef = ref(database, `tenants/${sessionId}/session`);

  // Usar 'on' para QR para permitir múltiplas tentativas
  client.on('qr', async (qr) => {
    const session = sessions[sessionId];
    if (!session) return;

    qrCount++;
    session.qrAttempts++;
    const qrUrl = await qrcode.toDataURL(qr);

    console.log(`[Sessão ${sessionId}] QR gerado #${qrCount} (Status atual: ${session.status})`);
    await set(sessionRef, {
      status: 'QR_CODE',
      qr: qrUrl,
      attempt: session.qrAttempts
    });
  });
  
  client.once('ready', async () => {
    console.log(`[Sessão ${sessionId}] ✅ Cliente pronto`);
    await set(sessionRef, { status: 'ready' });
    sessions[sessionId].status = 'ready';
    sessions[sessionId].qrAttempts = 0;
    sessions[sessionId].reconnectAttempts = 0;
    sessions[sessionId].lastActivity = Date.now();

    // Iniciar heartbeat
    if (!sessions[sessionId].heartbeatInterval) {
      sessions[sessionId].heartbeatInterval = startHeartbeat(sessionId);
    }
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;

    const chatId = message.from;
    console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);

    try {
      // Verificar se o cliente ainda está válido
      if (!await isClientValid(sessionId)) {
        console.warn(`[Sessão ${sessionId}] Cliente inválido ao receber mensagem`);
        return;
      }

      const configSnap = await get(ref(database, `tenants/${sessionId}/whatsappConfig`));
      const config = configSnap.exists() ? configSnap.val() : {};

      // Verifica se o assistente está ativo nas configurações
      if (config.isActive === false) {
        console.log(`[Sessão ${sessionId}] 🤖 Assistente desativado. Ignorando mensagem.`);
        return;
      }

      if (!sessionModels[sessionId]) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash";
        const systemInstruction = await createSystemInstruction(config);

        sessionModels[sessionId] = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction
        });
      }

      if (!userChats[sessionId]) userChats[sessionId] = {};
      if (!userChats[sessionId][chatId]) {
        userChats[sessionId][chatId] = sessionModels[sessionId].startChat({ history: [] });
      }

      const chat = userChats[sessionId][chatId];

      const result = await chat.sendMessage(message.body);
      const text = result.response.text();

      await message.reply(text);
      sessions[sessionId].lastActivity = Date.now();

    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro IA:`, err);
      try {
        await message.reply('Desculpe, tive um problema ao processar sua mensagem.');
      } catch (replyErr) {
        console.error(`[Sessão ${sessionId}] Erro ao enviar mensagem de erro:`, replyErr);
      }
    }
  });

  // Usar 'on' em vez de 'once' para capturar múltiplas desconexões
  client.on('disconnected', async (reason) => {
    console.log(`[Sessão ${sessionId}] ❌ Desconectado: ${reason}`);

    if (String(reason).toUpperCase() === 'LOGOUT') {
      console.log(`[Sessão ${sessionId}] Logout detectado, limpando sessão...`);
      await cleanupSession(sessionId, true);
      await set(sessionRef, { status: 'logged_out' });
      return;
    }

    // Para outras desconexões, tentar reconectar
    await cleanupSession(sessionId, false);
    await set(sessionRef, { status: 'disconnected' });

    // Tentar reconectar automaticamente
    const attempts = sessions[sessionId]?.reconnectAttempts || 0;
    if (attempts < MAX_RECONNECTION_ATTEMPTS) {
      console.log(`[Sessão ${sessionId}] Tentando reconectar (${attempts + 1}/${MAX_RECONNECTION_ATTEMPTS})...`);
      
      reconnectionTimers[sessionId] = setTimeout(() => {
        initializeWhatsAppClient(sessionId)
          .then(() => console.log(`[Sessão ${sessionId}] Reconexão bem-sucedida`))
          .catch(e => console.error(`[Sessão ${sessionId}] Falha na reconexão:`, e));
      }, RECONNECTION_DELAY * (attempts + 1)); // Backoff exponencial
    } else {
      console.error(`[Sessão ${sessionId}] Máximo de tentativas de reconexão atingido`);
    }
  });

  client.on('error', (err) => {
    console.error(`[Sessão ${sessionId}] Erro do cliente:`, err.message);
    if (String(err.message).includes('Target closed')) {
        console.log(`[Sessão ${sessionId}] Erro 'Target closed' detectado. Tentando reiniciar...`);
        // Lógica de reinicialização pode ser adicionada aqui se necessário
    }
  });
};

// --- INICIALIZAÇÃO DO CLIENTE ---
const initializeWhatsAppClient = async (sessionId) => {
  if (activeInitializations[sessionId]) {
    return activeInitializations[sessionId];
  }

  activeInitializations[sessionId] = new Promise(async (resolve, reject) => {
    try {
      let client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: sessionPathResolved
        }),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
      });

      attachLifecycleListeners(client, sessionId);

      sessions[sessionId] = {
        client,
        status: 'INITIALIZING',
        qrAttempts: 0,
        reconnectAttempts: (sessions[sessionId]?.reconnectAttempts || 0) + 1,
        lastActivity: Date.now(),
        heartbeatInterval: null
      };

      await client.initialize();
      resolve(sessions[sessionId]);

    } catch (e) {
      console.error(`[Sessão ${sessionId}] Erro na inicialização:`, e);
      reject(e);
    } finally {
      delete activeInitializations[sessionId];
    }
  });

  return activeInitializations[sessionId];
};

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    time: new Date().toISOString(),
    sessions: Object.keys(sessions)
  });
});

// --- STATUS ROUTE ---
app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  // Verificar estado real do cliente
  const isValid = await isClientValid(sessionId);

  if (isValid) {
    res.json({ status: 'ready' });
  } else {
    try {
      const snap = await get(ref(database, `tenants/${sessionId}/session/status`));
      res.json({ status: snap.exists() ? snap.val() : 'disconnected' });
    } catch (e) {
      res.json({ status: 'disconnected' });
    }
  }
});

// --- QR ROUTE ---
app.get('/api/whatsapp/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const qrRef = ref(database, `tenants/${sessionId}/session/qr`);
    const snapshot = await get(qrRef);
    if (snapshot.exists()) {
      res.json({ qr: snapshot.val() });
    } else {
      res.json({ qr: null, message: 'QR ainda não gerado.' });
    }
  } catch (e) {
    console.error(`[QR ${sessionId}] erro:`, e);
    res.status(500).json({ error: 'Erro ao buscar QR' });
  }
});

// --- START SESSION ---
app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const now = Date.now();
  const WINDOW = 10000;

  if (startRequestTimestamps[sessionId]) {
    const delta = now - startRequestTimestamps[sessionId];
    if (delta < WINDOW) {
      return res.status(429).json({
        success: false,
        message: `Espere ${Math.ceil((WINDOW - delta) / 1000)} segundos para tentar novamente`
      });
    }
  }
  startRequestTimestamps[sessionId] = now;

  const sessionRef = ref(database, `tenants/${sessionId}/session`);
  const snap = await get(sessionRef);
  const fbStatus = snap.exists() ? snap.val().status : 'disconnected';

  if (fbStatus === 'ready' && sessions[sessionId]) {
    const isValid = await isClientValid(sessionId);
    if (isValid) {
      return res.json({ success: true, message: 'Sessão já conectada' });
    }
  }

  console.log(`[Sessão ${sessionId}] Iniciando inicialização...`);

  initializeWhatsAppClient(sessionId)
    .then(() => console.log(`[Sessão ${sessionId}] Inicialização concluída`))
    .catch(e => console.error(`[Sessão ${sessionId}] Falha init:`, e));

  res.json({ success: true, message: 'Inicialização iniciada' });
});

// --- STOP SESSION ---
app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const session = sessions[sessionId];
  if (session && session.client) {
    try {
      await session.client.logout();
      await cleanupSession(sessionId, true);
      res.json({ success: true, message: 'Sessão encerrada' });
    } catch (e) {
      console.error(`[Sessão ${sessionId}] Erro ao desconectar:`, e);
      res.status(500).json({ error: 'Erro ao desconectar' });
    }
  } else {
    res.status(404).json({ error: 'Sessão não existe' });
  }
});

// --- UPDATE CONFIG ---
app.post('/api/config/update/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const data = req.body;

  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Nenhum dado enviado' });
  }

  try {
    const cfgRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
    await set(cfgRef, data);

    delete sessionModels[sessionId];
    delete userChats[sessionId];

    res.json({ success: true, message: 'Configurações atualizadas' });
  } catch (e) {
    console.error(`[Config ${sessionId}] erro:`, e);
    res.status(500).json({ error: 'Falha ao salvar config' });
  }
});

// --- GLOBAL ERROR HANDLERS ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (String(err).includes('Evaluation failed')) {
    console.error('Erro crítico do Puppeteer. O processo pode precisar ser reiniciado.');
  }
});

// --- CLEANUP ON EXIT ---
process.on('SIGINT', async () => {
  console.log('\n[Sistema] Encerrando servidor...');
  for (const sessionId of Object.keys(sessions)) {
    await cleanupSession(sessionId, false);
  }
  process.exit(0);
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
  console.log('📱 Aguardando sessões do WhatsApp...');
});