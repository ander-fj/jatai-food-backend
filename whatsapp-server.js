const express = require('express');
const cors = require('cors');
const { Client } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');
 
// --- VERIFICAÇÃO DAS VARIÁVEIS DE AMBIENTE ---
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('\n[ERRO CRÍTICO] A variável de ambiente MONGO_URI não foi encontrada.');
  console.error('Por favor, configure a string de conexão do seu MongoDB no seu ambiente de produção ou no arquivo .env.');
  process.exit(1);
}

// Conexão com o MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Conexão com MongoDB estabelecida com sucesso!'))
  .catch(err => {
    console.error('ERRO ao conectar ao MongoDB:', err);
    process.exit(1);
  });

const store = new MongoStore({ mongoose: mongoose });
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
  // 'GEMINI_MODEL_NAME', // Opcional, mas recomendado
];
 
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
 
if (missingEnvVars.length > 0) {
  console.error('\n[ERRO CRÍTICO] As seguintes variáveis de ambiente essenciais não foram encontradas:');
  missingEnvVars.forEach(v => console.error(`- ${v}`));
  console.error('\nPor favor, configure-as no seu ambiente de produção (ex: Render Environment Variables) ou no arquivo .env para desenvolvimento local.\n');
  process.exit(1); // Encerra a aplicação se alguma variável estiver faltando.
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

// Inicializa o Firebase
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const app = express();
const port = process.env.PORT || 3001;

// --- CONFIGURAÇÃO DO CORS ---
// Lista de origens permitidas. Adicione a URL do seu frontend.
const allowedOrigins = [
  'https://www.jataifood.com.br',
  'https://jatai-food-backend.onrender.com', // Adicione a porta do seu frontend local para testes
  'http://localhost:5173', // Exemplo com Vite
];

app.use(cors({
  origin: allowedOrigins
}));
// Middleware para interpretar o corpo das requisições como JSON
app.use(express.json());

// Armazena as sessões dos clientes. A chave é o 'id' da sessão.
const sessions = {};
const sessionChatMappings = {}; // Mapeia qual cliente (id) está associado a quais conversas de chat (chatId). Isso pode ser mantido em memória ou também movido.
// Armazena as sessões de chat da IA para manter o histórico. A limpeza disso já está sendo tratada.
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
    res.status(500).json({ error: 'Erro ao buscar QR code.' });
  }
});

// Rota para iniciar a conexão do WhatsApp
app.post('/api/whatsapp/start/:id', (req, res) => {
  const { id } = req.params;

  if (sessions[id] && sessions[id].pupPage) { // Uma verificação mais segura de que o cliente está ativo
    return res.status(200).json({ success: true, message: `Sessão ${id} já está conectada.` });
  }

  console.log(`Iniciando conexão para a sessão: ${id}`);
  const statusRef = ref(database, `tenants/${id}/session/status`);
  const qrRef = ref(database, `tenants/${id}/session/qr`);
  set(statusRef, 'INITIALIZING');

  const client = new Client({
    authStrategy: store, // Usa a nova estratégia de persistência
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
  });

  client.on('qr', (qr) => {
    console.log(`QR Code para a sessão ${id}:`);
    qrcodeTerminal.generate(qr, { small: true });
    set(statusRef, 'QR_CODE');
    // Gera e armazena o QR Code como uma data URL diretamente
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) set(qrRef, url);
    });
  });

  client.on('ready', () => {
    console.log(`Sessão ${id} conectada com sucesso!`);
    set(statusRef, 'ready');
    // Limpa o QR code após a conexão
    remove(qrRef);
  });
  
  // Inicializa o mapeamento de chats para esta sessão
  if (!sessionChatMappings[id]) {
    sessionChatMappings[id] = new Set();
  }

  client.on('message', async (message) => {
    // Ignora as próprias mensagens para evitar loops
    if (message.fromMe) {
      return;
    }

    console.log(`Mensagem recebida de ${message.from}: "${message.body}"`);

    try {
      const chatId = message.from;

      // Adiciona o ID do chat ao mapeamento da sessão do cliente
      sessionChatMappings[id].add(chatId);

      let restaurantData = {};
      try {
        const configRef = ref(database, `tenants/${id}/whatsappConfig`);
        const snapshot = await get(configRef);
        if (snapshot.exists()) {
          restaurantData = snapshot.val();
        }
      } catch (dbError) {
        console.error("Erro ao buscar configuração do Firebase para o assistente:", dbError);
      }

      // VERIFICA SE O ASSISTENTE ESTÁ ATIVO
      if (!restaurantData.isActive) {
        console.log(`Assistente desativado para o tenant ${id}. Ignorando mensagem.`);
        return; // Para a execução aqui se o assistente estiver inativo
      }

      // Inicia uma nova sessão de chat se não existir uma para este usuário
      if (!chatSessions[chatId]) {
        console.log(`Iniciando nova sessão de chat para ${chatId}`);

        if (Object.keys(restaurantData).length > 0) {
          console.log(`Configuração do restaurante "${restaurantData.restaurantName}" carregada do Firebase para o assistente.`);
        } else {
          console.log(`Nenhuma configuração encontrada no Firebase para o tenant ${id}. Usando instruções genéricas.`);
        }

        // A instrução do sistema é definida apenas uma vez, quando a conversa começa.
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
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash"; // Usa a variável ou um padrão
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        chatSessions[chatId] = model.startChat({
          history: [], // Começa com histórico vazio
        });
      }

      const chat = chatSessions[chatId];
      const result = await chat.sendMessage(message.body);
      const response = await result.response;
      const text = response.text();
      await message.reply(text);
    } catch (e) {
      console.error('Erro ao gerar resposta da IA:', e);
      await message.reply('Desculpe, não consegui processar sua solicitação no momento.');
    }
  });

  client.on('disconnected', (reason) => {
    console.log(`Sessão ${id} foi desconectada. Razão:`, reason);
    const sessionRef = ref(database, `tenants/${id}/session`);
    remove(sessionRef); // Limpa status e QR do Firebase

    // Limpa as sessões de chat da IA associadas a esta instância do WhatsApp
    Object.keys(chatSessions).forEach(key => {
      if (sessions[id]?.info?.wid?.user === key.split('@')[0]) {
          console.log(`Limpando sessão de chat para ${key}`);
          delete chatSessions[key];
      }
    });
    // Limpa o mapeamento de chats para a sessão desconectada
    if (sessionChatMappings[id]) {
      delete sessionChatMappings[id];
    }
    client.destroy();
    delete sessions[id];
  });

  client.initialize();
  sessions[id] = client;

  // Responde imediatamente para o frontend não ficar esperando
  res.status(202).json({ success: true, message: `Inicialização da sessão ${id} iniciada. Escaneie o QR Code.` });
});

// Rota para parar a conexão do WhatsApp
app.post('/api/whatsapp/stop/:id', async (req, res) => {
  const { id } = req.params;
  const client = sessions[id];

  if (client) {
    console.log(`Desconectando sessão ${id}...`);
    await client.logout(); // O evento 'disconnected' cuidará da limpeza
    res.status(200).json({ success: true, message: `Sessão ${id} desconectada.` });
  } else {
    // Se não houver cliente, apenas limpa o status
    const statusRef = ref(database, `tenants/${id}/session/status`);
    set(statusRef, 'disconnected');
    res.status(404).json({ success: false, error: `Sessão ${id} não encontrada.` });
  }
});

// Rota para enviar mensagem
app.post('/api/whatsapp/send-message/:id', async (req, res) => {
  const { id } = req.params;
  const { number, message } = req.body; // Pega o número e a mensagem do corpo da requisição

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
    // Formata o número para o padrão do WhatsApp (código do país + ddd + número + @c.us)
    const chatId = `${number}@c.us`;
    await client.sendMessage(chatId, message);
    console.log(`Mensagem enviada para ${number} na sessão ${id}`);
    res.status(200).json({ success: true, message: `Mensagem enviada para ${number}` });
  } catch (error) {
    console.error(`Erro ao enviar mensagem na sessão ${id}:`, error);
    res.status(500).json({ success: false, error: 'Erro ao enviar mensagem.', details: error.message });
  }
});

// Rota para atualizar a configuração do restaurante
app.post('/api/config/update/:id', async (req, res) => {
  const { id } = req.params; // O 'id' da sessão/tenant
  const newData = req.body;

  if (!newData || Object.keys(newData).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado fornecido para atualização.' });
  }
  
  try {
    // Importe a função 'set' do firebase/database no topo do arquivo
    // const { getDatabase, ref, get, set } = require('firebase/database');
    const configRef = ref(database, `tenants/${id}/whatsappConfig`);
    // ATENÇÃO: O 'set' substitui todos os dados no local. Se quiser apenas atualizar, use 'update'.
    // Para usar 'update', importe-o e chame update(configRef, newData);
    await set(configRef, newData);

    // Limpa as sessões de chat da IA que pertencem a este tenant para forçar a recriação com as novas instruções
    if (sessionChatMappings[id]) {
      sessionChatMappings[id].forEach(chatId => {
        if (chatSessions[chatId]) {
          delete chatSessions[chatId];
        }
      });
    }
    console.log(`[Sessão ${id}] Configurações do assistente atualizadas com sucesso no Firebase! As sessões de IA foram reiniciadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas e sessões de IA reiniciadas.' });
  } catch (error) {
    console.error(`[Sessão ${id}] Erro ao salvar configuração no Firebase:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração no servidor.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});