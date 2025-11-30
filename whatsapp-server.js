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

// --- CONFIGURAÇÃO DE SESSÃO PERSISTENTE ---
let SESSION_BASE_PATH = process.env.SESSION_PATH || '/var/data/wwebjs_auth';
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

const allowedOrigins = [
  'https://www.jataifood.com.br',
  'https://jataifood.com.br',
  'https://jatai-food-backend-production.up.railway.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
];

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

app.use(express.json());

// --- SESSÕES ---
const sessions = {};
const sessionModels = {};
const userChats = {};
const activeInitializations = {};
const startRequestTimestamps = {};
const reconnectionTimers = {};
const sessionCleanupLocks = {}; // Para evitar condições de corrida na limpeza

// --- CONSTANTES ---
const MAX_RECONNECTION_ATTEMPTS = 3; // Reduzido para evitar loops
const RECONNECTION_DELAY = 10000; // 10 segundos (aumentado)
const HEARTBEAT_INTERVAL = 30000; // 30 segundos

// --- SISTEMA IA ---
const createSystemInstruction = (config) => `
  Você é o assistente virtual do restaurante ${config.restaurantName || 'Nosso Restaurante'}!
  Nome: Jataí 🍕🤖
  - Seja simpático, rápido, informal e use emojis
  - Horário: ${config.hours || 'Não informado'}
  - Endereço: ${config.address || 'Não informado'}
  - Cardápio: ${config.menuUrl || 'Não informado'}
  - Telefone: ${config.phoneNumber || 'Não informado'}
  Nunca invente informações.
`;

const wait = ms => new Promise(r => setTimeout(r, ms));

// --- LIMPEZA DE SESSÃO ---
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  // Se uma limpeza já está em progresso, aguarda a conclusão e sai.
  if (sessionCleanupLocks[sessionId]) {
    console.log(`[Sessão ${sessionId}] 🧹 Aguardando limpeza anterior...`);
    await sessionCleanupLocks[sessionId].catch(err => {
      console.error(`[Sessão ${sessionId}] Erro na limpeza anterior (ignorado): ${err.message}`);
    });
    return;
  }

  const cleanupPromise = (async () => {
    console.log(`[Sessão ${sessionId}] 🧹 Iniciando limpeza da sessão... RemoveAuth=${forceRemoveAuth}`);

    const session = sessions[sessionId];
    if (!session) {
      console.log(`[Sessão ${sessionId}] 🧹 Sessão já não existia.`);
    }

    // Limpa timers de reconexão pendentes
    if (reconnectionTimers[sessionId]) {
      clearTimeout(reconnectionTimers[sessionId]);
      delete reconnectionTimers[sessionId];
    }
    // Limpa o heartbeat
    if (session?.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    const client = session?.client;
    if (client) {
      client.removeAllListeners();
      try {
        await client.destroy();
        console.log(`[Sessão ${sessionId}] 🧹 Cliente WA destruído com sucesso.`);
      } catch (e) {
        console.error(`[Sessão ${sessionId}] ⚠️ Erro ao destruir cliente (ignorado): ${e.message}`);
      }
    }

    // Remove todos os vestígios da sessão da memória
    delete sessions[sessionId];
    delete sessionModels[sessionId];
    delete userChats[sessionId];
    delete activeInitializations[sessionId];

    if (forceRemoveAuth) {
      try {
        const folder = path.join(sessionPathResolved, `session-${sessionId}`);
        if (fs.existsSync(folder)) {
          fs.rmSync(folder, { recursive: true, force: true });
          console.log(`[Sessão ${sessionId}] 🧹 Pasta de autenticação removida: ${folder}`);
        }
      } catch (fsErr) {
        console.error(`[Sessão ${sessionId}] ⚠️ Erro ao remover pasta de autenticação: ${fsErr.message}`);
      }
    }
    console.log(`[Sessão ${sessionId}] 🧹 Limpeza concluída.`);
  })();

  sessionCleanupLocks[sessionId] = cleanupPromise;
  try { await cleanupPromise; } finally { delete sessionCleanupLocks[sessionId]; }
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
      if (await isClientValid(sessionId)) {
        // OK
      } else {
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
  let readyDetected = false;

  client.on('qr', async (qr) => {
    try {
      const session = sessions[sessionId];
      if (!session) return;

      // Se um QR é gerado e a sessão já estava 'ready', significa que outra instância se conectou.
      if (readyDetected) {
        console.warn(`[Sessão ${sessionId}] ⚠️ QR regenerado após 'ready'. Múltiplas conexões detectadas. Encerrando.`);
        await set(sessionRef, { status: 'logged_out', reason: 'multiple_connections' });
        await cleanupSession(sessionId, true); // Limpeza forçada
        return;
      }

      if (!session.qrAttempts) session.qrAttempts = 0;
      session.qrAttempts++;
      const qrUrl = await qrcode.toDataURL(qr);

      console.log(`[Sessão ${sessionId}] QR gerado #${session.qrAttempts}`);
      await set(sessionRef, {
        status: 'QR_CODE',
        qr: qrUrl,
        attempt: session.qrAttempts
      });
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro no handler de QR:`, error);
    }
  });

  client.once('authenticated', () => {
    console.log(`[Sessão ${sessionId}] 🔐 Autenticado`);
  });

  client.once('ready', async () => {
    try {
      console.log(`[Sessão ${sessionId}] ✅ Cliente pronto`);
      readyDetected = true;
      await set(sessionRef, { status: 'ready' });
      const session = sessions[sessionId];
      if (session) {
        session.status = 'ready';
        session.qrAttempts = 0;
        session.reconnectAttempts = 0;
        session.lastActivity = Date.now();
        if (!session.heartbeatInterval) {
          session.heartbeatInterval = startHeartbeat(sessionId);
        }
      }
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro no handler de 'ready':`, error);
    }
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;

    const chatId = message.from;
    console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);

    try {
      if (!await isClientValid(sessionId)) {
        console.warn(`[Sessão ${sessionId}] Cliente inválido ao receber mensagem`);
        return;
      }

      const configSnap = await get(ref(database, `tenants/${sessionId}/whatsappConfig`));
      const config = configSnap.exists() ? configSnap.val() : {};

      if (!sessionModels[sessionId]) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash";
        const systemInstruction = createSystemInstruction(config);

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
      if (sessions[sessionId]) {
        sessions[sessionId].lastActivity = Date.now();
      }

    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro IA:`, err);
      try {
        await message.reply('Desculpe, tive um problema ao processar sua mensagem.');
      } catch (replyErr) {
        console.error(`[Sessão ${sessionId}] Erro ao enviar mensagem de erro:`, replyErr);
      }
    }
  });

  client.on('disconnected', async (reason) => {
    try {
      console.log(`[Sessão ${sessionId}] ❌ Desconectado: ${reason}`);
      readyDetected = false;

      // LOGOUT é geralmente uma ação terminal (usuário desconectou ou múltiplas sessões).
      // A sessão deve ser completamente encerrada.
      if (String(reason).toUpperCase() === 'LOGOUT') {
        console.log(`[Sessão ${sessionId}] Logout detectado, limpando sessão permanentemente.`);
        await set(sessionRef, { status: 'logged_out' });
        await cleanupSession(sessionId, true);
        return;
      }

      // Para outras razões de desconexão, tenta reconectar.
      const session = sessions[sessionId];
      if (!session) {
        return;
      }

      const attempts = session.reconnectAttempts || 0;
      if (attempts < MAX_RECONNECTION_ATTEMPTS) {
        session.reconnectAttempts = attempts + 1;
        const delay = RECONNECTION_DELAY * (attempts + 1); // Aumenta o delay a cada tentativa
        console.log(`[Sessão ${sessionId}] Tentando reconectar (${session.reconnectAttempts}/${MAX_RECONNECTION_ATTEMPTS}) em ${delay / 1000}s...`);

        await cleanupSession(sessionId, false); // Limpa a sessão atual antes de reconectar

        reconnectionTimers[sessionId] = setTimeout(() => {
          initializeWhatsAppClient(sessionId)
            .catch(e => console.error(`[Sessão ${sessionId}] Falha na reconexão agendada:`, e));
        }, delay);
      } else {
        console.error(`[Sessão ${sessionId}] Máximo de tentativas de reconexão atingido. Limpando permanentemente.`);
        await set(sessionRef, { status: 'disconnected' });
        await cleanupSession(sessionId, true);
      }
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro grave no handler de desconexão:`, error);
      await cleanupSession(sessionId, true); // Tenta uma limpeza final em caso de erro
    }
  });

  client.on('error', (err) => {
    console.error(`[Sessão ${sessionId}] Erro do cliente:`, err);
  });
};

// --- INICIALIZAÇÃO DO CLIENTE ---
const initializeWhatsAppClient = async (sessionId) => {
  if (activeInitializations[sessionId]) {
    return activeInitializations[sessionId];
  }

  activeInitializations[sessionId] = new Promise(async (resolve, reject) => {
    try {
      // Tenta limpar a sessão anterior, mas não deixa o processo falhar se a limpeza falhar.
      try {
        await cleanupSession(sessionId, false);
      } catch (cleanupErr) {
        console.warn(`[Sessão ${sessionId}] Aviso: A limpeza da sessão anterior falhou, mas a inicialização continuará. Erro: ${cleanupErr.message}`);
      }
      await wait(1000); // Pequeno cooldown 

      let client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: sessionPathResolved
        }),
        puppeteer: {
          headless: true, // Em produção, deve ser sempre true
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ],
          executablePath: '/usr/bin/chromium' // Adicionado para garantir que o Chromium instalado pelo Nixpacks seja usado
        }
      });

      attachLifecycleListeners(client, sessionId);

      sessions[sessionId] = {
        client,
        status: 'INITIALIZING',
        qrAttempts: 0,
        reconnectAttempts: (sessions[sessionId]?.reconnectAttempts || 0),
        lastActivity: Date.now(),
        heartbeatInterval: null
      };

      await client.initialize();
      resolve(sessions[sessionId]);

    } catch (e) {
      console.error(`[Sessão ${sessionId}] Erro na inicialização:`, e);
      await cleanupSession(sessionId, false); // Limpa em caso de falha
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
    // Se a sessão não existe no nosso servidor, ainda tentamos limpar os arquivos
    await cleanupSession(sessionId, true);
    res.status(404).json({ success: true, message: 'Sessão não encontrada no servidor, mas limpeza forçada.' });
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
        if (attempts < MAX_RECONNECTION_ATTEMPTS) {
          sessions[sessionId].reconnectAttempts = attempts + 1;
          const delay = RECONNECTION_DELAY * Math.pow(2, attempts);
          console.log(`[Sessão ${sessionId}] 🔄 Reconectando automaticamente (${attempts + 1}/${MAX_RECONNECTION_ATTEMPTS}) em ${delay/1000}s...`);
          
          await cleanupSession(sessionId, false);
          reconnectionTimers[sessionId] = setTimeout(() => {
            initializeWhatsAppClient(sessionId)
              .then(() => console.log(`[Sessão ${sessionId}] ✅ Reconexão bem-sucedida`))
              .catch(e => console.error(`[Sessão ${sessionId}] ❌ Falha na reconexão:`, e.message));
          }, delay);
        } else {
          console.log(`[Sessão ${sessionId}] ❌ Máximo de tentativas de reconexão atingido`);
          await cleanupSession(sessionId, true);
        }
        await set(sessionRef, { status: 'logged_out' });
        return;
      }
    }

    await set(sessionRef, { status: 'disconnected' }); // Garante a atualização imediata do status
    await cleanupSession(sessionId, false);

    // Tentar reconectar com delay maior
    const attempts = sessions[sessionId]?.reconnectAttempts || 0;
    if (attempts < MAX_RECONNECTION_ATTEMPTS) {
      const delay = RECONNECTION_DELAY * Math.pow(2, attempts); // Backoff exponencial
      console.log(`[Sessão ${sessionId}] Tentando reconectar em ${delay/1000}s (${attempts + 1}/${MAX_RECONNECTION_ATTEMPTS})...`);
      
      reconnectionTimers[sessionId] = setTimeout(() => {
        initializeWhatsAppClient(sessionId)
          .then(() => console.log(`[Sessão ${sessionId}] Reconexão bem-sucedida`))
          .catch(e => console.error(`[Sessão ${sessionId}] Falha na reconexão:`, e.message));
      }, delay);
    } else {
      console.error(`[Sessão ${sessionId}] Máximo de tentativas de reconexão atingido`);
    }
  });

  client.on('error', (err) => {
    console.error(`[Sessão ${sessionId}] Erro do cliente:`, err.message);
    
    // Tratar ProtocolError especificamente
    if (err.message && err.message.includes('ProtocolError')) {
      console.error(`[Sessão ${sessionId}] ❌ ProtocolError detectado - Reconectando...`);
      
      const attempts = sessions[sessionId]?.reconnectAttempts || 0;
      if (attempts < MAX_RECONNECTION_ATTEMPTS) {
        sessions[sessionId].reconnectAttempts = attempts + 1;
        const delay = RECONNECTION_DELAY * Math.pow(2, attempts);
        
        setTimeout(() => {
          initializeWhatsAppClient(sessionId)
            .catch(e => console.error(`[Sessão ${sessionId}] Falha na reconexão:`, e.message));
        }, delay);
      }
    }
  });
};

// --- INICIALIZAÇÃO DO CLIENTE ---
const initializeWhatsAppClient = async (sessionId) => {
  // Usar lock global para evitar múltiplas inicializações simultâneas
  if (globalInitLock[sessionId]) {
    console.log(`[Sessão ${sessionId}] Inicialização já em progresso, aguardando...`);
    return globalInitLock[sessionId];
  }

  if (activeInitializations[sessionId]) {
    return activeInitializations[sessionId];
  }

  globalInitLock[sessionId] = new Promise(async (resolve, reject) => {
    activeInitializations[sessionId] = new Promise(async (resolveInit, rejectInit) => {
      try {
        // Verificar se já existe uma instância ativa
        if (sessions[sessionId]?.client && await isClientValid(sessionId)) {
          console.log(`[Sessão ${sessionId}] Cliente já está ativo, retornando sessão existente`);
          resolveInit(sessions[sessionId]);
          resolve(sessions[sessionId]);
          delete globalInitLock[sessionId];
          return;
        }

        // Limpar sessão anterior se existir
        if (sessions[sessionId]) {
          await cleanupSession(sessionId, false);
        }

        // Aguardar um pouco antes de inicializar para evitar conflito
        await wait(INIT_COOLDOWN);

        let client = new Client({
          authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: sessionPathResolved
          }),
          puppeteer: {
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-extensions',
              '--disable-plugins',
              '--disable-images',
            ],
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
        resolveInit(sessions[sessionId]);
        resolve(sessions[sessionId]);

      } catch (e) {
        console.error(`[Sessão ${sessionId}] Erro na inicialização:`, e.message);
        rejectInit(e);
        reject(e);
      } finally {
        delete activeInitializations[sessionId];
        delete globalInitLock[sessionId];
      }
    });

    return activeInitializations[sessionId];
  });

  return globalInitLock[sessionId];
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
    console.error(`[QR ${sessionId}] erro:`, e.message);
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
    .catch(e => console.error(`[Sessão ${sessionId}] Falha init:`, e.message));

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
      console.error(`[Sessão ${sessionId}] Erro ao desconectar:`, e.message);
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
    console.error(`[Config ${sessionId}] erro:`, e.message);
    res.status(500).json({ error: 'Falha ao salvar config' });
  }
});

// --- GLOBAL ERROR HANDLERS ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
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