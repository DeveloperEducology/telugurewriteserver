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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
let TARGET_HANDLES = [
    "IndianTechGuide",
    "TeluguScribe",
];

let RSS_FEEDS = [
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

// Create schemas for dynamic sources
const twitterSourceSchema = new mongoose.Schema({
    handle: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    addedAt: { type: Date, default: Date.now }
});

const rssSourceSchema = new mongoose.Schema({
    name: { type: String, required: true },
    url: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    addedAt: { type: Date, default: Date.now }
});

const TwitterSource = mongoose.models.TwitterSource || mongoose.model("TwitterSource", twitterSourceSchema);
const RSSSource = mongoose.models.RSSSource || mongoose.model("RSSSource", rssSourceSchema);

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
    _id: String,
    title: { type: String, required: true },
    summary: String,
    imageUrl: String,
    url: String,
    source: String,
    publishedAt: Date
});

const queueSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    text: String,
    url: String,
    media: Array,
    imageUrl: {
        type: String,
        default: "https://pub-463c5e524a144b19b1f98c36673af4d9.r2.dev/videos/telugu%20shorts.jpg"
    },
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




const ArticleSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: [true, 'Please provide a title.'],
            trim: true,
        },
        slug: {
            type: String,
            required: [true, 'Please provide a slug.'],
            unique: true,
            trim: true,
        },
        summary: {
            type: String,
            required: [true, 'Please provide a summary.'],
        },
        content: {
            type: String,
            required: [false, 'Please provide content.'],
        },
        liveContent: {
            type: String, // For simple "live point" text/HTML
            trim: true,
        },
        isFullArticle: {
            type: Boolean,
            default: false, // Will not show on homepage grid by default
        },
        author: {
            type: String,
            default: 'Admin',
        },
        category: {
            type: String,
            default: 'General',
        },
        featuredImage: {
            type: String,
            default: '',
        },
        // --- ADD THIS FIELD ---
        featuredVideo: {
            type: String,
            default: '',
        },
        // --- END ---
        tags: [{
            type: String,
            trim: true
        }],
        publishedDate: {
            type: Date,
            default: Date.now,
        },
        status: {
            type: String,
            enum: ['draft', 'published'],
            default: 'published',
        },
    },
    {
        timestamps: true,
        collection: 'articles',
    }
);

const Article = mongoose.models.Article ||
    mongoose.model('Article', ArticleSchema);




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

// Function to load sources from database
async function loadSources() {
    try {
        const twitterSources = await TwitterSource.find({ isActive: true });
        const rssSources = await RSSSource.find({ isActive: true });

        TARGET_HANDLES = twitterSources.map(source => source.handle);
        RSS_FEEDS = rssSources.map(source => ({ name: source.name, url: source.url }));

        console.log(`✅ Loaded ${TARGET_HANDLES.length} Twitter handles and ${RSS_FEEDS.length} RSS feeds`);
    } catch (error) {
        console.error("Error loading sources:", error);
    }
}

// Load sources on startup
loadSources();

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
        if (!content) {
            $("p").each((i, el) => { if ($(el).text().length > 30) content += $(el).text().trim() + "\n"; });
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

        const queueDocs = newTweets.map((t) => {
            // Extract Image URL
            let imageUrl = null;
            if (t.extendedEntities && t.extendedEntities.media && t.extendedEntities.media.length > 0) {
                imageUrl = t.extendedEntities.media[0].media_url_https;
            } else if (t.media && t.media.length > 0) {
                imageUrl = t.media[0].media_url_https;
            }

            return {
                id: t.id,
                text: t.text,
                url: t.url,
                imageUrl: imageUrl, // Explicitly set imageUrl
                media: t.media || [],
                extendedEntities: t.extendedEntities || {},
                user: t.user || { screen_name: userName, name: userName },
                postType: "normal_post",
                useAuthorContext: false,
            };
        });

        await Queue.insertMany(queueDocs);
        console.log(`✅ Auto-Fetch: Queued ${newTweets.length} from @${userName}`);
        return newTweets.length;
    } catch (error) {
        console.error(`❌ Auto-Fetch Error:`, error.message);
        return 0;
    }
}

// Fetch single tweet details
async function fetchTweetDetails(tweetId) {
    const API_URL = "https://api.twitterapi.io/twitter/tweets";
    try {
        console.log(`[DEBUG] Fetching Tweet ID: ${tweetId}`);
        const response = await fetch(`${API_URL}?tweet_ids=${tweetId}`, {
            headers: { "X-API-Key": TWITTER_API_IO_KEY },
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[DEBUG] Twitter API Error (${response.status}): ${errText}`);
            return { success: false, error: `API Error ${response.status}: ${errText}` };
        }

        const data = await response.json();

        if (data.tweets && data.tweets.length > 0) {
            return { success: true, data: data.tweets[0] };
        }

        return { success: false, error: "Tweet object not found in API response" };

    } catch (error) {
        console.error("[DEBUG] Network/Code Error:", error);
        return { success: false, error: error.message };
    }
}

// Add single tweet to queue
app.post("/api/add-tweet-to-queue", async (req, res) => {
    try {
        const { tweetId } = req.body;
        if (!tweetId) return res.status(400).json({ error: "Tweet ID required" });

        // Check if already queued or posted
        const existingQ = await Queue.findOne({ id: tweetId });
        if (existingQ) return res.status(400).json({ error: "Tweet already in queue" });

        const existingP = await Post.findOne({ tweetId: tweetId });
        if (existingP) return res.status(400).json({ error: "Tweet already posted" });

        const result = await fetchTweetDetails(tweetId);

        if (!result.success) {
            return res.status(404).json({ error: result.error || "Tweet not found or API error" });
        }

        const tweet = result.data;

        // Extract Image
        let imageUrl = null;
        if (tweet.extendedEntities && tweet.extendedEntities.media && tweet.extendedEntities.media.length > 0) {
            imageUrl = tweet.extendedEntities.media[0].media_url_https;
        } else if (tweet.media && tweet.media.length > 0) {
            imageUrl = tweet.media[0].media_url_https;
        }

        const queueItem = {
            id: tweet.id,
            text: tweet.text,
            url: tweet.url || `https://twitter.com/i/web/status/${tweet.id}`,
            imageUrl: imageUrl,
            media: tweet.media || [],
            extendedEntities: tweet.extendedEntities || {},
            user: tweet.user || { screen_name: "manual_add", name: "Manual Add" },
            postType: "normal_post",
            useAuthorContext: false,
            queuedAt: new Date()
        };

        await Queue.create(queueItem);
        res.json({ success: true, message: "Tweet added to queue" });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
   - **Goal:** Create curiosity and human interest. Focus on the "Wow" factor.
   - **Style:** Natural, conversational Telugu (Vyavaharika Bhasha). Avoid robotic translations.
   - **Structure:** 
     - If a person said it: "[Impactful Quote/Statement]: [Person Name]"
     - If an event: "[Key Outcome/Shocking Detail]... [Context]"
   - **Tone:** Urgent, Emotional, or Intriguing.
   - **Length:** Max 8-10 words.
   - **Examples:**
     - "నా కడుపులో తిప్పినట్లయింది: బ్రయాన్ జాన్సన్" (Natural expression better than "I felt sick")
     - "రూ. 500 కోట్లు ఆవిరి... ఇన్వెస్టర్లకు షాక్!"

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
            recentPosts: await Post.find().sort({ publishedAt: -1 }).limit(10).select('title sourceName publishedAt categories isPublished'),
            queueItems: await Queue.find().sort({ queuedAt: 1 }).limit(20).select('text source queuedAt'),
            twitterHandles: TARGET_HANDLES.length,
            rssFeeds: RSS_FEEDS.length,
            twitterSources: await TwitterSource.find(),
            rssSources: await RSSSource.find(),
            lastUpdated: new Date()
        };

        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all posts with enhanced filtering
app.get("/api/posts", async (req, res) => {
    try {
        const { page = 1, limit = 20, category, search, status } = req.query;
        const skip = (page - 1) * limit;

        const filter = {};
        if (category && category !== 'all') {
            filter.categories = category;
        }

        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { summary: { $regex: search, $options: 'i' } },
                { sourceName: { $regex: search, $options: 'i' } }
            ];
        }

        if (status === 'published') {
            filter.isPublished = true;
        } else if (status === 'unpublished') {
            filter.isPublished = false;
        }

        const posts = await Post.find(filter)
            .sort({ publishedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .select('title summary imageUrl categories publishedAt sourceName isPublished postId');

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

// Update post
app.put("/api/posts/:id", async (req, res) => {
    try {
        const { title, summary, categories, isPublished, imageUrl, sourceName } = req.body;

        const post = await Post.findOne({ postId: req.params.id });
        if (!post) {
            return res.status(404).json({ success: false, error: "Post not found" });
        }

        // Update fields if provided
        if (title !== undefined) post.title = title;
        if (summary !== undefined) post.summary = summary;
        if (categories !== undefined) post.categories = categories;
        if (isPublished !== undefined) post.isPublished = isPublished;
        if (imageUrl !== undefined) post.imageUrl = imageUrl;
        if (sourceName !== undefined) post.sourceName = sourceName;

        await post.save();

        res.json({
            success: true,
            message: "Post updated successfully",
            post: {
                postId: post.postId,
                title: post.title,
                isPublished: post.isPublished
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Toggle post publish status
app.post("/api/posts/:id/toggle-publish", async (req, res) => {
    try {
        const post = await Post.findOne({ postId: req.params.id });
        if (!post) {
            return res.status(404).json({ success: false, error: "Post not found" });
        }

        post.isPublished = !post.isPublished;
        await post.save();

        res.json({
            success: true,
            message: `Post ${post.isPublished ? 'published' : 'unpublished'} successfully`,
            isPublished: post.isPublished
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete post
app.delete("/api/posts/:id", async (req, res) => {
    try {
        const result = await Post.deleteOne({ postId: req.params.id });
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, error: "Post not found" });
        }
        res.json({ success: true, message: "Post deleted successfully" });
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

// Create manual posts directly (bypass queue)
app.post("/api/create-manual-posts", async (req, res) => {
    try {
        const posts = Array.isArray(req.body) ? req.body : [req.body];

        if (!posts || posts.length === 0) {
            return res.status(400).json({ success: false, error: "No posts data provided" });
        }

        const createdPosts = [];

        for (const postData of posts) {
            const { title, summary, imageUrl, source, sourceName, sourceType, categories, relatedStories } = postData;

            if (!title || !summary) {
                console.log("Skipping post: Missing title or summary");
                continue;
            }

            // Check if post already exists
            const existingPost = await Post.findOne({
                title: title,
                summary: { $regex: new RegExp(summary.substring(0, 50), 'i') }
            });

            if (existingPost) {
                console.log(`Skipping duplicate post: ${title}`);
                continue;
            }

            const newPost = new Post({
                postId: generatePostId(),
                title,
                summary,
                text: summary,
                imageUrl: imageUrl || null,
                source: source || "Manual",
                sourceName: sourceName || "Manual Parser",
                sourceType: sourceType || "manual",
                categories: categories || ["General"],
                relatedStories: relatedStories || [],
                isPublished: true,
                type: "normal_post",
                lang: "te",
                publishedAt: new Date()
            });

            await newPost.save();
            createdPosts.push({
                postId: newPost.postId,
                title: newPost.title
            });

            console.log(`✅ Created manual post: ${title}`);
        }

        res.json({
            success: true,
            message: `Created ${createdPosts.length} posts successfully`,
            count: createdPosts.length,
            posts: createdPosts
        });

    } catch (error) {
        console.error("Error creating manual posts:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk update posts (publish/unpublish)
app.post("/api/posts/bulk-update", async (req, res) => {
    try {
        const { postIds, action } = req.body;

        if (!Array.isArray(postIds) || postIds.length === 0) {
            return res.status(400).json({ success: false, error: "No post IDs provided" });
        }

        let update = {};
        let message = "";

        if (action === 'publish') {
            update = { isPublished: true };
            message = "published";
        } else if (action === 'unpublish') {
            update = { isPublished: false };
            message = "unpublished";
        } else if (action === 'delete') {
            await Post.deleteMany({ postId: { $in: postIds } });
            message = "deleted";
        } else {
            return res.status(400).json({ success: false, error: "Invalid action" });
        }

        if (action !== 'delete') {
            await Post.updateMany(
                { postId: { $in: postIds } },
                { $set: update }
            );
        }

        res.json({
            success: true,
            message: `${postIds.length} posts ${message} successfully`
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Twitter Sources Management
app.get("/api/twitter-sources", async (req, res) => {
    try {
        const sources = await TwitterSource.find().sort({ addedAt: -1 });
        res.json({ success: true, sources });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/twitter-sources", async (req, res) => {
    try {
        const { handle } = req.body;

        if (!handle) {
            return res.status(400).json({ success: false, error: "Twitter handle is required" });
        }

        // Remove @ if present
        const cleanHandle = handle.replace('@', '');

        // Check if already exists
        const existing = await TwitterSource.findOne({ handle: cleanHandle });
        if (existing) {
            return res.status(400).json({ success: false, error: "Twitter handle already exists" });
        }

        const source = new TwitterSource({
            handle: cleanHandle,
            isActive: true
        });

        await source.save();

        // Reload sources
        await loadSources();

        res.json({
            success: true,
            message: "Twitter source added successfully",
            source
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put("/api/twitter-sources/:id", async (req, res) => {
    try {
        const { isActive } = req.body;

        const source = await TwitterSource.findById(req.params.id);
        if (!source) {
            return res.status(404).json({ success: false, error: "Source not found" });
        }

        if (isActive !== undefined) {
            source.isActive = isActive;
            await source.save();

            // Reload sources
            await loadSources();
        }

        res.json({
            success: true,
            message: "Twitter source updated successfully",
            source
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete("/api/twitter-sources/:id", async (req, res) => {
    try {
        const source = await TwitterSource.findById(req.params.id);
        if (!source) {
            return res.status(404).json({ success: false, error: "Source not found" });
        }

        await TwitterSource.deleteOne({ _id: req.params.id });

        // Reload sources
        await loadSources();

        res.json({
            success: true,
            message: "Twitter source deleted successfully"
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// RSS Sources Management
app.get("/api/rss-sources", async (req, res) => {
    try {
        const sources = await RSSSource.find().sort({ addedAt: -1 });
        res.json({ success: true, sources });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/rss-sources", async (req, res) => {
    try {
        const { name, url } = req.body;

        if (!name || !url) {
            return res.status(400).json({ success: false, error: "Name and URL are required" });
        }

        // Check if already exists
        const existing = await RSSSource.findOne({ url });
        if (existing) {
            return res.status(400).json({ success: false, error: "RSS source already exists" });
        }

        // Test the RSS feed
        try {
            await rssParser.parseURL(url);
        } catch (error) {
            return res.status(400).json({ success: false, error: "Invalid RSS feed URL" });
        }

        const source = new RSSSource({
            name,
            url,
            isActive: true
        });

        await source.save();

        // Reload sources
        await loadSources();

        res.json({
            success: true,
            message: "RSS source added successfully",
            source
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put("/api/rss-sources/:id", async (req, res) => {
    try {
        const { name, url, isActive } = req.body;

        const source = await RSSSource.findById(req.params.id);
        if (!source) {
            return res.status(404).json({ success: false, error: "Source not found" });
        }

        if (name !== undefined) source.name = name;
        if (url !== undefined) source.url = url;
        if (isActive !== undefined) source.isActive = isActive;

        await source.save();

        // Reload sources
        await loadSources();

        res.json({
            success: true,
            message: "RSS source updated successfully",
            source
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete("/api/rss-sources/:id", async (req, res) => {
    try {
        const source = await RSSSource.findById(req.params.id);
        if (!source) {
            return res.status(404).json({ success: false, error: "Source not found" });
        }

        await RSSSource.deleteOne({ _id: req.params.id });

        // Reload sources
        await loadSources();

        res.json({
            success: true,
            message: "RSS source deleted successfully"
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
        const { content, url, title, imageUrl, source, relatedStories } = req.body;
        if (!content && !url) return res.status(400).json({ error: "No content/url" });

        const queueItem = {
            id: new mongoose.Types.ObjectId().toString(),
            text: title ? `Title: ${title}\nContent: ${content || ""}` : content || `Article from ${url}`,
            url: url || "",
            imageUrl: imageUrl || null,
            relatedStories: relatedStories || [],
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

// Dashboard HTML
app.get("/", (req, res) => {
    res.redirect("/dashboard");
});


// Replace the dashboard route with this corrected version:
app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, 'src/views/dashboard.html'));
});


// --- WORKER (With Last-Mile Deduplication) ---
cron.schedule("*/10 * * * *", async () => {
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
cron.schedule("*/15 * * * *", async () => { 
    // await loadSources(); // Reload sources before fetching
    // await fetchAndQueueRSS(); 
});

cron.schedule("*/30 * * * *", async () => {
    await loadSources(); // Reload sources before fetching
    for (const handle of TARGET_HANDLES) {
        await fetchAndQueueTweetsForHandle(handle);
    }
});



// --- DUPLICATE FINDER (DB SCAN) ---
app.get("/api/find-duplicates", async (req, res) => {
    try {
        console.log("🔍 Starting DB Duplicate Scan...");

        // 1. Find Duplicates by URL (Exact Match)
        const urlDuplicates = await Post.aggregate([
            {
                $match: {
                    url: { $ne: null, $exists: true } // Ignore posts without URLs
                }
            },
            {
                $group: {
                    _id: "$url", // Group by URL
                    count: { $sum: 1 },
                    posts: { $push: { postId: "$postId", title: "$title", publishedAt: "$publishedAt" } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 } // Only keep groups with more than 1 post
                }
            },
            { $sort: { count: -1 } }
        ]);

        // 2. Find Duplicates by Title (Exact Match)
        const titleDuplicates = await Post.aggregate([
            {
                $group: {
                    _id: "$title", // Group by Title
                    count: { $sum: 1 },
                    posts: { $push: { postId: "$postId", url: "$url", publishedAt: "$publishedAt" } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            { $sort: { count: -1 } }
        ]);

        // 3. Find Duplicates by Fuzzy Similarity (Last 100 posts only to prevent timeout)
        // This runs in Javascript, not Mongo, so we limit the dataset.
        const recentPosts = await Post.find().sort({ publishedAt: -1 }).limit(100).select('title postId publishedAt');
        let fuzzyDuplicates = [];
        let checkedIds = new Set();

        for (let i = 0; i < recentPosts.length; i++) {
            const postA = recentPosts[i];
            if (checkedIds.has(postA.postId)) continue;

            for (let j = i + 1; j < recentPosts.length; j++) {
                const postB = recentPosts[j];
                if (checkedIds.has(postB.postId)) continue;

                // Check similarity
                const similarity = stringSimilarity.compareTwoStrings(postA.title, postB.title);

                if (similarity > 0.85) { // 85% threshold
                    fuzzyDuplicates.push({
                        similarity: `${(similarity * 100).toFixed(1)}%`,
                        original: { title: postA.title, id: postA.postId },
                        duplicate: { title: postB.title, id: postB.postId }
                    });
                    checkedIds.add(postB.postId); // Mark as found
                }
            }
        }

        res.json({
            success: true,
            summary: {
                totalUrlDuplicates: urlDuplicates.length,
                totalTitleDuplicates: titleDuplicates.length,
                totalFuzzyDuplicates: fuzzyDuplicates.length
            },
            data: {
                byUrl: urlDuplicates,
                byTitle: titleDuplicates,
                bySimilarity: fuzzyDuplicates
            }
        });

    } catch (error) {
        console.error("❌ Duplicate Scan Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));