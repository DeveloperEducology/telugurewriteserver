import Parser from "rss-parser";
import stringSimilarity from "string-similarity";
import mongoose from "mongoose";
import * as cheerio from "cheerio";
import { Post } from "../models/Post.js";
import { Queue } from "../models/Queue.js";
import { RSS_FEEDS } from "./sourceService.js";
import { normalizeUrl } from "../utils/helpers.js";

const rssParser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent"],
      ["media:thumbnail", "mediaThumbnail"],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

function extractRSSImage(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
  if (item.contentEncoded || item.content) {
    const html = item.contentEncoded || item.content;
    const $ = cheerio.load(html);
    const firstImg = $("img").first().attr("src");
    if (firstImg) return firstImg;
  }
  return null;
}

let isRSSFetching = false;

export async function fetchAndQueueRSS() {
  if (isRSSFetching) {
    console.log("⚠️ RSS Fetch running. Skipping.");
    return 0;
  }
  isRSSFetching = true;

  console.log("📡 RSS: Starting Fetch Cycle...");
  let totalQueued = 0;

  try {
    const recentPosts = await Post.find({
      publishedAt: { $gte: new Date(Date.now() - 72 * 60 * 60 * 1000) },
    }).select("title url");
    const recentQueue = await Queue.find().select("text url");

    const existingTitles = [
      ...recentPosts.map((p) => p.title),
      ...recentQueue.map((q) => q.text.split("\n")[0].replace("Title: ", "")),
    ].filter(Boolean);

    const existingUrls = new Set([
      ...recentPosts.map((p) => normalizeUrl(p.url)),
      ...recentQueue.map((q) => normalizeUrl(q.url)),
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
            const mediaObj = extractedImage
              ? [{ type: "photo", media_url_https: extractedImage, url: extractedImage }]
              : [];

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
              queuedAt: new Date(),
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
    isRSSFetching = false;
  }
  console.log(`📡 RSS: Cycle Complete. Queued ${totalQueued} new items.`);
  return totalQueued;
}