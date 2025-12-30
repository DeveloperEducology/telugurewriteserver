import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import sharp from "sharp";
import multer from "multer";
import * as cheerio from "cheerio";
import Parser from "rss-parser"; 
import stringSimilarity from "string-similarity";

// --- 1. INITIALIZATION ---
dotenv.config();
const app = express();
const PORT = process.env.PORT || 4001;

// --- CONFIGURATION ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const TWITTER_API_IO_KEY = process.env.TWITTER_API_KEY;
const AWS_BUCKET_NAME = process.env.AWS_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;

// --- TARGETS ---
const TARGET_HANDLES = [
  "IndianTechGuide",
  "TeluguScribe",
];

const RSS_FEEDS = [
  { name: "NTV Telugu", url: "https://ntvtelugu.com/feed" },
  { name: "Disha Daily", url: "https://www.dishadaily.com/google_feeds.xml" },
  { name: "TV9 Telugu", url: "https://tv9telugu.com/feed" },
  { name: "10TV Telugu", url: "https://10tv.in/latest/feed" },
  { name: "Namasthe Telangana", url: "https://www.ntnews.com/feed" },
  { name: "ABP Telugu", url: "https://telugu.abplive.com/news/feed" },
  { name: "Google News", url: "https://news.google.com/rss?hl=te&gl=IN&ceid=IN:te" },
  { name: "NDTV India", url: "https://feeds.feedburner.com/ndtvnews-india-news" },
  { name: "NDTV Sports", url: "https://feeds.feedburner.com/ndtvsports-latest" },
];

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage() });

const rssParser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent'], 
            ['media:thumbnail', 'mediaThumbnail'],
            ['content:encoded', 'contentEncoded']
        ]
    }
});

// --- VALIDATION ---
if (!GEMINI_API_KEY || !MONGO_URI || !TWITTER_API_IO_KEY) {
  console.error("❌ CRITICAL ERROR: Missing keys in .env file.");
  process.exit(1);
}

// --- 2. DB CONNECTION ---
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// --- 3. SCHEMAS ---

// Sub-schema for Related Stories
const relatedStorySchema = new mongoose.Schema({
    title: { type: String, required: true },
    summary: String,
    imageUrl: String,
    url: String
}, { _id: false });

const queueSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  text: String,
  url: String,
  media: Array,
  imageUrl: String,
  extendedEntities: Object,
  relatedStories: [relatedStorySchema],
  source: { type: String, default: "Manual" },
  user: Object,
  postType: { type: String, default: "normal_post" },
  promptType: { type: String, default: "DETAILED" }, 
  useAuthorContext: { type: Boolean, default: true },
  originalDbId: { type: mongoose.Schema.Types.ObjectId, default: null },
  queuedAt: { type: Date, default: Date.now },
});
const Queue = mongoose.models.Queue || mongoose.model("Queue", queueSchema);

const tagSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
}, { timestamps: true });
const Tag = mongoose.models.Tag || mongoose.model("Tag", tagSchema);

const postSchema = new mongoose.Schema({
    postId: { type: Number, unique: true },
    title: { type: String, required: true },
    summary: String,
    text: String,
    url: { type: String, unique: true, sparse: true },
    imageSearchSlug: { type: String, default: "" }, 
    imageUrl: String,
    videoUrl: String,
    relatedStories: [relatedStorySchema],

    media: [{
        mediaType: { type: String, default: "image" },
        url: String,
        width: Number,
        height: Number,
    }],
    sourceName: String,
    source: { type: String, default: "Manual" },
    sourceType: { type: String, default: "manual" },
    tweetId: { type: String, unique: true, sparse: true },
    twitterUrl: String,
    categories: [{ type: String, default: "General" }],
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],
    publishedAt: { type: Date, default: Date.now },
    isPublished: { type: Boolean, default: true },
    isAINews: { type: Boolean, default: false },
    type: { type: String, default: "normal_post" },
    lang: { type: String, default: "te" },
}, { timestamps: true, collection: "posts" });

const Post = mongoose.models.Post || mongoose.model("Post", postSchema);

// --- 4. GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite",
  generationConfig: { responseMimeType: "application/json" },
});

// --- HELPER FUNCTIONS ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const generatePostId = () => Math.floor(100000000 + Math.random() * 900000000);

// Helper: Normalize URL
function normalizeUrl(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url);
    urlObj.search = ""; 
    let cleanUrl = urlObj.toString();
    if (cleanUrl.endsWith("/")) cleanUrl = cleanUrl.slice(0, -1);
    return cleanUrl;
  } catch (e) { return url; }
}

function extractSlugFromUrl(url) {
    if (!url) return "";
    try {
        const urlObj = new URL(url);
        const pathSegments = urlObj.pathname.split('/').filter(Boolean);
        let slug = pathSegments[pathSegments.length - 1];
        if (slug && /^\d+$/.test(slug) && pathSegments.length > 1) {
            slug = pathSegments[pathSegments.length - 2];
        }
        if (!slug) return "";
        return slug.replace(/\.html?$/i, "").replace(/_/g, "-").toLowerCase();
    } catch (e) { return ""; }
}

async function getOrCreateTags(tagNames) {
  if (!tagNames || !Array.isArray(tagNames)) return [];
  const tagIds = [];
  for (const name of tagNames) {
    const slug = name.toLowerCase().replace(/ /g, "-").replace(/[^\w-]+/g, "");
    try {
      let tag = await Tag.findOne({ slug });
      if (!tag) tag = await Tag.create({ name, slug });
      tagIds.push(tag._id);
    } catch (e) { console.error(`Tag Error: ${e.message}`); }
  }
  return tagIds;
}

// ✅ SCRAPER
async function scrapeUrlContent(url) {
  if (!url || url.includes("twitter.com") || url.includes("x.com")) return null;
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" },
      timeout: 5000,
    });
    const $ = cheerio.load(data);
    $("script, style, nav, footer, header, aside, iframe, .ads").remove();
    let content = "";
    $('article, [itemprop="articleBody"], .post-content, .story-content').find("p").each((i, el) => {
       content += $(el).text().trim() + "\n";
    });
    if(!content) {
        $("p").each((i, el) => { if($(el).text().length > 30) content += $(el).text().trim() + "\n"; });
    }
    return content.substring(0, 15000).trim();
  } catch (err) {
    return null;
  }
}

// ✅ HELPER: Extract Image from RSS Item
function extractRSSImage(item) {
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
    if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
    if (item.contentEncoded || item.content) {
        const html = item.contentEncoded || item.content;
        const $ = cheerio.load(html);
        const firstImg = $('img').first().attr('src');
        if (firstImg) return firstImg;
    }
    return null;
}

// --- CORE FETCHING LOGIC ---

// 1. TWITTER FETCH
async function fetchAndQueueTweetsForHandle(userName) {
  const API_URL = "https://api.twitterapi.io/twitter/user/last_tweets";
  try {
    const response = await fetch(`${API_URL}?userName=${userName}`, {
      headers: { "X-API-Key": TWITTER_API_IO_KEY },
    });
    if (!response.ok) return 0;
    const data = await response.json();
    let tweets = data?.tweets ?? data?.data?.tweets ?? [];
    tweets = tweets.slice(0, 5); 

    if (tweets.length === 0) return 0;

    const postedIds = await Post.find({ tweetId: { $in: tweets.map((t) => t.id) } }).distinct("tweetId");
    const queuedIds = await Queue.find({ id: { $in: tweets.map((t) => t.id) } }).distinct("id");
    const ignoredIds = new Set([...postedIds, ...queuedIds]);
    const newTweets = tweets.filter((t) => !ignoredIds.has(t.id));

    if (newTweets.length === 0) return 0;

    const queueDocs = newTweets.map((t) => ({
      id: t.id,
      text: t.text,
      url: t.url,
      media: t.media || [],
      extendedEntities: t.extendedEntities || {},
      user: t.user || { screen_name: userName, name: userName },
      postType: "normal_post",
      useAuthorContext: false,
    }));

    await Queue.insertMany(queueDocs);
    console.log(`✅ Auto-Fetch: Queued ${newTweets.length} from @${userName}`);
    return newTweets.length;
  } catch (error) {
    console.error(`❌ Auto-Fetch Error:`, error.message);
    return 0;
  }
}

// 2. RSS FETCH & QUEUE (With Locking & Dedup)
let isRSSFetching = false;

async function fetchAndQueueRSS() {
    if (isRSSFetching) {
        console.log("⚠️ RSS Fetch running. Skipping.");
        return 0;
    }
    isRSSFetching = true; // Lock
    
    console.log("📡 RSS: Starting Fetch Cycle...");
    let totalQueued = 0;

    try {
        const recentPosts = await Post.find({
            publishedAt: { $gte: new Date(Date.now() - 72 * 60 * 60 * 1000) }
        }).select('title url');
        const recentQueue = await Queue.find().select('text url');

        const existingTitles = [
            ...recentPosts.map(p => p.title),
            ...recentQueue.map(q => q.text.split('\n')[0].replace("Title: ", ""))
        ].filter(Boolean);

        const existingUrls = new Set([
            ...recentPosts.map(p => normalizeUrl(p.url)),
            ...recentQueue.map(q => normalizeUrl(q.url))
        ]);

        for (const feedSource of RSS_FEEDS) {
            try {
                const feed = await rssParser.parseURL(feedSource.url);
                const items = feed.items.slice(0, 5); 

                for (const item of items) {
                    const cleanLink = normalizeUrl(item.link);
                    if (existingUrls.has(cleanLink)) continue;

                    let isDuplicate = false;
                    if (existingTitles.length > 0) {
                        const matches = stringSimilarity.findBestMatch(item.title, existingTitles);
                        if (matches.bestMatch.rating > 0.65) isDuplicate = true;
                    }

                    if (!isDuplicate) {
                        const extractedImage = extractRSSImage(item);
                        const mediaObj = extractedImage ? [{
                            type: 'photo',
                            media_url_https: extractedImage,
                            url: extractedImage
                        }] : [];

                        const newItem = new Queue({
                            id: new mongoose.Types.ObjectId().toString(),
                            text: `Title: ${item.title}\nSummary: ${item.contentSnippet || ""}`,
                            url: item.link,
                            imageUrl: extractedImage, 
                            media: mediaObj,
                            extendedEntities: { media: mediaObj }, 
                            source: feedSource.name,
                            user: { name: feedSource.name, screen_name: "RSS_Feed" },
                            postType: "normal_post",
                            promptType: "NEWS_ARTICLE",
                            queuedAt: new Date()
                        });

                        await newItem.save();
                        existingTitles.push(item.title);
                        existingUrls.add(cleanLink);
                        totalQueued++;
                    }
                }
            } catch (err) {
                console.error(`   ❌ Failed to fetch ${feedSource.name}: ${err.message}`);
            }
        }
    } catch (e) {
        console.error("RSS Error:", e);
    } finally {
        isRSSFetching = false; // Unlock
    }
    console.log(`📡 RSS: Cycle Complete. Queued ${totalQueued} new items.`);
    return totalQueued;
}

// 3. GEMINI PROMPT
async function formatTweetWithGemini(text, tweetUrl, sourceName) {
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
   - Example:  "కృష్ణా జలాలు వైఎస్సార్‌ పుణ్యమే: వైఎస్‌ అవినాష్‌రెడ్డి.
   - Length: Max 8-10 words.
   - Language: Natural spoken Telugu (Vyavaharika Bhasha).

2. SUMMARY (Body):
   - Length: Strictly 60 to 75 words.
   - Format: Single paragraph. NO bullet points.
   - Flow:
     * Sentence 1: Direct lead (What happened?).
     * Sentence 2: Key details (Why/Where/When?), mention if there is any statistical data.
     * Sentence 3: Outcome or what's next (The conclusion) cover important information and if person speakes use indirect speech.
   - Tone: Fast-paced, factual, and easy to read.
   - Vocabulary: Use simple Telugu. You can use English words for technical terms (e.g., CM, Police, Court, Fans) written in Telugu script or kept in English if common.

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
}

// --- API ROUTES ---

// Dashboard Stats API
app.get("/api/dashboard-stats", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const stats = {
      totalPosts: await Post.countDocuments(),
      postsToday: await Post.countDocuments({ publishedAt: { $gte: today } }),
      queueLength: await Queue.countDocuments(),
      categories: await Post.aggregate([
        { $group: { _id: { $arrayElemAt: ["$categories", 0] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      recentPosts: await Post.find().sort({ publishedAt: -1 }).limit(10).select('title sourceName publishedAt categories'),
      queueItems: await Queue.find().sort({ queuedAt: 1 }).limit(20).select('text source queuedAt'),
      rssFeeds: RSS_FEEDS.length,
      twitterHandles: TARGET_HANDLES.length,
      lastUpdated: new Date()
    };
    
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all posts
app.get("/api/posts", async (req, res) => {
  try {
    const { page = 1, limit = 20, category } = req.query;
    const skip = (page - 1) * limit;
    
    const filter = {};
    if (category && category !== 'all') {
      filter.categories = category;
    }
    
    const posts = await Post.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('title summary imageUrl categories publishedAt sourceName');
    
    const total = await Post.countDocuments(filter);
    
    res.json({
      success: true,
      posts,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get queue items
app.get("/api/queue", async (req, res) => {
  try {
    const queueItems = await Queue.find().sort({ queuedAt: 1 });
    res.json({ success: true, queue: queueItems });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear queue
app.post("/api/clear-queue", async (req, res) => {
  try {
    await Queue.deleteMany({});
    res.json({ success: true, message: "Queue cleared" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete from queue
app.delete("/api/queue/:id", async (req, res) => {
  try {
    await Queue.deleteOne({ id: req.params.id });
    res.json({ success: true, message: "Item removed from queue" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single post
app.get("/api/posts/:id", async (req, res) => {
  try {
    const post = await Post.findOne({ postId: req.params.id });
    if (!post) {
      return res.status(404).json({ success: false, error: "Post not found" });
    }
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add text content to queue
app.post("/api/add-text-to-queue", async (req, res) => {
  try {
    const { text, title, source, category } = req.body;
    
    if (!text) {
      return res.status(400).json({ success: false, error: "Text content is required" });
    }
    
    const queueItem = new Queue({
      id: new mongoose.Types.ObjectId().toString(),
      text: title ? `Title: ${title}\nContent: ${text}` : text,
      source: source || "Manual Text",
      user: { name: "Manual", screen_name: "manual_text" },
      postType: "normal_post",
      promptType: "DETAILED",
      queuedAt: new Date()
    });
    
    await queueItem.save();
    
    res.json({ 
      success: true, 
      message: "Text added to queue successfully",
      queueId: queueItem.id 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual RSS add to queue
app.post("/api/add-rss-to-queue", async (req, res) => {
  try {
    const postsToQueue = Array.isArray(req.body) ? req.body : req.body.items;
    if (!Array.isArray(postsToQueue)) return res.status(400).json({ error: "Array required" });

    const newQueueDocs = postsToQueue.map(item => {
      const mediaObj = item.imageUrl ? [{
        type: 'photo',
        media_url_https: item.imageUrl, 
        url: item.imageUrl
      }] : [];

      return {
        id: new mongoose.Types.ObjectId().toString(),
        text: `Title: ${item.title}\nSummary: ${item.summary || ""}`,
        url: item.url,
        imageUrl: item.imageUrl,
        media: mediaObj,
        relatedStories: item.relatedStories,
        extendedEntities: { media: mediaObj }, 
        source: item.source || "Manual",
        promptType: "DETAILED",
        user: { name: "Manual", screen_name: "manual" },
        queuedAt: new Date()
      };
    });

    if (newQueueDocs.length > 0) await Queue.insertMany(newQueueDocs);
    res.json({ success: true, count: newQueueDocs.length });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// Add URL content to queue
app.post("/api/add-content-to-queue", async (req, res) => {
  try {
    const { content, url, title, imageUrl, source } = req.body;
    if (!content && !url) return res.status(400).json({ error: "No content/url" });

    const queueItem = {
      id: new mongoose.Types.ObjectId().toString(),
      text: title ? `Title: ${title}\nContent: ${content || ""}` : content || `Article from ${url}`,
      url: url || "", 
      imageUrl: imageUrl || null,
      media: imageUrl ? [{ type: 'photo', media_url_https: imageUrl, url: imageUrl }] : [],
      extendedEntities: imageUrl ? { media: [{ media_url_https: imageUrl }] } : {},
      source: source || "Manual Paste",
      user: { name: source || "Admin", screen_name: "admin_direct" },
      postType: "normal_post",
      promptType: "DETAILED",
      queuedAt: new Date()
    };

    await Queue.create(queueItem);
    res.json({ success: true, queueId: queueItem.id });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// Trigger RSS fetch
app.get("/api/trigger-rss-fetch", async (req, res) => {
  const count = await fetchAndQueueRSS();
  res.json({ success: true, queued_count: count });
});

// Trigger Twitter fetch
app.get("/api/trigger-auto-fetch", async (req, res) => {
  let total = 0;
  for (const handle of TARGET_HANDLES) {
    total += await fetchAndQueueTweetsForHandle(handle);
  }
  res.json({ success: true, queued_total: total });
});

// Delete post
app.delete("/api/posts/:id", async (req, res) => {
  try {
    await Post.deleteOne({ postId: req.params.id });
    res.json({ success: true, message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dashboard HTML
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telugu News Aggregator Dashboard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        }
        
        :root {
            --primary: #4361ee;
            --primary-dark: #3a56d4;
            --secondary: #7209b7;
            --success: #4cc9f0;
            --warning: #f72585;
            --danger: #ef233c;
            --dark: #2b2d42;
            --light: #f8f9fa;
            --gray: #6c757d;
            --border: #dee2e6;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: var(--dark);
            min-height: 100vh;
            padding: 0;
            font-size: 14px;
        }
        
        .container {
            max-width: 100%;
            margin: 0;
            background: var(--light);
            min-height: 100vh;
        }
        
        /* Header */
        .header {
            background: linear-gradient(90deg, var(--dark), var(--primary-dark));
            color: white;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            position: sticky;
            top: 0;
            z-index: 100;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        }
        
        .logo {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        
        .logo h1 {
            font-size: 1.25rem;
            font-weight: 600;
        }
        
        .logo i {
            font-size: 1.5rem;
            color: var(--success);
        }
        
        .header-stats {
            display: flex;
            gap: 1rem;
            font-size: 0.85rem;
            opacity: 0.9;
        }
        
        .header-stats span {
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }
        
        /* Mobile Menu Toggle */
        .menu-toggle {
            display: none;
            background: none;
            border: none;
            color: white;
            font-size: 1.25rem;
            cursor: pointer;
            padding: 0.5rem;
        }
        
        /* Main Layout */
        .main-content {
            display: grid;
            grid-template-columns: 250px 1fr;
            min-height: calc(100vh - 120px);
        }
        
        /* Sidebar */
        .sidebar {
            background: white;
            padding: 1.5rem 1rem;
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            overflow-y: auto;
        }
        
        .nav-section {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        
        .nav-title {
            font-size: 0.75rem;
            text-transform: uppercase;
            color: var(--gray);
            font-weight: 600;
            letter-spacing: 0.5px;
            margin-bottom: 0.5rem;
        }
        
        .nav-link {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1rem;
            color: var(--dark);
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.2s;
            font-weight: 500;
        }
        
        .nav-link:hover {
            background: rgba(67, 97, 238, 0.1);
            color: var(--primary);
        }
        
        .nav-link.active {
            background: var(--primary);
            color: white;
        }
        
        .nav-link i {
            width: 20px;
            text-align: center;
        }
        
        /* Content Area */
        .content-area {
            padding: 1.5rem;
            overflow-y: auto;
            background: #f8fafc;
        }
        
        .content-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
            gap: 1rem;
        }
        
        .content-header h2 {
            font-size: 1.5rem;
            color: var(--dark);
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        
        .controls {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
        }
        
        .btn {
            padding: 0.625rem 1.25rem;
            border: none;
            border-radius: 8px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.875rem;
            text-decoration: none;
        }
        
        .btn-sm {
            padding: 0.5rem 1rem;
            font-size: 0.8125rem;
        }
        
        .btn-primary {
            background: var(--primary);
            color: white;
        }
        
        .btn-primary:hover {
            background: var(--primary-dark);
            transform: translateY(-1px);
        }
        
        .btn-success {
            background: var(--success);
            color: white;
        }
        
        .btn-warning {
            background: var(--warning);
            color: white;
        }
        
        .btn-danger {
            background: var(--danger);
            color: white;
        }
        
        .btn-light {
            background: white;
            color: var(--dark);
            border: 1px solid var(--border);
        }
        
        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        
        .stat-card {
            background: white;
            padding: 1.25rem;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            border-left: 4px solid var(--primary);
            display: flex;
            align-items: center;
            gap: 1rem;
            transition: transform 0.2s;
        }
        
        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 12px rgba(0,0,0,0.1);
        }
        
        .stat-icon {
            width: 48px;
            height: 48px;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 1.25rem;
        }
        
        .stat-info h3 {
            font-size: 1.75rem;
            color: var(--dark);
            margin-bottom: 0.25rem;
        }
        
        .stat-info p {
            color: var(--gray);
            font-size: 0.875rem;
        }
        
        /* Cards */
        .card {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            margin-bottom: 1.5rem;
        }
        
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.25rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border);
        }
        
        .card-header h3 {
            font-size: 1.125rem;
            color: var(--dark);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        /* Tables and Lists */
        .table-responsive {
            overflow-x: auto;
        }
        
        .table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .table th {
            text-align: left;
            padding: 0.75rem;
            background: #f8f9fa;
            color: var(--gray);
            font-weight: 600;
            font-size: 0.8125rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 2px solid var(--border);
        }
        
        .table td {
            padding: 1rem 0.75rem;
            border-bottom: 1px solid var(--border);
            font-size: 0.875rem;
        }
        
        .table tr:hover {
            background: #f8fafc;
        }
        
        /* Badges */
        .badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .badge-primary { background: #e3f2fd; color: #1976d2; }
        .badge-success { background: #e8f5e9; color: #2e7d32; }
        .badge-warning { background: #fff3e0; color: #f57c00; }
        .badge-danger { background: #ffebee; color: #d32f2f; }
        .badge-info { background: #e0f7fa; color: #0097a7; }
        
        /* Forms */
        .form-group {
            margin-bottom: 1rem;
        }
        
        .form-label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            color: var(--dark);
        }
        
        .form-control {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid var(--border);
            border-radius: 8px;
            font-size: 0.875rem;
            transition: border-color 0.2s;
        }
        
        .form-control:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.1);
        }
        
        textarea.form-control {
            min-height: 120px;
            resize: vertical;
        }
        
        /* Modal */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 1rem;
        }
        
        .modal.active {
            display: flex;
        }
        
        .modal-content {
            background: white;
            border-radius: 12px;
            max-width: 500px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            animation: modalSlide 0.3s ease;
        }
        
        @keyframes modalSlide {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .modal-body {
            padding: 1.5rem;
        }
        
        .modal-footer {
            padding: 1.5rem;
            border-top: 1px solid var(--border);
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
        }
        
        /* Loading */
        .loading {
            text-align: center;
            padding: 2rem;
            color: var(--gray);
        }
        
        .loading i {
            font-size: 2rem;
            margin-bottom: 1rem;
            color: var(--primary);
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        /* Tabs */
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--border);
            margin-bottom: 1.5rem;
        }
        
        .tab {
            padding: 0.75rem 1.5rem;
            background: none;
            border: none;
            color: var(--gray);
            font-weight: 500;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            transition: all 0.2s;
            font-size: 0.875rem;
        }
        
        .tab:hover {
            color: var(--primary);
        }
        
        .tab.active {
            color: var(--primary);
            border-bottom-color: var(--primary);
        }
        
        /* Chart Container */
        .chart-container {
            height: 300px;
            margin-top: 1rem;
        }
        
        /* Queue Items */
        .queue-item {
            padding: 1rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .queue-item:last-child {
            border-bottom: none;
        }
        
        .queue-content {
            flex: 1;
        }
        
        .queue-title {
            font-weight: 500;
            margin-bottom: 0.25rem;
            color: var(--dark);
        }
        
        .queue-meta {
            display: flex;
            gap: 1rem;
            font-size: 0.75rem;
            color: var(--gray);
        }
        
        .queue-actions {
            display: flex;
            gap: 0.5rem;
        }
        
        /* Mobile Responsive */
        @media (max-width: 1024px) {
            .main-content {
                grid-template-columns: 200px 1fr;
            }
        }
        
        @media (max-width: 768px) {
            .menu-toggle {
                display: block;
            }
            
            .main-content {
                grid-template-columns: 1fr;
            }
            
            .sidebar {
                position: fixed;
                top: 0;
                left: -250px;
                width: 250px;
                height: 100vh;
                z-index: 1000;
                transition: left 0.3s ease;
            }
            
            .sidebar.active {
                left: 0;
            }
            
            .header-stats {
                display: none;
            }
            
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .controls {
                width: 100%;
                justify-content: space-between;
            }
            
            .btn {
                flex: 1;
                justify-content: center;
            }
        }
        
        @media (max-width: 480px) {
            .content-area {
                padding: 1rem;
            }
            
            .stat-card {
                flex-direction: column;
                text-align: center;
                padding: 1rem;
            }
            
            .stat-info h3 {
                font-size: 1.5rem;
            }
            
            .queue-item {
                flex-direction: column;
                align-items: flex-start;
                gap: 1rem;
            }
            
            .queue-actions {
                width: 100%;
                justify-content: flex-end;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <header class="header">
            <div class="header-top">
                <div class="logo">
                    <i class="fas fa-newspaper"></i>
                    <h1>Telugu News Aggregator</h1>
                </div>
                <div class="header-stats">
                    <span><i class="fas fa-database"></i> <span id="total-posts">0</span> Posts</span>
                    <span><i class="fas fa-clock"></i> <span id="posts-today">0</span> Today</span>
                    <span><i class="fas fa-list"></i> <span id="queue-length">0</span> in Queue</span>
                </div>
                <button class="menu-toggle" id="menuToggle">
                    <i class="fas fa-bars"></i>
                </button>
            </div>
            
            <div class="controls">
                <button class="btn btn-primary" onclick="triggerRSSFetch()">
                    <i class="fas fa-rss"></i> Fetch RSS
                </button>
                <button class="btn btn-success" onclick="triggerTwitterFetch()">
                    <i class="fab fa-twitter"></i> Fetch Twitter
                </button>
                <button class="btn btn-warning" onclick="showAddTextModal()">
                    <i class="fas fa-plus"></i> Add Text
                </button>
                <button class="btn btn-light" onclick="refreshDashboard()">
                    <i class="fas fa-sync-alt"></i> Refresh
                </button>
            </div>
        </header>
        
        <!-- Main Content -->
        <div class="main-content">
            <!-- Sidebar -->
            <nav class="sidebar" id="sidebar">
                <div class="nav-section">
                    <div class="nav-title">Dashboard</div>
                    <a href="#" class="nav-link active" onclick="showSection('dashboard')">
                        <i class="fas fa-tachometer-alt"></i> Overview
                    </a>
                    <a href="#" class="nav-link" onclick="showSection('posts')">
                        <i class="fas fa-newspaper"></i> All Posts
                    </a>
                    <a href="#" class="nav-link" onclick="showSection('queue')">
                        <i class="fas fa-tasks"></i> Processing Queue
                    </a>
                </div>
                
                <div class="nav-section">
                    <div class="nav-title">Sources</div>
                    <a href="#" class="nav-link" onclick="showSection('rss')">
                        <i class="fas fa-rss"></i> RSS Feeds
                    </a>
                    <a href="#" class="nav-link" onclick="showSection('twitter')">
                        <i class="fab fa-twitter"></i> Twitter Handles
                    </a>
                </div>
                
                <div class="nav-section">
                    <div class="nav-title">Tools</div>
                    <a href="#" class="nav-link" onclick="showAddTextModal()">
                        <i class="fas fa-edit"></i> Add Text Content
                    </a>
                    <a href="#" class="nav-link" onclick="showAddUrlModal()">
                        <i class="fas fa-link"></i> Add URL
                    </a>
                    <a href="#" class="nav-link" onclick="clearQueue()">
                        <i class="fas fa-trash"></i> Clear Queue
                    </a>
                </div>
            </nav>
            
            <!-- Content Area -->
            <main class="content-area">
                <!-- Dashboard Section -->
                <div id="dashboard-section" class="section active">
                    <div class="content-header">
                        <h2><i class="fas fa-tachometer-alt"></i> Dashboard Overview</h2>
                        <div class="controls">
                            <button class="btn btn-sm btn-primary" onclick="refreshDashboard()">
                                <i class="fas fa-sync-alt"></i> Refresh
                            </button>
                        </div>
                    </div>
                    
                    <!-- Stats -->
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-file-alt"></i>
                            </div>
                            <div class="stat-info">
                                <h3 id="total-posts-count">0</h3>
                                <p>Total Posts</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-calendar-day"></i>
                            </div>
                            <div class="stat-info">
                                <h3 id="posts-today-count">0</h3>
                                <p>Posts Today</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-tasks"></i>
                            </div>
                            <div class="stat-info">
                                <h3 id="queue-length-count">0</h3>
                                <p>Queue Items</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-rss"></i>
                            </div>
                            <div class="stat-info">
                                <h3 id="rss-feeds-count">0</h3>
                                <p>RSS Feeds</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Charts -->
                    <div class="card">
                        <div class="card-header">
                            <h3><i class="fas fa-chart-pie"></i> Category Distribution</h3>
                        </div>
                        <div class="chart-container">
                            <canvas id="categoryChart"></canvas>
                        </div>
                    </div>
                    
                    <!-- Recent Posts -->
                    <div class="card">
                        <div class="card-header">
                            <h3><i class="fas fa-history"></i> Recent Posts</h3>
                            <a href="#" class="btn btn-sm btn-light" onclick="showSection('posts')">View All</a>
                        </div>
                        <div id="recent-posts">
                            <div class="loading">
                                <i class="fas fa-spinner fa-spin"></i>
                                <p>Loading recent posts...</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- All Posts Section -->
                <div id="posts-section" class="section" style="display: none;">
                    <div class="content-header">
                        <h2><i class="fas fa-newspaper"></i> All Posts</h2>
                        <div class="controls">
                            <select id="category-filter" class="form-control" style="width: auto;" onchange="loadPosts()">
                                <option value="all">All Categories</option>
                                <option value="Politics">Politics</option>
                                <option value="Sports">Sports</option>
                                <option value="Cinema">Cinema</option>
                                <option value="Technology">Technology</option>
                                <option value="Business">Business</option>
                                <option value="Crime">Crime</option>
                                <option value="General">General</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Title</th>
                                    <th>Category</th>
                                    <th>Source</th>
                                    <th>Published</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="posts-list">
                                <tr>
                                    <td colspan="5" class="loading">
                                        <i class="fas fa-spinner fa-spin"></i> Loading posts...
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    
                    <div id="pagination" style="text-align: center; margin-top: 1rem;"></div>
                </div>
                
                <!-- Queue Section -->
                <div id="queue-section" class="section" style="display: none;">
                    <div class="content-header">
                        <h2><i class="fas fa-tasks"></i> Processing Queue</h2>
                        <div class="controls">
                            <button class="btn btn-sm btn-danger" onclick="clearQueue()">
                                <i class="fas fa-trash"></i> Clear All
                            </button>
                        </div>
                    </div>
                    
                    <div id="queue-items">
                        <div class="loading">
                            <i class="fas fa-spinner fa-spin"></i>
                            <p>Loading queue items...</p>
                        </div>
                    </div>
                </div>
                
                <!-- RSS Feeds Section -->
                <div id="rss-section" class="section" style="display: none;">
                    <div class="content-header">
                        <h2><i class="fas fa-rss"></i> RSS Feeds</h2>
                        <button class="btn btn-primary" onclick="triggerRSSFetch()">
                            <i class="fas fa-sync-alt"></i> Fetch Now
                        </button>
                    </div>
                    
                    <div class="card">
                        <div class="table-responsive">
                            <table class="table">
                                <thead>
                                    <tr>
                                        <th>Source Name</th>
                                        <th>URL</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${RSS_FEEDS.map(feed => `
                                        <tr>
                                            <td>${feed.name}</td>
                                            <td><small>${feed.url}</small></td>
                                            <td><span class="badge badge-success">Active</span></td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                
                <!-- Twitter Handles Section -->
                <div id="twitter-section" class="section" style="display: none;">
                    <div class="content-header">
                        <h2><i class="fab fa-twitter"></i> Twitter Handles</h2>
                        <button class="btn btn-success" onclick="triggerTwitterFetch()">
                            <i class="fas fa-sync-alt"></i> Fetch Now
                        </button>
                    </div>
                    
                    <div class="card">
                        <div class="table-responsive">
                            <table class="table">
                                <thead>
                                    <tr>
                                        <th>Handle</th>
                                        <th>Status</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${TARGET_HANDLES.map(handle => `
                                        <tr>
                                            <td>@${handle}</td>
                                            <td><span class="badge badge-success">Active</span></td>
                                            <td>
                                                <button class="btn btn-sm btn-primary" onclick="fetchSingleHandle('${handle}')">
                                                    <i class="fas fa-sync"></i> Fetch
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </div>
    
    <!-- Add Text Modal -->
    <div class="modal" id="addTextModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3><i class="fas fa-edit"></i> Add Text Content</h3>
                <button class="btn btn-sm btn-light" onclick="hideModal('addTextModal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <form id="addTextForm">
                    <div class="form-group">
                        <label class="form-label">Title (Optional)</label>
                        <input type="text" class="form-control" id="textTitle" placeholder="Enter title">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Content *</label>
                        <textarea class="form-control" id="textContent" placeholder="Paste or type your content here..." required></textarea>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Source (Optional)</label>
                        <input type="text" class="form-control" id="textSource" placeholder="e.g., Manual, Admin, etc.">
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" onclick="hideModal('addTextModal')">Cancel</button>
                <button class="btn btn-primary" onclick="addTextToQueue()">Add to Queue</button>
            </div>
        </div>
    </div>
    
    <!-- Add URL Modal -->
    <div class="modal" id="addUrlModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3><i class="fas fa-link"></i> Add URL</h3>
                <button class="btn btn-sm btn-light" onclick="hideModal('addUrlModal')">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <form id="addUrlForm">
                    <div class="form-group">
                        <label class="form-label">URL *</label>
                        <input type="url" class="form-control" id="urlInput" placeholder="https://example.com/news/article" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Title (Optional)</label>
                        <input type="text" class="form-control" id="urlTitle" placeholder="Enter title">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Content (Optional)</label>
                        <textarea class="form-control" id="urlContent" placeholder="Optional content..."></textarea>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Source (Optional)</label>
                        <input type="text" class="form-control" id="urlSource" placeholder="e.g., Manual, Admin, etc.">
                    </div>
                </form>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" onclick="hideModal('addUrlModal')">Cancel</button>
                <button class="btn btn-primary" onclick="addUrlToQueue()">Add to Queue</button>
            </div>
        </div>
    </div>
    
    <script>
        let categoryChart = null;
        let currentSection = 'dashboard';
        let currentPage = 1;
        
        // Mobile menu toggle
        document.getElementById('menuToggle').addEventListener('click', function() {
            document.getElementById('sidebar').classList.toggle('active');
        });
        
        // Show section
        function showSection(section) {
            // Hide all sections
            document.querySelectorAll('.section').forEach(el => {
                el.style.display = 'none';
            });
            
            // Remove active class from all nav links
            document.querySelectorAll('.nav-link').forEach(el => {
                el.classList.remove('active');
            });
            
            // Show selected section
            document.getElementById(section + '-section').style.display = 'block';
            
            // Add active class to clicked nav link
            event.target.classList.add('active');
            
            // Update current section
            currentSection = section;
            
            // Load section data
            if (section === 'dashboard') {
                refreshDashboard();
            } else if (section === 'posts') {
                loadPosts();
            } else if (section === 'queue') {
                loadQueue();
            }
            
            // Close mobile menu
            document.getElementById('sidebar').classList.remove('active');
        }
        
        // Show modal
        function showModal(modalId) {
            document.getElementById(modalId).classList.add('active');
        }
        
        // Hide modal
        function hideModal(modalId) {
            document.getElementById(modalId).classList.remove('active');
        }
        
        // Show add text modal
        function showAddTextModal() {
            document.getElementById('addTextForm').reset();
            showModal('addTextModal');
        }
        
        // Show add URL modal
        function showAddUrlModal() {
            document.getElementById('addUrlForm').reset();
            showModal('addUrlModal');
        }
        
        // Fetch dashboard stats
        async function fetchDashboardStats() {
            try {
                const response = await fetch('/api/dashboard-stats');
                const data = await response.json();
                
                if (data.success) {
                    updateDashboard(data.stats);
                }
            } catch (error) {
                console.error('Failed to fetch stats:', error);
                showNotification('Error loading dashboard data', 'error');
            }
        }
        
        // Update dashboard
        function updateDashboard(stats) {
            // Update numbers in header
            document.getElementById('total-posts').textContent = stats.totalPosts;
            document.getElementById('posts-today').textContent = stats.postsToday;
            document.getElementById('queue-length').textContent = stats.queueLength;
            
            // Update numbers in dashboard
            document.getElementById('total-posts-count').textContent = stats.totalPosts;
            document.getElementById('posts-today-count').textContent = stats.postsToday;
            document.getElementById('queue-length-count').textContent = stats.queueLength;
            document.getElementById('rss-feeds-count').textContent = stats.rssFeeds;
            
            // Update recent posts
            const recentPostsContainer = document.getElementById('recent-posts');
            if (stats.recentPosts && stats.recentPosts.length > 0) {
                recentPostsContainer.innerHTML = stats.recentPosts.map(post => \`
                    <div class="queue-item">
                        <div class="queue-content">
                            <div class="queue-title">\${post.title.substring(0, 100)}\${post.title.length > 100 ? '...' : ''}</div>
                            <div class="queue-meta">
                                <span><i class="fas fa-source"></i> \${post.sourceName || 'Unknown'}</span>
                                <span><i class="fas fa-clock"></i> \${new Date(post.publishedAt).toLocaleDateString()}</span>
                                <span class="badge badge-primary">\${post.categories && post.categories[0] ? post.categories[0] : 'General'}</span>
                            </div>
                        </div>
                        <div class="queue-actions">
                            <button class="btn btn-sm btn-light" onclick="viewPost('\${post._id}')">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                \`).join('');
            } else {
                recentPostsContainer.innerHTML = '<div class="queue-item">No recent posts</div>';
            }
            
            // Update category chart
            updateCategoryChart(stats.categories);
        }
        
        // Update category chart
        function updateCategoryChart(categories) {
            const ctx = document.getElementById('categoryChart').getContext('2d');
            
            if (categoryChart) {
                categoryChart.destroy();
            }
            
            const labels = categories.map(cat => cat._id || 'General');
            const data = categories.map(cat => cat.count);
            
            // Color palette
            const colors = [
                '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0',
                '#9966FF', '#FF9F40', '#FF6384', '#C9CBCF'
            ];
            
            categoryChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors.slice(0, labels.length),
                        borderWidth: 2,
                        borderColor: '#fff'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                padding: 20,
                                usePointStyle: true
                            }
                        }
                    }
                }
            });
        }
        
        // Load posts
        async function loadPosts(page = 1) {
            currentPage = page;
            const category = document.getElementById('category-filter').value;
            
            try {
                const response = await fetch(\`/api/posts?page=\${page}&limit=20&category=\${category}\`);
                const data = await response.json();
                
                if (data.success) {
                    updatePostsList(data.posts, data.total, data.page, data.totalPages);
                }
            } catch (error) {
                console.error('Failed to load posts:', error);
                showNotification('Error loading posts', 'error');
            }
        }
        
        // Update posts list
        function updatePostsList(posts, total, page, totalPages) {
            const postsList = document.getElementById('posts-list');
            const pagination = document.getElementById('pagination');
            
            if (posts.length === 0) {
                postsList.innerHTML = \`
                    <tr>
                        <td colspan="5" style="text-align: center; padding: 2rem;">
                            <i class="fas fa-newspaper" style="font-size: 2rem; color: #ddd; margin-bottom: 1rem;"></i>
                            <p>No posts found</p>
                        </td>
                    </tr>
                \`;
                pagination.innerHTML = '';
                return;
            }
            
            postsList.innerHTML = posts.map(post => \`
                <tr>
                    <td style="max-width: 300px;">
                        <div style="font-weight: 500; margin-bottom: 0.25rem;">\${post.title.substring(0, 80)}\${post.title.length > 80 ? '...' : ''}</div>
                        <div style="font-size: 0.75rem; color: #666;">\${post.summary ? post.summary.substring(0, 100) + '...' : ''}</div>
                    </td>
                    <td>
                        <span class="badge badge-primary">\${post.categories && post.categories[0] ? post.categories[0] : 'General'}</span>
                    </td>
                    <td>\${post.sourceName || 'Unknown'}</td>
                    <td>\${new Date(post.publishedAt).toLocaleDateString()}</td>
                    <td>
                        <button class="btn btn-sm btn-light" onclick="viewPost('\${post._id}')">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deletePost('\${post._id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            \`).join('');
            
            // Generate pagination
            let paginationHTML = '';
            if (totalPages > 1) {
                paginationHTML = '<div style="display: flex; gap: 0.5rem; justify-content: center;">';
                
                if (page > 1) {
                    paginationHTML += \`<button class="btn btn-sm btn-light" onclick="loadPosts(\${page - 1})"><i class="fas fa-chevron-left"></i></button>\`;
                }
                
                for (let i = 1; i <= totalPages; i++) {
                    if (i === page) {
                        paginationHTML += \`<button class="btn btn-sm btn-primary">\${i}</button>\`;
                    } else if (i >= page - 2 && i <= page + 2) {
                        paginationHTML += \`<button class="btn btn-sm btn-light" onclick="loadPosts(\${i})">\${i}</button>\`;
                    }
                }
                
                if (page < totalPages) {
                    paginationHTML += \`<button class="btn btn-sm btn-light" onclick="loadPosts(\${page + 1})"><i class="fas fa-chevron-right"></i></button>\`;
                }
                
                paginationHTML += '</div>';
            }
            
            pagination.innerHTML = paginationHTML;
        }
        
        // Load queue
        async function loadQueue() {
            try {
                const response = await fetch('/api/queue');
                const data = await response.json();
                
                if (data.success) {
                    updateQueueList(data.queue);
                }
            } catch (error) {
                console.error('Failed to load queue:', error);
                showNotification('Error loading queue', 'error');
            }
        }
        
        // Update queue list
        function updateQueueList(queue) {
            const queueContainer = document.getElementById('queue-items');
            
            if (queue.length === 0) {
                queueContainer.innerHTML = \`
                    <div class="card">
                        <div style="text-align: center; padding: 3rem;">
                            <i class="fas fa-inbox" style="font-size: 3rem; color: #ddd; margin-bottom: 1rem;"></i>
                            <h3 style="color: #666; margin-bottom: 0.5rem;">Queue is Empty</h3>
                            <p style="color: #999;">No items waiting to be processed</p>
                        </div>
                    </div>
                \`;
                return;
            }
            
            queueContainer.innerHTML = queue.map(item => {
                const title = item.text ? (item.text.split('\\n')[0] || item.text).substring(0, 120) : 'No title';
                return \`
                    <div class="card" style="margin-bottom: 1rem;">
                        <div class="queue-item">
                            <div class="queue-content">
                                <div class="queue-title">\${title}\${title.length >= 120 ? '...' : ''}</div>
                                <div class="queue-meta">
                                    <span><i class="fas fa-source"></i> \${item.source || 'Unknown'}</span>
                                    <span><i class="fas fa-clock"></i> \${new Date(item.queuedAt).toLocaleString()}</span>
                                </div>
                            </div>
                            <div class="queue-actions">
                                <button class="btn btn-sm btn-danger" onclick="removeFromQueue('\${item.id}')">
                                    <i class="fas fa-trash"></i> Remove
                                </button>
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');
        }
        
        // Add text to queue
        async function addTextToQueue() {
            const title = document.getElementById('textTitle').value;
            const content = document.getElementById('textContent').value;
            const source = document.getElementById('textSource').value || 'Manual Text';
            
            if (!content.trim()) {
                showNotification('Please enter content', 'warning');
                return;
            }
            
            try {
                const response = await fetch('/api/add-text-to-queue', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        text: content,
                        title: title,
                        source: source
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('Text added to queue successfully!', 'success');
                    hideModal('addTextModal');
                    refreshDashboard();
                    if (currentSection === 'queue') {
                        loadQueue();
                    }
                } else {
                    showNotification(data.error || 'Failed to add text', 'error');
                }
            } catch (error) {
                showNotification('Error adding text: ' + error.message, 'error');
            }
        }
        
        // Add URL to queue
        async function addUrlToQueue() {
            const url = document.getElementById('urlInput').value;
            const title = document.getElementById('urlTitle').value;
            const content = document.getElementById('urlContent').value;
            const source = document.getElementById('urlSource').value || 'Manual URL';
            
            if (!url.trim()) {
                showNotification('Please enter a URL', 'warning');
                return;
            }
            
            try {
                const response = await fetch('/api/add-content-to-queue', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        url: url,
                        title: title,
                        content: content,
                        source: source
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('URL added to queue successfully!', 'success');
                    hideModal('addUrlModal');
                    refreshDashboard();
                    if (currentSection === 'queue') {
                        loadQueue();
                    }
                } else {
                    showNotification(data.error || 'Failed to add URL', 'error');
                }
            } catch (error) {
                showNotification('Error adding URL: ' + error.message, 'error');
            }
        }
        
        // Trigger RSS fetch
        async function triggerRSSFetch() {
            try {
                const response = await fetch('/api/trigger-rss-fetch');
                const data = await response.json();
                
                if (data.success) {
                    showNotification(\`RSS fetch completed! Queued \${data.queued_count} items.\`, 'success');
                    refreshDashboard();
                }
            } catch (error) {
                showNotification('Error triggering RSS fetch', 'error');
            }
        }
        
        // Trigger Twitter fetch
        async function triggerTwitterFetch() {
            try {
                const response = await fetch('/api/trigger-auto-fetch');
                const data = await response.json();
                
                if (data.success) {
                    showNotification(\`Twitter fetch completed! Queued \${data.queued_total} items.\`, 'success');
                    refreshDashboard();
                }
            } catch (error) {
                showNotification('Error triggering Twitter fetch', 'error');
            }
        }
        
        // Fetch single Twitter handle
        async function fetchSingleHandle(handle) {
            try {
                // This would need a separate endpoint, using the general one for now
                showNotification(\`Fetching tweets from @\${handle}...\`, 'info');
                await triggerTwitterFetch();
            } catch (error) {
                showNotification('Error fetching tweets', 'error');
            }
        }
        
        // Clear queue
        async function clearQueue() {
            if (!confirm('Are you sure you want to clear all items from the queue?')) {
                return;
            }
            
            try {
                const response = await fetch('/api/clear-queue', {
                    method: 'POST'
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('Queue cleared successfully!', 'success');
                    refreshDashboard();
                    if (currentSection === 'queue') {
                        loadQueue();
                    }
                } else {
                    showNotification('Failed to clear queue', 'error');
                }
            } catch (error) {
                showNotification('Error clearing queue: ' + error.message, 'error');
            }
        }
        
        // Remove from queue
        async function removeFromQueue(id) {
            if (!confirm('Remove this item from queue?')) {
                return;
            }
            
            try {
                const response = await fetch(\`/api/queue/\${id}\`, {
                    method: 'DELETE'
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('Item removed from queue', 'success');
                    loadQueue();
                    refreshDashboard();
                }
            } catch (error) {
                showNotification('Error removing item', 'error');
            }
        }
        
        // View post
        function viewPost(id) {
            // In a real app, this would open a detailed view
            alert('View post feature would open detailed view for ID: ' + id);
        }
        
        // Delete post
        async function deletePost(id) {
            if (!confirm('Are you sure you want to delete this post?')) {
                return;
            }
            
            try {
                const response = await fetch(\`/api/posts/\${id}\`, {
                    method: 'DELETE'
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification('Post deleted successfully', 'success');
                    loadPosts(currentPage);
                    refreshDashboard();
                }
            } catch (error) {
                showNotification('Error deleting post', 'error');
            }
        }
        
        // Show notification
        function showNotification(message, type = 'info') {
            // Remove existing notifications
            const existing = document.querySelector('.notification');
            if (existing) existing.remove();
            
            // Create notification
            const notification = document.createElement('div');
            notification.className = \`notification \${type}\`;
            notification.innerHTML = \`
                <div style="position: fixed; top: 20px; right: 20px; background: \${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : '#2196F3'}; color: white; padding: 1rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 9999; max-width: 300px;">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <i class="fas fa-\${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
                        <span>\${message}</span>
                    </div>
                </div>
            \`;
            
            document.body.appendChild(notification);
            
            // Auto remove after 3 seconds
            setTimeout(() => {
                notification.remove();
            }, 3000);
        }
        
        // Refresh dashboard
        function refreshDashboard() {
            fetchDashboardStats();
            if (currentSection === 'posts') {
                loadPosts(currentPage);
            } else if (currentSection === 'queue') {
                loadQueue();
            }
        }
        
        // Initial load
        fetchDashboardStats();
        
        // Auto-refresh every 30 seconds
        setInterval(refreshDashboard, 30000);
    </script>
</body>
</html>
  `);
});

// --- WORKER (With Last-Mile Deduplication) ---
cron.schedule("*/1 * * * *", async () => {
    const batch = await Queue.find().sort({ queuedAt: 1 }).limit(3);
    if (batch.length === 0) return;

    console.log(`⚙️ Worker: Processing ${batch.length} items...`);

    for (const item of batch) {
        try {
            console.log(`   Processing: ${item.url || item.id}`);
            
            // 🛑 LAST MILE DEDUPLICATION 🛑
            if (item.url) {
                const cleanUrl = normalizeUrl(item.url);
                const duplicate = await Post.findOne({ 
                    url: { $regex: new RegExp(cleanUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } 
                });
                
                if (duplicate) {
                    console.log(`   ⛔ Duplicate Found in DB (Skipping): ${cleanUrl}`);
                    await Queue.deleteOne({ _id: item._id });
                    continue; 
                }
            }
            
            const geminiData = await formatTweetWithGemini(item.text, item.url);

            if (geminiData) {
                let imageUrl = item.imageUrl;
                if(!imageUrl && item.extendedEntities?.media?.[0]) {
                    imageUrl = item.extendedEntities.media[0].media_url_https;
                }

                let finalPostType = "normal_post";
                let tweetVideo = null;
                const mediaList = item.extendedEntities?.media || item.media || [];
                
                if (mediaList.length > 0 && mediaList[0].type === "video") {
                    const variants = mediaList[0].video_info?.variants || [];
                    const bestVideo = variants.filter((v) => v.content_type === "video/mp4").sort((a, b) => b.bitrate - a.bitrate)[0];
                    if (bestVideo) {
                        tweetVideo = bestVideo.url;
                        finalPostType = "normal_video"; 
                    }
                }

                let finalSearchSlug = geminiData.slug_en;
                if (!finalSearchSlug || finalSearchSlug.length < 3) finalSearchSlug = extractSlugFromUrl(item.url);
                if (!finalSearchSlug) finalSearchSlug = "latest-telugu-news";

                const newPost = new Post({
                    postId: generatePostId(),
                    title: geminiData.title,
                    summary: geminiData.summary,
                    text: geminiData.summary,
                    url: item.url,
                    imageSearchSlug: finalSearchSlug, 
                    source: item.source || "Manual",
                    sourceName: item.user?.name || "Manual",
                    sourceType: item.source === "Manual" ? "manual" : "rss",
                    imageUrl: imageUrl, 
                    videoUrl: tweetVideo,
                    
                    // ✅ FIXED: Map relatedStories from Queue to Post
                    relatedStories: item.relatedStories || [],

                    categories: [geminiData.category || "General"],
                    tags: [], 
                    publishedAt: new Date(),
                    isPublished: true,
                    type: finalPostType,
                    lang: "te"
                });

                await newPost.save();
                console.log(`   ✅ Published: [${geminiData.category}] ${geminiData.title}`);
                await Queue.deleteOne({ _id: item._id });
            } else {
                console.log("   ⚠️ Gemini Failed");
                await Queue.deleteOne({ _id: item._id });
            }
        } catch (e) {
            console.error(`   ❌ Error: ${e.message}`);
        }
        await sleep(5000);
    }
});

// --- SCHEDULERS ---
cron.schedule("*/15 * * * *", async () => { await fetchAndQueueRSS(); });
cron.schedule("*/30 * * * *", async () => {
    for (const handle of TARGET_HANDLES) await fetchAndQueueTweetsForHandle(handle);
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));