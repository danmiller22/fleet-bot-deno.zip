// deno-lint-ignore-file no-explicit-any
/**
 * Fleet Reports Bot — Deno Deploy + Telegram
 * One-file. KV-backed. Context keyboards on every step.
 */

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GROUP_CHAT_ID_ENV = Deno.env.get("GROUP_CHAT_ID") || "";
const CRON_KEY = Deno.env.get("CRON_KEY") || crypto.randomUUID();
const DEFAULT_REPORTED_BY = Deno.env.get("DEFAULT_REPORTED_BY") || "Dan Miller";

const kv = await Deno.openKv();

type ReportStatus = "open" | "closed" | "snoozed";
type AssetType = "Truck" | "Trailer";

interface Report {
  id: string;
  status: ReportStatus;
  asset: AssetType;
  unitNumber: string;
  pairedTruck?: string;
  repairSide: AssetType;
  problem: string;
  plan: string;
  reportedBy: string;
  reportedByUserId?: number;
  createdAt: number;
  lastUpdateAt: number;
  lastReminderAt?: number;
  snoozedUntil?: number;
  history: Array<{ at: number; by?: number; text: string; kind: "update" | "close" | "snooze" }>;
}

interface DialogState {
  step: string;
  tmp: Record<string, any>;
  reportId?: string;
}

const BUTTONS = {
  NEW: "New report",
  UPDATE: "Update report",
  CLOSE: "Close report",
  SNOOZE: "Snooze report",
};

// Keyboards
function kb(rows: (string | { text: string })[][]) {
  return { reply_markup: { keyboard: rows.map(r => r.map(x => typeof x === "string" ? ({ text: x }) : x)), resize_keyboard: true } };
}
const kbMain = kb([[BUTTONS.NEW], [BUTTONS.UPDATE, BUTTONS.CLOSE], [BUTTONS.SNOOZE]]);
const kbTT = kb([["Truck", "Trailer"]]);
const kbSnooze = kb([["2h", "4h", "1d"], ["Back to menu"]]);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return new Response("ok");

  // Setup webhook from server side
  if (req.method === "GET" && url.pathname === "/setup_webhook") {
    if (url.searchParams.get("key") !== CRON_KEY) return new Response("forbidden", { status: 403 });
    const webhook = `${url.origin}/webhook`;
    const tg = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: webhook }),
    });
    const txt = await tg.text();
    return new Response(txt, { headers: { "content-type": "application/json" } });
  }

  // Manual cron trigger
  if (req.method === "GET" && url.pathname === "/cron") {
    if (url.searchParams.get("key") !== CRON_KEY) return new Response("forbidden", { status: 403 });
    const result = await runReminders();
    return json({ ok: true, result });
  }

  // Telegram webhook
  if (req.method === "POST" && url.pathname === "/webhook") {
    const update = await req.json();
    await handleUpdate(update);
    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
});

// Cron (Deno Deploy)
addEventListener("scheduled", (event: any) => {
  event.waitUntil(runReminders());
});

async function handleUpdate(update: any) {
  if (update.message) {
    const m = update.message;
    const chatId = m.chat.id;
    const text: string = m.text || "";
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const userId = m.from?.id;
    if (!userId) return;

    if (text.startsWith("/setgroup")) {
      if (isGroup) {
        await kv.set(["groupChatId"], chatId.toString());
        await sendMessage(chatId, "Group chat linked ✅");
      }
      return;
    }

    if (isGroup) return;

    if ([BUTTONS.NEW, BUTTONS.UPDATE, BUTTONS.CLOSE, BUTTONS.SNOOZE].includes(text)) {
      await startFlow(userId, chatId, text);
      return;
    }

    const state = await getDialog(userId);
    if (state) {
      await continueFlow(userId, chatId, state, text, m);
      return;
    }

    await sendMessage(chatId, "Choose an action:", kbMain);
    return;
  } else if (update.callback_query) {
    const cq = update.callback_query;
    const data: string = cq.data || "";
    const userId = cq.from?.id;
    const chatId = cq.message?.chat?.id;
    if (!userId || !chatId) return;

    if (data.startsWith("rem:update:")) {
      const reportId = data.split(":")[2];
      await setDialog(userId, { step: "update:await_text", reportId, tmp: {} });
      await sendMessage(chatId, `Update for #${reportId}: send text`, kbMain);
    } else if (data.startsWith("rem:snooze2h:")) {
      const reportId = data.split(":")[2];
      await snoozeReport(reportId, 2 * 60 * 60 * 1000, userId);
      await sendMessage(chatId, `Snoozed #${reportId} for 2h`, kbMain);
    } else if (data.startsWith("rem:close:")) {
      const reportId = data.split(":")[2];
      await setDialog(userId, { step: "close:await_text", reportId, tmp: {} });
      await sendMessage(chatId, `Close #${reportId}: send resolution`, kbMain);
    } else if (data.startsWith("rem:skip:")) {
      const reportId = data.split(":")[2];
      const r = await getReport(reportId);
      if (r) {
        r.lastReminderAt = Date.now();
        await saveReport(r);
      }
      await answerCallback(cq.id, "Skipped");
    }
  }
}

async function startFlow(userId: number, chatId: number, action: string) {
  switch (action) {
    case BUTTONS.NEW:
      await setDialog(userId, { step: "new:asset", tmp: { reportedBy: DEFAULT_REPORTED_BY } });
      await sendMessage(chatId, "Asset?", kbTT);
      break;
    case BUTTONS.UPDATE:
      await setDialog(userId, { step: "update:report_id", tmp: {} });
      await sendMessage(chatId, "Enter report id (e.g., R-20251016-001)", kbMain);
      break;
    case BUTTONS.CLOSE:
      await setDialog(userId, { step: "close:report_id", tmp: {} });
      await sendMessage(chatId, "Enter report id to close", kbMain);
      break;
    case BUTTONS.SNOOZE:
      await setDialog(userId, { step: "snooze:report_id", tmp: {} });
      await sendMessage(chatId, "Enter report id to snooze", kbMain);
      break;
  }
}

function parseAsset(s: string): AssetType | null {
  const t = s.trim().toLowerCase();
  if (t.startsWith("truck")) return "Truck";
  if (t.startsWith("trailer")) return "Trailer";
  return null;
}
function parseDuration(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d+)\s*(h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return m[2] === "h" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}

async function continueFlow(userId: number, chatId: number, state: DialogState, text: string, _message: any) {
  switch (state.step) {
    case "new:asset": {
      const a = parseAsset(text);
      if (!a) return void (await sendMessage(chatId, "Choose Truck or Trailer", kbTT));
      state.tmp.asset = a;
      state.step = a === "Trailer" ? "new:paired" : "new:unit";
      await setDialog(userId, state);
      await sendMessage(chatId, state.step === "new:paired" ? "Paired truck number?" : "Unit number?", kbMain);
      return;
    }
    case "new:paired":
      state.tmp.pairedTruck = text.trim();
      state.step = "new:unit";
      await setDialog(userId, state);
      await sendMessage(chatId, "Unit number?", kbMain);
      return;
    case "new:unit":
      state.tmp.unitNumber = text.trim();
      state.step = "new:repair_side";
      await setDialog(userId, state);
      await sendMessage(chatId, "Where was repair?", kbTT);
      return;
    case "new:repair_side": {
      const a = parseAsset(text);
      if (!a) return void (await sendMessage(chatId, "Choose Truck or Trailer", kbTT));
      state.tmp.repairSide = a;
      state.step = "new:problem";
      await setDialog(userId, state);
      await sendMessage(chatId, "Problem description?", kbMain);
      return;
    }
    case "new:problem":
      state.tmp.problem = text.trim();
      state.step = "new:plan";
      await setDialog(userId, state);
      await sendMessage(chatId, "Next steps?", kbMain);
      return;
    case "new:plan":
      state.tmp.plan = text.trim();
      state.step = "new:reported_by";
      await setDialog(userId, state);
      await sendMessage(chatId, `Reported by? (default: ${DEFAULT_REPORTED_BY})`, kbMain);
      return;
    case "new:reported_by": {
      state.tmp.reportedBy = text.trim() || DEFAULT_REPORTED_BY;
      const report = await createReport({
        asset: state.tmp.asset,
        unitNumber: state.tmp.unitNumber,
        pairedTruck: state.tmp.pairedTruck,
        repairSide: state.tmp.repairSide,
        problem: state.tmp.problem,
        plan: state.tmp.plan,
        reportedBy: state.tmp.reportedBy,
        reportedByUserId: userId,
      });
      await clearDialog(userId);
      await sendMessage(chatId, `Created #${report.id}`, kbMain);
      await postToGroup(formatReport(report, "OPEN"));
      return;
    }
    case "update:report_id":
      state.reportId = text.trim();
      state.step = "update:await_text";
      await setDialog(userId, state);
      await sendMessage(chatId, `Update for #${state.reportId}: send text`, kbMain);
      return;
    case "update:await_text": {
      const rid = state.reportId!;
      const r = await getReport(rid);
      if (!r) {
        await clearDialog(userId);
        return void (await sendMessage(chatId, "Report not found", kbMain));
      }
      r.status = "open";
      r.snoozedUntil = undefined;
      r.lastUpdateAt = Date.now();
      r.history.push({ at: Date.now(), by: userId, text: text.trim(), kind: "update" });
      await saveReport(r);
      await addToOpenIndex(r.id);
      await clearDialog(userId);
      await sendMessage(chatId, `Updated #${rid}`, kbMain);
      await postToGroup(`#${rid} [UPDATE]\n${text.trim()}`);
      return;
    }
    case "close:report_id":
      state.reportId = text.trim();
      state.step = "close:await_text";
      await setDialog(userId, state);
      await sendMessage(chatId, `Close #${state.reportId}: send resolution`, kbMain);
      return;
    case "close:await_text": {
      const rid = state.reportId!;
      const r = await getReport(rid);
      if (!r) {
        await clearDialog(userId);
        return void (await sendMessage(chatId, "Report not found", kbMain));
      }
      r.status = "closed";
      r.snoozedUntil = undefined;
      r.lastUpdateAt = Date.now();
      r.history.push({ at: Date.now(), by: userId, text: text.trim(), kind: "close" });
      await saveReport(r);
      await removeFromOpenIndex(r.id);
      await clearDialog(userId);
      await sendMessage(chatId, `Closed #${rid}`, kbMain);
      await postToGroup(`#${rid} [CLOSED]\nResolution: ${text.trim()}`);
      return;
    }
    case "snooze:report_id":
      state.reportId = text.trim();
      state.step = "snooze:await_dur";
      await setDialog(userId, state);
      await sendMessage(chatId, "Duration? Tap one or type like 4h/2d", kbSnooze);
      return;
    case "snooze:await_dur": {
      const x = text.trim().toLowerCase();
      if (x === "back to menu") {
        await clearDialog(userId);
        return void (await sendMessage(chatId, "Choose an action:", kbMain));
      }
      const ms = parseDuration(text);
      if (!ms) return void (await sendMessage(chatId, "Use 2h/4h/1d or 4h/2d", kbSnooze));
      const rid = state.reportId!;
      await snoozeReport(rid, ms, userId);
      await clearDialog(userId);
      await sendMessage(chatId, `Snoozed #${rid}`, kbMain);
      return;
    }
  }
}

async function createReport(input: {
  asset: AssetType;
  unitNumber: string;
  pairedTruck?: string;
  repairSide: AssetType;
  problem: string;
  plan: string;
  reportedBy: string;
  reportedByUserId?: number;
}): Promise<Report> {
  const id = await nextReportId();
  const now = Date.now();
  const r: Report = {
    id,
    status: "open",
    asset: input.asset,
    unitNumber: input.unitNumber,
    pairedTruck: input.pairedTruck,
    repairSide: input.repairSide,
    problem: input.problem,
    plan: input.plan,
    reportedBy: input.reportedBy,
    reportedByUserId: input.reportedByUserId,
    createdAt: now,
    lastUpdateAt: now,
    history: [],
  };
  await saveReport(r);
  await addToOpenIndex(id);
  return r;
}

function formatReport(r: Report, tag: "OPEN" | "UPDATE" | "CLOSED" | "SNOOZED") {
  const parts = [
    `#${r.id} [${tag}]`,
    `Asset: ${r.asset} ${r.unitNumber}${r.pairedTruck ? ` (paired truck ${r.pairedTruck})` : ""}`,
    `Repair side: ${r.repairSide}`,
    `Problem: ${r.problem}`,
    `Plan: ${r.plan}`,
    `Reported by: ${r.reportedBy}`,
  ];
  return parts.join("\n");
}

async function snoozeReport(reportId: string, ms: number, by?: number) {
  const r = await getReport(reportId);
  if (!r) return;
  r.snoozedUntil = Date.now() + ms;
  r.status = "snoozed";
  r.history.push({ at: Date.now(), by, text: `snoozed ${Math.round(ms / 3600000)}h`, kind: "snooze" });
  await saveReport(r);
  await addToOpenIndex(r.id);
  await postToGroup(`#${reportId} [SNOOZED] until ${new Date(r.snoozedUntil).toISOString()}`);
}

async function runReminders() {
  const now = Date.now();
  const openIds = (await kv.get<string[]>(["index", "open"])).value || [];
  let sent = 0;
  for (const id of openIds) {
    const r = await getReport(id);
    if (!r) continue;
    if (r.status === "closed") continue;
    const snoozed = r.snoozedUntil && r.snoozedUntil > now;
    if (snoozed) continue;
    const minAge = 60 * 60 * 1000;
    if (now - r.lastUpdateAt < minAge) continue;
    if (r.lastReminderAt && now - r.lastReminderAt < minAge) continue;
    if (!r.reportedByUserId) continue;
    await sendMessage(r.reportedByUserId, reminderText(r), {
      reply_markup: {
        inline_keyboard: [[
          { text: "Update now", callback_data: `rem:update:${r.id}` },
          { text: "Snooze 2h", callback_data: `rem:snooze2h:${r.id}` },
        ], [
          { text: "Close", callback_data: `rem:close:${r.id}` },
          { text: "Skip", callback_data: `rem:skip:${r.id}` },
        ]],
      },
    });
    r.lastReminderAt = now;
    await saveReport(r);
    sent++;
  }
  return { checked: openIds.length, sent };
}

function reminderText(r: Report) {
  return `Reminder for #${r.id}
Asset: ${r.asset} ${r.unitNumber}
Problem: ${r.problem}
Last update: ${new Date(r.lastUpdateAt).toISOString()}

Need an update?`;
}

// KV helpers
async function nextReportId(): Promise<string> {
  const date = new Date();
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const key = ["seq", ymd];
  const cur = (await kv.get<number>(key)).value ?? 0;
  const next = cur + 1;
  await kv.set(key, next);
  const nn = String(next).padStart(3, "0");
  return `R-${ymd}-${nn}`;
}
async function saveReport(r: Report) {
  await kv.set(["report", r.id], r);
}
async function getReport(id: string): Promise<Report | null> {
  return (await kv.get<Report>(["report", id])).value ?? null;
}
async function addToOpenIndex(id: string) {
  const key = ["index", "open"];
  const list = (await kv.get<string[]>(key)).value ?? [];
  if (!list.includes(id)) {
    list.push(id);
    await kv.set(key, list);
  }
}
async function removeFromOpenIndex(id: string) {
  const key = ["index", "open"];
  const list = (await kv.get<string[]>(key)).value ?? [];
  const filtered = list.filter((x) => x !== id);
  await kv.set(key, filtered);
}

// Dialog state
async function getDialog(userId: number): Promise<DialogState | null> {
  return (await kv.get<DialogState>(["dialog", userId])).value ?? null;
}
async function setDialog(userId: number, state: DialogState) {
  await kv.set(["dialog", userId], state, { expireIn: 30 * 60 * 1000 });
}
async function clearDialog(userId: number) {
  await kv.delete(["dialog", userId]);
}

// Telegram API
async function sendMessage(chatId: number | string, text: string, extra: any = {}) {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}
async function postToGroup(text: string) {
  const groupId = GROUP_CHAT_ID_ENV || (await kv.get<string>(["groupChatId"])).value;
  if (!groupId) return;
  await sendMessage(groupId, text);
}
async function answerCallback(id: string, text?: string) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}
function json(data: any) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}
