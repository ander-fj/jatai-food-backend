# Opções de Deploy para Sistema WhatsApp Multi-Tenant

## 🔴 Problema Atual
O Render Free Tier não tem disco persistente, causando:
- Perda de sessões WhatsApp a cada reinicialização
- Desconexões frequentes
- QR codes regenerados constantemente

---

## ✅ Soluções Recomendadas

### 1. **Render Starter Plan** (~$7/mês) ⭐ RECOMENDADO
- ✅ Disco persistente (1GB)
- ✅ Sem limite de horas
- ✅ Deploy automático via GitHub
- ✅ Fácil configuração (já configurado no `render.yaml`)

**Como ativar:**
1. No dashboard do Render, vá em Settings
2. Mude o plano de "Free" para "Starter"
3. Confirme o pagamento ($7/mês)
4. Faça redeploy

---

### 2. **Railway.app** (~$5/mês de crédito grátis)
- ✅ Volume persistente gratuito
- ✅ Melhor para apps com estado
- ✅ $5/mês grátis (depois $0.000463/GB-hour)
- ✅ Deploy via GitHub

**Como migrar:**
1. Acesse https://railway.app
2. Conecte com GitHub
3. Importe o repositório `jatai-food-backend`
4. Configure variáveis de ambiente
5. Deploy automático

---

### 3. **VPS (DigitalOcean/Vultr)** (~$5-6/mês)
- ✅ Controle total
- ✅ 100% estável
- ✅ Melhor performance
- ✅ Escalável

**Requer:**
- Configuração manual do servidor
- Conhecimento de Linux/SSH
- Nginx para reverse proxy
- PM2 para gerenciar processo Node.js

---

### 4. **Evolution API** (Alternativa Especializada)
- ✅ API dedicada para WhatsApp multi-instâncias
- ✅ Melhor para multi-tenant
- ✅ Self-hosted ou cloud
- ✅ Interface de gerenciamento

Repositório: https://github.com/EvolutionAPI/evolution-api

---

## 🎯 Recomendação Final

Para um sistema **multi-tenant de pizzarias**:

1. **Curto prazo**: Ative **Render Starter** ($7/mês)
   - Rápido de implementar
   - Resolve o problema imediatamente

2. **Médio prazo**: Migre para **Railway**
   - Mais barato
   - Melhor suporte para sessões

3. **Longo prazo**: Use **VPS** ou **Evolution API**
   - Mais profissional
   - Melhor para escalar (10+ pizzarias)

---

## 💰 Comparação de Custos

| Plataforma | Custo/mês | Persistência | Estabilidade | Escalabilidade |
|------------|-----------|--------------|--------------|----------------|
| Render Free | $0 | ❌ | ⚠️ | ⚠️ |
| Render Starter | $7 | ✅ | ✅ | ✅ |
| Railway | ~$5 | ✅ | ✅ | ✅ |
| VPS (DO) | $6 | ✅ | ✅✅ | ✅✅ |
| Evolution API | $0-10 | ✅ | ✅✅ | ✅✅✅ |

---

## 🚀 Ação Imediata

**Opção 1: Ativar Render Starter (5 minutos)**
```bash
git add render.yaml
git commit -m "feat: Add persistent disk support for Render Starter plan"
git push
```
Depois: Ativar Starter Plan no dashboard do Render

**Opção 2: Testar Railway (15 minutos)**
1. Acesse railway.app
2. Conecte GitHub
3. Deploy automático
4. Configure env vars no dashboard
