import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import cheerio from "cheerio";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

async function checkAndUpsertModel(creator, modelName) {
  const currentDate = new Date();
  const lastUpdated = formatDate(currentDate);

  const { data: existingModels, error: fetchError } = await supabase
    .from("replicateModelsData")
    .select("creator, modelName, id")
    .eq("creator", creator)
    .eq("modelName", modelName);

  if (fetchError) {
    console.error(fetchError);
    return;
  }

  if (existingModels && existingModels.length > 0) {
    console.log(
      `Model ${creator}/${modelName} already exists, skipping insertion.`
    );
    return;
  }

  const modelUrl = `https://replicate.ai/${creator}/${modelName}`;

  const { error: upsertError } = await supabase
    .from("replicateModelsData")
    .upsert([
      {
        creator: creator,
        modelName: modelName,
        tags: "",
        runs: 0,
        lastUpdated: lastUpdated,
        platform: "replicate",
        description: "",
        demoSources: [],
        modelUrl: modelUrl,
        indexedDate: lastUpdated,
      },
    ]);

  if (upsertError) {
    console.error(
      `Failed to upsert model ${creator}/${modelName}:`,
      upsertError
    );
  } else {
    console.log(`Upserted model ${creator}/${modelName}`);
  }
}

async function fetchNewModels() {
  let pageNumber = 1;
  while (true) {
    try {
      const response = await axios.get(
        `https://replicate.ai/explore?latest_models_page=${pageNumber}#latest-models`
      );
      const html = response.data;
      const $ = cheerio.load(html);
      const modelElements = $("h4.mb-1.overflow-hidden.overflow-ellipsis");

      modelElements.each((index, element) => {
        const creator = $(element)
          .find("span.text-shade")
          .first()
          .text()
          .trim();
        const modelName = $(element)
          .find("a.no-default")
          .text()
          .replace(`${creator}/`, "")
          .trim();
        checkAndUpsertModel(creator, modelName);
      });

      const nextPageElement = $('a[rel="next"]');
      if (nextPageElement.length > 0) {
        pageNumber += 1;
      } else {
        break;
      }
    } catch (error) {
      console.error("Failed to fetch new models. Error:", error.message);
      break;
    }
  }
}

fetchNewModels();
