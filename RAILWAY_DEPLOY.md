# Railway Deployment Guide

## 🚂 Deploy no Railway.app

### Passo 1: Criar Projeto
1. Acesse https://railway.app
2. Clique em "Login" e faça login com GitHub
3. Clique em "New Project"
4. Selecione "Deploy from GitHub repo"
5. Escolha o repositório `ander-fj/jatai-food-backend`

### Passo 2: Configurar Variáveis de Ambiente
No dashboard do Railway, vá em **Variables** e adicione:

```
NODE_ENV=production
PORT=10000
SESSION_PATH=/app/data/wwebjs_auth

# Gemini AI
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL_NAME=gemini-2.5-flash

# Firebase
FIREBASE_API_KEY=sua_chave_aqui
FIREBASE_AUTH_DOMAIN=seu_dominio.firebaseapp.com
FIREBASE_DATABASE_URL=https://seu_projeto.firebaseio.com
FIREBASE_PROJECT_ID=seu_projeto_id
FIREBASE_STORAGE_BUCKET=seu_projeto.appspot.com
FIREBASE_MESSAGING_SENDER_ID=seu_sender_id
FIREBASE_APP_ID=seu_app_id
```

### Passo 3: Adicionar Volume Persistente
1. No dashboard do projeto, clique em **Settings**
2. Vá para **Volumes**
3. Clique em "Add Volume"
4. Configure:
   - **Mount Path**: `/app/data`
   - **Size**: 1 GB (suficiente para sessões)

### Passo 4: Deploy
1. O Railway fará deploy automático
2. Aguarde o build completar (~2-3 minutos)
3. Você receberá uma URL pública (ex: `https://seu-app.railway.app`)

### Passo 5: Atualizar Frontend
No seu projeto frontend, atualize a variável:
```
VITE_API_URL=https://seu-app.railway.app
```

### Passo 6: Adicionar Domínio Personalizado (Opcional)
1. Em **Settings** → **Networking**
2. Clique em "Generate Domain" para obter domínio railway.app
3. Ou configure domínio customizado

---

## 📊 Monitoramento

**Logs em tempo real:**
- No dashboard, clique em **Deployments** → **View Logs**

**Métricas:**
- CPU, Memória e Rede disponíveis no dashboard

**Custos:**
- $5 de crédito grátis
- Depois: ~$0.000463/GB-hour (~$5-10/mês dependendo do uso)

---

## 🔄 Deploy Automático

Cada push no GitHub faz deploy automático. Para desabilitar:
1. Settings → Service → Build & Deploy
2. Desmarque "Auto Deploy"

---

## 🐛 Troubleshooting

**Sessões perdendo:**
- Verifique se o volume está montado em `/app/data`
- Verifique variável `SESSION_PATH=/app/data/wwebjs_auth`

**Erro de memória:**
- Railway oferece 512MB por padrão
- Se precisar mais, pode escalar no plano

**CORS error:**
- Adicione sua URL do Railway no `allowedOrigins` do código
