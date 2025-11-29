# ⚙️ Variáveis de Ambiente para Railway

Copie e cole estas variáveis no Railway Dashboard → Variables:

```
NODE_ENV=production
GEMINI_API_KEY=AIzaSyD2-3zEw9OqMPDo4_05x5NVnjb77W11OJk
GEMINI_MODEL_NAME=gemini-2.5-flash
FIREBASE_API_KEY=AIzaSyDQ_q5pURFbmjuOlvB5RNslZUr6Y6Yo_aE
FIREBASE_AUTH_DOMAIN=dhl-teste-327e8.firebaseapp.com
FIREBASE_DATABASE_URL=https://dhl-teste-327e8-default-rtdb.firebaseio.com
FIREBASE_PROJECT_ID=dhl-teste-327e8
FIREBASE_STORAGE_BUCKET=dhl-teste-327e8.appspot.com
FIREBASE_MESSAGING_SENDER_ID=595095451120
FIREBASE_APP_ID=1:595095451120:web:YOUR_APP_ID_HERE
```

⚠️ **IMPORTANTE:** 
Se você tiver o `FIREBASE_APP_ID` correto no Render, substitua acima. 
Se não tiver, você pode obter ele:
1. Acesse https://console.firebase.google.com
2. Selecione o projeto `dhl-teste-327e8`
3. Vá em Configurações do Projeto → Aplicativos
4. Copie o `App ID`

---

## 📝 Como adicionar no Railway

1. No dashboard do projeto Railway
2. Clique na aba **Variables**
3. Cole TODAS as variáveis acima (uma por linha)
4. Clique em "Add" para cada uma
5. O Railway fará redeploy automático
