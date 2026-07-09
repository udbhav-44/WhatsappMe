#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const projectDir = path.join(__dirname, '..');
const nodePath = process.execPath;
const serverPath = path.join(projectDir, 'src', 'server.js');

const platform = os.platform();

if (platform === 'darwin') {
  setupMac();
} else if (platform === 'win32') {
  setupWindows();
} else {
  setupLinux();
}

function setupMac() {
  const logsDir = path.join(projectDir, 'logs');

  // Create logs directory if it doesn't exist
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.whatsappscheduler.plist');
  const plistDir = path.dirname(plistPath);

  // Create LaunchAgents directory if it doesn't exist
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatsappscheduler</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logsDir}/app.log</string>
    <key>StandardErrorPath</key>
    <string>${logsDir}/app-error.log</string>
</dict>
</plist>`;

  // Write the plist file
  fs.writeFileSync(plistPath, plistContent);

  // Try to load the LaunchAgent
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
  } catch (error) {
    // launchctl load may fail if already loaded, so warn but don't fail
    console.warn('⚠️  Warning: launchctl load failed (may already be loaded)');
  }

  console.log('✅ Autostart configured!');
  console.log('The WhatsApp Scheduler will now start automatically when you log in.');
  console.log(`LaunchAgent written to: ~/Library/LaunchAgents/com.whatsappscheduler.plist`);
  console.log('');
  console.log('To open the app: http://localhost:3000');
  console.log('To stop the app: launchctl unload ~/Library/LaunchAgents/com.whatsappscheduler.plist');
}

function setupWindows() {
  const nodePath = process.execPath.replace(/\\/g, '\\\\');
  const serverPathWin = serverPath.replace(/\\/g, '\\\\');

  const command = `schtasks /create /tn "WhatsAppScheduler" /tr "\\"${nodePath}\\" \\"${serverPath}\\"" /sc ONLOGON /ru "%USERNAME%" /f`;

  try {
    execSync(command, { stdio: 'pipe' });
  } catch (error) {
    console.error('❌ Error creating Task Scheduler entry:', error.message);
    process.exit(1);
  }

  console.log('✅ Autostart configured!');
  console.log('Task Scheduler entry created. The app will start on next login.');
  console.log('');
  console.log('To open the app: http://localhost:3000');
  console.log('To remove autostart: Run "schtasks /delete /tn "WhatsAppScheduler" /f" in Command Prompt');
}

function setupLinux() {
  console.log('ℹ️  Linux detected.');
  console.log('Please set up autostart manually: add `node ' + serverPath + '` to your startup scripts.');
  console.log('');
  console.log('Common options:');
  console.log('- Add to ~/.bashrc or ~/.zshrc (if running on login)');
  console.log('- Use systemd service file');
  console.log('- Use your desktop environment autostart folder');
}
