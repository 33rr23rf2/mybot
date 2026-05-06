import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  try {
    // В SDK немає прямого методу listModels, але ми можемо зробити прямий запит
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    
    if (data.error) {
      console.error("Помилка API:", data.error.message);
      return;
    }

    console.log("--- ДОСТУПНІ МОДЕЛІ ---");
    data.models.forEach(model => {
      if (model.supportedGenerationMethods.includes("generateContent")) {
        console.log(`- ${model.name.replace('models/', '')} (${model.displayName})`);
      }
    });
    console.log("-----------------------");
  } catch (error) {
    console.error("Помилка при отриманні списку моделей:", error.message);
  }
}

listModels();
