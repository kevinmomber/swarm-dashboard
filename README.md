# Swarm Dashboard

Ein Web-Frontend zur Verwaltung eines **Docker Swarm** —
Übersicht, Nodes, Services (skalieren / aktualisieren / entfernen), Stacks
(deployen / entfernen), Tasks, Ressourcen und **Live-Logs**.

**Stack:** React + Vite (Frontend) · Node.js + Express + dockerode (Backend) ·
WebSocket-Log-Streaming.

---

## Features

| Bereich      | Funktionen |
|--------------|------------|
| Übersicht    | Cluster-Info, Node-/Service-/Task-/Stack-Zähler, Engine-Details |
| Nodes        | Rolle, Status, Verfügbarkeit ändern (activate / drain); reservierte CPU/RAM je Node + **echte** CPU-/RAM-/Disk-Auslastung des verbundenen Nodes; **Node aus Swarm entfernen** (mit Bestätigungshaken) |
| Services     | **Namenssuche** (Freitext), Skalieren, Image-Update / Force-Restart, **Update-Prüfung** (neues Image → farbliche Hervorhebung), entfernen, Live-Logs, **Web-Konsole** (docker exec, kein SSH), **Export** (Image-Tarball), **Tagging**-Button, **Views**: Liste / nach Stack / nach Custom-Tag; **Klick auf Servicenamen → Platzierung** (Nodes/Worker/Manager) |
| Stacks       | Aus Compose-YAML deployen, **bearbeiten** (gespeichert oder rekonstruiert), **Klick → Detail** (Services, Nodes, „nicht deployed"), speichern ohne Deploy, Import/Export, YAML-Highlighting, entfernen |
| Tasks        | Zustand pro Task inkl. Node-Zuordnung und Fehlern |
| **Container** | Eigenständige (nicht als Service deployte) Container clusterweit, Node-Filter, Start/Stop/Restart/Entfernen |
| **Images**   | Alle Images je Node, „in Verwendung"-Flag, Löschen/Prune, Download, Upload, Node-Filter |
| Ressourcen   | Netzwerke, Volumes, Secrets, Configs |
| **Einstellungen** | Dark/Light-Theme · Über/Version + Self-Update + Nutzungsrechte · **Authentifizierung** (lokale Benutzer) · **Monitoring & Alerting** · **Registries & Git** · Reverse Proxy (Traefik/nginx) · mehrere Backup-Zeitpläne (SMB/CIFS oder lokal, inkl. Bind-Mounts) · Restore |

---

## Nodes — Auslastung

Die Node-Ansicht zeigt pro Node CPU-, RAM- und Disk-Auslastung. Es gibt zwei Quellen:

1. **Node-Agent (empfohlen, echte Live-Werte für *alle* Nodes):** Der Stack deployt einen
   globalen Service `swarmdash-agent` (ein Container je Node, gleiches Image, Entrypoint
   `node server/src/agent.js`). Jeder Agent liest die echten Host-Werte (`/proc/meminfo`,
   `/proc/loadavg`, `statfs` über einen read-only Host-Mount) und meldet sie inkl. Node-ID.
   Das Dashboard löst alle Agent-Tasks per Docker-DNS (`dnsrr`-Alias `swarmdash-agent`) auf,
   aggregiert deren Werte und ordnet sie den Nodes zu. Solche Zeilen tragen ein **agent**-Badge.
2. **Fallback (ohne Agent):** reservierte CPU/RAM-Kapazität je Node (aus Task-Reservierungen,
   clusterweit) plus eine Live-Probe für den verbundenen Node über einen kurzlebigen Container.

Der Agent benötigt den **read-only Host-Mount** (`/:/host:ro`) für Metriken. Zusätzlich wird der
**lokale Docker-Socket** eingebunden, damit der Agent Konsole (`exec`) und Export (`commit`) für
Container **auf seinem Node** ausführen kann — das ist Voraussetzung dafür, dass Konsole/Export
auch für entfernte Nodes funktionieren. Der Socket gewährt Root-äquivalenten Zugriff auf dem Node;
wer nur Metriken möchte, kann den Socket-Mount im Stack entfernen.
Konfiguration über `AGENT_SERVICE` / `AGENT_PORT`
(Dashboard) bzw. `HOST_ROOT` / `NODE_ID` / `NODE_HOSTNAME` (Agent, per Swarm-Template gesetzt).

---

## Services — Konsole, Export, Tagging, Views

- **Web-Konsole** — interaktive Shell (`docker exec`) im laufenden Container direkt im Browser
  (xterm.js über WebSocket `/ws/exec`), ohne SSH. Läuft der Container auf einem **anderen Node**,
  vermittelt das Dashboard die Sitzung transparent über den **Node-Agenten** dieses Nodes
  (WS-Relay); ohne Agent nur für den verbundenen Node verfügbar. `?via=agent` erzwingt den
  Broker-Pfad (Diagnose).
- **Export** — erstellt aus dem laufenden Container ein vollständiges Image (Commit) und lädt es
  als `docker load`-fähiges Tarball herunter (`GET /api/services/:id/export`). Für Container auf
  entfernten Nodes streamt das Dashboard das Abbild über den dortigen Agenten durch.
- **Tagging** — Aktions-Button mit Auswahlmenü (Backup / Reverse-Proxy / Gruppe / eigenes Label);
  „Custom" gibt ein Freitextfeld frei. Setzt/entfernt Service-Labels.
- **Views** — Services als flache Liste, **nach Stack** oder **nach Custom-Tag**
  (`swarmdash.tag`) gruppiert.

---

## Reverse Proxy

Im Einstellungsbereich wählbar: **Traefik** oder **nginx**, mit externem DNS-Namen und
(für Traefik) Entrypoint, Cert-Resolver, Overlay-Netzwerk und TLS-Schalter. Ein Service nimmt am
Proxy teil, sobald er `swarmdash.proxy=true` trägt. Routing:

- **Eigener DNS-Name** über `swarmdash.proxy.host=app.example.com`, oder
- **externer DNS + `/servicename`** (Pfad-Routing), wenn kein eigener Host gesetzt ist.
- optionaler Container-Port über `swarmdash.proxy.port`.

**Traefik:** Die passenden `traefik.*`-Labels werden per Klick direkt am Service gesetzt
(inkl. StripPrefix-Middleware bei Pfad-Routing). **nginx:** eine fertige Server-/Location-Config
wird generiert und heruntergeladen.

---

## Container & Images

- **Container** — listet clusterweit alle **eigenständigen** Container (ohne Swarm-Service-Label),
  je Node gefiltert, mit Start/Stop/Restart/Entfernen. Aggregation über die Node-Agenten.
- **Images** — alle Images je Node mit „in Verwendung"-Flag; Löschen einzelner Images, **Prune**
  ungenutzter (dangling) Images, **Download** (docker save) und **Upload** (docker load, `.tar`)
  auf einen gewählten Node. Filter nach Node.

## Stacks — Speichern, Import/Export

Der Editor mit YAML-Syntaxhervorhebung bietet **Deployen**, **Speichern & Deployen** und
**Speichern ohne Deploy** (Definition wird in `DATA_DIR/stacks.json` abgelegt). Gespeicherte
Definitionen lassen sich bearbeiten, als `.yml` **exportieren** und wieder **importieren**.

## Über, Version & Self-Update

Der Bereich „Über & Version" zeigt Version, Ersteller, Image, Service, Node und Docker-Version,
prüft per Klick auf ein neueres Image (Registry-Digest-Abgleich) und kann den **Dashboard-Service
selbst aktualisieren** (rollend, start-first). Zusätzlich ein einblendbarer **Nutzungsrechte**-Text.

## Authentifizierung

Optionale lokale Benutzerverwaltung (standardmäßig aus). Passwörter werden per **scrypt** gehasht,
Sitzungen über signierte **HMAC-Token** (12 h) geführt. Ist die Authentifizierung aktiv, sind alle
API-Aufrufe und WebSockets (Logs/Konsole) geschützt; Rollen `admin`/`viewer`. Erst einen Benutzer
anlegen, dann aktivieren.

## Monitoring & Alerting

Überwacht Nodes (CPU/RAM/Disk gegen Schwellen, Node-Status) und per Label
`swarmdash.monitor=<tag>` ausgewählte Services (Repliken-Sollzustand) im konfigurierbaren Intervall.
Alarme werden **transitionsbasiert** (nur bei Zustandswechsel) an aktive Kanäle gesendet:
**Webhook** (Endpunkt-Service), **Matrix**, **MQTT** und **E-Mail (SMTP)**. Zusätzlich publiziert
das Monitoring periodische **Statusmeldungen per MQTT** (`<prefix>/node/<host>/status`,
`<prefix>/service/<name>/status`, `<prefix>/health`). Geheimnisse (MQTT-Passwort, Matrix-Token,
SMTP-Passwort) werden serverseitig gespeichert und nie über die API zurückgegeben.

## Einstellungen & Backups

Der Bereich **Einstellungen** bietet:

- **Erscheinungsbild** — Dark-/Light-Mode, sofort wirksam, server- und
  clientseitig persistiert (geräteübergreifend).
- **Mehrere Backup-Zeitpläne** — beliebig viele Jobs, jeder mit eigenem Cron-Ausdruck,
  eigener Aufbewahrung und eigenem **Backup-Tag** (`node-cron` im Backend, ein Cron-Task je Job).
- **Backup-Ziel** — gemeinsames Ziel für alle Jobs: **lokaler Host-Pfad** (Bind-Mount auf dem
  Manager-Node) **oder** **SMB/CIFS-Share** (Host, Share, Unterordner, Benutzer, Passwort,
  Version). Das Passwort wird serverseitig gespeichert und in API-Antworten nie zurückgegeben.
- **Service-Auswahl per Tagging** — ein Job sichert alle Services, deren Label
  `swarmdash.backup=<tag>` dem Job-Tag entspricht. Gesichert werden deren **Named Volumes**:

  ```bash
  # Standard-Job (Tag "true")
  docker service update --label-add swarmdash.backup=true <service>

  # eigenem Job zuordnen (z. B. Job mit Tag "db")
  docker service update --label-add swarmdash.backup=db <service>

  # optional nur bestimmte Volumes sichern
  docker service update --label-add swarmdash.backup.volumes=db_data,uploads <service>
  ```

- **Restore** — listet die Archive im Ziel (nach Volume gruppiert) und spielt ein gewähltes
  Archiv in sein Volume zurück (optional Volume vorher leeren).

**Funktionsweise:** Pro **Named Volume oder Bind-Mount** startet das Backend einen kurzlebigen
`alpine`-Container, der die Quelle (read-only) und das Ziel einhängt und ein
`tar.gz`-Archiv (`<volume>-YYYYMMDD-HHmmss.tar.gz`) schreibt. Bind-Mounts werden über ihren
(base64url-kodierten) Host-Pfad identifiziert und beim Restore genau dorthin zurückgespielt.
Anschließend greift die Aufbewahrungsregel. Läufe erscheinen in der **Backup-Historie**.

> Hinweise: Die kurzlebigen Container laufen auf dem Manager-Node — es werden nur
> Volumes gesichert, die auf diesem Node liegen. SMB/CIFS erfordert Kernel-CIFS-
> Unterstützung auf dem Host. Das `alpine`-Image wird bei Bedarf automatisch geladen.

---

## Schnellstart (Entwicklung)

Zwei Terminals — das Backend spricht mit Ihrem Docker/Swarm-Endpoint, das
Frontend läuft über Vite mit Proxy auf das Backend.

```powershell
# Terminal 1 – Backend (Port 3000)
cd server
npm install
# optional: an einen Remote-Swarm-Manager anbinden
$env:DOCKER_HOST = "tcp://<manager-ip>:2375"
npm run dev

# Terminal 2 – Frontend (Port 5173, proxyt /api und /ws auf :3000)
cd client
npm install
npm run dev
```

Anschließend <http://localhost:5173> öffnen.

> Die lokale Maschine muss kein Swarm-Manager sein. Verwaltungsaktionen
> funktionieren, sobald das Backend über `DOCKER_HOST` mit einem **Manager-Node**
> verbunden ist. Ist der Endpoint kein Manager, zeigt das Dashboard einen Hinweis
> und liefert nur Basisinformationen.

---

## Produktion — im Swarm betreiben (empfohlen)

Container läuft auf einem Manager-Node, der Docker-Socket wird gemountet.

```bash
# 1) Image bauen (auf einem Node mit Zugriff auf die Registry / lokal)
docker build -t swarm-dashboard:latest .

# 2) Als Stack deployen
docker stack deploy -c docker-stack.yml swarmdash
```

Dashboard danach unter `http://<manager>:3000` erreichbar.

Der `docker-stack.yml`:
- platziert den Dienst per `node.role == manager`,
- mountet `/var/run/docker.sock`,
- veröffentlicht Port 3000.

### Fertiges Image veröffentlichen (`latest`)

Nach Build, Test und `git push` wird das fertige Image zusätzlich abgelegt:

```powershell
$env:GITEA_PW = '<Git-Mirror-Passwort>'      # wird nicht gespeichert; sonst Abfrage
.\scripts\publish-image.ps1             # Version aus server/package.json
```

| Ziel | Ablage |
|---|---|
| **Git-Mirror** | Container-Registry `registry.example.com/admin/swarm-dashboard:latest` und `:<Version>` |
| **GitHub** | Release `latest` mit dem Asset `swarm-dashboard-latest.tar` (`docker load -i …`) |

Die Git-Mirror-Registry nutzt eine interne CA und ist vom Entwicklungsrechner nicht per Name erreichbar.
Das Skript kopiert das Image deshalb mit `skopeo` aus einem Wegwerf-Container auf der Staging-Node
(TLS-Prüfung nur für diese Übertragung aus); am Host wird nichts verändert. GitHub-Container-Registry
(`ghcr.io`) ist nicht eingerichtet, da dafür der Token-Scope `write:packages` fehlt – der Release-Asset
braucht nur den Scope `repo`. Parameter: `-SkipGit-Mirror`, `-SkipGitHub`, `-Version`.

---

## Konfiguration (Umgebungsvariablen)

| Variable            | Zweck | Standard |
|---------------------|-------|----------|
| `PORT`              | HTTP-Port des Servers | `3000` |
| `DATA_DIR`          | Ablage für `settings.json` + Backup-Historie | `server/../data` (Stack: `/data`) |
| `AGENT_SERVICE`     | DNS-Name/Alias des Node-Agenten (Dashboard) | `swarmdash-agent` |
| `AGENT_PORT`        | Port des Node-Agenten | `9787` |
| `HOST_ROOT`         | Read-only Host-Mount im Agent-Container | `/host` |
| `DOCKER_HOST`       | `tcp://host:2375\|2376`, `unix://…`, `npipe://…` | lokaler Socket/Pipe |
| `DOCKER_TLS_VERIFY` | `1` für TLS (Port 2376) | – |
| `DOCKER_CERT_PATH`  | Ordner mit `ca.pem`, `cert.pem`, `key.pem` | – |

---

## API

| Methode & Pfad | Beschreibung |
|----------------|--------------|
| `GET /api/info` | Cluster-/Swarm-Info + Zählungen |
| `GET /api/nodes` · `POST /api/nodes/:id/availability` · `/role` | Nodes verwalten |
| `GET /api/nodes/metrics` | Echte CPU-/RAM-/Disk-Auslastung des verbundenen Nodes |
| `GET /api/services` · `POST …/:id/scale` · `/update` · `DELETE …/:id` | Services verwalten |
| `POST /api/services/:id/labels` · `GET /api/services/:id/export` | Labels setzen/entfernen · Image-Export |
| `POST /api/services/check-updates` | Prüft je Service auf ein neueres Image (Registry-Digest) |
| `GET /api/services/:id/placement` | Nodes, auf denen die Tasks des Service laufen |
| `GET /api/stacks/:name/detail` | Services eines Stacks + Platzierung + „nicht deployed" |
| `DELETE /api/nodes/:id` | Node aus dem Swarm entfernen (nicht der verbundene) |
| `GET/POST /api/registries` · `DELETE …/:id` · `POST …/:id/test` | Registries verwalten/prüfen |
| `GET/POST /api/git` · `DELETE …/:id` · `POST …/:id/fetch` | Git-Repos verwalten · Compose abrufen |
| `GET /api/stacks` · `POST /api/stacks/deploy` · `DELETE /api/stacks/:name` | Stacks |
| `GET /api/stacks/:name/compose` · `GET/PUT/DELETE /api/stacks/saved…` | Stack bearbeiten (rekonstruiert) · gespeicherte Definitionen |
| `GET /api/tasks?service=` | Tasks |
| `GET /api/networks` · `/volumes` · `/secrets` · `/configs` | Ressourcen |
| `GET /api/settings` · `PUT /api/settings` | Theme + Reverse-Proxy + Backup-Jobs (Passwort maskiert) |
| `GET /api/backup/services?tag=` | Getaggte Services + Volumes (optional nach Job-Tag) |
| `POST /api/backup/run` (`{jobId}`) · `GET /api/backup/history` | Backup-Job starten / Verlauf |
| `GET /api/backup/archives` · `POST /api/backup/restore` | Archive auflisten / zurückspielen |
| `POST /api/backup/test-target` | Ziel auf Schreibbarkeit prüfen |
| `GET /api/proxy/services` · `POST /api/proxy/apply/:id` · `GET /api/proxy/nginx-config` | Reverse Proxy |
| `GET /api/containers` · `POST /api/containers/action` | Eigenständige Container + Lifecycle |
| `GET /api/images` · `POST …/action` · `/prune` · `GET …/export` · `POST …/import` | Images verwalten/aufräumen/übertragen |
| `GET /api/stacks/saved` · `PUT …` · `DELETE …/:name` · `GET …/:name/export` | Gespeicherte Stack-Definitionen |
| `GET /api/system/version` · `POST /api/system/check-update` · `/update` | Version & Self-Update |
| `GET /api/auth/status` · `POST /api/auth/login` · `/users` · `/enable` · `/password` | Authentifizierung & Benutzer |
| `GET /api/monitoring/status` · `POST /api/monitoring/test` | Monitoring & Alert-Test |
| `WS /ws/logs?service=ID&tail=N` | Live-Service-Logs |
| `WS /ws/exec?service=ID&shell=/bin/sh` | Interaktive Container-Konsole |
| Node-Agent: `GET /metrics` · `GET /health` · `GET /export` · `WS /exec` (Port 9787, intern) | Host-Metriken + Konsole/Export-Vermittlung je Node |

---

## Sicherheitshinweis

Dieses Werkzeug gewährt vollen Zugriff auf den Docker-Socket des Managers
(= Root-Äquivalent auf dem Host). Es enthält **keine Authentifizierung** —
betreiben Sie es ausschließlich in einem vertrauenswürdigen, nicht öffentlich
erreichbaren Netz oder hinter einem Reverse-Proxy mit Auth (z. B. Traefik +
Basic-Auth / OAuth).
