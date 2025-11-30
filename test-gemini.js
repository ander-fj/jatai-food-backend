const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// --- Validação da Chave de API ---
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ ERRO: A variável de ambiente GEMINI_API_KEY não foi definida.");
  console.error("Por favor, adicione sua chave ao arquivo .env ou configure-a no seu ambiente.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Testa a disponibilidade e funcionalidade de uma lista de modelos Gemini.
 */
async function testGeminiModels() {
  // Lista refinada com modelos comuns e suas versões "latest".
  const modelsToTest = [
    "gemini-1.5-flash",       // Alias para a versão estável mais recente do Flash
    "gemini-1.5-flash-latest",// Aponta para a versão mais recente, pode ser instável
    "gemini-1.5-pro",         // Alias para a versão estável mais recente do Pro
    "gemini-1.5-pro-latest",  // Aponta para a versão mais recente do Pro
    "gemini-pro",             // Modelo mais antigo, mas ainda muito utilizado
  ];

  const workingModels = [];
  const failedModels = [];

  console.log('🔍 Iniciando teste de modelos Gemini...\n');

  for (const modelName of modelsToTest) {
    try {
      console.log(`- Testando '${modelName}'...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      // Envia uma solicitação simples para verificar a funcionalidade
      const result = await model.generateContent("Oi, tudo bem?");
      await result.response; // Aguarda a resposta para confirmar que não há erro
      
      console.log(`  ✅ SUCESSO: Modelo '${modelName}' está funcionando!\n`);
      workingModels.push(modelName);

    } catch (error) {
      let errorMessage = error.message;
      if (error.message.includes('404')) {
        errorMessage = "Modelo não encontrado ou você não tem acesso a ele.";
      } else if (error.message.includes('API key not valid')) {
        errorMessage = "A chave de API fornecida não é válida.";
      }
      
      console.error(`  ❌ FALHA: Modelo '${modelName}' falhou. Motivo: ${errorMessage}\n`);
      failedModels.push({ model: modelName, reason: errorMessage });
    }
  }

  // --- Relatório Final ---
  console.log("--- Relatório Final do Teste Gemini ---");
  
  if (workingModels.length > 0) {
    console.log("\n✅ Modelos Funcionais:");
    workingModels.forEach(m => console.log(`  - ${m}`));
    console.log("\nVocê pode usar qualquer um desses nomes de modelo no seu arquivo 'whatsapp-server.js'.");
    console.log("Recomendamos 'gemini-2.5-flash' para um bom equilíbrio entre custo e performance.");
  } else {
    console.log("\n❌ Nenhum modelo Gemini funcional foi encontrado.");
  }

  if (failedModels.length > 0) {
    console.log("\n❌ Modelos com Falha:");
    failedModels.forEach(m => console.log(`  - ${m.model}: ${m.reason}`));
    console.log("\nVerifique os nomes dos modelos, sua chave de API e suas permissões de acesso no Google AI Studio.");
  }
  
  console.log("\n--- Teste Concluído ---");
}

testGeminiModels();