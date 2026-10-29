# Swarm Dashboard

Web-Oberfläche zur Verwaltung eines **Docker Swarm** — Übersicht, Nodes, Services, Stacks
(inkl. GitOps), Container, Images (inkl. Builder), Ressourcen (Netzwerke, Volumes, Secrets,
Configs), Security-Scans, Reverse Proxy, Monitoring, Backup und Live-Logs/Konsole im Browser.

**Stack:** React 18 + Vite (Frontend) · Node.js 22 (ESM) + Express + dockerode (Backend) ·
WebSocket (Logs, Konsole, Ereignisse) · `node:sqlite` (Metrik-/Scan-Verläufe).
**Ein Image, zwei Rollen:** das **Dashboard** (auf einem Manager) und ein globaler
**Node-Agent** (je Node) laufen aus demselben Image `swarm-dashboard`.

---

## Inhalt

[Schnellstart](#schnellstart-fertiges-image-aus-github) ·
[Features](#features) ·
[Bereiche im Detail](#bereiche-im-detail) ·
[Image bauen & veröffentlichen](#image-bauen--veröffentlichen) ·
[Konfiguration](#konfiguration) ·
[API](#api) ·
[Sicherheit](#sicherheitshinweis) ·
[Lizenz](#lizenz)

---

## Schnellstart: fertiges Image aus GitHub

Jedes Release wird zusätzlich als **fertiges Image** im GitHub-Release **`latest`** abgelegt
(Assets `swarm-dashboard-latest.tar` und `docker-stack.yml`). Ein Klonen und Bauen ist nicht nötig.

**Voraussetzungen:** ein Docker-Swarm mit mindestens einem Manager, Zugriff auf den Manager
(`docker`-CLI oder Docker-Context) und — da das Repository **privat** ist — die
[GitHub CLI](https://cli.github.com/) (`gh auth login`) bzw. ein Token mit Leserecht auf das Repo.

### Variante A — Image aus dem GitHub-Release laden

```bash
# 1) Release-Dateien herunterladen (Image-Tarball + Stack-Datei)
gh release download latest --repo kevinmomber/swarm-dashboard \
  --pattern "swarm-dashboard-latest.tar" --pattern "docker-stack.yml"

# 2) Image auf JEDEM Swarm-Node laden (Manager und Worker). Der Node-Agent läuft als
#    globaler Service auf allen Nodes und braucht das Image lokal.
docker --context <manager> load -i swarm-dashboard-latest.tar
docker --context <worker>  load -i swarm-dashboard-latest.tar     # je weiterem Node

# 3) Stack auf dem Manager deployen
docker --context <manager> stack deploy --resolve-image=never -c docker-stack.yml swarmdash
```

*(Direkt auf dem Manager entfällt `--context …`. Ohne Context lädt `docker load -i …` auf dem
lokalen Host.)* `--resolve-image=never` ist bei lokal geladenen Images nötig, weil der Deploy
sonst versucht, das Image in einer Registry nachzuschlagen.

Der Port lässt sich per Variable ändern (Standard `3000`):

```bash
SWARMDASH_PORT=8080 docker stack deploy --resolve-image=never -c docker-stack.yml swarmdash
# PowerShell:  $env:SWARMDASH_PORT = '8080'; docker stack deploy ...
```

### Variante B — Image aus einer eigenen Registry ziehen

Das Image aus Variante A (Schritt 1–2) lässt sich auf einem Rechner mit Zugriff auf Ihre Registry laden,
neu taggen (`docker tag swarm-dashboard:latest <registry>/swarm-dashboard:latest`) und pushen. Danach:

```bash
docker login <registry> -u <benutzer>
SWARMDASH_IMAGE=<registry>/swarm-dashboard:latest \
  docker stack deploy --with-registry-auth -c docker-stack.yml swarmdash
```

Die Variable `SWARMDASH_IMAGE` gilt für Dashboard **und** Agent und wird automatisch auch als
`HELPER_IMAGE` gesetzt (Hilfs-Container für Volume-Kopien). Verwendet die Registry eine **interne CA**, muss
deren Zertifikat auf **jedem Node** im Docker-Daemon vertraut werden
(`/etc/docker/certs.d/<registry>/ca.crt`), sonst scheitert der Pull mit
`x509: certificate signed by unknown authority`.

### Erster Start

1. `http://<manager>:3000` öffnen (bzw. den gesetzten `SWARMDASH_PORT`).
2. Unter **Nodes** sollten alle Nodes mit dem Badge **agent** erscheinen (echte CPU/RAM/Disk).
3. **Einstellungen → Authentifizierung:** einen Admin-Benutzer anlegen, **danach** aktivieren —
   die Anmeldung ist standardmäßig **aus** (siehe [Sicherheitshinweis](#sicherheitshinweis)).
4. Optional: Reverse Proxy, Monitoring, Backup-Zeitpläne einrichten.

> **Stack-Name:** Das Self-Update (Über & Version) sucht den Service `swarmdash_dashboard`
> (`SELF_SERVICE`). Wird der Stack anders benannt, `SELF_SERVICE=<stack>_dashboard` setzen.

### Aktualisieren

Neues Release laden (Schritt 1–2) und beide Services mit **der Versionsnummer** aktualisieren
(sie steht im Release-Titel und unter *Einstellungen → Über & Version*):

```bash
docker service update --force --image swarm-dashboard:<version> swarmdash_agent
docker service update --force --image swarm-dashboard:<version> swarmdash_dashboard
```

Beide müssen auf dieselbe Version — neue Agent-Funktionen (z. B. Netzwerke, Container-Statistik)
brauchen einen aktualisierten Agent auf allen Nodes.

### Entfernen

```bash
docker stack rm swarmdash
docker volume rm swarmdash_swarmdash_data      # Daten (Einstellungen, Benutzer, Verläufe) — erst nach Backup!
```

---

## Features

| Bereich | Funktionen |
|---------|------------|
| **Übersicht** | Cluster-Info, Node-/Service-/Task-/Stack-Zähler, Engine-Details |
| **Nodes** | Rolle/Status, Verfügbarkeit (activate/drain), echte CPU-/RAM-/Disk-Auslastung **aller** Nodes über die Agents, 48-h-Verlauf, Node entfernen |
| **Services** | Suche, Listen-/Stack-/Tag-Ansicht, Update-Prüfung, Skalieren, Image-Update, **Bearbeiten & Redeploy**, **Migration (vMotion)**, Rollback, Logs, Web-Konsole, Export, Tagging; **Platzierung & Ressourcen** (Live-CPU/RAM, Volumes, Netzwerke, Configs, Secrets) |
| **Stacks** | Deployen aus Compose-YAML, bearbeiten, speichern ohne Deploy, Import/Export, Detailansicht; **GitOps** (Auto-Deploy aus Git) |
| **Topologie** | Diagramm der Beziehungen zwischen Stacks, Services und Netzwerken |
| **Aktivität** | Live-Ereignisstrom der Docker-Engine |
| **Tasks** | Zustand pro Task inkl. Node und Fehlern |
| **Container** | Eigenständige und gestoppte Task-Container clusterweit, Lifecycle, Bearbeiten & Redeploy, Dateibrowser |
| **Images** | Alle Images je Node, Löschen/Prune/Pull, Download/Upload, **integrierter Builder** (BuildKit, Push in Registry) |
| **Ressourcen** | **Netzwerke anlegen/bearbeiten/löschen** (overlay, macvlan, ipvlan, IPv6), Volumes (Dateibrowser, Duplizieren, Export/Import, Migration), Bind-Mount-Analyse, Secrets, Configs |
| **Security** | Trivy-CVE-Scan aller Images mit Score, Best-Practice-Prüfung (Docker-/Host-Härtung) mit Verlauf und Zeitplan, interne **PKI** |
| **Einstellungen** | Theme · Über & Version/Self-Update · Authentifizierung (Rollen) · Monitoring · Registries & Git · GitOps · Docker-Endpoints · Reverse Proxy (Traefik/nginx) · Tailscale/DockTail · Backup · Secret-Tresor · Audit-Log |
| **Global** | Befehlspalette **Strg/Cmd + K** (Seiten, Services, Tasks, Volumes, Images, Nodes) · Dark-/Light-Theme |

---

## Bereiche im Detail

### Nodes — Auslastung

Pro Node CPU-, RAM- und Disk-Auslastung. Zwei Quellen:

1. **Node-Agent (empfohlen, echte Live-Werte für *alle* Nodes):** Der Stack deployt einen globalen
   Service `swarmdash-agent` (Entrypoint `node server/src/agent.js`). Jeder Agent liest die
   Host-Werte (`/proc/meminfo`, `/proc/loadavg`, `statfs` über einen read-only Host-Mount) und meldet
   sie mit Node-ID. Das Dashboard findet die Agents per Docker-DNS (`dnsrr`-Alias `swarmdash-agent`).
   Solche Zeilen tragen ein **agent**-Badge.
2. **Fallback (ohne Agent):** reservierte CPU/RAM aus den Task-Reservierungen plus eine Live-Probe
   für den verbundenen Node über einen kurzlebigen Container.

Ein Hintergrund-Sampler schreibt **einmal pro Minute** CPU/RAM/Disk je Node nach `metrics.db`
(48 Stunden Verlauf, Diagramme in der Node-Ansicht).

**Der Agent** braucht den read-only Host-Mount (`/:/host:ro`) und den **lokalen Docker-Socket**. Damit
erledigt er alles, was Swarm nicht über den Manager vermittelt: Konsole (`exec`), Export (`commit`),
node-lokale Listen (Container, Images, Volumes), Volume-Größen und -Kopien, Container-Statistik,
Netzwerk-Hilfsnetze (macvlan/ipvlan), Trivy-Scans und Host-Prüfungen. Der Socket gewährt
Root-äquivalenten Zugriff auf dem Node.

### Services

**Aktionen** (Menü je Zeile): Logs · Web-Konsole · Platzierung · Skalieren · Bearbeiten & Redeploy ·
Migration (vMotion) · Update · Rollback · Export · Tag · Entfernen. Status-Badges: *gesund*,
*degradiert*, *down*, *gestoppt*, *Update läuft/pausiert*. „Nach Updates suchen" vergleicht den
Registry-Digest mit dem im Service gepinnten Digest.

- **Platzierung & Ressourcen** (Klick auf den Servicenamen): je Task Node, Rolle, Slot, **Live-CPU und
  -RAM** (Aktualisierung alle 5 s), darunter **Volumes** mit Größe, **Netzwerke** mit Typ, Subnetz und der
  tatsächlichen Adresse je Task (bei macvlan/ipvlan IPv4, IPv6 und MAC), **Configs** (Name + Pfad im
  Container) und **Secrets** (nur der Name — Inhalte werden nie gelesen).
- **Bearbeiten & Redeploy:** Image, Repliken, Neustart-Bedingung, **Node-Bindung**, Ports, Umgebungsvariablen,
  Argumente, Mounts, **Netzwerke**, CPU-/RAM-Limits und -Reservierungen. Reiter *Layer*, *Prozesse* und
  *Dateien* zeigen Image-Layer, Prozesse und das Dateisystem des laufenden Containers. Speichern löst ein
  rollendes Update aus.
- **Host-Netzwerk:** Schalter „Host-Netzwerk verwenden". Docker erlaubt `host` nur als **einziges**
  Netzwerk: Overlays und veröffentlichte Ports entfallen, der Service ist nicht über Service-DNS oder den
  Proxy erreichbar. Für Dienste, die LAN-Präsenz **und** Overlay brauchen (z. B. Matter), stattdessen ein
  **macvlan-Netzwerk** zusätzlich zum Overlay verwenden (siehe Ressourcen → Netzwerke).
- **Migration (vMotion):** kopiert die Named Volumes des Service auf einen anderen Node und bindet den
  Service per `node.hostname`-Constraint dorthin. Die Quell-Volumes bleiben unverändert (Rollback möglich);
  Bind-Mounts werden gemeldet, aber nicht kopiert.
- **Web-Konsole:** interaktive Shell (`docker exec`, xterm.js über `WS /ws/exec`). Liegt der Container auf
  einem anderen Node, vermittelt der dortige Agent die Sitzung.
- **Export:** vollständiges Image des laufenden Containers als `docker load`-fähiges Tarball.
- **Tagging:** Backup / Reverse-Proxy / Gruppe / eigenes Label. **Views:** Liste, nach Stack, nach Custom-Tag
  (`swarmdash.tag`).

### Stacks & GitOps

- **Stacks:** Editor mit YAML-Highlighting — *Deployen*, *Speichern & Deployen*, *Speichern ohne Deploy*
  (Definitionen in `DATA_DIR/stacks.json`), Export als `.yml`, Import, Detailansicht (Services, Nodes,
  „nicht deployed").
- **GitOps (Einstellungen):** Ein Eintrag verbindet ein Git-Repo (aus *Registries & Git*), einen Compose-Pfad
  und einen Ziel-Stack. Ein Scheduler (oder „Jetzt synchronisieren") klont flach und führt
  `docker stack deploy` aus, **sobald sich die Compose-Datei seit dem letzten erfolgreichen Deploy geändert hat**.

### Container & Images

- **Container:** eigenständige Container (ohne Swarm-Service) und gestoppte Service-Task-Container zum
  Aufräumen, je Node gefiltert; Start/Stop/Restart/Entfernen; **Bearbeiten & Redeploy** (Neuanlage mit
  geänderter Konfiguration) sowie Reiter für Prozesse, **Dateibrowser** und Image-Layer. Aggregation über die
  Node-Agents.
- **Images:** je Node mit „in Verwendung"-Flag; Löschen, **Prune**, **Pull**, **Download** (`docker save`),
  **Upload** (`docker load`, auch mehrere Dateien).
- **Builder:** baut Images aus einem Dockerfile direkt auf dem Daemon des Managers (BuildKit) mit Live-Log,
  optionalem **Push** in eine konfigurierte Registry, gespeicherten Dockerfiles, kurzer Build-Historie und
  Build-Cache-Prune. *Hinweis:* das Ergebnis liegt nur auf dem Manager — für den Swarm in eine Registry pushen.

### Ressourcen

- **Netzwerke:** Anlegen, Bearbeiten und Löschen von **overlay**, **macvlan** und **ipvlan** (L2) mit
  attachable/internal/Verschlüsselung und **IPv6**. Vorlage **„Matter / IPv6 im LAN"** (macvlan + IPv6 +
  attachable). Bei macvlan/ipvlan legt das Dashboard pro Node ein *config-only*-Netzwerk an (Parent-Interface,
  eigener Adressbereich) und das swarm-weite Netzwerk per `ConfigFrom` darüber — Remote-Nodes über den Agent.
  Interfaces je Node werden erkannt; LAN-Subnetz, Gateway und IPv6-Präfix werden vorbelegt.
  *Bearbeiten* ersetzt ein **ungenutztes** Netzwerk (Docker kann Netzwerke nicht ändern) mit Vorab-Prüfung und
  Rollback bei Fehlern; *Löschen* entfernt auch die config-only-Hälften auf allen Nodes. Netzwerke, die ein
  Service verwendet, sind gesperrt, Stack-Netzwerke gehören dem Stack.
  *Grenzen von macvlan:* die Node erreicht ihre eigenen macvlan-Container nicht direkt; in VMs muss der Hypervisor
  zusätzliche MAC-Adressen erlauben; WLAN-Interfaces unterstützen macvlan in der Regel nicht.
- **Volumes:** Filter (Node, Nutzung, Suche), Detail mit Nutzung, **Dateibrowser**, **Export/Import** (Tarball),
  **Duplizieren** (auch node-übergreifend), **Umbenennen**, Anlegen, **Löschen** (Pflicht-Haken, nur ungenutzt;
  Mehrfachauswahl).
- **Bind-Mounts:** read-only Analyse aller Bind-Mounts (Services und Container) mit Einstufung
  *migrierbar* / *bedingt* / *nicht empfohlen* und **Migration in ein Named Volume** (mit Speicherplatz-Vorprüfung).
- **Secrets:** anlegen/löschen; Swarm gibt Werte nie zurück. **Configs:** anlegen/importieren, exportieren, löschen.

### Security

- **CVE-Scan:** Trivy prüft alle Images (Hilfs-Container mit Cache-Volume), Ergebnis je Image und als
  **Scorecard**; Filter nach Status.
- **Best-Practice-Prüfung:** read-only Härtungs-Check des Managers und der Nodes (z. B. `daemon.json`,
  `docker.sock`-Rechte, auditd-Regeln, seccomp/AppArmor, Log-Rotation; Host-Prüfungen laufen über die Agents),
  mit **Verlauf** der Scores, optionalem **Zeitplan** und **Alert-Integration** in das Monitoring.
- **PKI:** interne CA, Zertifikate ausstellen/herunterladen (auch PKCS#12), widerrufen, CRL. Wird für
  **mTLS** am Reverse Proxy genutzt.

### Reverse Proxy

Wählbar: **Traefik** oder **nginx**, mit externem DNS-Namen **oder einer IP** (Entrypoint, Cert-Resolver,
Overlay-Netzwerk, TLS). Ein Service nimmt teil, sobald er `swarmdash.proxy=true` trägt.

| Label | Wirkung |
|-------|---------|
| `swarmdash.proxy.host` | `app.example.com` (Host), `/pfad` oder `host/pfad` (Host + Pfad) |
| `swarmdash.proxy.port` | Container-Port |
| `swarmdash.proxy.entrypoints` | `web`, `websecure` oder `both` (HTTP leitet dann auf HTTPS um) |
| `swarmdash.proxy.mtls` | `off` · `optional` · `require` (Client-Zertifikat aus der internen PKI) |
| `swarmdash.proxy.tailnet` | `true` → zusätzlich über Tailscale erreichbar |

- **Routing:** nur Pfad wird an den externen Host (auch eine IP) gebunden: `Host(<ip>) && PathPrefix(/pfad)`
  mit StripPrefix. **TLS:** ACME-Cert-Resolver oder Zertifikate der internen PKI.
- Das **Frontend läuft auch unter einem Pfad-Präfix**: Assets sind relativ, das Backend setzt `<base href>` aus
  dem Header `X-Forwarded-Prefix`; `/api` und `/ws` richten sich danach.
- **Traefik:** die `traefik.*`-Labels werden per Klick am Service gesetzt. **nginx:** fertige Server-/Location-Config
  zum Download.
- **Tailscale / DockTail:** verwalteter Stack (`tailscaled` + DockTail) neben Traefik; nur Services mit dem
  Tailnet-Label werden über das Tailnet veröffentlicht. Auth-Keys liegen serverseitig und werden als Swarm-Secrets
  injiziert.

### Docker-Endpoints

Zusätzliche Docker-Hosts oder weitere Swarm-Manager registrieren (**tcp** mit TLS-Client-Zertifikaten oder
**ssh**), mit Verbindungstest und Inventar (Container, Images, Volumes, Netzwerke, Fähigkeiten). Zugangsdaten
und Zertifikate bleiben serverseitig und werden nie zurückgegeben. Nur für Administratoren.

### Secret-Tresor

Swarm-Secrets sind schreibgeschützt: ihr Wert lässt sich nach dem Anlegen nicht mehr auslesen. Der Tresor
speichert Werte beim Anlegen **verschlüsselt** (AES-256-GCM, Schlüssel per scrypt aus einer Passphrase) —
getrennt von den Backups. Die Passphrase wird **nie gespeichert**; ohne sie sind Tresor und Export wertlos.
Export/Import als verschlüsselte Datei und Neuanlage der Secrets nach einem Ausfall.

### Monitoring & Alerting

Überwacht Nodes (CPU/RAM/Disk gegen Schwellen, Node-Status), Docker-Endpoints und per Label
`swarmdash.monitor=<tag>` ausgewählte Services (Repliken-Sollzustand) im konfigurierbaren Intervall.
Alarme werden **transitionsbasiert** (nur bei Zustandswechsel) gesendet: **Webhook**, **Matrix**, **MQTT**,
**E-Mail (SMTP)**. Optional periodische **MQTT-Statusmeldungen**
(`<prefix>/node/<host>/status`, `<prefix>/service/<name>/status`, `<prefix>/endpoint/<name>/status`,
`<prefix>/alerts`). Geheimnisse (MQTT-/SMTP-Passwort, Matrix-Token) bleiben serverseitig und werden nie
über die API zurückgegeben. Der Best-Practice-Scan speist seine Alarme in dieselbe Pipeline.

### Backup & Restore

- **Mehrere Zeitpläne** — je Job eigener Cron-Ausdruck, eigene Aufbewahrung, eigener **Backup-Tag**.
- **Ziel** — gemeinsam für alle Jobs: **lokaler Host-Pfad** oder **SMB/CIFS-Share** (Host, Share, Unterordner,
  Benutzer, Passwort, Version; erfordert Kernel-CIFS-Unterstützung). Das Passwort wird nie zurückgegeben.
- **Auswahl per Label:** gesichert werden die **Named Volumes** (und Bind-Mounts) von Services mit
  `swarmdash.backup=<tag>`; `swarmdash.backup.volumes=a,b` beschränkt auf bestimmte Volumes.

  ```bash
  docker service update --label-add swarmdash.backup=true <service>        # Standard-Job
  docker service update --label-add swarmdash.backup=db <service>          # Job mit Tag "db"
  docker service update --label-add swarmdash.backup.volumes=db_data,uploads <service>
  ```

- **Node-bewusst:** jedes Volume wird auf dem Node gelesen, auf dem der Task des Service läuft (nicht auf dem
  Manager). Ein kurzlebiger Helfer-Container (`HELPER_IMAGE`, standardmäßig das Dashboard-Image) hängt Quelle
  (read-only) und Ziel ein und schreibt ein `tar.gz` (`<volume>-YYYYMMDD-HHmmss.tar.gz`); danach greift die
  Aufbewahrungsregel. Läufe erscheinen in der **Backup-Historie**.
- **Restore:** listet die Archive je Volume und spielt eins zurück (optional Volume vorher leeren) — auch auf
  einen anderen Node. Bind-Mount-Restore auf einen Remote-Node wird nicht unterstützt (nur Named Volumes).

### Authentifizierung, Rollen & Audit

Optionale lokale Benutzerverwaltung (**standardmäßig aus**). Passwörter werden mit **scrypt** gehasht,
Sitzungen über signierte **HMAC-Token** (12 h) geführt. Ist die Anmeldung aktiv, sind alle API-Aufrufe und
WebSockets geschützt. **Erst einen Benutzer anlegen, dann aktivieren.**

| Rolle | Rechte |
|-------|--------|
| `admin` | alles |
| `operator` | ändern erlaubt, **außer** PKI, Docker-Endpoints, Einstellungen und Reverse Proxy |
| `viewer` | nur lesen |

Das **Audit-Log** (Einstellungen) protokolliert alle ändernden API-Aufrufe (Benutzer, Zeit, Pfad, Status, Dauer, IP)
sowie **erfolgreiche und fehlgeschlagene Anmeldungen** (Passwörter nie). Filter nach Log-Pfad und Freitext; Ringpuffer
mit den letzten 1000 Einträgen.

### Über, Version & Self-Update

Zeigt Version, Ersteller, Image, Service, Node und Docker-Version, prüft per Registry-Digest auf ein neueres
Image und kann den **Dashboard-Service selbst aktualisieren** (rollend, start-first).

---

## Image bauen & veröffentlichen

```bash
docker build --provenance=false --sbom=false -t swarm-dashboard:<version> -t swarm-dashboard:latest .
```

Der `Dockerfile` baut in drei Stufen (Client, Server-Abhängigkeiten, gehärtete Laufzeit auf `node:22-alpine`,
mit aktuellen OS-Paketen und ohne npm/corepack im Endimage) und führt einen **echten `npm install`** aus —
damit greifen die `overrides` in `server/package.json` (u. a. `qs`, `uuid`, `proxy-addr`, `@grpc/grpc-js`,
`ip-address`). Die Registry ist über `--build-arg NPM_REGISTRY=<url>` wählbar; **Standard ist der
Registry-Mirror**, weil npmjs.org in der Zielumgebung per TLS-Inspektion blockiert ist.
Außerhalb davon z. B. `--build-arg NPM_REGISTRY=https://registry.npmjs.org/`. Für aktuelle OS-Pakete
gelegentlich mit `--no-cache` bauen.

> `Dockerfile.offline` ist ein **Legacy-Notbehelf** (Basis `swarm-dashboard:1.7.0`, überlagert nur Server-Code
> und Client). Seine eingefrorenen `node_modules` führten zu veralteten Abhängigkeiten — für Releases nicht verwenden.

**Image-Sicherheit:** Releases werden mit Trivy gescannt. Bewusst akzeptierte Befunde stehen mit Begründung und
Wiedervorlage in `.trivyignore`.

### Fertiges Image veröffentlichen (`latest`)

Nach Build, Test und `git push`:

```powershell
.\scripts\publish-image.ps1             # Version aus server/package.json
```

Das Skript legt das Image als Release **`latest`** auf GitHub ab (`swarm-dashboard-latest.tar` zum Laden mit
`docker load -i …` und `docker-stack.yml`) und kann es zusätzlich in eine interne Container-Registry kopieren
(Parameter im Skriptkopf; `-SkipGitHub` bzw. `-SkipGit-Mirror` lassen ein Ziel aus). Die GitHub-Container-Registry
(`ghcr.io`) ist nicht eingerichtet, da dafür der Token-Scope `write:packages` fehlt.

---

## Konfiguration

### Umgebungsvariablen

| Variable | Zweck | Standard |
|----------|-------|----------|
| `PORT` | HTTP-Port des Servers | `3000` |
| `DATA_DIR` | Ablage aller Daten (siehe unten) | `server/../data` (Stack: `/data`) |
| `AGENT_SERVICE` | DNS-Name/Alias des Node-Agenten (Dashboard) | `swarmdash-agent` |
| `AGENT_PORT` | Port des Node-Agenten | `9787` |
| `HOST_ROOT` | Read-only Host-Mount im Agent-Container | `/host` |
| `NODE_ID` · `NODE_HOSTNAME` | Node-Identität des Agents (per Swarm-Template gesetzt) | – · Hostname |
| `DOCKER_HOST` | `tcp://host:2375\|2376`, `unix://…`, `npipe://…` | lokaler Socket/Pipe |
| `DOCKER_TLS_VERIFY` · `DOCKER_CERT_PATH` | TLS (Port 2376); Ordner mit `ca.pem`, `cert.pem`, `key.pem` | – |
| `DOCKER_SOCK` | Socket-Pfad (Agent, Trivy-Helfer) | `/var/run/docker.sock` |
| `HELPER_IMAGE` | Image für Hilfs-Container (Volume-Kopie/-Größe/-Export) | `swarm-dashboard:latest` |
| `TRIVY_IMAGE` · `TRIVY_CACHE_VOLUME` | Scanner-Image und Cache-Volume | `aquasec/trivy:latest` · `trivy-cache` |
| `SELF_SERVICE` | Service-Name für das Self-Update | `swarmdash_dashboard` |
| `DASHBOARD_CREATOR` | Anzeige „Ersteller" in Über & Version | Autor aus `package.json` |

**Variablen der Stack-Datei** (von `docker stack deploy` ersetzt): `SWARMDASH_IMAGE` (Image für Dashboard
und Agent, Standard `swarm-dashboard:latest`) und `SWARMDASH_PORT` (Standard `3000`).

### Service-Labels

`swarmdash.proxy`, `.proxy.host`, `.proxy.port`, `.proxy.entrypoints`, `.proxy.mtls`, `.proxy.tailnet` ·
`swarmdash.backup`, `.backup.volumes` · `swarmdash.monitor` · `swarmdash.tag`.

### Datenverzeichnis (`DATA_DIR`)

`settings.json` (Einstellungen, Backup-Jobs, Registries, Verläufe) · `auth.json` (Benutzer, Hashes, Token-Secret) ·
`stacks.json` · `endpoints.json` · `audit.json` · `secret-vault.json` · `metrics.db` · `bestpractices.db` · `pki/`
(CA, Zertifikate, Schlüssel). Das Verzeichnis enthält **Geheimnisse** — als Volume persistieren, schützen und sichern.

---

## API

Alle Pfade unter `/api`; bei aktivierter Anmeldung mit `Authorization: Bearer <token>`.

| Bereich | Endpunkte |
|---------|-----------|
| Cluster | `GET /info` · `GET /tasks?service=` |
| Nodes | `GET /nodes` · `GET /nodes/:id` · `GET /nodes/metrics` · `GET /nodes/history` · `POST /nodes/:id/availability` · `POST /nodes/:id/role` · `DELETE /nodes/:id` |
| Services | `GET /services` · `GET /services/topology` · `GET /services/:id` · `POST …/:id/scale` · `…/update` · `…/rollback` · `…/migrate` · `…/edit` · `…/labels` · `GET …/:id/config` · `…/runtime` · `…/placement` · `…/export` · `POST /services/check-updates` · `DELETE …/:id` |
| Stacks | `GET /stacks` · `GET …/:name/compose` · `…/detail` · `POST /stacks/deploy` · `POST …/:name/diff` · `DELETE …/:name` · `GET/PUT /stacks/saved` · `DELETE …/saved/:name` · `GET …/saved/:name/export` |
| Container | `GET /containers` · `…/config` · `…/top` · `…/fs/list` · `…/fs/read` · `…/image-history` · `POST …/action` · `…/recreate` · `…/fs/op` |
| Images | `GET /images` · `…/usage` · `…/export` · `POST …/action` · `…/import` · `…/import-multi` · `…/prune` · `…/pull` |
| Netzwerke | `GET /networks` · `GET …/nodes` · `GET …/:id/usage` · `GET …/:id/spec` · `POST /networks` · `PUT …/:id` · `DELETE …/:id` |
| Volumes | `GET /volumes` · `…/usage` · `…/export` · `…/fs/list` · `…/fs/read` · `POST …/create` · `…/action` · `…/bulk-action` · `…/duplicate` · `…/rename` · `…/import` · `…/fs/op` |
| Bind-Mounts | `GET /binds` · `POST /migrate/preflight` · `POST /migrate` |
| Secrets / Configs | `GET/POST /secrets` · `DELETE …/:id` · `GET/POST /configs` · `GET …/:id` · `…/:id/export` · `DELETE …/:id` |
| Einstellungen | `GET/PUT /settings` |
| Backup | `GET /backup/services` · `POST /backup/run` · `GET /backup/history` · `GET /backup/archives` · `POST /backup/restore` · `POST /backup/test-target` |
| Reverse Proxy | `GET /proxy/status` · `…/services` · `…/compose` · `…/nginx-config` · `POST …/deploy` · `…/apply/:id` · `…/mtls/:id` · `…/tailnet/:id` · `…/reconcile-pki` · `DELETE …/apply/:id` · `…/stack` |
| Tailscale | `GET /tailscale/status` · `…/compose` · `POST …/deploy` · `DELETE …/stack` |
| PKI | `GET/POST/DELETE /pki/ca` · `GET/POST /pki/certs` · `GET …/certs/:id[/download]` · `POST …/certs/:id/p12` · `…/revoke` · `DELETE …/certs/:id` · `GET /pki/crl[/status]` |
| Security | `GET /security` · `POST /security/scan` (SSE) · `GET …/result` · `POST …/clear` · `GET/POST /security/best-practices[/run\|/schedule\|/history]` |
| Builder | `GET /builder` · `POST …/build` · `…/dockerfiles` · `…/prune-cache` · `DELETE …/dockerfiles/:id` |
| Endpoints | `GET/POST /endpoints` · `PUT/DELETE …/:id` · `POST …/test` · `GET …/inventory` · `GET …/:id/{containers,images,volumes,networks,capabilities}` |
| Secret-Tresor | `GET /secret-vault/status` · `POST …/init` · `…/unlock` · `…/entry` · `…/passphrase` · `…/import` · `…/recreate` · `GET …/export` · `DELETE …/entry/:name` |
| Git / GitOps / Registries | `GET/POST /git` · `POST …/:id/fetch` · `GET/POST /git/ops` · `PUT …/ops/:id` · `POST …/ops/:id/sync` · `GET/POST /registries` · `POST …/:id/test` |
| System | `GET /system/version` · `POST …/check-update` · `…/update` |
| Monitoring | `GET /monitoring/status` · `POST …/test` |
| Auth | `GET /auth/status` · `POST …/login` · `GET/POST …/users` · `POST …/enable` · `…/password` |
| Audit | `GET /audit` · `DELETE /audit` |
| WebSocket | `WS /ws/logs?service=ID&tail=N` · `WS /ws/exec?service=ID&shell=/bin/sh` · `WS /ws/events` |
| Node-Agent (Port 9787, intern) | `GET /health` · `/metrics` · `/host-audit` · `/containers` · `/images` · `/volumes` · `/volume-usage` · `/volume-size` · `/container-stats` · `POST /net-op` · `POST /volume-action` · `POST /trivy-scan` · Export/Exec u. a. |

---

## Sicherheitshinweis

Dieses Werkzeug gewährt vollen Zugriff auf den Docker-Socket des Managers und — über die Agents — auf den
Socket jedes Nodes (= **Root-Äquivalent** auf den Hosts). **Nach dem Deployment ist keine Authentifizierung aktiv**:
sie ist optional und muss nach dem ersten Start konfiguriert werden (*Einstellungen → Authentifizierung*).
Bis dahin kann jeder, der den Port erreicht, den Cluster verwalten.

Für alle veröffentlichten Services — **einschließlich des Swarm Dashboards selbst** — wird ein Reverse Proxy mit
Authentifizierung (z. B. Traefik + Basic-Auth, OAuth oder mTLS) **dringend empfohlen**.

- Betreiben Sie das Dashboard nur in einem vertrauenswürdigen, nicht öffentlich erreichbaren Netz oder hinter
  einem Reverse Proxy mit Authentifizierung.
- Aktivieren Sie die **Authentifizierung** und verwenden Sie `operator`/`viewer` für alltägliche Zugriffe.
- Das Datenverzeichnis enthält Benutzer-Hashes, CA-Schlüssel und den verschlüsselten Secret-Tresor — nicht teilen.
- Wer nur Metriken möchte, kann den Docker-Socket-Mount des Agents im Stack entfernen (dann entfallen Konsole,
  Export und node-lokale Funktionen).

---

## Lizenz

MIT — siehe [LICENSE](LICENSE).
