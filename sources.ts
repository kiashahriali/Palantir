
import type { NewsSource } from "./types";

export const RSS_SOURCES: NewsSource[] = [
  {
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    category: "world",
    enabled: true
  },
  {
    name: "The Guardian",
    url: "https://www.theguardian.com/world/rss",
    category: "world",
    enabled: true
  },
  {
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    category: "world",
    enabled: true
  },
  {
    name: "DW English",
    url: "https://rss.dw.com/rdf/rss-en-all",
    category: "world",
    enabled: true
  },
  {
    name: "NASA",
    url: "https://www.nasa.gov/news-release/feed/",
    category: "technology",
    enabled: true
  },
  {
    name: "CBS News",
    url: "https://www.cbsnews.com/latest/rss/main",
    category: "world",
    enabled: true
  },
  {
    name: "ABC News",
    url: "https://abcnews.go.com/abcnews/topstories",
    category: "world",
    enabled: true
  },
  {
    name: "Fox News",
    url: "https://moxie.foxnews.com/google-publisher/latest.xml",
    category: "world",
    enabled: true
  }
];
