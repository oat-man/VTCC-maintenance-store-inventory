# VTCC Maintenance Store Inventory

A self-contained web-based inventory system for the VTCC maintenance store. It uses Python standard library HTTP services and SQLite, so it can run without downloading packages. SQLite is an open-source relational database; the SQL access is kept in `app.py` so it can be migrated to PostgreSQL or MySQL later.

## Functions included

- CRUD for equipment and users.
- Role-based access:
  - `administrator`: all modules, users, equipment, requests, dashboard.
  - `front_end`: request and return equipment.
  - `store_manager`: approve or reject requests and returns.
  - `store`: check and update equipment in store.
- QR-code style equipment marker display and browser camera scanning using `BarcodeDetector` when supported.
- Manual equipment number entry for all browsers.
- Dashboard for below-minimum and above-maximum stock levels.
- Request, return, approval, and stock movement history.

## Design documentation

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for UML diagrams, workflows, API structure, and database structure.

## Run

```powershell
python app.py
```

Open:

```text
http://127.0.0.1:8000
```

## Seed accounts

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Front-end User | `front` | `front123` |
| Store Manager | `manager` | `manager123` |
| Store Officer | `store` | `store123` |

Change these passwords before production use.

## Production notes

- Set a strong `SESSION_SECRET` environment variable.
- Place the app behind HTTPS so camera-based QR scanning works reliably.
- Replace SQLite with PostgreSQL or MySQL if multiple concurrent sites or central enterprise hosting is required.
- Add organization-specific approval rules, audit reports, and backup policy before live operation.
