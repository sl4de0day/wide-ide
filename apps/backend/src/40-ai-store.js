

const AI_CONFIG_FILE = () =>
  node_path.join(electron.app.getPath("userData"), "ai-config.json");
const AI_SESSION_DIR = () =>
  node_path.join(electron.app.getPath("userData"), "ai-sessions");
const AI_ACTIVE_CHAT_FILE = () =>
  node_path.join(electron.app.getPath("userData"), "active-chat.json");

const AI_CLOUD_PROVIDERS = new Set(["claude-code", "antigravity", "codex"]);

const AI_DEFAULT_CONFIG = {

  tab: "cloud",
  provider: "claude-code",
  cloudModel: {
    "claude-code": "",
    antigravity: "",
    codex: "",
  },
  localModel: "",

  allowWrites: true,
  toolMode: "full",
  interactionMode: "agent",
  allowBrowser: true,

  claudeCodeSignedIn: false,
  claudeEffort: "high",
  claudeFallbackModel: "sonnet",
  antigravityEffort: "high",
  codexEffort: "high",
};

let aiConfigCache = null;

function aiNormalizeConfigRecord(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  const rawProvider = String(raw.provider || "").trim().toLowerCase();
  const provider = AI_CLOUD_PROVIDERS.has(rawProvider) ? rawProvider : AI_DEFAULT_CONFIG.provider;
  const rawCloudModel = raw.cloudModel && typeof raw.cloudModel === "object" ? raw.cloudModel : {};
  return {
    ...AI_DEFAULT_CONFIG,
    ...raw,
    provider,
    cloudModel: {
      "claude-code": typeof rawCloudModel["claude-code"] === "string" ? rawCloudModel["claude-code"] : "",
      antigravity: typeof rawCloudModel.antigravity === "string" ? rawCloudModel.antigravity : "",
      codex: typeof rawCloudModel.codex === "string" ? rawCloudModel.codex : "",
    },
  };
}

async function readAiConfig() {
  if (aiConfigCache) return aiConfigCache;
  try {
    const parsed = JSON.parse(await promises.readFile(AI_CONFIG_FILE(), "utf8"));
    aiConfigCache = aiNormalizeConfigRecord(parsed);
  } catch {
    aiConfigCache = aiNormalizeConfigRecord({});
  }
  return aiConfigCache;
}

async function writeAiConfig(next) {
  const normalized = aiNormalizeConfigRecord(next);
  aiConfigCache = normalized;
  try {
    await writeFileAtomic(AI_CONFIG_FILE(), JSON.stringify(normalized, null, 2), "utf8");
  } catch (error) {
    console.warn("[ai] The settings could not be saved:", error.message);
  }
  return normalized;
}

const AI_ID_PATTERN = /^[0-9a-f]{32}$/;

function newSessionId() {
  return node_crypto.randomBytes(16).toString("hex");
}

function sessionFile(id) {
  if (!AI_ID_PATTERN.test(String(id || ""))) return "";
  return node_path.join(AI_SESSION_DIR(), `${id}.json`);
}

const MAX_SESSION_MESSAGES = 200;

function sessionTitle(messages) {
  const first = (Array.isArray(messages) ? messages : []).find(
    (message) => message && message.role === "user" && typeof message.content === "string"
  );
  const text = String(first?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

async function readAiSession(id) {
  const file = sessionFile(id);
  if (!file) return null;
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  const appDataBase = process.env.APPDATA || (process.platform === "win32" ? node_path.join(node_os.homedir(), "AppData", "Roaming") : (process.env.XDG_CONFIG_HOME || node_path.join(node_os.homedir(), ".config")));
  const candFiles = [
    file,
    node_path.join(appDataBase, "wide", "ai-sessions", `${safe}.json`),
    node_path.join(appDataBase, "wide-app", "ai-sessions", `${safe}.json`),
    node_path.join(appDataBase, "Wide IDE", "ai-sessions", `${safe}.json`),
    node_path.join(appDataBase, "Wide", "ai-sessions", `${safe}.json`),
  ];
  try {
    const activeData = JSON.parse(await promises.readFile(AI_ACTIVE_CHAT_FILE(), "utf8"));
    if (activeData?.root) {
      candFiles.push(node_path.join(activeData.root, ".wide", "ai-sessions", `${safe}.json`));
    }
  } catch {}
  for (const cand of candFiles) {
    try {
      const parsed = JSON.parse(await promises.readFile(cand, "utf8"));
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const record = {
        id: typeof parsed.id === "string" && parsed.id ? parsed.id : String(id),
        root: parsed.root ?? "",
        title: parsed.title || sessionTitle(messages),
        createdAt: Number(parsed.createdAt) || 0,
        updatedAt: Number(parsed.updatedAt) || 0,
        claudeSessionId: typeof parsed.claudeSessionId === "string" ? parsed.claudeSessionId : "",
        claudeSyncedCount: typeof parsed.claudeSyncedCount === "number" ? parsed.claudeSyncedCount : 0,
        antigravityConversationId: typeof parsed.antigravityConversationId === "string" ? parsed.antigravityConversationId : "",
        antigravitySyncedCount: typeof parsed.antigravitySyncedCount === "number" ? parsed.antigravitySyncedCount : 0,
        codexThreadId: typeof parsed.codexThreadId === "string" ? parsed.codexThreadId : "",
        codexSyncedCount: typeof parsed.codexSyncedCount === "number" ? parsed.codexSyncedCount : 0,
        messages,
      };
      if (cand !== file) {
        try {
          await promises.mkdir(AI_SESSION_DIR(), { recursive: true });
          await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
        } catch {}
      }
      return record;
    } catch {}
  }
  return null;
}

async function writeAiSession(id, root, messages, stamp) {
  const file = sessionFile(id);
  if (!file) return null;
  const trimmed = Array.isArray(messages) ? messages.slice(-MAX_SESSION_MESSAGES) : [];
  const existing = await readAiSession(id);
  const prevSynced = typeof existing?.claudeSyncedCount === "number" ? existing.claudeSyncedCount : 0;
  const prevAgySynced = typeof existing?.antigravitySyncedCount === "number" ? existing.antigravitySyncedCount : 0;
  const prevCodexSynced = typeof existing?.codexSyncedCount === "number" ? existing.codexSyncedCount : 0;
  const record = {
    id: String(id),
    root: root || existing?.root || "",

    title: existing?.title || sessionTitle(trimmed),
    createdAt: existing?.createdAt || stamp,
    updatedAt: stamp,
    claudeSessionId: existing?.claudeSessionId || "",
    claudeSyncedCount: trimmed.length < prevSynced ? 0 : prevSynced,
    antigravityConversationId: existing?.antigravityConversationId || "",
    antigravitySyncedCount: trimmed.length < prevAgySynced ? 0 : prevAgySynced,
    codexThreadId: existing?.codexThreadId || "",
    codexSyncedCount: trimmed.length < prevCodexSynced ? 0 : prevCodexSynced,
    messages: trimmed,
  };
  try {
    await promises.mkdir(AI_SESSION_DIR(), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.warn("[ai] The conversation could not be saved:", error.message);
    return null;
  }
  return record;
}

async function getAiSessionClaudeMeta(id) {
  const rec = await readAiSession(id);
  return {
    claudeSessionId: rec?.claudeSessionId || "",
    claudeSyncedCount: typeof rec?.claudeSyncedCount === "number" ? rec.claudeSyncedCount : 0,
  };
}

async function setAiSessionClaudeMeta(id, meta) {
  const file = sessionFile(id);
  if (!file) return null;
  const existing = await readAiSession(id);
  const now = Date.now();
  const record = existing
    ? { ...existing }
    : { id: String(id), root: "", title: "", createdAt: now, updatedAt: now, messages: [] };
  if (typeof meta?.claudeSessionId === "string") {
    record.claudeSessionId = meta.claudeSessionId;
  }
  if (typeof meta?.claudeSyncedCount === "number") {
    record.claudeSyncedCount = meta.claudeSyncedCount;
  }
  try {
    await promises.mkdir(AI_SESSION_DIR(), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.warn("[ai] The session metadata could not be saved:", error.message);
    return null;
  }
  return record;
}

async function getAiSessionAntigravityMeta(id) {
  const rec = await readAiSession(id);
  return {
    antigravityConversationId: rec?.antigravityConversationId || "",
    antigravitySyncedCount: typeof rec?.antigravitySyncedCount === "number" ? rec.antigravitySyncedCount : 0,
  };
}

async function setAiSessionAntigravityMeta(id, meta) {
  const file = sessionFile(id);
  if (!file) return null;
  const existing = await readAiSession(id);
  const now = Date.now();
  const record = existing
    ? { ...existing }
    : { id: String(id), root: "", title: "", createdAt: now, updatedAt: now, messages: [] };
  if (typeof meta?.antigravityConversationId === "string") {
    record.antigravityConversationId = meta.antigravityConversationId;
  }
  if (typeof meta?.antigravitySyncedCount === "number") {
    record.antigravitySyncedCount = meta.antigravitySyncedCount;
  }
  try {
    await promises.mkdir(AI_SESSION_DIR(), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.warn("[ai] The Antigravity session metadata could not be saved:", error.message);
    return null;
  }
  return record;
}

async function getAiSessionCodexMeta(id) {
  const rec = await readAiSession(id);
  return {
    codexThreadId: rec?.codexThreadId || "",
    codexSyncedCount: typeof rec?.codexSyncedCount === "number" ? rec.codexSyncedCount : 0,
  };
}

async function setAiSessionCodexMeta(id, meta) {
  const file = sessionFile(id);
  if (!file) return null;
  const existing = await readAiSession(id);
  const now = Date.now();
  const record = existing
    ? { ...existing }
    : { id: String(id), root: "", title: "", createdAt: now, updatedAt: now, messages: [] };
  if (typeof meta?.codexThreadId === "string") {
    record.codexThreadId = meta.codexThreadId;
  }
  if (typeof meta?.codexSyncedCount === "number") {
    record.codexSyncedCount = meta.codexSyncedCount;
  }
  try {
    await promises.mkdir(AI_SESSION_DIR(), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.warn("[ai] The Codex session metadata could not be saved:", error.message);
    return null;
  }
  return record;
}

async function listAiSessions(root) {
  let names = [];
  try {
    names = await promises.readdir(AI_SESSION_DIR());
  } catch {
    return [];
  }
  const wanted = String(root || "").toLowerCase();
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readAiSession(name.slice(0, -5));
    if (!record) continue;

    if (record.root && String(record.root).toLowerCase() !== wanted) continue;
    found.push({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      count: record.messages.length,
    });
  }
  found.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return found;
}

function registerAiStoreHandlers() {
  electron.ipcMain.handle("ai:config", async (_event, patch) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    if (!patch || typeof patch !== "object") {
      return { ok: true, config: await readAiConfig() };
    }
    const current = await readAiConfig();
    const next = {
      ...current,
      ...patch,
      cloudModel: { ...current.cloudModel, ...(patch.cloudModel ?? {}) },
    };
    return { ok: true, config: await writeAiConfig(next) };
  });

  electron.ipcMain.handle("ai:sessions", async (_event, root) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    return { ok: true, sessions: await listAiSessions(root) };
  });

  electron.ipcMain.handle("ai:session", async (_event, id) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    const record = await readAiSession(id);
    if (!record) return { ok: false, error: "There is no such conversation." };
    return { ok: true, session: record };
  });

  electron.ipcMain.handle("ai:newSession", async (_event, root) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    const now = Date.now();
    return {
      ok: true,
      session: { id: newSessionId(), root: root || "", title: "", createdAt: now, updatedAt: now, messages: [] },
    };
  });

  electron.ipcMain.handle("ai:saveSession", async (_event, id, root, messages) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    const record = await writeAiSession(id, root, messages, Date.now());
    if (!record) return { ok: false, error: "The conversation could not be saved." };
    return { ok: true, session: { ...record, messages: undefined }, messages: record.messages };
  });

  electron.ipcMain.handle("ai:deleteSession", async (_event, id) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    const file = sessionFile(id);
    if (!file) return { ok: false, error: "There is no such conversation." };
    if (typeof aiCloseClaudeSession === "function") {
      aiCloseClaudeSession(id);
    }
    if (typeof aiCloseAntigravitySession === "function") {
      aiCloseAntigravitySession(id);
    }
    if (typeof aiCloseCodexSession === "function") {
      aiCloseCodexSession(id);
    }
    try {
      await promises.rm(file, { force: true });
    } catch {

    }
    return { ok: true };
  });

  electron.ipcMain.handle("ai:activeChat", async (_event, payload) => {
    const gate = await requireInstalled("ai-assistant");
    if (gate) return gate;
    const file = AI_ACTIVE_CHAT_FILE();
    if (payload && typeof payload === "object" && payload.id) {
      try {
        const record = {
          id: String(payload.id),
          root: String(payload.root || ""),
          title: String(payload.title || ""),
          timestamp: Date.now(),
        };
        await writeFileAtomic(file, JSON.stringify(record, null, 2), "utf8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    const appDataBase = process.env.APPDATA || (process.platform === "win32" ? node_path.join(node_os.homedir(), "AppData", "Roaming") : (process.env.XDG_CONFIG_HOME || node_path.join(node_os.homedir(), ".config")));
    const candFiles = [
      file,
      node_path.join(appDataBase, "wide-app", "active-chat.json"),
      node_path.join(appDataBase, "Wide IDE", "active-chat.json"),
      node_path.join(appDataBase, "Wide", "active-chat.json"),
      node_path.join(appDataBase, "wide", "active-chat.json"),
    ];
    let best = null;
    for (const cand of candFiles) {
      try {
        const data = await promises.readFile(cand, "utf8");
        const parsed = JSON.parse(data);
        if (parsed && parsed.id && (!best || (parsed.timestamp || 0) > (best.timestamp || 0))) {
          best = parsed;
        }
      } catch {}
    }
    return { ok: true, activeChat: best };
  });
}
