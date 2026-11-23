/* 同频 · 前端逻辑：无框架、无构建，所有数据来自 /api/state */
(() => {
  "use strict";

  // ---------------------------------------------------------------- 常量

  const TASK_STATUSES = ["todo", "doing", "review", "done"];
  const REQ_STATUSES = ["discussing", "confirmed", "building", "done", "paused"];
  const PRIORITIES = ["P0", "P1", "P2"];
  const KINDS = ["progress", "blocker", "decision", "comment"];

  const TASK_LABEL = { todo: "待办", doing: "进行中", review: "待确认", done: "已完成" };
  const REQ_LABEL = {
    discussing: "讨论中",
    confirmed: "已确认",
    building: "实现中",
    done: "已完成",
    paused: "已搁置",
  };
  const KIND_LABEL = {
    progress: "进展",
    blocker: "阻塞",
    decision: "决策",
    comment: "评论",
    system: "状态",
  };

  const IDENTITY_KEY = "tongpin.identity";
  const THEME_KEY = "tongpin.theme";
  const PROMPT_KEY = "tongpin.identityPrompted";
  const PROJECT_KEY = "tongpin.project";

  const PROJECT_COLORS = [
    "#17694F", "#3A6EA5", "#B0563F", "#7A5AA6",
    "#A9791C", "#2F7D7A", "#8A4F6B", "#4C6B2F",
  ];

  // 甘特图缩放：每天占多少像素
  const GANTT_ZOOMS = { day: 30, week: 12, month: 5 };

  const VIEW_META = {
    overview: ["概览", "只看今天该推进的事"],
    board: ["看板", "拖动卡片更新状态"],
    gantt: ["甘特图", "按时间看整体排期"],
    requirements: ["需求", "对齐我们到底在做什么"],
    activity: ["动态", "团队最近发生了什么"],
  };

  // ---------------------------------------------------------------- 状态

  const state = {
    data: null,
    rev: -1,
    view: "overview",
    identity: null,
    memberById: new Map(),
    projectById: new Map(),
    currentProjectId: null,
    ganttZoom: "week",
    reqById: new Map(),
    taskById: new Map(),
    tasksByReq: new Map(),
    drawer: null,
    drawerEntries: null,
    drawerReady: false,
    drafts: new Map(),
    composerKind: "progress",
    menu: null,
    confirmAction: null,
    myOnly: false,
    reqFilter: "all",
    feedKind: "all",
    search: "",
    online: true,
    lastSync: null,
    dragId: null,
    dropHandled: false,
  };
  let fieldSaveTimer = null;

  // ---------------------------------------------------------------- DOM

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const viewEl = $("#view");
  const drawerRoot = $("#drawer-root");
  const modalRoot = $("#modal-root");
  const menuRoot = $("#menu-root");
  const toastRoot = $("#toast-root");
  const searchInput = $("#search-input");
  const projectBtn = $("#project-btn");
  const projectNameEl = $("#project-name");
  const projectDotEl = $("#project-dot");

  // ---------------------------------------------------------------- 工具

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  }

  function initials(name) {
    const text = String(name || "").trim();
    if (!text) return "?";
    if (/^[A-Za-z]/.test(text)) return text.slice(0, 2).toUpperCase();
    return text.slice(0, 1);
  }

  function avatar(member, extra = "") {
    if (!member) {
      return `<span class="avatar ${extra}" style="background:var(--surface-2);color:var(--faint)" title="未指定">?</span>`;
    }
    return (
      `<span class="avatar ${extra}" title="${esc(member.name)}" ` +
      `style="background:color-mix(in srgb, ${esc(member.color)} 15%, var(--surface));color:${esc(member.color)}">` +
      `${esc(initials(member.name))}</span>`
    );
  }

  function member(id) {
    return id ? state.memberById.get(Number(id)) || null : null;
  }

  function requirement(id) {
    return id ? state.reqById.get(Number(id)) || null : null;
  }

  function task(id) {
    return id ? state.taskById.get(Number(id)) || null : null;
  }

  function project(id) {
    return id ? state.projectById.get(Number(id)) || null : null;
  }

  function currentProject() {
    return project(state.currentProjectId);
  }

  function projectTasks() {
    const pid = state.currentProjectId;
    if (!pid) return [];
    return state.data ? state.data.tasks.filter((t) => t.project_id === pid) : [];
  }

  function projectRequirements() {
    const pid = state.currentProjectId;
    if (!pid) return [];
    return state.data ? state.data.requirements.filter((r) => r.project_id === pid) : [];
  }

  function projectEntries() {
    const pid = state.currentProjectId;
    if (!pid || !state.data) return [];
    return state.data.entries.filter((e) => {
      const entity =
        e.entity_type === "task" ? state.taskById.get(e.entity_id) : state.reqById.get(e.entity_id);
      return entity && entity.project_id === pid;
    });
  }

  function entryProject(entry) {
    const entity =
      entry.entity_type === "task"
        ? state.taskById.get(entry.entity_id)
        : state.reqById.get(entry.entity_id);
    return entity ? entity.project_id : null;
  }

  function reqTasks(reqId) {
    return state.tasksByReq.get(Number(reqId)) || [];
  }

  function reqProgress(reqId) {
    const list = reqTasks(reqId);
    const done = list.filter((t) => t.status === "done").length;
    return { total: list.length, done, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
  }

  function reqRank(req) {
    return { building: 0, confirmed: 1, discussing: 2, paused: 3, done: 4 }[req.status] ?? 5;
  }

  function dueDiff(dateStr) {
    const parts = String(dateStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 9999;
    const target = new Date(parts[0], parts[1] - 1, parts[2]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function dueInfo(dateStr) {
    const diff = dueDiff(dateStr);
    if (diff < 0) return { text: `逾期 ${-diff} 天`, cls: "overdue" };
    if (diff === 0) return { text: "今天到期", cls: "today" };
    if (diff === 1) return { text: "明天到期", cls: "today" };
    if (diff <= 7) return { text: `${diff} 天后`, cls: "" };
    return { text: shortDate(dateStr), cls: "" };
  }

  function shortDate(value) {
    if (!value) return "";
    const parts = String(value).split("-");
    if (parts.length !== 3) return value;
    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function parseDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function isoDay(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addDays(d, n) {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function diffDays(from, to) {
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function monthLabel(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }

  function rangeText(start, end) {
    return `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
  }

  function relTime(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const seconds = Math.max(0, (Date.now() - then) / 1000);
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
    const d = new Date(then);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function clockTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function dayKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff < 7) return `${diff} 天前`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function toast(message, isError = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = message;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  async function api(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const error = new Error("无法连接服务器，请确认 app.py 还在运行");
      error.offline = true;
      throw error;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error("服务器返回了无法解析的内容");
    }
    if (!res.ok) throw new Error(data && data.error ? data.error : `请求失败（${res.status}）`);
    return data;
  }

  // ---------------------------------------------------------------- 数据

  function applyState(data) {
    state.data = data;
    state.rev = data.rev;
    state.lastSync = new Date();
    state.online = true;
    state.memberById = new Map(data.members.map((m) => [m.id, m]));
    state.projectById = new Map(data.projects.map((p) => [p.id, p]));
    state.reqById = new Map(data.requirements.map((r) => [r.id, r]));
    state.taskById = new Map(data.tasks.map((t) => [t.id, t]));

    if (!state.currentProjectId || !state.projectById.has(state.currentProjectId)) {
      const first = data.projects[0];
      state.currentProjectId = first ? first.id : null;
      if (first) localStorage.setItem(PROJECT_KEY, String(first.id));
    }

    const byReq = new Map();
    for (const t of data.tasks) {
      if (!t.requirement_id) continue;
      if (!byReq.has(t.requirement_id)) byReq.set(t.requirement_id, []);
      byReq.get(t.requirement_id).push(t);
    }
    state.tasksByReq = byReq;

    if (state.identity && !state.memberById.has(state.identity)) {
      state.identity = null;
      localStorage.removeItem(IDENTITY_KEY);
    }
  }

  async function refresh({ initial = false } = {}) {
    try {
      const data = await api("/api/state");
      const changed = !state.data || data.rev !== state.data.rev;
      applyState(data);
      if (changed || initial || !viewEl.querySelector(".view")) {
        render();
      } else {
        syncFooter();
      }
      if (!initial && state.wasOffline) {
        state.wasOffline = false;
        toast("已重新连接");
      }
    } catch (err) {
      const wasOnline = state.online;
      state.online = false;
      state.wasOffline = true;
      if (wasOnline && !initial) toast("连接断开了，正在自动重试", true);
      if (initial || !state.data || wasOnline) render();
    }
  }

  function syncFooter() {
    const foot = viewEl.querySelector("[data-sync]");
    if (!foot) return;
    foot.textContent = state.online
      ? `上次同步 ${clockTime(state.lastSync ? state.lastSync.toISOString() : null)}`
      : "连接断开，正在自动重试…";
    foot.style.color = state.online ? "" : "var(--danger)";
  }

  // ---------------------------------------------------------------- 渲染入口

  function render() {
    if (!state.data) {
      viewEl.innerHTML = state.online
        ? `<div class="empty-note" style="margin-top:12vh"><strong>正在连接</strong>正在读取这台机器上的数据…</div>`
        : `<div class="empty-note" style="margin-top:12vh"><strong>连不上服务器</strong>确认终端里的 <code>python app.py</code> 还在运行。这个页面每 5 秒会自动重试。</div>`;
      return;
    }

    const meta = VIEW_META[state.view] || VIEW_META.overview;
    $("#page-title").textContent = meta[0];
    $("#page-sub").textContent = subline();

    $$(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === state.view);
    });

    renderAvatarStack();
    renderSidebarUser();
    renderProjectButton();

    const boardScroll = viewEl.querySelector(".board");
    const scrollLeft = boardScroll ? boardScroll.scrollLeft : 0;
    const ganttScrollEl = viewEl.querySelector(".gantt-scroll");
    const ganttLeft = ganttScrollEl ? ganttScrollEl.scrollLeft : 0;

    if (state.search) {
      viewEl.innerHTML = renderSearchResults();
      renderDrawer();
      syncScrollLock();
      return;
    }

    switch (state.view) {
      case "board":
        viewEl.innerHTML = renderBoard();
        break;
      case "gantt":
        viewEl.innerHTML = renderGantt();
        break;
      case "requirements":
        viewEl.innerHTML = renderRequirements();
        break;
      case "activity":
        viewEl.innerHTML = renderActivity();
        break;
      default:
        viewEl.innerHTML = renderOverview();
    }

    const newBoard = viewEl.querySelector(".board");
    if (newBoard) newBoard.scrollLeft = scrollLeft;
    const newGantt = viewEl.querySelector(".gantt-scroll");
    if (newGantt) newGantt.scrollLeft = ganttLeft;

    renderDrawer();
    syncScrollLock();
  }

  function subline() {
    const data = state.data;
    if (!data) return "";
    if (state.search) return `搜索「${state.search}」`;
    const tasks = projectTasks();
    const active = tasks.filter((t) => t.status !== "done").length;
    switch (state.view) {
      case "board":
        return `${active} 个任务在推进 · 拖动卡片更新状态`;
      case "gantt":
        return `${projectRequirements().length} 个需求 · ${tasks.length} 个任务 · 按时间对齐排期`;
      case "requirements": {
        const total = tasks.length;
        const linked = tasks.filter((t) => t.requirement_id).length;
        const pct = total ? Math.round((linked / total) * 100) : 0;
        return `${projectRequirements().length} 个需求 · ${pct}% 的任务已挂到需求`;
      }
      case "activity":
        return `最近 ${projectEntries().length} 条更新`;
      default:
        return `${data.members.length} 人 · ${active} 个任务在推进`;
    }
  }

  function renderAvatarStack() {
    const el = $("#avatars");
    if (!state.data) return;
    const list = state.data.members;
    if (!list.length) {
      el.innerHTML = "";
      return;
    }
    const shown = list.slice(0, 6);
    el.innerHTML =
      shown
        .map(
          (m) =>
            `<button type="button" class="avatar" data-action="open-identity" title="${esc(m.name)}" ` +
            `aria-label="切换身份：${esc(m.name)}" style="background:color-mix(in srgb, ${esc(m.color)} 15%, var(--surface));color:${esc(m.color)}">` +
            `${esc(initials(m.name))}</button>`
        )
        .join("") +
      (list.length > shown.length
        ? `<span class="avatar" style="background:var(--surface-2);color:var(--muted)" title="还有 ${list.length - shown.length} 位成员">+${list.length - shown.length}</span>`
        : "");
  }

  function renderSidebarUser() {
    const el = $("#sidebar-user");
    const me = member(state.identity);
    if (me) {
      el.innerHTML = `${avatar(me, "sm")}<span class="who"><strong>${esc(me.name)}</strong><span>当前身份</span></span>`;
    } else {
      el.innerHTML =
        `<span class="avatar sm" style="background:var(--surface-2);color:var(--faint)">?</span>` +
        `<span class="who"><strong>选择身份</strong><span>更新会记在你名下</span></span>`;
    }
  }

  function renderProjectButton() {
    const p = currentProject();
    if (!projectBtn) return;
    projectNameEl.textContent = p ? p.name : "选择项目";
    projectDotEl.style.background = p ? p.color : "var(--faint)";
    projectBtn.title = p ? `当前项目：${p.name}（点击切换）` : "新建或选择项目";
  }

  // ---------------------------------------------------------------- 概览

  function renderOverview() {
    const { members } = state.data;
    const tasks = projectTasks();
    const requirements = projectRequirements();

    if (!state.data.projects.length) return projectOnboardingHTML();

    if (!members.length) return onboardingHTML();

    if (state.search) return renderSearchResults();

    const active = tasks.filter((t) => t.status !== "done");
    const doing = tasks.filter((t) => t.status === "doing" || t.status === "review");
    const todo = tasks.filter((t) => t.status === "todo");
    const done = tasks.filter((t) => t.status === "done");
    const overdue = active.filter((t) => t.due_date && dueDiff(t.due_date) < 0);
    const week = active.filter((t) => t.due_date && dueDiff(t.due_date) <= 7);
    const blocked = active.filter((t) => t.last_kind === "blocker");
    const linked = tasks.filter((t) => t.requirement_id);
    const coverage = tasks.length ? Math.round((linked.length / tasks.length) * 100) : 0;
    const unlinked = tasks.length - linked.length;

    const stats = `
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label"><span class="dot status-doing"></span>正在推进</div>
          <strong>${doing.length}</strong>
          <em>${todo.length} 项待办 · ${done.length} 项已完成</em>
        </div>
        <div class="stat ${overdue.length ? "is-alert" : ""}">
          <div class="stat-label"><span class="dot ${overdue.length ? "status-review" : "status-doing"}"></span>7 天内到期</div>
          <strong>${week.length}</strong>
          <em>${overdue.length ? `${overdue.length} 项已经逾期` : "未来一周的交付"}</em>
        </div>
        <div class="stat ${blocked.length ? "is-alert" : ""}">
          <div class="stat-label"><span class="dot ${blocked.length ? "status-review" : "status-doing"}"></span>有阻塞</div>
          <strong>${blocked.length}</strong>
          <em>${blocked.length ? "最新一条记录是阻塞" : "暂时没有卡点"}</em>
        </div>
        <div class="stat">
          <div class="stat-label"><span class="dot status-done"></span>需求覆盖</div>
          <strong>${coverage}%</strong>
          <em>${unlinked ? `${unlinked} 个任务还没挂需求` : tasks.length ? "所有任务都挂在需求上" : "还没有任务"}</em>
        </div>
      </div>`;

    const attention = buildAttention(active);
    const attentionHTML = attention.length
      ? attention.map(attentionRowHTML).join("")
      : `<div class="empty-note" style="margin:4px 0">没有逾期、阻塞或长期没更新的任务。今天可以专心做事。</div>`;

    const alignReqs = [...requirements]
      .sort(
        (a, b) =>
          reqRank(a) - reqRank(b) ||
          (a.target_date || "9999-99-99").localeCompare(b.target_date || "9999-99-99")
      )
      .slice(0, 7);

    const alignHTML = alignReqs.length
      ? alignReqs.map(alignRowHTML).join("")
      : `<div class="empty-note" style="margin:4px 0">还没有需求。先写清楚要解决什么，再往下拆任务。</div>`;

    const teamHTML = members
      .map((m) => {
        const mine = tasks.filter((t) => t.assignee_id === m.id);
        const counts = {
          doing: mine.filter((t) => t.status === "doing").length,
          review: mine.filter((t) => t.status === "review").length,
          todo: mine.filter((t) => t.status === "todo").length,
          done: mine.filter((t) => t.status === "done").length,
        };
        const total = mine.length;
        const blockedCount = mine.filter((t) => t.status !== "done" && t.last_kind === "blocker").length;
        const seg = (count, cls) =>
          count && total
            ? `<i class="${cls}" style="width:${(count / total) * 100}%"></i>`
            : "";
        return `<div class="member-card">
          <div class="member-top">${avatar(m)}<strong>${esc(m.name)}</strong></div>
          <div class="member-load" title="${total} 个任务">
            ${seg(counts.doing, "load-doing")}${seg(counts.review, "load-review")}${seg(counts.todo, "load-todo")}${seg(counts.done, "load-done")}
          </div>
          <div class="member-stats">
            <span><b>${counts.doing + counts.review}</b> 在做</span>
            <span><b>${counts.todo}</b> 待办</span>
            ${blockedCount ? `<span style="color:var(--danger)"><b>${blockedCount}</b> 阻塞</span>` : ""}
          </div>
        </div>`;
      })
      .join("");

    return `
      ${stats}
      <div class="overview-grid">
        <section class="panel">
          <div class="panel-head">
            <h2><svg class="icon"><use href="#i-alert"/></svg>值得先看</h2>
            <button type="button" class="link-btn" data-go="board">打开看板 →</button>
          </div>
          <div class="attention-list">${attentionHTML}</div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2><svg class="icon"><use href="#i-req"/></svg>需求对齐</h2>
            <button type="button" class="link-btn" data-go="requirements">全部需求 →</button>
          </div>
          <div class="req-align">${alignHTML}</div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head">
          <h2><svg class="icon"><use href="#i-overview"/></svg>谁在忙什么</h2>
          <span class="sub">按负责人统计，含已完成</span>
        </div>
        <div class="team-grid">${teamHTML}</div>
      </section>
      <div class="overview-foot">
        <span data-sync>${state.online ? `数据留在本机 · 上次同步 ${clockTime(state.lastSync ? state.lastSync.toISOString() : null)}` : "连接断开，正在自动重试…"}</span>
        <span>${members.length} 位成员 · 数据只在你们自己的机器上</span>
      </div>`;
  }

  function onboardingHTML() {
    return `<div class="panel" style="max-width:580px;margin:9vh auto;text-align:center;padding:38px 30px">
      <div class="brand-mark" style="margin:0 auto 18px;width:42px;height:42px"><i></i><i></i></div>
      <h2 style="margin:0 0 8px;font-size:21px;font-weight:680;letter-spacing:-.01em">五六个⼈，把事对齐就够了</h2>
      <p style="margin:0 auto;max-width:400px;color:var(--muted);font-size:12.8px;line-height:1.8">
        同频不需要注册，也没有权限设置。先添加成员，然后写一个需求、往下拆几个任务，
        每天把进展、阻塞和决定记在卡片里。
      </p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:20px">
        <button type="button" class="btn btn-primary" data-action="open-identity">添加第一位成员</button>
      </div>
      <p style="margin:18px 0 0;color:var(--faint);font-size:10.5px">
        数据保存在这台机器的一个 SQLite 文件里，随开随用。
      </p>
    </div>`;
  }

  function projectOnboardingHTML() {
    return `<div class="panel" style="max-width:580px;margin:9vh auto;text-align:center;padding:38px 30px">
      <div class="brand-mark" style="margin:0 auto 18px;width:42px;height:42px"><i></i><i></i></div>
      <h2 style="margin:0 0 8px;font-size:21px;font-weight:680;letter-spacing:-.01em">先建一个项目，再把事放进来</h2>
      <p style="margin:0 auto;max-width:420px;color:var(--muted);font-size:12.8px;line-height:1.8">
        一个项目就是一条时间线。项目经理可以同时建多个项目，在顶栏随时切换；
        需求、任务和进展都会留在各自的项目里。
      </p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:20px">
        <button type="button" class="btn btn-primary" data-action="new-project">创建第一个项目</button>
      </div>
      <p style="margin:18px 0 0;color:var(--faint);font-size:10.5px">
        之后可以随时改名字、补周期，也可以再加项目。
      </p>
    </div>`;
  }

  function buildAttention(active) {
    const items = [];
    for (const t of active) {
      let item = null;
      if (t.last_kind === "blocker") {
        item = { rank: 0, icon: "i-alert", cls: "", label: "有阻塞" };
      } else if (t.due_date) {
        const diff = dueDiff(t.due_date);
        if (diff < 0) item = { rank: 1, icon: "i-clock", cls: "", label: `逾期 ${-diff} 天` };
        else if (diff <= 2) {
          item = {
            rank: 2,
            icon: "i-clock",
            cls: "soon",
            label: diff === 0 ? "今天到期" : diff === 1 ? "明天到期" : "马上就要到期",
          };
        }
      }
      if (!item) {
        const days = (Date.now() - new Date(t.updated_at).getTime()) / 86400000;
        if ((t.status === "doing" || t.status === "review") && days >= 7) {
          item = { rank: 3, icon: "i-clock", cls: "stale", label: `${Math.floor(days)} 天没更新` };
        }
      }
      if (item) items.push({ ...item, task: t });
    }
    return items
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.task.due_date || "9999-99-99").localeCompare(b.task.due_date || "9999-99-99")
      )
      .slice(0, 7);
  }

  function attentionRowHTML(item) {
    const t = item.task;
    const req = requirement(t.requirement_id);
    const owner = member(t.assignee_id);
    const chipClass = item.rank <= 1 ? "danger" : item.rank === 2 ? "warn" : "";
    return `<div class="attention-row" data-task="${t.id}">
      <span class="att-icon ${item.cls}"><svg class="icon"><use href="#${item.icon}"/></svg></span>
      <div class="att-main">
        <div class="att-title">${esc(t.title)}</div>
        <div class="att-meta">
          <span class="att-chip ${chipClass}">${esc(item.label)}</span>
          <span class="att-chip"><span class="dot status-${t.status}" style="width:5px;height:5px"></span>${TASK_LABEL[t.status]}</span>
          <span class="att-req">${req ? esc(req.title) : "未关联需求"}</span>
        </div>
      </div>
      ${owner ? avatar(owner, "sm att-avatar") : ""}
    </div>`;
  }

  function alignRowHTML(req) {
    const { done, total, pct } = reqProgress(req.id);
    const owner = member(req.owner_id);
    return `<div class="align-row" data-req="${req.id}">
      <div class="align-top">
        <span class="pill status-${req.status}"><span class="dot" style="background:currentColor"></span>${REQ_LABEL[req.status]}</span>
        <span class="align-title">${esc(req.title)}</span>
      </div>
      <div class="align-meta">
        <div class="align-bar">
          <div class="progress-track track"><i style="width:${pct}%"></i></div>
          <span>${done}/${total}</span>
        </div>
        ${owner ? avatar(owner, "sm") : ""}
        <span>${req.target_date ? `目标 ${shortDate(req.target_date)}` : "未设目标日"}</span>
      </div>
    </div>`;
  }

  function renderSearchResults() {
    const q = state.search.toLowerCase();
    const tasks = projectTasks().filter((t) => {
      const req = requirement(t.requirement_id);
      return `${t.title} ${t.description} ${req ? req.title : ""}`.toLowerCase().includes(q);
    });
    const reqs = projectRequirements().filter((r) =>
      `${r.title} ${r.description}`.toLowerCase().includes(q)
    );

    const taskHTML = tasks.length
      ? tasks
          .slice(0, 30)
          .map(
            (t) => `<div class="attention-row" data-task="${t.id}">
              <span class="att-icon stale"><svg class="icon"><use href="#i-board"/></svg></span>
              <div class="att-main">
                <div class="att-title">${esc(t.title)}</div>
                <div class="att-meta">
                  <span class="att-chip"><span class="dot status-${t.status}" style="width:5px;height:5px"></span>${TASK_LABEL[t.status]}</span>
                  <span class="att-req">${esc(requirement(t.requirement_id)?.title || "未关联需求")}</span>
                </div>
              </div>
            </div>`
          )
          .join("")
      : `<div class="empty-note">没有匹配的任务。</div>`;

    const reqHTML = reqs.length
      ? reqs
          .slice(0, 20)
          .map(
            (r) => `<div class="attention-row" data-req="${r.id}">
              <span class="att-icon stale"><svg class="icon"><use href="#i-req"/></svg></span>
              <div class="att-main">
                <div class="att-title">${esc(r.title)}</div>
                <div class="att-meta"><span class="att-chip">${REQ_LABEL[r.status]}</span></div>
              </div>
            </div>`
          )
          .join("")
      : `<div class="empty-note">没有匹配的需求。</div>`;

    return `<div class="overview-grid" style="grid-template-columns:1fr 1fr">
      <section class="panel"><div class="panel-head"><h2>任务 · ${tasks.length}</h2></div><div class="attention-list">${taskHTML}</div></section>
      <section class="panel"><div class="panel-head"><h2>需求 · ${reqs.length}</h2></div><div class="attention-list">${reqHTML}</div></section>
    </div>`;
  }

  // ---------------------------------------------------------------- 看板

  function matchesTask(t) {
    if (t.project_id !== state.currentProjectId) return false;
    if (state.myOnly && t.assignee_id !== state.identity) return false;
    if (!state.search) return true;
    const req = requirement(t.requirement_id);
    return `${t.title} ${t.description} ${req ? req.title : ""}`
      .toLowerCase()
      .includes(state.search.toLowerCase());
  }

  function boardTasks() {
    return projectTasks().filter(matchesTask);
  }

  function renderBoard() {
    const tasks = boardTasks();
    const dragEnabled = !state.search && !state.myOnly;
    const me = member(state.identity);

    const head = `<div class="board-head">
      <span class="hint">${state.search ? `筛选出 ${tasks.length} 个任务 · 清除搜索后可拖拽` : dragEnabled ? `${tasks.length} 个任务 · 拖到别的列就更新状态` : "筛选时不能拖拽排序，可在卡片菜单里移动"}</span>
      <div class="side">
        <button type="button" class="filter-toggle ${state.myOnly ? "active" : ""}" data-action="toggle-my">
          ${me ? avatar(me, "sm") : ""}只看我的
        </button>
      </div>
    </div>`;

    const columns = TASK_STATUSES.map((status) => {
      const list = tasks.filter((t) => t.status === status);
      const empty = state.search
        ? "没有匹配的任务"
        : state.myOnly
        ? "你没有这一列的任务"
        : "拖到这里，或点 + 新建";
      return `<section class="column" data-status="${status}">
        <div class="column-head">
          <span class="dot status-${status}"></span>
          <h3>${TASK_LABEL[status]}</h3>
          <span class="column-count">${list.length}</span>
          <button type="button" class="icon-btn" data-quick="${status}" title="在${TASK_LABEL[status]}新建任务" aria-label="在${TASK_LABEL[status]}新建任务">
            <svg class="icon"><use href="#i-plus"/></svg>
          </button>
        </div>
        <div class="column-body" data-status="${status}">
          ${list.map((t) => cardHTML(t, dragEnabled)).join("")}
          ${list.length ? "" : `<div class="column-empty">${empty}</div>`}
        </div>
      </section>`;
    }).join("");

    const noTasks =
      !projectTasks().length && !state.search
        ? `<div class="empty-note" style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left">
            <span><strong>这个项目还没有任务。</strong>从一个具体任务开始，也可以先写需求再拆。</span>
            <button type="button" class="btn btn-ghost" data-action="new-task">新建任务</button>
          </div>`
        : "";

    return `${head}${noTasks}<div class="board">${columns}</div>`;
  }

  function cardHTML(t, dragEnabled) {
    const req = requirement(t.requirement_id);
    const owner = member(t.assignee_id);
    const due = t.due_date ? dueInfo(t.due_date) : null;
    const blocker = t.status !== "done" && t.last_kind === "blocker";
    const prio = t.priority !== "P2" ? `<span class="prio prio-${t.priority.toLowerCase()}">${t.priority}</span>` : "";
    return `<article class="card ${t.priority === "P0" ? "p0" : t.priority === "P1" ? "p1" : ""}" data-task="${t.id}" draggable="${dragEnabled}">
      <div class="card-top">
        <h4 class="card-title">${esc(t.title)}</h4>
        <button type="button" class="card-menu" data-menu="task" data-task="${t.id}" aria-label="任务操作">
          <svg class="icon"><use href="#i-more"/></svg>
        </button>
      </div>
      ${req ? `<div class="card-tags"><span class="req-tag"><svg class="icon"><use href="#i-link"/></svg>${esc(req.title)}</span></div>` : ""}
      <div class="card-meta">
        ${prio}
        ${due ? `<span class="card-due ${due.cls}"><svg class="icon"><use href="#i-clock"/></svg>${due.text}</span>` : ""}
        ${blocker ? `<span class="card-note" style="color:var(--danger)"><svg class="icon"><use href="#i-alert"/></svg>阻塞</span>` : ""}
        ${t.entry_count ? `<span class="card-note"><svg class="icon"><use href="#i-comment"/></svg>${t.entry_count}</span>` : ""}
        <span class="spacer"></span>
        ${owner ? avatar(owner, "sm") : ""}
      </div>
    </article>`;
  }

  // ---------------------------------------------------------------- 甘特图

  function taskSpan(t) {
    const start = parseDay(t.start_date);
    const end = parseDay(t.due_date);
    if (!start && !end) return null;
    const s = start || end;
    const e = end || start;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }

  function reqSpan(r) {
    let start = parseDay(r.start_date);
    let end = parseDay(r.target_date);
    for (const t of reqTasks(r.id)) {
      const span = taskSpan(t);
      if (!span) continue;
      if (!start || span.start < start) start = span.start;
      if (!end || span.end > end) end = span.end;
    }
    if (!start && !end) return null;
    const s = start || end;
    const e = end || start;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }

  function ganttRange(project) {
    let start = parseDay(project.start_date);
    let end = parseDay(project.target_date);
    for (const r of projectRequirements()) {
      const span = reqSpan(r);
      if (!span) continue;
      if (!start || span.start < start) start = span.start;
      if (!end || span.end > end) end = span.end;
    }
    if (!start || !end) {
      const today = new Date();
      start = start || addDays(today, -7);
      end = end || addDays(today, 21);
    }
    if (diffDays(start, end) < 14) end = addDays(start, 14);
    start = addDays(start, -3);
    end = addDays(end, 3);
    if (diffDays(start, end) > 400) end = addDays(start, 400);
    return { start, end };
  }

  function ganttMonths(start, end, dayW) {
    const parts = [];
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const segStart = cursor < start ? start : cursor;
      const segEnd = monthEnd > end ? end : monthEnd;
      const left = diffDays(start, segStart) * dayW;
      const width = (diffDays(segStart, segEnd) + 1) * dayW;
      if (width > 30) {
        parts.push(
          `<div class="g-month" style="left:${left}px;width:${width}px">${width > 58 ? monthLabel(segStart) : `${segStart.getMonth() + 1}月`}</div>`
        );
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    return parts.join("");
  }

  function ganttTicks(start, end, dayW, zoom) {
    const parts = [];
    if (zoom === "month") return parts.join("");
    const total = diffDays(start, end);
    if (zoom === "day") {
      for (let i = 0; i <= total; i += 1) {
        const d = addDays(start, i);
        const weekend = d.getDay() === 0 || d.getDay() === 6;
        parts.push(
          `<div class="g-tick ${weekend ? "weekend" : ""}" style="left:${i * dayW}px;width:${dayW}px">${d.getDate()}</div>`
        );
      }
    } else {
      let d = addDays(start, (8 - start.getDay()) % 7);
      while (d <= end) {
        const left = diffDays(start, d) * dayW;
        parts.push(
          `<div class="g-tick week" style="left:${left}px;width:${7 * dayW}px">${d.getMonth() + 1}/${d.getDate()}</div>`
        );
        d = addDays(d, 7);
      }
    }
    return parts.join("");
  }

  function ganttBar(span, range, dayW, cls, extra = "") {
    const left = diffDays(range.start, span.start) * dayW;
    const width = Math.max(5, (diffDays(span.start, span.end) + 1) * dayW - 2);
    return `<i class="g-bar ${cls}" style="left:${left + 1}px;width:${width}px" ${extra}></i>`;
  }

  function renderGantt() {
    const p = currentProject();
    if (!p) return projectOnboardingHTML();

    const allTasks = projectTasks();
    const allReqs = projectRequirements();
    const q = state.search.trim().toLowerCase();
    const tasks = q ? allTasks.filter((t) => matchesTask(t)) : allTasks;
    const reqs = q
      ? allReqs.filter(
          (r) =>
            `${r.title} ${r.description}`.toLowerCase().includes(q) ||
            tasks.some((t) => t.requirement_id === r.id)
        )
      : allReqs;
    const { start, end } = ganttRange(p);
    const totalDays = diffDays(start, end) + 1;
    const zoom = state.ganttZoom;
    const base = GANTT_ZOOMS[zoom] || GANTT_ZOOMS.week;
    const available = Math.max(520, Math.min(window.innerWidth - 320, 1500) - 240);
    const dayW = Math.min(base * 2.4, Math.max(base, available / totalDays));
    const trackW = Math.max(320, totalDays * dayW);

    const scheduled = tasks.filter((t) => taskSpan(t));
    const unscheduled = tasks.filter((t) => !taskSpan(t));
    const today = new Date();
    const todayOffset = diffDays(start, today);
    const todayLine =
      todayOffset >= 0 && todayOffset < totalDays
        ? `<i class="g-today-line" style="left:${(todayOffset + 0.5) * dayW}px"></i>`
        : "";

    const groups = [...reqs]
      .sort(
        (a, b) =>
          reqRank(a) - reqRank(b) ||
          (a.target_date || "9999-99-99").localeCompare(b.target_date || "9999-99-99")
      )
      .map((r) => {
        const span = reqSpan(r);
        const { done, total, pct } = reqProgress(r.id);
        const list = reqTasks(r.id)
          .filter((t) => taskSpan(t) && (!q || matchesTask(t)))
          .sort((a, b) => taskSpan(a).start - taskSpan(b).start || a.id - b.id);
        const bar = span
          ? ganttBar(
              span,
              { start },
              dayW,
              `req-bar status-${r.status}`,
              `title="${esc(r.title)} · ${done}/${total} 个任务完成"`
            ).replace("></i>", `><i style="width:${pct}%"></i></i>`)
          : `<span class="g-unscheduled-chip" style="left:4px">未排期</span>`;
        const rows = list
          .map((t) => {
            const ts = taskSpan(t);
            const owner = member(t.assignee_id);
            return `<div class="g-row" data-task="${t.id}">
              <div class="g-label g-task-label">
                <span class="dot status-${t.status}"></span>
                <span class="g-name" title="${esc(t.title)}">${esc(t.title)}</span>
                ${owner ? avatar(owner, "sm") : ""}
              </div>
              <div class="g-track" style="width:${trackW}px;--week:${7 * dayW}px">
                ${todayLine}
                ${ganttBar(
                  ts,
                  { start },
                  dayW,
                  `task-bar status-${t.status} ${diffDays(ts.start, ts.end) === 0 ? "milestone" : ""}`,
                  `title="${esc(t.title)} · ${shortDate(isoDay(ts.start))}${diffDays(ts.start, ts.end) ? ` – ${shortDate(isoDay(ts.end))}` : ""} · ${TASK_LABEL[t.status]}"`
                )}
              </div>
            </div>`;
          })
          .join("");
        return `<div class="g-row g-group" data-req="${r.id}">
            <div class="g-label g-group-label">
              <span class="dot status-${r.status}"></span>
              <span class="g-name" title="${esc(r.title)}">${esc(r.title)}</span>
              <span class="g-progress">${done}/${total || 0}</span>
            </div>
            <div class="g-track" style="width:${trackW}px;--week:${7 * dayW}px">
              ${todayLine}
              ${bar}
            </div>
          </div>${rows}`;
      })
      .join("");

    const unlinked = scheduled.filter((t) => !t.requirement_id || !requirement(t.requirement_id));
    const unlinkedHTML = unlinked.length
      ? `<div class="g-row g-group">
          <div class="g-label g-group-label"><span class="g-name">未关联需求</span><span class="g-progress">${unlinked.length}</span></div>
          <div class="g-track" style="width:${trackW}px;--week:${7 * dayW}px">${todayLine}</div>
        </div>
        ${unlinked
          .sort((a, b) => taskSpan(a).start - taskSpan(b).start)
          .map((t) => {
            const ts = taskSpan(t);
            const owner = member(t.assignee_id);
            return `<div class="g-row" data-task="${t.id}">
              <div class="g-label g-task-label">
                <span class="dot status-${t.status}"></span>
                <span class="g-name">${esc(t.title)}</span>
                ${owner ? avatar(owner, "sm") : ""}
              </div>
              <div class="g-track" style="width:${trackW}px;--week:${7 * dayW}px">
                ${todayLine}
                ${ganttBar(
                  ts,
                  { start },
                  dayW,
                  `task-bar status-${t.status} ${diffDays(ts.start, ts.end) === 0 ? "milestone" : ""}`,
                  `title="${esc(t.title)} · ${shortDate(isoDay(ts.start))} · ${TASK_LABEL[t.status]}"`
                )}
              </div>
            </div>`;
          })
          .join("")}`
      : "";

    const unscheduledHTML = unscheduled.length
      ? `<div class="gantt-unscheduled">
          <span class="g-unscheduled-title">未排期任务</span>
          <div class="g-chips">
            ${unscheduled
              .map(
                (t) =>
                  `<button type="button" class="g-chip" data-task="${t.id}"><span class="dot status-${t.status}"></span>${esc(t.title)}</button>`
              )
              .join("")}
          </div>
          <span class="g-unscheduled-hint">在任务抽屉里补上开始/截止日期，就会出现在时间轴上</span>
        </div>`
      : "";

    const emptyNote =
      !reqs.length && !tasks.length
        ? q
          ? `<div class="empty-note" style="margin:16px">没有匹配「${esc(state.search)}」的需求或任务。</div>`
          : `<div class="empty-note" style="margin:16px">这个项目还没有需求和任务。先写下要解决什么，再拆出带日期的任务。</div>`
        : "";

    const zoomLabels = [["day", "日"], ["week", "周"], ["month", "月"]];
    return `<div class="gantt-top">
        <div class="gantt-title">
          <h2>${esc(p.name)}</h2>
          <p>${rangeText(start, end)} · ${reqs.length} 个需求 · ${tasks.length} 个任务${unscheduled.length ? ` · ${unscheduled.length} 个未排期` : ""}</p>
        </div>
        <div class="gantt-actions">
          <div class="gantt-legend">
            ${TASK_STATUSES.map((s) => `<span><i class="dot status-${s}"></i>${TASK_LABEL[s]}</span>`).join("")}
          </div>
          <div class="segmented gantt-zoom">
            ${zoomLabels.map(([value, label]) => `<button type="button" class="${zoom === value ? "active" : ""}" data-zoom="${value}">${label}</button>`).join("")}
          </div>
          <button type="button" class="btn btn-ghost" data-action="edit-project"><svg class="icon"><use href="#i-more"/></svg>项目周期</button>
        </div>
      </div>
      ${emptyNote}
      <div class="gantt-scroll">
        <div class="gantt">
          <div class="gantt-head">
            <div class="g-label g-corner"><span>需求 / 任务</span><span class="g-days">${totalDays} 天</span></div>
            <div class="g-head-track" style="width:${trackW}px">
              <div class="g-months">${ganttMonths(start, end, dayW)}</div>
              <div class="g-ticks">${ganttTicks(start, end, dayW, zoom)}</div>
            </div>
          </div>
          <div class="gantt-body">
            ${groups}${unlinkedHTML}
            <div class="g-row g-today-row">
              <div class="g-label g-task-label"><span class="g-name">今天</span><span class="g-progress">${shortDate(isoDay(today))}</span></div>
              <div class="g-track" style="width:${trackW}px;--week:${7 * dayW}px">${todayLine}</div>
            </div>
          </div>
        </div>
      </div>
      ${unscheduledHTML}
      <p class="gantt-foot">横向滚动查看完整周期 · 点击任意条目打开详情 · 日期在任务/需求抽屉里直接修改</p>`;
  }

  // ---------------------------------------------------------------- 需求

  function renderRequirements() {
    const q = state.search.toLowerCase();
    const all = projectRequirements();
    const list = all
      .filter((r) => state.reqFilter === "all" || r.status === state.reqFilter)
      .filter((r) => !q || `${r.title} ${r.description}`.toLowerCase().includes(q));

    const chips = [
      `<button type="button" class="filter-chip ${state.reqFilter === "all" ? "active" : ""}" data-filter="req" data-value="all">全部 <span class="count">${all.length}</span></button>`,
      ...REQ_STATUSES.map((status) => {
        const count = all.filter((r) => r.status === status).length;
        return `<button type="button" class="filter-chip ${state.reqFilter === status ? "active" : ""}" data-filter="req" data-value="${status}">${REQ_LABEL[status]} <span class="count">${count}</span></button>`;
      }),
    ].join("");

    const rows = list.length
      ? list
          .map((r) => {
            const { done, total, pct } = reqProgress(r.id);
            const owner = member(r.owner_id);
            return `<div class="req-item" data-req="${r.id}">
              <span class="pill status-${r.status}"><span class="dot" style="background:currentColor"></span>${REQ_LABEL[r.status]}</span>
              <div class="req-main">
                <div class="req-title">${esc(r.title)}</div>
                <div class="req-desc">${esc(r.description || "还没有说明")}</div>
              </div>
              <div class="req-progress">
                <div class="line"><div class="progress-track"><i style="width:${pct}%"></i></div><span>${done}/${total}</span></div>
                <small>${r.entry_count || 0} 条记录${r.target_date ? ` · 目标 ${shortDate(r.target_date)}` : ""}</small>
              </div>
              <div class="req-owner">${owner ? avatar(owner, "sm") + `<span>${esc(owner.name)}</span>` : `<span style="color:var(--faint)">未指定</span>`}</div>
              <div class="req-updated">${relTime(r.updated_at)}</div>
              <svg class="icon"><use href="#i-chevron"/></svg>
            </div>`;
          })
          .join("")
      : `<div class="empty-note" style="margin:16px">${state.search ? "没有匹配的需求。" : "还没有需求。先写清楚要解决什么，再往下拆任务。"}</div>`;

    return `<div class="req-toolbar">
      <div class="chips">${chips}</div>
      <button type="button" class="btn btn-ghost" data-action="new-req"><svg class="icon"><use href="#i-plus"/></svg>新建需求</button>
    </div>
    <div class="req-list">${rows}</div>`;
  }

  // ---------------------------------------------------------------- 动态

  function matchesEntry(e) {
    if (entryProject(e) !== state.currentProjectId) return false;
    if (state.feedKind !== "all" && e.kind !== state.feedKind) return false;
    if (!state.search) return true;
    const entity =
      e.entity_type === "task" ? state.taskById.get(e.entity_id) : state.reqById.get(e.entity_id);
    return `${e.body} ${entity ? entity.title : ""}`.toLowerCase().includes(state.search.toLowerCase());
  }

  function renderActivity() {
    const all = projectEntries();
    const list = all.filter(matchesEntry);

    const chipDefs = [["all", "全部"], ...KINDS.map((k) => [k, KIND_LABEL[k]]), ["system", "状态"]];
    const chips = chipDefs
      .map(([value, label]) => {
        const count = value === "all" ? all.length : all.filter((e) => e.kind === value).length;
        return `<button type="button" class="filter-chip ${state.feedKind === value ? "active" : ""}" data-filter="feed" data-value="${value}">${label} <span class="count">${count}</span></button>`;
      })
      .join("");

    if (!list.length) {
      return `<div class="activity-wrap">
        <div class="activity-toolbar"><div class="chips">${chips}</div></div>
        <div class="empty-note" style="margin-top:18px"><strong>还没有动态</strong>${state.search ? "换个关键词试试。" : "在任务或需求里记一条进展，这里就会出现。"}</div>
      </div>`;
    }

    const groups = [];
    let current = null;
    for (const entry of list) {
      const key = dayKey(entry.created_at);
      if (!current || current.key !== key) {
        current = { key, label: dayLabel(entry.created_at), items: [] };
        groups.push(current);
      }
      current.items.push(entry);
    }

    const html = groups
      .map(
        (g) =>
          `<div class="feed-day">${g.label}</div><div class="feed">${g.items.map(feedItemHTML).join("")}</div>`
      )
      .join("");

    return `<div class="activity-wrap">
      <div class="activity-toolbar">
        <div class="chips">${chips}</div>
        <span style="font-size:10.5px;color:var(--faint)">最近 ${all.length} 条</span>
      </div>
      ${html}
    </div>`;
  }

  function feedItemHTML(entry) {
    const isTask = entry.entity_type === "task";
    const entity = isTask ? state.taskById.get(entry.entity_id) : state.reqById.get(entry.entity_id);
    const author = member(entry.author_id);
    const kind = entry.kind || "comment";
    const link = entity
      ? `<button type="button" class="entity-link" data-${isTask ? "task" : "req"}="${entity.id}">
          <svg class="icon"><use href="#${isTask ? "i-board" : "i-req"}"/></svg>
          <span>${isTask ? "任务" : "需求"} · ${esc(entity.title)}</span>
        </button>`
      : "";
    return `<div class="feed-item ${kind === "system" ? "system" : ""}">
      ${avatar(author, "sm")}
      <div class="feed-main">
        <div class="feed-head">
          <strong>${author ? esc(author.name) : "系统"}</strong>
          <span class="feed-kind ${kind}">${KIND_LABEL[kind] || "记录"}</span>
          <span class="feed-time">${relTime(entry.created_at)}</span>
        </div>
        <p class="feed-body">${esc(entry.body)}</p>
        ${link}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- 抽屉

  function openEntity(type, id) {
    const entity = type === "task" ? task(id) : requirement(id);
    if (!entity) return;
    const same = state.drawer && state.drawer.type === type && state.drawer.id === Number(id);
    if (!same) {
      state.drawerReady = false;
      state.drawerEntries = null;
    }
    state.drawer = { type, id: Number(id) };
    renderDrawer();
    syncScrollLock();
    loadDrawerEntries();
  }

  async function loadDrawerEntries() {
    const wanted = state.drawer;
    if (!wanted) return;
    try {
      const res = await api(`/api/entries?entity_type=${wanted.type}&entity_id=${wanted.id}`);
      if (
        state.drawer &&
        state.drawer.type === wanted.type &&
        state.drawer.id === wanted.id
      ) {
        state.drawerEntries = res.entries;
        renderDrawer();
      }
    } catch (err) {
      // 记录加载失败不阻塞主流程
    }
  }

  function closeDrawer() {
    const active = document.activeElement;
    if (active && drawerRoot.contains(active) && active.matches("textarea[data-field]")) {
      saveDrawerField(active.dataset.field, active.value);
    }
    clearTimeout(fieldSaveTimer);
    fieldSaveTimer = null;
    state.drawer = null;
    state.drawerEntries = null;
    state.drawerReady = false;
    drawerRoot.innerHTML = "";
    syncScrollLock();
  }

  function renderDrawer() {
    const d = state.drawer;
    if (!d) {
      drawerRoot.innerHTML = "";
      return;
    }
    const entity = d.type === "task" ? task(d.id) : requirement(d.id);
    if (!entity) {
      closeDrawer();
      return;
    }

    const active = document.activeElement;
    const activeField = active && drawerRoot.contains(active) ? active.dataset.field || "" : "";
    const activeCaret = activeField && active.selectionStart != null ? active.selectionStart : null;
    const activeValue =
      activeField && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") ? active.value : null;

    const readyClass = state.drawerReady ? " ready" : "";
    const html =
      d.type === "task"
        ? taskDrawerHTML(entity, readyClass)
        : requirementDrawerHTML(entity, readyClass);
    drawerRoot.innerHTML = html;
    state.drawerReady = true;

    const titleEl = drawerRoot.querySelector(".drawer-title");
    autosize(titleEl);
    const composer = drawerRoot.querySelector("[data-composer]");
    if (composer) composer.value = state.drafts.get(`${d.type}:${d.id}`) || "";

    if (activeField) {
      const target =
        activeField === "composer"
          ? composer
          : drawerRoot.querySelector(`[data-field="${activeField}"]`);
      if (target) {
        target.focus();
        if (activeValue != null && target.value !== activeValue) target.value = activeValue;
        if (activeCaret != null && target.setSelectionRange) {
          try {
            target.setSelectionRange(activeCaret, activeCaret);
          } catch (err) {
            /* 忽略 */
          }
        }
        if (target.tagName === "TEXTAREA") autosize(target);
      }
    }
  }

  function requirementOptions(selectedId) {
    const list = projectRequirements();
    const current = requirement(selectedId);
    if (current && !list.some((r) => r.id === current.id)) list.unshift(current);
    return list
      .map((r) => `<option value="${r.id}" ${r.id === selectedId ? "selected" : ""}>${esc(r.title)}</option>`)
      .join("");
  }

  function taskDrawerHTML(t, readyClass) {
    const req = requirement(t.requirement_id);
    const owner = member(t.assignee_id);
    return `<div class="drawer-backdrop${readyClass}" data-action="close-drawer"></div>
      <aside class="drawer${readyClass}" role="dialog" aria-modal="true" aria-label="任务详情">
        <div class="drawer-head">
          <span class="drawer-type"><svg class="icon"><use href="#i-board"/></svg>任务</span>
          <span class="spacer"></span>
          <span class="drawer-saved" data-saved>已保存</span>
          <button type="button" class="icon-btn" data-menu="drawer-task" data-task="${t.id}" aria-label="更多操作"><svg class="icon"><use href="#i-more"/></svg></button>
          <button type="button" class="icon-btn" data-action="close-drawer" aria-label="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
        </div>
        <div class="drawer-body">
          <textarea class="drawer-title" data-field="title" rows="1" maxlength="120" placeholder="任务标题">${esc(t.title)}</textarea>
          <div class="drawer-tags">
            <span class="pill status-${t.status}"><span class="dot" style="background:currentColor"></span>${TASK_LABEL[t.status]}</span>
            <span class="prio prio-${t.priority.toLowerCase()}">${t.priority}</span>
            ${req ? `<button type="button" class="req-tag" style="border:0;height:21px" data-req="${req.id}"><svg class="icon"><use href="#i-link"/></svg>${esc(req.title)}</button>` : ""}
          </div>

          <div class="field-grid">
            <div class="field"><label>状态</label>
              <select data-field="status">${TASK_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${TASK_LABEL[s]}</option>`).join("")}</select>
            </div>
            <div class="field"><label>优先级</label>
              <select data-field="priority">${PRIORITIES.map((p) => `<option value="${p}" ${p === t.priority ? "selected" : ""}>${p}</option>`).join("")}</select>
            </div>
            <div class="field"><label>负责人</label>
              <select data-field="assignee_id">
                <option value="">暂不指定</option>
                ${state.data.members.map((m) => `<option value="${m.id}" ${m.id === t.assignee_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field"><label>开始日期</label>
              <input type="date" data-field="start_date" value="${t.start_date || ""}">
            </div>
            <div class="field"><label>截止日期</label>
              <input type="date" data-field="due_date" value="${t.due_date || ""}">
            </div>
            <div class="field full"><label>所属需求</label>
              <select data-field="requirement_id">
                <option value="">不关联需求</option>
                ${requirementOptions(t.requirement_id)}
              </select>
            </div>
          </div>

          <div class="drawer-desc-label"><span>说明</span><span>失焦自动保存</span></div>
          <textarea class="drawer-desc" data-field="description" maxlength="4000" placeholder="补充背景、验收标准，或者一个链接…">${esc(t.description)}</textarea>

          <div class="drawer-section">
            <div class="drawer-section-head">
              <h3>记录</h3>
              <span class="count">${state.drawerEntries ? state.drawerEntries.length : ""}</span>
            </div>
            ${composerHTML()}
            ${timelineHTML()}
          </div>

          <p style="margin-top:22px;color:var(--faint);font-size:10px;line-height:1.7">
            由 ${owner ? esc(owner.name) : "未指定负责人"} 负责 · 创建于 ${relTime(t.created_at)}
          </p>
        </div>
      </aside>`;
  }

  function requirementDrawerHTML(r, readyClass) {
    const owner = member(r.owner_id);
    const { done, total, pct } = reqProgress(r.id);
    const linked = reqTasks(r.id);
    const linkedHTML = linked.length
      ? linked
          .map(
            (t) => `<div class="linked-task ${t.status === "done" ? "done" : ""}" data-task="${t.id}">
              <span class="dot status-${t.status}"></span>
              <span>${esc(t.title)}</span>
              ${member(t.assignee_id) ? avatar(member(t.assignee_id), "sm") : ""}
            </div>`
          )
          .join("")
      : `<div class="drawer-empty" style="padding:12px 0">还没有任务挂在需求下。</div>`;

    return `<div class="drawer-backdrop${readyClass}" data-action="close-drawer"></div>
      <aside class="drawer${readyClass}" role="dialog" aria-modal="true" aria-label="需求详情">
        <div class="drawer-head">
          <span class="drawer-type"><svg class="icon"><use href="#i-req"/></svg>需求</span>
          <span class="spacer"></span>
          <span class="drawer-saved" data-saved>已保存</span>
          <button type="button" class="icon-btn" data-menu="drawer-req" data-req="${r.id}" aria-label="更多操作"><svg class="icon"><use href="#i-more"/></svg></button>
          <button type="button" class="icon-btn" data-action="close-drawer" aria-label="关闭"><svg class="icon"><use href="#i-close"/></svg></button>
        </div>
        <div class="drawer-body">
          <textarea class="drawer-title" data-field="title" rows="1" maxlength="120" placeholder="需求标题">${esc(r.title)}</textarea>
          <div class="drawer-tags">
            <span class="pill status-${r.status}"><span class="dot" style="background:currentColor"></span>${REQ_LABEL[r.status]}</span>
            <span class="prio prio-${r.priority.toLowerCase()}">${r.priority}</span>
            <span style="font-size:10.5px;color:var(--faint)">${done}/${total} 个任务完成</span>
          </div>

          <div class="field-grid">
            <div class="field"><label>状态</label>
              <select data-field="status">${REQ_STATUSES.map((s) => `<option value="${s}" ${s === r.status ? "selected" : ""}>${REQ_LABEL[s]}</option>`).join("")}</select>
            </div>
            <div class="field"><label>优先级</label>
              <select data-field="priority">${PRIORITIES.map((p) => `<option value="${p}" ${p === r.priority ? "selected" : ""}>${p}</option>`).join("")}</select>
            </div>
            <div class="field"><label>负责人</label>
              <select data-field="owner_id">
                <option value="">暂不指定</option>
                ${state.data.members.map((m) => `<option value="${m.id}" ${m.id === r.owner_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field"><label>开始日期</label>
              <input type="date" data-field="start_date" value="${r.start_date || ""}">
            </div>
            <div class="field"><label>目标日期</label>
              <input type="date" data-field="target_date" value="${r.target_date || ""}">
            </div>
          </div>

          <div class="drawer-desc-label"><span>说明</span><span>失焦自动保存</span></div>
          <textarea class="drawer-desc" data-field="description" maxlength="4000" placeholder="这个需求要解决什么问题？范围是什么？">${esc(r.description)}</textarea>

          <div class="drawer-section">
            <div class="drawer-section-head">
              <h3>关联任务</h3>
              <span class="count">${done}/${total}</span>
            </div>
            <div class="req-progress" style="margin:2px 0 8px">
              <div class="line"><div class="progress-track"><i style="width:${pct}%"></i></div><span>${pct}%</span></div>
            </div>
            <div>${linkedHTML}</div>
            <div class="linked-add">
              <input type="text" data-linked-input maxlength="120" placeholder="输入任务标题，回车创建并关联">
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-head">
              <h3>记录</h3>
              <span class="count">${state.drawerEntries ? state.drawerEntries.length : ""}</span>
            </div>
            ${composerHTML()}
            ${timelineHTML()}
          </div>

          <p style="margin-top:22px;color:var(--faint);font-size:10px;line-height:1.7">
            由 ${owner ? esc(owner.name) : "未指定负责人"} 负责 · 创建于 ${relTime(r.created_at)}
          </p>
        </div>
      </aside>`;
  }

  function composerHTML() {
    return `<div class="composer">
      <textarea data-composer maxlength="2000" placeholder="记一条进展、阻塞或决定…"></textarea>
      <div class="composer-foot">
        <div class="kind-tabs">
          ${KINDS.map(
            (k) =>
              `<button type="button" class="kind-tab k-${k} ${state.composerKind === k ? "active" : ""}" data-kind="${k}">${KIND_LABEL[k]}</button>`
          ).join("")}
        </div>
        <span class="spacer"></span>
        <span class="composer-hint">Ctrl + Enter</span>
        <button type="button" class="btn btn-primary" data-action="submit-entry">记录</button>
      </div>
    </div>`;
  }

  function timelineHTML() {
    if (!state.drawerEntries) return `<div class="drawer-empty">载入记录…</div>`;
    if (!state.drawerEntries.length)
      return `<div class="drawer-empty">还没有记录。第一条进展、阻塞或决定会出现在这里。</div>`;
    return `<div class="timeline">${state.drawerEntries
      .map((entry) => {
        const author = member(entry.author_id);
        const kind = entry.kind || "comment";
        return `<div class="tl-item ${kind === "system" ? "system" : ""}">
          ${avatar(author, "sm")}
          <div class="tl-main">
            <div class="tl-head">
              <strong>${author ? esc(author.name) : "系统"}</strong>
              ${kind !== "comment" ? `<span class="tl-kind ${kind}">${KIND_LABEL[kind] || ""}</span>` : ""}
              <time>${relTime(entry.created_at)}</time>
            </div>
            <p class="tl-body">${esc(entry.body)}</p>
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function autosize(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  function flashSaved() {
    const el = drawerRoot.querySelector("[data-saved]");
    if (!el) return;
    el.classList.add("show");
    clearTimeout(flashSaved.timer);
    flashSaved.timer = setTimeout(() => el.classList.remove("show"), 1400);
  }

  // ---------------------------------------------------------------- 抽屉行为

  async function saveDrawerField(field, rawValue) {
    const d = state.drawer;
    if (!d) return;
    const entity = d.type === "task" ? task(d.id) : requirement(d.id);
    if (!entity) return;

    let value = rawValue;
    if (field === "title") {
      value = String(rawValue || "").trim();
      if (!value) {
        toast("标题不能为空", true);
        renderDrawer();
        return;
      }
    }

    const idField = field === "assignee_id" || field === "requirement_id" || field === "owner_id";
    const dateField = field === "due_date" || field === "target_date" || field === "start_date";
    const bodyValue = idField ? (value ? Number(value) : null) : dateField ? value || null : value;
    const current = entity[field] == null ? null : entity[field];
    if (String(current == null ? "" : current) === String(bodyValue == null ? "" : bodyValue)) return;

    try {
      const path = d.type === "task" ? `/api/tasks/${d.id}` : `/api/requirements/${d.id}`;
      const data = await api(path, {
        method: "PATCH",
        body: { [field]: bodyValue, actor_id: state.identity },
      });
      applyState(data);
      await loadDrawerEntries();
      render();
      flashSaved();
    } catch (err) {
      toast(err.message, true);
      renderDrawer();
    }
  }

  async function submitEntry() {
    const d = state.drawer;
    if (!d) return;
    const ta = drawerRoot.querySelector("[data-composer]");
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    if (!requireIdentity()) return;

    const button = drawerRoot.querySelector('[data-action="submit-entry"]');
    if (button) button.disabled = true;
    try {
      const data = await api("/api/entries", {
        method: "POST",
        body: {
          entity_type: d.type,
          entity_id: d.id,
          kind: state.composerKind,
          body: text,
          actor_id: state.identity,
        },
      });
      applyState(data);
      state.drafts.set(`${d.type}:${d.id}`, "");
      await loadDrawerEntries();
      render();
      const fresh = drawerRoot.querySelector("[data-composer]");
      if (fresh) fresh.focus();
    } catch (err) {
      toast(err.message, true);
    } finally {
      const btn = drawerRoot.querySelector('[data-action="submit-entry"]');
      if (btn) btn.disabled = false;
    }
  }

  async function createLinkedTask(title) {
    const d = state.drawer;
    if (!d || d.type !== "requirement") return;
    if (!requireIdentity()) return;
    const req = requirement(d.id);
    if (!req) return;
    try {
      const data = await api("/api/tasks", {
        method: "POST",
        body: {
          title,
          status: "todo",
          assignee_id: state.identity,
          requirement_id: d.id,
          project_id: req.project_id,
          actor_id: state.identity,
        },
      });
      applyState(data);
      render();
      toast("已添加任务");
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- 弹层

  function openModal(html, { wide = false } = {}) {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop>
      <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>
    </div>`;
    syncScrollLock();
    setTimeout(() => {
      const first =
        modalRoot.querySelector("[autofocus]") ||
        modalRoot.querySelector("input, textarea, select");
      if (first) first.focus();
    }, 30);
  }

  function closeModal() {
    modalRoot.innerHTML = "";
    state.confirmAction = null;
    syncScrollLock();
  }

  function requestNewTask() {
    if (!requireIdentity()) return;
    openTaskModal();
  }

  function requireIdentity() {
    if (state.identity && state.memberById.has(state.identity)) return true;
    openIdentityModal();
    return false;
  }

  function openIdentityModal() {
    const rows = state.data.members
      .map(
        (m) => `<button type="button" class="identity-row ${m.id === state.identity ? "active" : ""}" data-identity="${m.id}">
          ${avatar(m, "lg")}
          <span class="who"><strong>${esc(m.name)}</strong><span>${m.id === state.identity ? "当前身份" : "切换为这个身份"}</span></span>
          ${m.id === state.identity ? `<span class="check"><svg class="icon"><use href="#i-check"/></svg></span>` : ""}
        </button>`
      )
      .join("");

    openModal(`<div class="modal-head">
        <h2>你是哪位？</h2>
        <p>选一个身份，之后的进展、阻塞和决定都会记在你名下。不需要密码。</p>
      </div>
      <div class="modal-body">
        ${rows ? `<div class="identity-list">${rows}</div>` : `<div class="empty-note">还没有成员，先在下面加一个。</div>`}
        <form class="identity-add" data-form="member">
          <input name="name" maxlength="20" placeholder="新成员昵称" autocomplete="off" autofocus>
          <button type="submit" class="btn btn-ghost"><svg class="icon"><use href="#i-user-plus"/></svg>加入</button>
        </form>
      </div>
      <div class="modal-foot"><span class="spacer"></span><button type="button" class="btn btn-quiet" data-action="close-modal">先随便看看</button></div>`);
  }

  function openTaskModal(preset = {}) {
    if (!currentProject()) {
      openProjectModal();
      return;
    }
    const ownerDefault = state.identity || "";
    openModal(`<form data-form="task">
      <div class="modal-head"><h2>新建任务</h2><p>先写清楚要做什么，需求和负责人可以稍后再补。</p></div>
      <div class="modal-body">
        <div class="form-row">
          <label>任务标题</label>
          <input class="big" name="title" maxlength="120" required placeholder="例如：把看板的拖拽体验再顺一下" autofocus>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>关联需求</label>
            <select name="requirement_id">
              <option value="">暂不关联</option>
              ${requirementOptions(preset.requirement_id || "")}
            </select>
          </div>
          <div class="form-row"><label>负责人</label>
            <select name="assignee_id">
              <option value="">暂不指定</option>
              ${state.data.members.map((m) => `<option value="${m.id}" ${String(m.id) === String(ownerDefault) ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
            </select>
          </div>
          <div class="form-row"><label>状态</label>
            <select name="status">${TASK_STATUSES.map((s) => `<option value="${s}" ${s === "todo" ? "selected" : ""}>${TASK_LABEL[s]}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>优先级</label>
            <select name="priority">${PRIORITIES.map((p) => `<option value="${p}" ${p === "P2" ? "selected" : ""}>${p}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>开始日期</label><input type="date" name="start_date"></div>
          <div class="form-row"><label>截止日期</label><input type="date" name="due_date"></div>
        </div>
        <div class="form-row"><label>补充说明</label><textarea name="description" maxlength="4000" placeholder="可选。背景、验收标准、链接…"></textarea></div>
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn btn-quiet" data-action="close-modal">取消</button>
        <button type="submit" class="btn btn-primary">创建任务</button>
      </div>
    </form>`);
  }

  function openReqModal() {
    if (!currentProject()) {
      openProjectModal();
      return;
    }
    openModal(`<form data-form="requirement">
      <div class="modal-head"><h2>新建需求</h2><p>一个需求说清一件事。任务都挂到需求下，进度才有意义。</p></div>
      <div class="modal-body">
        <div class="form-row">
          <label>需求标题</label>
          <input class="big" name="title" maxlength="120" required placeholder="例如：新人能在五分钟内加入" autofocus>
        </div>
        <div class="form-row"><label>说明</label>
          <textarea name="description" maxlength="4000" placeholder="要解决什么问题？不做什么？"></textarea>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>状态</label>
            <select name="status">${REQ_STATUSES.map((s) => `<option value="${s}" ${s === "discussing" ? "selected" : ""}>${REQ_LABEL[s]}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>优先级</label>
            <select name="priority">${PRIORITIES.map((p) => `<option value="${p}" ${p === "P2" ? "selected" : ""}>${p}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>负责人</label>
            <select name="owner_id">
              <option value="">暂不指定</option>
              ${state.data.members.map((m) => `<option value="${m.id}" ${m.id === state.identity ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
            </select>
          </div>
          <div class="form-row"><label>开始日期</label><input type="date" name="start_date"></div>
          <div class="form-row"><label>目标日期</label><input type="date" name="target_date"></div>
        </div>
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn btn-quiet" data-action="close-modal">取消</button>
        <button type="submit" class="btn btn-primary">创建需求</button>
      </div>
    </form>`);
  }

  function openProjectModal(project = null) {
    const p = project || null;
    const color = (p && p.color) || PROJECT_COLORS[0];
    const swatches = PROJECT_COLORS.map(
      (c) =>
        `<button type="button" class="swatch ${c === color ? "active" : ""}" data-color="${c}" style="--sw:${c}" aria-label="项目颜色 ${c}"></button>`
    ).join("");
    openModal(`<form data-form="project">
      <input type="hidden" name="project_id" value="${p ? p.id : ""}">
      <input type="hidden" name="color" value="${color}">
      <div class="modal-head">
        <h2>${p ? "项目设置" : "新建项目"}</h2>
        <p>${p ? "调整名称、周期或颜色，改完立即生效。" : "一个项目对应一件事。项目经理可以同时参与多个项目，随时在顶部切换。"}</p>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>项目名称</label>
          <input class="big" name="name" maxlength="60" required placeholder="例如：客户门户 2.0" value="${p ? esc(p.name) : ""}" autofocus>
        </div>
        <div class="form-row">
          <label>一句话说明</label>
          <input name="description" maxlength="200" placeholder="可选。这个项目要达成什么？" value="${p ? esc(p.description) : ""}">
        </div>
        <div class="form-grid">
          <div class="form-row"><label>开始日期</label><input type="date" name="start_date" value="${p && p.start_date ? p.start_date : ""}"></div>
          <div class="form-row"><label>目标日期</label><input type="date" name="target_date" value="${p && p.target_date ? p.target_date : ""}"></div>
        </div>
        <div class="form-row"><label>项目颜色</label><div class="swatch-row">${swatches}</div></div>
      </div>
      <div class="modal-foot">
        ${p ? `<button type="button" class="btn btn-quiet" data-action="delete-project" data-project="${p.id}">删除项目</button>` : ""}
        <span class="spacer"></span>
        <button type="button" class="btn btn-quiet" data-action="close-modal">取消</button>
        <button type="submit" class="btn btn-primary">${p ? "保存设置" : "创建项目"}</button>
      </div>
    </form>`);
  }

  function confirmDelete(kind, id, title) {
    const label = kind === "task" ? "任务" : kind === "requirement" ? "需求" : "项目";
    const note =
      kind === "requirement"
        ? "下的任务会保留，但不再关联这个需求。"
        : kind === "project"
          ? "只有在项目里没有需求和任务时才能删除。"
          : "的记录也会一起删除。";
    state.confirmAction = async () => {
      closeModal();
      try {
        const path =
          kind === "task"
            ? `/api/tasks/${id}`
            : kind === "requirement"
              ? `/api/requirements/${id}`
              : `/api/projects/${id}`;
        const data = await api(path, { method: "DELETE" });
        applyState(data);
        closeDrawer();
        render();
        toast(`${label}已删除`);
      } catch (err) {
        toast(err.message, true);
      }
    };
    openModal(`<div class="modal-head">
        <h2>删除${label}？</h2>
        <p>「${esc(title)}」${note}这个操作不能撤销。</p>
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-action="close-modal">取消</button>
        <button type="button" class="btn btn-danger" data-action="do-delete">删除${label}</button>
      </div>`);
  }

  async function handleModalForm(form) {
    const kind = form.dataset.form;
    if (kind === "member") {
      const input = form.querySelector('input[name="name"]');
      const name = (input.value || "").trim();
      if (!name) {
        input.focus();
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const data = await api("/api/members", { method: "POST", body: { name } });
        applyState(data);
        state.identity = data.created_id;
        localStorage.setItem(IDENTITY_KEY, String(state.identity));
        closeModal();
        render();
        toast(`欢迎，${name}`);
      } catch (err) {
        toast(err.message, true);
        submit.disabled = false;
      }
      return;
    }

    if (!requireIdentity()) return;
    const fd = new FormData(form);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;

    try {
      let data;
      if (kind === "project") {
        const projectId = fd.get("project_id");
        const body = {
          name: fd.get("name"),
          description: fd.get("description") || "",
          color: fd.get("color"),
          start_date: fd.get("start_date") || null,
          target_date: fd.get("target_date") || null,
          actor_id: state.identity,
        };
        if (projectId) {
          data = await api(`/api/projects/${projectId}`, { method: "PATCH", body });
          applyState(data);
          closeModal();
          render();
          toast("项目设置已保存");
        } else {
          data = await api("/api/projects", { method: "POST", body });
          applyState(data);
          closeModal();
          switchProject(data.created_id);
          toast("项目已创建");
        }
      } else if (kind === "task") {
        data = await api("/api/tasks", {
          method: "POST",
          body: {
            title: fd.get("title"),
            description: fd.get("description") || "",
            status: fd.get("status"),
            priority: fd.get("priority"),
            assignee_id: fd.get("assignee_id") || null,
            requirement_id: fd.get("requirement_id") || null,
            project_id: state.currentProjectId,
            start_date: fd.get("start_date") || null,
            due_date: fd.get("due_date") || null,
            actor_id: state.identity,
          },
        });
        const createdId = data.created_id;
        applyState(data);
        closeModal();
        render();
        openEntity("task", createdId);
        toast("任务已创建");
      } else if (kind === "requirement") {
        data = await api("/api/requirements", {
          method: "POST",
          body: {
            title: fd.get("title"),
            description: fd.get("description") || "",
            status: fd.get("status"),
            priority: fd.get("priority"),
            owner_id: fd.get("owner_id") || null,
            project_id: state.currentProjectId,
            start_date: fd.get("start_date") || null,
            target_date: fd.get("target_date") || null,
            actor_id: state.identity,
          },
        });
        const createdId = data.created_id;
        applyState(data);
        closeModal();
        render();
        openEntity("requirement", createdId);
        toast("需求已创建");
      }
    } catch (err) {
      toast(err.message, true);
      submit.disabled = false;
    }
  }

  function pickIdentity(id) {
    const m = member(id);
    if (!m) return;
    state.identity = m.id;
    localStorage.setItem(IDENTITY_KEY, String(m.id));
    closeModal();
    render();
    toast(`当前身份：${m.name}`);
  }

  // ---------------------------------------------------------------- 菜单

  function closeMenu() {
    menuRoot.innerHTML = "";
    state.menu = null;
  }

  function showMenu(items, anchorRect, onPick) {
    closeMenu();
    const html = items
      .map((item, index) => {
        if (item.sep) return `<div class="menu-sep"></div>`;
        if (item.heading) return `<div class="menu-label">${esc(item.label)}</div>`;
        return `<button type="button" class="menu-item ${item.danger ? "danger" : ""}" data-index="${index}" ${item.disabled ? "disabled" : ""}>
          ${item.swatch ? `<span class="menu-swatch" style="background:${item.swatch}"></span>` : item.dot ? `<span class="dot status-${item.dot}"></span>` : item.icon ? `<svg class="icon"><use href="#${item.icon}"/></svg>` : ""}
          ${esc(item.label)}
        </button>`;
      })
      .join("");
    menuRoot.innerHTML = `<div class="menu" role="menu">${html}</div>`;
    const menu = menuRoot.firstElementChild;
    const rect = menu.getBoundingClientRect();
    let left = anchorRect.right - rect.width;
    let top = anchorRect.bottom + 6;
    if (left < 8) left = 8;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - rect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    state.menu = { items, onPick };
  }

  function taskMenu(taskId, anchorRect) {
    const t = task(taskId);
    if (!t) return;
    const items = [
      { label: "任务", heading: true },
      { label: "打开详情", action: "open", icon: "i-board" },
      { sep: true },
      { label: "移动到", heading: true },
      ...TASK_STATUSES.map((s) => ({
        label: TASK_LABEL[s],
        action: "status",
        value: s,
        dot: s,
        disabled: s === t.status,
      })),
      { sep: true },
      { label: "删除任务", action: "delete", icon: "i-trash", danger: true },
    ];
    showMenu(items, anchorRect, async (item) => {
      if (item.action === "open") {
        openEntity("task", taskId);
      } else if (item.action === "status") {
        try {
          const data = await api(`/api/tasks/${taskId}`, {
            method: "PATCH",
            body: { status: item.value, actor_id: state.identity },
          });
          applyState(data);
          render();
          toast(`已移到${TASK_LABEL[item.value]}`);
        } catch (err) {
          toast(err.message, true);
        }
      } else if (item.action === "delete") {
        confirmDelete("task", taskId, t.title);
      }
    });
  }

  function drawerMenu(kind, id, anchorRect) {
    const entity = kind === "task" ? task(id) : requirement(id);
    if (!entity) return;
    showMenu(
      [
        { label: kind === "task" ? "任务" : "需求", heading: true },
        { label: "打开详情", action: "open", icon: kind === "task" ? "i-board" : "i-req" },
        { sep: true },
        { label: `删除${kind === "task" ? "任务" : "需求"}`, action: "delete", icon: "i-trash", danger: true },
      ],
      anchorRect,
      (item) => {
        if (item.action === "open") openEntity(kind, id);
        else if (item.action === "delete") confirmDelete(kind, id, entity.title);
      }
    );
  }

  function switchProject(id) {
    const p = project(id);
    if (!p) return;
    state.currentProjectId = p.id;
    localStorage.setItem(PROJECT_KEY, String(p.id));
    closeDrawer();
    closeModal();
    closeMenu();
    render();
    toast(`切换到「${p.name}」`);
  }

  function projectMenu(anchorRect) {
    const items = [{ label: "项目", heading: true }];
    state.data.projects
      .slice()
      .sort((a, b) => a.id - b.id)
      .forEach((p) => {
        items.push({
          label: `${p.name}${p.id === state.currentProjectId ? " ✓" : ""}`,
          swatch: p.color || "#8a8f84",
          action: "switch",
          value: p.id,
        });
      });
    items.push({ sep: true }, { label: "新建项目", action: "new", icon: "i-plus" });
    const cur = currentProject();
    if (cur) items.push({ label: "项目设置", action: "edit", icon: "i-more" });
    showMenu(items, anchorRect, (item) => {
      if (item.action === "switch") switchProject(item.value);
      else if (item.action === "new") openProjectModal();
      else if (item.action === "edit" && cur) openProjectModal(cur);
    });
  }

  // ---------------------------------------------------------------- 看板交互

  function openQuickAdd(status) {
    if (!requireIdentity()) return;
    if (!currentProject()) {
      openProjectModal();
      return;
    }
    const body = viewEl.querySelector(`.column[data-status="${status}"] .column-body`);
    if (!body) return;
    const existing = body.querySelector(".quick-add input");
    if (existing) {
      existing.focus();
      return;
    }
    const form = document.createElement("form");
    form.className = "quick-add";
    form.innerHTML = `<input type="text" maxlength="120" placeholder="任务标题，回车创建" aria-label="任务标题">`;
    const empty = body.querySelector(".column-empty");
    if (empty) body.insertBefore(form, empty);
    else body.appendChild(form);

    const input = form.querySelector("input");
    input.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) {
        form.remove();
        return;
      }
      input.disabled = true;
      try {
        const data = await api("/api/tasks", {
          method: "POST",
          body: { title, status, project_id: state.currentProjectId, actor_id: state.identity },
        });
        applyState(data);
        render();
        toast("任务已创建");
      } catch (err) {
        toast(err.message, true);
        input.disabled = false;
        input.focus();
      }
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        form.remove();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!input.value.trim() && form.isConnected) form.remove();
      }, 120);
    });
  }

  function getDragAfterElement(container, y) {
    const cards = $$(".card:not(.dragging)", container);
    return cards.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  }

  async function commitReorder() {
    const columns = {};
    $$(".column", viewEl).forEach((col) => {
      columns[col.dataset.status] = $$(".card", col.querySelector(".column-body")).map((c) =>
        Number(c.dataset.task)
      );
    });
    try {
      const data = await api("/api/reorder", {
        method: "POST",
        body: { columns, actor_id: state.identity },
      });
      applyState(data);
      render();
    } catch (err) {
      toast(err.message, true);
      await refresh({ silent: true });
    }
  }

  // ---------------------------------------------------------------- 事件绑定

  function go(view) {
    if (!VIEW_META[view]) return;
    state.view = view;
    closeDrawer();
    closeMenu();
    try {
      history.replaceState(null, "", `#${view}`);
    } catch (err) {
      location.hash = view;
    }
    render();
    window.scrollTo({ top: 0 });
  }

  function onViewClick(event) {
    const menuBtn = event.target.closest("[data-menu]");
    if (menuBtn) {
      event.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      if (menuBtn.dataset.menu === "task") taskMenu(Number(menuBtn.dataset.task), rect);
      else if (menuBtn.dataset.menu === "drawer-task")
        drawerMenu("task", Number(menuBtn.dataset.task), rect);
      else if (menuBtn.dataset.menu === "drawer-req")
        drawerMenu("requirement", Number(menuBtn.dataset.req), rect);
      return;
    }

    const quick = event.target.closest("[data-quick]");
    if (quick) {
      openQuickAdd(quick.dataset.quick);
      return;
    }

    const filter = event.target.closest("[data-filter]");
    if (filter) {
      const group = filter.dataset.filter;
      if (group === "req") state.reqFilter = filter.dataset.value;
      else if (group === "feed") state.feedKind = filter.dataset.value;
      render();
      return;
    }

    const goBtn = event.target.closest("[data-go]");
    if (goBtn) {
      go(goBtn.dataset.go);
      return;
    }

    const zoomBtn = event.target.closest("[data-zoom]");
    if (zoomBtn) {
      state.ganttZoom = zoomBtn.dataset.zoom;
      render();
      return;
    }

    const actionBtn = event.target.closest("[data-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === "new-project") {
        openProjectModal();
        return;
      }
      if (action === "edit-project") {
        openProjectModal(currentProject());
        return;
      }
      if (action === "toggle-my") {
        if (!state.identity) {
          openIdentityModal();
          return;
        }
        state.myOnly = !state.myOnly;
        render();
        return;
      }
      if (action === "new-task") {
        requestNewTask();
        return;
      }
      if (action === "new-req") {
        openReqModal();
        return;
      }
      if (action === "open-identity") {
        openIdentityModal();
        return;
      }
    }

    const reqEl = event.target.closest("[data-req]");
    if (reqEl) {
      openEntity("requirement", Number(reqEl.dataset.req));
      return;
    }

    const taskEl = event.target.closest("[data-task]");
    if (taskEl) {
      openEntity("task", Number(taskEl.dataset.task));
    }
  }

  function onViewDragStart(event) {
    const card = event.target.closest(".card");
    if (!card || card.getAttribute("draggable") !== "true") return;
    state.dragId = Number(card.dataset.task);
    state.dropHandled = false;
    card.classList.add("dragging");
    try {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(state.dragId));
    } catch (err) {
      /* 忽略 */
    }
  }

  function onViewDragOver(event) {
    if (!state.dragId) return;
    const body = event.target.closest(".column-body");
    if (!body) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    $$(".column-body.drag-over", viewEl).forEach((el) => {
      if (el !== body) el.classList.remove("drag-over");
    });
    body.classList.add("drag-over");

    const card = viewEl.querySelector(`.card[data-task="${state.dragId}"]`);
    if (!card) return;
    const after = getDragAfterElement(body, event.clientY);
    const empty = body.querySelector(".column-empty");
    if (after) body.insertBefore(card, after);
    else if (empty) body.insertBefore(card, empty);
    else body.appendChild(card);
  }

  function onViewDrop(event) {
    if (!state.dragId) return;
    event.preventDefault();
    state.dropHandled = true;
    $$(".column-body.drag-over", viewEl).forEach((el) => el.classList.remove("drag-over"));
    commitReorder();
  }

  function onViewDragEnd(event) {
    const card = event.target.closest(".card");
    if (card) card.classList.remove("dragging");
    $$(".column-body.drag-over", viewEl).forEach((el) => el.classList.remove("drag-over"));
    const id = state.dragId;
    state.dragId = null;
    if (!state.dropHandled && id != null) {
      // 没落到任何列，回到原位
      render();
    }
  }

  function onDrawerClick(event) {
    const menuBtn = event.target.closest("[data-menu]");
    if (menuBtn) {
      event.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      if (menuBtn.dataset.menu === "drawer-task")
        drawerMenu("task", Number(menuBtn.dataset.task), rect);
      else if (menuBtn.dataset.menu === "drawer-req")
        drawerMenu("requirement", Number(menuBtn.dataset.req), rect);
      return;
    }

    if (event.target.closest("[data-action='close-drawer']")) {
      closeDrawer();
      return;
    }

    const kindBtn = event.target.closest("[data-kind]");
    if (kindBtn) {
      state.composerKind = kindBtn.dataset.kind;
      $$(".kind-tab", drawerRoot).forEach((b) =>
        b.classList.toggle("active", b === kindBtn)
      );
      return;
    }

    if (event.target.closest("[data-action='submit-entry']")) {
      submitEntry();
      return;
    }

    const reqEl = event.target.closest("[data-req]");
    if (reqEl) {
      openEntity("requirement", Number(reqEl.dataset.req));
      return;
    }

    const taskEl = event.target.closest("[data-task]");
    if (taskEl) {
      openEntity("task", Number(taskEl.dataset.task));
    }
  }

  function onDrawerChange(event) {
    const field = event.target.closest("[data-field]");
    if (!field || field.tagName === "TEXTAREA") return;
    saveDrawerField(field.dataset.field, field.value);
  }

  function onDrawerFocusOut(event) {
    const field = event.target.closest("textarea[data-field]");
    if (!field) return;
    clearTimeout(fieldSaveTimer);
    fieldSaveTimer = null;
    saveDrawerField(field.dataset.field, field.value);
  }

  function onDrawerInput(event) {
    const target = event.target;
    if (target.matches("[data-composer]")) {
      const d = state.drawer;
      if (d) state.drafts.set(`${d.type}:${d.id}`, target.value);
      return;
    }
    if (target.matches(".drawer-title")) autosize(target);
    if (target.matches("textarea[data-field]")) {
      const d = state.drawer;
      if (!d) return;
      const field = target.dataset.field;
      if (field === "title" && !target.value.trim()) return;
      const key = `${d.type}:${d.id}`;
      const value = target.value;
      clearTimeout(fieldSaveTimer);
      fieldSaveTimer = setTimeout(() => {
        fieldSaveTimer = null;
        const cur = state.drawer;
        if (!cur || `${cur.type}:${cur.id}` !== key) return;
        saveDrawerField(field, value);
      }, 700);
    }
  }

  function onDrawerKeyDown(event) {
    if (event.target.matches(".drawer-title") && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.target.blur();
      return;
    }
    if (
      event.target.matches("[data-composer]") &&
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      submitEntry();
      return;
    }
    if (event.target.matches("[data-linked-input]") && event.key === "Enter") {
      event.preventDefault();
      const value = event.target.value.trim();
      if (value) {
        event.target.value = "";
        createLinkedTask(value);
      }
    }
  }

  function syncScrollLock() {
    const locked = Boolean(state.drawer) || Boolean(modalRoot.firstElementChild);
    document.body.style.overflow = locked ? "hidden" : "";
  }

  // ---------------------------------------------------------------- 主题

  function applyTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const dark = saved
      ? saved === "dark"
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    updateThemeButton();
  }

  function updateThemeButton() {
    const dark = document.documentElement.dataset.theme === "dark";
    const use = $("#theme-btn use");
    if (use) use.setAttribute("href", dark ? "#i-sun" : "#i-moon");
    const btn = $("#theme-btn");
    if (btn) btn.title = dark ? "切到浅色" : "切到深色";
  }

  function toggleTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    localStorage.setItem(THEME_KEY, dark ? "light" : "dark");
    updateThemeButton();
  }

  // ---------------------------------------------------------------- 启动

  function bindEvents() {
    viewEl.addEventListener("click", onViewClick);
    viewEl.addEventListener("dragstart", onViewDragStart);
    viewEl.addEventListener("dragover", onViewDragOver);
    viewEl.addEventListener("drop", onViewDrop);
    viewEl.addEventListener("dragend", onViewDragEnd);

    drawerRoot.addEventListener("click", onDrawerClick);
    drawerRoot.addEventListener("change", onDrawerChange);
    drawerRoot.addEventListener("focusout", onDrawerFocusOut);
    drawerRoot.addEventListener("input", onDrawerInput);
    drawerRoot.addEventListener("keydown", onDrawerKeyDown);

    modalRoot.addEventListener("click", (event) => {
      if (event.target.matches("[data-modal-backdrop]")) {
        closeModal();
        return;
      }
      if (event.target.closest("[data-action='close-modal']")) {
        closeModal();
        return;
      }
      const identityBtn = event.target.closest("[data-identity]");
      if (identityBtn) {
        pickIdentity(Number(identityBtn.dataset.identity));
        return;
      }
      const swatch = event.target.closest(".swatch");
      if (swatch) {
        const input = modalRoot.querySelector('input[name="color"]');
        if (input) input.value = swatch.dataset.color;
        $$(".swatch", modalRoot).forEach((el) => el.classList.toggle("active", el === swatch));
        return;
      }
      const deleteProjectBtn = event.target.closest("[data-action='delete-project']");
      if (deleteProjectBtn) {
        const p = project(Number(deleteProjectBtn.dataset.project));
        closeModal();
        if (p) confirmDelete("project", p.id, p.name);
        return;
      }
      if (event.target.closest("[data-action='do-delete']")) {
        const action = state.confirmAction;
        state.confirmAction = null;
        if (action) action();
      }
    });

    modalRoot.addEventListener("submit", (event) => {
      const form = event.target.closest("form[data-form]");
      if (!form) return;
      event.preventDefault();
      handleModalForm(form);
    });

    menuRoot.addEventListener("click", (event) => {
      const itemBtn = event.target.closest("[data-index]");
      if (!itemBtn || !state.menu) return;
      const index = Number(itemBtn.dataset.index);
      const item = state.menu.items[index];
      const onPick = state.menu.onPick;
      closeMenu();
      if (item && onPick) onPick(item);
    });

    $("#nav").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-view]");
      if (btn) go(btn.dataset.view);
    });

    $("#theme-btn").addEventListener("click", toggleTheme);
    $("#export-btn").addEventListener("click", () => {
      window.location.assign("/api/export");
    });
    $("#identity-btn").addEventListener("click", openIdentityModal);
    $("#project-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      projectMenu(event.currentTarget.getBoundingClientRect());
    });
    $("#new-task-btn").addEventListener("click", requestNewTask);
    $("#avatars").addEventListener("click", (event) => {
      if (event.target.closest("[data-action='open-identity']")) openIdentityModal();
    });
    $("#sidebar-user").addEventListener("click", openIdentityModal);

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = searchInput.value.trim();
        render();
      }, 140);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        searchInput.value = "";
        state.search = "";
        render();
        searchInput.blur();
      }
    });

    document.addEventListener("click", (event) => {
      if (state.menu && !event.target.closest(".menu")) closeMenu();
    });
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.menu) {
          closeMenu();
          return;
        }
        if (modalRoot.firstElementChild) {
          closeModal();
          return;
        }
        if (state.drawer) closeDrawer();
        return;
      }
      if (event.key === "/" && !isTyping(event.target)) {
        event.preventDefault();
        searchInput.focus();
      }
    });

    window.addEventListener("hashchange", () => {
      const view = location.hash.slice(1);
      if (VIEW_META[view] && view !== state.view) {
        state.view = view;
        closeDrawer();
        render();
        window.scrollTo({ top: 0 });
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh({ silent: true });
    });

    window.setInterval(() => {
      if (!document.hidden) refresh({ silent: true });
    }, 5000);
  }

  async function boot() {
    applyTheme();

    const savedIdentity = Number(localStorage.getItem(IDENTITY_KEY) || 0);
    state.identity = savedIdentity || null;

    const hash = location.hash.slice(1);
    if (VIEW_META[hash]) state.view = hash;

    bindEvents();
    render();
    await refresh({ initial: true });

    if (
      state.data &&
      state.data.members.length &&
      !state.identity &&
      !sessionStorage.getItem(PROMPT_KEY)
    ) {
      sessionStorage.setItem(PROMPT_KEY, "1");
      setTimeout(() => {
        if (!state.identity) openIdentityModal();
      }, 700);
    }
  }

  boot();
})();