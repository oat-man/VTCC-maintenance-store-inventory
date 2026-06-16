from http import cookies
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time


ROOT = Path(__file__).parent
DB_PATH = ROOT / "inventory.db"
STATIC_DIR = ROOT / "static"
SESSION_SECRET = os.environ.get("SESSION_SECRET", "change-this-secret-for-production").encode()


ROLE_PERMISSIONS = {
    "administrator": {"all"},
    "front_end": {"request:create", "return:create", "inventory:read"},
    "store_manager": {"request:approve", "return:approve", "inventory:read", "dashboard:read"},
    "store": {"inventory:read", "inventory:update", "movement:check", "dashboard:read"},
}


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120000)
    return f"{salt}${digest.hex()}"


def verify_password(password, stored):
    salt, expected = stored.split("$", 1)
    return hmac.compare_digest(hash_password(password, salt), stored)


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('administrator','front_end','store_manager','store')),
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS equipment (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                equipment_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                location TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                minimum_qty INTEGER NOT NULL DEFAULT 0,
                maximum_qty INTEGER NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT 'pcs',
                status TEXT NOT NULL DEFAULT 'available',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_type TEXT NOT NULL CHECK(request_type IN ('request','return')),
                equipment_id INTEGER NOT NULL REFERENCES equipment(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                requester_id INTEGER NOT NULL REFERENCES users(id),
                approver_id INTEGER REFERENCES users(id),
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','completed')),
                purpose TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                decided_at TEXT
            );

            CREATE TABLE IF NOT EXISTS stock_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                equipment_id INTEGER NOT NULL REFERENCES equipment(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                movement_type TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                reference TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            seed_users = [
                ("admin", "admin123", "System Administrator", "administrator"),
                ("front", "front123", "Front-end User", "front_end"),
                ("manager", "manager123", "Store Manager", "store_manager"),
                ("store", "store123", "Store Officer", "store"),
            ]
            conn.executemany(
                "INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,?)",
                [(u, hash_password(p), n, r) for u, p, n, r in seed_users],
            )
        count = conn.execute("SELECT COUNT(*) FROM equipment").fetchone()[0]
        if count == 0:
            seed_equipment = [
                ("VTCC-RDO-001", "Handheld Radio", "Communication", "Rack A1", 12, 4, 20, "set"),
                ("VTCC-BAT-014", "Radio Battery Pack", "Communication", "Rack A2", 26, 10, 40, "pcs"),
                ("VTCC-MTR-007", "Digital Multimeter", "Electrical", "Cabinet B1", 3, 4, 10, "pcs"),
                ("VTCC-LMP-021", "Runway Inspection Lamp", "Lighting", "Shelf C3", 18, 8, 25, "pcs"),
                ("VTCC-CBL-112", "Coaxial Cable 10m", "Cable", "Bin D2", 42, 15, 60, "pcs"),
            ]
            conn.executemany(
                """
                INSERT INTO equipment
                    (equipment_no,name,category,location,quantity,minimum_qty,maximum_qty,unit)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                seed_equipment,
            )


def sign_payload(payload):
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    sig = hmac.new(SESSION_SECRET, raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def verify_token(token):
    try:
        raw, sig = token.split(".", 1)
        expected = hmac.new(SESSION_SECRET, raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def rows(sql, args=()):
    with db() as conn:
        return [dict(row) for row in conn.execute(sql, args).fetchall()]


def one(sql, args=()):
    with db() as conn:
        row = conn.execute(sql, args).fetchone()
        return dict(row) if row else None


class Handler(BaseHTTPRequestHandler):
    server_version = "VTCCInventory/1.0"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.route_api("GET", parsed.path, parse_qs(parsed.query))
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.route_api("POST", parsed.path, parse_qs(parsed.query))
        self.send_error(404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        return self.route_api("PUT", parsed.path, parse_qs(parsed.query))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        return self.route_api("DELETE", parsed.path, parse_qs(parsed.query))

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.exists():
            self.send_error(404)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(target.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(target.read_bytes())

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def current_user(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        morsel = jar.get("vtcc_session")
        if not morsel:
            return None
        payload = verify_token(morsel.value)
        if not payload:
            return None
        return one(
            "SELECT id, username, full_name, role, active FROM users WHERE id=? AND active=1",
            (payload["uid"],),
        )

    def can(self, user, permission):
        allowed = ROLE_PERMISSIONS.get(user["role"], set())
        return "all" in allowed or permission in allowed

    def require(self, permission):
        user = self.current_user()
        if not user:
            self.json({"error": "Authentication required"}, 401)
            return None
        if permission and not self.can(user, permission):
            self.json({"error": "Permission denied"}, 403)
            return None
        return user

    def json(self, payload, status=200, headers=None):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def route_api(self, method, path, query):
        try:
            if path == "/api/login" and method == "POST":
                return self.login()
            if path == "/api/logout" and method == "POST":
                return self.json({"ok": True}, headers={"Set-Cookie": "vtcc_session=; Max-Age=0; Path=/; SameSite=Lax"})
            if path == "/api/me" and method == "GET":
                user = self.current_user()
                return self.json({"user": user})
            if path == "/api/dashboard" and method == "GET":
                return self.dashboard()
            if path == "/api/equipment" and method == "GET":
                return self.list_equipment(query)
            if path == "/api/equipment" and method == "POST":
                return self.create_equipment()
            if path.startswith("/api/equipment/"):
                return self.equipment_item(method, path.rsplit("/", 1)[-1])
            if path == "/api/requests" and method == "GET":
                return self.list_requests()
            if path == "/api/requests" and method == "POST":
                return self.create_request()
            if path.startswith("/api/requests/") and method == "PUT":
                return self.decide_request(path.rsplit("/", 1)[-1])
            if path == "/api/users" and method == "GET":
                return self.list_users()
            if path == "/api/users" and method == "POST":
                return self.create_user()
            if path.startswith("/api/users/"):
                return self.user_item(method, path.rsplit("/", 1)[-1])
            self.json({"error": "Not found"}, 404)
        except ValueError as exc:
            self.json({"error": str(exc)}, 400)
        except sqlite3.IntegrityError as exc:
            self.json({"error": f"Database constraint failed: {exc}"}, 400)
        except Exception as exc:
            self.json({"error": f"Server error: {exc}"}, 500)

    def login(self):
        data = self.body()
        user = one(
            "SELECT id, username, password_hash, full_name, role, active FROM users WHERE username=?",
            (data.get("username", ""),),
        )
        if not user or not user["active"] or not verify_password(data.get("password", ""), user["password_hash"]):
            return self.json({"error": "Invalid username or password"}, 401)
        token = sign_payload({"uid": user["id"], "exp": time.time() + 60 * 60 * 10})
        safe_user = {k: user[k] for k in ("id", "username", "full_name", "role")}
        self.json(
            {"user": safe_user},
            headers={"Set-Cookie": f"vtcc_session={token}; HttpOnly; Path=/; SameSite=Lax"},
        )

    def dashboard(self):
        user = self.require("dashboard:read")
        if not user:
            return
        data = {
            "total_items": one("SELECT COUNT(*) count FROM equipment")["count"],
            "low_stock": rows("SELECT * FROM equipment WHERE quantity < minimum_qty ORDER BY quantity ASC"),
            "over_stock": rows("SELECT * FROM equipment WHERE maximum_qty > 0 AND quantity > maximum_qty ORDER BY quantity DESC"),
            "pending_requests": one("SELECT COUNT(*) count FROM requests WHERE status='pending'")["count"],
            "recent_movements": rows(
                """
                SELECT sm.*, e.equipment_no, e.name, u.full_name
                FROM stock_movements sm
                JOIN equipment e ON e.id=sm.equipment_id
                JOIN users u ON u.id=sm.user_id
                ORDER BY sm.created_at DESC LIMIT 8
                """
            ),
        }
        self.json(data)

    def list_equipment(self, query):
        user = self.require("inventory:read")
        if not user:
            return
        term = (query.get("q", [""])[0] or "").strip()
        if term:
            like = f"%{term}%"
            data = rows(
                """
                SELECT * FROM equipment
                WHERE equipment_no LIKE ? OR name LIKE ? OR category LIKE ? OR location LIKE ?
                ORDER BY equipment_no
                """,
                (like, like, like, like),
            )
        else:
            data = rows("SELECT * FROM equipment ORDER BY equipment_no")
        self.json({"equipment": data})

    def create_equipment(self):
        user = self.require("inventory:update")
        if not user:
            return
        data = self.body()
        required = ["equipment_no", "name", "category", "location"]
        missing = [key for key in required if not data.get(key)]
        if missing:
            raise ValueError(f"Missing required fields: {', '.join(missing)}")
        with db() as conn:
            cur = conn.execute(
                """
                INSERT INTO equipment
                    (equipment_no,name,category,location,quantity,minimum_qty,maximum_qty,unit,status,notes)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    data["equipment_no"].strip(),
                    data["name"].strip(),
                    data["category"].strip(),
                    data["location"].strip(),
                    int(data.get("quantity", 0)),
                    int(data.get("minimum_qty", 0)),
                    int(data.get("maximum_qty", 0)),
                    data.get("unit", "pcs").strip(),
                    data.get("status", "available"),
                    data.get("notes", ""),
                ),
            )
        self.json({"id": cur.lastrowid}, 201)

    def equipment_item(self, method, item_id):
        user = self.require("inventory:read" if method == "GET" else "inventory:update")
        if not user:
            return
        if method == "GET":
            item = one("SELECT * FROM equipment WHERE id=? OR equipment_no=?", (int(item_id) if item_id.isdigit() else -1, item_id))
            if not item:
                return self.json({"error": "Equipment not found"}, 404)
            item["movements"] = rows(
                """
                SELECT sm.*, u.full_name FROM stock_movements sm
                JOIN users u ON u.id=sm.user_id
                WHERE equipment_id=? ORDER BY created_at DESC LIMIT 12
                """,
                (item["id"],),
            )
            return self.json({"equipment": item})
        equipment_id = int(item_id)
        if method == "DELETE":
            with db() as conn:
                conn.execute("DELETE FROM equipment WHERE id=?", (equipment_id,))
            return self.json({"ok": True})
        data = self.body()
        with db() as conn:
            conn.execute(
                """
                UPDATE equipment
                SET equipment_no=?, name=?, category=?, location=?, quantity=?, minimum_qty=?,
                    maximum_qty=?, unit=?, status=?, notes=?, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                (
                    data["equipment_no"].strip(),
                    data["name"].strip(),
                    data["category"].strip(),
                    data["location"].strip(),
                    int(data.get("quantity", 0)),
                    int(data.get("minimum_qty", 0)),
                    int(data.get("maximum_qty", 0)),
                    data.get("unit", "pcs").strip(),
                    data.get("status", "available"),
                    data.get("notes", ""),
                    equipment_id,
                ),
            )
            conn.execute(
                "INSERT INTO stock_movements (equipment_id,user_id,movement_type,quantity,reference) VALUES (?,?,?,?,?)",
                (equipment_id, user["id"], "store_check", int(data.get("quantity", 0)), "Store stock check/update"),
            )
        self.json({"ok": True})

    def list_requests(self):
        user = self.require(None)
        if not user:
            return
        if user["role"] == "front_end":
            condition = "WHERE r.requester_id=?"
            args = (user["id"],)
        else:
            condition = ""
            args = ()
        data = rows(
            f"""
            SELECT r.*, e.equipment_no, e.name, u.full_name requester_name, a.full_name approver_name
            FROM requests r
            JOIN equipment e ON e.id=r.equipment_id
            JOIN users u ON u.id=r.requester_id
            LEFT JOIN users a ON a.id=r.approver_id
            {condition}
            ORDER BY r.created_at DESC
            """,
            args,
        )
        self.json({"requests": data})

    def create_request(self):
        user = self.require("request:create")
        if not user:
            return
        data = self.body()
        req_type = data.get("request_type", "request")
        if req_type == "return" and not self.can(user, "return:create"):
            return self.json({"error": "Permission denied"}, 403)
        with db() as conn:
            cur = conn.execute(
                """
                INSERT INTO requests (request_type,equipment_id,quantity,requester_id,purpose)
                VALUES (?,?,?,?,?)
                """,
                (req_type, int(data["equipment_id"]), int(data["quantity"]), user["id"], data.get("purpose", "")),
            )
        self.json({"id": cur.lastrowid}, 201)

    def decide_request(self, item_id):
        user = self.require("request:approve")
        if not user:
            return
        data = self.body()
        action = data.get("status")
        if action not in ("approved", "rejected", "completed"):
            raise ValueError("Status must be approved, rejected, or completed")
        request = one("SELECT * FROM requests WHERE id=?", (int(item_id),))
        if not request:
            return self.json({"error": "Request not found"}, 404)
        with db() as conn:
            if action in ("approved", "completed") and request["status"] == "pending":
                multiplier = -1 if request["request_type"] == "request" else 1
                equipment = conn.execute("SELECT quantity FROM equipment WHERE id=?", (request["equipment_id"],)).fetchone()
                new_qty = equipment["quantity"] + (multiplier * request["quantity"])
                if new_qty < 0:
                    raise ValueError("Not enough quantity in store")
                conn.execute("UPDATE equipment SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (new_qty, request["equipment_id"]))
                conn.execute(
                    "INSERT INTO stock_movements (equipment_id,user_id,movement_type,quantity,reference) VALUES (?,?,?,?,?)",
                    (request["equipment_id"], user["id"], request["request_type"], multiplier * request["quantity"], f"Request #{item_id}"),
                )
            conn.execute(
                "UPDATE requests SET status=?, approver_id=?, decided_at=CURRENT_TIMESTAMP WHERE id=?",
                (action, user["id"], int(item_id)),
            )
        self.json({"ok": True})

    def list_users(self):
        user = self.require("all")
        if not user:
            return
        self.json({"users": rows("SELECT id,username,full_name,role,active,created_at FROM users ORDER BY username")})

    def create_user(self):
        user = self.require("all")
        if not user:
            return
        data = self.body()
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO users (username,password_hash,full_name,role,active) VALUES (?,?,?,?,?)",
                (data["username"], hash_password(data["password"]), data["full_name"], data["role"], int(data.get("active", 1))),
            )
        self.json({"id": cur.lastrowid}, 201)

    def user_item(self, method, item_id):
        user = self.require("all")
        if not user:
            return
        data = self.body() if method != "DELETE" else {}
        with db() as conn:
            if method == "DELETE":
                conn.execute("UPDATE users SET active=0 WHERE id=?", (int(item_id),))
                return self.json({"ok": True})
            fields = [data["username"], data["full_name"], data["role"], int(data.get("active", 1)), int(item_id)]
            conn.execute("UPDATE users SET username=?, full_name=?, role=?, active=? WHERE id=?", fields)
            if data.get("password"):
                conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data["password"]), int(item_id)))
        self.json({"ok": True})


def main():
    init_db()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    print(f"VTCC Inventory running at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
