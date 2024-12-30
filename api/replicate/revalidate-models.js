import dotenv from "dotenv";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL; // e.g. https://my-domain.com
const secret = process.env.MY_SECRET_TOKEN; // same secret used in /api/revalidate

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Fetch all models updated in the last 24 hours
  const { data, error } = await supabase
    .from("modelsData")
    .select("slug, platform, lastUpdated")
    .gte("lastUpdated", since);

  if (error) {
    console.error("Error fetching recently updated models:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No models updated in the last 24 hours.");
    process.exit(0);
  }

  // 2. Revalidate each updated model
  for (const { slug, platform } of data) {
    const path = `/models/${platform}/${slug}`;
    try {
      const url = `${siteUrl}/api/revalidate?secret=${secret}&path=${encodeURIComponent(
        path
      )}`;
      console.log(`Revalidating ${path}...`);
      const resp = await axios.get(url);
      console.log(`Success revalidating ${path}:`, resp.data);
    } catch (err) {
      console.error(
        `Failed revalidating ${path}:`,
        err.response?.data || err.message
      );
    }
  }
}

main();
