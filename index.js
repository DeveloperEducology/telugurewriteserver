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
  { name: "NTV Telugu", url: "https://ntvtelugu.com/feed" },
  { name: "TV9 Telugu", url: "https://tv9telugu.com/feed" },
  // { name: "V6 Telugu", url: "https://www.v6velugu.com/feed/" },
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



// --- 3. SCHEMAS ---

// Sub-schema for Related Stories (The fix you requested)
const relatedStorySchema = new mongoose.Schema({
    title: { type: String, required: true },
    summary: String,
    imageUrl: String,
    url: String
}, { _id: false }); // _id: false prevents creating a unique ID for each sub-object



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

// Helper: Normalize URL (Removes params like ?utm_source and trailing slashes)
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

const getHandleFromUrl = (url) => {
  if (!url) return null;
  const match = url.match(/(?:twitter\.com|x\.com)\/([^\/]+)/);
  return match ? match[1] : null;
};

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

// --- ROUTES ---

app.get("/", (req, res) => res.send("<h1>✅ Server Running: Dedupe Active</h1>"));

app.get("/api/trigger-rss-fetch", async (req, res) => {
    const count = await fetchAndQueueRSS();
    res.json({ success: true, queued_count: count });
});

app.get("/api/trigger-auto-fetch", async (req, res) => {
  let total = 0;
  for (const handle of TARGET_HANDLES) {
    total += await fetchAndQueueTweetsForHandle(handle);
  }
  res.json({ success: true, queued_total: total });
});

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

        if(newQueueDocs.length > 0) await Queue.insertMany(newQueueDocs);
        res.json({ success: true, count: newQueueDocs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (error) { res.status(500).json({ error: error.message }); }
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