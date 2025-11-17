const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testModels() {
  const modelsToTest = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro",
    "gemini-1.5-pro-002",
    "gemini-1.5-pro-latest",
    "gemini-pro",
    "gemini-2.0-flash-exp"
  ];

  console.log('🔍 Testando modelos disponíveis...\n');

  for (const modelName of modelsToTest) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent("Oi");
      const response = await result.response;
      const text = response.text();
      console.log(`✅ ${modelName} - FUNCIONA!`);
    } catch (error) {
      // Removido o substring para mostrar a mensagem de erro completa
      console.log(`❌ ${modelName} - ${error.message}`);
    }
  }
}

testModels();