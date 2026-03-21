#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = dirname(__dirname);
const SKILL_NAME = 'groundtruth';

// Directories to copy into the skill install location
const COPY_DIRS = ['agents', 'commands', 'tracking', 'output'];
const COPY_FILES = ['SKILL.md', 'README.md', 'LICENSE'];

// Claude Code skills directory — standard location
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const INSTALL_DIR = join(CLAUDE_SKILLS_DIR, SKILL_NAME);

function log(msg) {
  process.stdout.write(msg + '\n');
}

function err(msg) {
  process.stderr.write('✗ ' + msg + '\n');
}

function main() {
  log('');
  log('Groundtruth — installing Claude Code skill');
  log('─'.repeat(48));

  // Check Node version
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    err(`Node.js 18+ required (found ${process.versions.node})`);
    process.exit(1);
  }

  // Warn if already installed
  if (existsSync(INSTALL_DIR)) {
    log(`⚠  Existing install found at: ${INSTALL_DIR}`);
    log('   Updating in place...');
  }

  // Create install directory
  try {
    mkdirSync(INSTALL_DIR, { recursive: true });
    mkdirSync(join(INSTALL_DIR, 'sources'), { recursive: true });
  } catch (e) {
    err(`Failed to create install directory: ${e.message}`);
    process.exit(1);
  }

  // Copy directories
  for (const dir of COPY_DIRS) {
    const src = join(SKILL_ROOT, dir);
    const dest = join(INSTALL_DIR, dir);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, dest, { recursive: true });
    } catch (e) {
      err(`Failed to copy ${dir}/: ${e.message}`);
      process.exit(1);
    }
  }

  // Copy top-level files
  for (const file of COPY_FILES) {
    const src = join(SKILL_ROOT, file);
    const dest = join(INSTALL_DIR, file);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, dest);
    } catch (e) {
      err(`Failed to copy ${file}: ${e.message}`);
      process.exit(1);
    }
  }

  // Write .gitignore for sources/ inside install dir
  const gitignore = 'sources/*/\n!sources/.gitkeep\n';
  const gitignorePath = join(INSTALL_DIR, '.gitignore');
  try {
    import('fs').then(({ writeFileSync }) => {
      writeFileSync(gitignorePath, gitignore);
    });
  } catch (_) {
    // non-fatal
  }

  // Read version from package.json
  let version = '?';
  try {
    const pkg = JSON.parse(readFileSync(join(SKILL_ROOT, 'package.json'), 'utf8'));
    version = pkg.version;
  } catch (_) {}

  log('');
  log(`✓ Groundtruth v${version} installed`);
  log(`  Location: ${INSTALL_DIR}`);
  log('');
  log('Next steps:');
  log('  1. Open Claude Code in any project');
  log('  2. Run: /analyze https://github.com/org/repo');
  log('  3. Or run: /analyze /path/to/urls.txt');
  log('');
  log('To update later:');
  log('  npx @sathvikc/groundtruth');
  log('');
}

main();
