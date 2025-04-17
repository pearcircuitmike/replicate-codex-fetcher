// fetch-new-papers.js
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import axios from "axios";
import Parser from "rss-parser";
import slugify from "slugify";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Set up explicit execution logging
console.log("Script starting...");

// Setup proper paths for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();
console.log("Environment loaded");
console.log(`NODE_ENV set to: ${process.env.NODE_ENV}`); // Log current environment

// Check for required environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error(
    "ERROR: Missing required environment variables SUPABASE_URL or SUPABASE_SERVICE_KEY"
  );
  process.exit(1);
}
if (!process.env.ORCID_CLIENT_ID || !process.env.ORCID_CLIENT_SECRET) {
  console.warn(
    "WARN: ORCID_CLIENT_ID or ORCID_CLIENT_SECRET not set. ORCID search/enrichment will be skipped."
  );
}

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized");

// ORCID API configuration
const ORCID_API_URL = "https://pub.orcid.org/v3.0";
const ORCID_TOKEN_URL = "https://orcid.org/oauth/token";
const ORCID_WORKS_PAGE_SIZE = 100; // Max items per page for works endpoint (adjust if needed)
const MAX_WORKS_PAGES_TO_CHECK = 10; // Safety limit for pagination

// Configure RSS parser with custom fields
const rssParser = new Parser({
  customFields: {
    item: [
      ["arxiv:announce_type", "announceType"],
      ["arxiv:doi", "doi"], // Extract DOI from RSS feed - Make sure the key matches parser output
    ],
  },
  // Ensure we get categories correctly
  headers: { Accept: "application/rss+xml" },
});

const categories = ["cs", "eess"]; // Add other relevant parent categories if needed

const allowedCategories = [
  "cs.AI",
  "cs.CL",
  "cs.CV",
  "cs.CY",
  "cs.DC",
  "cs.ET",
  "cs.HC",
  "cs.IR",
  "cs.LG",
  "cs.MA",
  "cs.MM",
  "cs.NE",
  "cs.RO",
  "cs.SD",
  "cs.NI",
  "eess.AS",
  "eess.IV",
  "stat.ML",
];

// --- Helper Functions ---

function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function sanitizeValue(value) {
  return typeof value === "string" ? value.replace(/\\|\"/g, "").trim() : "";
}

function extractArxivId(url) {
  const match = url ? url.match(/\/abs\/(.+)/) : null;
  return match ? match[1].replace(/v\d+$/, "") : null;
}

function normalizeArxivId(id) {
  if (!id) return null;
  return id
    .toLowerCase()
    .replace(/^arxiv:/, "")
    .replace(/v\d+$/, "")
    .trim();
}

function generatePdfUrl(arxivId) {
  return arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null;
}

function generateSlug(title) {
  if (!title) return `paper-${Date.now()}`;
  const articleRegex = /\b(a|an|the|of|for|in|on|at|and|with|to|from)\b/gi;
  const slug = slugify(title, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@?#$%^&={}|[\]]/g,
  })
    .replace(articleRegex, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = slug.split("-");
  let shortSlug = "";
  let wordCount = 0;
  const maxWords = 7;
  for (const word of words) {
    if (word && wordCount < maxWords) {
      shortSlug += (shortSlug ? "-" : "") + word;
      wordCount++;
    } else if (wordCount >= maxWords) break;
  }
  const fallbackArxivId = title?.match(/\d{4}\.\d{4,5}/)?.[0];
  return shortSlug.length > 3
    ? shortSlug
    : `paper-${fallbackArxivId || Date.now()}`;
}

function isAnnounceTypeNew(item) {
  const announceTypeRaw = item.announceType || item["arxiv:announce_type"];
  if (!announceTypeRaw) return false;
  const announceType = announceTypeRaw.trim().toLowerCase();
  return (
    announceType === "new" ||
    announceType === "replace" ||
    announceType === "replace-cross"
  );
}

// --- ORCID API Interaction ---

let orcidTokenCache = { token: null, expiry: null };

async function getOrcidApiToken() {
  const now = Date.now();
  if (
    orcidTokenCache.token &&
    orcidTokenCache.expiry &&
    orcidTokenCache.expiry > now
  )
    return orcidTokenCache.token;
  const clientId = process.env.ORCID_CLIENT_ID;
  const clientSecret = process.env.ORCID_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  console.log("Fetching new ORCID token...");
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "/read-public",
    });
    const response = await axios.post(ORCID_TOKEN_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
    });
    const { access_token: token, expires_in: expiresIn } = response.data;
    if (!token || !expiresIn)
      throw new Error("Invalid token response from ORCID");
    orcidTokenCache.token = token;
    orcidTokenCache.expiry = now + (expiresIn - 300) * 1000;
    console.log("New ORCID token obtained and cached");
    return token;
  } catch (error) {
    console.error(
      `Failed to get ORCID API token: ${error.message}`,
      error.response?.data ? JSON.stringify(error.response.data) : ""
    );
    orcidTokenCache.token = null;
    orcidTokenCache.expiry = null;
    return null;
  }
}

async function searchOrcidByName(searchTerm, token) {
  if (!searchTerm || !token) return null;
  const nameParts = searchTerm.split(" ");
  const familyName = nameParts.pop() || "";
  const givenNames = nameParts.join(" ");
  let query = `family-name:${familyName}`;
  if (givenNames)
    query += ` AND (given-names:"${givenNames}" OR given-names:${givenNames.charAt(
      0
    )}*)`;
  try {
    const response = await axios.get(`${ORCID_API_URL}/search`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      params: { q: query },
      timeout: 15000,
    });
    const results = response.data?.result || [];
    const numFound = response.data?.["num-found"] || 0;
    if (numFound === 0 || !results[0]) return null;
    const topResult = results[0];
    const orcidId = topResult["orcid-identifier"]?.path;
    if (!orcidId) {
      console.warn(
        "ORCID search result missing orcid-identifier path:",
        topResult
      );
      return null;
    }
    const isHighConfidence = numFound === 1; // Simple confidence based on uniqueness
    return { orcid: orcidId, name: null, isHighConfidence: isHighConfidence };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`ORCID search returned 404 for query: ${query}`);
      return null;
    }
    console.error(
      `Failed to search ORCID by name (${searchTerm}): ${error.message}`,
      error.response?.status ? `Status: ${error.response.status}` : ""
    );
    return null;
  }
}

/**
 * Checks if a specific paper (by arXiv ID or DOI) exists in an ORCID profile's works.
 * Handles pagination up to a limit.
 */
async function checkOrcidWorksForPaper(orcidId, arxivId, doi, token) {
  if (!orcidId || !token || (!arxivId && !doi)) return false;
  console.log(
    `   Checking ALL ORCID works for ${orcidId} for paper arXiv:${arxivId} / DOI:${doi}`
  );

  const normalizedTargetArxivId = normalizeArxivId(arxivId);
  let offset = 0;
  let totalWorks = 0;
  let pagesChecked = 0;
  let groupsOnPage = 0;

  do {
    const worksUrl = `${ORCID_API_URL}/${orcidId}/works?offset=${offset}&rows=${ORCID_WORKS_PAGE_SIZE}`;
    console.log(`      Checking works page: ${worksUrl}`);
    try {
      const response = await axios.get(worksUrl, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: 20000,
      });

      if (offset === 0) {
        totalWorks = response.data?.["total-size"] || 0;
        console.log(`      Total works reported for ${orcidId}: ${totalWorks}`);
        if (totalWorks === 0) return false;
      }

      const groups = response.data?.group || [];
      groupsOnPage = groups.length;

      if (groupsOnPage === 0) break;

      for (const group of groups) {
        const workSummaries = group["work-summary"] || [];
        for (const work of workSummaries) {
          const externalIds = work["external-ids"]?.["external-id"] || [];
          for (const extId of externalIds) {
            const idType = extId["external-id-type"]?.toLowerCase();
            const idValue = extId["external-id-value"];
            if (!idValue) continue;

            if (
              doi &&
              idType === "doi" &&
              idValue.toLowerCase() === doi.toLowerCase()
            ) {
              console.log(
                `   [+] Paper found on ORCID profile ${orcidId} via DOI match (Page ${
                  pagesChecked + 1
                }).`
              );
              return true;
            }
            if (normalizedTargetArxivId && idType === "arxiv") {
              const normalizedWorkArxivId = normalizeArxivId(idValue);
              if (normalizedWorkArxivId === normalizedTargetArxivId) {
                console.log(
                  `   [+] Paper found on ORCID profile ${orcidId} via arXiv ID match (Page ${
                    pagesChecked + 1
                  }).`
                );
                return true;
              }
            }
          }
        }
      }

      offset += groupsOnPage;
      pagesChecked++;

      if (
        pagesChecked >= MAX_WORKS_PAGES_TO_CHECK ||
        offset >= totalWorks ||
        groupsOnPage < ORCID_WORKS_PAGE_SIZE
      ) {
        console.log(
          `      Stopping works check: Pages checked=${pagesChecked}, Processed approx=${offset}/${totalWorks}, Last page size=${groupsOnPage}`
        );
        break;
      }
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`   ORCID works endpoint returned 404 for ${orcidId}.`);
        return false;
      } else {
        console.error(
          `   Error fetching/checking ORCID works page (offset ${offset}) for ${orcidId}: ${error.message}`,
          error.response?.status ? `Status: ${error.response.status}` : ""
        );
      }
      return false;
    }
  } while (groupsOnPage === ORCID_WORKS_PAGE_SIZE);

  console.log(
    `   Paper (arXiv:${arxivId} / DOI:${doi}) not found after checking ${pagesChecked} page(s) of works for ORCID ${orcidId}.`
  );
  return false;
}

/**
 * Enrich author profile with data from ORCID API (inline for now)
 * Conditionally stores emails based on NODE_ENV.
 */
async function triggerOrcidEnrichment(authorId, orcidId) {
  console.log(
    `Attempting enrichment for author ${authorId} with ORCID ${orcidId}`
  );
  try {
    const token = await getOrcidApiToken();
    if (!token) {
      console.warn(`Skipping enrichment for ${authorId}: No ORCID token.`);
      return;
    }
    const response = await axios.get(`${ORCID_API_URL}/${orcidId}/person`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const personData = response.data;
    let updateData = { last_orcid_sync: new Date().toISOString() };

    // Canonical Name
    if (personData.name?.["family-name"]?.value)
      updateData.canonical_name = `${
        personData.name["given-names"]?.value || ""
      } ${personData.name["family-name"].value}`.trim();
    else if (personData.name?.["credit-name"]?.value)
      updateData.canonical_name = personData.name["credit-name"].value;

    // Biography, Keywords, Country, Aliases
    if (personData.biography?.content)
      updateData.biography = personData.biography.content;
    if (personData.keywords?.keyword?.length > 0)
      updateData.keywords = personData.keywords.keyword
        .map((k) => k.content)
        .filter(Boolean);
    if (personData.addresses?.address?.[0]?.country?.value)
      updateData.country = personData.addresses.address[0].country.value;
    if (personData["other-names"]?.["other-name"]?.length > 0)
      updateData.aliases = personData["other-names"]["other-name"]
        .map((name) => name.content)
        .filter(Boolean);

    // Researcher URLs (Corrected Parsing)
    let parsedUrls = [];
    if (personData["researcher-urls"]?.["researcher-url"]?.length > 0) {
      console.log(
        `   Parsing URLs from 'researcher-urls' structure for ${orcidId}`
      );
      parsedUrls = personData["researcher-urls"]["researcher-url"]
        .map((item) => ({ name: item["url-name"], url: item.url?.value })) // Correct keys
        .filter((u) => u.url && u.name);
    }
    if (parsedUrls.length > 0) {
      updateData.researcher_urls = parsedUrls;
      console.log(
        `   Found and parsed ${parsedUrls.length} researcher URLs for ${orcidId}`
      );
    } else {
      console.log(`   No researcher URLs found or parsed for ${orcidId}`);
    }

    // *** CORRECTED CONDITIONAL EMAIL STORAGE ***
    const hasRealEmails = personData.emails?.email?.length > 0; // Check if real emails exist

    if (process.env.NODE_ENV === "production") {
      // Production: Store real emails only if they exist
      if (hasRealEmails) {
        console.log(
          `   Storing ${personData.emails.email.length} real emails for author ${authorId} in production.`
        );
        updateData.emails = personData.emails.email
          .map((email) => ({
            email: email.email,
            primary: email.primary,
            verified: email.verified,
            visibility: email.visibility,
          }))
          .filter((e) => e.email);
      } else {
        console.log(
          `   No real emails found for author ${authorId} in production. 'emails' field not updated.`
        );
      }
    } else {
      // Development/Other: Store hardcoded email ONLY IF real emails were found in ORCID data
      if (hasRealEmails) {
        const devEmail = "msyoung2012@gmail.com";
        console.log(
          `   Real emails found for author ${authorId}, storing hardcoded dev email (${devEmail}) instead (NODE_ENV: ${process.env.NODE_ENV})`
        );
        updateData.emails = [
          {
            email: devEmail,
            primary: true,
            verified: false, // Assume not verified for dev
            visibility: "PUBLIC", // Default visibility
          },
        ];
      } else {
        // No real emails found, so don't store the dev email either
        console.log(
          `   No real emails found for author ${authorId}, skipping dev email storage (NODE_ENV: ${process.env.NODE_ENV}). 'emails' field not updated.`
        );
      }
    }
    // *** END CORRECTED CONDITIONAL EMAIL STORAGE ***

    // Update the author record
    const { error } = await supabase
      .from("authors")
      .update(updateData)
      .eq("id", authorId);
    if (error)
      console.error(
        `Failed to update author ${authorId} (ORCID ${orcidId}) with enrichment data:`,
        error
      );
    else
      console.log(
        `Successfully enriched author ${authorId} (ORCID ${orcidId})`
      );
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn(
        `ORCID ID ${orcidId} (for author ${authorId}) returned 404 during enrichment. Cannot enrich.`
      );
      return;
    }
    console.error(
      `Error during ORCID enrichment for author ${authorId} (ORCID ${orcidId}): ${error.message}`,
      error.response?.status ? `Status: ${error.response.status}` : ""
    );
  }
}

/**
 * Resolve author: Find existing or create new author record based on available info.
 * Uses works check to set confidence, but links ORCID if found via search.
 */
async function resolveAuthor(
  original_name_string,
  orcid_from_source,
  source_type,
  arxivId = null,
  doi = null
) {
  let authorRecord = null;
  let verification_status = "UNVERIFIED";

  if (!original_name_string) {
    console.error("Attempted to resolve author with empty name string.");
    return null;
  }

  try {
    // --- Stage 1: Check provided ORCID (from Crossref) ---
    if (orcid_from_source && source_type === "FROM_CROSSREF") {
      const { data, error } = await supabase
        .from("authors")
        .select("id")
        .eq("orcid_id", orcid_from_source)
        .maybeSingle();
      if (error)
        throw new Error(
          `DB error finding author by ORCID ${orcid_from_source}: ${error.message}`
        );
      if (data) {
        authorRecord = { id: data.id };
        verification_status = "FROM_CROSSREF";
        console.log(
          `   Resolved author "${original_name_string}" to existing ORCID ${orcid_from_source} (Author ID: ${data.id}, Status: FROM_CROSSREF)`
        );
        triggerOrcidEnrichment(data.id, orcid_from_source);
      } else {
        const { data: insertedAuthor, error: insertError } = await supabase
          .from("authors")
          .insert({
            orcid_id: orcid_from_source,
            canonical_name: original_name_string,
          })
          .select("id")
          .single();
        if (insertError)
          throw new Error(
            `DB error inserting new author for ORCID ${orcid_from_source}: ${insertError.message}`
          );
        authorRecord = { id: insertedAuthor.id };
        verification_status = "FROM_CROSSREF";
        console.log(
          `   Inserted new author for "${original_name_string}" with ORCID ${orcid_from_source} (Author ID: ${insertedAuthor.id}, Status: FROM_CROSSREF)`
        );
        triggerOrcidEnrichment(insertedAuthor.id, orcid_from_source);
      }
    }
    // --- Stage 2: Fallback to ORCID Search (if no Crossref ORCID) ---
    else if (source_type === "SEARCH_ORCID") {
      const orcidToken = await getOrcidApiToken();
      let orcidSearchResult = null;
      if (orcidToken)
        orcidSearchResult = await searchOrcidByName(
          original_name_string,
          orcidToken
        );

      if (orcidSearchResult?.orcid) {
        // Found potential ORCID via search
        console.log(
          `   ORCID Search found potential match: ${orcidSearchResult.orcid} for "${original_name_string}" (HighConf: ${orcidSearchResult.isHighConfidence})`
        );
        let paperFoundOnProfile = false;
        if (orcidToken)
          paperFoundOnProfile = await checkOrcidWorksForPaper(
            orcidSearchResult.orcid,
            arxivId,
            doi,
            orcidToken
          );

        // Set status based on works check
        if (paperFoundOnProfile) {
          verification_status = "ORCID_MATCH_CONFIRMED";
          console.log(
            `   [✓] Paper FOUND on ORCID profile ${orcidSearchResult.orcid}. Status set to: ${verification_status}`
          );
        } else {
          verification_status = "ORCID_MATCH_POTENTIAL"; // Still link, but mark as potential
          console.log(
            `   [?] Paper NOT found on ORCID profile ${orcidSearchResult.orcid}. Status set to: ${verification_status}`
          );
        }

        // Find or Insert Author record (ALWAYS do this now if orcidSearchResult exists)
        const { data: existingAuthor, error: findError } = await supabase
          .from("authors")
          .select("id")
          .eq("orcid_id", orcidSearchResult.orcid)
          .maybeSingle();
        if (findError)
          throw new Error(
            `DB error finding author by searched ORCID ${orcidSearchResult.orcid}: ${findError.message}`
          );

        if (existingAuthor) {
          authorRecord = { id: existingAuthor.id };
          console.log(
            `   Resolved author "${original_name_string}" to existing ORCID ${orcidSearchResult.orcid} via SEARCH (Author ID: ${existingAuthor.id}, Final Status: ${verification_status})`
          );
          triggerOrcidEnrichment(existingAuthor.id, orcidSearchResult.orcid);
        } else {
          const { data: insertedAuthor, error: insertError } = await supabase
            .from("authors")
            .insert({
              orcid_id: orcidSearchResult.orcid,
              canonical_name: original_name_string,
            })
            .select("id")
            .single();
          if (insertError)
            throw new Error(
              `DB error inserting new author for searched ORCID ${orcidSearchResult.orcid}: ${insertError.message}`
            );
          authorRecord = { id: insertedAuthor.id };
          console.log(
            `   Inserted new author for "${original_name_string}" with ORCID ${orcidSearchResult.orcid} via SEARCH (Author ID: ${insertedAuthor.id}, Final Status: ${verification_status})`
          );
          triggerOrcidEnrichment(insertedAuthor.id, orcidSearchResult.orcid);
        }
      }
      // --- Stage 3: Create/Find Placeholder (only if ORCID search yielded nothing) ---
      if (!authorRecord) {
        console.log(
          `   [!] No ORCID found for "${original_name_string}" via Crossref or Search. Checking/creating placeholder (orcid_id = NULL).`
        );
        const { data: placeholder, error: findError } = await supabase
          .from("authors")
          .select("id")
          .is("orcid_id", null)
          .eq("canonical_name", original_name_string)
          .maybeSingle();
        if (findError)
          throw new Error(
            `DB error finding placeholder author for name "${original_name_string}": ${findError.message}`
          );
        if (placeholder) {
          authorRecord = { id: placeholder.id };
          verification_status = "UNVERIFIED";
          console.log(
            `   [+] Found existing placeholder author record ${authorRecord.id} for "${original_name_string}" (Status: UNVERIFIED)`
          );
        } else {
          console.log(
            `   [*] Creating NEW placeholder author record for "${original_name_string}" (orcid_id = NULL)...`
          );
          const { data: insertedPlaceholder, error: insertError } =
            await supabase
              .from("authors")
              .insert({ orcid_id: null, canonical_name: original_name_string })
              .select("id")
              .single();
          if (insertError)
            throw new Error(
              `DB error inserting placeholder author for name "${original_name_string}": ${insertError.message}`
            );
          authorRecord = { id: insertedPlaceholder.id };
          verification_status = "UNVERIFIED";
          console.log(
            `   [+] Created new placeholder author record ${authorRecord.id} for "${original_name_string}" (Status: UNVERIFIED)`
          );
        }
      } // End placeholder logic
    } else {
      console.error(
        `Invalid source_type "${source_type}" in resolveAuthor for "${original_name_string}"`
      );
      return null;
    }

    if (!authorRecord) {
      console.error(
        `   Failed to resolve or create any author record for "${original_name_string}"`
      );
      return null;
    }
    return {
      author_id: authorRecord.id,
      verification_status: verification_status,
    };
  } catch (error) {
    console.error(
      `Error in resolveAuthor for "${original_name_string}": ${error.message}`
    );
    return null;
  }
}

/**
 * Main function to check and insert papers and link authors
 */
async function checkAndInsertPaperIfNew(item, allCategories, pubDate) {
  const title = sanitizeValue(item.title);
  const paperUrl = sanitizeValue(item.link);
  const arxivId = extractArxivId(paperUrl);

  console.log(`Processing paper: ${arxivId} - "${title}"`);

  try {
    if (!arxivId) {
      console.error(`Failed to extract arxivId from URL: ${paperUrl}`);
      return;
    }
    if (!isAnnounceTypeNew(item)) {
      console.log(
        `Skipping paper "${title}" (ID: ${arxivId}) because its announceType ('${
          item.announceType || item["arxiv:announce_type"]
        }') is not new/replace/replace-cross.`
      );
      return;
    }
    const paperArxivCategories = (item.categories || [])
      .map((cat) =>
        typeof cat === "string" ? cat.trim() : cat._ ? cat._.trim() : null
      )
      .filter((cat) => cat && allowedCategories.includes(cat));
    if (paperArxivCategories.length === 0) {
      console.log(
        `Skipping paper "${title}" (ID: ${arxivId}) because it does not have an allowed category in [${(
          item.categories || []
        )
          .map((c) => (typeof c === "string" ? c : c?._))
          .join(", ")}]`
      );
      return;
    }

    const { data: existingPaper, error: selectError } = await supabase
      .from("arxivPapersData")
      .select("id")
      .eq("arxivId", arxivId)
      .maybeSingle();
    if (selectError) {
      console.error(
        `Failed to check existing paper "${title}" (ID: ${arxivId}):`,
        selectError
      );
      return;
    }
    if (existingPaper) {
      console.log(
        `Paper "${title}" (ID: ${arxivId}) already exists. Skipping.`
      );
      return;
    }

    const original_authors_str = sanitizeValue(item.creator);
    const doi = sanitizeValue(item.doi || item["arxiv:doi"]);
    const abstractText = sanitizeValue(
      item.contentSnippet || item.summary || item.description || ""
    ).replace(/^Abstract:\s*/i, "");
    const pdfUrl = generatePdfUrl(arxivId);
    const slug = generateSlug(title || arxivId);
    const publishedDate = new Date(item.pubDate || pubDate).toISOString();
    const lastUpdated = new Date().toISOString();

    const { data: insertedPaper, error: insertError } = await supabase
      .from("arxivPapersData")
      .insert([
        {
          title: title || `arXiv:${arxivId}`,
          arxivCategories: paperArxivCategories,
          abstract: abstractText,
          paperUrl: paperUrl,
          pdfUrl: pdfUrl,
          publishedDate: publishedDate,
          lastUpdated: lastUpdated,
          indexedDate: lastUpdated,
          arxivId: arxivId,
          slug: slug,
          platform: "arxiv",
          doi: doi,
        },
      ])
      .select("id")
      .single();
    if (insertError) {
      console.error(
        `Failed to insert paper "${title}" (ID: ${arxivId}):`,
        insertError
      );
      return;
    }
    const paper_id = insertedPaper.id;
    console.log(
      `Inserted new paper "${title}" (ID: ${arxivId}) with DB ID ${paper_id}`
    );

    const original_authors_list = original_authors_str
      ? original_authors_str.split(/,\s*(?![jJ]r\.|[IVXLCDM]+$)/g)
      : [];
    if (original_authors_list.length === 0) {
      console.warn(`No authors found for paper ${arxivId}`);
      return;
    }

    let crossrefAuthors = [];
    if (doi) {
      console.log(`Fetching Crossref for DOI: ${doi}`);
      try {
        const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(
          doi
        )}`;
        const response = await axios.get(crossrefUrl, {
          timeout: 15000,
          headers: { Accept: "application/json" },
        });
        crossrefAuthors = response.data?.message?.author || [];
        console.log(
          `Found ${crossrefAuthors.length} authors in Crossref for DOI ${doi}`
        );
      } catch (err) {
        if (err.response && err.response.status === 404)
          console.log(`Crossref returned 404 for DOI ${doi}.`);
        else
          console.warn(
            `Failed to fetch/parse Crossref for DOI ${doi}: ${err.message}`
          );
      }
    } else {
      console.log(`No DOI found for paper ${arxivId}, skipping Crossref.`);
    }

    for (let i = 0; i < original_authors_list.length; i++) {
      const original_name_string = sanitizeValue(original_authors_list[i]);
      const author_order = i + 1;
      if (!original_name_string) continue;
      console.log(
        ` -> Processing author ${author_order}/${original_authors_list.length}: "${original_name_string}"`
      );
      let resolvedAuthorData = null;
      let foundOrcidInCrossref = false;

      if (crossrefAuthors.length > 0) {
        const normalizedOriginalName = original_name_string.toLowerCase();
        const originalFamilyNameMatch = normalizedOriginalName.split(" ").pop();
        const crossrefMatch = crossrefAuthors.find((ca) => {
          const cg = (ca.given || "").toLowerCase();
          const cf = (ca.family || "").toLowerCase();
          const cfn = `${cg} ${cf}`.trim();
          return (
            cfn === normalizedOriginalName ||
            (cf &&
              originalFamilyNameMatch &&
              cf.includes(originalFamilyNameMatch)) ||
            (cf && normalizedOriginalName.includes(cf))
          );
        });
        if (crossrefMatch?.ORCID) {
          const orcidUrl = crossrefMatch.ORCID;
          const orcidIdMatch = orcidUrl.match(
            /(\d{4}-\d{4}-\d{4}-\d{3}[0-9X])$/
          );
          if (orcidIdMatch) {
            const orcid_id = orcidIdMatch[1];
            console.log(`   Found ORCID ${orcid_id} via Crossref match.`);
            resolvedAuthorData = await resolveAuthor(
              original_name_string,
              orcid_id,
              "FROM_CROSSREF",
              arxivId,
              doi
            );
            foundOrcidInCrossref = true;
          }
        }
      }
      if (!foundOrcidInCrossref)
        resolvedAuthorData = await resolveAuthor(
          original_name_string,
          null,
          "SEARCH_ORCID",
          arxivId,
          doi
        );

      if (resolvedAuthorData?.author_id) {
        const { error: linkError } = await supabase
          .from("paperAuthors")
          .insert({
            paper_id: paper_id,
            author_id: resolvedAuthorData.author_id,
            author_order: author_order,
            original_name_string: original_name_string,
            verification_status: resolvedAuthorData.verification_status,
          });
        if (linkError) {
          if (linkError.code === "23505")
            console.warn(
              `   Attempted to link duplicate author ${resolvedAuthorData.author_id} to paper ${paper_id}. Skipping.`
            );
          else
            console.error(
              `   DB error linking author ${resolvedAuthorData.author_id} to paper ${paper_id}:`,
              linkError
            );
        } else
          console.log(
            `   Linked author ${resolvedAuthorData.author_id} to paper ${paper_id} with status ${resolvedAuthorData.verification_status}`
          );
      } else {
        console.error(
          `   Could not resolve/create author record for "${original_name_string}" on paper ${arxivId}`
        );
      }
    }
  } catch (error) {
    console.error(
      `Top-level error processing paper item "${title || paperUrl}":`,
      error
    );
  }
}

async function fetchPapersFromRSS(category) {
  try {
    console.log(`Fetching RSS feed for category "${category}"...`);
    const feedUrl = `https://rss.arxiv.org/rss/${category}`;
    const feed = await rssParser.parseURL(feedUrl);
    console.log(
      `Found ${feed.items.length} items in category "${category}" feed.`
    );
    const feedPubDate = new Date(feed.pubDate || Date.now());
    let processedCount = 0;
    for (const item of feed.items) {
      const itemCategories = item.categories || [category];
      await checkAndInsertPaperIfNew(item, itemCategories, feedPubDate);
      processedCount++;
    }
    console.log(
      `Finished processing ${processedCount} items for category "${category}"`
    );
  } catch (error) {
    console.error(
      `Failed to fetch or process RSS feed for category "${category}". Error:`,
      error
    );
  }
}

async function fetchNewPapers() {
  console.log("Starting master fetch process from arXiv RSS...");
  try {
    for (const category of categories) await fetchPapersFromRSS(category);
    console.log(
      "Attempting to refresh materialized view 'unique_authors_data_view'..."
    );
    // Ensure execute_sql function exists in Supabase
    const { error: rpcError } = await supabase.rpc("execute_sql", {
      sql_text:
        "REFRESH MATERIALIZED VIEW CONCURRENTLY public.unique_authors_data_view;",
    });
    if (rpcError) {
      console.error(
        "Error refreshing materialized view via RPC (concurrently):",
        rpcError
      );
      console.log("Attempting non-concurrent refresh as fallback...");
      const { error: fallbackRpcError } = await supabase.rpc("execute_sql", {
        sql_text: "REFRESH MATERIALIZED VIEW public.unique_authors_data_view;",
      });
      if (fallbackRpcError)
        console.error(
          "Fallback non-concurrent refresh also failed:",
          fallbackRpcError
        );
      else
        console.log(
          "Materialized view refreshed successfully (non-concurrently)."
        );
    } else
      console.log(
        "Materialized view refreshed successfully via RPC (concurrently)."
      );
  } catch (error) {
    console.error("Error during the main fetchNewPapers execution:", error);
  } finally {
    console.log("Finished master fetch process.");
  }
}

// Direct execution point
console.log("Initiating paper fetcher...");
fetchNewPapers().catch((error) => {
  console.error("Unhandled fatal error in fetchNewPapers:", error);
  process.exit(1);
});
