'use strict';

/*
 * Lifecycle hook server for the runner MicroVM
 * Author: Sean Stoves
 *
 * Lambda MicroVMs drives the VM by POSTing here on 9000 (8080 answers the same
 * routes, belt and suspenders):
 *   /ready      polled while the image warms. 200 = snapshot me
 *   /run        the job payload, once the VM gets dispatched
 *   /terminate  heads up, you're about to be torn down
 *
 * Nothing to warm, so /ready says yes right away. /run starts one JIT runner,
 * and when it exits we kill the VM. One job, one VM, no leftovers.
 */

const http = require('http');
const zlib = require('zlib');
const path = require('path');
const { spawn } = require('child_process');
const { LambdaMicrovmsClient, TerminateMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');

const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1';
const PORTS = [9000, 8080];
const ENTRYPOINT_PATH = path.join(__dirname, 'entrypoint.sh');

// Live AWS creds the execution role drops into our env. The job doesn't get these.
// AWS_REGION is left alone on purpose, it's harmless and jobs tend to want it.
const AWS_CREDENTIAL_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
];

// We keep the real env. Something has to have creds to call TerminateMicrovm at the end.
const microvmsClient = new LambdaMicrovmsClient({});

// /run can show up twice. Second one gets ignored, one VM runs one job.
let jobStarted = false;

function log(message, fields) {
  console.log(JSON.stringify({ msg: message, ts: new Date().toISOString(), ...fields }));
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Dispatcher always sends base64(gzip(encoded_jit_config)). Garbage in throws, which
// turns into a 500 on this /run only.
function decodeRunHookPayload(runHookPayload) {
  const raw = Buffer.from(runHookPayload, 'base64');
  return zlib.gunzipSync(raw).toString('utf8');
}

async function terminateMicrovm(microvmId) {
  try {
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    log('microvm termination requested', { microvmId });
  } catch (err) {
    log('microvm termination request failed', { microvmId, error: err.message });
  }
}

function runJob(encodedJitConfig, microvmId) {
  log('runner job starting', { microvmId });

  // Strip the creds before the job gets the env. This is not airtight, and I'm not
  // going to pretend it is: we're the same UID as the job, so anything that goes
  // looking can read them out of /proc/<our pid>/environ. This stops the lazy leak
  // (env dumps, `printenv` in a log), not a determined one. Separate UID is the fix.
  const childEnv = { ...process.env };
  for (const key of AWS_CREDENTIAL_ENV_VARS) {
    delete childEnv[key];
  }

  const child = spawn(ENTRYPOINT_PATH, [], {
    env: { ...childEnv, ENCODED_JIT_CONFIG: encodedJitConfig },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    log('runner job exited', { microvmId, code, signal });
    terminateMicrovm(microvmId);
  });

  child.on('error', (err) => {
    log('runner job failed to start', { microvmId, error: err.message });
    terminateMicrovm(microvmId);
  });
}

async function handleReady(res) {
  log('ready check received');
  sendJson(res, 200, { status: 'ready' });
}

async function handleRun(req, res) {
  const body = await readRequestBody(req);
  const { microvmId, runHookPayload } = JSON.parse(body.toString('utf8'));

  if (jobStarted) {
    log('duplicate run request ignored', { microvmId });
    sendJson(res, 200, { status: 'already running' });
    return;
  }

  // Decode first, flag second. Flip it before a decode that throws and this VM can
  // never take a retried /run, it just sits there bricked until the idle timer.
  const encodedJitConfig = decodeRunHookPayload(runHookPayload);
  jobStarted = true;
  runJob(encodedJitConfig, microvmId);
  sendJson(res, 200, { status: 'started' });
}

async function handleTerminate(res) {
  log('terminate notice received');
  sendJson(res, 200, { status: 'terminating' });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.startsWith(HOOK_PREFIX)
    ? url.pathname.slice(HOOK_PREFIX.length)
    : url.pathname;

  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  try {
    if (route === '/ready') {
      await handleReady(res);
    } else if (route === '/run') {
      await handleRun(req, res);
    } else if (route === '/terminate') {
      await handleTerminate(res);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    log('request handling error', { path: url.pathname, error: err.message });
    sendJson(res, 500, { error: 'internal error' });
  }
}

for (const port of PORTS) {
  http.createServer(handleRequest).listen(port, () => {
    log('lifecycle hook server listening', { port });
  });
}
