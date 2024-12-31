# README: Scheduling & Realtime Listeners

This project includes multiple Node.js scripts that run at specific times (via cron or custom scheduling) and some scripts that listen continuously for Supabase Realtime events. Below is an overview of **what each script does**, **where it's located**, and **how to manage** them on your DigitalOcean droplet with PM2.

---

## Table of Contents

1. [Scheduled Scripts](#scheduled-scripts)  
   1.1 [\_scheduler.js (Daily at 6:05 AM UTC)](#1.1-_schedulerjs-daily-at-605-am-utc)  
   1.2 [\_schedulerDigests.js (Daily + Weekly Digests at 13:45 UTC)](#1.2-_schedulerdigestsjs-daily--weekly-digests-at-1345-utc)  
   1.3 [\_schedulerRandomHourly.js (Random Hourly Shitpost)](#1.3-_schedulerrandomhourlyjs-random-hourly-shitpost)

2. [Supabase Realtime Listener Scripts](#supabase-realtime-listener-scripts)  
   2.1 [delinquency-notifications.js](#21-delinquency-notificationsjs)  
   2.2 [subscription-cancellation.js](#22-subscription-cancellationjs)  
   2.3 [trial-cancellation.js](#23-trial-cancellationjs)

3. [Managing Everything with PM2](#managing-everything-with-pm2)  
   3.1 [Install & Setup](#31-install--setup)  
   3.2 [Starting Scheduled Scripts](#32-starting-scheduled-scripts)  
   3.3 [Starting Realtime Listeners](#33-starting-realtime-listeners)  
   3.4 [Logs & Status](#34-logs--status)  
   3.5 [Auto-Restart on Reboot](#35-auto-restart-on-reboot)

4. [FAQ](#faq)

---

## Scheduled Scripts

In the root directory, you have **three** main scheduler files that use [`node-cron`](https://www.npmjs.com/package/node-cron) or custom logic.

### 1.1 `_scheduler.js` (Daily at 6:05 AM UTC)

- **File**: `/_scheduler.js`
- **What It Does**:

  - Schedules a big batch of scripts to run **once per day at 6:05 AM UTC**.
  - Runs many tasks under `api/replicate/` (like `update-runs.js`, `update-github-score.js`, `fetch-new-models.js`, `generate-tags.js`, `create-embeddings.js`, `generate-summary.js`).
  - Runs tasks under `api/arxiv/` (like `fetch-new-papers.js`, `update-hn-score.js`, `update-reddit-score.js`, `update-twitter-score.js`, `publish-to-devto.js`, `publish-to-hashnode.js`, `choose-paper-tasks.js`), plus some extras under `api/twitter/`, `api/huggingFace/`, `api/loops/`, `api/site/`, etc.
  - Ends with revalidation scripts for `arxiv` and `replicate`.

- **Key Implementation Details**:
  1. Uses `node-cron` with `cron.schedule("05 06 * * *", ...)`.
  2. Sets a flag `isScriptRunning` to avoid overlap.
  3. Spawns each sub-script in sequence using `child_process.spawn(...)`.

### 1.2 `_schedulerDigests.js` (Daily + Weekly Digests at 13:45 UTC)

- **File**: `/_schedulerDigests.js`
- **What It Does**:

  - Runs **daily** and **weekly** email digests.
  - Fires once a day at **13:45 UTC** (which is 8:45 AM ET in standard time).
  - First calls `resend/send-daily-digest.js` (for daily subscribers).
  - Then calls `resend/send-weekly-digest.js` (for weekly subscribers).

- **Key Implementation Details**:
  1. `cron.schedule("45 13 * * *", ...)` triggers daily.
  2. The daily script checks who needs a daily email.
  3. The weekly script checks who hasn’t received a weekly email in 7 days.
  4. Also uses an `isRunning` flag to prevent overlap.

### 1.3 `_schedulerRandomHourly.js` (Random Hourly Shitpost)

- **File**: `/_schedulerRandomHourly.js`
- **What It Does**:

  - Schedules a “paper shitpost” tweet at a **random minute** each hour.
  - The code calculates the next run time by picking a random minute (0–59).
  - Calls `api/twitter/publish-paper-shitpost.js`.

- **Key Implementation Details**:
  1. Not a standard cron expression; it uses `setTimeout` logic to schedule the next run.
  2. If it’s already running, it waits.
  3. On completion, it schedules the next run again.

---

## Supabase Realtime Listener Scripts

These scripts **listen** for changes in your `subscriptions` table so they must run **continuously** under PM2. They’re located in:

api/realtime/
├─ delinquency-notifications.js
├─ subscription-cancellation.js
└─ trial-cancellation.js

### 2.1 `delinquency-notifications.js`

- Listens for updates where a subscription transitions to `past_due` with `cancel_at_period_end = false`.
- Sends an email telling the user their card charge failed and they need to update billing.
- Uses Supabase Realtime with `.on("postgres_changes", { event: "UPDATE", ... })`.

### 2.2 `subscription-cancellation.js`

- Listens for “active → canceled” scenarios (where `status = 'active'` and `cancel_at_period_end` flips to true).
- Emails the user to see why they canceled.
- Also uses Realtime logic.

### 2.3 `trial-cancellation.js`

- Similar approach for `status = 'trialing'` and `cancel_at_period_end` flips to true.
- Sends a different email asking about their trial experience.

**Note**: All three remain running constantly so they can react to DB updates in real time.

---

## Managing Everything with PM2

### 3.1 Install & Setup

On your DigitalOcean droplet:

```bash
# 1) Pull code
cd /path/to/your/project
git pull origin main

# 2) Install dependencies
npm install

# 3) Install PM2 globally if not already
npm install -g pm2
```

### 3.2 Starting Scheduled Scripts

If your scheduling scripts (\_scheduler.js, \_schedulerDigests.js, \_schedulerRandomHourly.js) each contain node-cron or custom timers, you need them continuously running. Start them with PM2:

pm2 start \_scheduler.js --name daily-tasks
pm2 start \_schedulerDigests.js --name digest-tasks
pm2 start \_schedulerRandomHourly.js --name random-hourly

- daily-tasks: runs at 6:05 AM UTC.
- digest-tasks: runs daily at 13:45 UTC, calling daily + weekly digests.
- random-hourly: random minute each hour for paper shitposts.

### 3.3 Starting Realtime Listeners

Under api/realtime/, you have three scripts:

```
pm2 start api/realtime/delinquency-notifications.js --name delinquency
pm2 start api/realtime/subscription-cancellation.js --name subscription-cancel
pm2 start api/realtime/trial-cancellation.js --name trial-cancel
```

These must never exit so they can catch updates from Supabase in real time.

### 3.4 Logs & Status

Check status:

```
pm2 status
```

Check logs (combined):

```
pm2 logs
```

Check logs (specific script):

```
pm2 logs subscription-cancel
```

Stop or restart:

```
pm2 stop daily-tasks
pm2 restart daily-tasks
```

### 3.5 Auto-Restart on Reboot

Once everything is running and verified:

```
pm2 startup
pm2 save
```

This ensures PM2 restarts all your scripts automatically if the droplet reboots. I think.

## FAQ

1. **What if I want to run daily tasks via system cron instead?**

   - You can, but if your scripts have `node-cron` inside, they’re meant to run continuously under PM2. If you prefer a single-run approach, you’d refactor the script so it does everything at launch, then exits. Otherwise, a “cron in code + system cron outside” can cause confusion.

2. **How do I handle DST for the digests (8:45 AM ET)?**

   - Right now, `_schedulerDigests.js` is set to `13:45 UTC`—that corresponds to 8:45 AM ET in standard time, but 9:45 AM ET in daylight time. If you want exact 8:45 AM ET all year, you must either change it manually twice a year or run the script in an environment with its timezone set to ET.

3. **Why do the Realtime scripts never exit?**

   - They listen to Supabase DB changes. If they exited, you’d miss events. So they must run constantly, which is why we keep them under PM2.

4. **What’s the ‘random hourly’ approach?**

   - `_schedulerRandomHourly.js` picks a random minute each hour to post a “paper shitpost.” It uses a custom `setTimeout` approach instead of a static cron expression.

5. **How do I debug if something’s not firing?**
   - Check PM2 logs: `pm2 logs <script-name>`. Look for errors or “Condition not met” logs. Also ensure the right columns/tables are included in Supabase Realtime.

---

**That’s It!**

- **`_scheduler.js`** runs a big daily batch at 6:05 AM UTC.
- **`_schedulerDigests.js`** runs daily/weekly email scripts at 13:45 UTC.
- **`_schedulerRandomHourly.js`** handles random-hour tweet logic.
- Three **Realtime** scripts in `api/realtime/` handle delinquency notifications, subscription cancellations, and trial cancellations.

All remain running under **PM2** or system cron, depending on your setup. Check `pm2 logs` for troubleshooting. Good luck!
