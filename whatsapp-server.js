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
// Railway: /app/data é o volume persistente
// Render: /var/data é o volume persistente  
// Local: ./wwebjs_auth
const isRailway = process.env.RAILWAY_ENVIRONMENT !== undefined;
const isRender = process.env.RENDER !== undefined;

let SESSION_BASE_PATH;
if (isRailway) {
  SESSION_BASE_PATH = '/app/data/wwebjs_auth';
} else if (isRender) {
  SESSION_BASE_PATH = process.env.SESSION_PATH || '/var/data/wwebjs_auth';
} else {
  SESSION_BASE_PATH = process.env.SESSION_PATH || path.join(__dirname, '.wwebjs_auth');
}

let sessionPathResolved = SESSION_BASE_PATH;

console.log(`[Sistema] Plataforma detectada: ${isRailway ? 'Railway' : isRender ? 'Render' : 'Local'}`);
console.log(`[Sistema] Caminho de sessão configurado: ${SESSION_BASE_PATH}`);

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
  'https://jataifood.vercel.app',
  'https://jatai-food-backend.onrender.com',
  'https://jatai-food-backend-production.up.railway.app',
  'http://localhost:5173',
  'http://localhost:5174',
];

// Adicionar automaticamente a URL do Railway se disponível
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  allowedOrigins.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}

console.log(`[CORS] Origens permitidas:`, allowedOrigins);

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
  let menuContent = `
  Cardápio Jataí Food:
  - Pizza de Calabresa: R$ 40,00
  - Pizza de Mussarela: R$ 38,00
  - Pizza de Frango com Catupiry: R$ 45,00
  - Hambúrguer Clássico: R$ 25,00
  - X-Bacon: R$ 28,00
  - Batata Frita: R$ 15,00
  - Refrigerante Lata: R$ 5,00
  - Água: R$ 3,00
  `;

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
      console.error(`[IA] Falha ao buscar cardápio da URL. Usando cardápio padrão. Erro: ${error.message}`);
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
  Nunca invente informações.
`;
};

const wait = ms => new Promise(r => setTimeout(r, ms));

// --- FUNÇÕES DE VALIDAÇÃO ---
const isPuppeteerError = (error) => {
  const errorStr = String(error);
  return errorStr.includes('Falha na avaliação') || 
         errorStr.includes('ExecutionContext') ||
         errorStr.includes('Target closed') ||
         errorStr.includes('Session closed');
};

// --- LIMPEZA DE SESSÃO ---
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... RemoveAuth=${forceRemoveAuth}`);

  const client = sessions[sessionId]?.client || null;

  try { await remove(ref(database, `tenants/${sessionId}/session`)); } catch {}

  if (client) {
    try {
      client.removeAllListeners();
      
      // Aguardar um pouco antes de destruir para permitir que operações pendentes terminem
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await client.destroy();
    } catch (e) {
      // Ignorar erros de destruição, pois o cliente já pode estar fechado
      if (!String(e).includes('Target closed') && !String(e).includes('ProtocolError')) {
        console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, e.message);
      }
    }
    delete sessions[sessionId];
  }

  delete sessionModels[sessionId];
  delete userChats[sessionId];
  delete messageProcessingLocks[sessionId];

  // Limpar timers
  if (reconnectionTimers[sessionId]) {
    clearTimeout(reconnectionTimers[sessionId]);
    delete reconnectionTimers[sessionId];
  }

  if (forceRemoveAuth) {
    const folder = path.join(sessionPathResolved, `session-${sessionId}`);
    if (fs.existsSync(folder)) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
        console.log(`[Sessão ${sessionId}] Pasta removida: ${folder}`);
      } catch (e) {
        console.error(`[Sessão ${sessionId}] Erro ao remover pasta:`, e.message);
      }
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
  let qrCount = 0;

  client.on('qr', async (qr) => {
    const session = sessions[sessionId];
    if (!session) {
      console.log(`[Sessão ${sessionId}] ⚠️  QR recebido mas sessão não existe mais`);
      return;
    }
    
    // Adicionado para evitar QR em sessão pronta
    if (session.status === 'ready') {
      console.log(`[Sessão ${sessionId}] ⚠️  QR ignorado, sessão já está pronta.`);
      return;
    }

    qrCount++;
    session.qrAttempts++;
    const qrUrl = await qrcode.toDataURL(qr);

    const currentStatus = session.status;
    console.log(`[Sessão ${sessionId}] QR gerado #${session.qrAttempts} (Status atual: ${currentStatus})`);

    await set(sessionRef, {
      status: 'QR_CODE',
      qr: qrUrl,
      attempt: session.qrAttempts
    });
  });

  client.once('authenticated', () => {
    console.log(`[Sessão ${sessionId}] 🔐 Autenticado`);
  });

  client.once('ready', async () => {
    console.log(`[Sessão ${sessionId}] ✅ Cliente pronto`);
    await set(sessionRef, { status: 'ready' });
    sessions[sessionId].status = 'ready';
    sessions[sessionId].qrAttempts = 0;
    sessions[sessionId].reconnectAttempts = 0;
    sessions[sessionId].lastActivity = Date.now();

    if (!sessions[sessionId].heartbeatInterval) {
      sessions[sessionId].heartbeatInterval = startHeartbeat(sessionId);
    }
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;

    const chatId = message.from;
    const messageId = message.id.id || `${Date.now()}-${Math.random()}`;

    if (messageProcessingLocks[messageId]) {
      return;
    }

    messageProcessingLocks[messageId] = true;

    try {
      console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);

      if (!await isClientValid(sessionId)) {
        console.warn(`[Sessão ${sessionId}] ⚠️  Cliente inválido ao receber mensagem`);
        return;
      }

      if (!message.body || message.body.trim() === '') {
        console.log(`[Sessão ${sessionId}] ⏭️  Mensagem vazia, ignorando`);
        return;
      }

      const configSnap = await get(ref(database, `tenants/${sessionId}/whatsappConfig`));
      const config = configSnap.exists() ? configSnap.val() : {};

      if (!sessionModels[sessionId]) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";
        const systemInstruction = await createSystemInstruction(config); // Agora é assíncrono

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

      const result = await Promise.race([
        chat.sendMessage(message.body),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout ao processar mensagem')), MESSAGE_TIMEOUT)
        )
      ]);

      console.log(`[Sessão ${sessionId}] Resposta da IA recebida.`);
      const response = result.response;
      if (!response) {
          console.error(`[Sessão ${sessionId}] Erro: A resposta da IA é nula ou indefinida.`);
          await message.reply('Desculpe, não consegui gerar uma resposta.');
          return;
      }

      const text = response.text();
      console.log(`[Sessão ${sessionId}] Texto da IA: "${text}"`);

      if (!await isClientValid(sessionId)) {
        console.warn(`[Sessão ${sessionId}] ⚠️  Cliente desconectou antes de enviar resposta`);
        return;
      }
      
      try {
        await message.reply(text);
      } catch (replyErr) {
        console.error(`[Sessão ${sessionId}] Erro específico ao tentar enviar a resposta (message.reply):`, replyErr);
        // Se o erro de resposta for um erro de puppeteer, trate-o como crítico.
        if (isPuppeteerError(replyErr)) {
            console.error(`[Sessão ${sessionId}] ❌ Erro crítico do Puppeteer durante o message.reply`);
        }
        return; // Interrompe a execução aqui, pois o envio da mensagem falhou
      }

      sessions[sessionId].lastActivity = Date.now();

    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro ao processar mensagem:`, err.message);
      if (err.stack) {
        console.error(`[Sessão ${sessionId}] Stack:`, err.stack);
      }

      if (isPuppeteerError(err)) {
        console.error(`[Sessão ${sessionId}] ❌ Erro crítico do Puppeteer detectado. A sessão será reiniciada.`);
        
        if (sessions[sessionId] && sessions[sessionId].isRestarting) {
            console.log(`[Sessão ${sessionId}] Reinicialização já em andamento.`);
            return;
        }
        if(sessions[sessionId]) sessions[sessionId].isRestarting = true;

        await cleanupSession(sessionId, false);
        await set(ref(database, `tenants/${sessionId}/session`), { status: 'restarting' });

        console.log(`[Sessão ${sessionId}] Agendando reinicialização em ${RECONNECTION_DELAY / 1000}s...`);
        reconnectionTimers[sessionId] = setTimeout(() => {
          initializeWhatsAppClient(sessionId)
            .then(() => {
                console.log(`[Sessão ${sessionId}] Reinicialização concluída com sucesso.`);
                if(sessions[sessionId]) delete sessions[sessionId].isRestarting;
            })
            .catch(e => {
                console.error(`[Sessão ${sessionId}] Falha na reinicialização agendada:`, e.message);
                if(sessions[sessionId]) delete sessions[sessionId].isRestarting;
            });
        }, RECONNECTION_DELAY);

        return;
      }

      try {
        if (await isClientValid(sessionId)) {
          await message.reply('Desculpe, tive um problema ao processar sua mensagem.');
        }
      } catch (replyErr) {
        console.error(`[Sessão ${sessionId}] Erro ao enviar mensagem de erro de fallback:`, replyErr.message);
      }
    } finally {
      delete messageProcessingLocks[messageId];
    }
  });

  client.on('disconnected', async (reason) => {
    console.log(`[Sessão ${sessionId}] ❌ Desconectado: ${reason}`);

    if (String(reason).toUpperCase() === 'LOGOUT') {
      console.log(`[Sessão ${sessionId}] Logout detectado, limpando sessão...`);
      await cleanupSession(sessionId, true); // Revertido para 'true' para garantir limpeza completa
      await set(sessionRef, { status: 'logged_out' });
      return;
    }

    await cleanupSession(sessionId, false);
    await set(sessionRef, { status: 'disconnected' });

    // Tentar reconectar com delay maior
    const attempts = sessions[sessionId]?.reconnectAttempts || 0;
    if (attempts < MAX_RECONNECTION_ATTEMPTS) {
      const delay = RECONNECTION_DELAY * (attempts + 1);
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

  console.log(`[Sessão ${sessionId}] 📞 Requisição /start recebida`);

  const now = Date.now();
  const WINDOW = 10000;

  if (startRequestTimestamps[sessionId]) {
    const delta = now - startRequestTimestamps[sessionId];
    if (delta < WINDOW) {
      console.log(`[Sessão ${sessionId}] ⏰ Requisição bloqueada - aguardar ${Math.ceil((WINDOW - delta) / 1000)}s`);
      return res.status(429).json({
        success: false,
        message: `Espere ${Math.ceil((WINDOW - delta) / 1000)} segundos para tentar novamente`
      });
    }
  }

  startRequestTimestamps[sessionId] = now;

  // Verificar se já está inicializando
  if (globalInitLock[sessionId] || activeInitializations[sessionId]) {
    console.log(`[Sessão ${sessionId}] ⚠️  Inicialização já em andamento`);
    return res.json({ success: true, message: 'Inicialização já em andamento' });
  }

  // Verificar se já está conectado
  const isValid = await isClientValid(sessionId);
  if (isValid) {
    console.log(`[Sessão ${sessionId}] ✅ Já está conectado`);
    return res.json({ success: true, message: 'Sessão já conectada' });
  }

  const sessionRef = ref(database, `tenants/${sessionId}/session`);
  const snap = await get(sessionRef);
  const fbStatus = snap.exists() ? snap.val().status : 'disconnected';

  console.log(`[Sessão ${sessionId}] Status atual: ${fbStatus}`);

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
  // Ignorar erros de protocol após logout (são esperados)
  if (reason && String(reason).includes('Target closed')) {
    return;
  }
  if (reason && String(reason).includes('ProtocolError')) {
    return;
  }
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