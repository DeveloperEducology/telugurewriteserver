import axios from "axios";
import * as cheerio from "cheerio";

export const scrapeUrlContent = async (url) => {
  if (!url || url.includes("twitter.com") || url.includes("x.com")) return null;

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 8000, // Increased timeout
    });

    const $ = cheerio.load(data);

    // 1. CLEANUP: Remove junk
    $("script, style, nav, footer, header, aside, iframe, .ads, .advertisement, .menu, .sidebar").remove();

    // 2. EXTRACT TITLE (Crucial for Context)
    const pageTitle = $("h1").first().text().trim() || $("title").text().trim();
    const metaDesc = $('meta[name="description"]').attr("content") || "";

    // 3. EXTRACT BODY
    let content = "";
    
    // Expanded selectors for better coverage (including ntnews specific classes)
    const selectors = [
      "article", 
      "[itemprop='articleBody']", 
      ".post-content", 
      ".story-content", 
      ".main-content", 
      ".article-body",
      "#content-body",
      ".entry-content"
    ];

    // Try finding specific container first
    let container = null;
    for (const selector of selectors) {
      if ($(selector).length > 0) {
        container = $(selector);
        break;
      }
    }

    // Extract paragraphs
    const target = container || $("body");
    target.find("p").each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) content += text + "\n";
    });

    // 4. COMBINE (Give AI the headline + description + body)
    const finalContext = `
      HEADLINE: ${pageTitle}
      DESCRIPTION: ${metaDesc}
      BODY:
      ${content}
    `.trim();

    // If total content is too short, return null to avoid bad AI results
    if (finalContext.length < 50) return null;

    return finalContext.substring(0, 15000); // Limit size for Gemini
  } catch (err) {
    console.error(`❌ Scraper Error (${url}): ${err.message}`);
    return null;
  }
};