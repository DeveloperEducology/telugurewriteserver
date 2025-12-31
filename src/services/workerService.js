import cron from "node-cron";
import { Queue } from "../models/Queue.js";
import { Post } from "../models/Post.js";
import { formatTweetWithGemini } from "./aiService.js";
import { normalizeUrl, extractSlugFromUrl, generatePostId, sleep } from "../utils/helpers.js";
import { fetchAndQueueRSS } from "./rssService.js";
import { fetchAllTwitterHandles } from "./twitterService.js";
import { loadSources } from "./sourceService.js";

async function processQueueItem() {
  const batch = await Queue.find().sort({ queuedAt: 1 }).limit(3);
  if (batch.length === 0) return;

  console.log(`⚙️ Worker: Processing ${batch.length} items...`);

  for (const item of batch) {
    try {
      console.log(`   Processing: ${item.url || item.id}`);

      // 🛑 DEDUPLICATION
      if (item.url) {
        const cleanUrl = normalizeUrl(item.url);
        const duplicate = await Post.findOne({
          url: { $regex: new RegExp(cleanUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        });

        if (duplicate) {
          console.log(`   ⛔ Duplicate Found (Skipping): ${cleanUrl}`);
          await Queue.deleteOne({ _id: item._id });
          continue;
        }
      }

      // 🤖 AI PROCESSING
      const geminiData = await formatTweetWithGemini(item.text, item.url);

      if (geminiData) {
        // --- FALLBACK LOGIC START ---
        // If Gemini returns empty title, use URL slug or generic text
        let finalTitle = geminiData.title;
        if (!finalTitle || finalTitle.trim() === "") {
             console.warn("   ⚠️ Missing Title from AI. Using Fallback.");
             finalTitle = extractSlugFromUrl(item.url) || "News Update";
        }
        
        // Ensure Summary exists
        const finalSummary = geminiData.summary || finalTitle;
        // --- FALLBACK LOGIC END ---

        let imageUrl = item.imageUrl;
        if (!imageUrl && item.extendedEntities?.media?.[0]) {
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
        if (!finalSearchSlug) finalSearchSlug = "latest-news";

        const newPost = new Post({
          postId: generatePostId(),
          title: finalTitle, // Uses fallback if needed
          summary: finalSummary,
          text: finalSummary,
          url: item.url,
          imageSearchSlug: finalSearchSlug,
          source: item.source || "Manual",
          sourceName: item.user?.name || "Manual",
          sourceType: item.source === "Manual" ? "manual" : "rss",
          imageUrl: imageUrl,
          videoUrl: tweetVideo,
          relatedStories: item.relatedStories || [],
          categories: [geminiData.category || "General"],
          tags: [],
          publishedAt: new Date(),
          isPublished: true,
          type: finalPostType,
          lang: "te",
        });

        await newPost.save();
        console.log(`   ✅ Published: [${geminiData.category}] ${finalTitle.substring(0, 30)}...`);
        await Queue.deleteOne({ _id: item._id });
      } else {
        console.log("   ⚠️ Gemini Failed or No Content");
        // Optional: Keep in queue for retry, or delete? Currently deleting to prevent block.
        await Queue.deleteOne({ _id: item._id });
      }
    } catch (e) {
      console.error(`   ❌ Error: ${e.message}`);
      // If validation failed specifically, delete the poison pill to unblock queue
      if(e.message.includes("validation failed")) {
          await Queue.deleteOne({ _id: item._id });
      }
    }
    await sleep(5000);
  }
}

export const initCronJobs = () => {
  cron.schedule("*/1 * * * *", processQueueItem);
  
  cron.schedule("*/15 * * * *", async () => {
    await loadSources();
    await fetchAndQueueRSS();
  });

  cron.schedule("*/30 * * * *", async () => {
    await loadSources();
    await fetchAllTwitterHandles();
  });
  
  console.log("⏰ Cron Jobs Initialized");
};