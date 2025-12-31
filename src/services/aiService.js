import { GoogleGenerativeAI } from "@google/generative-ai";
import { scrapeUrlContent } from "./scraperService.js";
import dotenv from "dotenv";
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-lite", // Updated model name from original prompt implies 2.0 or 1.5, adjusted for safety
  generationConfig: { responseMimeType: "application/json" },
});

export const formatTweetWithGemini = async (text, tweetUrl) => {
  const scrapedContext = tweetUrl ? await scrapeUrlContent(tweetUrl) : null;

  const prompt = `
Role: Senior Editor at Way2News/Inshorts (Telugu).
Task: Rewrite the provided input into a "Short News Card" format.

Input Text: "${text}"
${scrapedContext ? `Context: ${scrapedContext}` : ""}

=========================================
STRICT GUIDELINES (Way2News Style)
=========================================

1. HEADLINE (Title):
   - Must be PUNCHY and CLICKABLE (Catchy).
   - Structure: [statement]: [person].
   - Example:  "కృష్ణా జలాలు వైఎస్సార్‌ పుణ్యమే: వైఎస్‌ అవినాష్‌రెడ్డి"
   - Length: Max 8-10 words.
   - Language: Natural spoken Telugu (Vyavaharika Bhasha).

2. SUMMARY (Body):
   - Length: Strictly 60 to 75 words.
   - Format: Single paragraph. NO bullet points.
   - Flow:
     * Sentence 1: Direct lead (What happened?).
     * Sentence 2: Key details (Why/Where/When?), mention if there is any statistical data.
     * Sentence 3: Outcome or what's next (The conclusion) cover important information.
   - Tone: Fast-paced, factual, and easy to read.

3. METADATA:
   - Category: Pick one [Politics, Cinema, Sports, Crime, Business, Technology, General].
   - Slug: Create a short English word for image search (e.g., "cm jagan delhi tour").

=========================================
OUTPUT FORMAT (JSON ONLY - NO MARKDOWN)
=========================================
{
  "title": "Telugu Title Here",
  "summary": "The 60-word summary text here...",
  "category": "English Category",
  "slug_en": "english-slug-here"
}
`;
  try {
    const result = await model.generateContent(prompt);
    let textResp = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(textResp);
  } catch (e) {
    console.error("Gemini Error:", e.message);
    return null;
  }
};