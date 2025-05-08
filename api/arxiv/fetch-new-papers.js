import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import axios from "axios";
import Parser from "rss-parser";
import slugify from "slugify";
// Added for HTML storing
import zlib from "zlib";
import crypto from "crypto";
import { Buffer } from "buffer"; // Ensure Buffer is available

// Set up explicit execution logging
console.log("Script starting: fetch-new-papers.js");

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

// --- Script Configuration ---
const DELAY_BETWEEN_AUTHORS_MS = 1100; // Delay between processing each author (for ORCID rate limits)
const DELAY_WITHIN_WORKS_CHECK_MS = 150; // Delay within works check loop (for ORCID rate limits)
// *** IMPORTANT: Add delay for HTML fetching if calling sequentially ***
const DELAY_BETWEEN_HTML_FETCH_MS = 5000; // Start with 5 seconds, ADJUST based on arXiv limits/blocking

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

// Browser simulation headers (needed for HTML fetch)
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

// --- Helper Functions ---

// Simple delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function sanitizeValue(value) {
  // Match sanitization used in backfill script
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x1F\x7F-\x9F\\]|"/g, "").trim();
  }
  return value;
}

function extractArxivId(url) {
  const match = url ? url.match(/\/abs\/(.+)/) : null;
  // Extract ID and try to get version if present
  const idWithVersion = match ? match[1] : null;
  if (!idWithVersion) return { id: null, version: null };

  const versionMatch = idWithVersion.match(/v(\d+)$/);
  const version = versionMatch ? `v${versionMatch[1]}` : null;
  const id = idWithVersion.replace(/v\d+$/, "");
  return { id, version };
}

function normalizeArxivId(id) {
  if (!id) return null;
  return id
    .toLowerCase()
    .replace(/^arxiv:/, "")
    .replace(/v\d+$/, "") // Ensure version is stripped for normalization
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
// [ORCID functions remain unchanged]
// ... (Keep existing ORCID functions here) ...
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
  console.log("   Fetching new ORCID token...");
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
    console.log("   New ORCID token obtained and cached");
    return token;
  } catch (error) {
    console.error(
      `   Failed to get ORCID API token: ${error.message}`,
      error.response?.data ? JSON.stringify(error.response.data) : ""
    );
    orcidTokenCache.token = null;
    orcidTokenCache.expiry = null;
    return null;
  }
}

// Updated searchOrcidByName to be stricter
async function searchOrcidByName(searchTerm, token) {
  if (!searchTerm || !token) return null;
  const nameParts = searchTerm.trim().split(/\s+/);
  const familyName = nameParts.pop() || "";
  const givenNames = nameParts.join(" ");

  // --- MODIFIED QUERY ---
  // Only search by family name and exact full given name (if available)
  let query = `family-name:"${familyName}"`; // Use quotes for potentially better matching
  if (givenNames) {
    query += ` AND given-names:"${givenNames}"`;
  } else {
    console.log(
      `      WARN: Only one name part found ('${familyName}'). Searching by family name only.`
    );
  }
  // --- END MODIFIED QUERY ---

  console.log(`      Searching ORCID with STRICT query: ${query}`);
  try {
    const response = await axios.get(`${ORCID_API_URL}/search`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      params: { q: query },
      timeout: 15000,
    });
    const results = response.data?.result || [];
    const numFound = response.data?.["num-found"] || 0;
    if (numFound === 0 || !results[0]) {
      console.log(
        `      ORCID strict search found no results for query: ${query}`
      );
      return null;
    }
    const topResult = results[0];
    const orcidId = topResult["orcid-identifier"]?.path;
    if (!orcidId) {
      console.warn(
        "      ORCID search result missing orcid-identifier path:",
        topResult
      );
      return null;
    }
    // isHighConfidence is true only if exactly one result is found
    const isHighConfidence = numFound === 1;
    console.log(
      `      ORCID strict search found ${numFound} result(s). Top result: ${orcidId} (HighConf: ${isHighConfidence})`
    );
    // Return confidence flag along with the top result's ORCID
    return { orcid: orcidId, name: null, isHighConfidence: isHighConfidence };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`      ORCID strict search returned 404 for query: ${query}`);
      return null;
    }
    console.error(
      `      Failed to search ORCID by name (strict) (${searchTerm}): ${error.message}`,
      error.response?.status ? `Status: ${error.response.status}` : ""
    );
    return null;
  }
}

/**
 * Checks if a specific paper (by arXiv ID or DOI) exists in an ORCID profile's works.
 * Handles pagination up to a limit. Includes delay for rate limiting.
 */
async function checkOrcidWorksForPaper(orcidId, arxivId, doi, token) {
  if (!orcidId || !token || (!arxivId && !doi)) return false;
  const normalizedTargetArxivId = normalizeArxivId(arxivId);
  console.log(
    `   Checking ALL ORCID works for ${orcidId} for paper arXiv:${normalizedTargetArxivId} / DOI:${doi}`
  );

  let offset = 0;
  let totalWorks = 0;
  let pagesChecked = 0;
  let groupsOnPage = 0;

  do {
    // Add delay before fetching next page to respect rate limits
    if (pagesChecked > 0) {
      // Don't delay before the first fetch
      await delay(DELAY_WITHIN_WORKS_CHECK_MS);
    }

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
      pagesChecked++; // Increment after processing the current page's response

      if (
        pagesChecked >= MAX_WORKS_PAGES_TO_CHECK ||
        (totalWorks > 0 && offset >= totalWorks) || // Added check against totalWorks
        groupsOnPage < ORCID_WORKS_PAGE_SIZE
      ) {
        console.log(
          `      Stopping works check: Pages checked=${pagesChecked}, Processed approx=${offset}/${
            totalWorks || "unknown"
          }, Last page size=${groupsOnPage}`
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
      return false; // Stop checking if an error occurs
    }
  } while (groupsOnPage === ORCID_WORKS_PAGE_SIZE); // Continue only if the last page was full

  console.log(
    `   Paper (arXiv:${normalizedTargetArxivId} / DOI:${doi}) not found after checking ${pagesChecked} page(s) of works for ORCID ${orcidId}.`
  );
  return false;
}

/**
 * Enrich author profile with data from ORCID API (inline for now)
 * Conditionally stores emails based on NODE_ENV.
 */
async function triggerOrcidEnrichment(authorId, orcidId) {
  if (!authorId || !orcidId) {
    console.warn(
      "   Skipping enrichment trigger: Missing authorId or orcidId."
    );
    return;
  }
  console.log(
    `   Attempting ORCID enrichment trigger for author ${authorId} with ORCID ${orcidId}`
  );
  try {
    const token = await getOrcidApiToken();
    if (!token) {
      console.warn(`   Skipping enrichment for ${authorId}: No ORCID token.`);
      return;
    }
    const response = await axios.get(`${ORCID_API_URL}/${orcidId}/person`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const personData = response.data;
    // Ensure orcid_id is included in update, especially if enriching an existing record
    let updateData = {
      last_orcid_sync: new Date().toISOString(),
      orcid_id: orcidId,
    };

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

    // Researcher URLs
    let parsedUrls = [];
    if (personData["researcher-urls"]?.["researcher-url"]?.length > 0) {
      // console.log(`   Parsing URLs from 'researcher-urls' structure for ${orcidId}`); // Less verbose
      parsedUrls = personData["researcher-urls"]["researcher-url"]
        .map((item) => ({ name: item["url-name"], url: item.url?.value })) // Correct keys
        .filter((u) => u.url && u.name);
    }
    if (parsedUrls.length > 0) {
      updateData.researcher_urls = parsedUrls;
      // console.log(`   Found and parsed ${parsedUrls.length} researcher URLs for ${orcidId}`); // Less verbose
    } else {
      // console.log(`   No researcher URLs found or parsed for ${orcidId}`); // Less verbose
    }

    // Conditional Email Storage
    const hasRealEmails = personData.emails?.email?.length > 0; // Check if real emails exist

    if (process.env.NODE_ENV === "production") {
      // Production: Store real emails only if they exist
      if (hasRealEmails) {
        console.log(
          `      Storing ${personData.emails.email.length} real emails for author ${authorId} in production.`
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
          `      No real emails found for author ${authorId} in production. 'emails' field not updated.`
        );
      }
    } else {
      // Development/Other: Store hardcoded email ONLY IF real emails were found in ORCID data
      if (hasRealEmails) {
        const devEmail = "msyoung2012@gmail.com";
        console.log(
          `      Real emails found for author ${authorId}, storing hardcoded dev email (${devEmail}) instead (NODE_ENV: ${process.env.NODE_ENV})`
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
          `      No real emails found for author ${authorId}, skipping dev email storage (NODE_ENV: ${process.env.NODE_ENV}). 'emails' field not updated.`
        );
      }
    }

    // Update the author record
    const { error } = await supabase
      .from("authors")
      .update(updateData)
      .eq("id", authorId);
    if (error)
      console.error(
        `   Failed to update author ${authorId} (ORCID ${orcidId}) with enrichment data:`,
        error
      );
    else
      console.log(
        `   Successfully enriched author ${authorId} (ORCID ${orcidId})`
      );
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn(
        `   ORCID ID ${orcidId} (for author ${authorId}) returned 404 during enrichment. Cannot enrich.`
      );
      return;
    }
    console.error(
      `   Error during ORCID enrichment for author ${authorId} (ORCID ${orcidId}): ${error.message}`,
      error.response?.status ? `Status: ${error.response.status}` : ""
    );
  }
}

/**
 * Resolve author: Find existing or create new author record based on available info.
 * Uses stricter ORCID search and only proceeds with high-confidence results.
 * Calls enrichment whenever an ORCID is associated.
 * @param {string} original_name_string - The name string from the paper's author list.
 * @param {string|null} orcid_from_source - ORCID ID found via Crossref (if any).
 * @param {'FROM_CROSSREF'|'SEARCH_ORCID'} source_type - How the ORCID was (or wasn't) found.
 * @param {string|null} arxivId - The arXiv ID of the paper for works check.
 * @param {string|null} doi - The DOI of the paper for works check.
 * @returns {Promise<{author_id: string, verification_status: string}|null>} Object with author_id and verification_status, or null on failure.
 */
async function resolveAuthor(
  original_name_string,
  orcid_from_source,
  source_type,
  arxivId = null,
  doi = null
) {
  // This function is identical to the one in enrich-arxiv-authors.js
  // It now includes the stricter search logic and high-confidence check.
  let authorRecord = null;
  let resolved_orcid_id = orcid_from_source; // Use ORCID from Crossref if available
  let verification_status = "UNVERIFIED";
  let author_id = null;

  if (!original_name_string) {
    console.error("Attempted to resolve author with empty name string.");
    return null;
  }
  const sanitized_name = sanitizeValue(original_name_string);
  if (!sanitized_name) {
    console.error(
      `      Author name "${original_name_string}" became empty after sanitization.`
    );
    return null;
  }

  console.log(
    `   Resolving author: "${sanitized_name}" (Source Type: ${source_type}, Crossref ORCID: ${
      orcid_from_source || "N/A"
    })`
  );

  try {
    // --- Stage 1: Check provided ORCID (if from Crossref) ---
    if (resolved_orcid_id && source_type === "FROM_CROSSREF") {
      verification_status = "FROM_CROSSREF";
      const { data: existingAuthor, error: findError } = await supabase
        .from("authors")
        .select("id")
        .eq("orcid_id", resolved_orcid_id)
        .maybeSingle();

      if (findError)
        throw new Error(
          `DB error finding author by ORCID ${resolved_orcid_id}: ${findError.message}`
        );

      if (existingAuthor) {
        author_id = existingAuthor.id;
        console.log(
          `      Found existing author ${author_id} via Crossref ORCID ${resolved_orcid_id}. Status: ${verification_status}`
        );
        await triggerOrcidEnrichment(author_id, resolved_orcid_id); // Enrich existing
      } else {
        console.log(
          `      Inserting new author with Crossref ORCID ${resolved_orcid_id} for name "${sanitized_name}"...`
        );
        const { data: insertedAuthor, error: insertError } = await supabase
          .from("authors")
          .insert({
            orcid_id: resolved_orcid_id,
            canonical_name: sanitized_name,
          })
          .select("id")
          .single();
        if (insertError)
          throw new Error(
            `DB error inserting new author for ORCID ${resolved_orcid_id}: ${insertError.message}`
          );
        author_id = insertedAuthor.id;
        console.log(
          `      Inserted new author ${author_id}. Status: ${verification_status}`
        );
        await triggerOrcidEnrichment(author_id, resolved_orcid_id); // Enrich new
      }
    }
    // --- Stage 2: Search ORCID by name (if no Crossref ORCID) ---
    else if (source_type === "SEARCH_ORCID") {
      const orcidToken = await getOrcidApiToken();
      let orcidSearchResult = null;
      if (orcidToken) {
        orcidSearchResult = await searchOrcidByName(sanitized_name, orcidToken); // Uses stricter search now
      }

      // --- MODIFIED: Only proceed if high confidence ---
      if (orcidSearchResult?.orcid && orcidSearchResult.isHighConfidence) {
        console.log(
          `      ORCID Search found high-confidence match: ${orcidSearchResult.orcid} for "${sanitized_name}"`
        );
        const potential_orcid = orcidSearchResult.orcid;

        // Check if this ORCID is already assigned to ANY author
        const { data: existingAuthorWithOrcid, error: checkError } =
          await supabase
            .from("authors")
            .select("id, canonical_name")
            .eq("orcid_id", potential_orcid)
            .maybeSingle();

        if (checkError)
          throw new Error(
            `DB error checking for existing ORCID ${potential_orcid}: ${checkError.message}`
          );

        let paperFoundOnProfile = false; // Check works regardless of existing/new author
        if (orcidToken) {
          paperFoundOnProfile = await checkOrcidWorksForPaper(
            potential_orcid,
            arxivId,
            doi,
            orcidToken
          );
        }
        // Set status based on works check for the link
        verification_status = paperFoundOnProfile
          ? "ORCID_MATCH_CONFIRMED"
          : "ORCID_MATCH_POTENTIAL";

        if (existingAuthorWithOrcid) {
          // High-confidence ORCID matches an existing author record
          author_id = existingAuthorWithOrcid.id;
          resolved_orcid_id = potential_orcid;
          console.log(
            `         Found existing author ${author_id} ("${existingAuthorWithOrcid.canonical_name}") via high-confidence search. Final Status: ${verification_status}`
          );
          await triggerOrcidEnrichment(author_id, resolved_orcid_id); // Enrich existing
        } else {
          // High-confidence ORCID is new. Create a new author.
          resolved_orcid_id = potential_orcid;
          console.log(
            `         High-confidence ORCID ${resolved_orcid_id} is new. Final Status: ${verification_status}`
          );
          console.log(
            `         Inserting new author with high-confidence searched ORCID ${resolved_orcid_id} for name "${sanitized_name}"...`
          );
          const { data: insertedAuthor, error: insertError } = await supabase
            .from("authors")
            .insert({
              orcid_id: resolved_orcid_id,
              canonical_name: sanitized_name,
            })
            .select("id")
            .single();
          if (insertError)
            throw new Error(
              `DB error inserting new author for searched ORCID ${resolved_orcid_id}: ${insertError.message}`
            );
          author_id = insertedAuthor.id;
          console.log(`         Inserted new author ${author_id}.`);
          await triggerOrcidEnrichment(author_id, resolved_orcid_id); // Enrich new
        }
      } else if (
        orcidSearchResult?.orcid &&
        !orcidSearchResult.isHighConfidence
      ) {
        // Low confidence result - log and skip ORCID association
        console.log(
          `      ORCID Search found match ${orcidSearchResult.orcid} but confidence is low (multiple results). Skipping ORCID association.`
        );
        resolved_orcid_id = null;
        // author_id remains null, will proceed to placeholder check
      } else {
        // No search results
        console.log(`      No ORCID found via search for "${sanitized_name}".`);
        resolved_orcid_id = null;
        // author_id remains null, will proceed to placeholder check
      }

      // --- Stage 3: No ORCID found OR low confidence search ---
      if (!author_id) {
        console.log(
          `      No high-confidence ORCID associated. Checking/creating placeholder author...`
        );
        resolved_orcid_id = null; // Ensure no ORCID
        verification_status = "UNVERIFIED";

        const { data: placeholder, error: findError } = await supabase
          .from("authors")
          .select("id")
          .is("orcid_id", null)
          .eq("canonical_name", sanitized_name)
          .maybeSingle();

        if (findError)
          throw new Error(
            `DB error finding placeholder author for name "${sanitized_name}": ${findError.message}`
          );

        if (placeholder) {
          author_id = placeholder.id;
          console.log(
            `         Found existing placeholder author ${author_id} for "${sanitized_name}". Status: ${verification_status}`
          );
        } else {
          console.log(
            `         Creating NEW placeholder author record for "${sanitized_name}"...`
          );
          const { data: insertedPlaceholder, error: insertError } =
            await supabase
              .from("authors")
              .insert({ orcid_id: null, canonical_name: sanitized_name })
              .select("id")
              .single();
          if (insertError)
            throw new Error(
              `DB error inserting placeholder author for name "${sanitized_name}": ${insertError.message}`
            );
          author_id = insertedPlaceholder.id;
          console.log(
            `         Created new placeholder author ${author_id}. Status: ${verification_status}`
          );
          // Do NOT call triggerOrcidEnrichment for placeholders
        }
      } // End placeholder logic
    } else {
      console.error(
        `Invalid source_type "${source_type}" in resolveAuthor for "${sanitized_name}"`
      );
      return null;
    }

    // Final check for author_id
    if (!author_id) {
      console.error(
        `   Failed to resolve or create any author record for "${sanitized_name}"`
      );
      return null;
    }

    // Return only author_id and verification_status needed for linking
    // ORCID enrichment is handled internally now
    return {
      author_id: author_id,
      verification_status: verification_status,
      // orcid_id: resolved_orcid_id // No longer needed by caller
    };
  } catch (error) {
    console.error(
      `Error in resolveAuthor for "${original_name_string}": ${error.message}`
    );
    return null;
  }
}

// --- CORRECTED: Function to fetch and store arXiv HTML ---
/**
 * Fetches HTML for a given arXiv paper, gzips it, calculates hash, and stores in paper_assets.
 * Logs fetch errors to the table.
 * @param {string} paperId - The UUID of the paper in arxivPapersData.
 * @param {string} arxivIdWithVersion - The arXiv ID, potentially including version (e.g., '2301.12345v1').
 */
async function storeArxivHtml(paperId, arxivIdWithVersion) {
  const plainArxivId = normalizeArxivId(arxivIdWithVersion); // Get ID without version for logging consistency
  console.log(
    `[HTML Store] Attempting to store HTML for paperId: ${paperId}, arxivId: ${plainArxivId}`
  );
  const htmlUrl = `https://arxiv.org/html/${arxivIdWithVersion}`; // Use ID with version for fetching correct HTML
  let versionIdentifier = arxivIdWithVersion.match(/v(\d+)$/)?.[0] || null; // Extract 'vX'

  try {
    const response = await axios.get(htmlUrl, {
      headers: browserHeaders,
      timeout: 20000, // Increased timeout for potentially larger HTML pages
      responseType: "text", // Ensure we get text
    });

    const htmlContent = response.data;
    if (!htmlContent || typeof htmlContent !== "string") {
      throw new Error("Fetched content is not valid HTML string.");
    }

    // Gzip Content
    const gzippedContentBuffer = zlib.gzipSync(
      Buffer.from(htmlContent, "utf-8")
    );

    // Calculate Hash (of uncompressed content)
    const hash = crypto.createHash("sha256").update(htmlContent).digest("hex");

    // *** CRITICAL FIX: Convert Buffer to hex string for BYTEA insertion ***
    // PostgreSQL BYTEA hex format starts with '\x'
    const hexStringForDb = "\\x" + gzippedContentBuffer.toString("hex");
    console.log(
      `[HTML Store] Storing gzipped data as hex string (length: ${hexStringForDb.length}) for ${plainArxivId}`
    );

    // Insert into public.paper_assets using the hex string
    const { data, error: insertError } = await supabase
      .from("paper_assets")
      .insert({
        paper_id: paperId,
        arxiv_id: plainArxivId, // Store normalized ID
        asset_type: "html_content_gzipped",
        content_gzipped: hexStringForDb, // Store the hex string
        source_url: htmlUrl,
        content_hash_sha256: hash,
        content_version_identifier: versionIdentifier,
        fetched_at: new Date().toISOString(),
        fetch_error: null, // Explicitly set to null on success
      });

    if (insertError) {
      console.error(
        `[HTML Store] DB insert error for ${plainArxivId}:`,
        insertError
      );
      // Optional: Decide if you want to throw an error here or just log it
    } else {
      console.log(`[HTML Store] Successfully stored HTML for ${plainArxivId}.`);
    }
  } catch (fetchError) {
    let errorMessage = fetchError.message;
    if (axios.isAxiosError(fetchError) && fetchError.response) {
      errorMessage = `HTTP ${fetchError.response.status}: ${fetchError.message}`;
      console.error(
        `[HTML Store] Fetch error for ${plainArxivId} (${htmlUrl}): HTTP ${fetchError.response.status}`
      );
    } else {
      console.error(
        `[HTML Store] Fetch/Processing error for ${plainArxivId} (${htmlUrl}): ${errorMessage}`
      );
    }

    // Log the failure to paper_assets
    const { error: logError } = await supabase.from("paper_assets").insert({
      paper_id: paperId,
      arxiv_id: plainArxivId, // Store normalized ID
      asset_type: "html_content_gzipped",
      source_url: htmlUrl,
      fetch_error: errorMessage.substring(0, 500), // Truncate long errors
      content_version_identifier: versionIdentifier,
      fetched_at: new Date().toISOString(),
    });

    if (logError) {
      console.error(
        `[HTML Store] CRITICAL: Failed to log fetch error for ${plainArxivId} to DB:`,
        logError
      );
    }
  }
}

/**
 * Main function to check and insert papers and link authors
 */
async function checkAndInsertPaperIfNew(item, allCategories, pubDate) {
  const title = sanitizeValue(item.title);
  const paperUrl = sanitizeValue(item.link);
  // Use the modified extractArxivId to get ID and version
  const { id: arxivIdBase, version: arxivVersion } = extractArxivId(paperUrl);
  // Construct the ID with version if available, otherwise use base ID for fetching HTML later
  const arxivIdForHtmlFetch = arxivVersion
    ? `${arxivIdBase}${arxivVersion}`
    : arxivIdBase;

  console.log(`Processing paper: ${arxivIdBase} - "${title}"`); // Log base ID for consistency

  try {
    if (!arxivIdBase) {
      console.error(`Failed to extract arxivId from URL: ${paperUrl}`);
      return;
    }
    if (!isAnnounceTypeNew(item)) {
      console.log(
        `Skipping paper "${title}" (ID: ${arxivIdBase}) because its announceType ('${
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
        `Skipping paper "${title}" (ID: ${arxivIdBase}) because it does not have an allowed category in [${(
          item.categories || []
        )
          .map((c) => (typeof c === "string" ? c : c?._))
          .join(", ")}]`
      );
      return;
    }

    // Check using the base ArXiv ID (without version) for existence
    const { data: existingPaper, error: selectError } = await supabase
      .from("arxivPapersData")
      .select("id")
      .eq("arxivId", arxivIdBase) // Check against the base ID
      .maybeSingle();
    if (selectError) {
      console.error(
        `Failed to check existing paper "${title}" (ID: ${arxivIdBase}):`,
        selectError
      );
      return;
    }
    if (existingPaper) {
      console.log(
        `Paper "${title}" (ID: ${arxivIdBase}) already exists. Skipping.`
      );
      return;
    }

    const original_authors_str = sanitizeValue(item.creator);
    // Use sanitized DOI from RSS item directly
    const doi = sanitizeValue(item.doi || item["arxiv:doi"]);
    const abstractText = sanitizeValue(
      item.contentSnippet || item.summary || item.description || ""
    ).replace(/^Abstract:\s*/i, "");
    const pdfUrl = generatePdfUrl(arxivIdBase); // Use base ID for PDF URL consistency
    const slug = generateSlug(title || arxivIdBase);
    const publishedDate = new Date(item.pubDate || pubDate).toISOString();
    const lastUpdated = new Date().toISOString();

    // --- Insert Paper ---
    const { data: insertedPaper, error: insertError } = await supabase
      .from("arxivPapersData")
      .insert([
        {
          title: title || `arXiv:${arxivIdBase}`,
          arxivCategories: paperArxivCategories,
          abstract: abstractText,
          paperUrl: paperUrl,
          pdfUrl: pdfUrl,
          publishedDate: publishedDate,
          lastUpdated: lastUpdated,
          indexedDate: lastUpdated,
          arxivId: arxivIdBase, // Store the base ID in the main table
          slug: slug,
          platform: "arxiv",
          doi: doi, // Insert DOI found from RSS/API
        },
      ])
      .select("id") // Select the UUID 'id' column
      .single();

    if (insertError) {
      console.error(
        `Failed to insert paper "${title}" (ID: ${arxivIdBase}):`,
        insertError
      );
      return; // Stop processing if paper insert fails
    }

    // Ensure we have the UUID paper_id
    if (!insertedPaper || !insertedPaper.id) {
      console.error(
        `Failed to retrieve paper ID after insert for "${title}" (ID: ${arxivIdBase}). Cannot store HTML.`
      );
      return;
    }
    const paper_id = insertedPaper.id; // This is the UUID
    console.log(
      `Inserted new paper "${title}" (ID: ${arxivIdBase}) with DB ID ${paper_id}`
    );

    // --- Store HTML Asset ---
    // Call storeArxivHtml AFTER successful paper insertion
    // Pass the UUID paper_id and the arxiv ID (with version if available) for fetching
    // Add a delay before fetching HTML to respect rate limits if processing many papers sequentially
    console.log(
      `[HTML Store] Scheduling HTML fetch for ${arxivIdBase} after delay...`
    );
    await delay(DELAY_BETWEEN_HTML_FETCH_MS); // Apply delay *before* the fetch
    await storeArxivHtml(paper_id, arxivIdForHtmlFetch);

    // --- Process Authors ---
    const original_authors_list = original_authors_str
      ? original_authors_str.split(/,\s*(?![jJ]r\.|[IVXLCDM]+$)/g)
      : [];
    if (original_authors_list.length === 0) {
      console.warn(`No authors found for paper ${arxivIdBase}`);
      // Continue processing even if no authors? Or return? Decided to continue.
    } else {
      let crossrefAuthors = [];
      // Use the DOI we determined for the paper (from RSS)
      const effectiveDoi = doi;

      if (effectiveDoi) {
        console.log(`Fetching Crossref for DOI: ${effectiveDoi}`);
        try {
          const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(
            effectiveDoi
          )}`;
          const response = await axios.get(crossrefUrl, {
            timeout: 15000,
            headers: { Accept: "application/json" },
          });
          crossrefAuthors = response.data?.message?.author || [];
          console.log(
            `Found ${crossrefAuthors.length} authors in Crossref for DOI ${effectiveDoi}`
          );
        } catch (err) {
          if (err.response && err.response.status === 404)
            console.log(`Crossref returned 404 for DOI ${effectiveDoi}.`);
          else
            console.warn(
              `Failed to fetch/parse Crossref for DOI ${effectiveDoi}: ${err.message}`
            );
        }
      } else {
        console.log(
          `No DOI found for paper ${arxivIdBase}, skipping Crossref.`
        );
      }

      // Loop through authors from the original string
      for (let i = 0; i < original_authors_list.length; i++) {
        const original_name_string = sanitizeValue(original_authors_list[i]);
        const author_order = i + 1;
        if (!original_name_string) continue;

        console.log(
          ` -> Processing Author ${author_order}/${original_authors_list.length}: "${original_name_string}"`
        );

        let resolvedAuthorData = null;
        let crossrefOrcidMatch = null;

        // Try matching with Crossref authors first if available
        if (crossrefAuthors.length > 0) {
          const normalizedOriginalName = original_name_string.toLowerCase();
          const nameParts = original_name_string.split(/\s+/);
          const originalFamilyName = nameParts.pop() || "";
          const originalGivenInitial = nameParts[0]
            ? nameParts[0].charAt(0).toLowerCase()
            : "";

          const crossrefMatch = crossrefAuthors.find((ca) => {
            const cf = (ca.family || "").toLowerCase();
            const cg = (ca.given || "").toLowerCase();
            const cfn = `${cg} ${cf}`.trim();
            if (ca.ORCID && cf === originalFamilyName.toLowerCase())
              return true;
            return (
              cfn === normalizedOriginalName ||
              (cf === originalFamilyName.toLowerCase() &&
                cg.startsWith(originalGivenInitial))
            );
          });

          if (crossrefMatch?.ORCID) {
            const orcidUrl = crossrefMatch.ORCID;
            const orcidIdMatch = orcidUrl.match(
              /(\d{4}-\d{4}-\d{4}-\d{3}[0-9X])$/
            );
            if (orcidIdMatch) {
              crossrefOrcidMatch = orcidIdMatch[1];
              console.log(
                `      Found potential ORCID ${crossrefOrcidMatch} via Crossref match.`
              );
            }
          }
        }

        // Resolve author: Use Crossref ORCID if found, otherwise search (stricter search + high-confidence check now)
        if (crossrefOrcidMatch) {
          resolvedAuthorData = await resolveAuthor(
            original_name_string,
            crossrefOrcidMatch,
            "FROM_CROSSREF",
            arxivIdBase, // Pass base ID for consistency
            effectiveDoi // Pass effective DOI
          );
        } else {
          resolvedAuthorData = await resolveAuthor(
            original_name_string,
            null,
            "SEARCH_ORCID",
            arxivIdBase, // Pass base ID for consistency
            effectiveDoi // Pass effective DOI
          );
        }

        // Link author if resolved successfully
        if (resolvedAuthorData?.author_id) {
          const { error: linkError } = await supabase
            .from("paperAuthors")
            .insert({
              paper_id: paper_id, // Use the UUID paper_id
              author_id: resolvedAuthorData.author_id,
              author_order: author_order,
              original_name_string: original_name_string, // Store original unsanitized? Or sanitized? Using original from list here.
              verification_status: resolvedAuthorData.verification_status,
            });
          if (linkError) {
            if (linkError.code === "23505")
              console.warn(
                `      Attempted to link duplicate author ${resolvedAuthorData.author_id} to paper ${paper_id}. Skipping.`
              );
            else
              console.error(
                `      DB error linking author ${resolvedAuthorData.author_id} to paper ${paper_id}:`,
                linkError
              );
          } else
            console.log(
              `      Linked author ${resolvedAuthorData.author_id} to paper ${paper_id} with status ${resolvedAuthorData.verification_status}`
            );
          // Enrichment is now handled *inside* resolveAuthor
        } else {
          console.error(
            `      Could not resolve/create author record for "${original_name_string}" on paper ${arxivIdBase}`
          );
        }

        // Add delay between processing authors for rate limiting
        await delay(DELAY_BETWEEN_AUTHORS_MS);
      } // End author loop
    } // End else block for authors processing
  } catch (error) {
    console.error(
      `Top-level error processing paper item "${title || paperUrl}":`,
      error
    );
    // Do not attempt to store HTML if there was a top-level error before insertion
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
      const itemCategories = item.categories || [category]; // Use categories from item if available
      // checkAndInsertPaperIfNew now handles the HTML fetch delay internally
      await checkAndInsertPaperIfNew(item, itemCategories, feedPubDate);
      processedCount++;
      // Removed delay here as it's now handled before HTML fetch within checkAndInsertPaperIfNew
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

/** Refreshes the materialized view */
async function refreshMaterializedView() {
  console.log(
    "Attempting to refresh materialized view 'unique_authors_data_view'..."
  );
  try {
    // Ensure execute_sql function exists in Supabase (used for REFRESH)
    // Use 'sql' parameter based on previous error hints
    const { error: rpcError } = await supabase.rpc("execute_sql", {
      sql: "REFRESH MATERIALIZED VIEW CONCURRENTLY public.unique_authors_data_view;",
    });
    if (rpcError) {
      console.error(
        "Error refreshing materialized view via RPC (concurrently):",
        rpcError
      );
      console.log("Attempting non-concurrent refresh as fallback...");
      const { error: fallbackRpcError } = await supabase.rpc("execute_sql", {
        sql: "REFRESH MATERIALIZED VIEW public.unique_authors_data_view;",
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
    } else {
      console.log(
        "Materialized view refreshed successfully via RPC (concurrently)."
      );
    }
  } catch (error) {
    console.error("Error calling RPC to refresh materialized view:", error);
  }
}

async function fetchNewPapers() {
  console.log("Starting master fetch process from arXiv RSS...");
  try {
    for (const category of categories) {
      await fetchPapersFromRSS(category);
    }
    await refreshMaterializedView(); // Refresh view after processing all categories
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
