#!/usr/bin/env node
import dotenv from "dotenv";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const secret = process.env.MY_SECRET_TOKEN;

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("arxivPapersData")
    .select("slug, platform")
    .gte("lastUpdated", since);
  if (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("No updated papers in last 24h.");
    process.exit(0);
  }
  for (const { slug, platform } of data) {
    const path = `/papers/${platform}/${slug}`;
    try {
      const url = `${siteUrl}/api/revalidate?secret=${secret}&path=${encodeURIComponent(
        path
      )}`;
      const resp = await axios.get(url);
      console.log(`Revalidated ${path}:`, resp.data);
    } catch (err) {
      console.error(
        `Failed revalidating ${path}:`,
        err.response?.data || err.message
      );
    }
  }
}

main();
