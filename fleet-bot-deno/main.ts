// deno-lint-ignore-file no-explicit-any
/**
 * Fleet Reports Bot — Deno Deploy + Telegram
 * - Buttons почти на всех шагах (без кнопок для Problem/Plan).
 * - После Problem: сбор медиа с кнопками Done/Skip.
 * - После Reported by: превью и подтверждение Post.
 * - Report ID = номер стороны ремонта (Truck->truckNumber, Trailer->trailerNumber), при конфликте -2, -3...
 * - Зеркалит любые медиа из ЛС в группу, КРОМЕ шага создания (new:*), чтобы не уезжали раньше времени.
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
  id: string;                 // e.g. "4542" or "5678-2"
  status: ReportStatus;
  asset: AssetType;
  truckNumber?: string;
  trailerNumber?: string;
  pairedTruck?: string;       // only when Trailer
  repairSide: AssetType;      // where repair was
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
  step: string;               // e.g., new:asset, new:media, new:confirm
  tmp: Record<string, any>;   // collects inputs; tmp.mediaMsgIds: number[]
  reportId?: string;
}

const BUTTONS = {
  NEW: "New report",
  UPDATE: "Update report",
  CLOSE: "Close report",
  SNOOZE: "Snooze report",
};

// Reply keyboards
function kb(rows: (string | { text: string })[][]) {
  return { reply_markup: { keyboard: rows.map(r => r.map(x => typeof x === "string" ? ({ text: x }) : x)), resize_keyboard: true, one_time_keyboard: false } };
}
const kbMain = kb([[BUTTONS.NEW], [BUTTONS.UPDATE, BUTTONS.CLOSE], [BUTTONS.SNOOZE]]);
const kbTT = kb([["Truck", "Trailer"]]);
const kbReporter = kb([[DEFAULT_REPORTED_BY], ["Other (type)"]]);
const kbSnooze = kb([["2h", "4h", "1d"], ["Back to menu"]]);
const kbUpdateQuick = kb([["Rolling", "Waiting parts"], ["At shop", "Custom (type)"], ["Back to menu"]]);
const kbMedia = kb([["Done", "Skip"]]); // ← кнопки для завершения сбора медиа

// Inline keyboards
const ikNewConfirm = {
  reply_markup: {
    inline_keyboard: [[
      { text: "Post", callback_data: "new:post" },
      { text: "Cancel", callback_data: "new:cancel" },
    ]],
  },
};

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

    if (text?.startsWith?.("/setgroup")) {
      if (isGroup) {
        await kv.set(["groupChatId"], chatId.toString());
        await sendMessage(chatId, "Group chat linked ✅");
      }
      return;
    }

    // detect active dialog for mirroring suppression
    const state = await getDialog(userId);

    if (!isGroup) {
      // Mirror media from DM to group unless we are in NEW flow collecting inputs
      if (hasMedia(m)) {
        if (state && state.step.startsWith("new:")) {
          await collectMediaInState(userId, state, m);
        } else {
          await mirrorMediaToGroup(m);
        }
        return;
      }
    }

    if (isGroup) return;

    if ([BUTTONS.NEW, BUTTONS.UPDATE, BUTTONS.CLOSE, BUTTONS.SNOOZE].includes(text)) {
      await startFlow(userId, chatId, text);
      return;
    }

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

    if (data === "new:post" || data === "new:cancel") {
      const state = await getDialog(userId);
      if (!state || !state.step.startsWith("new:")) {
        await answerCallback(cq.id, "No draft");
        return;
      }
      if (data === "new:cancel") {
        await clearDialog(userId);
        await answerCallback(cq.id, "Canceled");
        await sendMessage(chatId, "Canceled.", kbMain);
        return;
      }
      // POST
      const draft = state.tmp;
      const report = await createReportFromState(userId, draft);
      await clearDialog(userId);
      await answerCallback(cq.id, "Posted");
      await sendMessage(chatId, `Created #${report.id}`, kbMain);
      await postToGroup(formatReport(report, "OPEN"));
      // push media to group
      if (draft.mediaMsgIds?.length) {
        const groupId = await getGroupId();
        if (groupId) {
          for (const mid of draft.mediaMsgIds as number[]) {
            await copyMessage(groupId, chatId, mid);
          }
        }
      }
      return;
    }

    if (data.startsWith("rem:update:")) {
      const reportId = data.split(":")[2];
      await setDialog(userId, { step: "update:quick_or_text", reportId, tmp: {} });
      await sendMessage(chatId, `Update for #${reportId}: choose or type`, kbUpdateQuick);
    } else if (data.startsWith("rem:snooze2h:")) {
      const reportId = data.split(":")[2];
      await snoozeReport(reportId, 2 * 60 * 60 * 1000, userId);
      await sendMessage(chatId, `Snoozed #${reportId} for 2h`, kbMain);
    } else if (data.startsWith("rem:close:")) {
      const reportId = data.split(":")[2];
      await setDialog(userId, { step: "close:await_text", reportId, tmp: {} });
      await sendMessage(chatId, `Close #${reportId}: resolution`, kbMain);
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

// Media helpers
function hasMedia(m: any) {
  return !!(m.photo || m.video || m.document);
}
async function collectMediaInState(userId: number, state: DialogState, m: any) {
  state.tmp.mediaMsgIds = state.tmp.mediaMsgIds || [];
  state.tmp.mediaMsgIds.push(m.message_id);
  await setDialog(userId, state);
  await sendMessage(m.chat.id, `Added media (${state.tmp.mediaMsgIds.length}). Tap Done when finished or Skip.`, kbMedia);
}
async function getGroupId(): Promise<string | null> {
  return GROUP_CHAT_ID_ENV || (await kv.get<string>(["groupChatId"])).value || null;
}
async function copyMessage(chatId: number | string, fromChat: number | string, messageId: number) {
  await fetch(`${API}/copyMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChat, message_id: messageId }),
  });
}
async function mirrorMediaToGroup(m: any) {
  const groupId = await getGroupId();
  if (!groupId) {
    await sendMessage(m.chat.id, "Group not linked. Send /setgroup in the group.");
    return;
  }
  await copyMessage(groupId, m.chat.id, m.message_id);
  await sendMessage(m.chat.id, "Sent to group ✓");
}

async function startFlow(userId: number, chatId: number, action: string) {
  switch (action) {
    case BUTTONS.NEW:
      await setDialog(userId, { step: "new:asset", tmp: { reportedBy: DEFAULT_REPORTED_BY, mediaMsgIds: [] } });
      await sendMessage(chatId, "Asset?", kbTT);
      break;
    case BUTTONS.UPDATE:
      await setDialog(userId, { step: "update:report_id", tmp: {} });
      await sendMessage(chatId, "Enter report id (truck or trailer number)", kbMain);
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
    // NEW REPORT
    case "new:asset": {
      const a = parseAsset(text);
      if (!a) return void (await sendMessage(chatId, "Choose Truck or Trailer", kbTT));
      state.tmp.asset = a;
      state.step = a === "Trailer" ? "new:trailer_num" : "new:truck_num";
      await setDialog(userId, state);
      await sendMessage(chatId, a === "Trailer" ? "Trailer number?" : "Truck number?");
      return;
    }
    case "new:truck_num":
      state.tmp.truckNumber = text.trim();
      state.step = "new:repair_side";
      await setDialog(userId, state);
      await sendMessage(chatId, "Where was repair?", kbTT);
      return;
    case "new:trailer_num":
      state.tmp.trailerNumber = text.trim();
      state.step = "new:paired_truck";
      await setDialog(userId, state);
      await sendMessage(chatId, "Paired truck number?");
      return;
    case "new:paired_truck":
      state.tmp.pairedTruck = text.trim();
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
      await sendMessage(chatId, "Problem?"); // free text
      return;
    }
    case "new:problem":
      state.tmp.problem = text.trim();
      state.step = "new:media";
      await setDialog(userId, state);
      await sendMessage(chatId, "Send photos/videos/documents of the damage. Tap Done when finished or Skip.", kbMedia);
      return;
    case "new:media": {
      const t = text.trim().toLowerCase();
      if (t === "done" || t === "skip") {
        state.step = "new:plan";
        await setDialog(userId, state);
        await sendMessage(chatId, "Plan?"); // free text
        return;
      }
      // if text while expecting media, just hint again
      await sendMessage(chatId, "Send media or tap Done / Skip.", kbMedia);
      return;
    }
    case "new:plan":
      state.tmp.plan = text.trim();
      state.step = "new:reported_by";
      await setDialog(userId, state);
      await sendMessage(chatId, "Reported by?", kbReporter);
      return;
    case "new:reported_by": {
      const v = text.trim();
      if (v.toLowerCase() === "other (type)") {
        state.step = "new:reported_by_text";
        await setDialog(userId, state);
        await sendMessage(chatId, "Type name");
        return;
      }
      state.tmp.reportedBy = v || DEFAULT_REPORTED_BY;
      // Preview
      const preview = formatDraft(state.tmp);
      state.step = "new:confirm";
      await setDialog(userId, state);
      await sendMessage(chatId, `Preview:\n${preview}\n\nPost to group?`, ikNewConfirm);
      return;
    }
    case "new:reported_by_text": {
      state.tmp.reportedBy = text.trim() || DEFAULT_REPORTED_BY;
      const preview = formatDraft(state.tmp);
      state.step = "new:confirm";
      await setDialog(userId, state);
      await sendMessage(chatId, `Preview:\n${preview}\n\nPost to group?`, ikNewConfirm);
      return;
    }
    case "new:confirm":
      // waiting for inline button. Ignore text.
      await sendMessage(chatId, "Tap Post or Cancel.", ikNewConfirm);
      return;

    // UPDATE
    case "update:report_id":
      state.reportId = text.trim();
      state.step = "update:quick_or_text";
      await setDialog(userId, state);
      await sendMessage(chatId, `Update for #${state.reportId}: choose or type`, kbUpdateQuick);
      return;
    case "update:quick_or_text": {
      const rid = state.reportId!;
      const r = await getReport(rid);
      if (!r) { await clearDialog(userId); return void (await sendMessage(chatId, "Report not found", kbMain)); }
      let payload = text.trim();
      if (payload.toLowerCase() === "back to menu") { await clearDialog(userId); return void (await sendMessage(chatId, "Choose an action:", kbMain)); }
      if (payload.toLowerCase() === "custom (type)") {
        state.step = "update:text";
        await setDialog(userId, state);
        await sendMessage(chatId, "Type update text");
        return;
      }
      r.status = "open"; r.snoozedUntil = undefined; r.lastUpdateAt = Date.now();
      r.history.push({ at: Date.now(), by: userId, text: payload, kind: "update" });
      await saveReport(r); await addToOpenIndex(r.id); await clearDialog(userId);
      await sendMessage(chatId, `Updated #${rid}`, kbMain);
      await postToGroup(`#${rid} [UPDATE]\n${payload}`);
      return;
    }
    case "update:text": {
      const rid = state.reportId!;
      const r = await getReport(rid);
      if (!r) { await clearDialog(userId); return void (await sendMessage(chatId, "Report not found", kbMain)); }
      r.status = "open"; r.snoozedUntil = undefined; r.lastUpdateAt = Date.now();
      r.history.push({ at: Date.now(), by: userId, text: text.trim(), kind: "update" });
      await saveReport(r); await addToOpenIndex(r.id); await clearDialog(userId);
      await sendMessage(chatId, `Updated #${rid}`, kbMain);
      await postToGroup(`#${rid} [UPDATE]\n${text.trim()}`);
      return;
    }

    // CLOSE
    case "close:report_id":
      state.reportId = text.trim();
      state.step = "close:await_text";
      await setDialog(userId, state);
      await sendMessage(chatId, `Close #${state.reportId}: resolution`, kbMain);
      return;
    case "close:await_text": {
      const rid = state.reportId!;
      const r = await getReport(rid);
      if (!r) { await clearDialog(userId); return void (await sendMessage(chatId, "Report not found", kbMain)); }
      r.status = "closed"; r.snoozedUntil = undefined; r.lastUpdateAt = Date.now();
      r.history.push({ at: Date.now(), by: userId, text: text.trim(), kind: "close" });
      await saveReport(r); await removeFromOpenIndex(r.id); await clearDialog(userId);
      await sendMessage(chatId, `Closed #${rid}`, kbMain);
      await postToGroup(`#${rid} [CLOSED]\nResolution: ${text.trim()}`);
      return;
    }

    // SNOOZE
    case "snooze:report_id":
      state.reportId = text.trim();
      state.step = "snooze:await_dur";
      await setDialog(userId, state);
      await sendMessage(chatId, "Duration? Tap one or type like 4h/2d", kbSnooze);
      return;
    case "snooze:await_dur": {
      const x = text.trim().toLowerCase();
      if (x === "back to menu") { await clearDialog(userId); return void (await sendMessage(chatId, "Choose an action:", kbMain)); }
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

function formatDraft(t: any) {
  const assetLine = t.asset === "Truck"
    ? `Truck ${t.truckNumber ?? "?"}`
    : `Trailer ${t.trailerNumber ?? "?"}${t.pairedTruck ? ` (paired truck ${t.pairedTruck})` : ""}`;
  const medias = (t.mediaMsgIds?.length ?? 0) > 0 ? `Media: ${t.mediaMsgIds.length} file(s)` : `Media: none`;
  return [
    `Asset: ${assetLine}`,
    `Repair side: ${t.repairSide}`,
    `Problem: ${t.problem}`,
    `Plan: ${t.plan}`,
    `Reported by: ${t.reportedBy || DEFAULT_REPORTED_BY}`,
    medias,
  ].join("\n");
}

async function createReportFromState(userId: number, t: any): Promise<Report> {
  const baseId = chooseSimpleId(t);
  const id = await ensureUniqueId(baseId);
  const now = Date.now();
  const r: Report = {
    id,
    status: "open",
    asset: t.asset,
    truckNumber: t.truckNumber,
    trailerNumber: t.trailerNumber,
    pairedTruck: t.pairedTruck,
    repairSide: t.repairSide,
    problem: t.problem,
    plan: t.plan,
    reportedBy: t.reportedBy || DEFAULT_REPORTED_BY,
    reportedByUserId: userId,
    createdAt: now,
    lastUpdateAt: now,
    history: [],
  };
  await saveReport(r);
  await addToOpenIndex(id);
  return r;
}

// ID = number from repair side (Truck -> truckNumber, Trailer -> trailerNumber).
function chooseSimpleId(t: any): string {
  if (t.repairSide === "Truck") {
    return (t.truckNumber || t.pairedTruck || t.trailerNumber || "unknown").toString();
  } else {
    return (t.trailerNumber || "unknown").toString();
  }
}
async function ensureUniqueId(base: string): Promise<string> {
  let id = base;
  let n = 2;
  while ((await kv.get(["report", id])).value) {
    id = `${base}-${n++}`;
  }
  return id;
}

function formatReport(r: Report, tag: "OPEN" | "UPDATE" | "CLOSED" | "SNOOZED") {
  const assetLine = r.asset === "Truck"
    ? `Truck ${r.truckNumber ?? "?"}`
    : `Trailer ${r.trailerNumber ?? "?"}${r.pairedTruck ? ` (paired truck ${r.pairedTruck})` : ""}`;
  const parts = [
    `#${r.id} [${tag}]`,
    `Asset: ${assetLine}`,
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
  const asset = r.asset === "Truck" ? `Truck ${r.truckNumber ?? "?"}` : `Trailer ${r.trailerNumber ?? "?"}`;
  return `Reminder for #${r.id}
Asset: ${asset}
Problem: ${r.problem}
Last update: ${new Date(r.lastUpdateAt).toISOString()}

Need an update?`;
}

// KV helpers
async function saveReport(r: Report) { await kv.set(["report", r.id], r); }
async function getReport(id: string): Promise<Report | null> { return (await kv.get<Report>(["report", id])).value ?? null; }
async function addToOpenIndex(id: string) {
  const key = ["index", "open"];
  const list = (await kv.get<string[]>(key)).value ?? [];
  if (!list.includes(id)) { list.push(id); await kv.set(key, list); }
}
async function removeFromOpenIndex(id: string) {
  const key = ["index", "open"];
  const list = (await kv.get<string[]>(key)).value ?? [];
  await kv.set(key, list.filter(x => x !== id));
}

// Dialog state
async function getDialog(userId: number): Promise<DialogState | null> {
  return (await kv.get<DialogState>(["dialog", userId])).value ?? null;
}
async function setDialog(userId: number, state: DialogState) {
  await kv.set(["dialog", userId], state, { expireIn: 30 * 60 * 1000 });
}
async function clearDialog(userId: number) { await kv.delete(["dialog", userId]); }

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
function json(data: any) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
