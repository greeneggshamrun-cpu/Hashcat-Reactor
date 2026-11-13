'use strict';

/**
 * Shared cloud-init / run-script generator used by every cloud provisioner
 * (DigitalOcean, AWS, ...). It brings up a CUDA-capable GPU host, installs
 * hashcat, verifies a GPU backend is actually visible (aborting loudly if not,
 * so a misconfigured instance can't silently CPU-crack), and leaves the actual
 * hashcat invocation as a template the operator completes with their own hash
 * file and wordlist.
 *
 * It embeds no hashes and uploads results nowhere.
 */

function sanitizeComment(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
}

/**
 * @param {object} job   must carry { name, authorization: { basis } }
 * @param {object} opts
 * @param {number}  [opts.maxLifetimeMinutes=120]
 * @param {boolean} [opts.cudaReady=false]        image already has driver+CUDA
 * @param {boolean} [opts.hashcatFromSource=false] build hashcat vs apt
 * @param {string}  [opts.cudaVersion='12-6']
 * @param {string}  [opts.hashFileRemotePath='/root/target.hash']
 * @param {string}  [opts.hashcatArgs='']
 * @returns {string} a bash script
 */
function generateRunScript(job, opts = {}) {
  const life = Math.max(5, Number(opts.maxLifetimeMinutes) || 120);
  const hashFile = opts.hashFileRemotePath || '/root/target.hash';
  const extra = opts.hashcatArgs || '';
  const cudaReady = opts.cudaReady === true;
  const fromSource = opts.hashcatFromSource === true;
  const cudaVersion = opts.cudaVersion || '12-6';
  const spotAware = opts.spotAware === true;

  const lines = [
    '#!/bin/bash',
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'umask 077   # restrict perms on potfile / restore file / any artifacts',
    '# --- reactor-scheduler run script (review before use) ---',
    `# Job: ${sanitizeComment(job.name)}  | authorization basis: ${job.authorization.basis}`,
    '',
    '# Self-destruct safety net: power off and let the control plane reap it.',
    `shutdown -h +${life} "reactor-scheduler max lifetime reached" &`,
    '',
    'log() { echo "reactor-scheduler: $*"; }',
    'wait_apt() { while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do log "waiting for apt lock"; sleep 5; done; }',
    '',
    '# ---- CUDA / NVIDIA driver bootstrap -------------------------------------',
    'have_cuda() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; }',
  ];

  if (cudaReady) {
    lines.push(
      'log "cudaReady=true: expecting preinstalled driver+CUDA (e.g. a Deep Learning / AI-ML image)"'
    );
  } else {
    lines.push(
      'if have_cuda; then',
      '  log "NVIDIA driver already present; skipping CUDA install"',
      'else',
      '  log "installing NVIDIA driver + CUDA for ubuntu2204 (fresh image)"',
      '  wait_apt; apt-get update -y',
      '  apt-get install -y build-essential wget gnupg',
      '  tmp=$(mktemp -d)',
      '  wget -qO "$tmp/cuda-keyring.deb" https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb',
      '  dpkg -i "$tmp/cuda-keyring.deb"',
      '  wait_apt; apt-get update -y',
      '  # cuda-drivers = kernel driver + libcuda; cuda-toolkit brings nvrtc etc.',
      `  wait_apt; apt-get install -y cuda-drivers cuda-toolkit-${cudaVersion} || apt-get install -y cuda-drivers cuda-toolkit`,
      '  modprobe nvidia || true',
      'fi'
    );
  }

  lines.push('', '# ---- hashcat ------------------------------------------------------------');
  if (fromSource) {
    lines.push(
      'if ! command -v hashcat >/dev/null 2>&1; then',
      '  log "building hashcat from source"',
      '  wait_apt; apt-get install -y git build-essential',
      '  git clone --depth 1 https://github.com/hashcat/hashcat /opt/hashcat',
      '  make -C /opt/hashcat -j"$(nproc)" && make -C /opt/hashcat install',
      'fi'
    );
  } else {
    lines.push(
      'if ! command -v hashcat >/dev/null 2>&1; then',
      '  log "installing hashcat from apt"',
      '  wait_apt; apt-get install -y hashcat',
      'fi'
    );
  }

  lines.push(
    '',
    '# ---- GPU sanity check (abort rather than silently CPU-crack) ------------',
    '# A GPU instance must expose a GPU to hashcat. If the driver did not come up',
    '# (fresh images sometimes need a reboot), abort loudly to avoid paying GPU',
    '# rates for CPU-only work. Use a CUDA-ready image to skip the install race.',
    'if ! have_cuda; then',
    '  nvidia-smi || true',
    '  echo "reactor-scheduler: ERROR no usable GPU (nvidia-smi failed). Aborting to avoid CPU-only spend. If this is a fresh image, reboot once so the driver loads, or use a Deep Learning / AI-ML image." >&2',
    '  exit 1',
    'fi',
    'if ! hashcat -I 2>/dev/null | grep -qiE "Backend Device|CUDA|OpenCL"; then',
    '  echo "reactor-scheduler: ERROR hashcat sees no backend device. Aborting." >&2',
    '  exit 1',
    'fi',
    'log "GPU ready:"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true',
    ''
  );

  if (spotAware) {
    lines.push(
      '# ---- spot-interruption watcher -----------------------------------------',
      '# On a spot instance AWS gives a ~2 min interruption notice via IMDSv2.',
      '# hashcat checkpoints continuously (--restore), so a reclaim is resumable;',
      '# this just logs the notice and nudges hashcat to flush its restore file.',
      'spot_watch() {',
      '  while true; do',
      '    TOK=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)',
      '    CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/spot/instance-action 2>/dev/null || echo 000)',
      '    if [ "$CODE" = "200" ]; then log "SPOT INTERRUPTION notice received; hashcat --restore will resume on next launch"; pkill -INT hashcat || true; break; fi',
      '    sleep 5',
      '  done',
      '}',
      'spot_watch &',
      ''
    );
  }

  lines.push(
    '# ---- run the authorized job --------------------------------------------',
    '# Fill in your hash mode, wordlist/mask, and hash file path. Run with',
    '# --restore so an interrupted (or spot-reclaimed) run resumes instead of',
    '# starting over:',
    `#   target hash file expected at: ${hashFile}`,
    `# Example (dictionary): hashcat -m <mode> -a 0 --restore-file-path /root/reactor.restore ${hashFile} /root/wordlist.txt ${extra}`.trim(),
    '# Resume after an interruption:  hashcat --restore --restore-file-path /root/reactor.restore',
    '# Cracked results are written to the local potfile for YOU to retrieve:',
    '#   scp <user>@<instance-ip>:~/.local/share/hashcat/hashcat.potfile .',
    '# This script does NOT upload results anywhere.',
    '',
    'log "environment ready; run your authorized hashcat command above."'
  );
  return lines.join('\n');
}

module.exports = { generateRunScript, sanitizeComment };
