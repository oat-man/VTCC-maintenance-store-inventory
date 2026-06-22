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
    "front_end": {"request:create", "return:create", "inventory:read", "notifications:read", "dashboard:read"},
    "store_manager": {
        "master:manage", "equipment:create", "equipment:update", "orders:read", "inventory:read",
        "dashboard:read", "request:final_approve", "return:final_approve", "movement:approve",
        "audit:read", "notifications:read"
    },
    "store": {
        "inventory:read", "purchase:create", "request:prepare", "return:receive", "return:inspect",
        "movement:propose", "orders:read", "dashboard:read", "notifications:read"
    },
}

ROLE_LABELS = {
    "administrator": "Administrator",
    "front_end": "Front-end User",
    "store": "Store Officer",
    "store_manager": "Manager",
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


def table_columns(conn, table):
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def migrate_schema(conn):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS user_roles (
               user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
               PRIMARY KEY (user_id, role_id)
           )"""
    )
    equipment_cols = table_columns(conn, "equipment")
    for column, ddl in (
        ("category_id", "ALTER TABLE equipment ADD COLUMN category_id INTEGER REFERENCES categories(id)"),
        ("group_id", "ALTER TABLE equipment ADD COLUMN group_id INTEGER REFERENCES groups(id)"),
        ("location_id", "ALTER TABLE equipment ADD COLUMN location_id INTEGER REFERENCES locations(id)"),
        ("return_quantity", "ALTER TABLE equipment ADD COLUMN return_quantity INTEGER NOT NULL DEFAULT 0"),
    ):
        if column not in equipment_cols:
            conn.execute(ddl)
    for table in ("categories", "groups", "locations"):
        if "active" not in table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    movement_cols = table_columns(conn, "stock_movements")
    for column, ddl in (
        ("source_type", "ALTER TABLE stock_movements ADD COLUMN source_type TEXT DEFAULT ''"),
        ("system_quantity", "ALTER TABLE stock_movements ADD COLUMN system_quantity INTEGER"),
        ("balance_after", "ALTER TABLE stock_movements ADD COLUMN balance_after INTEGER"),
        ("location_id", "ALTER TABLE stock_movements ADD COLUMN location_id INTEGER REFERENCES locations(id)"),
        ("lot_reference", "ALTER TABLE stock_movements ADD COLUMN lot_reference TEXT DEFAULT ''"),
        ("location_quantity", "ALTER TABLE stock_movements ADD COLUMN location_quantity INTEGER"),
        ("location_balance_after", "ALTER TABLE stock_movements ADD COLUMN location_balance_after INTEGER"),
        ("allocation_id", "ALTER TABLE stock_movements ADD COLUMN allocation_id INTEGER REFERENCES stock_balances(id)"),
    ):
        if column not in movement_cols:
            conn.execute(ddl)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS stock_balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            equipment_id INTEGER NOT NULL REFERENCES equipment(id),
            location_id INTEGER NOT NULL REFERENCES locations(id),
            source_type TEXT NOT NULL,
            lot_reference TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(equipment_id, location_id, source_type, lot_reference)
        );
        CREATE TRIGGER IF NOT EXISTS sync_legacy_equipment_quantity
        AFTER UPDATE OF quantity ON equipment
        WHEN NEW.quantity != OLD.quantity
         AND COALESCE((SELECT SUM(quantity) FROM stock_balances WHERE equipment_id=NEW.id), 0) != NEW.quantity
        BEGIN
            INSERT OR IGNORE INTO stock_balances
                (equipment_id, location_id, source_type, lot_reference, quantity)
            VALUES (NEW.id, NEW.location_id, 'legacy_adjustment', 'LEGACY', 0);
            UPDATE stock_balances
            SET quantity = quantity + NEW.quantity -
                    (SELECT SUM(quantity) FROM stock_balances WHERE equipment_id=NEW.id),
                updated_at=CURRENT_TIMESTAMP
            WHERE equipment_id=NEW.id AND location_id=NEW.location_id
              AND source_type='legacy_adjustment' AND lot_reference='LEGACY';
        END;

        CREATE TABLE IF NOT EXISTS stock_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposer_id INTEGER NOT NULL REFERENCES users(id),
            reviewer_id INTEGER REFERENCES users(id),
            source_type TEXT NOT NULL,
            equipment_id INTEGER NOT NULL REFERENCES equipment(id),
            location_id INTEGER NOT NULL REFERENCES locations(id),
            allocation_id INTEGER REFERENCES stock_balances(id),
            quantity INTEGER,
            actual_quantity INTEGER,
            expected_direction TEXT DEFAULT "",
            lot_reference TEXT DEFAULT "",
            reference TEXT DEFAULT "",
            status TEXT NOT NULL DEFAULT "pending_manager",
            review_comment TEXT DEFAULT "",
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            decided_at TEXT
        );

        CREATE TABLE IF NOT EXISTS returned_goods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
            equipment_id INTEGER NOT NULL REFERENCES equipment(id),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            receiving_location_id INTEGER REFERENCES locations(id),
            received_by INTEGER NOT NULL REFERENCES users(id),
            inspected_by INTEGER REFERENCES users(id),
            decided_by INTEGER REFERENCES users(id),
            disposition TEXT DEFAULT "",
            status TEXT NOT NULL DEFAULT "awaiting_inspection",
            inspection_note TEXT DEFAULT "",
            manager_comment TEXT DEFAULT "",
            received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            inspected_at TEXT,
            decided_at TEXT,
            UNIQUE(order_item_id)
        );
        """
    )


def sync_user_roles(conn):
    conn.execute(
        """INSERT OR IGNORE INTO user_roles (user_id, role_id)
           SELECT u.id, r.id FROM users u JOIN roles r ON r.role_key=u.role"""
    )


def user_roles(conn, user_id):
    return [row["role_key"] for row in conn.execute(
        """SELECT r.role_key FROM user_roles ur JOIN roles r ON r.id=ur.role_id
           WHERE ur.user_id=? ORDER BY CASE r.role_key
             WHEN 'administrator' THEN 1 WHEN 'store_manager' THEN 2 WHEN 'store' THEN 3 ELSE 4 END""",
        (user_id,),
    ).fetchall()]


def set_user_roles(conn, user_id, role_keys):
    if isinstance(role_keys, str):
        role_keys = [role_keys]
    role_keys = list(dict.fromkeys(role_keys or []))
    if not role_keys or any(role not in ROLE_PERMISSIONS for role in role_keys):
        raise ValueError("At least one valid role is required")
    placeholders = ",".join("?" for _ in role_keys)
    role_rows = conn.execute(
        f"SELECT id,role_key FROM roles WHERE role_key IN ({placeholders})", tuple(role_keys)
    ).fetchall()
    if len(role_rows) != len(role_keys):
        raise ValueError("One or more roles are invalid")
    conn.execute("DELETE FROM user_roles WHERE user_id=?", (user_id,))
    conn.executemany("INSERT INTO user_roles (user_id,role_id) VALUES (?,?)", [(user_id, row["id"]) for row in role_rows])
    conn.execute("UPDATE users SET role=? WHERE id=?", (role_keys[0], user_id))


def add_roles(conn, user):
    if not user:
        return None
    result = dict(user)
    result["roles"] = user_roles(conn, result["id"]) or [result["role"]]
    result["role"] = result["roles"][0]
    return result


MASTER_TYPES = {
    "categories": {"table": "categories", "number": "category_no", "prefix": "CAT"},
    "groups": {"table": "groups", "number": "group_no", "prefix": "GRP"},
    "locations": {"table": "locations", "number": "locate_no", "prefix": "LOC"},
}


def next_master_number(conn, kind):
    config = MASTER_TYPES[kind]
    next_id = conn.execute(
        f"SELECT COALESCE(MAX(id), 0) + 1 FROM {config['table']}"
    ).fetchone()[0]
    while True:
        number = f"{config['prefix']}-{next_id:04d}"
        exists = conn.execute(
            f"SELECT 1 FROM {config['table']} WHERE {config['number']}=?", (number,)
        ).fetchone()
        if not exists:
            return number
        next_id += 1


def seed_master_data(conn):
    roles = [
        ("administrator", "Administrator"),
        ("front_end", "Front-end User"),
        ("store", "Store Officer"),
        ("store_manager", "Store Manager"),
    ]
    conn.executemany("INSERT OR IGNORE INTO roles (role_key,name) VALUES (?,?)", roles)
    categories = [("CAT-COM", "Communication"), ("CAT-ELE", "Electrical"), ("CAT-LGT", "Lighting"), ("CAT-CBL", "Cable")]
    conn.executemany("INSERT OR IGNORE INTO categories (category_no,name) VALUES (?,?)", categories)
    cat_ids = {row["name"]: row["id"] for row in conn.execute("SELECT id,name FROM categories")}
    groups = [
        ("GRP-RDO", "Radio Equipment", cat_ids.get("Communication")),
        ("GRP-MTR", "Meters and Test Tools", cat_ids.get("Electrical")),
        ("GRP-LMP", "Inspection Lighting", cat_ids.get("Lighting")),
        ("GRP-CBL", "Signal Cable", cat_ids.get("Cable")),
    ]
    conn.executemany("INSERT OR IGNORE INTO groups (group_no,name,category_id) VALUES (?,?,?)", [g for g in groups if g[2]])
    locations = [
        ("LOC-A1", "Rack A1", "Communication equipment rack"),
        ("LOC-A2", "Rack A2", "Battery and charging shelf"),
        ("LOC-B1", "Cabinet B1", "Electrical test cabinet"),
        ("LOC-C3", "Shelf C3", "Lighting spare shelf"),
        ("LOC-D2", "Bin D2", "Cable storage bin"),
        ("AREA-RETURN", "Returned Goods", "Controlled quarantine area for received returns"),
        ("AREA-DISC", "Discontinued Goods", "Controlled area for manager-approved discontinued goods"),
    ]
    conn.executemany("INSERT OR IGNORE INTO locations (locate_no,name,details) VALUES (?,?,?)", locations)


def sync_equipment_master_links(conn):
    for item in conn.execute("SELECT id, category, location FROM equipment").fetchall():
        category = conn.execute("SELECT id FROM categories WHERE name=?", (item["category"],)).fetchone()
        location = conn.execute("SELECT id FROM locations WHERE name=?", (item["location"],)).fetchone()
        group = None
        if category:
            group = conn.execute("SELECT id FROM groups WHERE category_id=? ORDER BY id LIMIT 1", (category["id"],)).fetchone()
        conn.execute(
            "UPDATE equipment SET category_id=COALESCE(category_id,?), group_id=COALESCE(group_id,?), location_id=COALESCE(location_id,?) WHERE id=?",
            (category["id"] if category else None, group["id"] if group else None, location["id"] if location else None, item["id"]),
        )


def sync_opening_stock_balances(conn):
    conn.execute(
        """
        INSERT OR IGNORE INTO stock_balances
            (equipment_id, location_id, source_type, lot_reference, quantity)
        SELECT e.id, e.location_id, 'opening_balance', 'OPENING', e.quantity
        FROM equipment e
        WHERE e.location_id IS NOT NULL AND e.quantity > 0
          AND NOT EXISTS (SELECT 1 FROM stock_balances sb WHERE sb.equipment_id=e.id)
        """
    )


def adjust_legacy_stock_balance(conn, equipment_id, delta, source_type, lot_reference):
    item = conn.execute("SELECT location_id FROM equipment WHERE id=?", (equipment_id,)).fetchone()
    if not item or not item["location_id"]:
        raise ValueError("Equipment requires a default location")
    if delta >= 0:
        conn.execute(
            """INSERT INTO stock_balances (equipment_id,location_id,source_type,lot_reference,quantity)
               VALUES (?,?,?,?,?)
               ON CONFLICT(equipment_id,location_id,source_type,lot_reference)
               DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP""",
            (equipment_id, item["location_id"], source_type, lot_reference, delta),
        )
        return
    remaining = -delta
    balances = conn.execute(
        "SELECT id,quantity FROM stock_balances WHERE equipment_id=? AND quantity>0 ORDER BY created_at,id",
        (equipment_id,),
    ).fetchall()
    if sum(row["quantity"] for row in balances) < remaining:
        raise ValueError("Not enough allocated quantity in store")
    for balance in balances:
        used = min(remaining, balance["quantity"])
        conn.execute("UPDATE stock_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (used, balance["id"]))
        remaining -= used
        if not remaining:
            break


def init_db():
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS roles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role_key TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('administrator','front_end','store_manager','store')),
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                category_id INTEGER NOT NULL REFERENCES categories(id),
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                locate_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                details TEXT DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1
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

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_type TEXT NOT NULL CHECK(order_type IN ('purchase','request','return')),
                requester_id INTEGER NOT NULL REFERENCES users(id),
                authorizer_id INTEGER REFERENCES users(id),
                decider_id INTEGER REFERENCES users(id),
                status TEXT NOT NULL DEFAULT 'pending',
                purpose TEXT DEFAULT '',
                file_reference TEXT DEFAULT '',
                comment TEXT DEFAULT '',
                acknowledged_at TEXT,
                decided_at TEXT,
                requester_delivered_at TEXT,
                store_delivered_at TEXT,
                requester_accepted_at TEXT,
                store_received_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                equipment_id INTEGER NOT NULL REFERENCES equipment(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                return_action TEXT DEFAULT ''
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

            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                order_id INTEGER REFERENCES orders(id),
                message TEXT NOT NULL,
                read_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS syslog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER REFERENCES users(id),
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                details TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        migrate_schema(conn)
        seed_master_data(conn)
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
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
        sync_user_roles(conn)
        if conn.execute("SELECT COUNT(*) FROM equipment").fetchone()[0] == 0:
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
        sync_equipment_master_links(conn)
        sync_opening_stock_balances(conn)


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


def log_activity(conn, user_id, action, entity_type, entity_id=None, details=""):
    conn.execute(
        "INSERT INTO syslog (user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)",
        (user_id, action, entity_type, entity_id, details),
    )


def notify_role(conn, role, order_id, message):
    for user in conn.execute(
        """SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id WHERE r.role_key=? AND u.active=1""", (role,)
    ).fetchall():
        conn.execute("INSERT INTO notifications (user_id,order_id,message) VALUES (?,?,?)", (user["id"], order_id, message))


def notify_user(conn, user_id, order_id, message):
    conn.execute("INSERT INTO notifications (user_id,order_id,message) VALUES (?,?,?)", (user_id, order_id, message))


class Handler(BaseHTTPRequestHandler):
    server_version = "VTCCInventory/2.0"

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
            ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
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
        with db() as conn:
            user = conn.execute("SELECT id,username,full_name,role,active FROM users WHERE id=? AND active=1", (payload["uid"],)).fetchone()
            return add_roles(conn, user)

    def can(self, user, permission):
        allowed = set().union(*(ROLE_PERMISSIONS.get(role, set()) for role in user.get("roles", [user["role"]])))
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
            if path == "/api/login" and method == "POST": return self.login()
            if path == "/api/logout" and method == "POST": return self.json({"ok": True}, headers={"Set-Cookie": "vtcc_session=; Max-Age=0; Path=/; SameSite=Lax"})
            if path == "/api/me" and method == "GET": return self.json({"user": self.current_user()})
            if path == "/api/dashboard" and method == "GET": return self.dashboard()
            if path == "/api/master" and method == "GET": return self.master_data()
            if path.startswith("/api/master/"): return self.master_item(method, path.rsplit("/", 1)[-1])
            if path == "/api/equipment" and method == "GET": return self.list_equipment(query)
            if path == "/api/equipment" and method == "POST": return self.create_equipment()
            if path == "/api/stock-movements" and method == "GET": return self.list_stock_movements(query)
            if path == "/api/stock-movements" and method == "POST": return self.create_stock_movement()
            if path == "/api/stock-balances" and method == "GET": return self.list_stock_balances(query)
            if path == "/api/stock-proposals" and method == "GET": return self.list_stock_proposals()
            if path.startswith("/api/stock-proposals/") and method == "PUT": return self.stock_proposal_action(path)
            if path == "/api/returned-goods" and method == "GET": return self.list_returned_goods()
            if path.startswith("/api/returned-goods/") and method == "PUT": return self.returned_goods_action(path)
            if path.startswith("/api/equipment/"): return self.equipment_item(method, path.rsplit("/", 1)[-1])
            if path == "/api/orders" and method == "GET": return self.list_orders(query)
            if path == "/api/orders" and method == "POST": return self.create_order()
            if path.startswith("/api/orders/") and method in ("PUT", "DELETE"): return self.order_action(path, method)
            if path == "/api/requests" and method == "GET": return self.list_orders({"type": ["request"]})
            if path == "/api/requests" and method == "POST": return self.create_legacy_request()
            if path.startswith("/api/requests/") and method == "PUT": return self.legacy_decide(path.rsplit("/", 1)[-1])
            if path == "/api/notifications" and method == "GET": return self.notifications()
            if path == "/api/syslog" and method == "GET": return self.syslog()
            if path == "/api/users" and method == "GET": return self.list_users()
            if path == "/api/users" and method == "POST": return self.create_user()
            if path.startswith("/api/users/"): return self.user_item(method, path.rsplit("/", 1)[-1])
            self.json({"error": "Not found"}, 404)
        except ValueError as exc:
            self.json({"error": str(exc)}, 400)
        except sqlite3.IntegrityError as exc:
            self.json({"error": f"Database constraint failed: {exc}"}, 400)
        except Exception as exc:
            self.json({"error": f"Server error: {exc}"}, 500)

    def login(self):
        data = self.body()
        user = one("SELECT id, username, password_hash, full_name, role, active FROM users WHERE username=?", (data.get("username", ""),))
        if not user or not user["active"] or not verify_password(data.get("password", ""), user["password_hash"]):
            return self.json({"error": "Invalid username or password"}, 401)
        token = sign_payload({"uid": user["id"], "exp": time.time() + 60 * 60 * 10})
        with db() as conn:
            safe_user = add_roles(conn, user)
        safe_user = {k: safe_user[k] for k in ("id", "username", "full_name", "role", "roles")}
        self.json({"user": safe_user}, headers={"Set-Cookie": f"vtcc_session={token}; HttpOnly; Path=/; SameSite=Lax"})

    def dashboard(self):
        user = self.require("dashboard:read")
        if not user: return
        data = {
            "total_items": one("SELECT COUNT(*) count FROM equipment")["count"],
            "low_stock": rows("SELECT * FROM equipment_view WHERE quantity < minimum_qty ORDER BY quantity ASC"),
            "over_stock": rows("SELECT * FROM equipment_view WHERE maximum_qty > 0 AND quantity > maximum_qty ORDER BY quantity DESC"),
            "pending_requests": one("SELECT COUNT(*) count FROM orders WHERE order_type='request' AND status IN ('pending','pending_manager_approval','manager_approved')")["count"],
            "pending_returns": one("SELECT COUNT(*) count FROM orders WHERE order_type='return' AND status IN ('pending','pending_manager_acceptance','manager_accepted','return_delivered','returned_goods')")["count"],
            "unread_notifications": one("SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL", (user["id"],))["count"],
            "recent_movements": rows(
                """
                SELECT sm.*, e.equipment_no, e.name, u.full_name
                FROM stock_movements sm JOIN equipment e ON e.id=sm.equipment_id JOIN users u ON u.id=sm.user_id
                ORDER BY sm.created_at DESC LIMIT 8
                """
            ),
        }
        self.json(data)

    def ensure_view(self):
        with db() as conn:
            conn.execute("DROP VIEW IF EXISTS equipment_view")
            conn.execute(
                """
                CREATE VIEW equipment_view AS
                SELECT e.*, c.name category_name, c.category_no, g.name group_name, g.group_no,
                       l.name location_name, l.locate_no, l.details location_details
                FROM equipment e
                LEFT JOIN categories c ON c.id=e.category_id
                LEFT JOIN groups g ON g.id=e.group_id
                LEFT JOIN locations l ON l.id=e.location_id
                """
            )

    def master_data(self):
        user = self.require("inventory:read")
        if not user: return
        with db() as conn:
            self.json({
                "roles": [dict(row) for row in conn.execute("SELECT role_key,name FROM roles ORDER BY id")],
                "categories": [dict(row) for row in conn.execute("SELECT * FROM categories ORDER BY category_no")],
                "groups": [dict(row) for row in conn.execute("SELECT g.*, c.name category_name, c.category_no FROM groups g JOIN categories c ON c.id=g.category_id ORDER BY g.group_no")],
                "locations": [dict(row) for row in conn.execute("SELECT * FROM locations ORDER BY locate_no")],
                "next_numbers": {kind: next_master_number(conn, kind) for kind in MASTER_TYPES},
            })

    def master_item(self, method, kind):
        user = self.require("master:manage")
        if not user: return
        data = self.body()
        if kind not in MASTER_TYPES:
            return self.json({"error": "Unknown master data type"}, 404)
        config = MASTER_TYPES[kind]
        table = config["table"]
        with db() as conn:
            if method == "POST":
                number = next_master_number(conn, kind)
                name = data.get("name", "").strip()
                if not name:
                    raise ValueError("Name is required")
                if kind == "groups":
                    category_id = int(data.get("category_id") or 0)
                    category = conn.execute("SELECT 1 FROM categories WHERE id=? AND active=1", (category_id,)).fetchone()
                    if not category:
                        raise ValueError("An active category is required")
                    cur = conn.execute(
                        "INSERT INTO groups (group_no,name,category_id,active) VALUES (?,?,?,1)",
                        (number, name, category_id),
                    )
                elif kind == "locations":
                    cur = conn.execute(
                        "INSERT INTO locations (locate_no,name,details,active) VALUES (?,?,?,1)",
                        (number, name, data.get("details", "").strip()),
                    )
                else:
                    cur = conn.execute(
                        "INSERT INTO categories (category_no,name,active) VALUES (?,?,1)",
                        (number, name),
                    )
                log_activity(conn, user["id"], "create", kind, cur.lastrowid, name)
                return self.json({"id": cur.lastrowid, config["number"]: number}, 201)

            item_id = int(data.get("id") or 0)
            item = conn.execute(f"SELECT * FROM {table} WHERE id=?", (item_id,)).fetchone()
            if not item:
                return self.json({"error": "Master data item not found"}, 404)

            if method == "DELETE":
                references = {
                    "categories": (("groups", "category_id"), ("equipment", "category_id")),
                    "groups": (("equipment", "group_id"),),
                    "locations": (("equipment", "location_id"),),
                }[kind]
                referenced = any(
                    conn.execute(
                        f"SELECT 1 FROM {ref_table} WHERE {ref_col}=? LIMIT 1", (item_id,)
                    ).fetchone()
                    for ref_table, ref_col in transaction_references
                )
                if referenced:
                    return self.json(
                        {"error": "This item is referenced and cannot be deleted. Deactivate it instead."},
                        409,
                    )
                conn.execute(f"DELETE FROM {table} WHERE id=?", (item_id,))
                log_activity(conn, user["id"], "delete", kind, item_id, item["name"])
                return self.json({"ok": True})

            if method != "PUT":
                return self.json({"error": "Method not allowed"}, 405)

            if "active" in data and "name" not in data:
                active = 1 if data["active"] else 0
                conn.execute(f"UPDATE {table} SET active=? WHERE id=?", (active, item_id))
                action = "activate" if active else "deactivate"
                log_activity(conn, user["id"], action, kind, item_id, item["name"])
                return self.json({"ok": True})

            name = data.get("name", "").strip()
            if not name:
                raise ValueError("Name is required")
            if kind == "groups":
                category_id = int(data.get("category_id") or 0)
                category = conn.execute("SELECT 1 FROM categories WHERE id=? AND active=1", (category_id,)).fetchone()
                if not category and category_id != item["category_id"]:
                    raise ValueError("An active category is required")
                conn.execute(
                    "UPDATE groups SET name=?, category_id=? WHERE id=?",
                    (name, category_id, item_id),
                )
            elif kind == "locations":
                conn.execute(
                    "UPDATE locations SET name=?, details=? WHERE id=?",
                    (name, data.get("details", "").strip(), item_id),
                )
            else:
                conn.execute("UPDATE categories SET name=? WHERE id=?", (name, item_id))
            log_activity(conn, user["id"], "update", kind, item_id, name)
        self.json({"ok": True})

    def equipment_payload(self, data):
        category_id = int(data.get("category_id") or 0)
        group_id = int(data.get("group_id") or 0) or None
        location_id = int(data.get("location_id") or 0)
        category = one("SELECT name FROM categories WHERE id=?", (category_id,))
        location = one("SELECT name FROM locations WHERE id=?", (location_id,))
        if not category or not location:
            raise ValueError("Category and location are required")
        return (
            data["equipment_no"].strip(), data["name"].strip(), category["name"], location["name"],
            int(data.get("minimum_qty", 0)), int(data.get("maximum_qty", 0)),
            data.get("unit", "pcs").strip(), data.get("status", "available"), data.get("notes", ""),
            category_id, group_id, location_id,
        )

    def list_equipment(self, query):
        user = self.require("inventory:read")
        if not user: return
        self.ensure_view()
        term = (query.get("q", [""])[0] or "").strip()
        if term:
            like = f"%{term}%"
            data = rows(
                """
                SELECT * FROM equipment_view
                WHERE equipment_no LIKE ? OR name LIKE ? OR category_name LIKE ? OR group_name LIKE ? OR location_name LIKE ?
                ORDER BY equipment_no
                """, (like, like, like, like, like)
            )
        else:
            data = rows("SELECT * FROM equipment_view ORDER BY equipment_no")
        self.json({"equipment": data})

    def create_equipment(self):
        user = self.require("equipment:create")
        if not user: return
        data = self.body()
        missing = [key for key in ("equipment_no", "name", "category_id", "location_id") if not data.get(key)]
        if missing: raise ValueError(f"Missing required fields: {', '.join(missing)}")
        values = self.equipment_payload(data)
        with db() as conn:
            cur = conn.execute(
                """
                INSERT INTO equipment
                    (equipment_no,name,category,location,quantity,minimum_qty,maximum_qty,unit,status,notes,category_id,group_id,location_id)
                VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)
                """, values
            )
            log_activity(conn, user["id"], "create", "equipment", cur.lastrowid, data.get("name", ""))
        self.json({"id": cur.lastrowid}, 201)

    def equipment_item(self, method, item_id):
        permission = {
            "GET": "inventory:read",
            "PUT": "equipment:update",
            "DELETE": "equipment:delete",
        }.get(method)
        if not permission:
            return self.json({"error": "Method not allowed"}, 405)
        user = self.require(permission)
        if not user: return
        self.ensure_view()
        if method == "GET":
            item = one("SELECT * FROM equipment_view WHERE id=? OR equipment_no=?", (int(item_id) if item_id.isdigit() else -1, item_id))
            if not item: return self.json({"error": "Equipment not found"}, 404)
            item["movements"] = rows("SELECT sm.*, u.full_name FROM stock_movements sm JOIN users u ON u.id=sm.user_id WHERE equipment_id=? ORDER BY created_at DESC LIMIT 12", (item["id"],))
            return self.json({"equipment": item})
        equipment_id = int(item_id)
        if method == "DELETE":
            with db() as conn:
                conn.execute("DELETE FROM equipment WHERE id=?", (equipment_id,))
                log_activity(conn, user["id"], "delete", "equipment", equipment_id)
            return self.json({"ok": True})
        data = self.body()
        values = self.equipment_payload(data)
        with db() as conn:
            conn.execute(
                """
                UPDATE equipment SET equipment_no=?, name=?, category=?, location=?, minimum_qty=?, maximum_qty=?,
                    unit=?, status=?, notes=?, category_id=?, group_id=?, location_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
                """, values + (equipment_id,)
            )
            log_activity(conn, user["id"], "update", "equipment", equipment_id, data.get("name", ""))
        self.json({"ok": True})

    def list_stock_movements(self, query):
        user = self.require("inventory:read")
        if not user: return
        direction = (query.get("direction", [""])[0] or "").strip()
        source_type = (query.get("source_type", [""])[0] or "").strip()
        equipment_id = int((query.get("equipment_id", ["0"])[0] or 0))
        where, args = [], []
        if direction == "incoming":
            where.append("sm.quantity > 0")
        elif direction == "outgoing":
            where.append("sm.quantity < 0")
        if source_type:
            legacy_types = {
                "procurement": ("purchase",),
                "return_equipment": ("return_stock", "return_received"),
                "checking_store": ("store_check",),
                "delivered_requester": ("request_delivery",),
            }.get(source_type, ())
            placeholders = ",".join("?" for _ in legacy_types)
            clause = "sm.source_type=?"
            if placeholders:
                clause += f" OR (COALESCE(sm.source_type,'')='' AND sm.movement_type IN ({placeholders}))"
            where.append(f"({clause})")
            args.extend((source_type, *legacy_types))
        if equipment_id:
            where.append("sm.equipment_id=?")
            args.append(equipment_id)
        condition = "WHERE " + " AND ".join(where) if where else ""
        data = rows(
            f"""
            SELECT sm.*, e.equipment_no, e.name, e.unit, u.full_name,
                   l.locate_no, l.name location_name
            FROM stock_movements sm
            JOIN equipment e ON e.id=sm.equipment_id
            JOIN users u ON u.id=sm.user_id
            LEFT JOIN locations l ON l.id=sm.location_id
            {condition}
            ORDER BY sm.created_at DESC, sm.id DESC LIMIT 250
            """, args
        )
        self.json({"movements": data})

    def list_stock_balances(self, query):
        user = self.require("inventory:read")
        if not user: return
        equipment_id = int((query.get("equipment_id", ["0"])[0] or 0))
        where, args = "WHERE sb.quantity > 0", []
        if equipment_id:
            where += " AND sb.equipment_id=?"
            args.append(equipment_id)
        data = rows(
            f"""
            SELECT sb.*, e.equipment_no, e.name equipment_name, e.unit,
                   l.locate_no, l.name location_name
            FROM stock_balances sb
            JOIN equipment e ON e.id=sb.equipment_id
            JOIN locations l ON l.id=sb.location_id
            {where}
            ORDER BY e.equipment_no, l.locate_no, sb.created_at, sb.id
            """, args
        )
        self.json({"balances": data})

    def create_stock_movement(self):
        user = self.require("movement:propose")
        if not user: return
        data = self.body()
        source_type = data.get("source_type", "").strip()
        if source_type not in {"procurement", "return_equipment", "checking_store", "delivered_requester"}:
            raise ValueError("Unknown stock movement source")
        equipment_id = int(data.get("equipment_id") or 0)
        location_id = int(data.get("location_id") or 0)
        if not equipment_id or not location_id:
            raise ValueError("Equipment and location are required")
        with db() as conn:
            cur = conn.execute(
                """INSERT INTO stock_proposals
                   (proposer_id,source_type,equipment_id,location_id,allocation_id,quantity,actual_quantity,
                    expected_direction,lot_reference,reference)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (user["id"], source_type, equipment_id, location_id, int(data.get("allocation_id") or 0) or None,
                 int(data.get("quantity") or 0) or None,
                 int(data["actual_quantity"]) if str(data.get("actual_quantity", "")).strip() else None,
                 data.get("expected_direction", ""), data.get("lot_reference", "").strip(),
                 data.get("reference", "").strip()),
            )
            proposal_id = cur.lastrowid
            notify_role(conn, "store_manager", None, f"Stock proposal #{proposal_id} is waiting for approval")
            log_activity(conn, user["id"], "propose", "stock_proposal", proposal_id, source_type)
        self.json({"id": proposal_id, "status": "pending_manager"}, 201)

    def post_stock_movement(self, data, user, respond=True):
        source_type = data.get("source_type", "").strip()
        allowed = {"procurement": 1, "return_equipment": 1, "checking_store": 0, "delivered_requester": -1}
        if source_type not in allowed:
            raise ValueError("Unknown stock movement source")
        equipment_id = int(data.get("equipment_id") or 0)
        location_id = int(data.get("location_id") or 0)
        reference = data.get("reference", "").strip()
        lot_reference = data.get("lot_reference", "").strip()
        with db() as conn:
            item = conn.execute("SELECT id, name, quantity FROM equipment WHERE id=?", (equipment_id,)).fetchone()
            location = conn.execute("SELECT id FROM locations WHERE id=? AND active=1", (location_id,)).fetchone()
            if not item:
                raise ValueError("Equipment not found")
            if not location:
                raise ValueError("An active storage location is required")
            system_quantity = item["quantity"]
            location_quantity = conn.execute(
                "SELECT COALESCE(SUM(quantity),0) total FROM stock_balances WHERE equipment_id=? AND location_id=?",
                (equipment_id, location_id),
            ).fetchone()["total"]
            allocation_id = None
            if source_type == "checking_store":
                actual_quantity = int(data.get("actual_quantity", -1))
                if actual_quantity < 0:
                    raise ValueError("Actual quantity must be zero or greater")
                delta = actual_quantity - location_quantity
                expected_direction = data.get("expected_direction", "").strip()
                if expected_direction == "incoming" and delta < 0:
                    raise ValueError("This count is an outgoing adjustment; use Outgoing equipment - From Checking Store")
                if expected_direction == "outgoing" and delta > 0:
                    raise ValueError("This count is an incoming adjustment; use Incoming equipment - From Checking Store")
                lot_reference = lot_reference or reference or f"CHECK-{int(time.time())}"
                if delta > 0:
                    conn.execute(
                        """INSERT INTO stock_balances (equipment_id,location_id,source_type,lot_reference,quantity)
                           VALUES (?,?,?,?,?)
                           ON CONFLICT(equipment_id,location_id,source_type,lot_reference)
                           DO UPDATE SET quantity=quantity+excluded.quantity, updated_at=CURRENT_TIMESTAMP""",
                        (equipment_id, location_id, source_type, lot_reference, delta),
                    )
                    allocation_id = conn.execute(
                        "SELECT id FROM stock_balances WHERE equipment_id=? AND location_id=? AND source_type=? AND lot_reference=?",
                        (equipment_id, location_id, source_type, lot_reference),
                    ).fetchone()["id"]
                elif delta < 0:
                    remaining = -delta
                    for balance in conn.execute(
                        "SELECT id,quantity FROM stock_balances WHERE equipment_id=? AND location_id=? AND quantity>0 ORDER BY created_at,id",
                        (equipment_id, location_id),
                    ).fetchall():
                        used = min(remaining, balance["quantity"])
                        conn.execute("UPDATE stock_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (used, balance["id"]))
                        remaining -= used
                        if not remaining: break
                movement_type = "checking_store"
                reference = reference or "Physical count at storage location"
            elif source_type == "delivered_requester":
                allocation_id = int(data.get("allocation_id") or 0)
                allocation = conn.execute(
                    "SELECT * FROM stock_balances WHERE id=? AND equipment_id=? AND location_id=?",
                    (allocation_id, equipment_id, location_id),
                ).fetchone()
                quantity = int(data.get("quantity") or 0)
                if not allocation or quantity <= 0:
                    raise ValueError("Select a stored lot and a quantity greater than zero")
                if quantity > allocation["quantity"]:
                    raise ValueError(f"Only {allocation['quantity']} available in the selected lot")
                delta = -quantity
                lot_reference = allocation["lot_reference"]
                conn.execute("UPDATE stock_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (quantity, allocation_id))
                movement_type = source_type
            else:
                quantity = int(data.get("quantity") or 0)
                if quantity <= 0:
                    raise ValueError("Quantity must be greater than zero")
                if source_type == "procurement" and not lot_reference:
                    raise ValueError("Procurement lot is required")
                lot_reference = lot_reference or reference or f"{source_type.upper()}-{int(time.time())}"
                delta = quantity
                conn.execute(
                    """INSERT INTO stock_balances (equipment_id,location_id,source_type,lot_reference,quantity)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(equipment_id,location_id,source_type,lot_reference)
                       DO UPDATE SET quantity=quantity+excluded.quantity, updated_at=CURRENT_TIMESTAMP""",
                    (equipment_id, location_id, source_type, lot_reference, quantity),
                )
                allocation_id = conn.execute(
                    "SELECT id FROM stock_balances WHERE equipment_id=? AND location_id=? AND source_type=? AND lot_reference=?",
                    (equipment_id, location_id, source_type, lot_reference),
                ).fetchone()["id"]
                movement_type = source_type
            balance_after = system_quantity + delta
            location_balance_after = location_quantity + delta
            if balance_after < 0 or location_balance_after < 0:
                raise ValueError("Insufficient stock at the selected storage location")
            conn.execute("UPDATE equipment SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (balance_after, equipment_id))
            cur = conn.execute(
                """INSERT INTO stock_movements
                   (equipment_id,user_id,movement_type,quantity,reference,source_type,system_quantity,balance_after,
                    location_id,lot_reference,location_quantity,location_balance_after,allocation_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (equipment_id, user["id"], movement_type, delta, reference, source_type, system_quantity, balance_after,
                 location_id, lot_reference, location_quantity, location_balance_after, allocation_id),
            )
            log_activity(conn, user["id"], "stock_movement", "equipment", equipment_id,
                         f"{source_type}: {delta:+d}; location {location_id}; lot {lot_reference}; balance {balance_after}")
        result = {"id": cur.lastrowid, "difference": delta, "balance_after": balance_after,
                  "location_balance_after": location_balance_after}
        if respond:
            self.json(result, 201)
        return result

    def list_stock_proposals(self):
        user = self.require("orders:read")
        if not user: return
        data = rows(
            """SELECT sp.*, e.equipment_no, e.name equipment_name, e.unit,
                      l.locate_no, l.name location_name, u.full_name proposer_name,
                      r.full_name reviewer_name
               FROM stock_proposals sp
               JOIN equipment e ON e.id=sp.equipment_id
               JOIN locations l ON l.id=sp.location_id
               JOIN users u ON u.id=sp.proposer_id
               LEFT JOIN users r ON r.id=sp.reviewer_id
               ORDER BY CASE sp.status WHEN 'pending_manager' THEN 0 ELSE 1 END,
                        sp.created_at DESC"""
        )
        self.json({"proposals": data})

    def stock_proposal_action(self, path):
        user = self.require("movement:approve")
        if not user: return
        parts = path.strip("/").split("/")
        proposal_id = int(parts[2])
        action = parts[3] if len(parts) > 3 else ""
        if action not in ("approve", "reject"):
            return self.json({"error": "Unknown proposal action"}, 404)
        proposal = one("SELECT * FROM stock_proposals WHERE id=?", (proposal_id,))
        if not proposal:
            return self.json({"error": "Stock proposal not found"}, 404)
        if proposal["status"] != "pending_manager":
            return self.json({"error": "This proposal has already been decided"}, 409)
        payload = self.body()
        comment = payload.get("comment", "").strip()
        if action == "reject":
            with db() as conn:
                conn.execute(
                    """UPDATE stock_proposals SET status='rejected',reviewer_id=?,
                       review_comment=?,decided_at=CURRENT_TIMESTAMP WHERE id=?""",
                    (user["id"], comment, proposal_id),
                )
                notify_user(conn, proposal["proposer_id"], None, f"Stock proposal #{proposal_id} was rejected")
                log_activity(conn, user["id"], "reject", "stock_proposal", proposal_id, comment)
            return self.json({"ok": True, "status": "rejected"})
        data = {
            "source_type": proposal["source_type"],
            "equipment_id": proposal["equipment_id"],
            "location_id": proposal["location_id"],
            "allocation_id": proposal["allocation_id"],
            "quantity": proposal["quantity"],
            "actual_quantity": proposal["actual_quantity"],
            "expected_direction": proposal["expected_direction"],
            "lot_reference": proposal["lot_reference"],
            "reference": proposal["reference"],
        }
        result = self.post_stock_movement(data, user, respond=False)
        with db() as conn:
            conn.execute(
                """UPDATE stock_proposals SET status='approved_posted',reviewer_id=?,
                   review_comment=?,decided_at=CURRENT_TIMESTAMP WHERE id=?""",
                (user["id"], comment, proposal_id),
            )
            notify_user(conn, proposal["proposer_id"], None, f"Stock proposal #{proposal_id} was approved and posted")
            log_activity(conn, user["id"], "approve_and_post", "stock_proposal", proposal_id, comment)
        self.json({"ok": True, "status": "approved_posted", "posting": result})

    def list_returned_goods(self):
        user = self.require("orders:read")
        if not user: return
        data = rows(
            """SELECT rg.*, e.equipment_no, e.name equipment_name, e.unit,
                      l.locate_no, l.name location_name, u.full_name received_by_name,
                      i.full_name inspected_by_name, d.full_name decided_by_name
               FROM returned_goods rg
               JOIN equipment e ON e.id=rg.equipment_id
               LEFT JOIN locations l ON l.id=rg.receiving_location_id
               JOIN users u ON u.id=rg.received_by
               LEFT JOIN users i ON i.id=rg.inspected_by
               LEFT JOIN users d ON d.id=rg.decided_by
               ORDER BY CASE rg.status
                 WHEN 'pending_manager_restock' THEN 0
                 WHEN 'pending_manager_discontinue' THEN 0
                 WHEN 'awaiting_inspection' THEN 1 ELSE 2 END,
                 rg.received_at DESC"""
        )
        self.json({"returned_goods": data})

    def returned_goods_action(self, path):
        user = self.require(None)
        if not user: return
        parts = path.strip("/").split("/")
        goods_id = int(parts[2])
        action = parts[3] if len(parts) > 3 else ""
        item = one("SELECT * FROM returned_goods WHERE id=?", (goods_id,))
        if not item:
            return self.json({"error": "Returned goods item not found"}, 404)
        data = self.body()
        with db() as conn:
            if action == "inspect":
                if not self.can(user, "return:inspect"):
                    return self.json({"error": "Permission denied"}, 403)
                if item["status"] != "awaiting_inspection":
                    return self.json({"error": "This item is not awaiting inspection"}, 409)
                disposition = data.get("disposition")
                if disposition not in ("restock", "discontinue"):
                    raise ValueError("Disposition must be restock or discontinue")
                status = f"pending_manager_{disposition}"
                conn.execute(
                    """UPDATE returned_goods SET status=?,disposition=?,inspection_note=?,
                       inspected_by=?,inspected_at=CURRENT_TIMESTAMP WHERE id=?""",
                    (status, disposition, data.get("comment", ""), user["id"], goods_id),
                )
                notify_role(conn, "store_manager", item["order_id"], f"Returned goods #{goods_id} needs final decision")
                log_activity(conn, user["id"], "inspect", "returned_goods", goods_id, disposition)
            elif action in ("approve", "reject"):
                if not self.can(user, "return:final_approve"):
                    return self.json({"error": "Permission denied"}, 403)
                if item["status"] not in ("pending_manager_restock", "pending_manager_discontinue"):
                    return self.json({"error": "This item is not awaiting manager decision"}, 409)
                if action == "reject":
                    conn.execute(
                        """UPDATE returned_goods SET status='awaiting_inspection',manager_comment=?,
                           decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?""",
                        (data.get("comment", ""), user["id"], goods_id),
                    )
                elif item["disposition"] == "restock":
                    equipment = conn.execute("SELECT location_id,quantity FROM equipment WHERE id=?", (item["equipment_id"],)).fetchone()
                    adjust_legacy_stock_balance(conn, item["equipment_id"], item["quantity"], "return_equipment", f"RETURN-{item['order_id']}")
                    conn.execute("UPDATE equipment SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (item["quantity"], item["equipment_id"]))
                    conn.execute(
                        """INSERT INTO stock_movements
                           (equipment_id,user_id,movement_type,quantity,reference,source_type,system_quantity,
                            balance_after,location_id,lot_reference)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (item["equipment_id"], user["id"], "return_to_stock", item["quantity"],
                         f"Return order #{item['order_id']}", "return_equipment", equipment["quantity"],
                         equipment["quantity"] + item["quantity"], equipment["location_id"], f"RETURN-{item['order_id']}"),
                    )
                    conn.execute(
                        """UPDATE returned_goods SET status='in_stock',manager_comment=?,
                           decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?""",
                        (data.get("comment", ""), user["id"], goods_id),
                    )
                else:
                    discontinued = conn.execute("SELECT id FROM locations WHERE locate_no='AREA-DISC'").fetchone()
                    conn.execute(
                        """UPDATE returned_goods SET status='discontinued',receiving_location_id=?,
                           manager_comment=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?""",
                        (discontinued["id"] if discontinued else item["receiving_location_id"],
                         data.get("comment", ""), user["id"], goods_id),
                    )
                if action == "approve":
                    open_items = conn.execute(
                        "SELECT COUNT(*) FROM returned_goods WHERE order_id=? AND status NOT IN ('in_stock','discontinued')",
                        (item["order_id"],),
                    ).fetchone()[0]
                    if not open_items:
                        conn.execute("UPDATE orders SET status='completed' WHERE id=?", (item["order_id"],))
                log_activity(conn, user["id"], action, "returned_goods", goods_id, data.get("comment", ""))
            else:
                return self.json({"error": "Unknown returned goods action"}, 404)
        self.json({"ok": True})

    def list_orders(self, query):
        user = self.require(None)
        if not user: return
        order_type = (query.get("type", [""])[0] if query else "").strip()
        args = []
        where = []
        if order_type:
            where.append("o.order_type=?")
            args.append(order_type)
        condition = "WHERE " + " AND ".join(where) if where else ""
        orders = rows(
            f"""
            SELECT o.*, r.full_name requester_name, a.full_name authorizer_name, d.full_name decider_name
            FROM orders o JOIN users r ON r.id=o.requester_id
            LEFT JOIN users a ON a.id=o.authorizer_id LEFT JOIN users d ON d.id=o.decider_id
            {condition} ORDER BY o.created_at DESC
            """, tuple(args)
        )
        for order in orders:
            order["items"] = rows(
                """
                SELECT oi.*, e.equipment_no, e.name, e.unit FROM order_items oi
                JOIN equipment e ON e.id=oi.equipment_id WHERE oi.order_id=? ORDER BY oi.id
                """, (order["id"],)
            )
        self.json({"orders": orders})

    def create_order(self):
        user = self.require(None)
        if not user: return
        data = self.body()
        order_type = data.get("order_type")
        if order_type == "purchase" and not self.can(user, "purchase:create"): return self.json({"error": "Permission denied"}, 403)
        if order_type == "request" and not self.can(user, "request:create"): return self.json({"error": "Permission denied"}, 403)
        if order_type == "return" and not self.can(user, "return:create"): return self.json({"error": "Permission denied"}, 403)
        items = [i for i in data.get("items", []) if i.get("equipment_id") and int(i.get("quantity", 0)) > 0]
        if not items: raise ValueError("At least one equipment item is required")
        status = "completed" if order_type == "purchase" else "pending"
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO orders (order_type,requester_id,status,purpose,file_reference) VALUES (?,?,?,?,?)",
                (order_type, user["id"], status, data.get("purpose", ""), data.get("file_reference", "")),
            )
            order_id = cur.lastrowid
            for item in items:
                equipment_id = int(item["equipment_id"])
                qty = int(item["quantity"])
                conn.execute("INSERT INTO order_items (order_id,equipment_id,quantity,return_action) VALUES (?,?,?,?)", (order_id, equipment_id, qty, item.get("return_action", "")))
                if order_type == "purchase":
                    adjust_legacy_stock_balance(conn, equipment_id, qty, "procurement", f"PURCHASE-{order_id}")
                    conn.execute("UPDATE equipment SET quantity=quantity+?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (qty, equipment_id))
                    conn.execute("INSERT INTO stock_movements (equipment_id,user_id,movement_type,quantity,reference) VALUES (?,?,?,?,?)", (equipment_id, user["id"], "purchase", qty, f"Purchase order #{order_id}: {data.get('file_reference', '')}"))
            if order_type in ("request", "return"):
                notify_role(conn, "store", order_id, f"New {order_type} order #{order_id} is pending acknowledgement")
                notify_role(conn, "store_manager", order_id, f"New {order_type} order #{order_id} is pending acknowledgement")
            log_activity(conn, user["id"], "create", f"{order_type}_order", order_id, data.get("purpose", ""))
        self.json({"id": order_id}, 201)

    def order_action(self, path, method="PUT"):
        parts = path.strip("/").split("/")
        order_id = int(parts[2])
        action = parts[3] if len(parts) > 3 else ("delete" if method == "DELETE" else "")
        user = self.require(None)
        if not user: return
        order = one("SELECT * FROM orders WHERE id=?", (order_id,))
        if not order: return self.json({"error": "Order not found"}, 404)
        data = self.body()
        with db() as conn:
            if action in ("edit", "delete"):
                if user["id"] != order["requester_id"]:
                    return self.json({"error": "Only the owner can edit or delete this order"}, 403)
                if order["status"] != "pending":
                    return self.json({"error": "Only pending orders can be changed"}, 409)
                if action == "delete":
                    conn.execute("DELETE FROM notifications WHERE order_id=?", (order_id,))
                    conn.execute("DELETE FROM orders WHERE id=?", (order_id,))
                    log_activity(conn, user["id"], "delete", "order", order_id)
                else:
                    items = [i for i in data.get("items", []) if i.get("equipment_id") and int(i.get("quantity", 0)) > 0]
                    if not items:
                        raise ValueError("At least one equipment item is required")
                    conn.execute("UPDATE orders SET purpose=?,file_reference=? WHERE id=?", (data.get("purpose", ""), data.get("file_reference", ""), order_id))
                    conn.execute("DELETE FROM order_items WHERE order_id=?", (order_id,))
                    conn.executemany(
                        "INSERT INTO order_items (order_id,equipment_id,quantity) VALUES (?,?,?)",
                        [(order_id, int(item["equipment_id"]), int(item["quantity"])) for item in items],
                    )
                    log_activity(conn, user["id"], "update", "order", order_id)
            elif action in ("ack", "prepare"):
                permission = "request:prepare" if order["order_type"] == "request" else "return:receive"
                if not self.can(user, permission):
                    return self.json({"error": "Only a Store Officer can prepare this transaction"}, 403)
                if order["status"] != "pending":
                    return self.json({"error": "Only pending transactions can be prepared"}, 409)
                next_status = "pending_manager_approval" if order["order_type"] == "request" else "pending_manager_acceptance"
                conn.execute(
                    """UPDATE orders SET status=?,authorizer_id=?,acknowledged_at=CURRENT_TIMESTAMP
                       WHERE id=?""", (next_status, user["id"], order_id)
                )
                notify_role(conn, "store_manager", order_id, f"{order['order_type'].title()} order #{order_id} needs final approval")
                notify_user(conn, order["requester_id"], order_id, f"Store Officer prepared your {order['order_type']} order #{order_id}")
                log_activity(conn, user["id"], "prepare", "order", order_id, next_status)
            elif action == "decide":
                permission = "request:final_approve" if order["order_type"] == "request" else "return:final_approve"
                if not self.can(user, permission):
                    return self.json({"error": "Only a Store Manager can make the final decision"}, 403)
                expected = "pending_manager_approval" if order["order_type"] == "request" else "pending_manager_acceptance"
                if order["status"] != expected:
                    return self.json({"error": "The Store Officer must prepare this transaction first"}, 409)
                decision = data.get("decision")
                if order["order_type"] == "request":
                    statuses = {"approved": "manager_approved", "rejected": "rejected"}
                else:
                    statuses = {"accepted": "manager_accepted", "cancelled": "cancelled"}
                if decision not in statuses:
                    raise ValueError("Invalid manager decision")
                status = statuses[decision]
                conn.execute(
                    """UPDATE orders SET status=?,decider_id=?,decided_at=CURRENT_TIMESTAMP,comment=?
                       WHERE id=?""", (status, user["id"], data.get("comment", ""), order_id)
                )
                notify_user(conn, order["requester_id"], order_id, f"Your {order['order_type']} order #{order_id} is {status.replace('_', ' ')}")
                notify_role(conn, "store", order_id, f"{order['order_type'].title()} order #{order_id} is {status.replace('_', ' ')}")
                log_activity(conn, user["id"], "final_decision", "order", order_id, f"{status}: {data.get('comment', '')}")
            elif action == "store-deliver":
                if not self.can(user, "request:prepare"):
                    return self.json({"error": "Only a Store Officer can deliver items"}, 403)
                if order["order_type"] != "request" or order["status"] != "manager_approved":
                    raise ValueError("Only manager-approved requests can be delivered")
                for item in conn.execute("SELECT * FROM order_items WHERE order_id=?", (order_id,)).fetchall():
                    stock = conn.execute("SELECT quantity FROM equipment WHERE id=?", (item["equipment_id"],)).fetchone()["quantity"]
                    if stock < item["quantity"]:
                        raise ValueError("Not enough quantity in store")
                    adjust_legacy_stock_balance(conn, item["equipment_id"], -item["quantity"], "delivered_requester", f"REQUEST-{order_id}")
                    conn.execute("UPDATE equipment SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (item["quantity"], item["equipment_id"]))
                    conn.execute(
                        "INSERT INTO stock_movements (equipment_id,user_id,movement_type,quantity,reference) VALUES (?,?,?,?,?)",
                        (item["equipment_id"], user["id"], "request_delivery", -item["quantity"], f"Request order #{order_id}"),
                    )
                conn.execute("UPDATE orders SET status='delivered',store_delivered_at=CURRENT_TIMESTAMP WHERE id=?", (order_id,))
                notify_user(conn, order["requester_id"], order_id, f"Request order #{order_id} is ready and was delivered")
                log_activity(conn, user["id"], "deliver", "order", order_id)
            elif action == "requester-accept":
                if user["id"] != order["requester_id"]:
                    return self.json({"error": "Only the requester can accept delivered items"}, 403)
                if order["status"] != "delivered":
                    return self.json({"error": "This request has not been delivered"}, 409)
                conn.execute("UPDATE orders SET status='completed',requester_accepted_at=CURRENT_TIMESTAMP WHERE id=?", (order_id,))
                log_activity(conn, user["id"], "accept_delivery", "order", order_id)
            elif action == "returner-deliver":
                if user["id"] != order["requester_id"]:
                    return self.json({"error": "Only the returner can deliver return items"}, 403)
                if order["status"] != "manager_accepted":
                    return self.json({"error": "This return has not been accepted by the Store Manager"}, 409)
                conn.execute("UPDATE orders SET status='return_delivered',requester_delivered_at=CURRENT_TIMESTAMP WHERE id=?", (order_id,))
                notify_role(conn, "store", order_id, f"Return order #{order_id} was delivered to the Returned Goods area")
                log_activity(conn, user["id"], "deliver_return", "order", order_id)
            elif action == "store-receive":
                if not self.can(user, "return:receive"):
                    return self.json({"error": "Only a Store Officer can receive returned goods"}, 403)
                if order["order_type"] != "return" or order["status"] != "return_delivered":
                    return self.json({"error": "The returner has not delivered this order"}, 409)
                returned_area = conn.execute("SELECT id FROM locations WHERE locate_no='AREA-RETURN'").fetchone()
                if not returned_area:
                    raise ValueError("Returned Goods location is not configured")
                for item in conn.execute("SELECT * FROM order_items WHERE order_id=?", (order_id,)).fetchall():
                    conn.execute(
                        """INSERT OR IGNORE INTO returned_goods
                           (order_id,order_item_id,equipment_id,quantity,receiving_location_id,received_by)
                           VALUES (?,?,?,?,?,?)""",
                        (order_id, item["id"], item["equipment_id"], item["quantity"], returned_area["id"], user["id"]),
                    )
                conn.execute("UPDATE orders SET status='returned_goods',store_received_at=CURRENT_TIMESTAMP WHERE id=?", (order_id,))
                notify_role(conn, "store_manager", order_id, f"Return order #{order_id} was received into Returned Goods")
                notify_user(conn, order["requester_id"], order_id, f"Return order #{order_id} was received by the store")
                log_activity(conn, user["id"], "receive_return", "order", order_id, "returned_goods")
            else:
                return self.json({"error": "Unknown order action"}, 404)
        self.json({"ok": True})

    def create_legacy_request(self):
        data = self.body()
        return self.create_order_from_legacy(data)

    def create_order_from_legacy(self, data):
        data["order_type"] = data.get("request_type", "request")
        data["items"] = [{"equipment_id": data.get("equipment_id"), "quantity": data.get("quantity", 1)}]
        return self.create_order()

    def legacy_decide(self, item_id):
        return self.json({"error": "Use /api/orders/{id}/decide"}, 410)

    def notifications(self):
        user = self.require("notifications:read")
        if not user: return
        with db() as conn:
            data = [dict(row) for row in conn.execute("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30", (user["id"],)).fetchall()]
            conn.execute("UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE user_id=?", (user["id"],))
        self.json({"notifications": data})

    def syslog(self):
        user = self.require("audit:read")
        if not user: return
        self.json({"syslog": rows("SELECT s.*, u.username, u.full_name FROM syslog s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 200")})

    def list_users(self):
        user = self.require("all")
        if not user: return
        with db() as conn:
            users = [add_roles(conn, row) for row in conn.execute("SELECT id,username,full_name,role,active,created_at FROM users ORDER BY username").fetchall()]
        self.json({"users": users})

    def create_user(self):
        user = self.require("all")
        if not user: return
        data = self.body()
        with db() as conn:
            roles = data.get("roles") or [data.get("role")]
            cur = conn.execute("INSERT INTO users (username,password_hash,full_name,role,active) VALUES (?,?,?,?,?)", (data["username"], hash_password(data["password"]), data["full_name"], roles[0], int(data.get("active", 1))))
            set_user_roles(conn, cur.lastrowid, roles)
            log_activity(conn, user["id"], "create", "user", cur.lastrowid, data["username"])
        self.json({"id": cur.lastrowid}, 201)

    def user_item(self, method, item_id):
        user = self.require("all")
        if not user: return
        if method not in ("PUT", "DELETE"):
            return self.json({"error": "Method not allowed"}, 405)
        data = self.body() if method != "DELETE" else {}
        with db() as conn:
            target_id = int(item_id)
            target = conn.execute("SELECT username, active FROM users WHERE id=?", (target_id,)).fetchone()
            if not target:
                return self.json({"error": "User not found"}, 404)
            if method == "DELETE":
                if target_id == user["id"]:
                    return self.json({"error": "You cannot delete your own user account."}, 409)
                transaction_references = (
                    ("orders", "requester_id"), ("orders", "authorizer_id"), ("orders", "decider_id"),
                    ("requests", "requester_id"), ("requests", "approver_id"),
                    ("stock_movements", "user_id"),
                )
                referenced = any(
                    conn.execute(
                        f"SELECT 1 FROM {ref_table} WHERE {ref_col}=? LIMIT 1", (target_id,)
                    ).fetchone()
                    for ref_table, ref_col in transaction_references
                )
                if referenced:
                    return self.json(
                        {"error": "This user is referenced by a store transaction and cannot be deleted. Deactivate the user instead."},
                        409,
                    )
                conn.execute("DELETE FROM notifications WHERE user_id=?", (target_id,))
                deleted_user = "Deleted user: {}".format(target["username"])
                conn.execute(
                    """UPDATE syslog SET user_id=NULL,
                       details=CASE WHEN length(details)=0 THEN ? ELSE ? || char(59) || char(32) || details END
                       WHERE user_id=?""",
                    (deleted_user, deleted_user, target_id),
                )
                conn.execute("DELETE FROM users WHERE id=?", (target_id,))
                log_activity(conn, user["id"], "delete", "user", target_id, target["username"])
                return self.json({"ok": True})
            if "active" in data and "username" not in data:
                active = 1 if data["active"] else 0
                if target_id == user["id"] and not active:
                    return self.json({"error": "You cannot deactivate your own user account."}, 409)
                conn.execute("UPDATE users SET active=? WHERE id=?", (active, target_id))
                action = "activate" if active else "deactivate"
                log_activity(conn, user["id"], action, "user", target_id, target["username"])
                return self.json({"ok": True})
            roles = data.get("roles") or [data.get("role")]
            fields = [data["username"], data["full_name"], roles[0], int(data.get("active", target["active"])), target_id]
            conn.execute("UPDATE users SET username=?, full_name=?, role=?, active=? WHERE id=?", fields)
            set_user_roles(conn, target_id, roles)
            if data.get("password"):
                conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data["password"]), target_id))
            log_activity(conn, user["id"], "update", "user", target_id, data["username"])
        self.json({"ok": True})


def main():
    init_db()
    Handler(None, None, None) if False else None
    with db() as conn:
        conn.execute("DROP VIEW IF EXISTS equipment_view")
        conn.execute(
            """
            CREATE VIEW equipment_view AS
            SELECT e.*, c.name category_name, c.category_no, g.name group_name, g.group_no,
                   l.name location_name, l.locate_no, l.details location_details
            FROM equipment e
            LEFT JOIN categories c ON c.id=e.category_id
            LEFT JOIN groups g ON g.id=e.group_id
            LEFT JOIN locations l ON l.id=e.location_id
            """
        )
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f"VTCC Inventory running at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
