import fs from "node:fs";
import path from "node:path";
import { launcherPath } from "./paths.ts";

/**
 * Everything that differs between macOS and Linux lives here. Nothing else
 * in the harness checks the operating system.
 */
export type Platform = "darwin" | "linux";

/** Case-insensitive file systems (macOS default): compare paths folded. */
export const caseFold = (s: string): string => (process.platform === "darwin" ? s.toLowerCase() : s);

export function detect(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new Error(`unsupported platform ${process.platform}`);
}

export interface ServiceFiles {
  /** Where each generated file belongs, and its text. */
  files: Array<{ path: string; text: string }>;
  /** Commands an admin runs afterwards. */
  commands: string[];
  notes: string[];
}

export interface InstallOpts {
  user: string;
  node: string;
  codeDir: string;
}

const homeOf = (p: Platform, user: string) => (p === "darwin" ? `/Users/${user}` : `/home/${user}`);

/** A systemd word: double-quoted, with the characters systemd itself interprets escaped (\ " % $). */
export const sdEsc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
export const sdq = (s: string): string => `"${sdEsc(s)}"`;

/** Text inside an XML element. */
export const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function systemdUnit(o: InstallOpts): string {
  const bin = launcherPath(o.codeDir);
  return `[Unit]
Description=OptChat for %i
After=network-online.target
Wants=network-online.target

[Service]
User=%i
WorkingDirectory=/home/%i
Environment=OPTCHAT_HOME=/home/%i/optchat
Environment=HOME=/home/%i
Environment="PATH=${sdEsc(path.dirname(o.node))}:/home/%i/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=${sdq(o.node)} ${sdq(bin)} serve
# Exit 0 means "another instance holds the lock": do not restart in a loop.
Restart=on-failure
RestartPreventExitStatus=0
RestartSec=5
# Kill the whole control group, so no orphaned \`claude\` child survives.
KillMode=control-group
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectProc=invisible
# Each service sees only its own home, so one user's agent cannot read another's files.
ProtectHome=tmpfs
BindPaths=/home/%i
# "-": a path that does not exist yet must not stop the service from starting.
ReadWritePaths=-/home/%i/optchat -/home/%i/work -/home/%i/.claude -/home/%i/.claude.json -/home/%i/.cache
# Status and errors only; never message text (the chat log is the record).
SyslogIdentifier=optchat-%i

[Install]
WantedBy=multi-user.target
`;
}

export function systemdBackup(o: InstallOpts): { service: string; timer: string } {
  const bin = launcherPath(o.codeDir);
  return {
    service: `[Unit]
Description=OptChat backup for %i

[Service]
Type=oneshot
User=%i
Environment=OPTCHAT_HOME=/home/%i/optchat
Environment=HOME=/home/%i
Environment="PATH=${sdEsc(path.dirname(o.node))}:/usr/local/bin:/usr/bin:/bin"
ExecStart=${sdq(o.node)} ${sdq(bin)} backup
`,
    timer: `[Unit]
Description=Daily OptChat backup for %i

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function plistArgs(args: string[]): string {
  return `<array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>`;
}

export function launchdPlist(o: InstallOpts): string {
  const home = homeOf("darwin", o.user);
  const bin = launcherPath(o.codeDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>optchat.${xml(o.user)}</string>
  <key>UserName</key><string>${xml(o.user)}</string>
  <key>ProgramArguments</key>
  ${plistArgs([o.node, bin, "serve"])}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path.dirname(o.node))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${xml(home)}</string>
    <key>USER</key><string>${xml(o.user)}</string>
    <key>OPTCHAT_HOME</key><string>${xml(home)}/optchat</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Exit 0 (lock held) must not restart in a loop. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><false/>
  <key>StandardErrorPath</key><string>${xml(home)}/optchat/run/service.log</string>
  <key>StandardOutPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

export function launchdBackupPlist(o: InstallOpts): string {
  const home = homeOf("darwin", o.user);
  const bin = launcherPath(o.codeDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>optchat.backup.${xml(o.user)}</string>
  <key>UserName</key><string>${xml(o.user)}</string>
  <key>ProgramArguments</key>
  ${plistArgs([o.node, bin, "backup"])}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path.dirname(o.node))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${xml(home)}</string>
    <key>OPTCHAT_HOME</key><string>${xml(home)}/optchat</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
`;
}

/** Under `ProtectHome=tmpfs` the service sees /usr, /opt and its OWN home only: node and the code must live there. */
export function visibilityWarnings(o: InstallOpts, p: Platform): string[] {
  if (p !== "linux") return [];
  const own = homeOf(p, o.user);
  const visible = (f: string) => !f.startsWith("/home/") || f === own || f.startsWith(own + "/");
  return [o.node, o.codeDir]
    .filter((f) => !visible(f))
    .map((f) => `WARNING: ${f} is under another user's home, which the service cannot see (ProtectHome=tmpfs). Install node and the code under /usr, /opt or /home/${o.user}, or the service will not start.`);
}

export function installPlan(p: Platform, o: InstallOpts): ServiceFiles {
  const home = homeOf(p, o.user);
  const warnings = visibilityWarnings(o, p);
  if (p === "linux") {
    const b = systemdBackup(o);
    return {
      files: [
        { path: "/etc/systemd/system/optchat@.service", text: systemdUnit(o) },
        { path: "/etc/systemd/system/optchat-backup@.service", text: b.service },
        { path: "/etc/systemd/system/optchat-backup@.timer", text: b.timer },
      ],
      commands: [
        `chmod 700 ${home}`,
        `install -d -m 700 -o ${o.user} ${home}/optchat ${home}/optchat/secrets ${home}/work ${home}/.claude`,
        "systemctl daemon-reload",
        `systemctl enable --now optchat@${o.user}.service`,
        `systemctl enable --now optchat-backup@${o.user}.timer`,
      ],
      notes: [
        ...warnings,
        "The unit file is shared by all users: installing for another user replaces it with THIS node and code path.",
        "Do not add this user to the sudo group.",
        `Keep ${home}/optchat out of host-level backups. If /home is on btrfs/ZFS with automatic snapshots, put ~/optchat on its own subvolume with snapshots OFF: a snapshot keeps a secret after redaction.`,
        "Disk encryption: after an unplanned reboot nothing runs until LUKS is unlocked. Use TPM2 auto-unlock (systemd-cryptenroll) or SSH unlock (dropbear-initramfs).",
        "Mask sleep: systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
      ],
    };
  }
  const b = launchdBackupPlist(o);
  return {
    files: [
      { path: `/Library/LaunchDaemons/optchat.${o.user}.plist`, text: launchdPlist(o) },
      { path: `/Library/LaunchDaemons/optchat.backup.${o.user}.plist`, text: b },
    ],
    commands: [
      `chmod 700 ${home}`,
      `install -d -m 700 -o ${o.user} ${home}/optchat ${home}/optchat/secrets ${home}/optchat/run ${home}/work`,
      `tmutil addexclusion -p ${home}/optchat`,
      `launchctl bootstrap system /Library/LaunchDaemons/optchat.${o.user}.plist`,
      `launchctl bootstrap system /Library/LaunchDaemons/optchat.backup.${o.user}.plist`,
    ],
    notes: [
      "Time Machine cannot delete one path from its backups, so ~/optchat is excluded (restic is the off-host copy).",
      "FileVault: after an unplanned restart nothing runs until an admin unlocks the disk. Use `sudo fdesetup authrestart` for planned restarts.",
      "Computer use needs a separate LaunchAgent in the GUI session (a LaunchDaemon cannot reach the screen); see PLAN.md, Phase 9.",
      "Rotate service.log with newsyslog.",
    ],
  };
}

/**
 * Root only, all or nothing: every file is first written under a temporary name; the live files are then
 * replaced one by one, and if any step fails the ones already replaced are put back.
 */
export function writeFilesIfRoot(files: ServiceFiles["files"], isRoot = process.getuid?.() === 0): string[] {
  if (!isRoot) throw new Error("--write needs root (run it with sudo); nothing was written");
  const tmps: string[] = [];
  const cleanup = () => tmps.forEach((t) => fs.rmSync(t, { force: true }));
  try {
    for (const f of files) {
      const tmp = `${f.path}.optchat-tmp`;
      const fd = fs.openSync(tmp, "w", 0o644);
      tmps.push(tmp);
      try {
        fs.writeSync(fd, f.text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  const replaced: Array<{ path: string; backup?: string }> = [];
  try {
    for (let k = 0; k < files.length; k++) {
      const target = files[k].path;
      let backup: string | undefined;
      if (fs.existsSync(target)) {
        backup = `${target}.optchat-bak`;
        fs.copyFileSync(target, backup);
      }
      fs.renameSync(tmps[k], target);
      replaced.push({ path: target, backup });
    }
  } catch (e) {
    for (const r of replaced.reverse()) {
      if (r.backup) fs.renameSync(r.backup, r.path);
      else fs.rmSync(r.path, { force: true });
    }
    cleanup();
    throw e;
  }
  for (const r of replaced) if (r.backup) fs.rmSync(r.backup, { force: true });
  return files.map((f) => f.path);
}
