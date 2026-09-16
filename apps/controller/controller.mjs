import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const REMOTE_DIR_DEFAULT = '/home/ec2-user/option-scanner';
// Load the existing project .env before reading controller configuration.
// This preserves the working BPS launcher behavior when controller.mjs is
// started directly with: node apps/controller/controller.mjs
function loadLocalEnv() {
  const file = path.join(path.resolve(__dirname, '..', '..'), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    let value = match[2].trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
loadLocalEnv();

const PORT = Number(process.env.BPS_CONTROLLER_PORT || 8787);

function strategyMeta(strategy) {
  const key = String(strategy || 'BULL_PUT').toUpperCase();
  if (key === 'BEAR_CALL') {
    return {key: 'BEAR_CALL', file: 'bcs_results.csv', latest: 'latest_bcs_results.csv'};
  }
  return {key: 'BULL_PUT', file: 'bps_results.csv', latest: 'latest_bps_results.csv'};
}

let state = {
  running: false,
  status: 'idle',
  message: 'Ready',
  lines: [],
  startedAt: null,
  finishedAt: null,
  resultFile: null,
  error: null
};

function log(line) {
  const clean = String(line).replace(/\r/g, '');
  if (!clean) return;
  state.lines.push(clean);
  if (state.lines.length > 500) state.lines.shift();
  console.log(clean);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {windowsHide: true, ...opts});
    let out = '';
    let err = '';

    p.stdout?.on('data', d => {
      out += d.toString();
      d.toString().split(/\r?\n/).forEach(log);
    });

    p.stderr?.on('data', d => {
      err += d.toString();
      d.toString().split(/\r?\n/).forEach(x => log('[stderr] ' + x));
    });

    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve({out, err});
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => s += d);
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function formatExpiry(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value.trim();

  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, year, month, day] = match;
  return `${day}-${months[Number(month) - 1] || month}-${year}`;
}

function archiveStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function archiveExpiry(expiry) {
  return String(expiry || 'NoExpiry').replace(/[^A-Za-z0-9-]/g, '-');
}

function awsCliPath() {
  const candidates = [];

  if (process.env.AWS_CLI_PATH) candidates.push(process.env.AWS_CLI_PATH);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Amazon', 'AWSCLIV2', 'aws.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Amazon', 'AWSCLIV2', 'aws.exe'));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return 'aws';
}

async function ensureEc2Ready(cfg) {
  const instanceId = process.env.BPS_EC2_INSTANCE_ID || cfg.instanceId || 'i-05a5ee6857acfb59f';

  const aws = awsCliPath();

  state.status = 'ec2';
  state.message = 'Checking EC2 instance';
  log(`EC2 instance: ${instanceId}`);
  log(`AWS CLI: ${aws}`);

  let result;
  try {
    result = await run(aws, [
      'ec2', 'describe-instances',
      '--instance-ids', instanceId,
      '--query', 'Reservations[0].Instances[0].State.Name',
      '--output', 'text'
    ]);
  } catch (error) {
    throw new Error(`Unable to query EC2 via AWS CLI. Make sure AWS credentials are configured. ${error.message}`);
  }

  let status = String(result.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'unknown';
  log(`EC2 status: ${status}`);

  if (status === 'stopped') {
    state.message = 'Starting EC2 instance';
    log('EC2 is stopped — starting instance...');
    await run(aws, ['ec2', 'start-instances', '--instance-ids', instanceId]);
    log('✓ EC2 start requested');
  } else if (status === 'pending') {
    log('EC2 is already starting — waiting...');
  } else if (status === 'running') {
    log('✓ EC2 is already running — continuing without restart');
  } else if (status === 'stopping') {
    throw new Error('EC2 is stopping. Please wait for it to stop and run the scan again.');
  } else if (status === 'shutting-down') {
    throw new Error('EC2 is shutting down. Please wait and run the scan again.');
  } else if (status === 'terminated') {
    throw new Error('EC2 instance is terminated and cannot be started.');
  } else {
    throw new Error(`EC2 is not ready. Current state: ${status}`);
  }

  if (status !== 'running') {
    state.message = 'Waiting for EC2 to become running';
    log('Waiting for EC2 to reach running state...');
    await run(aws, ['ec2', 'wait', 'instance-running', '--instance-ids', instanceId]);
    log('✓ EC2 instance is running');
  }

  const ipResult = await run(aws, [
    'ec2', 'describe-instances',
    '--instance-ids', instanceId,
    '--query', 'Reservations[0].Instances[0].PublicIpAddress',
    '--output', 'text'
  ]);

  const currentHost = String(ipResult.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

  if (!currentHost || currentHost === 'None' || currentHost === 'null') {
    throw new Error('EC2 is running but has no public IP address.');
  }

  log(`EC2 public IP: ${currentHost}`);
  return currentHost;
}

async function waitForSsh(host, user, key) {
  state.status = 'connecting';
  state.message = 'Waiting for SSH';
  log(`Waiting for SSH on ${host}:22...`);

  const attempts = 18;
  let lastError = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      await run('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'ConnectionAttempts=1',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-i', key,
        `${user}@${host}`,
        'echo BPS_SSH_OK'
      ]);

      log('✓ SSH connection');
      return;
    } catch (error) {
      lastError = error;

      if (i < attempts) {
        log(`SSH not ready (${i}/${attempts}) — retrying in 5s...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  throw new Error(
    `EC2 is running but SSH is not reachable after ${attempts * 5} seconds. ${lastError?.message || ''}`
  );
}

async function updateRemoteSessionToken(host, user, key, remoteDir, token) {
  const tokenFile = path.join(PUBLIC, '.bps_session_token.tmp');
  const remoteToken = '/tmp/bps_session_token';

  fs.writeFileSync(tokenFile, token.trim(), 'utf8');

  try {
    log('Uploading fresh Breeze session token to EC2...');

    await run('scp', [
      '-q',
      '-o', 'ConnectTimeout=12',
      '-i', key,
      tokenFile,
      `${user}@${host}:${remoteToken}`
    ]);

    const updateEnvCmd =
      `cd ${remoteDir} && ` +
      `source .venv/bin/activate && ` +
      `python -c "from pathlib import Path; ` +
      `p=Path('.env'); ` +
      `t=Path('${remoteToken}').read_text(encoding='utf-8').strip(); ` +
      `lines=p.read_text(encoding='utf-8').splitlines() if p.exists() else []; ` +
      `lines=[x for x in lines if not x.startswith('BREEZE_SESSION_TOKEN=')]; ` +
      `lines.append('BREEZE_SESSION_TOKEN='+t); ` +
      `p.write_text('\\\\n'.join(lines)+'\\\\n',encoding='utf-8')" && ` +
      `rm -f ${remoteToken} && ` +
      `grep -q '^BREEZE_SESSION_TOKEN=' .env`;

    await run('ssh', [
      '-o', 'ConnectTimeout=12',
      '-i', key,
      `${user}@${host}`,
      updateEnvCmd
    ]);

    log('✓ Session token updated in EC2 .env');
  } finally {
    try { fs.unlinkSync(tokenFile); } catch {}
  }
}

async function stopEc2(instanceId) {
  const aws = awsCliPath();

  state.status = 'ec2';
  state.message = 'Stopping EC2 instance after successful scan';
  log(`Stopping EC2 instance ${instanceId} after CSV was copied to Windows...`);

  await run(aws, [
    'ec2', 'stop-instances',
    '--instance-ids', instanceId
  ]);

  log('✓ EC2 stop requested');

  await run(aws, [
    'ec2', 'wait', 'instance-stopped',
    '--instance-ids', instanceId
  ]);

  log('✓ EC2 instance is stopped after successful scan');
}

async function doScan(cfg) {
  const meta = strategyMeta(cfg.strategy);

  const user = cfg.user || process.env.BPS_EC2_USER || 'ec2-user';
  const key = cfg.keyPath || process.env.BPS_EC2_KEY_PATH;
  const remoteDir = cfg.remoteDir || process.env.BPS_EC2_REMOTE_DIR || REMOTE_DIR_DEFAULT;

  if (!key) throw new Error('SSH key path is required.');
  if (!fs.existsSync(key)) throw new Error(`SSH key not found: ${key}`);

  fs.mkdirSync(PUBLIC, {recursive: true});

  if (typeof cfg.expiry !== 'string' || !cfg.expiry.trim()) {
    throw new Error('Expiry date is required. Select an expiry before running the scan.');
  }

  if (!cfg.sessionToken?.trim()) {
    throw new Error('Fresh Breeze session token is required. Enter the current session token in the UI.');
  }

  const runtimeConfig = {
    strategy: meta.key,
    min_otm_percent: Number(cfg.minOtm),
    max_otm_percent: Number(cfg.maxOtm),
    max_spread_width: Number(cfg.maxWidth),
    min_profit_to_loss: Number(cfg.minPL),
    max_profit_to_loss: Number(cfg.maxPL),
    min_oi: Number(cfg.minOI),
    min_volume: Number(cfg.minVolume),
    expiry: formatExpiry(cfg.expiry)
  };

  const configFile = path.join(PUBLIC, 'runtime_scan_config.json');
  fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));

  /*
   * COMPLETE SCAN FLOW
   *
   * 1. Check EC2.
   * 2. Start only if stopped; never restart a running instance.
   * 3. Wait for running and resolve its public IP.
   * 4. Wait for SSH.
   * 5. Upload scan_config.json.
   * 6. Upload the fresh UI session token and replace only BREEZE_SESSION_TOKEN.
   * 7. Run the already-installed EC2 scanner.
   * 8. Copy the strategy CSV to Windows.
   * 9. Create/update latest CSV on Windows.
   * 10. Only after all Windows CSV work succeeds, stop EC2.
   */

  const host = await ensureEc2Ready(cfg);

  await waitForSsh(host, user, key);

  state.status = 'uploading';
  state.message = 'Uploading scan configuration';

  await run('scp', [
    '-q',
    '-o', 'ConnectTimeout=12',
    '-i', key,
    configFile,
    `${user}@${host}:${remoteDir}/scan_config.json`
  ]);

  log('✓ Scan configuration uploaded');

  await updateRemoteSessionToken(
    host,
    user,
    key,
    remoteDir,
    cfg.sessionToken
  );

  state.status = 'scanning';
  state.message = 'Running scanner';

  await run('ssh', [
    '-o', 'ConnectTimeout=12',
    '-i', key,
    `${user}@${host}`,
    `cd ${remoteDir} && source .venv/bin/activate && python scan_universe.py`
  ]);

  log('✓ Scanner finished');

  state.status = 'downloading';
  state.message = 'Copying results to Windows';

  const archiveName =
    `${meta.key}_${archiveExpiry(runtimeConfig.expiry)}_${archiveStamp()}.csv`;

  const archiveTarget = path.join(PUBLIC, archiveName);

  await run('scp', [
    '-q',
    '-o', 'ConnectTimeout=12',
    '-i', key,
    `${user}@${host}:${remoteDir}/${meta.file}`,
    archiveTarget
  ]);

  state.resultFile = archiveName;
  log(`✓ Archived results copied to ${archiveTarget}`);

  const target = path.join(PUBLIC, meta.latest);

  try {
    fs.copyFileSync(archiveTarget, target);
    log(`✓ Latest results copied to ${target}`);
  } catch (error) {
    log(`⚠ Latest results not updated; close the open CSV and refresh: ${error.message}`);
    throw new Error(`Unable to create latest Windows CSV. ${error.message}`);
  }

  /*
   * IMPORTANT:
   * EC2 is stopped ONLY after the scanner completed and the latest CSV
   * was successfully created on Windows.
   *
   * If anything before this point fails, doScan throws and EC2 is NOT stopped.
   */
  const instanceId = process.env.BPS_EC2_INSTANCE_ID || cfg.instanceId;
  if (!instanceId) {
    throw new Error('BPS_EC2_INSTANCE_ID is required to stop EC2.');
  }

  await stopEc2(instanceId);

  state.status = 'complete';
  state.message = 'Scan complete';
}

function uiConfig() {
  return {
    host: process.env.BPS_EC2_HOST || '',
    user: process.env.BPS_EC2_USER || 'ec2-user',
    keyPath: process.env.BPS_EC2_KEY_PATH || '',
    remoteDir: process.env.BPS_EC2_REMOTE_DIR || REMOTE_DIR_DEFAULT,
    csvPublicDir: PUBLIC,
    instanceId: process.env.BPS_EC2_INSTANCE_ID || '',
    securityGroupId: process.env.BPS_EC2_SECURITY_GROUP_ID || '',
    region: process.env.BPS_AWS_REGION || ''
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.url === '/api/config' && req.method === 'GET') {
    return json(res, uiConfig());
  }

  if (req.url?.startsWith('/api/results/') && req.method === 'GET') {
    const fileName = decodeURIComponent(
      req.url.slice('/api/results/'.length).split('?')[0]
    );

    if (!fileName ||
        path.basename(fileName) !== fileName ||
        !fileName.endsWith('.csv')) {
      return json(res, {error: 'Invalid result file'}, 400);
    }

    const filePath = path.join(PUBLIC, fileName);

    if (!fs.existsSync(filePath)) {
      return json(res, {error: 'Result file not found'}, 404);
    }

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });

    return fs.createReadStream(filePath).pipe(res);
  }

  if (req.url === '/api/status' && req.method === 'GET') {
    return json(res, state);
  }

  if (req.url === '/api/run' && req.method === 'POST') {
    if (state.running) {
      return json(res, {error: 'A scan is already running.'}, 409);
    }

    let cfg;
    try {
      cfg = await body(req);
    } catch {
      return json(res, {error: 'Invalid JSON'}, 400);
    }

    state = {
      running: true,
      status: 'starting',
      message: 'Starting scan',
      lines: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultFile: null,
      error: null
    };

    json(res, {ok: true});

    doScan(cfg)
      .then(() => {
        state.running = false;
        state.finishedAt = new Date().toISOString();
      })
      .catch(e => {
        state.running = false;
        state.status = 'error';
        state.message = 'Scan failed';
        state.error = e.message;
        log('✗ ' + e.message);
        state.finishedAt = new Date().toISOString();
      });

    return;
  }

  if (req.url === '/api/reset' && req.method === 'POST') {
    state = {
      running: false,
      status: 'idle',
      message: 'Ready',
      lines: [],
      startedAt: null,
      finishedAt: null,
      resultFile: null,
      error: null
    };
    return json(res, {ok: true});
  }

  return json(res, {error: 'Not found'}, 404);
});

server.listen(
  PORT,
  '127.0.0.1',
  () => console.log(`BPS local controller listening on http://127.0.0.1:${PORT}`)
);
