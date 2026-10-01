#!/usr/bin/env node
// PreToolUse guard for Bash.
//
// Groundtruth clones and reads repositories it does not control, so an injected instruction plus a
// shell is the worst available combination. This blocks the shapes that matter: fetching and
// executing remote code, exfiltration of the user's own credentials, writes outside the state
// directory, and mutation of the clones the pipeline treats as read-only.
//
// Bash permission rules are not a security boundary in their own right — the docs note they match
// command *text*, so the same program invoked differently escapes them. That is precisely why this
// exists alongside them rather than instead of them.

import { join, resolve, sep } from 'node:path';
import { allow, cloneRoot, deny, logEvent, readStdin, stateRoot } from './hook-lib.mjs';

const { tool_input: input = {} } = await readStdin();
const command = String(input.command || '');
if (!command) allow();

const inPath = (root, p) => p === root || p.startsWith(root + sep);
const home = process.env.HOME || '';

// Secrets this pipeline has no reason to read. The threat is exfiltration of the *user's* files —
// which is worse than a repo producing a wrong verdict, and was entirely absent from the original
// threat model.
const SECRET_PATTERNS = [
  // Match the secret itself, wherever it appears: a tilde, a $HOME, or an absolute path, with any
  // flag or quoting in between. Anchoring on the leading command let `cat ~/.ssh/id_rsa` through.
  // The secret path itself, so it is caught wherever the command mentions it — including archive
  // tools that name a whole directory rather than a single key file.
  { re: /(?:^|[\s"'`(=|;|&])(?:~\/|\$HOME\/|\/home\/[^/]+\/|\/Users\/[^/]+\/)?(?:\.ssh\b|\.aws\/credentials|\.gnupg\b|\.npmrc|\.netrc|\.git-credentials|\.claude\.json|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config)(?:\b|\/|$)/, why: 'accessing a credential store' },
  { re: /(?:^|[\s"'`(=|;&])[^\n]*\.env(?:\.[a-z]+)?(?:\b|["'`\s])/i, why: 'reading a dotenv file' },
  { re: /\b(?:curl|wget|nc|ncat|telnet)\b[^\n]*(?:\/dev\/tcp\/|\$\(|`)/i, why: 'network access with command substitution' },
  // Any interpreter, not just sh: `| python3` and `| node` fetch-and-run just as effectively.
  // A fetch piped into any executable, not a fixed list of shells. `| python3` fetches and runs just
  // as effectively as `| sh`, and enumerating interpreters loses to the next one that appears.
  { re: /(?:curl|wget|fetch)\b[^|\n]*\|\s*(?:sudo\s+)?(?:[a-z0-9_./-]*\s*)*[a-z0-9_./-]+\b/i, why: 'piping fetched content into another program' },
  { re: /\b(?:python3?|node|ruby|perl|php)\b[^\n]{0,40}\s-c\s+["'`]?\s*\$\(/, why: 'running shell substitution as a script argument' },
  { re: /\b(?:sh|bash|zsh|python3?|node|ruby|perl)\s+-c\s*["']?\s*\$\(/, why: 'running shell substitution as a script argument' },
  { re: /\b(?:eval|exec)\b\s*\(?\s*\$/, why: 'evaluating a shell variable' },
  { re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*)\s+(?:\/|~|\$HOME|\*|\.\.?(?:\s|$))/ , why: 'recursive deletion of a root, home, or parent path' },
  { re: /\b(?:mkfs|fdisk|parted|diskutil\s+(?:erase|partition))\b|\bof=\/dev\//, why: 'writing directly to a block device' },
  { re: /\bdd\b[^\n]*\bof=/, why: 'writing directly to a device or file with dd' },
  { re: /\bhistory\s+-c\b|\b(?:unset|unsetenv)\s+HISTFILE\b/, why: 'clearing shell history' },
];

for (const { re, why } of SECRET_PATTERNS) {
  if (re.test(command)) {
    logEvent('bash-denied', { command: command.slice(0, 200), why });
    deny(`Blocked: ${why}. Groundtruth clones and inspects repositories it does not control, so a ` +
      'prompt-injected agent must not be able to fetch and run remote code, read the user\'s ' +
      'credentials, or erase their files. If this command is genuinely needed, run it yourself ' +
      'outside the agent.');
  }
}

// Writing outside the pipeline's own state, or into a clone, breaks the read-only invariant the
// analysis depends on.
const clone = cloneRoot();
const GROUNDTRUTH_PATH = /(?:\.cache\/groundtruth|groundtruth[\w.-]*(?:\/|$))/;

// Detect a clone path from the command text itself, not only from the configured root. The clone
// directory is configurable and a previous version may have written elsewhere; matching the literal
// configured path missed every `git -C ~/.cache/groundtruth/... pull` and let it through.
const touchesClone = GROUNDTRUTH_PATH.test(command) ||
  /(?:-C|--git-dir|--work-tree)[\s"'=]+[^\s"']*groundtruth/i.test(command);

const MUTATING = /\b(?:rm|mv|cp|chmod|chown|ln|mkdir|tee|dd|install|touch|truncate|shred)\b|[^\n]*\d>>?\s*\S/;
if (touchesClone && MUTATING.test(command)) {
  logEvent('bash-denied-clone-write', { command: command.slice(0, 200) });
  deny('Blocked: clones are read-only for the analysis. Two agents reading a tree that one of them ' +
    'is mutating will read different bytes of the same file and produce contradictory profiles, and ' +
    'the profile would claim a commit that was never analysed. Re-clone with scripts/clone.mjs.');
}

// Writes into system or user configuration paths, whichever shell form is used. The previous
// pattern required a leading space before the path, so `echo x >/etc/passwd` slipped through.
const SYSTEM_WRITE = /(?:^|[\s"'`>|;&(])(?:~\/|\$HOME\/|\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/opt\/|\/private\/etc|\/var\/)(?:[^\s"'`|;&]*)/;
const WRITE_VERB = /\b(?:rm|mv|cp|chmod|chown|ln|mkdir|tee|dd|install|touch|chmod)\b|(?:^|[\s])[>]\s*\S|(?:^|[\s])>>?\s*\S/;
if (SYSTEM_WRITE.test(command) && WRITE_VERB.test(command)) {
  logEvent('bash-denied-system-write', { command: command.slice(0, 200) });
  deny('Blocked: this writes to a system or user configuration path. Groundtruth clones and reads ' +
    'repositories; it has no reason to modify the user\'s machine, and an agent processing ' +
    'untrusted repositories is exactly who should not be able to.');
}

// Git operations against a clone. `git pull` there runs with the user's real Git identity on an
// untrusted remote, and `push`/`set-url` would point a clone at an attacker's server.
if (/\bgit\b[^\n]*\b(?:pull|push|fetch|clone|submodule\s+update|remote\s+(?:add|set-url|remove))\b/.test(command)) {
  if (touchesClone || /\bpush\b|\bset-url\b/.test(command)) {
    logEvent('bash-denied-git', { command: command.slice(0, 200) });
    deny('Blocked: use scripts/clone.mjs and scripts/drift.mjs for git operations. They clone shallow ' +
      'and read the remote with ls-remote, which needs no credentials — a `git pull` on an untrusted ' +
      'checkout runs with the user\'s real Git identity, and `git push` or `set-url` would redirect a ' +
      'clone to an attacker\'s server.');
  }
}

// Credentials in the environment, in case a future agent improvises a curl.
if (/\b(?:ANTHROPIC|OPENAI|GITHUB|GH|AWS|NPM)_[A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD)\b/.test(command)) {
  logEvent('bash-denied-env-secret', { command: command.slice(0, 200) });
  deny('Blocked: this references an API token from the environment. Groundtruth must not transmit ' +
    'the user\'s credentials anywhere, including as part of a verification fetch.');
}

allow();