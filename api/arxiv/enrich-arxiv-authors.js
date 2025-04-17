// enrich-arxiv-authors.js (Backfill Logic)
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import axios from "axios";
import { parseStringPromise as xmlParse } from "xml2js"; // Added for arXiv API XML parsing

// --- Basic Setup ---
console.log("Script starting: enrich-arxiv-authors.js (Backfill Logic)");
dotenv.config();
console.log("Environment loaded");
console.log(`NODE_ENV set to: ${process.env.NODE_ENV}`);

// --- Environment Variable Checks ---
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

// --- Supabase Client ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized");

// --- ORCID API Configuration ---
const ORCID_API_URL = "https://pub.orcid.org/v3.0";
const ORCID_TOKEN_URL = "https://orcid.org/oauth/token";
const ORCID_WORKS_PAGE_SIZE = 100;
const MAX_WORKS_PAGES_TO_CHECK = 10; // Safety limit for pagination

// --- arXiv API Configuration ---
const ARXIV_API_URL = "http://export.arxiv.org/api/query";

// --- Script Configuration ---
const BATCH_SIZE = 25; // How many papers to process per batch (adjust based on performance/rate limits)
const DELAY_BETWEEN_AUTHORS_MS = 1100; // Increased delay for rate limiting (1.1 seconds)
const DELAY_WITHIN_WORKS_CHECK_MS = 150; // Added delay within works check loop
const DELAY_BETWEEN_BATCHES_MS = 3000; // Delay between paper batches
const TARGET_SCHEMA = "public"; // Define the schema name

// --- Helper Functions ---

function sanitizeValue(value) {
  if (typeof value === "string") {
    // Remove control characters, backslashes, double quotes, trim whitespace
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x1F\x7F-\x9F\\]|"/g, "").trim();
  }
  return value; // Return non-strings as is
}

function normalizeArxivId(id) {
  if (!id) return null;
  return id
    .toLowerCase()
    .replace(/^arxiv:/, "")
    .replace(/v\d+$/, "")
    .trim();
}

// Simple delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- ORCID API Interaction ---
// Includes: getOrcidApiToken, searchOrcidByName, checkOrcidWorksForPaper, triggerOrcidEnrichment

let orcidTokenCache = { token: null, expiry: null };

async function getOrcidApiToken() {
  const now = Date.now();
  if (
    orcidTokenCache.token &&
    orcidTokenCache.expiry &&
    orcidTokenCache.expiry > now
  ) {
    return orcidTokenCache.token;
  }
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

async function checkOrcidWorksForPaper(orcidId, arxivId, doi, token) {
  if (!orcidId || !token || (!arxivId && !doi)) return false;
  // Use the correctly quoted column name if needed for logging, but normalizeArxivId handles the value itself
  const normalizedTargetArxivId = normalizeArxivId(arxivId);
  console.log(
    `         Checking ORCID works for ${orcidId} for paper arXiv:${normalizedTargetArxivId} / DOI:${doi}`
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
    // console.log(`            Checking works page: ${worksUrl}`); // Verbose logging
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
        // console.log(`            Total works reported for ${orcidId}: ${totalWorks}`); // Verbose
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
                `         [+] Paper found on ORCID profile ${orcidId} via DOI match (Page ${
                  pagesChecked + 1
                }).`
              );
              return true;
            }
            if (normalizedTargetArxivId && idType === "arxiv") {
              const normalizedWorkArxivId = normalizeArxivId(idValue);
              if (normalizedWorkArxivId === normalizedTargetArxivId) {
                console.log(
                  `         [+] Paper found on ORCID profile ${orcidId} via arXiv ID match (Page ${
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
        (totalWorks > 0 && offset >= totalWorks) ||
        groupsOnPage < ORCID_WORKS_PAGE_SIZE
      ) {
        //   console.log(`            Stopping works check: Pages checked=${pagesChecked}, Processed approx=${offset}/${totalWorks || 'unknown'}, Last page size=${groupsOnPage}`); // Verbose
        break;
      }
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(
          `         ORCID works endpoint returned 404 for ${orcidId}.`
        );
        return false;
      } else {
        console.error(
          `         Error fetching/checking ORCID works page (offset ${offset}) for ${orcidId}: ${error.message}`,
          error.response?.status ? `Status: ${error.response.status}` : ""
        );
      }
      return false; // Stop checking if an error occurs
    }
  } while (groupsOnPage === ORCID_WORKS_PAGE_SIZE); // Continue only if the last page was full
  console.log(
    `         Paper (arXiv:${normalizedTargetArxivId} / DOI:${doi}) not found after checking ${pagesChecked} page(s) of works for ORCID ${orcidId}.`
  );
  return false;
}

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
    let updateData = {
      last_orcid_sync: new Date().toISOString(),
      orcid_id: orcidId,
    };
    if (personData.name?.["family-name"]?.value) {
      updateData.canonical_name = `${
        personData.name["given-names"]?.value || ""
      } ${personData.name["family-name"].value}`.trim();
    } else if (personData.name?.["credit-name"]?.value) {
      updateData.canonical_name = personData.name["credit-name"].value;
    }
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
    let parsedUrls = [];
    if (personData["researcher-urls"]?.["researcher-url"]?.length > 0) {
      parsedUrls = personData["researcher-urls"]["researcher-url"]
        .map((item) => ({ name: item["url-name"], url: item.url?.value }))
        .filter((u) => u.url && u.name);
    }
    if (parsedUrls.length > 0) updateData.researcher_urls = parsedUrls;
    const hasRealEmails = personData.emails?.email?.length > 0;
    if (process.env.NODE_ENV === "production") {
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
      if (hasRealEmails) {
        const devEmail = "msyoung2012@gmail.com";
        console.log(
          `      Real emails found for author ${authorId}, storing hardcoded dev email (${devEmail}) instead (NODE_ENV: ${process.env.NODE_ENV})`
        );
        updateData.emails = [
          {
            email: devEmail,
            primary: true,
            verified: false,
            visibility: "PUBLIC",
          },
        ];
      } else {
        console.log(
          `      No real emails found for author ${authorId}, skipping dev email storage (NODE_ENV: ${process.env.NODE_ENV}). 'emails' field not updated.`
        );
      }
    }
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

// --- Author Resolution Logic ---
/**
 * Finds or creates an author record based on name and potential ORCID.
 * Only uses ORCID search results if they are high-confidence (1 result).
 * @param {string} original_name_string - The name string from the paper's author list.
 * @param {string|null} orcid_from_source - ORCID ID found via Crossref (if any).
 * @param {'FROM_CROSSREF'|'SEARCH_ORCID'} source_type - How the ORCID was (or wasn't) found.
 * @param {string|null} arxivId - The arXiv ID of the paper for works check.
 * @param {string|null} doi - The DOI of the paper for works check.
 * @returns {Promise<{author_id: string, verification_status: string, orcid_id: string|null}|null>}
 */
async function resolveAuthor(
  original_name_string,
  orcid_from_source,
  source_type,
  arxivId = null,
  doi = null
) {
  let authorRecord = null;
  let resolved_orcid_id = orcid_from_source; // Start with Crossref ORCID if provided
  let verification_status = "UNVERIFIED";
  let author_id = null;

  if (!original_name_string) {
    console.error("      Attempted to resolve author with empty name string.");
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
    `      Resolving author: "${sanitized_name}" (Source Type: ${source_type}, Crossref ORCID: ${
      orcid_from_source || "N/A"
    })`
  );

  try {
    // --- Stage 1: Check provided ORCID (if from Crossref) ---
    if (resolved_orcid_id && source_type === "FROM_CROSSREF") {
      verification_status = "FROM_CROSSREF"; // Assume valid if from Crossref initially
      // Check if an author with this ORCID already exists
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
          `         Found existing author ${author_id} via Crossref ORCID ${resolved_orcid_id}. Status: ${verification_status}`
        );
      } else {
        // Create new author record with Crossref ORCID
        console.log(
          `         Inserting new author with Crossref ORCID ${resolved_orcid_id} for name "${sanitized_name}"...`
        );
        const { data: insertedAuthor, error: insertError } = await supabase
          .from("authors")
          .insert({
            orcid_id: resolved_orcid_id,
            canonical_name: sanitized_name,
          })
          .select("id")
          .single();
        if (insertError) {
          // Removed race condition handling based on user feedback
          throw new Error(
            `DB error inserting new author for ORCID ${resolved_orcid_id}: ${insertError.message}`
          );
        } else {
          author_id = insertedAuthor.id;
          console.log(
            `         Inserted new author ${author_id}. Status: ${verification_status}`
          );
        }
      }
    }
    // --- Stage 2: Search ORCID by name (if no Crossref ORCID) ---
    else if (source_type === "SEARCH_ORCID") {
      const orcidToken = await getOrcidApiToken();
      let orcidSearchResult = null;
      if (orcidToken) {
        orcidSearchResult = await searchOrcidByName(sanitized_name, orcidToken); // Uses stricter search now
      }

      // --- MODIFIED: Check confidence before proceeding ---
      if (orcidSearchResult?.orcid && orcidSearchResult.isHighConfidence) {
        // --- HIGH CONFIDENCE - Proceed with ORCID ---
        console.log(
          `         ORCID Search found high-confidence match: ${orcidSearchResult.orcid} for "${sanitized_name}"`
        );
        const potential_orcid = orcidSearchResult.orcid;

        // Check if this ORCID is already assigned to ANY author
        const { data: existingAuthorWithOrcid, error: checkError } =
          await supabase
            .from("authors")
            .select("id, canonical_name") // Select id and name for logging
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
          // Enrichment will be triggered later if orcid_id is set
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
          if (insertError) {
            // Removed race condition handling based on user feedback
            throw new Error(
              `DB error inserting new author for searched ORCID ${resolved_orcid_id}: ${insertError.message}`
            );
          } else {
            author_id = insertedAuthor.id;
            console.log(`         Inserted new author ${author_id}.`);
            // Enrichment will be triggered later if orcid_id is set
          }
        } // End if/else existingAuthorWithOrcid (High Confidence)
      } else if (
        orcidSearchResult?.orcid &&
        !orcidSearchResult.isHighConfidence
      ) {
        // Low confidence result - log and skip ORCID association
        console.log(
          `         ORCID Search found match ${orcidSearchResult.orcid} but confidence is low (multiple results). Skipping ORCID association.`
        );
        resolved_orcid_id = null; // Ensure no ORCID is associated with this author for now
        // author_id remains null, flow will fall through to Stage 3
      } else {
        // No search results
        console.log(
          `         No ORCID found via search for "${sanitized_name}".`
        );
        resolved_orcid_id = null;
        // author_id remains null, will proceed to placeholder check
      }

      // --- Stage 3: No ORCID found OR low confidence search ---
      // This block is reached if:
      // - source_type was 'SEARCH_ORCID' and no result was found
      // - source_type was 'SEARCH_ORCID' and result had low confidence (author_id was not set above)
      if (!author_id) {
        // No ORCID found by any means OR low confidence. Find or create a placeholder author (orcid_id IS NULL).
        console.log(
          `         No high-confidence ORCID found for "${sanitized_name}". Checking/creating placeholder author...`
        );
        resolved_orcid_id = null; // Ensure no ORCID is associated
        verification_status = "UNVERIFIED";

        // Look for an existing placeholder with the same name
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
          // Create a new placeholder author
          console.log(
            `         Creating NEW placeholder author record for "${sanitized_name}"...`
          );
          const { data: insertedPlaceholder, error: insertError } =
            await supabase
              .from("authors")
              .insert({ orcid_id: null, canonical_name: sanitized_name })
              .select("id")
              .single();
          if (insertError) {
            // Cannot be a unique constraint violation on ORCID here (it's null)
            // Could potentially be a duplicate canonical_name if a constraint existed there (doesn't seem to)
            throw new Error(
              `DB error inserting placeholder author for name "${sanitized_name}": ${insertError.message}`
            );
          }
          author_id = insertedPlaceholder.id;
          console.log(
            `         Created new placeholder author ${author_id}. Status: ${verification_status}`
          );
        }
      }
    } else {
      // Should not happen with current logic, but handle defensively
      console.error(
        `      Invalid source_type "${source_type}" in resolveAuthor for "${sanitized_name}"`
      );
      return null;
    }

    // Final check for author_id
    if (!author_id) {
      console.error(
        `      Failed to resolve or create any author record for "${sanitized_name}"`
      );
      return null;
    }

    // Return the resolved author ID, final status, and the ORCID (if any)
    // This ORCID ID is used by the caller to decide whether to trigger enrichment
    return {
      author_id: author_id,
      verification_status: verification_status,
      orcid_id: resolved_orcid_id, // Will be null if placeholder or low-confidence search
    };
  } catch (error) {
    console.error(
      `      Error in resolveAuthor for "${original_name_string}": ${error.message}`
    );
    return null; // Indicate failure
  }
}

// --- Linking and Processing Logic ---

/**
 * Creates a link between a paper and an author in the paperAuthors table.
 * Handles potential duplicate entries gracefully by checking error code.
 * @param {string} paper_id - UUID of the paper.
 * @param {string} author_id - UUID of the author.
 * @param {number} author_order - Order of the author in the paper's list.
 * @param {string} original_name_string - The original name string from the paper.
 * @param {string} verification_status - The status determined by resolveAuthor.
 */
async function linkAuthorToPaper(
  paper_id,
  author_id,
  author_order,
  original_name_string,
  verification_status
) {
  console.log(
    `      Attempting to link Paper ${paper_id} and Author ${author_id} (Order: ${author_order}, Status: ${verification_status})...`
  );
  const { error: linkError } = await supabase.from("paperAuthors").insert({
    paper_id: paper_id,
    author_id: author_id,
    author_order: author_order,
    original_name_string: sanitizeValue(original_name_string), // Sanitize again just in case
    verification_status: verification_status,
  });

  if (linkError) {
    // Check for unique constraint violation (error code 23505 in PostgreSQL)
    if (linkError.code === "23505") {
      // You might want to check error.message or error.details to be sure it's the expected constraint
      console.warn(
        `      Link between Paper ${paper_id} and Author ${author_id} (or order ${author_order}) already exists. Skipping insertion.`
      );
    } else {
      // Log other errors
      console.error(
        `      DB error linking author ${author_id} to paper ${paper_id}:`,
        linkError
      );
    }
  } else {
    console.log(
      `      Successfully linked Author ${author_id} to Paper ${paper_id}.`
    );
  }
}

/**
 * Fetches Crossref data for a given DOI.
 * @param {string} doi - The DOI to query.
 * @returns {Promise<object|null>} - The Crossref message object or null on error/not found.
 */
async function fetchCrossrefData(doi) {
  if (!doi) return null;
  console.log(`   Fetching Crossref for DOI: ${doi}`);
  try {
    const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(
      doi
    )}`;
    const response = await axios.get(crossrefUrl, {
      timeout: 15000, // 15 seconds timeout
      headers: { Accept: "application/json" },
      // Optional: Add Mailto for Crossref politeness policy
      // params: { mailto: 'your-email@example.com' }
    });
    // Return the 'message' part which contains work details
    return response.data?.message || null;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.log(`   Crossref returned 404 for DOI ${doi}.`);
    } else {
      console.warn(
        `   Failed to fetch/parse Crossref for DOI ${doi}: ${err.message}`
      );
    }
    return null;
  }
}

/**
 * Fetches DOI from arXiv API for a given arXiv ID.
 * @param {string} arxivId - The arXiv ID (e.g., '2504.10708').
 * @returns {Promise<string|null>} - The DOI string or null if not found/error.
 */
async function fetchDoiFromArxivApi(arxivId) {
  if (!arxivId) return null;
  const apiUrl = `${ARXIV_API_URL}?id_list=${arxivId}`;
  console.log(`   Querying arXiv API for DOI: ${apiUrl}`);
  try {
    const response = await axios.get(apiUrl, { timeout: 10000 }); // 10 sec timeout
    const xmlResult = await xmlParse(response.data, {
      explicitArray: false,
      trim: true,
      ignoreAttrs: false,
      mergeAttrs: true,
    }); // Keep attributes

    // Navigate the parsed structure safely using optional chaining
    const entry = xmlResult?.feed?.entry;
    if (!entry) {
      console.log(`   arXiv API response missing 'feed.entry' for ${arxivId}`);
      return null;
    }

    // Try finding DOI in arxiv:doi element (handles string or object with '_')
    const arxivDoiElement = entry["arxiv:doi"];
    if (arxivDoiElement) {
      const doiValue =
        typeof arxivDoiElement === "object" && arxivDoiElement._
          ? arxivDoiElement._
          : arxivDoiElement;
      if (typeof doiValue === "string" && doiValue.trim()) {
        console.log(`   Found DOI via <arxiv:doi>: ${doiValue.trim()}`);
        return doiValue.trim();
      }
    }

    // Fallback: Try finding DOI in link element
    let links = entry.link;
    if (links && !Array.isArray(links)) {
      // Handle single link case
      links = [links];
    }
    if (Array.isArray(links)) {
      const doiLink = links.find((link) => link?.title === "doi" && link?.href);
      if (doiLink) {
        // Extract DOI from href (e.g., http://dx.doi.org/...)
        const href = doiLink.href;
        const doiMatch = href.match(/doi\.org\/(.*)/i); // Case-insensitive match
        if (doiMatch && doiMatch[1]) {
          console.log(
            `   Found DOI via <link title="doi">: ${doiMatch[1].trim()}`
          );
          return doiMatch[1].trim();
        }
      }
    }

    console.log(`   DOI not found in arXiv API response for ${arxivId}`);
    return null;
  } catch (error) {
    console.error(
      `   Error fetching or parsing arXiv API for ${arxivId}: ${error.message}`
    );
    return null;
  }
}

/**
 * Processes a single paper from arxivPapersData: resolves its authors and links them.
 * Includes fetching DOI from arXiv API if missing in DB.
 * @param {object} paper - Paper record containing id, authors (array), arxivId, doi.
 */
async function processPaperAuthors(paper) {
  // Ensure paper object and ID exist before destructuring or accessing
  if (!paper || !paper.id) {
    console.warn(
      `Skipping paper due to invalid structure or missing ID:`,
      paper
    );
    return;
  }
  // Use original keys from RPC result, ensure consistency
  const paperId = paper.id;
  const authorStrings = paper.authors; // Could be null
  const arxivId = paper.arxivId; // Assuming key is arxivId from json_build_object
  const existingDoi = paper.doi; // Assuming key is doi

  console.log(
    `\n -> Processing Paper ID: ${paperId} (arXiv:${arxivId}, DB DOI:${
      existingDoi || "N/A"
    })`
  );

  let effectiveDoi = existingDoi;

  // --- New: Fetch DOI from arXiv API if missing in DB ---
  if ((!effectiveDoi || String(effectiveDoi).trim() === "") && arxivId) {
    console.log(`   DOI missing for ${arxivId}. Querying arXiv API...`);
    await delay(500); // Small delay before hitting arXiv API
    const apiDoi = await fetchDoiFromArxivApi(arxivId);
    if (apiDoi) {
      effectiveDoi = apiDoi;
      console.log(
        `   [+] Found DOI via arXiv API: ${effectiveDoi}. Updating database...`
      );
      try {
        const { error: updateError } = await supabase
          .from("arxivPapersData")
          .update({ doi: effectiveDoi })
          .eq("id", paperId);
        if (updateError) {
          console.error(
            `      DB Error updating DOI for paper ${paperId}:`,
            updateError
          );
          // Continue processing with the found DOI even if DB update fails
        } else {
          console.log(
            `      Successfully updated DOI for paper ${paperId} in database.`
          );
        }
      } catch (dbError) {
        console.error(
          `      Exception during DB DOI update for paper ${paperId}:`,
          dbError
        );
      }
    } else {
      console.log(`   DOI not found via arXiv API for ${arxivId}.`);
    }
  }
  // --- End New DOI Fetch Logic ---

  // Check authors array *after* potential DOI lookup/update
  if (!Array.isArray(authorStrings)) {
    console.warn(
      `Skipping author processing for paper ${paperId} because 'authors' field is not an array:`,
      authorStrings
    );
    return; // Stop processing this paper's authors
  }

  if (authorStrings.length === 0) {
    console.log(
      "    No authors listed in the 'authors' array for this paper. Skipping author processing."
    );
    return;
  }

  // Fetch Crossref data once if DOI exists *now*
  let crossrefData = null;
  if (effectiveDoi) {
    // Use effectiveDoi here
    crossrefData = await fetchCrossrefData(effectiveDoi);
  }
  const crossrefAuthors = crossrefData?.author || [];
  if (crossrefAuthors.length > 0) {
    console.log(
      `   Found ${crossrefAuthors.length} authors in Crossref using DOI: ${effectiveDoi}.`
    );
  }

  // Process each author string from the paper's array
  for (let i = 0; i < authorStrings.length; i++) {
    const original_name_string = authorStrings[i];
    const author_order = i + 1;

    if (
      !original_name_string ||
      typeof original_name_string !== "string" ||
      !original_name_string.trim()
    ) {
      console.warn(
        `    Skipping invalid author entry at index ${i}:`,
        original_name_string
      );
      continue;
    }
    const sanitized_original_name = sanitizeValue(original_name_string);
    if (!sanitized_original_name) {
      console.warn(
        `    Skipping author entry at index ${i} which became empty after sanitization: "${original_name_string}"`
      );
      continue;
    }

    console.log(
      `   -- Processing Author ${author_order}/${authorStrings.length}: "${sanitized_original_name}"`
    );

    let resolvedAuthorData = null;
    let crossrefOrcidMatch = null;

    // Try matching with Crossref authors first if available
    if (crossrefAuthors.length > 0) {
      const normalizedOriginalName = sanitized_original_name.toLowerCase();
      // Simple matching: check family name and optionally given name initial/full
      const nameParts = sanitized_original_name.split(/\s+/);
      const originalFamilyName = nameParts.pop() || "";
      const originalGivenInitial = nameParts[0]
        ? nameParts[0].charAt(0).toLowerCase()
        : "";

      const crossrefMatch = crossrefAuthors.find((ca) => {
        const cf = (ca.family || "").toLowerCase();
        const cg = (ca.given || "").toLowerCase();
        const cfn = `${cg} ${cf}`.trim();

        // Prioritize ORCID if present, even with looser name match
        // Check family name match first for relevance before just relying on ORCID presence
        if (ca.ORCID && cf === originalFamilyName.toLowerCase()) {
          // If family names match and ORCID exists, consider it a potential match
          return true;
        }
        // Stricter name match if no ORCID or family name didn't match
        return (
          cfn === normalizedOriginalName ||
          (cf === originalFamilyName.toLowerCase() &&
            cg.startsWith(originalGivenInitial))
        );
      });

      if (crossrefMatch?.ORCID) {
        const orcidUrl = crossrefMatch.ORCID;
        const orcidIdMatch = orcidUrl.match(/(\d{4}-\d{4}-\d{4}-\d{3}[0-9X])$/);
        if (orcidIdMatch) {
          crossrefOrcidMatch = orcidIdMatch[1];
          console.log(
            `      Found potential ORCID ${crossrefOrcidMatch} via Crossref match.`
          );
        }
      }
    }

    // Resolve author: Use Crossref ORCID if found, otherwise search (stricter search + high-confidence check now)
    // Pass effectiveDoi down to resolveAuthor
    if (crossrefOrcidMatch) {
      resolvedAuthorData = await resolveAuthor(
        sanitized_original_name,
        crossrefOrcidMatch,
        "FROM_CROSSREF",
        arxivId,
        effectiveDoi
      );
    } else {
      resolvedAuthorData = await resolveAuthor(
        sanitized_original_name,
        null,
        "SEARCH_ORCID",
        arxivId,
        effectiveDoi
      );
    }

    // Link author if resolved successfully
    if (resolvedAuthorData?.author_id) {
      await linkAuthorToPaper(
        paperId, // Use destructured paperId
        resolvedAuthorData.author_id,
        author_order,
        sanitized_original_name, // Use the sanitized name used for resolution
        resolvedAuthorData.verification_status
      );

      // --- CORRECTED ENRICHMENT TRIGGER ---
      // Trigger enrichment if an ORCID ID was successfully associated with the author record
      // by resolveAuthor (either from Crossref or high-confidence search).
      if (resolvedAuthorData.orcid_id) {
        console.log(
          `   ORCID ${resolvedAuthorData.orcid_id} associated with Author ${resolvedAuthorData.author_id}. Triggering enrichment (Status: ${resolvedAuthorData.verification_status}).`
        );
        await triggerOrcidEnrichment(
          resolvedAuthorData.author_id,
          resolvedAuthorData.orcid_id
        );
      }
      // --- END CORRECTED ENRICHMENT TRIGGER ---
    } else {
      console.error(
        `      Could not resolve/create author record for "${sanitized_original_name}" on paper ${paperId}`
      );
    }

    // Delay between processing each author for rate limiting
    await delay(DELAY_BETWEEN_AUTHORS_MS);
  } // End loop through author strings
}

/**
 * Fetches and processes a batch of papers from arxivPapersData that haven't been processed yet
 * and have a non-null authors array.
 * Uses RPC call for efficient LEFT JOIN filtering.
 * @param {number} offset - The starting offset for the query.
 * @param {number} limit - The maximum number of records to fetch.
 * @returns {Promise<Array<object>>} - An array of paper objects fetched, or empty array on error/no results.
 */
async function processPaperBatch(offset, limit) {
  console.log(
    `\n--- Processing Paper Batch: Offset ${offset}, Limit ${limit} ---`
  );

  // Use RPC to execute a query that selects papers without entries in paperAuthors
  // and ensures the authors array is not null.
  const sqlQuery = `
      SELECT json_build_object(
          'id', p.id,
          'authors', p.authors,
          'arxivId', p."arxivId", -- Use double quotes for case-sensitive column
          'doi', p.doi
      )
      FROM
          "${TARGET_SCHEMA}"."arxivPapersData" p
      LEFT JOIN
          "${TARGET_SCHEMA}"."paperAuthors" pa ON p.id = pa.paper_id
      WHERE
          pa.paper_id IS NULL -- Only select papers with NO links in paperAuthors
          AND p.authors IS NOT NULL -- Optimization: Exclude papers where authors array is NULL
      ORDER BY
          p."publishedDate" DESC -- Use double quotes for case-sensitive column. Or choose another consistent order like p.id
      LIMIT ${limit}
      OFFSET ${offset};
  `;
  console.log("Executing SQL:", sqlQuery); // Log the query for debugging

  const { data: papers, error: rpcError } = await supabase.rpc(
    "execute_sql_select", // Assumes an RPC function named 'execute_sql_select' exists
    { sql_text: sqlQuery } // Pass the SQL query string as the 'sql_text' parameter
  );

  if (rpcError) {
    console.error(
      "DB Error fetching batch of unprocessed papers via RPC:",
      rpcError
    );
    // Check if the error is because the RPC function doesn't exist
    if (
      rpcError.message.includes(
        "function public.execute_sql_select() does not exist"
      )
    ) {
      console.error(
        "ERROR: The required RPC function 'execute_sql_select' does not exist in your Supabase project."
      );
      console.error("Please create it using SQL: ");
      console.error(`
             CREATE OR REPLACE FUNCTION public.execute_sql_select(sql_text text)
             RETURNS SETOF json -- Or jsonb if preferred
             LANGUAGE plpgsql
             AS $$
             BEGIN
                 RETURN QUERY EXECUTE sql_text;
             END;
             $$;
         `);
    }
    return []; // Return empty array on error
  }

  // The RPC function returns an array of JSON objects (because we used json_build_object)
  if (!papers || papers.length === 0) {
    console.log(
      "No more unprocessed papers found (with non-null authors) in this range."
    );
    return []; // No more records to process in this range
  }

  console.log(
    `Fetched ${papers.length} unprocessed papers with non-null authors in this batch.`
  );

  // Process each paper in the batch
  // Since each element in 'papers' is now the JSON object we built, access properties directly
  for (const paper of papers) {
    try {
      // Re-validate paper object structure minimally - RPC returns JSON, check keys
      // The check for Array.isArray(paper.authors) is still useful here,
      // although the SQL query filtered out NULLs. It guards against unexpected non-array data.
      if (!paper || !paper.id /* || !Array.isArray(paper.authors) */) {
        // Relax authors check here, handled in processPaperAuthors
        console.warn(
          `Skipping paper with invalid structure or missing ID returned by RPC:`,
          paper
        );
        continue; // Skip this paper, proceed to the next one in the batch
      }
      // No need to map keys now, as json_build_object created the correct structure
      await processPaperAuthors(paper); // Pass the JSON object directly
    } catch (error) {
      // Use paper.id if available in the error context
      const paperIdForError = paper?.id || "unknown";
      console.error(`Error processing paper ${paperIdForError}:`, error);
      // Continue to the next paper even if one fails
    }
    // No delay here, delay is between authors within a paper and between batches
  }

  return papers; // Return the array of papers fetched in this batch
}

// --- Main Execution ---

/**
 * Gets the total count of papers that need processing.
 * @returns {Promise<number>} The total count, or 0 if an error occurs.
 */
async function getTotalPapersToProcessCount() {
  console.log("Fetching total count of papers to process...");
  // Corrected SQL query to return JSON
  const countSqlQuery = `
        SELECT json_build_object('total_count', COUNT(p.id))
        FROM "${TARGET_SCHEMA}"."arxivPapersData" p
        LEFT JOIN "${TARGET_SCHEMA}"."paperAuthors" pa ON p.id = pa.paper_id
        WHERE pa.paper_id IS NULL
          AND p.authors IS NOT NULL;
    `;
  console.log("Executing Count SQL:", countSqlQuery); // Log the count query for debugging
  try {
    // Use execute_sql_select as it returns JSON which is easy to parse
    const { data, error } = await supabase.rpc("execute_sql_select", {
      sql_text: countSqlQuery,
    });

    if (error) {
      console.error("DB Error fetching total paper count via RPC:", error);
      return 0; // Return 0 on error
    }

    // Expecting result like [{ "total_count": 12345 }]
    if (data && data.length > 0 && data[0].total_count !== undefined) {
      // COUNT returns bigint, which can exceed JS Number.MAX_SAFE_INTEGER
      // Use BigInt for parsing if counts can be very large, otherwise parseInt is ok for smaller counts
      let count = 0;
      try {
        // Attempt to parse as BigInt first, then fallback to Number if needed, or just use Number if counts are reasonable
        // Using Number/parseInt for simplicity assuming count fits standard JS number limits
        count = parseInt(data[0].total_count, 10);
      } catch (parseError) {
        console.error(
          "Error parsing total_count:",
          parseError,
          "Value:",
          data[0].total_count
        );
        return 0;
      }
      console.log(`Total papers to process: ${count}`);
      return isNaN(count) ? 0 : count;
    } else {
      console.error(
        "Unexpected result format when fetching total paper count:",
        data
      );
      return 0;
    }
  } catch (e) {
    console.error("Error executing count query:", e);
    return 0;
  }
}

async function runBackfillEnrichment() {
  console.log(
    "Starting backfill and enrichment process for existing papers..."
  );
  let offset = 0;
  let processedCount = 0; // Keep track of papers processed across batches

  // Check if the required RPC function exists before starting the loop (optional but good practice)
  try {
    // Check execute_sql_select
    // Updated test query to return valid JSON
    const { error: checkSelectError } = await supabase.rpc(
      "execute_sql_select",
      { sql_text: "SELECT '{}'::json;" }
    );
    if (
      checkSelectError &&
      checkSelectError.message.includes(
        "function public.execute_sql_select() does not exist"
      )
    ) {
      console.error(
        "FATAL ERROR: The required RPC function 'execute_sql_select' does not exist. Please create it before running the script."
      );
      process.exit(1);
    } else if (checkSelectError && checkSelectError.code === "42804") {
      // Catch the type mismatch early
      console.error(
        "FATAL ERROR: The RPC function 'execute_sql_select' exists but does not return SETOF json/jsonb. Please fix the function definition."
      );
      console.error("Expected: RETURNS SETOF json");
      process.exit(1);
    } else if (checkSelectError) {
      // Log other verification errors as warnings
      console.warn(
        "Warning: Could not verify 'execute_sql_select' function compatibility:",
        checkSelectError.message
      );
    }

    // Check execute_sql (assuming it's needed for REFRESH)
    const { error: checkExecError } = await supabase.rpc("execute_sql", {
      sql: "SELECT 1;",
    }); // Use 'sql' param name
    if (
      checkExecError &&
      checkExecError.message.includes(
        "function public.execute_sql(sql) does not exist"
      )
    ) {
      console.warn(
        "WARNING: The RPC function 'execute_sql(sql)' used for refreshing the view does not exist. View refresh will fail."
      );
      // Optionally exit if refresh is critical: process.exit(1);
    } else if (checkExecError) {
      console.warn(
        "Warning: Could not verify existence of 'execute_sql(sql)' function:",
        checkExecError.message
      );
    }
  } catch (e) {
    console.error("Error checking for RPC functions:", e);
    // Decide if to proceed or exit
  }

  // Get the total count before starting the loop
  const totalToProcess = await getTotalPapersToProcessCount();
  if (totalToProcess === 0) {
    console.log("No papers found needing processing.");
    // Optionally refresh view even if nothing was processed
    // await refreshMaterializedView(); // Call extracted refresh logic if desired
    return; // Exit early
  }

  // Main processing loop - Corrected Logic
  while (true) {
    // Loop indefinitely until explicitly broken
    let papersInBatch = [];
    try {
      console.log(`Attempting to fetch batch starting at offset ${offset}...`);
      papersInBatch = await processPaperBatch(offset, BATCH_SIZE); // Returns array of papers

      if (papersInBatch.length === 0) {
        // No more papers found in this offset range that meet criteria
        console.log(
          "No more papers found to process in this range. Ending loop."
        );
        break; // Exit the while loop
      }

      // Increment processed count by the number of papers actually fetched in this batch
      // Note: processPaperAuthors handles skipping *within* a paper, but we count papers fetched here.
      processedCount += papersInBatch.length;

      // Log progress
      const percentage =
        totalToProcess > 0
          ? ((processedCount / totalToProcess) * 100).toFixed(1)
          : 0;
      // Use processedCount for accurate progress numerator
      console.log(
        `--- Batch finished processing ${papersInBatch.length} papers. Progress: ${processedCount} / ${totalToProcess} (${percentage}%) papers processed. Waiting ${DELAY_BETWEEN_BATCHES_MS}ms... ---`
      );

      // Increment offset for the *next* batch query.
      // Always step by BATCH_SIZE to check the next page based on ORDER BY.
      offset += BATCH_SIZE;

      await delay(DELAY_BETWEEN_BATCHES_MS);
    } catch (error) {
      // This catch block is for errors thrown directly by processPaperBatch (e.g., RPC connection issues)
      // Errors within the paper processing loop inside processPaperBatch are caught there.
      console.error(
        `Error during paper batch processing loop (Offset: ${offset}):`,
        error
      );
      console.log(
        "Pausing for 60 seconds due to error before potentially retrying..."
      );
      await delay(60000); // Pause for a minute on major batch error
      // Consider whether to retry the same offset or skip it
      // continueProcessing = true; // Force retry (potentially infinite loop if error persists)
      console.log("Stopping after error in batch loop.");
      break; // Exit the while loop on major error
    }
  } // End while loop

  console.log("Backfill and enrichment processing loop finished.");
  await refreshMaterializedView(); // Call extracted refresh logic
}

/**
 * Refreshes the materialized view, attempting concurrent refresh first.
 */
async function refreshMaterializedView() {
  console.log(
    "Attempting to refresh materialized view 'unique_authors_data_view'..."
  );
  try {
    // Ensure execute_sql function exists in Supabase (used for REFRESH)
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

// --- Script Entry Point ---
runBackfillEnrichment()
  .then(() => {
    console.log("Script finished successfully.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      "Unhandled fatal error during backfill/enrichment process:",
      error
    );
    process.exit(1);
  });
