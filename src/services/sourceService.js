import { TwitterSource, RSSSource } from "../models/Source.js";

// In-memory storage for rapid access
export let TARGET_HANDLES = [];
export let RSS_FEEDS = [];

export async function loadSources() {
  try {
    const twitterSources = await TwitterSource.find({ isActive: true });
    const rssSources = await RSSSource.find({ isActive: true });

    TARGET_HANDLES = twitterSources.map((source) => source.handle);
    RSS_FEEDS = rssSources.map((source) => ({ name: source.name, url: source.url }));

    console.log(`✅ Loaded ${TARGET_HANDLES.length} Twitter handles and ${RSS_FEEDS.length} RSS feeds`);
  } catch (error) {
    console.error("Error loading sources:", error);
  }
}