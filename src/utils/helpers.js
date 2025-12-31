export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const generatePostId = () => Math.floor(100000000 + Math.random() * 900000000);

export function normalizeUrl(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url);
    urlObj.search = "";
    let cleanUrl = urlObj.toString();
    if (cleanUrl.endsWith("/")) cleanUrl = cleanUrl.slice(0, -1);
    return cleanUrl;
  } catch (e) {
    return url;
  }
}

export function extractSlugFromUrl(url) {
  if (!url) return "";
  try {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    let slug = pathSegments[pathSegments.length - 1];
    if (slug && /^\d+$/.test(slug) && pathSegments.length > 1) {
      slug = pathSegments[pathSegments.length - 2];
    }
    if (!slug) return "";
    return slug.replace(/\.html?$/i, "").replace(/_/g, "-").toLowerCase();
  } catch (e) {
    return "";
  }
}