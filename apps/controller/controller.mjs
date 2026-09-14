import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const REMOTE_DIR_DEFAULT = '/home/ec2-user/option-scanner';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCANNER_PATH = path.join(PROJECT_ROOT, 'services', 'scanner');
const RESTART_IF_RUNNING = !['0','false','no','off'].includes(String(process.env.BPS_EC2_RESTART_IF_RUNNING ?? 'true').toLowerCase());

// Load the local .env without adding a runtime dependency. Only scanner
// credentials are ever copied to EC2; AWS/SSH settings stay on Windows.
function loadLocalEnv(){
  const file=path.join(PROJECT_ROOT,'.env');
  if(!fs.existsSync(file)) return;
  for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    const line=raw.trim();
    if(!line || line.startsWith('#')) continue;
    const match=line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if(!match) continue;
    const name=match[1];
    let value=match[2].trim();
    if((value.startsWith('"')&&value.endsWith('"')) || (value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
    if(process.env[name]===undefined) process.env[name]=value;
  }
}
loadLocalEnv();
function strategyMeta(strategy){
  const key=String(strategy||'BULL_PUT').toUpperCase();
  if(key==='BEAR_CALL') return {key, file:'bcs_results.csv', latest:'latest_bcs_results.csv', label:'Bear Call Spread'};
  return {key:'BULL_PUT', file:'bps_results.csv', latest:'latest_bps_results.csv', label:'Bull Put Spread'};
}
const PORT = Number(process.env.BPS_CONTROLLER_PORT || 8787);

let state = {running:false, status:'idle', message:'Ready', lines:[], startedAt:null, finishedAt:null, resultFile:null, error:null};

function log(line){
  const clean = String(line).replace(/\r/g,'');
  if(!clean) return;
  state.lines.push(clean);
  if(state.lines.length>500) state.lines.shift();
  console.log(clean);
}
function run(cmd,args,opts={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{windowsHide:true,...opts});
    let out='',err='';
    p.stdout?.on('data',d=>{out+=d; d.toString().split(/\r?\n/).forEach(log)});
    p.stderr?.on('data',d=>{err+=d; d.toString().split(/\r?\n/).forEach(x=>log('[stderr] '+x))});
    p.on('error',reject);
    p.on('close',code=>code===0?resolve({out,err}):reject(new Error(`${cmd} exited with code ${code}`)));
  });
}
function json(res,obj,code=200){
  res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(obj));
}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',d=>s+=d);req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}})})}
function formatExpiry(value){
  if(typeof value!=='string'||!value.trim()) return '';
  const match=value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match) return value.trim();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [,year,month,day]=match;
  return `${day}-${months[Number(month)-1]||month}-${year}`;
}
function archiveStamp(date=new Date()){
  const pad=value=>String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
function archiveExpiry(expiry){
  return String(expiry||'NoExpiry').replace(/[^A-Za-z0-9-]/g,'-');
}


function awsCliPath(){
  const candidates=[];
  if(process.env.AWS_CLI_PATH) candidates.push(process.env.AWS_CLI_PATH);
  if(process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA,'Programs','Amazon','AWSCLIV2','aws.exe'));
  if(process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles,'Amazon','AWSCLIV2','aws.exe'));
  if(process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'],'Amazon','AWSCLIV2','aws.exe'));
  for(const candidate of candidates){
    if(candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'aws';
}

function awsBaseArgs(){
  const args=[];
  const region=process.env.BPS_AWS_REGION;
  if(region?.trim()) args.push('--region',region.trim());
  return args;
}

async function ensureSshAccess(cfg){
  const aws=awsCliPath();
  const securityGroupId=process.env.BPS_EC2_SECURITY_GROUP_ID || cfg.securityGroupId || 'sg-00c15ab4be4a6979a';
  if(!securityGroupId){
    throw new Error('BPS_EC2_SECURITY_GROUP_ID is required to refresh SSH access from the UI.');
  }

  state.status='ssh-access';state.message='Refreshing SSH access';
  log('Checking current Windows public IP for SSH access...');

  let publicIp='';
  try{
    const response=await fetch('https://api.ipify.org');
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    publicIp=(await response.text()).trim();
  }catch(error){
    throw new Error(`Unable to determine current Windows public IP. ${error.message}`);
  }

  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(publicIp)){
    throw new Error(`Invalid public IP returned by api.ipify.org: ${publicIp}`);
  }

  const cidr=`${publicIp}/32`;
  log(`Current Windows public IP: ${publicIp}`);

  let sgResult;
  try{
    sgResult=await run(aws,[
      ...awsBaseArgs(),
      'ec2','describe-security-groups',
      '--group-ids',securityGroupId,
      '--query','SecurityGroups[0].IpPermissions[?FromPort==`22` && ToPort==`22` && IpProtocol==`tcp`].IpRanges[].CidrIp',
      '--output','text'
    ]);
  }catch(error){
    throw new Error(`Unable to inspect SSH security-group rules. ${error.message}`);
  }

  const ranges=String(sgResult.out||'').split(/\s+/).map(x=>x.trim()).filter(Boolean);

  if(ranges.includes(cidr)){
    log(`✓ SSH access already allowed for ${cidr}`);
    return;
  }

  log(`SSH access missing for ${cidr} — adding rule to ${securityGroupId}...`);

  try{
    // Avoid --ip-permissions JSON because Windows native argument parsing can
    // strip JSON quotes. The simple AWS CLI form is robust.
    await run(aws,[
      ...awsBaseArgs(),
      'ec2','authorize-security-group-ingress',
      '--group-id',securityGroupId,
      '--protocol','tcp',
      '--port','22',
      '--cidr',cidr
    ]);
  }catch(error){
    // Another preflight may have added the rule between describe and authorize.
    try{
      const verify=await run(aws,[
        ...awsBaseArgs(),
        'ec2','describe-security-groups',
        '--group-ids',securityGroupId,
        '--query','SecurityGroups[0].IpPermissions[?FromPort==`22` && ToPort==`22` && IpProtocol==`tcp`].IpRanges[].CidrIp',
        '--output','text'
      ]);
      const verifiedRanges=String(verify.out||'').split(/\s+/).map(x=>x.trim()).filter(Boolean);
      if(verifiedRanges.includes(cidr)){
        log(`✓ SSH access already added for ${cidr}`);
        return;
      }
    }catch{}
    throw new Error(`Unable to add SSH access for ${cidr}. ${error.message}`);
  }

  log(`✓ SSH access added for ${cidr}`);
}

async function ensureEc2Ready(cfg){
  const instanceId=process.env.BPS_EC2_INSTANCE_ID || cfg.instanceId || 'i-05a5ee6857acfb59f';
  const aws=awsCliPath();

  state.status='ec2';state.message='Checking EC2 instance';
  log(`EC2 instance: ${instanceId}`);
  log(`AWS CLI: ${aws}`);

  let result;
  try{
    result=await run(aws,[
      ...awsBaseArgs(),
      'ec2','describe-instances',
      '--instance-ids',instanceId,
      '--query','Reservations[0].Instances[0].State.Name',
      '--output','text'
    ]);
  }catch(error){
    throw new Error(`Unable to query EC2 via AWS CLI. Make sure AWS credentials are configured. ${error.message}`);
  }

  let status=String(result.out||'').trim().split(/\r?\n/).filter(Boolean).pop()||'unknown';
  log(`EC2 status: ${status}`);

  if(status==='stopped'){
    state.status='ec2';state.message='Starting EC2 instance';
    log('EC2 is stopped — starting instance...');
    await run(aws,[
      ...awsBaseArgs(),
      'ec2','start-instances',
      '--instance-ids',instanceId,
      '--query','StartingInstances[0].CurrentState.Name',
      '--output','text'
    ]);
    log('✓ EC2 start requested');
  }else if(status==='pending'){
    log('EC2 is already starting — waiting...');
  }else if(status==='running'){
    if(RESTART_IF_RUNNING){
      state.status='ec2';state.message='Restarting EC2 instance';
      log('EC2 is already running — restarting it for a clean scanner session...');
      await run(aws,[...awsBaseArgs(),'ec2','stop-instances','--instance-ids',instanceId,'--query','StoppingInstances[0].CurrentState.Name','--output','text']);
      log('✓ EC2 stop requested');
      await run(aws,[...awsBaseArgs(),'ec2','wait','instance-stopped','--instance-ids',instanceId]);
      log('✓ EC2 instance is stopped');
      await run(aws,[...awsBaseArgs(),'ec2','start-instances','--instance-ids',instanceId,'--query','StartingInstances[0].CurrentState.Name','--output','text']);
      log('✓ EC2 start requested');
      status='stopped';
    }else{
      log('✓ EC2 is already running');
    }
  }else if(status==='stopping'){
    throw new Error('EC2 is stopping. Please wait for it to stop and run the scan again.');
  }else if(status==='shutting-down'){
    throw new Error('EC2 is shutting down. Please wait and run the scan again.');
  }else if(status==='terminated'){
    throw new Error('EC2 instance is terminated and cannot be started.');
  }else{
    throw new Error(`EC2 is not ready. Current state: ${status}`);
  }

  if(status!=='running'){
    state.status='ec2';state.message='Waiting for EC2 to become running';
    log('Waiting for EC2 to reach running state...');
    await run(aws,[...awsBaseArgs(),'ec2','wait','instance-running','--instance-ids',instanceId]);
    log('✓ EC2 instance is running');
  }

  // The instance uses an Elastic IP, but retrieving it from AWS keeps the
  // controller independent of a hard-coded host value.
  const ipResult=await run(aws,[
    ...awsBaseArgs(),
    'ec2','describe-instances',
    '--instance-ids',instanceId,
    '--query','Reservations[0].Instances[0].PublicIpAddress',
    '--output','text'
  ]);
  const currentHost=String(ipResult.out||'').trim().split(/\r?\n/).filter(Boolean).pop()||'';
  if(!currentHost || currentHost==='None' || currentHost==='null'){
    throw new Error('EC2 is running but has no public IP address.');
  }
  log(`EC2 public IP: ${currentHost}`);
  return currentHost;
}

async function waitForSsh(host,user,key){
  state.status='connecting';state.message='Waiting for SSH';
  log(`Waiting for SSH on ${host}:22...`);

  const attempts=18; // up to ~90 seconds
  let lastError=null;

  for(let i=1;i<=attempts;i++){
    try{
      await run('ssh',[
        '-o','ConnectTimeout=5',
        '-o','ConnectionAttempts=1',
        '-o','StrictHostKeyChecking=accept-new',
        '-i',key,
        `${user}@${host}`,
        'echo BPS_SSH_OK'
      ]);
      log('✓ SSH connection');
      return;
    }catch(error){
      lastError=error;
      if(i<attempts){
        log(`SSH not ready (${i}/${attempts}) — retrying in 5s...`);
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
    }
  }

  throw new Error(`EC2 is running but SSH is not reachable after ${attempts*5} seconds. ${lastError?.message||''}`);
}

function scannerFiles(){
  const names=[
    'bps_engine.py',
    'credit_spread_engine.py',
    'scan_universe.py',
    'scan_config.json',
    'requirements.txt',
    'download_security_master.py'
  ];
  const files=names.map(name=>({local:path.join(SCANNER_PATH,name),remote:name}));
  const strategyDir=path.join(SCANNER_PATH,'strategies');
  for(const name of ['__init__.py','bull_put.py','bear_call.py']) files.push({local:path.join(strategyDir,name),remote:`strategies/${name}`});
  const lotFile=path.join(SCANNER_PATH,'stock_lot.csv');
  if(fs.existsSync(lotFile)) files.push({local:lotFile,remote:'stock_lot.csv'});
  return files.filter(x=>fs.existsSync(x.local));
}

function scannerEnv(){
  const names=['BREEZE_API_KEY','BREEZE_API_SECRET','BREEZE_SESSION_TOKEN','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD'];
  const values=[];
  for(const name of names){
    const value=process.env[name];
    if(value!==undefined && value!=='') values.push(`${name}=${value}`);
  }
  return values;
}

async function uploadScanner(cfg,host,user,key,remoteDir){
  const files=scannerFiles();
  if(!files.some(x=>x.remote==='scan_universe.py')) throw new Error('Local scanner files are incomplete: scan_universe.py is missing.');
  state.status='uploading';state.message='Deploying scanner to EC2';
  log(`Preparing scanner in ${remoteDir}`);
  await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,`mkdir -p ${remoteDir}/strategies ${remoteDir}/backups`]);

  const localPaths=files.map(x=>x.local);
  const remoteBase=`${user}@${host}:${remoteDir}/`;
  await run('scp',['-q','-o','ConnectTimeout=12','-i',key,...localPaths,remoteBase]);
  // Strategy files need to land in the strategies directory.
  for(const item of files.filter(x=>x.remote.startsWith('strategies/'))){
    await run('scp',['-q','-o','ConnectTimeout=12','-i',key,item.local,`${user}@${host}:${remoteDir}/${item.remote}`]);
  }
  // Preserve the current lot-size master when the new folder does not have one.
  await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,`if [ ! -f ${remoteDir}/stock_lot.csv ] && [ -f /home/ec2-user/bps-scanner/stock_lot.csv ]; then cp /home/ec2-user/bps-scanner/stock_lot.csv ${remoteDir}/stock_lot.csv; echo '✓ Existing lot-size master copied'; fi`]);
  log(`✓ Scanner files deployed (${files.length} files)`);
}

async function ensureScannerEnv(cfg,host,user,key,remoteDir){
  loadLocalEnv();
  const envValues=scannerEnv();
  const hasLocalApi=envValues.some(x=>x.startsWith('BREEZE_API_KEY=')) && envValues.some(x=>x.startsWith('BREEZE_API_SECRET='));
  const localToken=cfg.sessionToken?.trim() || envValues.find(x=>x.startsWith('BREEZE_SESSION_TOKEN='))?.slice('BREEZE_SESSION_TOKEN='.length) || '';

  state.status='environment';state.message='Checking Breeze credentials';

  // Prefer the Windows .env when complete. Otherwise retain an already-valid
  // EC2 .env in the new scanner directory. No legacy-directory terminology is
  // exposed to the UI.
  if(hasLocalApi && localToken){
    const values=envValues.filter(x=>!x.startsWith('BREEZE_SESSION_TOKEN='));
    values.push(`BREEZE_SESSION_TOKEN=${localToken}`);
    const envFile=path.join(PUBLIC,'.scanner.env.tmp');
    fs.writeFileSync(envFile,values.join('\n')+'\n','utf8');
    try{
      await run('scp',['-q','-o','ConnectTimeout=12','-i',key,envFile,`${user}@${host}:${remoteDir}/.env.new`]);
      await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,`cd ${remoteDir} && mv .env.new .env && chmod 600 .env && grep -q '^BREEZE_API_KEY=' .env && grep -q '^BREEZE_API_SECRET=' .env && grep -q '^BREEZE_SESSION_TOKEN=' .env`]);
    }finally{try{fs.unlinkSync(envFile)}catch{}}
    log('✓ Breeze .env refreshed in option-scanner');
    return;
  }

  // If the Windows .env does not contain a complete credential set, retain
  // the already configured EC2-side .env. This avoids unnecessary migration
  // or credential prompts when the scanner is already provisioned.
  //
  // No complete Windows credentials: verify the EC2-side environment that
  // was already configured for the scanner.
  const check=`cd ${remoteDir} && test -f .env && chmod 600 .env && grep -q '^BREEZE_API_KEY=' .env && grep -q '^BREEZE_API_SECRET=' .env && grep -q '^BREEZE_SESSION_TOKEN=' .env`;
  try{
    await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,check]);
    log('✓ Breeze .env already configured in option-scanner');
  }catch{
    throw new Error('Breeze credentials are not configured. Add BREEZE_API_KEY, BREEZE_API_SECRET and BREEZE_SESSION_TOKEN to the Windows .env or configure .env in /home/ec2-user/option-scanner.');
  }
}
async function ensurePythonEnv(host,user,key,remoteDir){
  state.status='environment';state.message='Preparing Python environment';
  const cmd=`cd ${remoteDir} && if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi && if [ ! -f .requirements.sha256 ] || [ "$(sha256sum requirements.txt | awk '{print $1}')" != "$(cat .requirements.sha256 2>/dev/null)" ]; then .venv/bin/pip install -r requirements.txt && sha256sum requirements.txt | awk '{print $1}' > .requirements.sha256; else echo '✓ Python requirements already up to date'; fi`;
  await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,cmd]);
  log('✓ Python environment ready');
}

async function prepareEc2(cfg){
  const user=cfg.user || 'ec2-user';
  const key=cfg.keyPath;
  const remoteDir=cfg.remoteDir || REMOTE_DIR_DEFAULT;
  if(!key) throw new Error('SSH key path is required.');
  if(!fs.existsSync(key)) throw new Error(`SSH key not found: ${key}`);
  fs.mkdirSync(PUBLIC,{recursive:true});
  const host=await ensureEc2Ready(cfg);
  await ensureSshAccess(cfg);
  await waitForSsh(host,user,key);
  await uploadScanner(cfg,host,user,key,remoteDir);
  await ensureScannerEnv(cfg,host,user,key,remoteDir);
  await ensurePythonEnv(host,user,key,remoteDir);
  return {host,user,key,remoteDir};
}

async function doScan(cfg){
  const meta=strategyMeta(cfg.strategy);
  if(typeof cfg.expiry!=='string' || !cfg.expiry.trim()) throw new Error('Expiry date is required. Select an expiry before running the scan.');
  const runtimeConfig={
    strategy:meta.key,
    min_otm_percent:Number(cfg.minOtm), max_otm_percent:Number(cfg.maxOtm),
    max_spread_width:Number(cfg.maxWidth), min_profit_to_loss:Number(cfg.minPL),
    max_profit_to_loss:Number(cfg.maxPL), min_oi:Number(cfg.minOI), min_volume:Number(cfg.minVolume),
    expiry:formatExpiry(cfg.expiry)
  };
  const configFile=path.join(PUBLIC,'runtime_scan_config.json');
  fs.writeFileSync(configFile,JSON.stringify(runtimeConfig,null,2));

  const ready=await prepareEc2(cfg);
  const {host,user,key,remoteDir}=ready;
  await run('scp',['-q','-o','ConnectTimeout=12','-i',key,configFile,`${user}@${host}:${remoteDir}/scan_config.json`]);
  log('✓ Scan configuration uploaded');

  state.status='scanning';state.message='Running scanner';
  await run('ssh',['-o','ConnectTimeout=12','-i',key,`${user}@${host}`,`cd ${remoteDir} && source .venv/bin/activate && python scan_universe.py`]);
  log('✓ Scanner finished');

  state.status='downloading';state.message='Copying results to Windows';
  const archiveName=`${meta.key}_${archiveExpiry(runtimeConfig.expiry)}_${archiveStamp()}.csv`;
  const archiveTarget=path.join(PUBLIC,archiveName);
  await run('scp',['-q','-o','ConnectTimeout=12','-i',key,`${user}@${host}:${remoteDir}/${meta.file}`,archiveTarget]);
  state.resultFile=archiveName;
  log(`✓ Archived results copied to ${archiveTarget}`);

  const target=path.join(PUBLIC,meta.latest);
  try{
    fs.copyFileSync(archiveTarget,target);
    log(`✓ Latest results copied to ${target}`);
  }catch(error){
    log(`⚠ Latest results not updated; close the open CSV and refresh: ${error.message}`);
  }
  state.status='complete';state.message='Scan complete';
}

function uiConfig(){
  loadLocalEnv();
  return {
    host:process.env.BPS_EC2_HOST||'',
    user:process.env.BPS_EC2_USER||'ec2-user',
    keyPath:process.env.BPS_EC2_KEY_PATH||'',
    remoteDir:process.env.BPS_EC2_REMOTE_DIR||REMOTE_DIR_DEFAULT,
    instanceId:process.env.BPS_EC2_INSTANCE_ID||'',
    securityGroupId:process.env.BPS_EC2_SECURITY_GROUP_ID||'',
    region:process.env.BPS_AWS_REGION||''
  };
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end()}
  if(req.url?.startsWith('/api/results/')&&req.method==='GET'){
    const fileName=decodeURIComponent(req.url.slice('/api/results/'.length).split('?')[0]);
    if(!fileName||path.basename(fileName)!==fileName||!fileName.endsWith('.csv'))return json(res,{error:'Invalid result file'},400);
    const filePath=path.join(PUBLIC,fileName);
    if(!fs.existsSync(filePath))return json(res,{error:'Result file not found'},404);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});
    return fs.createReadStream(filePath).pipe(res);
  }
  if(req.url==='/api/config'&&req.method==='GET') return json(res,uiConfig());
  if(req.url==='/api/status'&&req.method==='GET') return json(res,state);
  if(req.url==='/api/setup'&&req.method==='POST'){
    if(state.running) return json(res,{error:'A scan/setup operation is already running.'},409);
    let cfg;try{cfg=await body(req)}catch{return json(res,{error:'Invalid JSON'},400)}
    state={running:true,status:'starting',message:'Preparing EC2',lines:[],startedAt:new Date().toISOString(),finishedAt:null,resultFile:null,error:null};
    json(res,{ok:true});
    prepareEc2(cfg).then(()=>{state.running=false;state.status='complete';state.message='EC2 ready';state.finishedAt=new Date().toISOString()}).catch(e=>{state.running=false;state.status='error';state.message='EC2 preparation failed';state.error=e.message;log('✗ '+e.message);state.finishedAt=new Date().toISOString()});
    return;
  }
  if(req.url==='/api/run'&&req.method==='POST'){
    if(state.running) return json(res,{error:'A scan is already running.'},409);
    let cfg;try{cfg=await body(req)}catch{return json(res,{error:'Invalid JSON'},400)}
    state={running:true,status:'starting',message:'Starting scan',lines:[],startedAt:new Date().toISOString(),finishedAt:null,resultFile:null,error:null};
    json(res,{ok:true});
    doScan(cfg).then(()=>{state.running=false;state.finishedAt=new Date().toISOString()}).catch(e=>{state.running=false;state.status='error';state.message='Scan failed';state.error=e.message;log('✗ '+e.message);state.finishedAt=new Date().toISOString()});
    return;
  }
  if(req.url==='/api/reset'&&req.method==='POST'){state={running:false,status:'idle',message:'Ready',lines:[],startedAt:null,finishedAt:null,resultFile:null,error:null};return json(res,{ok:true})}
  json(res,{error:'Not found'},404);
});
server.listen(PORT,'127.0.0.1',()=>console.log(`BPS local controller listening on http://127.0.0.1:${PORT}`));