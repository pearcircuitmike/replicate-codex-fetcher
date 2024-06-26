import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegStatic from "ffmpeg-static";
import path from "path";
import getMP3Duration from "get-mp3-duration";
import puppeteer from "puppeteer";

const execFileAsync = promisify(execFile);

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

async function getPapers() {
  console.log("Fetching papers from Supabase...");
  const { data, error } = await supabase
    .from("arxivPapersData")
    .select("title, generatedSummary, abstract, slug")
    .order("totalScore", { ascending: false })
    .limit(1);

  if (error) throw error;
  console.log(`Fetched ${data.length} papers from Supabase.`);
  return data;
}

async function generateNarratorScript(paper) {
  console.log("Generating narrator script...");
  const message = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `<Instructions>Write a verbatim script for a narrator of a YouTube video to read. The script should cover a summary of the following abstract for a technical audience. Be matter-of-fact and clear, in the style of an NPR or Vox video script. Do not include any introductions or conclusions mentioning that this is a script or video. Divide the script into short sentences or phrases, each on a new line.
You should never restate your prompt, just give the narration in your response. Your summary should be tight and very short and crisp.</Instructions>
<PaperTitle>${paper.title}</PaperTitle>
<Abstract>${paper.abstract}</Abstract>
<GeneratedSummary>${paper.generatedSummary}</GeneratedSummary>
Transcript to be read:
`,
      },
    ],
  });

  console.log("Narrator script generated successfully.");
  return message.content[0].text;
}

async function generateAudio(script) {
  console.log("Generating audio...");
  const voice_id = "raMcNf2S8wCmuaBcyI6E";
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: script,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  };

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`,
      options
    );

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(
        `ElevenLabs API error: ${response.status} ${response.statusText} - ${errorData}`
      );
    }

    const audioBuffer = await response.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      throw new Error("Received empty audio buffer from ElevenLabs API");
    }

    const audioFilePath = path.join(process.cwd(), "narration.mp3");
    await fs.writeFile(audioFilePath, Buffer.from(audioBuffer));
    console.log("Audio file created successfully");

    const stats = await fs.stat(audioFilePath);
    if (stats.size === 0) {
      throw new Error("Created audio file is empty");
    }
    console.log(`Audio file size: ${stats.size} bytes`);

    return audioFilePath;
  } catch (error) {
    console.error("Error generating audio:", error.message);
    throw error;
  }
}

async function captureWebPageScreenshot(slug) {
  console.log(`Capturing screenshot for slug: ${slug}`);
  const url = `https://aimodels.fyi/papers/arxiv/${slug}`;
  console.log(`Navigating to URL: ${url}`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 608, height: 1080, isMobile: true });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    console.log("Page loaded successfully");
    await autoScroll(page);

    const screenshotPath = path.join(process.cwd(), "webpage_screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    const pageHeight = await page.evaluate(() => document.body.scrollHeight);

    const stats = await fs.stat(screenshotPath);
    console.log(`Screenshot file size: ${stats.size} bytes`);

    return { screenshotPath, pageHeight };
  } catch (error) {
    console.error("Error capturing screenshot:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

async function createScrollingVideo(screenshotPath, pageHeight, audioDuration) {
  console.log("Creating scrolling video...");
  const scrollingVideoPath = path.join(process.cwd(), "scrolling_video.mp4");
  const frameRate = 30;

  const args = [
    "-loop",
    "1",
    "-i",
    screenshotPath,
    "-filter_complex",
    `[0:v]scale=608:${pageHeight}:force_original_aspect_ratio=decrease,pad=608:${pageHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,crop=608:1080:0:'if(gte(t,${audioDuration}),${pageHeight}-1080,t/${audioDuration}*(${pageHeight}-1080))'`,
    "-t",
    audioDuration.toString(),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    frameRate.toString(),
    scrollingVideoPath,
  ];

  console.log(
    "Executing FFmpeg command for scrolling video:",
    ffmpegStatic,
    args.join(" ")
  );
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegStatic, args);
    console.log("FFmpeg stdout:", stdout);
    console.log("FFmpeg stderr:", stderr);

    const stats = await fs.stat(scrollingVideoPath);
    console.log(
      `Scrolling video created successfully. File size: ${stats.size} bytes`
    );
  } catch (error) {
    console.error("Error creating scrolling video:", error.message);
    console.error("FFmpeg stderr:", error.stderr);
    throw error;
  }

  return scrollingVideoPath;
}

async function combineVideoAndAudio(videoPath, audioPath, outputPath) {
  console.log("Combining video and audio...");
  const args = [
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    outputPath,
  ];

  console.log(
    "Executing FFmpeg command for combining video and audio:",
    ffmpegStatic,
    args.join(" ")
  );
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegStatic, args);
    console.log("FFmpeg stdout:", stdout);
    console.log("FFmpeg stderr:", stderr);

    const stats = await fs.stat(outputPath);
    console.log(
      `Combined video created successfully. File size: ${stats.size} bytes`
    );
  } catch (error) {
    console.error("Error combining video and audio:", error.message);
    console.error("FFmpeg stderr:", error.stderr);
    throw error;
  }
}

async function detectSpeechSegments(audioPath) {
  console.log("Detecting speech segments...");
  const outputPath = path.join(process.cwd(), "speech_segments.txt");
  const args = [
    "-i",
    audioPath,
    "-af",
    "silencedetect=noise=-30dB:d=0.5",
    "-f",
    "null",
    "-",
  ];

  try {
    const { stderr } = await execFileAsync(ffmpegStatic, args);
    const segments = parseSilenceDetectOutput(stderr);
    await fs.writeFile(outputPath, JSON.stringify(segments, null, 2));
    console.log("Speech segments detected and saved.");
    return segments;
  } catch (error) {
    console.error("Error detecting speech segments:", error);
    throw error;
  }
}

function parseSilenceDetectOutput(output) {
  const lines = output.split("\n");
  const segments = [];
  let start = 0;

  for (const line of lines) {
    if (line.includes("silence_end")) {
      const endTime = parseFloat(line.split("silence_end: ")[1].split(" ")[0]);
      segments.push({ start, end: endTime });
      start = endTime;
    }
  }

  // Add a final segment if there's remaining audio
  if (start > 0) {
    segments.push({ start, end: Infinity });
  }

  return segments;
}

async function generateSRTContent(script, speechSegments, audioDuration) {
  console.log("Generating SRT content...");
  const lines = script.split("\n").filter((line) => line.trim() !== "");
  let srtContent = "";

  let segmentIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    let start, end;

    if (segmentIndex < speechSegments.length) {
      start = speechSegments[segmentIndex].start;
      end = speechSegments[segmentIndex].end;
      segmentIndex++;
    } else {
      // If we've run out of detected segments, estimate timings
      const averageSegmentDuration =
        speechSegments.reduce(
          (sum, segment) => sum + (segment.end - segment.start),
          0
        ) / speechSegments.length;
      start =
        i > 0
          ? parseFloat(
              srtContent
                .split("\n")
                .slice(-3)[0]
                .split(" --> ")[1]
                .replace(",", ".")
            )
          : 0;
      end = Math.min(start + averageSegmentDuration, audioDuration);
    }

    srtContent += `${i + 1}\n`;
    srtContent += `${formatSRTTime(start)} --> ${formatSRTTime(end)}\n`;
    srtContent += `${lines[i]}\n\n`;
  }

  console.log("SRT content generated successfully");
  return srtContent;
}

function formatSRTTime(seconds) {
  const date = new Date(seconds * 1000);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const secs = date.getUTCSeconds().toString().padStart(2, "0");
  const ms = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${secs},${ms}`;
}

async function addSubtitlesToVideo(
  inputVideoPath,
  subtitlesPath,
  outputVideoPath
) {
  console.log("Adding subtitles to video...");
  const args = [
    "-i",
    inputVideoPath,
    "-vf",
    `subtitles=${subtitlesPath}:force_style='Fontname=Arial,FontSize=24,PrimaryColour=&H00FF00,BackColour=&H000000,BorderStyle=3,Outline=0,Shadow=0'`,
    "-c:a",
    "copy",
    outputVideoPath,
  ];

  console.log(
    "Executing FFmpeg command for adding subtitles:",
    ffmpegStatic,
    args.join(" ")
  );
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegStatic, args);
    console.log("FFmpeg stdout:", stdout);
    console.log("FFmpeg stderr:", stderr);

    const stats = await fs.stat(outputVideoPath);
    console.log(
      `Video with subtitles created successfully. File size: ${stats.size} bytes`
    );
  } catch (error) {
    console.error("Error adding subtitles to video:", error.message);
    console.error("FFmpeg stderr:", error.stderr);
    throw error;
  }
}

async function main() {
  try {
    console.log("Starting video generation process...");
    const papers = await getPapers();
    if (papers.length === 0) {
      console.log("No papers found");
      return;
    }
    const paper = papers[0];
    console.log(`Processing paper: ${paper.title}`);

    const script = await generateNarratorScript(paper);
    const audioPath = await generateAudio(script);

    const { screenshotPath, pageHeight } = await captureWebPageScreenshot(
      paper.slug
    );

    const audioBuffer = await fs.readFile(audioPath);
    const audioDuration = getMP3Duration(audioBuffer) / 1000; // Convert to seconds

    const scrollingVideoPath = await createScrollingVideo(
      screenshotPath,
      pageHeight,
      audioDuration
    );

    const combinedVideoPath = path.join(process.cwd(), "combined_video.mp4");
    await combineVideoAndAudio(
      scrollingVideoPath,
      audioPath,
      combinedVideoPath
    );

    const speechSegments = await detectSpeechSegments(audioPath);
    const srtContent = await generateSRTContent(
      script,
      speechSegments,
      audioDuration
    );
    const srtPath = path.join(process.cwd(), "subtitles.srt");
    await fs.writeFile(srtPath, srtContent);

    const finalVideoPath = path.join(process.cwd(), "final_video.mp4");
    await addSubtitlesToVideo(combinedVideoPath, srtPath, finalVideoPath);

    console.log("Video generation process completed successfully!");
    console.log(`Final video saved at: ${finalVideoPath}`);
  } catch (error) {
    console.error("Error in main process:", error.stack);
  }
}

main();
