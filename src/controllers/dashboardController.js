import { Post } from "../models/Post.js";
import { Queue } from "../models/Queue.js";
import { TwitterSource, RSSSource } from "../models/Source.js";
import { TARGET_HANDLES, RSS_FEEDS } from "../services/sourceService.js";

export const getDashboardStats = async (req, res) => {
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
        { $limit: 10 },
      ]),
      recentPosts: await Post.find().sort({ publishedAt: -1 }).limit(10).select("title sourceName publishedAt categories isPublished postId"),
      queueItems: await Queue.find().sort({ queuedAt: 1 }).limit(20).select("text source queuedAt"),
      twitterHandles: TARGET_HANDLES.length,
      rssFeeds: RSS_FEEDS.length,
      twitterSources: await TwitterSource.find(),
      rssSources: await RSSSource.find(),
      lastUpdated: new Date(),
    };

    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};