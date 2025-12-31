import { Post } from "../models/Post.js";
import { Queue } from "../models/Queue.js";
import { TARGET_HANDLES } from "./sourceService.js";

export async function fetchAndQueueTweetsForHandle(userName) {
  const API_URL = "https://api.twitterapi.io/twitter/user/last_tweets";
  try {
    const response = await fetch(`${API_URL}?userName=${userName}`, {
      headers: { "X-API-Key": process.env.TWITTER_API_KEY },
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
    console.error(`❌ Auto-Fetch Error for ${userName}:`, error.message);
    return 0;
  }
}

export async function fetchAllTwitterHandles() {
  let total = 0;
  for (const handle of TARGET_HANDLES) {
    total += await fetchAndQueueTweetsForHandle(handle);
  }
  return total;
}