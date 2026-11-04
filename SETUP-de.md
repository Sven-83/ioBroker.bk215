# Inbetriebnahme

1. Adapter von GitHub installieren: `iobroker url https://github.com/Sven-83/sunlit`
2. Instanz anlegen und öffnen: **E-Mail und Passwort der Sunlit-/SunEnergyXT-App** eintragen (das Passwort wird verschlüsselt gespeichert).
3. Speichern. Nach etwa einer Minute stehen unter `bk215.0.live.*` Akku, Solar, Wechselrichter und Hausverbrauch, nach einigen Minuten die Statistik unter `bk215.0.stats.*`.
4. Prüfen: `bk215.0.info.connection` = true, `info.lastError` leer. Kommen Werte als leer/null, unter `bk215.0.raw.*` nachsehen, was die Cloud liefert.

Der Adapter liest nur. Er ändert nichts am Speicher; Lade- und Entladeregeln bleiben in der App.
