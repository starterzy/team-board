#!/usr/bin/env python3
"""同频 · 5–6 人小组的轻量项目协作板.

设计目标：零依赖、单文件数据、一条命令启动。
后端只使用 Python 标准库（http.server + sqlite3），前端是无构建步骤的原生 HTML/CSS/JS。

用法:
    python app.py                 # 启动，数据写入 data/pm.db
    python app.py --demo          # 首次启动时载入一组示例数据
    python app.py --open          # 启动后自动打开浏览器
    python app.py --port 9000     # 换端口
    python app.py --host 127.0.0.1  # 只允许本机访问
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import sqlite3
import sys
import threading
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DEFAULT_DB = BASE_DIR / "data" / "pm.db"
DB_PATH = DEFAULT_DB

TASK_STATUSES = ("todo", "doing", "review", "done")
REQ_STATUSES = ("discussing", "confirmed", "building", "done", "paused")
PRIORITIES = ("P0", "P1", "P2")
ENTRY_KINDS = ("progress", "blocker", "decision", "comment")

TASK_STATUS_LABEL = {
    "todo": "待办",
    "doing": "进行中",
    "review": "待确认",
    "done": "已完成",
}
REQ_STATUS_LABEL = {
    "discussing": "讨论中",
    "confirmed": "已确认",
    "building": "实现中",
    "done": "已完成",
    "paused": "已搁置",
}

MEMBER_COLORS = (
    "#17694F", "#B0563F", "#3A6EA5", "#7A5AA6",
    "#A9791C", "#2F7D7A", "#8A4F6B", "#4C6B2F",
)

PROJECT_COLORS = (
    "#17694F", "#3A6EA5", "#B0563F", "#7A5AA6",
    "#A9791C", "#2F7D7A", "#8A4F6B", "#4C6B2F",
)

TS_FMT = "%Y-%m-%dT%H:%M:%SZ"


# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime(TS_FMT)


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = db_connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO meta(key, value) VALUES ('rev', '0');

            CREATE TABLE IF NOT EXISTS members (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                color       TEXT NOT NULL DEFAULT '#17694F',
                start_date  TEXT,
                target_date TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS requirements (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'discussing',
                priority    TEXT NOT NULL DEFAULT 'P2',
                owner_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
                start_date  TEXT,
                target_date TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                title          TEXT NOT NULL,
                description    TEXT NOT NULL DEFAULT '',
                status         TEXT NOT NULL DEFAULT 'todo',
                priority       TEXT NOT NULL DEFAULT 'P2',
                assignee_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
                requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
                start_date     TEXT,
                due_date       TEXT,
                position       INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL,
                done_at        TEXT
            );

            CREATE TABLE IF NOT EXISTS entries (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id   INTEGER NOT NULL,
                kind        TEXT NOT NULL DEFAULT 'comment',
                body        TEXT NOT NULL,
                author_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
                created_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, position);
            CREATE INDEX IF NOT EXISTS idx_tasks_req ON tasks(requirement_id);
            CREATE INDEX IF NOT EXISTS idx_entries_entity ON entries(entity_type, entity_id, id);
            """
        )
        migrate_schema(conn)
        # 旧库由 migrate_schema 补上 project_id 之后，才能建这两条索引
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position);
            CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project_id);
            """
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 轻量迁移：给旧版本的库补上 projects / project_id / start_date
# ---------------------------------------------------------------------------

def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def ensure_default_project(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()
    if row:
        return int(row["id"])
    stamp = now_iso()
    today = date.today()
    cur = conn.execute(
        "INSERT INTO projects(name, description, color, start_date, target_date, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "默认项目",
            "由旧版本数据自动创建，可以改名或补上起止日期。",
            PROJECT_COLORS[0],
            (today - timedelta(days=7)).isoformat(),
            (today + timedelta(days=30)).isoformat(),
            stamp,
            stamp,
        ),
    )
    return int(cur.lastrowid)


def migrate_schema(conn: sqlite3.Connection) -> None:
    req_cols = table_columns(conn, "requirements")
    task_cols = table_columns(conn, "tasks")
    for table, cols in (("requirements", req_cols), ("tasks", task_cols)):
        if "project_id" not in cols:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN project_id INTEGER"
                " REFERENCES projects(id) ON DELETE CASCADE"
            )
        if "start_date" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN start_date TEXT")

    orphan = conn.execute(
        "SELECT 1 FROM requirements WHERE project_id IS NULL"
        " UNION ALL SELECT 1 FROM tasks WHERE project_id IS NULL LIMIT 1"
    ).fetchone()
    if orphan:
        project_id = ensure_default_project(conn)
        conn.execute("UPDATE requirements SET project_id = ? WHERE project_id IS NULL", (project_id,))
        conn.execute("UPDATE tasks SET project_id = ? WHERE project_id IS NULL", (project_id,))


def bump_rev(conn: sqlite3.Connection) -> int:
    conn.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'")
    row = conn.execute("SELECT value FROM meta WHERE key = 'rev'").fetchone()
    return int(row["value"])


def add_entry(
    conn: sqlite3.Connection,
    entity_type: str,
    entity_id: int,
    kind: str,
    body: str,
    author_id: int | None,
    created_at: str | None = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO entries(entity_type, entity_id, kind, body, author_id, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (entity_type, entity_id, kind, body, author_id, created_at or now_iso()),
    )
    return int(cur.lastrowid)


def touch(conn: sqlite3.Connection, entity_type: str, entity_id: int, when: str | None = None) -> None:
    table = "tasks" if entity_type == "task" else "requirements"
    conn.execute(f"UPDATE {table} SET updated_at = ? WHERE id = ?", (when or now_iso(), entity_id))


def member_name(conn: sqlite3.Connection, member_id: int | None) -> str:
    if not member_id:
        return "未指定"
    row = conn.execute("SELECT name FROM members WHERE id = ?", (member_id,)).fetchone()
    return row["name"] if row else "已移除成员"


def entity_title(conn: sqlite3.Connection, entity_type: str, entity_id: int) -> str:
    table = "tasks" if entity_type == "task" else "requirements"
    row = conn.execute(f"SELECT title FROM {table} WHERE id = ?", (entity_id,)).fetchone()
    return row["title"] if row else "（已删除）"


# ---------------------------------------------------------------------------
# 读取状态
# ---------------------------------------------------------------------------

TASK_QUERY = """
SELECT
    t.id, t.project_id, t.title, t.description, t.status, t.priority, t.assignee_id,
    t.requirement_id, t.start_date, t.due_date, t.position, t.created_at, t.updated_at, t.done_at,
    (SELECT COUNT(*) FROM entries e
       WHERE e.entity_type = 'task' AND e.entity_id = t.id AND e.kind <> 'system') AS entry_count,
    (SELECT e.kind FROM entries e
       WHERE e.entity_type = 'task' AND e.entity_id = t.id AND e.kind <> 'system'
       ORDER BY e.id DESC LIMIT 1) AS last_kind
FROM tasks t
ORDER BY t.status, t.position, t.id
"""

REQ_QUERY = """
SELECT
    r.id, r.project_id, r.title, r.description, r.status, r.priority, r.owner_id,
    r.start_date, r.target_date, r.created_at, r.updated_at,
    (SELECT COUNT(*) FROM entries e
       WHERE e.entity_type = 'requirement' AND e.entity_id = r.id AND e.kind <> 'system') AS entry_count
FROM requirements r
ORDER BY r.id
"""


def read_state(conn: sqlite3.Connection) -> dict:
    req_rows = [dict(r) for r in conn.execute(REQ_QUERY)]
    task_rows = [dict(r) for r in conn.execute(TASK_QUERY)]
    members = [dict(r) for r in conn.execute(
        "SELECT id, name, color, created_at FROM members ORDER BY id"
    )]
    projects = [dict(r) for r in conn.execute(
        "SELECT id, name, description, color, start_date, target_date, created_at, updated_at"
        " FROM projects ORDER BY id"
    )]
    entries = [dict(r) for r in conn.execute(
        "SELECT id, entity_type, entity_id, kind, body, author_id, created_at"
        " FROM entries ORDER BY id DESC LIMIT 400"
    )]
    rev = conn.execute("SELECT value FROM meta WHERE key = 'rev'").fetchone()["value"]
    return {
        "rev": int(rev),
        "server_time": now_iso(),
        "members": members,
        "projects": projects,
        "requirements": req_rows,
        "tasks": task_rows,
        "entries": entries,
    }


def read_entity_entries(conn: sqlite3.Connection, entity_type: str, entity_id: int) -> list[dict]:
    if entity_type not in ("task", "requirement"):
        raise ApiError(400, "实体类型不正确")
    rows = conn.execute(
        "SELECT id, entity_type, entity_id, kind, body, author_id, created_at"
        " FROM entries WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 500",
        (entity_type, entity_id),
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------

def clean_text(value, field: str, max_len: int, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, f"{field}格式不正确")
    value = value.strip()
    if required and not value:
        raise ApiError(400, f"{field}不能为空")
    if len(value) > max_len:
        raise ApiError(400, f"{field}最多 {max_len} 个字符")
    return value


def clean_enum(value, field: str, allowed: tuple[str, ...], default: str | None = None) -> str:
    if value is None:
        if default is not None:
            return default
        raise ApiError(400, f"{field}不能为空")
    if value not in allowed:
        raise ApiError(400, f"{field}取值不正确")
    return value


def clean_id(value, field: str) -> int | None:
    if value in (None, "", 0):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ApiError(400, f"{field}不正确")


def clean_date(value, field: str) -> str | None:
    if value in (None, ""):
        return None
    text = str(value)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ApiError(400, f"{field}格式应为 YYYY-MM-DD")
    try:
        date.fromisoformat(text)
    except ValueError:
        raise ApiError(400, f"{field}不是有效日期")
    return text


def require_actor(conn: sqlite3.Connection, body: dict) -> int:
    actor = clean_id(body.get("actor_id"), "操作人")
    if not actor:
        raise ApiError(400, "请先选择你的身份")
    row = conn.execute("SELECT id FROM members WHERE id = ?", (actor,)).fetchone()
    if not row:
        raise ApiError(400, "操作人不存在，请重新选择身份")
    return actor


def optional_actor(conn: sqlite3.Connection, body: dict) -> int | None:
    actor = clean_id(body.get("actor_id"), "操作人")
    if actor is None:
        return None
    row = conn.execute("SELECT id FROM members WHERE id = ?", (actor,)).fetchone()
    if not row:
        raise ApiError(400, "操作人不存在，请重新选择身份")
    return actor


def ensure_member(conn: sqlite3.Connection, member_id: int | None) -> None:
    if member_id is None:
        return
    if not conn.execute("SELECT 1 FROM members WHERE id = ?", (member_id,)).fetchone():
        raise ApiError(400, "成员不存在")


def ensure_requirement(conn: sqlite3.Connection, requirement_id: int | None) -> None:
    if requirement_id is None:
        return
    if not conn.execute("SELECT 1 FROM requirements WHERE id = ?", (requirement_id,)).fetchone():
        raise ApiError(400, "关联的需求不存在")


def ensure_project(conn: sqlite3.Connection, project_id: int | None) -> int:
    if not project_id:
        raise ApiError(400, "请先选择项目")
    row = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise ApiError(400, "项目不存在，请刷新后重试")
    return int(row["id"])


def same_project_requirement(conn: sqlite3.Connection, project_id: int, requirement_id: int | None) -> None:
    if requirement_id is None:
        return
    row = conn.execute("SELECT project_id FROM requirements WHERE id = ?", (requirement_id,)).fetchone()
    if not row:
        raise ApiError(400, "关联的需求不存在")
    if row["project_id"] != project_id:
        raise ApiError(400, "这个需求属于另一个项目")


# ---------------------------------------------------------------------------
# 写操作
# ---------------------------------------------------------------------------

def create_member(conn: sqlite3.Connection, body: dict) -> dict:
    name = clean_text(body.get("name"), "昵称", 20, required=True)
    if conn.execute("SELECT 1 FROM members WHERE name = ?", (name,)).fetchone():
        raise ApiError(409, "这个昵称已经有人用了")
    count = conn.execute("SELECT COUNT(*) AS n FROM members").fetchone()["n"]
    color = clean_text(body.get("color"), "颜色", 16) or MEMBER_COLORS[count % len(MEMBER_COLORS)]
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
        color = MEMBER_COLORS[count % len(MEMBER_COLORS)]
    cur = conn.execute(
        "INSERT INTO members(name, color, created_at) VALUES (?, ?, ?)",
        (name, color, now_iso()),
    )
    bump_rev(conn)
    state = read_state(conn)
    state["created_id"] = cur.lastrowid
    return state


def update_member(conn: sqlite3.Connection, member_id: int, body: dict) -> dict:
    row = conn.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
    if not row:
        raise ApiError(404, "成员不存在")
    if "name" in body:
        name = clean_text(body.get("name"), "昵称", 20, required=True)
        dup = conn.execute("SELECT 1 FROM members WHERE name = ? AND id <> ?", (name, member_id)).fetchone()
        if dup:
            raise ApiError(409, "这个昵称已经有人用了")
        conn.execute("UPDATE members SET name = ? WHERE id = ?", (name, member_id))
    if "color" in body:
        color = clean_text(body.get("color"), "颜色", 16)
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
            conn.execute("UPDATE members SET color = ? WHERE id = ?", (color, member_id))
    bump_rev(conn)
    return read_state(conn)


def valid_color(value, fallback: str) -> str:
    color = clean_text(value, "颜色", 16) or fallback
    return color if re.fullmatch(r"#[0-9A-Fa-f]{6}", color) else fallback


def check_date_order(start_date: str | None, target_date: str | None) -> None:
    if start_date and target_date and start_date > target_date:
        raise ApiError(400, "开始日期不能晚于目标日期")


def create_project(conn: sqlite3.Connection, body: dict) -> dict:
    optional_actor(conn, body)
    name = clean_text(body.get("name"), "项目名", 60, required=True)
    description = clean_text(body.get("description"), "项目说明", 1000)
    count = conn.execute("SELECT COUNT(*) AS n FROM projects").fetchone()["n"]
    color = valid_color(body.get("color"), PROJECT_COLORS[count % len(PROJECT_COLORS)])
    start_date = clean_date(body.get("start_date"), "开始日期")
    target_date = clean_date(body.get("target_date"), "目标日期")
    check_date_order(start_date, target_date)
    stamp = now_iso()
    cur = conn.execute(
        "INSERT INTO projects(name, description, color, start_date, target_date, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, description, color, start_date, target_date, stamp, stamp),
    )
    bump_rev(conn)
    state = read_state(conn)
    state["created_id"] = cur.lastrowid
    return state


def update_project(conn: sqlite3.Connection, project_id: int, body: dict) -> dict:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise ApiError(404, "项目不存在")
    optional_actor(conn, body)
    changes = {}
    if "name" in body:
        changes["name"] = clean_text(body.get("name"), "项目名", 60, required=True)
    if "description" in body:
        changes["description"] = clean_text(body.get("description"), "项目说明", 1000)
    if "color" in body:
        changes["color"] = valid_color(body.get("color"), row["color"])
    if "start_date" in body:
        changes["start_date"] = clean_date(body.get("start_date"), "开始日期")
    if "target_date" in body:
        changes["target_date"] = clean_date(body.get("target_date"), "目标日期")
    if not changes:
        return read_state(conn)

    check_date_order(
        changes.get("start_date", row["start_date"]),
        changes.get("target_date", row["target_date"]),
    )
    sets = ", ".join(f"{key} = ?" for key in changes)
    values = list(changes.values())
    conn.execute(
        f"UPDATE projects SET {sets}, updated_at = ? WHERE id = ?",
        (*values, now_iso(), project_id),
    )
    bump_rev(conn)
    return read_state(conn)


def delete_project(conn: sqlite3.Connection, project_id: int) -> dict:
    if not conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
        raise ApiError(404, "项目不存在")
    count = conn.execute(
        "SELECT (SELECT COUNT(*) FROM requirements WHERE project_id = ?)"
        " + (SELECT COUNT(*) FROM tasks WHERE project_id = ?) AS n",
        (project_id, project_id),
    ).fetchone()["n"]
    if count:
        raise ApiError(400, "项目里还有需求和任务，暂时不能删除")
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    bump_rev(conn)
    return read_state(conn)


def create_requirement(conn: sqlite3.Connection, body: dict) -> dict:
    project_id = ensure_project(conn, clean_id(body.get("project_id"), "项目"))
    title = clean_text(body.get("title"), "标题", 120, required=True)
    description = clean_text(body.get("description"), "说明", 4000)
    status = clean_enum(body.get("status"), "状态", REQ_STATUSES, "discussing")
    priority = clean_enum(body.get("priority"), "优先级", PRIORITIES, "P2")
    owner_id = clean_id(body.get("owner_id"), "负责人")
    start_date = clean_date(body.get("start_date"), "开始日期")
    target_date = clean_date(body.get("target_date"), "目标日期")
    check_date_order(start_date, target_date)
    ensure_member(conn, owner_id)
    stamp = now_iso()
    cur = conn.execute(
        "INSERT INTO requirements(project_id, title, description, status, priority, owner_id,"
        " start_date, target_date, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (project_id, title, description, status, priority, owner_id,
         start_date, target_date, stamp, stamp),
    )
    bump_rev(conn)
    state = read_state(conn)
    state["created_id"] = cur.lastrowid
    return state


def update_requirement(conn: sqlite3.Connection, req_id: int, body: dict) -> dict:
    row = conn.execute("SELECT * FROM requirements WHERE id = ?", (req_id,)).fetchone()
    if not row:
        raise ApiError(404, "需求不存在")
    actor = optional_actor(conn, body)
    changes = {}
    if "title" in body:
        changes["title"] = clean_text(body.get("title"), "标题", 120, required=True)
    if "description" in body:
        changes["description"] = clean_text(body.get("description"), "说明", 4000)
    if "status" in body:
        changes["status"] = clean_enum(body.get("status"), "状态", REQ_STATUSES)
    if "priority" in body:
        changes["priority"] = clean_enum(body.get("priority"), "优先级", PRIORITIES)
    if "owner_id" in body:
        changes["owner_id"] = clean_id(body.get("owner_id"), "负责人")
        ensure_member(conn, changes["owner_id"])
    if "start_date" in body:
        changes["start_date"] = clean_date(body.get("start_date"), "开始日期")
    if "target_date" in body:
        changes["target_date"] = clean_date(body.get("target_date"), "目标日期")
    check_date_order(
        changes.get("start_date", row["start_date"]),
        changes.get("target_date", row["target_date"]),
    )

    if not changes:
        return read_state(conn)

    new_status = changes.get("status", row["status"])
    new_owner = changes.get("owner_id", row["owner_id"])
    old_status, old_owner = row["status"], row["owner_id"]
    title = changes.get("title", row["title"])
    if new_status != old_status:
        add_entry(
            conn, "requirement", req_id, "system",
            f"把需求「{title}」从 {REQ_STATUS_LABEL.get(old_status, old_status)} 改为 {REQ_STATUS_LABEL.get(new_status, new_status)}",
            actor,
        )
    if "owner_id" in changes and new_owner != old_owner:
        add_entry(
            conn, "requirement", req_id, "system",
            f"把需求「{title}」的负责人改为 {member_name(conn, new_owner)}",
            actor,
        )

    sets = ", ".join(f"{key} = ?" for key in changes)
    values = list(changes.values())
    conn.execute(
        f"UPDATE requirements SET {sets}, updated_at = ? WHERE id = ?",
        (*values, now_iso(), req_id),
    )
    bump_rev(conn)
    return read_state(conn)


def delete_requirement(conn: sqlite3.Connection, req_id: int) -> dict:
    if not conn.execute("SELECT 1 FROM requirements WHERE id = ?", (req_id,)).fetchone():
        raise ApiError(404, "需求不存在")
    conn.execute("DELETE FROM entries WHERE entity_type = 'requirement' AND entity_id = ?", (req_id,))
    conn.execute("DELETE FROM requirements WHERE id = ?", (req_id,))
    bump_rev(conn)
    return read_state(conn)


def create_task(conn: sqlite3.Connection, body: dict) -> dict:
    actor = require_actor(conn, body)
    project_id = ensure_project(conn, clean_id(body.get("project_id"), "项目"))
    title = clean_text(body.get("title"), "标题", 120, required=True)
    description = clean_text(body.get("description"), "说明", 4000)
    status = clean_enum(body.get("status"), "状态", TASK_STATUSES, "todo")
    priority = clean_enum(body.get("priority"), "优先级", PRIORITIES, "P2")
    assignee_id = clean_id(body.get("assignee_id"), "负责人")
    requirement_id = clean_id(body.get("requirement_id"), "关联需求")
    start_date = clean_date(body.get("start_date"), "开始日期")
    due_date = clean_date(body.get("due_date"), "截止日期")
    check_date_order(start_date, due_date)
    ensure_member(conn, assignee_id)
    ensure_requirement(conn, requirement_id)
    same_project_requirement(conn, project_id, requirement_id)
    max_pos = conn.execute(
        "SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE project_id = ? AND status = ?",
        (project_id, status),
    ).fetchone()["p"]
    stamp = now_iso()
    cur = conn.execute(
        "INSERT INTO tasks(project_id, title, description, status, priority, assignee_id, requirement_id,"
        " start_date, due_date, position, created_at, updated_at, done_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            project_id, title, description, status, priority, assignee_id, requirement_id,
            start_date, due_date, max_pos + 1, stamp, stamp, stamp if status == "done" else None,
        ),
    )
    bump_rev(conn)
    state = read_state(conn)
    state["created_id"] = cur.lastrowid
    return state


def update_task(conn: sqlite3.Connection, task_id: int, body: dict) -> dict:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        raise ApiError(404, "任务不存在")
    actor = optional_actor(conn, body)
    changes = {}
    if "title" in body:
        changes["title"] = clean_text(body.get("title"), "标题", 120, required=True)
    if "description" in body:
        changes["description"] = clean_text(body.get("description"), "说明", 4000)
    if "status" in body:
        changes["status"] = clean_enum(body.get("status"), "状态", TASK_STATUSES)
    if "priority" in body:
        changes["priority"] = clean_enum(body.get("priority"), "优先级", PRIORITIES)
    if "assignee_id" in body:
        changes["assignee_id"] = clean_id(body.get("assignee_id"), "负责人")
        ensure_member(conn, changes["assignee_id"])
    if "requirement_id" in body:
        changes["requirement_id"] = clean_id(body.get("requirement_id"), "关联需求")
        ensure_requirement(conn, changes["requirement_id"])
        same_project_requirement(conn, row["project_id"], changes["requirement_id"])
    if "start_date" in body:
        changes["start_date"] = clean_date(body.get("start_date"), "开始日期")
    if "due_date" in body:
        changes["due_date"] = clean_date(body.get("due_date"), "截止日期")
    check_date_order(
        changes.get("start_date", row["start_date"]),
        changes.get("due_date", row["due_date"]),
    )

    if not changes:
        return read_state(conn)

    title = changes.get("title", row["title"])
    new_status = changes.get("status", row["status"])
    old_status = row["status"]
    if new_status != old_status:
        if new_status == "done":
            changes["done_at"] = now_iso()
        elif old_status == "done":
            changes["done_at"] = None
        add_entry(
            conn, "task", task_id, "system",
            f"把「{title}」从 {TASK_STATUS_LABEL.get(old_status, old_status)} 移到 {TASK_STATUS_LABEL.get(new_status, new_status)}",
            actor,
        )
        if new_status == "done":
            # 完成时挪到该列末尾（限定在当前项目内）
            max_pos = conn.execute(
                "SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE project_id = ? AND status = 'done'",
                (row["project_id"],),
            ).fetchone()["p"]
            changes["position"] = max_pos + 1
    if "assignee_id" in changes and changes["assignee_id"] != row["assignee_id"]:
        add_entry(
            conn, "task", task_id, "system",
            f"把「{title}」的负责人改为 {member_name(conn, changes['assignee_id'])}",
            actor,
        )
    if "requirement_id" in changes and changes["requirement_id"] != row["requirement_id"]:
        if changes["requirement_id"]:
            req_title = entity_title(conn, "requirement", changes["requirement_id"])
            add_entry(conn, "task", task_id, "system", f"把「{title}」关联到需求「{req_title}」", actor)
        else:
            add_entry(conn, "task", task_id, "system", f"取消了「{title}」的需求关联", actor)

    sets = ", ".join(f"{key} = ?" for key in changes)
    values = list(changes.values())
    conn.execute(
        f"UPDATE tasks SET {sets}, updated_at = ? WHERE id = ?",
        (*values, now_iso(), task_id),
    )
    bump_rev(conn)
    return read_state(conn)


def delete_task(conn: sqlite3.Connection, task_id: int) -> dict:
    if not conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone():
        raise ApiError(404, "任务不存在")
    conn.execute("DELETE FROM entries WHERE entity_type = 'task' AND entity_id = ?", (task_id,))
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    bump_rev(conn)
    return read_state(conn)


def reorder_tasks(conn: sqlite3.Connection, body: dict) -> dict:
    actor = optional_actor(conn, body)
    columns = body.get("columns")
    if not isinstance(columns, dict) or not columns:
        raise ApiError(400, "缺少排序数据")
    seen: set[int] = set()
    cleaned: dict[str, list[int]] = {}
    for status, ids in columns.items():
        if status not in TASK_STATUSES:
            raise ApiError(400, "列状态不正确")
        if not isinstance(ids, list):
            raise ApiError(400, "排序数据格式不正确")
        cleaned[status] = []
        for raw in ids:
            try:
                tid = int(raw)
            except (TypeError, ValueError):
                raise ApiError(400, "任务编号不正确")
            if tid in seen:
                raise ApiError(400, "任务重复出现在多列中")
            seen.add(tid)
            cleaned[status].append(tid)

    existing = {
        row["id"]: dict(row)
        for row in conn.execute("SELECT id, title, status, position, updated_at FROM tasks")
    }
    for tid in seen:
        if tid not in existing:
            raise ApiError(400, "任务不存在，请刷新后重试")

    stamp = now_iso()
    changed = False
    for status, ids in cleaned.items():
        for index, tid in enumerate(ids):
            task = existing[tid]
            status_changed = task["status"] != status
            if status_changed:
                changed = True
                if status == "done":
                    conn.execute("UPDATE tasks SET done_at = ? WHERE id = ?", (stamp, tid))
                elif task["status"] == "done":
                    conn.execute("UPDATE tasks SET done_at = NULL WHERE id = ?", (tid,))
                add_entry(
                    conn, "task", tid, "system",
                    f"把「{task['title']}」从 {TASK_STATUS_LABEL.get(task['status'], task['status'])} 移到 {TASK_STATUS_LABEL.get(status, status)}",
                    actor,
                )
            if status_changed or task["position"] != index:
                changed = True
                conn.execute(
                    "UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?",
                    (status, index, stamp if status_changed else task["updated_at"], tid),
                )
    if changed:
        bump_rev(conn)
    return read_state(conn)


def create_entry(conn: sqlite3.Connection, body: dict) -> dict:
    actor = require_actor(conn, body)
    entity_type = clean_enum(body.get("entity_type"), "实体类型", ("task", "requirement"))
    entity_id = clean_id(body.get("entity_id"), "实体编号")
    if not entity_id:
        raise ApiError(400, "缺少实体编号")
    table = "tasks" if entity_type == "task" else "requirements"
    if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (entity_id,)).fetchone():
        raise ApiError(404, "要更新的对象不存在")
    kind = clean_enum(body.get("kind"), "记录类型", ENTRY_KINDS, "comment")
    text = clean_text(body.get("body"), "内容", 2000, required=True)
    entry_id = add_entry(conn, entity_type, entity_id, kind, text, actor)
    touch(conn, entity_type, entity_id)
    bump_rev(conn)
    state = read_state(conn)
    state["created_id"] = entry_id
    return state


# ---------------------------------------------------------------------------
# 示例数据
# ---------------------------------------------------------------------------

def seed_demo(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) AS n FROM members").fetchone()["n"]:
        return

    def ago(hours: float) -> str:
        return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime(TS_FMT)

    def day(offset: int) -> str:
        return (date.today() + timedelta(days=offset)).isoformat()

    colors = ["#17694F", "#B0563F", "#3A6EA5", "#7A5AA6", "#A9791C"]
    names = ["林知远", "苏芮", "陈默", "周野", "许澄"]
    member_ids = []
    for name, color in zip(names, colors):
        member_ids.append(conn.execute(
            "INSERT INTO members(name, color, created_at) VALUES (?, ?, ?)",
            (name, color, ago(24 * 30)),
        ).lastrowid)

    projects = [
        dict(
            name="客户门户 2.0", color="#17694F", start=-28, target=28,
            desc="给现有客户做一个自助门户：登录、工单、账单三块。这一季先把登录和工单跑通。",
        ),
        dict(
            name="内部数据看板", color="#3A6EA5", start=-10, target=44,
            desc="把散在表格里的周数据收进一个看板，先服务运营周会，不追求大而全。",
        ),
    ]
    project_ids = []
    for p in projects:
        stamp = ago(24 * 21)
        project_ids.append(conn.execute(
            "INSERT INTO projects(name, description, color, start_date, target_date, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (p["name"], p["desc"], p["color"], day(p["start"]), day(p["target"]), stamp, stamp),
        ).lastrowid)

    reqs = [
        dict(
            project=0, title="团队空间：成员与身份", owner=0, status="confirmed", priority="P0",
            start=-26, target=12, created=240, desc=(
                "5–6 人小组的入口必须足够轻：不注册、不设密码，选一个名字就能开始。"
                "成员颜色用于在看板上快速辨认负责人。\n\n"
                "范围：成员名单、颜色标识、身份切换。不做权限分级。"
            ),
        ),
        dict(
            project=0, title="任务看板：拖拽即更新", owner=1, status="building", priority="P0",
            start=-20, target=7, created=200, desc=(
                "看板是每天的默认视图。拖动卡片就代表状态变化，不要求填写额外字段；"
                "需要说明时再补一条进展。\n\n"
                "验收：跨列拖动后刷新页面状态不丢；空列也能作为放置目标。"
            ),
        ),
        dict(
            project=0, title="需求对齐：一页看清在做什么", owner=0, status="building", priority="P1",
            start=-18, target=14, created=180, desc=(
                "每个任务可以挂到一个需求下；需求页显示关联任务的完成度，以及最近一次决策。"
                "周会前用这一页对齐，而不是翻聊天记录。"
            ),
        ),
        dict(
            project=1, title="每周进度同步", owner=3, status="discussing", priority="P1",
            start=-8, target=21, created=150, desc=(
                "周五下午自动汇总：本周完成、进行中、阻塞、下周计划。"
                "先做「一键复制 Markdown」，不接 IM。"
            ),
        ),
        dict(
            project=1, title="移动端快速更新进展", owner=4, status="paused", priority="P2",
            start=-4, target=30, created=100, desc=(
                "外出时用手机补一条进展。优先保证打开任务、写一句话、发布这三步在 10 秒内完成。"
            ),
        ),
        dict(
            project=1, title="指标口径与权限边界", owner=2, status="confirmed", priority="P1",
            start=-9, target=40, created=90, desc=(
                "同一张图，运营、销售、管理层看到的数可能不一样。先把每个指标的定义、"
                "数据来源和可见范围写清楚，再谈图表。"
            ),
        ),
    ]
    req_ids = []
    for r in reqs:
        stamp = ago(r["created"])
        req_ids.append(conn.execute(
            "INSERT INTO requirements(project_id, title, description, status, priority, owner_id,"
            " start_date, target_date, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                project_ids[r["project"]], r["title"], r["desc"], r["status"], r["priority"],
                member_ids[r["owner"]], day(r["start"]), day(r["target"]), stamp, stamp,
            ),
        ).lastrowid)

    tasks = [
        # key, title, req, status, assignee, priority, start, due, position, created, done
        ("members", "成员名单与颜色标识", 0, "done", 1, "P1", -12, -2, 0, 220, 30),
        ("identity", "首次进入的身份选择", 0, "review", 2, "P1", -6, 1, 0, 210, None),
        ("member-ui", "成员管理弹层", 0, "todo", 2, "P2", -2, 4, 0, 150, None),
        ("board", "四列看板与卡片信息", 1, "done", 2, "P0", -10, -3, 1, 190, 52),
        ("drag", "卡片拖拽与跨列排序", 1, "doing", 2, "P0", -5, 1, 0, 170, None),
        ("drawer", "任务详情抽屉", 1, "doing", 1, "P1", -6, 2, 1, 160, None),
        ("signals", "逾期与阻塞标记", 1, "todo", 3, "P1", 0, 3, 1, 140, None),
        ("req-status", "需求状态与负责人", 2, "done", 0, "P1", -11, -4, 2, 170, 76),
        ("progress", "关联任务完成度", 2, "doing", 0, "P1", -4, 2, 2, 120, None),
        ("timeline", "决策记录时间线", 2, "review", 1, "P1", -3, 0, 1, 110, None),
        ("review-notes", "整理本周评审问题", None, "todo", 0, "P2", -2, -1, 2, 40, None),
        ("weekly-rule", "周报汇总口径", 3, "todo", 3, "P2", 1, 5, 0, 90, None),
        ("weekly-copy", "一键复制 Markdown", 3, "todo", 3, "P2", 2, 7, 1, 80, None),
        ("mobile", "手机端抽屉适配", 4, "todo", 4, "P2", 3, 9, 2, 70, None),
        ("metrics-dict", "埋点事件字典", 5, "doing", 4, "P1", -4, 3, 0, 65, None),
        ("metric-cards", "首屏指标卡", 5, "todo", 3, "P1", 0, 6, 3, 55, None),
        ("export-share", "导出与分享", 5, "todo", 1, "P2", 2, 10, 4, 45, None),
    ]
    task_ids: dict[str, int] = {}
    task_meta: dict[str, dict] = {}
    for key, title, req_i, status, assignee, priority, start_off, due_off, pos, created, done_h in tasks:
        stamp = ago(created)
        done_at = ago(done_h) if done_h else None
        project_id = project_ids[reqs[req_i]["project"]] if req_i is not None else project_ids[0]
        tid = conn.execute(
            "INSERT INTO tasks(project_id, title, description, status, priority, assignee_id,"
            " requirement_id, start_date, due_date, position, created_at, updated_at, done_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                project_id, title, "", status, priority, member_ids[assignee],
                req_ids[req_i] if req_i is not None else None,
                day(start_off), day(due_off), pos, stamp, stamp, done_at,
            ),
        ).lastrowid
        task_ids[key] = tid
        task_meta[key] = dict(title=title, created=created)

    entries: list[tuple[float, str, str, str, int]] = []

    def note(entity_type: str, entity_id: int, kind: str, hours: float, author: int, body: str) -> None:
        entries.append((hours, entity_type, str(entity_id), kind, body, author))

    # 需求讨论与决策
    note("requirement", req_ids[0], "decision", 168, 0,
         "不做账号密码。身份存在浏览器本地，换设备时重新选一次；数据仍然在共享的 SQLite 文件里。")
    note("requirement", req_ids[0], "progress", 8, 2,
         "成员颜色和首字母头像已接上，切换身份不再刷新页面。")
    note("requirement", req_ids[1], "decision", 96, 1,
         "状态只保留四列：待办 / 进行中 / 待确认 / 已完成。评审中的任务不再单独开列。")
    note("requirement", req_ids[1], "progress", 20, 2,
         "跨列排序接口已通，空列放置的边界情况今天补。")
    note("requirement", req_ids[1], "blocker", 4, 2,
         "Safari 下跨列拖拽偶尔丢 drop 事件。先加「移动到」菜单兜底，拖拽作为增强。")
    note("requirement", req_ids[2], "decision", 30, 0,
         "需求页只保留「最近一条决策」，完整记录进抽屉，避免页面变成文档。")
    note("requirement", req_ids[2], "progress", 6, 0,
         "进度按已完成任务数 / 关联任务总数；需求下没有任务时显示「未拆解」。")
    note("requirement", req_ids[3], "comment", 20, 3,
         "汇总口径按 done_at 落在本周算完成，不看创建时间。")

    # 任务上的讨论
    note("task", task_ids["identity"], "comment", 8, 4,
         "文案再确认一下：「你是谁」比「选择身份」更像人话。")
    note("task", task_ids["drag"], "progress", 26, 2,
         "跨列拖动后重排 position，刷新不会丢。")
    note("task", task_ids["drawer"], "comment", 12, 1,
         "描述先不做富文本，纯文本 + 换行就够了。")
    note("task", task_ids["progress"], "progress", 6, 0,
         "进度条按已完成任务数 / 关联任务总数；空需求显示「未拆解」。")
    note("task", task_ids["timeline"], "comment", 30, 1,
         "决策用左侧竖线标出来，不要做成另一种卡片。")
    note("task", task_ids["weekly-copy"], "comment", 28, 3,
         "模板：本周完成 / 进行中 / 阻塞 / 下周计划。")
    note("task", task_ids["review-notes"], "blocker", 5, 4,
         "等设计确认空状态文案，暂时没法收口。")
    note("task", task_ids["signals"], "progress", 50, 3,
         "逾期用日期变红，阻塞用卡片左上角小圆点，不额外占一行。")

    # 第二个项目：数据看板
    note("requirement", req_ids[5], "decision", 42, 2,
         "先冻结口径再画图：每个指标写清定义、来源和可见范围，避免周会上对不上数。")
    note("task", task_ids["metrics-dict"], "progress", 20, 4,
         "事件字典已覆盖登录、工单、账单三类，还差两个漏斗定义。")
    note("task", task_ids["metrics-dict"], "blocker", 6, 4,
         "销售和运营对「有效工单」的口径不一致，等周会拍板。")
    note("task", task_ids["metric-cards"], "comment", 10, 3,
         "首屏只放四个数：新增工单、按时解决率、平均响应、待处理。")
    note("task", task_ids["export-share"], "comment", 26, 1,
         "导出先给 CSV，分享链接以后再说，别把权限问题带进来。")

    # 状态变化（系统记录）
    for key, hours, old, new in [
        ("req-status", 76, "进行中", "已完成"),
        ("board", 52, "进行中", "已完成"),
        ("members", 30, "待确认", "已完成"),
        ("identity", 30, "进行中", "待确认"),
        ("drag", 60, "待办", "进行中"),
        ("drawer", 55, "待办", "进行中"),
    ]:
        if key in ("req-status",):
            title = "需求状态与负责人"
            note("task", task_ids[key], "system", hours, 0,
                 f"把「{title}」从 {old} 移到 {new}")
        else:
            note("task", task_ids[key], "system", hours, 2,
                 f"把「{task_meta[key]['title']}」从 {old} 移到 {new}")

    note("requirement", req_ids[0], "system", 60, 2, "把需求「团队空间：成员与身份」从 讨论中 改为 已确认")
    note("requirement", req_ids[1], "system", 80, 1, "把需求「任务看板：拖拽即更新」从 已确认 改为 实现中")
    note("requirement", req_ids[2], "system", 50, 0, "把需求「需求对齐：一页看清在做什么」从 已确认 改为 实现中")

    # 按时间正序写入，保证 id 顺序与时间一致
    entries.sort(key=lambda item: -item[0])
    for hours, entity_type, entity_id, kind, body, author in entries:
        add_entry(conn, entity_type, int(entity_id), kind, body, member_ids[author], created_at=ago(hours))

    # 最近一条记录的时间即实体的更新时间
    for table, etype in (("tasks", "task"), ("requirements", "requirement")):
        conn.execute(
            f"""
            UPDATE {table} SET updated_at = COALESCE((
                SELECT MAX(e.created_at) FROM entries e
                WHERE e.entity_type = '{etype}' AND e.entity_id = {table}.id
            ), updated_at)
            """
        )
    bump_rev(conn)
    conn.commit()
    print(
        f"已载入示例数据（{len(projects)} 个项目 / {len(member_ids)} 位成员 /"
        f" {len(reqs)} 个需求 / {len(tasks)} 个任务）。"
    )


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Tongpin/1.2"
    protocol_version = "HTTP/1.1"

    # -- 输出 --------------------------------------------------------------
    def send_json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def send_text(self, text: str, status: int = 200) -> None:
        raw = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def serve_static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        candidate = (WEB_DIR / rel).resolve()
        try:
            candidate.relative_to(WEB_DIR.resolve())
        except ValueError:
            self.send_error_json(404, "页面不存在")
            return
        if not candidate.is_file():
            if path == "/favicon.ico" and (WEB_DIR / "favicon.svg").is_file():
                candidate = WEB_DIR / "favicon.svg"
            else:
                self.send_error_json(404, "页面不存在")
                return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".json": "application/json; charset=utf-8",
        }.get(candidate.suffix.lower(), "application/octet-stream")
        raw = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    # -- 输入 --------------------------------------------------------------
    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "请求长度不正确")
        if length <= 0:
            return {}
        if length > 2_000_000:
            raise ApiError(413, "请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "JSON 格式不正确")
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是一个对象")
        return data

    # -- 路由 --------------------------------------------------------------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            try:
                self.serve_static(path)
            except BrokenPipeError:
                pass
            except Exception as exc:  # pragma: no cover - 兜底
                print("静态文件错误:", exc)
                self.send_error_json(500, "读取页面失败")
            return

        conn = db_connect()
        try:
            if path == "/api/health":
                self.send_json({"ok": True, "time": now_iso()})
            elif path == "/api/state":
                self.send_json(read_state(conn))
            elif path == "/api/entries":
                query = parse_qs(parsed.query)
                entity_type = (query.get("entity_type") or ["task"])[0]
                try:
                    entity_id = int((query.get("entity_id") or ["0"])[0])
                except ValueError:
                    raise ApiError(400, "实体编号不正确")
                self.send_json({"entries": read_entity_entries(conn, entity_type, entity_id)})
            elif path == "/api/export":
                export = {
                    "exported_at": now_iso(),
                    "members": [dict(r) for r in conn.execute("SELECT * FROM members ORDER BY id")],
                    "projects": [dict(r) for r in conn.execute("SELECT * FROM projects ORDER BY id")],
                    "requirements": [dict(r) for r in conn.execute("SELECT * FROM requirements ORDER BY id")],
                    "tasks": [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY id")],
                    "entries": [dict(r) for r in conn.execute("SELECT * FROM entries ORDER BY id")],
                }
                raw = json.dumps(export, ensure_ascii=False, indent=2).encode("utf-8")
                filename = f"tongpin-{date.today().isoformat()}.json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
            else:
                raise ApiError(404, "接口不存在")
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover
            print("GET 错误:", repr(exc))
            self.send_error_json(500, "服务器开小差了")
        finally:
            conn.close()

    def do_POST(self) -> None:
        self.handle_write("POST")

    def do_PATCH(self) -> None:
        self.handle_write("PATCH")

    def do_DELETE(self) -> None:
        self.handle_write("DELETE")

    def handle_write(self, method: str) -> None:
        path = urlparse(self.path).path
        conn = db_connect()
        try:
            body = self.read_json() if method in ("POST", "PATCH") else {}
            with conn:
                if method == "POST" and path == "/api/members":
                    result = create_member(conn, body)
                elif method == "PATCH" and (m := re.fullmatch(r"/api/members/(\d+)", path)):
                    result = update_member(conn, int(m.group(1)), body)
                elif method == "POST" and path == "/api/projects":
                    result = create_project(conn, body)
                elif method == "PATCH" and (m := re.fullmatch(r"/api/projects/(\d+)", path)):
                    result = update_project(conn, int(m.group(1)), body)
                elif method == "DELETE" and (m := re.fullmatch(r"/api/projects/(\d+)", path)):
                    result = delete_project(conn, int(m.group(1)))
                elif method == "POST" and path == "/api/requirements":
                    result = create_requirement(conn, body)
                elif method == "PATCH" and (m := re.fullmatch(r"/api/requirements/(\d+)", path)):
                    result = update_requirement(conn, int(m.group(1)), body)
                elif method == "DELETE" and (m := re.fullmatch(r"/api/requirements/(\d+)", path)):
                    result = delete_requirement(conn, int(m.group(1)))
                elif method == "POST" and path == "/api/tasks":
                    result = create_task(conn, body)
                elif method == "PATCH" and (m := re.fullmatch(r"/api/tasks/(\d+)", path)):
                    result = update_task(conn, int(m.group(1)), body)
                elif method == "DELETE" and (m := re.fullmatch(r"/api/tasks/(\d+)", path)):
                    result = delete_task(conn, int(m.group(1)))
                elif method == "POST" and path == "/api/reorder":
                    result = reorder_tasks(conn, body)
                elif method == "POST" and path == "/api/entries":
                    result = create_entry(conn, body)
                else:
                    raise ApiError(404, "接口不存在")
            self.send_json(result)
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message)
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover
            print(f"{method} 错误:", repr(exc))
            self.send_error_json(500, "服务器开小差了")
        finally:
            conn.close()

    def log_message(self, fmt: str, *args) -> None:
        # 保持终端干净，只记录错误；需要排查时可打开下面这行。
        # print("%s - %s" % (self.address_string(), fmt % args))
        pass


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        address = sock.getsockname()[0]
        sock.close()
        return address
    except OSError:
        return "127.0.0.1"


def main() -> None:
    global DB_PATH
    parser = argparse.ArgumentParser(description="同频 · 5–6 人小组的轻量项目协作板")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0（局域网可访问）")
    parser.add_argument("--port", type=int, default=8765, help="端口，默认 8765")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite 文件路径")
    parser.add_argument("--demo", action="store_true", help="首次启动时载入示例数据")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    DB_PATH = Path(args.db).expanduser().resolve()
    init_db()
    conn = db_connect()
    try:
        if args.demo:
            with conn:
                seed_demo(conn)
    finally:
        conn.close()

    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f"无法监听 {args.host}:{args.port} —— {exc}")
        print("端口可能被占用，试试：python app.py --port 8766")
        sys.exit(1)
    server.daemon_threads = True

    local_url = f"http://127.0.0.1:{args.port}"
    print()
    print("  同频 · 小队协作板")
    print("  ─────────────────────────────")
    print(f"  本机     {local_url}")
    if args.host in ("0.0.0.0", "::"):
        print(f"  局域网   http://{local_ip()}:{args.port}")
    print(f"  数据     {DB_PATH}")
    print("  Ctrl+C 停止")
    print()

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(local_url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。数据已保存在", DB_PATH)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()